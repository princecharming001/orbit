/**
 * Importing the student's texts from the Mac's Messages, so who they really talk to counts: a friend from class they
 * text every week is a close tie even if they never email. Read in this browser (see integrations/imessageDb.ts);
 * the messages never leave it.
 *
 * - Only one-to-one conversations both sides wrote in, from the last two years.
 * - A number or address is filed on a person only when Orbit can name them: someone already in Orbit with that
 *   number or address, or a name from the student's Contacts (exported as a vCard). Unnamed numbers are skipped, never
 *   guessed.
 * - Each day of texting is one touch each way (text_in, text_out), so closeness counts it; a text back after the
 *   student's outreach proposes "replied" for that chat; the person's page shows the last few messages.
 *
 * Importing again updates everything without doubling it.
 */
import type { Person, User } from '@orbit/core';
import { hasRealName, newId, normalizeEmail } from '@orbit/core';
import { addTouchpoint, recomputePersonStrength } from '../db/repo';
import { db, type IntegrationAccount, type TextThread } from '../db/schema';
import { readMessagesDb, type TextConversation } from '../integrations/imessageDb';
import { normalizePhone, parseVCards, type VCardContact } from '../integrations/vcard';
import { loadPeopleCache, upsertPerson } from './people';
import { evaluateTrigger } from './stages';

const LOOKBACK_MS = 2 * 365 * 86_400_000;

export interface TextImportResult {
  people: number;
  created: number;
  conversations: number;
  messages: number;
  skippedUnnamed: number;
  skippedOneWay: number;
  groupChats: number;
}

const handleKey = (h: string) => (h.includes('@') ? normalizeEmail(h) : normalizePhone(h));

export async function importTexts(
  user: User,
  input: { messagesDb: Uint8Array; contactsVcf?: string },
  opts: { now?: Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<TextImportResult> {
  const now = opts.now ?? new Date();
  const { conversations, groupChats } = await readMessagesDb(input.messagesDb, {
    since: new Date(now.getTime() - LOOKBACK_MS),
  });
  const contacts = input.contactsVcf ? parseVCards(input.contactsVcf) : [];
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
    groupChats,
  };
  const threads = new Map<string, TextThread>();
  const touched = new Set<string>();
  let done = 0;
  for (const conv of conversations) {
    opts.onProgress?.(++done, conversations.length);
    const key = handleKey(conv.handle);
    if (!key) continue;
    if (!conv.inCount || !conv.outCount) {
      result.skippedOneWay++;
      continue;
    }
    const contact = contactBy.get(key);
    let person =
      personBy.get(key) ??
      contact?.emails.map((e) => personBy.get(normalizeEmail(e))).find(Boolean) ??
      contact?.phones.map((ph) => personBy.get(ph)).find(Boolean);
    if (!person) {
      // only someone the student's Contacts name in full: "Mom" or a lone first name is not filed as a person
      const parts = contact?.name.trim().split(/\s+/) ?? [];
      if (
        !contact ||
        !hasRealName({
          firstName: parts[0] ?? '',
          lastName: parts.slice(1).join(' '),
          displayName: contact.name,
        })
      ) {
        result.skippedUnnamed++;
        continue;
      }
      const email = contact.emails[0] ?? (key.includes('@') ? key : undefined);
      const r = await upsertPerson(
        {
          userId: user.id,
          email,
          displayName: contact.name,
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
    // remember the number, so the next import (and the next conversation from it) finds them
    if (!key.includes('@')) {
      const phones = [...new Set([...(person.phones ?? []), key, ...(contact?.phones ?? [])])];
      if (phones.length !== (person.phones ?? []).length) {
        await db.people.update(person.id, { phones });
        person = { ...person, phones };
      }
    }
    for (const ph of person.phones ?? []) personBy.set(ph, person);
    await fileConversation(user, person, conv, key);
    const t = threads.get(person.id);
    threads.set(person.id, mergeThread(t, user.id, person.id, conv, key, now));
    touched.add(person.id);
    result.conversations++;
    result.messages += conv.inCount + conv.outCount;
  }
  await db.textThreads.bulkPut([...threads.values()]);
  for (const pid of touched) await recomputePersonStrength(pid, now);
  result.people = touched.size;
  await saveRow(user, result, now);
  return result;
}

/** A day of texting each way becomes one touch; a text back after the student's outreach proposes "replied". */
async function fileConversation(user: User, p: Person, conv: TextConversation, key: string) {
  for (const d of conv.days) {
    if (d.inCount)
      await addTouchpoint({
        userId: user.id,
        personId: p.id,
        kind: 'text_in',
        occurredAt: d.firstAt,
        refTable: 'texts',
        refId: `${key}:${d.day}:in`,
        summary: `Texts from ${p.firstName || p.displayName}`,
        weight: 0.6,
      });
    if (d.outCount)
      await addTouchpoint({
        userId: user.id,
        personId: p.id,
        kind: 'text_out',
        occurredAt: d.firstAt,
        refTable: 'texts',
        refId: `${key}:${d.day}:out`,
        summary: `Texts to ${p.firstName || p.displayName}`,
        weight: 0.45,
      });
  }
  const waiting = await db.chats
    .where('personId')
    .equals(p.id)
    .filter((c) => c.stage === 'outreach_sent')
    .toArray();
  for (const chat of waiting) {
    const since = chat.firstOutreachAt ?? chat.stageEnteredAt;
    const back = conv.days.find((d) => d.inCount > 0 && d.firstAt > since);
    if (back)
      await evaluateTrigger(
        chat,
        // a text back is a reply, but it may be about anything: the student confirms it
        { type: 'inbound_signal', signal: 'reply_neutral', confidence: 0.7 },
        { table: 'texts', id: `${key}:${back.day}:in`, at: back.firstAt },
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
  const recent = [...(t?.recent ?? []), ...conv.recent].sort((a, b) => a.at.localeCompare(b.at)).slice(-8);
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
    importedAt: now.toISOString(),
  };
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
    lastError: undefined,
    syncState: { people: r.people, conversations: r.conversations, messages: r.messages },
  };
  await db.integrations.put(row);
}

/** Forget the texts: the history and the touches go; people stay (they may have other history). */
export async function forgetTexts(user: Pick<User, 'id'>, now = new Date()): Promise<void> {
  const tps = await db.touchpoints
    .where('userId')
    .equals(user.id)
    .filter((t) => t.refTable === 'texts')
    .toArray();
  await db.touchpoints.bulkDelete(tps.map((t) => t.id));
  await db.textThreads.where('userId').equals(user.id).delete();
  for (const pid of new Set(tps.map((t) => t.personId))) await recomputePersonStrength(pid, now);
  await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'imessage')
    .modify({ status: 'revoked', syncState: {} });
}

export async function textsStatus(user: Pick<User, 'id'>) {
  const row = await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'imessage')
    .first();
  const on = !!row && row.status === 'active';
  return {
    imported: on,
    people: on ? Number((row.syncState as { people?: number }).people ?? 0) : 0,
    lastSyncedAt: on ? row.lastSyncedAt : undefined,
  };
}
