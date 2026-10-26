/**
 * One conversation per person, whatever it went through (plan 25). LinkedIn 1:1 messages are kept as message rows
 * like email: a thread per LinkedIn chat (`channel: 'linkedin'`, `linkedin:<chat id>`) and a row per message
 * (`linkedin:<message id>`), written idempotently by the reply reader (engine/linkedinInbox.ts) and the history reader
 * (engine/linkedinActivity.ts), only for people Orbit has (by member id). Inbound messages are read like email
 * (core `heuristicSignal`). A LinkedIn thread is never a chat's `threadId`, which drives Gmail threading: LinkedIn
 * conversations are found by person.
 *
 * `latestReply` is the newest answer from someone across their chat's email thread and their LinkedIn chats, which
 * is what the cards and drafts answer; `conversationWith` is every message with them, Gmail, LinkedIn and the recent
 * iMessage texts, for the Messages tab and the chat.
 */
import type { CoffeeChat, EmailMessage, EmailThread, Person, Suggestion, User } from '@orbit/core';
import { heuristicSignal, newId } from '@orbit/core';
import { db } from '../db/schema';

export const LINKEDIN_THREAD_PREFIX = 'linkedin:';

/** One LinkedIn message as the readers have it. */
export interface LinkedInMessageIn {
  id: string;
  at: string;
  /** the student wrote it */
  out: boolean;
  text: string;
}

const time = (at: string | undefined) => (at ? Date.parse(at) : Number.NaN);
/** Stages in which the student's ask is still waiting on the person's answer (as engine/ingest.ts reads email). */
const AWAITING_ANSWER = new Set<CoffeeChat['stage']>(['outreach_sent', 'replied', 'no_response']);

/**
 * Keep one LinkedIn chat's messages with someone Orbit has: the thread, and each message not kept before. Returns the
 * thread and the messages added (oldest first).
 */
export async function storeLinkedInChat(
  user: Pick<User, 'id'> & { timezone?: string; email?: string },
  person: Pick<Person, 'id' | 'displayName' | 'firstName'>,
  chatId: string,
  messages: LinkedInMessageIn[],
  now: Date = new Date(),
): Promise<{ thread: EmailThread; added: EmailMessage[] }> {
  const key = `${LINKEDIN_THREAD_PREFIX}${chatId}`;
  let thread = await db.threads
    .where('externalThreadId')
    .equals(key)
    .filter((t) => t.userId === user.id)
    .first();
  if (!thread) {
    thread = {
      id: newId('th'),
      userId: user.id,
      externalThreadId: key,
      channel: 'linkedin',
      messageCount: 0,
      participantEmails: [],
      participantPersonIds: [person.id],
      category: 'networking',
      categoryConfidence: 1,
      isNetworking: true,
      classifiedAt: now.toISOString(),
      classifiedBy: 'heuristic',
    };
    await db.threads.add(thread);
  } else if (!thread.participantPersonIds.includes(person.id)) {
    // the same chat now known to be this person (a merge): keep them on it
    thread.participantPersonIds = [...thread.participantPersonIds, person.id];
    await db.threads.update(thread.id, { participantPersonIds: thread.participantPersonIds });
  }
  const chat = (await db.chats.where('personId').equals(person.id).toArray()).find(
    (c) => c.stage !== 'archived',
  );
  const added: EmailMessage[] = [];
  const sorted = [...messages]
    .filter((m) => Number.isFinite(time(m.at)) && m.text?.trim())
    .sort((a, b) => time(a.at) - time(b.at));
  for (const m of sorted) {
    const ext = `${LINKEDIN_THREAD_PREFIX}${m.id}`;
    if (await db.messages.where('externalMessageId').equals(ext).first()) continue;
    const sentAt = new Date(time(m.at)).toISOString();
    const read = m.out
      ? undefined
      : heuristicSignal(m.text, 'inbound', new Date(sentAt), {
          timeZone: user.timezone,
          awaitingAnswer: !!chat && AWAITING_ANSWER.has(chat.stage),
        });
    const row: EmailMessage = {
      id: newId('m'),
      userId: user.id,
      threadId: thread.id,
      externalMessageId: ext,
      channel: 'linkedin',
      direction: m.out ? 'outbound' : 'inbound',
      fromEmail: m.out ? (user.email ?? '').toLowerCase() : '',
      fromName: m.out ? undefined : person.displayName,
      toEmails: [],
      ccEmails: [],
      fromPersonId: m.out ? undefined : person.id,
      sentAt,
      bodyText: m.text.trim(),
      headers: {},
      isAutomated: false,
      ...(read
        ? { signal: read.signal, signalConfidence: read.confidence, extraction: read.extraction }
        : {}),
      processedAt: now.toISOString(),
    };
    await db.messages.add(row);
    added.push(row);
  }
  if (added.length) {
    const all = await db.messages.where('threadId').equals(thread.id).sortBy('sentAt');
    const patch = {
      messageCount: all.length,
      firstMessageAt: all[0]?.sentAt,
      lastMessageAt: all.at(-1)?.sentAt,
      snippet: all.at(-1)?.bodyText.slice(0, 140),
    };
    await db.threads.update(thread.id, patch);
    Object.assign(thread, patch);
  }
  return { thread, added };
}

