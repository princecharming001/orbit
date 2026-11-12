/**
 * Importing the student's texts from the Mac's Messages, so who they really talk to counts: a friend from class they
 * text every week is a close tie even if they never email (plan 43 §6). Read in this browser (see
 * integrations/imessageDb.ts); the words never leave it.
 *
 * - One-to-one chats both sides wrote in, and group chats of up to eight where the member and the student both wrote,
 *   from the last two years. The newest days come from chat.db-wal when the student gives it.
 * - A number or address is filed on a person only when Orbit can name them: someone already in Orbit with that
 *   number or address, or a name from the student's Contacts (exported as a vCard). Unnamed numbers are skipped, never
 *   guessed. A Contacts card goes through the same resolution as every other source (entity/resolve.ts): its numbers
 *   and addresses find the person they belong to, and its name can only suggest someone (a Gmail "Ana Ruiz" with
 *   another address is asked about, not merged), and someone with their own, different numbers is someone else.
 * - Numbers are compared in one form (+15551234567), read in the country the student's numbers are written for: their
 *   time zone or city, or the country most of their texts' numbers are from.
 * - Each day of texting, counted in the student's own time zone, is one touch each way (text_in, text_out) with the
 *   size of the chat (core weighs a group down) and whether anything was written (a day of tapbacks is light). A text
 *   back after the student's outreach proposes "replied" for that chat; the person's page shows the last few messages.
 * - Instagram and X handles on a Contacts card are kept on the person, as proof for matching accounts later.
 * - A signed-in student's browser then sends, per person and day, how many texts each way (POST /texts/days), with
 *   the name and numbers of a friend the server does not know yet. Never the words.
 *
 * Importing again updates everything without doubling it. Texts count only while the student's Texts switch is on
 * (engine/sources.ts); Off hides them from closeness, Remove deletes what was taken.
 */
import type { OptionalSource, Person, Touchpoint, User } from '@orbit/core';
import {
  compareNames,
  hasRealName,
  localDay,
  newId,
  normalizeEmail,
  parseName,
  phoneRegionFor,
} from '@orbit/core';
import { addTouchpoint, recomputeAllStrengths, recomputePersonStrength, studentTimeZone } from '../db/repo';
import { db, type IntegrationAccount, type TextThread } from '../db/schema';
import { readMessagesDb, type TextConversation } from '../integrations/imessageDb';
import { forgetSavedFolder } from '../integrations/messagesFolder';
import {
  callApi,
  isServerUser,
  type TextDaysRequest,
  type TextDayUpload,
  type TextPersonUpload,
} from '../integrations/orbitApi';
import { normalizePhone, parseVCards, type VCardContact } from '../integrations/vcard';
import { loadPeopleCache, upsertPerson } from './people';
import { setSourceState, sourceState } from './sources';
import { evaluateTrigger } from './stages';

const LOOKBACK_MS = 2 * 365 * 86_400_000;
const TEXTS: OptionalSource = 'imessage';
/** the student's exported contacts, kept in this browser only */
const contactsKey = (userId: string) => `texts:contacts:${userId}`;

/** Whether a contacts file from an earlier import is kept here. */
export async function hasSavedContacts(userId: string): Promise<boolean> {
  return !!(await db.kv.get(contactsKey(userId)))?.value;
}

export interface TextImportResult {
  people: number;
  created: number;
  /** chats filed: one per person texted one to one, one per group chat */
  conversations: number;
  /** texts with words, both ways */
  messages: number;
  skippedUnnamed: number;
  skippedOneWay: number;
  /** group chats in the file, of any size */
  groupChats: number;
  /** group chats of up to eight with someone Orbit could name */
  groupsRead: number;
  /** people whose Contacts card lists an Instagram or X handle */
  handles: number;
  /** whether the newest messages (chat.db-wal) were read */
  newest: boolean;
  /** a signed-in student's counts went up to Orbit's server; undefined in local mode */
  uploaded?: boolean;
  uploadError?: string;
}

export interface TextImportInput {
  messagesDb: Uint8Array;
  /** chat.db-wal from the same folder, with the newest messages */
  messagesWal?: Uint8Array;
  contactsVcf?: string;
}

/** One person's day of texts, summed over their chats: what goes to the server, never the words. */
interface DayCount {
  in: number;
  out: number;
  group: number;
  words: boolean;
}

