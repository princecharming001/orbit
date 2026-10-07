import type { Candidate, MeetingNote, NoteSource, Person, PersonFact, User } from '@orbit/core';
import {
  heuristicNoteExtraction,
  isPlaceholderName,
  looksLikeNotetakerText,
  newId,
  normalizeEmail,
  parseGranolaText,
  parseName,
  stripDiacritics,
} from '@orbit/core';
import { addTouchpoint, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmNoteExtraction } from '../integrations/anthropic';
import {
  evaluateImmediateSuggestions,
  FACT_DRAFT_KINDS,
  refreshIfFactsNewer,
  refreshPendingDrafts,
  refreshPersonSummary,
  regenerateDraft,
  surfaceLlmFailure,
  upsertSuggestions,
} from './brief';
import { upsertPerson } from './people';
import { evaluateTrigger, retireSuggestions } from './stages';

/** The stage event reason for a chat opened by a note about someone the student had never messaged. */
const NOTE_OPENED_CHAT = 'note:met';

export interface CaptureInput {
  text: string;
  source: NoteSource;
  personIds?: string[];
  occurredAt?: string;
  title?: string;
  externalId?: string;
  attendees?: { name?: string; email?: string }[];
}

/** First names that are also everyday words or months: only a full-name mention counts for them. */
const WORD_NAMES = new Set(
  (
    'may june april august summer autumn winter will bill mark grace hope faith joy chase max ray rich frank ' +
    'sunny dawn rose art page hunter rocky sky river angel honey cash miles lane drew brook'
  ).split(' '),
);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * People a note names: full names ("Maya Wu"), and first names alone ("call with Maya") when exactly one
 * person has that first name. A first name, or a full name, shared by several people comes back as
 * `ambiguous`.
 */
export function mentionedPeople(
  text: string,
  people: Person[],
  userFirstName?: string,
): { full: Person[]; byFirstName: Person[]; ambiguous: Person[] } {
  const folded = stripDiacritics(text);
  const humans = people.filter((p) => p.isHuman && !p.hiddenAt && !isPlaceholderName(p));
  const fullHit = (name: string) =>
    new RegExp(`(?:^|[^\\p{L}])${escapeRe(stripDiacritics(name))}(?![\\p{L}])`, 'iu').test(folded);
  const fullHits = humans.filter((p) => p.displayName.includes(' ') && fullHit(p.displayName));
  // a full name several people share ("Tom Wu" at Bain and "Tom Wu" at Google) does not say which one
  const nameKey = (p: Person) => stripDiacritics(p.displayName).toLowerCase().replace(/\s+/g, ' ').trim();
  const fullCount = new Map<string, number>();
  for (const p of fullHits) fullCount.set(nameKey(p), (fullCount.get(nameKey(p)) ?? 0) + 1);
  const full = fullHits.filter((p) => fullCount.get(nameKey(p)) === 1);
  const sharedFull = fullHits.filter((p) => fullCount.get(nameKey(p))! > 1);
  // capitalised words in the note: "Maya", "Mary-Kate" (a first name written in lower case is too risky)
  const words = new Set(folded.match(/\p{Lu}[\p{L}-]*\p{L}/gu) ?? []);
  const self = stripDiacritics(userFirstName ?? '').toLowerCase();
  const byFirst = new Map<string, Person[]>();
  for (const p of humans) {
    const first = stripDiacritics(p.firstName);
    const key = first.toLowerCase();
    if (first.length < 3 || key === self || WORD_NAMES.has(key)) continue;
    const cap = first[0]!.toUpperCase() + first.slice(1);
    if (!words.has(first) && !words.has(cap)) continue;
    byFirst.set(key, [...(byFirst.get(key) ?? []), p]);
  }
  const named = new Set(fullHits.map((p) => stripDiacritics(p.firstName).toLowerCase()));
  const byFirstName: Person[] = [];
  const ambiguous: Person[] = [...sharedFull];
  for (const [key, list] of byFirst) {
    if (named.has(key)) continue; // "Maya Wu ... Maya said" is the person already named in full
    if (list.length === 1) byFirstName.push(list[0]!);
    else ambiguous.push(...list);
  }
  return { full, byFirstName, ambiguous };
}

