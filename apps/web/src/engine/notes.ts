import type { MeetingNote, NoteSource, User } from '@orbit/core';
import { heuristicNoteExtraction, newId, normalizeEmail, parseGranolaText, parseName } from '@orbit/core';
import { addTouchpoint, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmNoteExtraction } from '../integrations/anthropic';
import {
  evaluateImmediateSuggestions,
  FACT_DRAFT_KINDS,
  refreshIfFactsNewer,
  refreshPersonSummary,
} from './brief';
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
  const primary = note.personIds[0] ? await db.people.get(note.personIds[0]) : undefined;
  const ext =
    (hasLlm()
      ? await llmNoteExtraction(note.rawText, primary?.displayName, user.fullName).catch(() => undefined)
      : undefined) ?? heuristicNoteExtraction(note.rawSummary ?? note.rawText, primary?.firstName);
  await db.notes.update(note.id, { extraction: ext, summary: ext.summary, processedAt: now.toISOString() });
  if (!primary) return;
  const existing = await db.facts.where('personId').equals(primary.id).toArray();
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
  for (const f of ext.facts) {
    if (existing.some((e) => e.type === f.type && norm(e.text) === norm(f.text))) continue;
    await db.facts.add({
      id: newId('f'),
      userId: user.id,
      personId: primary.id,
      type: f.type,
      text: f.text,
      sourceTable: 'notes',
      sourceId: note.id,
      occurredAt: note.occurredAt,
      confidence: f.confidence,
      createdAt: now.toISOString(),
    });
  }
  for (const o of ext.offers) {
    if (
      existing.some((e) => e.type === 'offer' && norm(e.text) === norm(o)) ||
      ext.facts.some((f) => f.type === 'offer' && norm(f.text) === norm(o))
    )
      continue;
    await db.facts.add({
      id: newId('f'),
      userId: user.id,
      personId: primary.id,
      type: 'offer',
      text: o,
      sourceTable: 'notes',
      sourceId: note.id,
      occurredAt: note.occurredAt,
      confidence: 0.75,
      createdAt: now.toISOString(),
    });
  }
  for (const a of ext.actionItems) {
    if (a.owner !== 'user') continue;
    const due = parseDueHint(a.dueHint, new Date(note.occurredAt));
    await db.actionItems.add({
      id: newId('ai'),
      userId: user.id,
      personId: primary.id,
      chatId: note.chatId,
      text: a.text,
      dueAt: due.toISOString(),
      status: 'open',
      sourceTable: 'notes',
      sourceId: note.id,
      createdAt: now.toISOString(),
    });
  }
  await addTouchpoint({
    userId: user.id,
    personId: primary.id,
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
      personId: primary.id,
      kind: 'meeting',
      occurredAt: note.occurredAt,
      refTable: 'notes',
      refId: `${note.id}:meeting`,
      summary: `Meeting (from notes): ${note.title ?? ''}`,
      weight: 1,
    });
  const chat = note.chatId ? await db.chats.get(note.chatId) : undefined;
  if (chat) {
    await evaluateTrigger(
      chat,
      { type: 'note_ingested', confidence: note.matchConfidence ?? 0.8 },
      { table: 'notes', id: note.id },
      now,
      new Date(note.occurredAt),
    );
    if (!chat.completedAt) await db.chats.update(chat.id, { completedAt: note.occurredAt });
  }
  await recomputePersonStrength(primary.id, now);
  await refreshPersonSummary(user, primary.id);
  await notify(
    user.id,
    'system',
    `Notes from your chat with ${primary.firstName} are in`,
    ext.suggestedNextStep,
    `/people/${primary.id}`,
  );
  // drafts that lean on what was said (thank-you, check-in, referral ask) and were written before these notes
  // existed are re-drafted with the new facts; an edited draft is left alone
  const drafted = await db.suggestions
    .where('personId')
    .equals(primary.id)
    .filter((s) => FACT_DRAFT_KINDS.has(s.kind) && s.status === 'pending' && !!s.outboundMessageId)
    .toArray();
  await evaluateImmediateSuggestions(user.id, { personId: primary.id, chatId: chat?.id }, now);
  for (const s of drafted) {
    const fresh = await db.suggestions.get(s.id);
    if (fresh?.status === 'pending') await refreshIfFactsNewer(user.id, fresh, { factsJustAdded: true });
  }
}

export function parseDueHint(hint: string | undefined, from: Date): Date {
  const d = new Date(from);
  const h = (hint ?? '').toLowerCase();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wd = days.findIndex((x) => h.includes(x));
  if (h.includes('tomorrow')) d.setDate(d.getDate() + 1);
  else if (wd >= 0) d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7 || 7));
  else if (h.includes('eod') || h.includes('today')) return d;
  else if (h.includes('month')) d.setDate(d.getDate() + 30);
  else if (h.includes('week')) d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 7);
  d.setHours(17, 0, 0, 0);
  return d;
}