/** A real answer from them: not an auto-reply, not an out-of-office note. */
const isReply = (m: EmailMessage) =>
  m.direction === 'inbound' && !m.isAutomated && m.signal !== 'out_of_office';

/**
 * The newest reply from the chat's person: on the chat's email thread, or in their LinkedIn chats (never another
 * email thread, where a group email or a newsletter is not an answer to this chat).
 */
export async function latestReply(
  chat: Pick<CoffeeChat, 'personId' | 'threadId'>,
): Promise<EmailMessage | undefined> {
  const [onThread, onLinkedIn] = await Promise.all([
    chat.threadId ? db.messages.where('threadId').equals(chat.threadId).toArray() : [],
    db.messages
      .where('fromPersonId')
      .equals(chat.personId)
      .filter((m) => m.channel === 'linkedin')
      .toArray(),
  ]);
  return [...onThread, ...onLinkedIn].filter(isReply).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
}

/** The newest LinkedIn reply from each person, for the card rules (one read for everyone). */
export async function linkedInRepliesByPerson(userId: string): Promise<Map<string, EmailMessage>> {
  const threads = await db.threads
    .where('userId')
    .equals(userId)
    .filter((t) => t.channel === 'linkedin')
    .toArray();
  const out = new Map<string, EmailMessage>();
  for (const t of threads)
    for (const m of await db.messages.where('threadId').equals(t.id).toArray()) {
      if (!isReply(m) || !m.fromPersonId) continue;
      const prev = out.get(m.fromPersonId);
      if (!prev || prev.sentAt < m.sentAt) out.set(m.fromPersonId, m);
    }
  return out;
}

/** The newer of two messages (either may be missing). */
export const newer = (a: EmailMessage | undefined, b: EmailMessage | undefined) =>
  !a ? b : !b ? a : b.sentAt > a.sentAt ? b : a;