/**
 * Who Orbit will file a note with when the student leaves "Let Orbit figure it out", shown under the picker before
 * saving. It follows ingestNote's order: people the title line names, then full names in the text, then first names
 * only one person has, then the chat on the calendar that just ended.
 */
export type NoteMatchPreview =
  | { kind: 'person'; person: Person; why: 'named' | 'calendar' }
  | { kind: 'several'; people: Person[] }
  | { kind: 'none' };
export function previewNoteMatch(
  text: string,
  people: Person[],
  user: Pick<User, 'firstName' | 'fullName'>,
  calendarPerson?: Person,
): NoteMatchPreview {
  const self = parseName(user.fullName || user.firstName || '').normalized;
  const fromTitle = looksLikeNotetakerText(text)
    ? (parseGranolaText(text).attendees ?? [])
        .map((a) => parseName(a.name).normalized)
        .filter((n) => n && n !== self)
        .map((n) => people.filter((p) => p.nameNormalized === n && p.isHuman && !p.hiddenAt))
        .filter((hits) => hits.length === 1)
        .map((hits) => hits[0]!)
    : [];
  if (fromTitle.length === 1) return { kind: 'person', person: fromTitle[0]!, why: 'named' };
  if (fromTitle.length > 1) return { kind: 'several', people: fromTitle };
  const m = mentionedPeople(text, people, user.firstName);
  if (m.full.length === 1 && !m.byFirstName.length && !m.ambiguous.length)
    return { kind: 'person', person: m.full[0]!, why: 'named' };
  const named = [...m.full, ...m.byFirstName, ...m.ambiguous];
  if (named.length) {
    if (calendarPerson && named.some((p) => p.id === calendarPerson.id))
      return { kind: 'person', person: calendarPerson, why: 'calendar' };
    return { kind: 'several', people: named };
  }
  return calendarPerson ? { kind: 'person', person: calendarPerson, why: 'calendar' } : { kind: 'none' };
}

