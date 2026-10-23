/**
 * One-time repair of false "they replied" (plan 17 B / F), for a student's own profile (never the demo, never an Orbit
 * account, whose pipeline lives on the server). Older versions:
 *
 * - counted any LinkedIn message from someone as their reply (even one from before the student wrote, or from an old
 *   conversation), and any email in a one-to-one thread (even when they wrote first), and moved the chat on by
 *   themselves; an old LinkedIn message of the student's could also mark a chat "First message sent";
 * - wrote a "They replied" touch for any move to Replied or later, and a "Coffee chat" meeting for any move to
 *   Completed, which then counted as real messages and meetings in closeness.
 *
 * This undoes the system's own moves to Replied (and anything after, when nothing but those inbox readers moved the
 * chat) that have no message from them after the outreach, removes the invented touches that no message, meeting or
 * move of the student's backs, and rescores the people affected. Anything the student moved, confirmed or did
 * themselves stays. Runs once per profile per version, recorded in `kv`.
 */
import type { ChatStage, CoffeeChat, StageEvent, User } from '@orbit/core';
import { AWAITING_FIRST_REPLY, kindAllowedInStage, sentForChat } from '@orbit/core';
import { recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import { DEMO_USER_ID } from './demo';
import { retireSuggestions } from './stages';

export const REPLY_REPAIR_VERSION = '2026-10-22-replies';

const REPLIED_OR_LATER: ReadonlySet<ChatStage> = new Set([
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
]);
const MET: ReadonlySet<ChatStage> = new Set(['completed', 'followed_up', 'nurturing']);
/** The readers whose replies older versions trusted too easily. */
const INBOX_TABLES = new Set(['linkedin_messages', 'messages']);

export interface ReplyRepairStats {
  /** chats moved back to where they stood before the false reply */
  chats: number;
  /** invented "They replied" and "Coffee chat" touches removed */
  touches: number;
  /** people rescored */
  people: number;
}

const applied = (e: StageEvent) => e.status === 'applied' || e.status === 'confirmed';
const ms = (at: string | undefined) => (at ? Date.parse(at) : Number.NaN);

/**
 * When this chat's ask really went out: an introduction, an outreach the student sent for it (not an old message
 * from before the chat), a message Orbit sent, or the student marking it sent. Undefined when none is on record.
 */
async function realOutreachAt(chat: CoffeeChat, events: StageEvent[]): Promise<string | undefined> {
  const sent = await db.outbound
    .where('personId')
    .equals(chat.personId)
    .filter((o) => o.status === 'sent' && !!o.sentAt && (!o.chatId || o.chatId === chat.id))
    .toArray();
  const times = [
    chat.introducedAt,
    chat.firstOutreachAt && sentForChat(chat, chat.firstOutreachAt) ? chat.firstOutreachAt : undefined,
    ...sent.map((o) => o.sentAt),
    ...events
      .filter((e) => e.actor === 'user' && applied(e) && e.toStage === 'outreach_sent')
      .map((e) => e.createdAt),
  ].filter((t): t is string => !!t && Number.isFinite(ms(t)));
  return times.sort()[0];
}

/** Whether they wrote to the student (an email or a LinkedIn message Orbit recorded) after `after`. */
async function heardAfter(chat: CoffeeChat, after: string): Promise<boolean> {
  const emails = await db.messages
    .where('fromPersonId')
    .equals(chat.personId)
    .filter((m) => m.direction === 'inbound' && !m.isAutomated && m.sentAt > after)
    .count();
  if (emails) return true;
  const dms = await db.touchpoints
    .where('personId')
    .equals(chat.personId)
    .filter((t) => t.kind === 'linkedin_in' && t.refTable === 'linkedin_dm' && t.occurredAt > after)
    .count();
  return dms > 0;
}

/** When the message that moved the chat was written, if Orbit can tell. */
async function evidenceTime(chat: CoffeeChat, e: StageEvent): Promise<string | undefined> {
  if (e.evidenceRefTable === 'messages' && e.evidenceRefId) {
    const m = await db.messages.get(e.evidenceRefId);
    // an email the student sent is not their reply
    if (m?.direction !== 'inbound') return undefined;
    return m.sentAt;
  }
  // LinkedIn messages are not kept: the time they were recorded at (the "They replied" touch, or the chat's last
  // message from them)
  const tp = await db.touchpoints
    .where('[personId+refTable+refId]')
    .equals([chat.personId, 'stage_evidence', `${chat.id}:replied`])
    .first();
  return tp?.occurredAt ?? chat.lastInboundAt;
}

/** Undo the false reply on one chat; returns whether it moved. */
async function repairChat(chat: CoffeeChat, now: Date): Promise<boolean> {
  const events = (await db.stageEvents.where('chatId').equals(chat.id).toArray()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  // the move into Replied or later, made by the inbox readers from a stage still waiting on a first reply
  const i = events.findIndex(
    (e) =>
      applied(e) &&
      e.actor === 'system' &&
      REPLIED_OR_LATER.has(e.toStage) &&
      !!e.fromStage &&
      AWAITING_FIRST_REPLY.has(e.fromStage) &&
      INBOX_TABLES.has(e.evidenceRefTable ?? ''),
  );
  if (i < 0) return false;
  const first = events[i]!;
  // everything since then was the same readers' doing (no calendar, notes or student move built on it)
  const since = events.slice(i).filter(applied);
  if (since.some((e) => e.actor !== 'system' || !INBOX_TABLES.has(e.evidenceRefTable ?? ''))) return false;
  if (!REPLIED_OR_LATER.has(chat.stage) || since.at(-1)?.toStage !== chat.stage) return false;
  const outreach = await realOutreachAt(chat, events);
  const replyAt = await evidenceTime(chat, first);
  if (outreach && replyAt && ms(replyAt) > ms(outreach)) return false;
  // the reply that moved it came first, but they did answer the ask later: the chat stands where it is
  if (outreach && (await heardAfter(chat, outreach))) return false;
  // where it stood before; a "First message sent" the LinkedIn reader made from an old message goes too
  let to = first.fromStage!;
  const rejected = [...since];
  const before = events.slice(0, i).filter(applied).at(-1);
  if (
    to === 'outreach_sent' &&
    !outreach &&
    before?.toStage === 'outreach_sent' &&
    before.actor === 'system' &&
    before.evidenceRefTable === 'linkedin_messages' &&
    before.fromStage
  ) {
    to = before.fromStage;
    rejected.push(before);
  }
  const iso = now.toISOString();
  const prior = events.filter((e) => applied(e) && !rejected.includes(e)).at(-1);
  const changes: Partial<CoffeeChat> = {
    stage: to,
    stageEnteredAt: prior?.createdAt ?? chat.createdAt,
    // their message before the outreach was no reply: "waiting on a reply" again
    lastInboundAt: undefined,
    updatedAt: iso,
  };
  if (!outreach && (to === 'identified' || to === 'warming')) {
    changes.firstOutreachAt = undefined;
    changes.lastOutboundAt = undefined;
  }
  await db.chats.update(chat.id, changes);
  for (const e of rejected)
    await db.stageEvents.update(e.id, {
      status: 'rejected',
      reason: `${e.reason}|repair:no_reply_after_outreach`,
      decidedAt: iso,
    });
  const open = await db.suggestions
    .where('chatId')
    .equals(chat.id)
    .filter(
      (s) =>
        (s.status === 'pending' || s.status === 'snoozed') &&
        s.kind !== 'confirm_stage' &&
        !kindAllowedInStage(s.kind, to),
    )
    .toArray();
  await retireSuggestions(open, 'repair:no_reply_after_outreach', now);
  return true;
}

export async function repairFalseReplies(
  user: Pick<User, 'id'>,
  now = new Date(),
): Promise<ReplyRepairStats | undefined> {
  if (user.id === DEMO_USER_ID || isServerUser(user.id) || usesMockConnectors(user.id)) return undefined;
  const key = `repair:${REPLY_REPAIR_VERSION}:${user.id}`;
  if (await db.kv.get(key)) return undefined;
  const stats: ReplyRepairStats = { chats: 0, touches: 0, people: 0 };
  const rescore = new Set<string>();

  // 1. chats moved to Replied by a message that was no reply
  const chats = await db.chats.where('userId').equals(user.id).toArray();
  for (const c of chats) {
    if (await repairChat(c, now)) {
      stats.chats++;
      rescore.add(c.personId);
    }
  }

  // 2. "They replied" and "Coffee chat" touches nothing backs
  const byId = new Map((await db.chats.where('userId').equals(user.id).toArray()).map((c) => [c.id, c]));
  const invented = await db.touchpoints
    .where('userId')
    .equals(user.id)
    .filter((t) => t.refTable === 'stage_evidence')
    .toArray();
  for (const t of invented) {
    const sep = t.refId.lastIndexOf(':');
    const chat = byId.get(t.refId.slice(0, sep));
    const what = t.refId.slice(sep + 1);
    const events = chat ? await db.stageEvents.where('chatId').equals(chat.id).toArray() : [];
    const studentSaid = (stages: ReadonlySet<ChatStage>) =>
      events.some((e) => e.actor === 'user' && applied(e) && stages.has(e.toStage));
    let keep = false;
    if (chat && what === 'replied') keep = studentSaid(REPLIED_OR_LATER) && REPLIED_OR_LATER.has(chat.stage);
    else if (chat && what === 'met') {
      const ev = chat.scheduledEventId ? await db.events.get(chat.scheduledEventId) : undefined;
      const happened = !!ev && ev.status !== 'cancelled' && ev.startAt <= now.toISOString();
      keep = (studentSaid(MET) || happened) && MET.has(chat.stage);
    }
    if (keep) continue;
    await db.touchpoints.delete(t.id);
    stats.touches++;
    rescore.add(t.personId);
  }

  // 3. closeness without them
  for (const id of rescore) {
    await recomputePersonStrength(id, now);
    stats.people++;
  }
  await db.kv.put({ key, value: { at: now.toISOString(), ...stats } });
  return stats;
}
