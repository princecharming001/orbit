/**
 * LinkedIn replies, read the way Gmail replies are. With LinkedIn connected live in this browser, Orbit reads the
 * student's 1:1 LinkedIn chats and, when someone they wrote to answers, records it on that person's chat and moves it
 * on (Replied, Scheduling, Declined), with a notification. Messages from people Orbit has no chat with are left alone:
 * the inbox is not a source of new people.
 *
 * What counts (plan 17 B): the person is matched by their LinkedIn member id only (a name could be a namesake, and
 * no id is ever written from a name). The student's own message is this chat's outreach only when it was sent for
 * it: after the chat was opened, or within two weeks before (they wrote, then added the person); an older one is
 * history. Their message is a reply only when it came after that outreach. A first reply moves the chat on by itself
 * when Orbit knows the ask went out on LinkedIn (it sent it, or it read the student's own message there first);
 * otherwise it is proposed (0.7) for the student to confirm. Every message read is also a touch for closeness
 * (engine/linkedinActivity.ts). Runs every few minutes while the app is open (engine/checkReplies.ts).
 */
import type { CoffeeChat, User } from '@orbit/core';
import { AWAITING_FIRST_REPLY, answersOutreach, heuristicSignal, sentForChat } from '@orbit/core';
import { notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import { type LinkedInInboxMessage, linkedInInbox, unipileConfigured } from '../integrations/unipile';
import { evaluateImmediateSuggestions } from './brief';
import { liveChatOf } from './drafts';
import { recordDmTouches } from './linkedinActivity';
import { LIVE_SOON, liveLinkedInAccount } from './linkedinLive';
import { evaluateTrigger } from './stages';

const DAY = 86_400_000;
/** How far back the first read goes. */
const FIRST_LOOKBACK_DAYS = 30;
/** A reply older than this is recorded quietly, without a notification. */
const NOTIFY_WITHIN_MS = 3 * DAY;
/** A first reply Orbit is not sure of is proposed at this confidence, for the student to confirm. */
const UNSURE_REPLY = 0.7;

/** What the reply reader keeps on the live LinkedIn row, next to the connection sync's own state. */
interface RepliesState {
  /** the newest LinkedIn message time seen; the next read starts just before it */
  repliesAfter?: string;
  /** when LinkedIn was last read for replies */
  repliesCheckedAt?: string;
}

export type ReplySyncResult =
  | { ok: true; replies: number; people: string[] }
  | { ok: false; reason: 'not_connected' | 'unconfigured' | 'error'; message: string };

const none: ReplySyncResult = { ok: true, replies: 0, people: [] };
const time = (at: string | undefined) => (at ? Date.parse(at) : Number.NaN);

/**
 * Read the student's LinkedIn messages since the last read and record the replies. Does nothing for an Orbit account
 * (its server holds LinkedIn) or the sample student (whose LinkedIn is a mock).
 */
export async function syncLinkedInReplies(
  user: Pick<User, 'id' | 'timezone'>,
  opts: { now?: Date; fetch?: typeof fetch } = {},
): Promise<ReplySyncResult> {
  const now = opts.now ?? new Date();
  if (isServerUser(user.id) || usesMockConnectors(user.id)) return none;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId)
    return { ok: false, reason: 'not_connected', message: 'LinkedIn is not connected live.' };
  if (!unipileConfigured() || !row.accessToken)
    return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
  const state = row.syncState as RepliesState;
  const last = time(state.repliesAfter);
  const after = new Date(Number.isFinite(last) ? last - 60_000 : now.getTime() - FIRST_LOOKBACK_DAYS * DAY);
  const r = await linkedInInbox(row.externalAccountId, after, { token: row.accessToken, fetch: opts.fetch });
  if (!r.ok)
    return { ok: false, reason: r.reason === 'unconfigured' ? 'unconfigured' : 'error', message: r.message };
  const recorded = await recordLinkedInMessages(user, r.value.messages, now);
  // the connection sync writes this row too: merge into what is there now
  const fresh = await liveLinkedInAccount(user.id);
  const next: RepliesState = {
    // read to the end: the newest message is the next checkpoint. Cut short (more than one read takes, or messages
    // whose chat could not be found): the unread ones are older than those read, so the checkpoint stays where it
    // was and they are read next time (what was read is not recorded twice)
    repliesAfter: r.value.complete
      ? (r.value.latest ?? state.repliesAfter ?? after.toISOString())
      : (state.repliesAfter ?? after.toISOString()),
    repliesCheckedAt: now.toISOString(),
  };
  await db.integrations.update(row.id, { syncState: { ...(fresh?.syncState ?? row.syncState), ...next } });
  return { ok: true, replies: recorded.length, people: recorded };
}

/** Orbit itself sent this chat a LinkedIn message before `at` (not a hand-off the student sent). */
async function orbitSentOnLinkedIn(chat: CoffeeChat, at: string): Promise<boolean> {
  const sent = await db.outbound
    .where('personId')
    .equals(chat.personId)
    .filter(
      (o) =>
        o.channel === 'linkedin' &&
        o.status === 'sent' &&
        !!o.providerMessageId &&
        (!o.chatId || o.chatId === chat.id) &&
        !!o.sentAt &&
        o.sentAt < at,
    )
    .count();
  return sent > 0;
}

