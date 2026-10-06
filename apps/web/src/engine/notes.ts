import type { MeetingNote, NoteSource, Person, PersonFact, User } from '@orbit/core';
import { heuristicNoteExtraction, newId, normalizeEmail, parseGranolaText, parseName } from '@orbit/core';
import { addTouchpoint, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmNoteExtraction } from '../integrations/anthropic';
import { evaluateImmediateSuggestions, refreshPersonSummary } from './brief';
import { upsertPerson } from './people';
import { evaluateTrigger } from './stages';

export interface CaptureInput {
  text: string;
  source: NoteSource;
  personIds?: string[];
  occurredAt?: string;
  title?: string;
  externalId?: string;
  attendees?: { name?: string; email?: string }[];
}

export async function ingestNote(user: User, inp: CaptureInput, now = new Date()): Promise<MeetingNote> {
  const parsed =
    inp.source.startsWith('granola') || /^(summary|transcript)/im.test(inp.text)
      ? parseGranolaText(inp.text)
      : undefined;
  const occurredAt = inp.occurredAt ?? now.toISOString();
  const attendees: { name?: string; email?: string }[] = [
    ...(inp.attendees ?? []),
    ...(parsed?.attendees ?? []),
  ];
  // match people: explicit ids > attendee emails > names > calendar window
  const personIds = new Set(inp.personIds ?? []);
  let confidence = personIds.size ? 1 : 0;
  for (const a of attendees) {
    if (a.email && normalizeEmail(a.email) !== normalizeEmail(user.email)) {
      const { person } = await upsertPerson({
        userId: user.id,
        email: a.email,
        displayName: a.name,
        source: 'note',
        userSchool: user.school,
      });
      personIds.add(person.id);
      confidence = Math.max(confidence, 0.98);
    } else if (a.name) {
      const n = parseName(a.name);
      const hit = await db.people
        .where('userId')
        .equals(user.id)
        .filter((p) => p.nameNormalized === n.normalized)
        .toArray();
      if (hit.length === 1) {
        personIds.add(hit[0]!.id);
        confidence = Math.max(confidence, 0.8);
      }
    }
  }
  let calendarEventId: string | undefined;
  const t = new Date(occurredAt).getTime();
  const nearby = await db.events
    .where('userId')
    .equals(user.id)
    .filter(
      (e) => Math.abs(new Date(e.startAt).getTime() - t) < 3 * 3_600_000 && e.attendeePersonIds.length > 0,
    )
    .toArray();
  if (nearby.length) {
    const ev = nearby.sort(
      (a, b) => Math.abs(new Date(a.startAt).getTime() - t) - Math.abs(new Date(b.startAt).getTime() - t),
    )[0]!;
    if (!personIds.size || ev.attendeePersonIds.some((id) => personIds.has(id))) {
      calendarEventId = ev.id;
      for (const id of ev.attendeePersonIds) personIds.add(id);
      confidence = Math.max(confidence, 0.9);
    }
  }
  if (!personIds.size) {
    // scan text for known names
    const people = await db.people.where('userId').equals(user.id).toArray();
    const lower = inp.text.toLowerCase();
    const hits = people.filter(
      (p) => p.isHuman && p.displayName.length > 4 && lower.includes(p.displayName.toLowerCase()),
    );
    if (hits.length === 1) {
      personIds.add(hits[0]!.id);
      confidence = 0.8;
    }
  }
  const ids = [...personIds];
  const primary = ids[0] ? await db.people.get(ids[0]) : undefined;
  const chat = primary
    ? await db.chats
        .where('personId')
        .equals(primary.id)
        .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
        .first()
    : undefined;
  const note: MeetingNote = {
    id: newId('n'),
    userId: user.id,
    source: inp.source,
    externalId: inp.externalId,
    title: inp.title ?? parsed?.title ?? (primary ? `Chat with ${primary.displayName}` : 'Note'),
    occurredAt,
    rawText: inp.text,
    rawSummary: parsed?.summary,
    attendees,
    personIds: ids,
    chatId: chat?.id,
    calendarEventId,
    matchStatus: ids.length ? (confidence >= 0.8 ? 'auto' : 'unmatched') : 'unmatched',
    matchConfidence: confidence,
    createdAt: now.toISOString(),
  };
  if (inp.externalId) {
    const dup = await db.notes.where('[source+externalId]').equals([inp.source, inp.externalId]).first();
    if (dup) return dup;
  }
  await db.notes.add(note);
  await processNote(user, note, now);
  return note;
}