export async function importTexts(
  user: User,
  input: TextImportInput,
  opts: { now?: Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<TextImportResult> {
  const now = opts.now ?? new Date();
  const timeZone = studentTimeZone(user);
  const read = await readMessagesDb(
    { db: input.messagesDb, wal: input.messagesWal },
    { since: new Date(now.getTime() - LOOKBACK_MS), timeZone },
  );
  const { conversations } = read;
  // the country the student's numbers are written for: chat.db keeps numbers with their country code, so most of
  // them say where the phone lives even when the student is travelling
  const region = phoneRegionFor(
    user,
    conversations.map((c) => c.handle).filter((h) => h.trim().startsWith('+')),
  );
  const handleKey = (h: string) => (h.includes('@') ? normalizeEmail(h) : normalizePhone(h, region));
  // the contacts file is kept in this browser, so the next update is one click and still names new numbers
  if (input.contactsVcf) await db.kv.put({ key: contactsKey(user.id), value: input.contactsVcf });
  const vcf = input.contactsVcf ?? ((await db.kv.get(contactsKey(user.id)))?.value as string | undefined);
  const contacts = vcf ? parseVCards(vcf, region) : [];
  const contactBy = new Map<string, VCardContact>();
  for (const c of contacts) for (const k of [...c.phones, ...c.emails]) contactBy.set(k, c);
  const cache = await loadPeopleCache(user.id);
  const personBy = new Map<string, Person>();
  for (const p of cache.people) {
    for (const ph of p.phones ?? []) personBy.set(ph, p);
    for (const e of p.emails) personBy.set(normalizeEmail(e), p);
  }
  const result: TextImportResult = {
    people: 0,
    created: 0,
    conversations: 0,
    messages: 0,
    skippedUnnamed: 0,
    skippedOneWay: 0,
    groupChats: read.groupChats,
    groupsRead: 0,
    handles: 0,
    newest: read.walFrames > 0,
  };
  // the switch goes on with the first import, so what is filed counts at once
  if ((await sourceState(TEXTS, user.id)) !== 'on') await setSourceState(TEXTS, 'on', user.id);
  const threads = new Map<string, TextThread>();
  const touched = new Set<string>();
  const unnamed = new Set<string>();
  const oneWay = new Set<string>();
  const groups = new Set<string>();
  const dayCounts = new Map<string, Map<string, DayCount>>();
  const daysByPerson = new Map<string, Set<string>>();
  let done = 0;
  for (const conv of conversations) {
    opts.onProgress?.(++done, conversations.length);
    const key = handleKey(conv.handle);
    if (!key) continue;
    // only chats both sides wrote in; in a group, a member counts only if they and the student both did
    if (!conv.inCount || !conv.outCount) {
      oneWay.add(`${conv.chat}|${key}`);
      continue;
    }
    const contact = contactBy.get(key);
    // someone already in Orbit with this number or address
    let person =
      personBy.get(key) ??
      contact?.emails.map((e) => personBy.get(normalizeEmail(e))).find(Boolean) ??
      contact?.phones.map((ph) => personBy.get(ph)).find(Boolean);
    // only someone the student's Contacts name in full: "Mom" or a lone first name is not filed as a new person
    const named = !!contact && hasRealName(nameOf(contact));
    if (!person) {
      if (!contact || !named) {
        unnamed.add(key);
        continue;
      }
      // a card nobody in Orbit has these numbers or addresses for goes through resolution like every other source:
      // its name can join someone only with evidence beyond the name, else it is a suggestion the student answers,
      // and someone with their own, different numbers is someone else
      const r = await upsertPerson(
        {
          userId: user.id,
          email: (key.includes('@') ? key : undefined) ?? contact.emails[0],
          displayName: contact.name,
          phones: [...new Set([...(key.includes('@') ? [] : [key]), ...contact.phones])],
          phonesVerified: true,
          companyRaw: contact.org,
          title: contact.title,
          source: 'imessage',
          userSchool: user.school,
          firstSeenAt: conv.firstAt,
        },
        cache,
      );
      person = r.person;
      if (r.created) result.created++;
    }
    // remember the numbers, so the next import (and the next conversation from them) finds them: this one, and the
    // card's others unless the card's name says it is someone else (one home line, two people)
    const card = contact && named ? compareNames(contact.name, person.displayName) : undefined;
    const cardIsThem = !!contact && !(card && card.score === 0 && card.given === 'different');
    const phones = [
      ...new Set([
        ...(person.phones ?? []),
        ...(key.includes('@') ? [] : [key]),
        ...(cardIsThem ? contact!.phones : []),
      ]),
    ];
    if (phones.length !== (person.phones ?? []).length) {
      await db.people.update(person.id, { phones });
      person = { ...person, phones };
    }
    for (const ph of person.phones ?? []) personBy.set(ph, person);
    for (const e of person.emails) personBy.set(normalizeEmail(e), person);
    await fileConversation(user, person, conv, key, timeZone);
    const counts = dayCounts.get(person.id) ?? new Map<string, DayCount>();
    const seen = daysByPerson.get(person.id) ?? new Set<string>();
    for (const d of conv.days) {
      seen.add(d.day);
      const c = counts.get(d.day) ?? { in: 0, out: 0, group: conv.group, words: false };
      c.in += d.inCount + d.inLight;
      c.out += d.outCount + d.outLight;
      c.group = Math.min(c.group, conv.group);
      c.words ||= d.inCount + d.outCount > 0;
      counts.set(d.day, c);
    }
    dayCounts.set(person.id, counts);
    daysByPerson.set(person.id, seen);
    threads.set(person.id, mergeThread(threads.get(person.id), user.id, person.id, conv, key, now));
    touched.add(person.id);
    if (conv.chat === 'direct') {
      result.conversations++;
      result.messages += conv.inCount + conv.outCount;
    } else {
      if (!groups.has(conv.chat)) {
        groups.add(conv.chat);
        result.conversations++;
        // the student's own texts to the group count once, whoever else is in it
        result.messages += conv.outCount;
      }
      result.messages += conv.inCount;
    }
  }
  for (const [pid, t] of threads) t.days = daysByPerson.get(pid)?.size ?? 0;
  await db.textThreads.bulkPut([...threads.values()]);
  result.handles = await keepContactHandles(contacts, personBy);
  for (const pid of touched) await recomputePersonStrength(pid, now);
  result.people = touched.size;
  result.skippedUnnamed = unnamed.size;
  result.skippedOneWay = oneWay.size;
  result.groupsRead = groups.size;
  if (isServerUser(user.id)) {
    const people = await db.people.bulkGet([...dayCounts.keys()]);
    const r = await uploadTextDays(
      textDaysBody(
        people.filter((p): p is Person => !!p),
        dayCounts,
      ),
    );
    result.uploaded = r.ok;
    if (!r.ok) result.uploadError = r.message;
  }
  await saveRow(user, result, now);
  return result;
}

/** A Contacts card's name as name fields ("Ana Ruiz", or the N field when the card has no FN). */
function nameOf(c: VCardContact) {
  const n =
    c.firstName || c.lastName ? { first: c.firstName ?? '', last: c.lastName ?? '' } : parseName(c.name);
  return { firstName: n.first, lastName: n.last, displayName: c.name };
}

/**
 * Instagram and X handles from the student's Contacts, kept on the person the card belongs to (found by a number or
 * an address, never by the name alone). Returns how many people gained a handle.
 */
async function keepContactHandles(contacts: VCardContact[], personBy: Map<string, Person>): Promise<number> {
  let n = 0;
  for (const c of contacts) {
    if (!c.handles.instagram.length && !c.handles.x.length) continue;
    const found = [...c.phones, ...c.emails].map((k) => personBy.get(k)).find(Boolean);
    if (!found) continue;
    const p = (await db.people.get(found.id)) ?? found;
    const had = p.contactHandles ?? {};
    const next = {
      instagram: [...new Set([...(had.instagram ?? []), ...c.handles.instagram])],
      x: [...new Set([...(had.x ?? []), ...c.handles.x])],
    };
    const contactHandles = {
      ...(next.instagram.length ? { instagram: next.instagram } : {}),
      ...(next.x.length ? { x: next.x } : {}),
    };
    if (JSON.stringify(contactHandles) !== JSON.stringify(had))
      await db.people.update(p.id, { contactHandles });
    n++;
  }
  return n;
}

/** A touch written or brought up to date: a later read can fill in words, an earlier first text, the chat's size. */
async function upsertTextTouch(tp: Omit<Touchpoint, 'id'>): Promise<void> {
  const existing = await db.touchpoints
    .where('[personId+refTable+refId]')
    .equals([tp.personId, tp.refTable, tp.refId])
    .first();
  if (!existing) {
    await addTouchpoint(tp);
    return;
  }
  if (
    existing.occurredAt !== tp.occurredAt ||
    existing.words !== tp.words ||
    existing.group !== tp.group ||
    existing.weight !== tp.weight
  )
    await db.touchpoints.update(existing.id, {
      occurredAt: tp.occurredAt,
      words: tp.words,
      group: tp.group,
      weight: tp.weight,
      summary: tp.summary,
    });
}

/**
 * A day of texting each way becomes one touch, dated by that day's first text that way, with the chat's size and
 * whether anything was written. A text back after the student's outreach proposes "replied" (the student confirms)
 * only when the outreach itself went out as a text, or the text is plainly about the ask; a friend texting about
 * something else after a LinkedIn note is not a reply.
 */
async function fileConversation(
  user: User,
  p: Person,
  conv: TextConversation,
  key: string,
  timeZone: string | undefined,
) {
  const direct = conv.chat === 'direct';
  const name = p.firstName || p.displayName;
  const ref = (day: string, way: 'in' | 'out') =>
    direct ? `${key}:${day}:${way}` : `${key}:${conv.chat}:${day}:${way}`;
  for (const d of conv.days) {
    for (const way of ['in', 'out'] as const) {
      const words = way === 'in' ? d.inCount : d.outCount;
      const light = way === 'in' ? d.inLight : d.outLight;
      if (!words && !light) continue;
      await upsertTextTouch({
        userId: user.id,
        personId: p.id,
        kind: way === 'in' ? 'text_in' : 'text_out',
        occurredAt: (way === 'in' ? d.firstInAt : d.firstOutAt) ?? d.firstAt,
        refTable: 'texts',
        refId: ref(d.day, way),
        summary: direct
          ? way === 'in'
            ? `Texts from ${name}`
            : `Texts to ${name}`
          : `Group texts with ${name} (${conv.group} people)`,
        weight: words ? (way === 'in' ? 0.6 : 0.45) : 0.2,
        group: conv.group,
        ...(words ? {} : { words: false }),
      });
    }
  }
  // only a one-to-one chat can answer an ask
  if (!direct) return;
  const waiting = await db.chats
    .where('personId')
    .equals(p.id)
    .filter((c) => c.stage === 'outreach_sent')
    .toArray();
  // a text about a networking ask (a chat, a call, a time, the role, a referral), unless plainly about something else
  const aboutTheAsk =
    /\b(chat|call|coffee|meet|meeting|zoom|hop on|catch up|happy to (?:help|chat|talk)|would love to|internship|interview|referral|refer you|resume|role|position|recruiting|\d{1,2} ?min(?:ute)?s?|(?:mon|tues|wednes|thurs|fri)day|next week)\b/i;
  const elsewhere = /\b(dinner|lol|haha|practice|party|game|ride)\b/i;
  for (const chat of waiting) {
    const since = chat.firstOutreachAt ?? chat.stageEnteredAt;
    const sinceMs = Date.parse(since);
    const inAt = (d: TextConversation['days'][number]) => d.firstInAt ?? d.firstAt;
    // the outreach went out as a text: by Messages from Orbit, or not by email or LinkedIn and the student texted
    // them around then
    const byText =
      chat.outreachChannel === 'imessage' ||
      (chat.outreachChannel !== 'gmail' &&
        chat.outreachChannel !== 'linkedin' &&
        conv.days.some(
          (d) =>
            d.outCount > 0 && Math.abs(Date.parse(d.firstOutAt ?? d.firstAt) - sinceMs) <= 36 * 3_600_000,
        ));
    // or one of their texts since then is about the ask (a chat, a call, a time, the role)
    const about = conv.recent.find(
      (m) => !m.fromMe && m.at > since && aboutTheAsk.test(m.text) && !elsewhere.test(m.text),
    );
    const back = byText
      ? conv.days.find((d) => d.inCount > 0 && inAt(d) > since)
      : about
        ? conv.days.find((d) => d.day === localDay(about.at, timeZone))
        : undefined;
    if (back)
      await evaluateTrigger(
        chat,
        // a text back is a reply, but it may be about anything: the student confirms it
        { type: 'inbound_signal', signal: 'reply_neutral', confidence: 0.7 },
        { table: 'texts', id: `${key}:${back.day}:in`, at: byText ? inAt(back) : about?.at },
      );
  }
}

function mergeThread(
  t: TextThread | undefined,
  userId: string,
  personId: string,
  conv: TextConversation,
  key: string,
  now: Date,
): TextThread {
  const direct = conv.chat === 'direct';
  const recent = [...(t?.recent ?? []), ...(direct ? conv.recent : [])]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-8);
  return {
    id: personId,
    userId,
    personId,
    handles: [...new Set([...(t?.handles ?? []), key])],
    inCount: (t?.inCount ?? 0) + conv.inCount,
    outCount: (t?.outCount ?? 0) + conv.outCount,
    firstAt: t && t.firstAt < conv.firstAt ? t.firstAt : conv.firstAt,
    lastAt: t && t.lastAt > conv.lastAt ? t.lastAt : conv.lastAt,
    recent,
    groups: (t?.groups ?? 0) + (direct ? 0 : 1),
    importedAt: now.toISOString(),
  };
}

/**
 * What a signed-in student's browser sends after an import (plan 43 §6, decision 1): per person and day, how many
 * texts each way, the smallest chat and whether anything was written; for a friend the server does not know yet, their
 * name and numbers. Built from counts alone, so no word of any message can be in it.
 */
export function textDaysBody(people: Person[], counts: Map<string, Map<string, DayCount>>): TextDaysRequest {
  const days: TextDayUpload[] = [];
  const out: TextPersonUpload[] = [];
  for (const p of people) {
    const byDay = counts.get(p.id);
    if (!byDay?.size) continue;
    // a person the server sent keeps its id (a uuid); one this browser made is named by its local id
    const known = UUID.test(p.id);
    if (!known) out.push({ ref: p.id, name: p.displayName, phones: [...(p.phones ?? [])] });
    for (const [day, c] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      days.push({
        ...(known ? { personId: p.id } : { ref: p.id }),
        day,
        in: c.in,
        out: c.out,
        group: c.group,
        words: c.words,
      });
  }
  return { days, people: out };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_BATCH = 2000;

/** POST /texts/days in batches; the first refusal stops it and says why. */
export async function uploadTextDays(
  body: TextDaysRequest,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!body.days.length) return { ok: true };
  for (let i = 0; i < body.days.length; i += UPLOAD_BATCH) {
    const days = body.days.slice(i, i + UPLOAD_BATCH);
    const refs = new Set(days.map((d) => d.ref).filter(Boolean));
    const r = await callApi('/texts/days', { days, people: body.people.filter((p) => refs.has(p.ref)) });
    if (!r.ok) return { ok: false, message: r.message };
  }
  return { ok: true };
}

async function saveRow(user: User, r: TextImportResult, now: Date) {
  const existing = await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'imessage')
    .first();
  const row: IntegrationAccount = {
    scopes: [],
    ...existing,
    id: existing?.id ?? newId('int'),
    userId: user.id,
    provider: 'imessage',
    status: 'active',
    connectedAt: existing?.connectedAt ?? now.toISOString(),
    lastSyncedAt: now.toISOString(),
    lastError: r.uploadError,
    syncState: {
      people: r.people,
      conversations: r.conversations,
      messages: r.messages,
      groups: r.groupsRead,
      newest: r.newest,
    },
  };
  await db.integrations.put(row);
}

/** Rescore everyone after a switch: two passes, since a person's score reads their neighbours' (plan 43 §3.2). */
async function rescoreAll(userId: string, now: Date) {
  await recomputeAllStrengths(userId, now);
  await recomputeAllStrengths(userId, now);
}

/**
 * The student's Texts switch, on or off. Off keeps everything and leaves it out of closeness and paths; On brings it
 * back as it was. In account mode the server rescores; here closeness is worked out again.
 */
export async function setTextsOn(
  user: Pick<User, 'id'>,
  on: boolean,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await setSourceState(TEXTS, on ? 'on' : 'off', user.id);
  if (!r.ok) return r;
  await rescoreAll(user.id, now);
  return { ok: true };
}

/**
 * Remove what Orbit took from texts: the touches (one-to-one and group), the histories, the server's days, the handles
 * from Contacts, and anyone known only from texts with nothing else of theirs in Orbit (no chat, note, message or
 * other history). People with any other history stay.
 */
export async function forgetTexts(
  user: Pick<User, 'id'>,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  // account mode: the server deletes its days and the friends only texts knew first; if it cannot, nothing changes
  const r = await setSourceState(TEXTS, 'removed', user.id);
  if (!r.ok) return r;
  const tps = await db.touchpoints
    .where('userId')
    .equals(user.id)
    .filter((t) => t.refTable === 'texts')
    .toArray();
  await db.touchpoints.bulkDelete(tps.map((t) => t.id));
  await db.textThreads.where('userId').equals(user.id).delete();
  await db.textDays.where('userId').equals(user.id).delete();
  await db.kv.delete(contactsKey(user.id));
  await forgetSavedFolder(user.id);
  const affected = new Set(tps.map((t) => t.personId));
  const people = await db.people.where('userId').equals(user.id).toArray();
  for (const p of people) if (p.contactHandles) await db.people.update(p.id, { contactHandles: undefined });
  for (const pid of affected) {
    const p = people.find((x) => x.id === pid);
    if (!p?.sources.every((s) => s === 'imessage')) continue;
    const [touches, chats, outbound, notes] = await Promise.all([
      db.touchpoints.where('personId').equals(pid).count(),
      db.chats.where('personId').equals(pid).count(),
      db.outbound.where('personId').equals(pid).count(),
      db.notes
        .where('userId')
        .equals(user.id)
        .filter((n) => n.personIds.includes(pid))
        .count(),
    ]);
    if (touches || chats || outbound || notes || p.notes?.trim()) continue;
    await db.transaction(
      'rw',
      [
        db.people,
        db.affiliations,
        db.personIdentities,
        db.edges,
        db.facts,
        db.recommendations,
        db.merges,
        db.tieLabels,
        db.tieScores,
      ],
      async () => {
        await db.affiliations.where('personId').equals(pid).delete();
        await db.personIdentities.where('personId').equals(pid).delete();
        await db.edges.where('personAId').equals(pid).delete();
        await db.edges.where('personBId').equals(pid).delete();
        await db.facts.where('personId').equals(pid).delete();
        await db.recommendations.where('personId').equals(pid).delete();
        await db.merges
          .where('userId')
          .equals(user.id)
          .filter((m) => m.personAId === pid || m.personBId === pid)
          .delete();
        await db.tieLabels.delete(pid);
        await db.tieScores.delete(pid);
        await db.people.delete(pid);
      },
    );
    affected.delete(pid);
  }
  for (const pid of affected) await recomputePersonStrength(pid, now);
  await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'imessage')
    .modify({ status: 'revoked', syncState: {} });
  return { ok: true };
}

export interface TextsStatus {
  /** the student's switch: not connected, on, off or removed */
  state: 'not_connected' | 'on' | 'off' | 'removed';
  /** an import has run and its rows are kept (on or off) */
  imported: boolean;
  people: number;
  conversations: number;
  groups: number;
  lastSyncedAt?: string;
  /** the last upload to the server did not go through */
  error?: string;
}

export async function textsStatus(user: Pick<User, 'id'>): Promise<TextsStatus> {
  const [row, state] = await Promise.all([
    db.integrations
      .where('userId')
      .equals(user.id)
      .filter((i) => i.provider === 'imessage')
      .first(),
    sourceState(TEXTS, user.id),
  ]);
  const kept = !!row && row.status === 'active' && state !== 'removed';
  const s = (row?.syncState ?? {}) as { people?: number; conversations?: number; groups?: number };
  return {
    state,
    imported: kept,
    people: kept ? Number(s.people ?? 0) : 0,
    conversations: kept ? Number(s.conversations ?? 0) : 0,
    groups: kept ? Number(s.groups ?? 0) : 0,
    lastSyncedAt: kept ? row.lastSyncedAt : undefined,
    ...(kept && row.lastError ? { error: row.lastError } : {}),
  };
}
