/**
 * LinkedIn replies, read the way Gmail replies are. With LinkedIn connected live in this browser, Orbit reads the
 * student's 1:1 LinkedIn chats and, when someone they wrote to answers, records it on that person's chat and moves it
 * on (Replied, Scheduling, Declined), with a notification. Messages from people Orbit has no chat with are left alone:
 * the inbox is not a source of new people.
 */
import type { CoffeeChat, Person, User } from '@orbit/core';
import { heuristicSignal, peopleNamed } from '@orbit/core';
import { notify } from '../db/repo';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import { type LinkedInInboxMessage, linkedInInbox, unipileConfigured } from '../integrations/unipile';
import { evaluateImmediateSuggestions } from './brief';
import { liveChatOf } from './drafts';
import { LIVE_SOON, liveLinkedInAccount } from './linkedinLive';
import { evaluateTrigger } from './stages';

const DAY = 86_400_000;
/** How far back the first read goes. */
const FIRST_LOOKBACK_DAYS = 30;
/** On app open, LinkedIn is read again at most this often. */
export const REPLY_CHECK_EVERY_MS = 15 * 60_000;
/** A reply older than this is recorded quietly, without a notification. */
const NOTIFY_WITHIN_MS = 3 * DAY;

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
    repliesAfter: r.value.latest ?? state.repliesAfter ?? after.toISOString(),
    repliesCheckedAt: now.toISOString(),
  };
  await db.integrations.update(row.id, { syncState: { ...(fresh?.syncState ?? row.syncState), ...next } });
  return { ok: true, replies: recorded.length, people: recorded };
}

/** On app open: read LinkedIn for replies unless it was read in the last quarter hour. Never throws. */
export async function autoSyncLinkedInReplies(
  user: Pick<User, 'id' | 'timezone'>,
  now = new Date(),
): Promise<ReplySyncResult | undefined> {
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return undefined;
  const checked = time((row.syncState as RepliesState).repliesCheckedAt);
  if (Number.isFinite(checked) && now.getTime() - checked < REPLY_CHECK_EVERY_MS) return undefined;
  return syncLinkedInReplies(user, { now }).catch(() => undefined);
}

/** Who a LinkedIn chat is with, among the student's people. */
async function personFor(
  counterpart: LinkedInInboxMessage['counterpart'],
  byMember: Map<string, Person>,
  people: Person[],
): Promise<{ person: Person; chat: CoffeeChat } | undefined> {
  let person = counterpart.providerId ? byMember.get(counterpart.providerId) : undefined;
  let byNameOnly = false;
  if (!person && counterpart.name) {
    // the shared name matcher (accents, scripts, nicknames, middle names), and only someone with no other LinkedIn id
    const same = peopleNamed(people, counterpart.name).filter(
      (p) => !p.linkedinMemberId || p.linkedinMemberId === counterpart.providerId,
    );
    if (same.length === 1) {
      person = same[0];
      byNameOnly = true;
    }
  }
  if (!person || person.hiddenAt) return undefined;
  const chat = await liveChatOf(person.id);
  if (!chat || chat.stage === 'archived') return undefined;
  // a name alone is trusted only for someone the student is writing to on LinkedIn
  if (byNameOnly && chat.outreachChannel !== 'linkedin') return undefined;
  if (counterpart.providerId && person.linkedinMemberId !== counterpart.providerId)
    await db.people.update(person.id, { linkedinMemberId: counterpart.providerId });
  return { person, chat };
}

/**
 * Record LinkedIn messages on the chats they belong to: the student's own messages keep "you wrote last" right, and
 * a new message from the other person is their reply. Returns the first names of the people who replied.
 */
export async function recordLinkedInMessages(
  user: Pick<User, 'id' | 'timezone'>,
  messages: LinkedInInboxMessage[],
  now = new Date(),
): Promise<string[]> {
  if (!messages.length) return [];
  const people = await db.people.where('userId').equals(user.id).toArray();
  const byMember = new Map(people.filter((p) => p.linkedinMemberId).map((p) => [p.linkedinMemberId!, p]));
  const chats = new Map<string, LinkedInInboxMessage[]>();
  for (const m of messages) {
    if (!Number.isFinite(time(m.at))) continue;
    chats.set(m.chatId, [...(chats.get(m.chatId) ?? []), m]);
  }
  const replied: string[] = [];
  for (const msgs of chats.values()) {
    const found = await personFor(msgs[0]!.counterpart, byMember, people);
    if (!found) continue;
    const { person, chat } = found;
    const sorted = [...msgs].sort((a, b) => time(a.at) - time(b.at));
    const at = now.toISOString();
    const lastOut = sorted.filter((m) => m.fromMe).at(-1);
    if (lastOut && !(time(chat.lastOutboundAt) >= time(lastOut.at))) {
      const changes: Partial<CoffeeChat> = {
        lastOutboundAt: new Date(time(lastOut.at)).toISOString(),
        firstOutreachAt:
          chat.firstOutreachAt ?? new Date(time(sorted.find((m) => m.fromMe)!.at)).toISOString(),
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
    const fresh = sorted.filter((m) => !m.fromMe && !(time(chat.lastInboundAt) >= time(m.at)));
    const reply = fresh.at(-1);
    if (!reply) continue;
    const replyAt = new Date(time(reply.at)).toISOString();
    await db.chats.update(chat.id, { lastInboundAt: replyAt, updatedAt: at });
    chat.lastInboundAt = replyAt;
    const text = fresh.map((m) => m.text).join('\n\n');
    const read = heuristicSignal(text, 'inbound', new Date(replyAt), {
      timeZone: user.timezone,
      awaitingAnswer: true,
    });
    const evidence = { table: 'linkedin_messages', id: reply.id, at: replyAt };
    // a person answering on LinkedIn is certain; what the answer means picks the stage
    const moved = await evaluateTrigger(
      chat,
      { type: 'inbound_signal', signal: read.signal, confidence: Math.max(read.confidence, 0.85) },
      evidence,
      now,
    );
    if (moved === 'none' && (chat.stage === 'outreach_sent' || chat.stage === 'no_response'))
      await evaluateTrigger(
        chat,
        { type: 'inbound_signal', signal: 'reply_neutral', confidence: 0.85 },
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