export async function processNote(user: User, note: MeetingNote, now = new Date()): Promise<void> {
  const notePeople = (await db.people.bulkGet(note.personIds)).filter((p): p is Person => !!p);
  const primary = notePeople.find((p) => p.id === note.personIds[0]);
  const ext =
    (hasLlm()
      ? await llmNoteExtraction(note.rawText, primary?.displayName, user.fullName).catch(() => undefined)
      : undefined) ??
    heuristicNoteExtraction(note.rawText, {
      people: notePeople.map((p) => ({ key: p.id, first: p.firstName, last: p.lastName || undefined })),
      userNames: [user.fullName, user.firstName].filter(Boolean),
    });
  await db.notes.update(note.id, { extraction: ext, summary: ext.summary, processedAt: now.toISOString() });
  if (!primary) return;
  // each fact belongs to the person it is about: an id from the heuristic path, a name from the LLM path
  const personFor = (about: string | undefined): Person => {
    if (!about) return primary;
    const byId = notePeople.find((p) => p.id === about);
    if (byId) return byId;
    const a = about.toLowerCase().trim();
    return (
      notePeople.find((p) => p.displayName.toLowerCase() === a) ??
      notePeople.find(
        (p) => p.firstName.toLowerCase() === a || a.startsWith(`${p.firstName.toLowerCase()} `),
      ) ??
      primary
    );
  };
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .trim();
  const existingByPerson = new Map<string, PersonFact[]>();
  const existingFor = async (personId: string) => {
    let list = existingByPerson.get(personId);
    if (!list) {
      list = await db.facts.where('personId').equals(personId).toArray();
      existingByPerson.set(personId, list);
    }
    return list;
  };
  const touched = new Set<string>([primary.id]);
  const addFact = async (
    personId: string,
    type: PersonFact['type'],
    text: string,
    confidence: number,
    evidence?: string,
  ) => {
    const list = await existingFor(personId);
    if (list.some((e) => e.type === type && norm(e.text) === norm(text))) return;
    const f: PersonFact = {
      id: newId('f'),
      userId: user.id,
      personId,
      type,
      text,
      evidence,
      sourceTable: 'notes',
      sourceId: note.id,
      occurredAt: note.occurredAt,
      confidence,
      createdAt: now.toISOString(),
    };
    await db.facts.add(f);
    list.push(f);
    touched.add(personId);
  };
  for (const f of ext.facts) await addFact(personFor(f.about).id, f.type, f.text, f.confidence, f.evidence);
  for (const o of ext.offers) {
    if (ext.facts.some((f) => f.type === 'offer' && norm(f.text) === norm(o))) continue;
    await addFact(primary.id, 'offer', o, 0.75);
  }
  for (const a of ext.actionItems) {
    if (a.owner !== 'user') continue;
    const due = parseDueHint(a.dueHint, new Date(note.occurredAt), user.timezone);
    await db.actionItems.add({
      id: newId('ai'),
      userId: user.id,
      personId: personFor(a.about).id,
      chatId: note.chatId,
      text: a.text,
      dueAt: due.toISOString(),
      status: 'open',
      sourceTable: 'notes',
      sourceId: note.id,
      createdAt: now.toISOString(),
    });
  }
  // everyone in the note was in the meeting
  for (const p of notePeople) {
    await addTouchpoint({
      userId: user.id,
      personId: p.id,
      kind: 'note',
      occurredAt: note.occurredAt,
      refTable: 'notes',
      refId: note.id,
      summary: `Notes: ${note.title ?? ''}`,
      weight: 0.3,
    });
    if (!note.calendarEventId)
      await addTouchpoint({
        userId: user.id,
        personId: p.id,
        kind: 'meeting',
        occurredAt: note.occurredAt,
        refTable: 'notes',
        refId: `${note.id}:meeting`,
        summary: `Meeting (from notes): ${note.title ?? ''}`,
        weight: 1,
      });
  }
  const chat = note.chatId ? await db.chats.get(note.chatId) : undefined;
  if (chat) {
    await evaluateTrigger(
      chat,
      { type: 'note_ingested', confidence: note.matchConfidence ?? 0.8 },
      { table: 'notes', id: note.id },
      now,
    );
    if (!chat.completedAt) await db.chats.update(chat.id, { completedAt: note.occurredAt });
  }
  for (const p of notePeople) await recomputePersonStrength(p.id, now);
  for (const id of touched) await refreshPersonSummary(user, id);
  await notify(
    user.id,
    'system',
    `Notes from your chat with ${primary.firstName} are in`,
    ext.suggestedNextStep,
    `/people/${primary.id}`,
  );
  await evaluateImmediateSuggestions(user.id, { personId: primary.id, chatId: chat?.id }, now);
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/** Calendar date and weekday of an instant in a time zone. */
function zonedDate(d: Date, timeZone: string): { y: number; m: number; day: number; wd: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')) - 1, day: Number(get('day')), wd };
}

/** The instant at which the wall clock in `timeZone` reads y-m-day hour:00. */
function zonedInstant(y: number, m: number, day: number, hour: number, timeZone: string): Date {
  const wall = Date.UTC(y, m, day, hour, 0, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(guess));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const shown = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
    guess += wall - shown;
  }
  return new Date(guess);
}