/** One message in the Conversation tab: from any channel, in the shape the tab and the chat read. */
export interface ConversationItem {
  id: string;
  channel: 'gmail' | 'linkedin' | 'text';
  /** the student wrote it */
  out: boolean;
  at: string;
  text: string;
  subject?: string;
  /** for Gmail: the thread it is on, and whether others were on it */
  threadId?: string;
  group?: boolean;
  /** sent from Orbit, still in its undo window or going out */
  pending?: boolean;
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Every message with someone, oldest first: their Gmail threads (only messages they wrote or that were written to
 * them), their LinkedIn chats, and the recent texts Orbit imported from the Mac's Messages.
 */
export async function conversationWith(userId: string, personId: string): Promise<ConversationItem[]> {
  const person = await db.people.get(personId);
  if (!person) return [];
  const theirs = new Set(
    [person.primaryEmail, ...person.emails].filter(Boolean).map((e) => e!.toLowerCase()),
  );
  const threads = await db.threads
    .where('userId')
    .equals(userId)
    .filter((t) => (t.participantPersonIds ?? []).includes(personId))
    .toArray();
  const items: ConversationItem[] = [];
  for (const t of threads) {
    const msgs = await db.messages.where('threadId').equals(t.id).toArray();
    const linkedIn = t.channel === 'linkedin';
    for (const m of msgs) {
      if (m.isAutomated) continue;
      if (!linkedIn) {
        const toThem =
          m.direction === 'outbound' && [...m.toEmails, ...m.ccEmails].some((e) => theirs.has(e));
        const fromThem = m.direction === 'inbound' && m.fromPersonId === personId;
        if (!toThem && !fromThem) continue;
      }
      items.push({
        id: m.id,
        channel: linkedIn ? 'linkedin' : 'gmail',
        out: m.direction === 'outbound',
        at: m.sentAt,
        text: m.bodyText,
        ...(linkedIn ? {} : { subject: m.subject ?? t.subject, threadId: t.id }),
        ...(!linkedIn && t.participantPersonIds.length > 1 ? { group: true } : {}),
      });
    }
  }
  // what the student sent on LinkedIn from Orbit, until the next read of LinkedIn brings the message itself back
  const sentHere = (await db.outbound.where('personId').equals(personId).toArray()).filter(
    (o) => o.channel === 'linkedin' && ['queued', 'sending', 'sent'].includes(o.status),
  );
  const said = new Set(items.filter((i) => i.out && i.channel === 'linkedin').map((i) => squash(i.text)));
  for (const o of sentHere) {
    const text = o.bodyFinal ?? o.bodyDraft;
    if (said.has(squash(text))) continue;
    items.push({
      id: `out:${o.id}`,
      channel: 'linkedin',
      out: true,
      at: o.sentAt ?? o.queuedAt ?? o.approvedAt ?? o.createdAt,
      text,
      ...(o.status === 'sent' ? {} : { pending: true }),
    });
  }
  const texts = await db.textThreads.where('personId').equals(personId).toArray();
  for (const tt of texts)
    for (const [i, r] of tt.recent.entries())
      items.push({ id: `text:${tt.id}:${i}`, channel: 'text', out: r.fromMe, at: r.at, text: r.text });
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** The message a card is about, quoted on it: the reply it answers, the email behind a stage or intro question. */
export interface QuotedMessage {
  text: string;
  at: string;
  channel: 'gmail' | 'linkedin';
}

const quote = (m: EmailMessage | undefined): QuotedMessage | undefined =>
  m?.bodyText.trim()
    ? { text: m.bodyText.replace(/\s+/g, ' ').trim(), at: m.sentAt, channel: m.channel ?? 'gmail' }
    : undefined;

export async function quotedMessageFor(
  s: Pick<Suggestion, 'kind' | 'payload'>,
): Promise<QuotedMessage | undefined> {
  if (s.kind === 'confirm_intro' && typeof s.payload.messageId === 'string')
    return quote(await db.messages.get(s.payload.messageId));
  if (s.kind === 'confirm_stage' && typeof s.payload.stageEventId === 'string') {
    const e = await db.stageEvents.get(s.payload.stageEventId);
    if (e?.evidenceRefTable !== 'messages' || !e.evidenceRefId) return undefined;
    return quote(await db.messages.get(e.evidenceRefId));
  }
  if (typeof s.payload.inReplyTo === 'string') return quote(await db.messages.get(s.payload.inReplyTo));
  return undefined;
}

/** "wrote on LinkedIn Tue, Oct 21" / "wrote Tue, Oct 21" */
export function wroteWhen(q: Pick<QuotedMessage, 'at' | 'channel'>): string {
  const day = new Date(q.at).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return q.channel === 'linkedin' ? `wrote on LinkedIn ${day}` : `wrote ${day}`;
}