/** "Tue, Oct 6" in the student's time zone. */
function dayLabel(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export async function ingestNote(user: User, inp: CaptureInput, now = new Date()): Promise<MeetingNote> {
  const parsed =
    inp.source.startsWith('granola') || looksLikeNotetakerText(inp.text)
      ? parseGranolaText(inp.text)
      : undefined;
  const occurredAt = inp.occurredAt ?? now.toISOString();
  const attendees: { name?: string; email?: string }[] = [
    ...(inp.attendees ?? []),
    ...(parsed?.attendees ?? []),
  ];
  // match people: explicit ids > attendee emails > names > calendar window > names in the text
  const personIds = new Set(inp.personIds ?? []);
  // people the note could be with when Orbit cannot tell on its own; the match card offers them first
  const candidates = new Set<string>();
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
      if (n.normalized === parseName(user.fullName).normalized) continue;
      const hit = await db.people
        .where('userId')
        .equals(user.id)
        .filter((p) => p.nameNormalized === n.normalized)
        .toArray();
      if (hit.length === 1) {
        personIds.add(hit[0]!.id);
        confidence = Math.max(confidence, 0.8);
      } else for (const h of hit) candidates.add(h.id);
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
  // a note that names someone in full who was not at the nearby meeting is about them, not the meeting
  const namedInText =
    !personIds.size && nearby.length
      ? mentionedPeople(inp.text, await db.people.where('userId').equals(user.id).toArray(), user.firstName)
          .full
      : [];
  if (
    nearby.length &&
    !(namedInText.length && !nearby.some((e) => namedInText.some((p) => e.attendeePersonIds.includes(p.id))))
  ) {
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
    // scan the text for people the student knows: full names, then first names that only one person has
    const people = await db.people.where('userId').equals(user.id).toArray();
    const m = mentionedPeople(inp.text, people, user.firstName);
    if (m.full.length === 1 && !m.byFirstName.length && !m.ambiguous.length) {
      personIds.add(m.full[0]!.id);
      confidence = 0.8;
    } else if (m.full.length || m.byFirstName.length) {
      // a likely match: attach it, and ask the student to confirm
      for (const p of [...m.full, ...m.byFirstName]) personIds.add(p.id);
      confidence = 0.7;
    }
    for (const p of m.ambiguous) candidates.add(p.id);
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
  const sure = ids.length > 0 && confidence >= 0.8;
  const note: MeetingNote = {
    id: newId('n'),
    userId: user.id,
    source: inp.source,
    externalId: inp.externalId,
    title:
      inp.title ??
      parsed?.title ??
      (primary && sure
        ? `Chat with ${primary.displayName}`
        : `Note from ${dayLabel(occurredAt, user.timezone || 'UTC')}`),
    occurredAt,
    rawText: inp.text,
    rawSummary: parsed?.summary,
    attendees,
    personIds: ids,
    // an unconfirmed guess touches nothing in the pipeline until the student confirms it
    chatId: sure ? chat?.id : undefined,
    calendarEventId,
    matchStatus: sure ? 'auto' : 'unmatched',
    matchConfidence: confidence,
    createdAt: now.toISOString(),
  };
  if (inp.externalId) {
    const dup = await db.notes.where('[source+externalId]').equals([inp.source, inp.externalId]).first();
    if (dup) return dup;
  }
  await db.notes.add(note);
  await processNote(user, note, now);
  if (note.matchStatus === 'unmatched')
    await upsertSuggestions(user.id, [await noteMatchCandidate(user, note, [...candidates])], now);
  return note;
}

/**
 * The "who was this note with?" card for a note Orbit could not match for sure: it names the person Orbit
 * guessed, or the people the note could be about. Raised as soon as the note is saved (so it is on Today
 * right away, not after the next brief) and refreshed by the brief with the same wording.
 */
export async function noteMatchCandidate(
  user: Pick<User, 'id' | 'timezone'>,
  note: MeetingNote,
  candidates?: string[],
): Promise<Candidate & { priorityScore: number }> {
  const dedupeKey = `note:${note.id}`;
  const known =
    candidates ??
    ((await db.suggestions.where('dedupeKey').equals(dedupeKey).first())?.payload.candidatePersonIds as
      | string[]
      | undefined) ??
    [];
  const guessed = (await db.people.bulkGet(note.personIds)).filter((p): p is Person => !!p);
  const others = (await db.people.bulkGet(known.filter((id) => !note.personIds.includes(id)))).filter(
    (p): p is Person => !!p && !p.hiddenAt,
  );
  const day = dayLabel(note.occurredAt, user.timezone || 'UTC');
  const everyone = [...guessed, ...others];
  // two people with the same name are told apart by where they work (or their address)
  const label = (p: Person) => {
    if (everyone.filter((q) => q.displayName === p.displayName).length < 2) return p.displayName;
    const where = p.currentOrganizationRaw ?? p.primaryEmail ?? p.emails[0];
    return where ? `${p.displayName} ${p.currentOrganizationRaw ? 'at' : 'with'} ${where}` : p.displayName;
  };
  const names = (ps: Person[], joiner: string) =>
    ps.length <= 2
      ? ps.map(label).join(` ${joiner} `)
      : `${ps.slice(0, -1).map(label).join(', ')}, ${joiner} ${label(ps[ps.length - 1]!)}`;
  const reasonText =
    guessed.length === 1
      ? `Was your note from ${day} with ${label(guessed[0]!)}?`
      : guessed.length > 1
        ? `Who was your note from ${day} with? It mentions ${names(guessed, 'and')}.`
        : others.length
          ? `Who was your note from ${day} with? It could be ${names(others, 'or')}.`
          : `Who was your note from ${day} with?`;
  return {
    kind: 'confirm_note_match',
    dedupeKey,
    reasonText,
    signals: {},
    payload: { noteId: note.id, candidatePersonIds: [...guessed, ...others].map((p) => p.id) },
    urgency: 0.5,
    goalRelevance: 0.3,
    confidence: 1,
    priorityScore: 0.3,
  };
}

/**
 * The student says who a note was with (or that it was with nobody they track). Whatever an earlier
 * guess wrote from this note is removed first, then the note is processed for the chosen person.
 */
export async function rematchNote(
  user: User,
  noteId: string,
  personId: string | undefined,
  now = new Date(),
): Promise<void> {
  const note = await db.notes.get(noteId);
  if (!note) return;
  await db.suggestions.where('dedupeKey').equals(`note:${noteId}`).modify({ status: 'done' });
  const previous = note.personIds;
  // an unconfirmed guess wrote nothing but the extraction; an automatic match wrote facts and pipeline state
  const applied = note.matchStatus !== 'unmatched' && !!note.processedAt;
  if (personId && previous.length === 1 && previous[0] === personId && applied) {
    await db.notes.update(noteId, { matchStatus: 'confirmed', matchConfidence: 1 });
    return;
  }
  if (previous.length) await retireNoteEffects(note, now);
  const chatId = personId
    ? (
        await db.chats
          .where('personId')
          .equals(personId)
          .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
          .first()
      )?.id
    : undefined;
  const person = personId ? await db.people.get(personId) : undefined;
  await db.notes.update(noteId, {
    personIds: personId ? [personId] : [],
    matchStatus: personId ? 'confirmed' : 'rejected',
    matchConfidence: 1,
    chatId,
    title: person && /^Note from /.test(note.title ?? '') ? `Chat with ${person.displayName}` : note.title,
  });
  const fresh = (await db.notes.get(noteId))!;
  if (personId) await processNote(user, fresh, now);
  for (const id of previous)
    if (id !== personId) {
      await recomputePersonStrength(id, now);
      await refreshPersonSummary(user, id);
    }
}

/**
 * Undo what processing a note wrote for the people it was matched to: facts, action items and
 * touchpoints from the note, the chat stage it moved (and the completion date it set), the
 * suggestions that only made sense because of that stage, and the "Notes are in" notification.
 */
async function retireNoteEffects(note: MeetingNote, now: Date): Promise<void> {
  const previous = note.personIds;
  const noteId = note.id;
  const fromNote = (x: { sourceTable?: string; sourceId?: string }) =>
    x.sourceTable === 'notes' && x.sourceId === noteId;
  const factIds = new Set(
    (await db.facts.where('personId').anyOf(previous).filter(fromNote).toArray()).map((f) => f.id),
  );
  await db.facts.where('personId').anyOf(previous).filter(fromNote).delete();
  await db.actionItems.where('personId').anyOf(previous).filter(fromNote).delete();
  await db.touchpoints
    .where('personId')
    .anyOf(previous)
    .filter((tp) => tp.refTable === 'notes' && (tp.refId === noteId || tp.refId === `${noteId}:meeting`))
    .delete();
  const at = now.toISOString();
  const reverted = new Set<string>();
  const events = await db.stageEvents
    .where('userId')
    .equals(note.userId)
    .filter((e) => e.evidenceRefTable === 'notes' && e.evidenceRefId === noteId && e.status !== 'rejected')
    .toArray();
  for (const ev of events) {
    await db.stageEvents.update(ev.id, { status: 'rejected', decidedAt: at });
    // a chat this note opened (the student met someone they had never messaged) goes with the note
    if (ev.reason === NOTE_OPENED_CHAT) {
      const opened = await db.chats.get(ev.chatId);
      if (opened && opened.stage === 'completed' && !opened.lastOutboundAt && !opened.lastInboundAt) {
        await db.chats.delete(opened.id);
        await db.suggestions
          .where('userId')
          .equals(note.userId)
          .filter((x) => x.chatId === opened.id && (x.status === 'pending' || x.status === 'snoozed'))
          .modify({ status: 'expired', decidedAt: at });
        continue;
      }
    }
    await db.suggestions
      .where('dedupeKey')
      .equals(`stage:${ev.id}`)
      .filter((x) => x.status === 'pending' || x.status === 'snoozed')
      .modify({ status: 'expired', decidedAt: at });
    const chat = await db.chats.get(ev.chatId);
    if (ev.status !== 'proposed' && chat && chat.stage === ev.toStage) {
      await db.chats.update(chat.id, {
        stage: ev.fromStage,
        stageEnteredAt: at,
        updatedAt: at,
        ...(ev.toStage === 'completed' ? { completedAt: undefined } : {}),
      });
      reverted.add(chat.id);
    }
  }
  for (const chat of await db.chats.where('personId').anyOf(previous).toArray()) {
    if (chat.completedAt && chat.completedAt === note.occurredAt && chat.stage !== 'completed') {
      await db.chats.update(chat.id, { completedAt: undefined, updatedAt: at });
      reverted.add(chat.id);
    }
  }
  // suggestions raised because the chat had happened no longer hold
  for (const chatId of reverted) {
    const stale = await db.suggestions
      .where('userId')
      .equals(note.userId)
      .filter(
        (x) =>
          x.chatId === chatId &&
          (x.status === 'pending' || x.status === 'snoozed') &&
          ['thank_you', 'ask_referral', 'report_back'].includes(x.kind),
      )
      .toArray();
    for (const x of stale) {
      await db.suggestions.update(x.id, { status: 'expired', decidedAt: at });
      if (x.outboundMessageId)
        await db.outbound
          .where('id')
          .equals(x.outboundMessageId)
          .filter((m) => m.status === 'draft')
          .modify({ status: 'cancelled' });
    }
  }
  await settleDraftsCiting(note.userId, previous, factIds, now);
  const body = note.extraction?.suggestedNextStep;
  await db.notifications
    .where('userId')
    .equals(note.userId)
    .filter(
      (x) =>
        previous.some((id) => x.link === `/people/${id}`) &&
        /^Notes from your chat with /.test(x.title) &&
        x.body === body,
    )
    .delete();
}

/**
 * Drafts that quote a fact the note had put on someone now cite something that person never said. An untouched
 * draft is written again from what is still known; one the student already edited cannot be rewritten, so it is
 * cancelled and its card retired.
 */
async function settleDraftsCiting(
  userId: string,
  personIds: string[],
  factIds: Set<string>,
  now: Date,
): Promise<void> {
  if (!factIds.size || !personIds.length) return;
  const drafts = await db.outbound
    .where('personId')
    .anyOf(personIds)
    .filter((m) => m.status === 'draft' && (m.claims ?? []).some((c) => !!c.factId && factIds.has(c.factId)))
    .toArray();
  const user = drafts.length ? await db.users.get(userId) : undefined;
  for (const d of drafts) {
    if (user && d.bodyFinal === undefined && (await regenerateDraft(user, d.id, {}, now))) continue;
    await db.outbound.update(d.id, { status: 'cancelled' });
    const s = d.suggestionId ? await db.suggestions.get(d.suggestionId) : undefined;
    if (s) await retireSuggestions([{ ...s, outboundMessageId: undefined }], 'note_moved', now);
  }
}

export async function processNote(user: User, note: MeetingNote, now = new Date()): Promise<void> {
  const notePeople = (await db.people.bulkGet(note.personIds)).filter((p): p is Person => !!p);
  const primary = notePeople.find((p) => p.id === note.personIds[0]);
  const ext =
    (hasLlm()
      ? await llmNoteExtraction(note.rawText, primary?.displayName, user.fullName).catch((e) =>
          surfaceLlmFailure(user.id, e),
        )
      : undefined) ??
    heuristicNoteExtraction(note.rawSummary ?? note.rawText, {
      people: notePeople.map((p) => ({ key: p.id, first: p.firstName, last: p.lastName || undefined })),
      userNames: [user.fullName, user.firstName].filter(Boolean),
      organizations: notePeople.map((p) => p.currentOrganizationRaw).filter((o): o is string => !!o),
    });
  await db.notes.update(note.id, { extraction: ext, summary: ext.summary, processedAt: now.toISOString() });
  note.extraction = ext;
  // nothing is written for a guess the student has not confirmed: no facts, no meeting, no chat stage,
  // no notification. Confirming it (rematchNote) processes the note again for the person they chose.
  if (!primary || note.matchStatus === 'unmatched') return;
  // A note is written after a conversation. Someone the student met without messaging first (a career fair, a club
  // event, an intro in person) has no chat yet: open one at "completed", so the thank-you comes next, not a cold
  // first message to the person they just talked to.
  if (!note.chatId) {
    const open = await db.chats
      .where('personId')
      .equals(primary.id)
      .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
      .first();
    if (open) {
      note.chatId = open.id;
    } else {
      const at = now.toISOString();
      const met = {
        id: newId('c'),
        userId: user.id,
        personId: primary.id,
        organizationId: primary.currentOrganizationId,
        stage: 'completed' as const,
        stageEnteredAt: note.occurredAt,
        source: 'detected' as const,
        goalTags: [],
        bumpCount: 0,
        priority: 2 as const,
        completedAt: note.occurredAt,
        createdAt: at,
        updatedAt: at,
      };
      await db.chats.add(met);
      await db.stageEvents.add({
        id: newId('se'),
        userId: user.id,
        chatId: met.id,
        toStage: 'completed',
        status: 'applied',
        actor: 'system',
        reason: NOTE_OPENED_CHAT,
        evidenceRefTable: 'notes',
        evidenceRefId: note.id,
        confidence: note.matchConfidence ?? 0.8,
        createdAt: at,
        decidedAt: at,
      });
      note.chatId = met.id;
      // the first-message card for this person no longer holds: they have already talked
      const firstMessage = await db.suggestions
        .where('personId')
        .equals(primary.id)
        .filter((x) => x.kind === 'new_outreach' && (x.status === 'pending' || x.status === 'snoozed'))
        .toArray();
      if (firstMessage.length) await retireSuggestions(firstMessage, 'superseded:met', now);
    }
    await db.notes.update(note.id, { chatId: note.chatId });
  }
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
  // the same promise written down twice (the notetaker's summary and the student's own note) is kept once
  const STOP = new Set([
    'i',
    'my',
    'me',
    'her',
    'him',
    'them',
    'the',
    'a',
    'an',
    'to',
    'and',
    'by',
    'of',
    'over',
    'send',
  ]);
  const words = (t: string) =>
    new Set(
      norm(t)
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const samePromise = (x: string, y: string) => {
    const a = words(x);
    const b = words(y);
    if (!a.size || !b.size) return false;
    const shared = [...a].filter((w) => b.has(w)).length;
    return shared / Math.min(a.size, b.size) >= 0.6;
  };
  for (const a of ext.actionItems) {
    if (a.owner !== 'user') continue;
    const pid = personFor(a.about).id;
    const open = await db.actionItems
      .where('personId')
      .equals(pid)
      .filter((x) => x.status === 'open')
      .toArray();
    if (open.some((x) => samePromise(x.text, a.text))) continue;
    const due = parseDueHint(a.dueHint, new Date(note.occurredAt), user.timezone);
    await db.actionItems.add({
      id: newId('ai'),
      userId: user.id,
      personId: pid,
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
      new Date(note.occurredAt),
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
  // a thank-you (or check-in) drafted before these notes arrived is redrafted with what they said
  await refreshPendingDrafts(user, { personId: primary.id });
  // and the fact-driven kinds (thank-you, check-in, referral ask) remember which facts they were drafted with, so
  // the validity pass does not re-draft them again for the same facts
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