/**
 * Turn a due phrase from a note ("by Friday", "tomorrow", "in two weeks", "by Oct 20", "by the early
 * deadline in October") into a due time, 5 pm in the student's time zone. Undated promises get a week.
 */
export function parseDueHint(hint: string | undefined, from: Date, timeZone = 'UTC'): Date {
  const h = (hint ?? '').toLowerCase();
  const base = zonedDate(from, timeZone);
  let { y, m, day } = base;
  let hour = 17;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wd = days.findIndex((x) => h.includes(x));
  const monthDay = h.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  const monthOnly = h.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  );
  const slash = h.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  const inN = h.match(/\bin\s+(a|an|one|two|three|four|five|six|\d+)\s+(day|week)s?\b/);
  const addDays = (n: number) => {
    const t = new Date(Date.UTC(y, m, day + n));
    y = t.getUTCFullYear();
    m = t.getUTCMonth();
    day = t.getUTCDate();
  };
  const fixedDate = (mo: number, d: number) => {
    // a date that already passed this year means next year
    const thisYear = Date.UTC(base.y, mo, d) < Date.UTC(base.y, base.m, base.day) ? base.y + 1 : base.y;
    y = thisYear;
    m = mo;
    day = d;
  };
  if (h.includes('tomorrow')) addDays(1);
  else if (h.includes('tonight')) hour = 21;
  else if (h.includes('eod') || h.includes('today')) hour = 17;
  else if (monthDay) fixedDate(MONTH_INDEX[monthDay[1]!.slice(0, 3)]!, Number(monthDay[2]));
  else if (slash) fixedDate(Number(slash[1]) - 1, Number(slash[2]));
  else if (wd >= 0) addDays((wd - base.wd + 7) % 7 || 7);
  else if (inN) addDays((NUMBER_WORDS[inN[1]!] ?? Number(inN[1])) * (inN[2] === 'week' ? 7 : 1));
  else if (/end of (the )?week|this week/.test(h)) addDays((5 - base.wd + 7) % 7);
  else if (/end of (the )?month|this month/.test(h)) day = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  else if (monthOnly) {
    // "in October": the end of that month
    const mo = MONTH_INDEX[monthOnly[1]!.slice(0, 3)]!;
    y = mo < base.m ? base.y + 1 : base.y;
    m = mo;
    day = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  } else if (h.includes('next month')) addDays(30);
  else if (h.includes('week')) addDays(7);
  else addDays(7);
  return zonedInstant(y, m, day, hour, timeZone);
}