/**
 * Record LinkedIn messages on the chats they belong to: the student's own messages keep "you wrote last" right, and
 * a new message from the other person after the outreach is their reply. Returns the first names of the people who
 * replied.
 */
export async function recordLinkedInMessages(
  user: Pick<User, 'id' | 'timezone'>,
  messages: LinkedInInboxMessage[],
  now = new Date(),
): Promise<string[]> {
  if (!messages.length) return [];
  const people = await db.people.where('userId').equals(user.id).toArray();
  // by member id only: the same name is not the same person, and no member id is ever taken from a name
  const byMember = new Map(
    people.filter((p) => p.linkedinMemberId && !p.hiddenAt).map((p) => [p.linkedinMemberId!, p]),
  );
  const chats = new Map<string, LinkedInInboxMessage[]>();
  for (const m of messages) {
    if (!Number.isFinite(time(m.at))) continue;
    chats.set(m.chatId, [...(chats.get(m.chatId) ?? []), m]);
  }
  const replied: string[] = [];
  for (const msgs of chats.values()) {
    const providerId = msgs[0]!.counterpart.providerId;
    const person = providerId ? byMember.get(providerId) : undefined;
    if (!person) continue;
    const sorted = [...msgs].sort((a, b) => time(a.at) - time(b.at));
    // every message is part of their history with the student, whatever the chat says
    if (
      await recordDmTouches(
        user.id,
        person,
        sorted.map((m) => ({ at: m.at!, out: m.fromMe, text: m.text })),
      )
    )
      await recomputePersonStrength(person.id, now);
    const chat = await liveChatOf(person.id);
    if (!chat || chat.stage === 'archived') continue;
    const at = now.toISOString();
    // the student's messages sent for this chat: an older one is history, not this chat's outreach
    const forChat = sorted.filter((m) => m.fromMe && sentForChat(chat, m.at));
    const lastOut = forChat.at(-1);
    if (lastOut && !(time(chat.lastOutboundAt) >= time(lastOut.at))) {
      const changes: Partial<CoffeeChat> = {
        lastOutboundAt: new Date(time(lastOut.at)).toISOString(),
        firstOutreachAt: chat.firstOutreachAt ?? new Date(time(forChat[0]!.at)).toISOString(),
        updatedAt: at,
      };
      await db.chats.update(chat.id, changes);
      Object.assign(chat, changes);
      // they wrote to the person on LinkedIn themselves: the outreach is done
      if (chat.stage === 'identified' || chat.stage === 'warming')
        await evaluateTrigger(
          chat,
          { type: 'outbound_sent', kind: 'outreach' },
          { table: 'linkedin_messages', id: lastOut.id, at: lastOut.at },
          now,
        );
    }
    // their messages since the last one recorded, and only those that answer the outreach (someone who wrote first,
    // or an old conversation, has not replied to anything)
    const fresh = sorted.filter(
      (m) => !m.fromMe && !(time(chat.lastInboundAt) >= time(m.at)) && answersOutreach(chat, m.at),
    );
    const reply = fresh.at(-1);
    if (!reply) continue;
    const replyAt = new Date(time(reply.at)).toISOString();
    const firstReply = AWAITING_FIRST_REPLY.has(chat.stage);
    await db.chats.update(chat.id, { lastInboundAt: replyAt, updatedAt: at });
    chat.lastInboundAt = replyAt;
    const text = fresh.map((m) => m.text).join('\n\n');
    const read = heuristicSignal(text, 'inbound', new Date(replyAt), {
      timeZone: user.timezone,
      awaitingAnswer: true,
    });
    const evidence = { table: 'linkedin_messages', id: reply.id, at: replyAt };
    // a first reply moves the chat by itself when Orbit knows the ask went out on LinkedIn: it sent the outreach
    // there, or it read the student's own message to this person in this same inbox before the reply came. A
    // LinkedIn message answering an ask that went out some other way (by email) is proposed for the student to
    // confirm: it may be about anything. Later messages keep what the reading says.
    const askedHere = forChat.some((m) => time(m.at) <= time(reply.at));
    const sure = firstReply && (askedHere || (await orbitSentOnLinkedIn(chat, replyAt)));
    const confidence = !firstReply
      ? read.confidence
      : sure
        ? Math.max(read.confidence, 0.85)
        : Math.min(read.confidence, UNSURE_REPLY);
    const moved = await evaluateTrigger(
      chat,
      { type: 'inbound_signal', signal: read.signal, confidence },
      evidence,
      now,
    );
    if (moved === 'none' && (chat.stage === 'outreach_sent' || chat.stage === 'no_response'))
      await evaluateTrigger(
        chat,
        { type: 'inbound_signal', signal: 'reply_neutral', confidence: sure ? 0.85 : UNSURE_REPLY },
        evidence,
        now,
      );
    replied.push(person.firstName);
    if (now.getTime() - time(replyAt) < NOTIFY_WITHIN_MS)
      await notify(
        user.id,
        'reply_received',
        `${person.firstName} replied on LinkedIn`,
        reply.text.slice(0, 120),
        `/people/${person.id}`,
      );
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: person.id }, now).catch(
      () => undefined,
    );
  }
  return replied;
}
