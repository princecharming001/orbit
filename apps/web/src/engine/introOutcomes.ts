/**
 * How the student's intro asks turned out (plan 21 §8), for learning which routes work: each ask keeps its route as it
 * was weighed (engine/drafts.ts `requestIntro`), and the outcome is read from what Orbit already sees — an
 * introduction email from that person to the target, their reply (agreed or declined), or three weeks of silence after
 * the ask went out. Asks never sent, and ones still waiting, have no outcome yet. Read-only.
 */
import { classifyReply, type IntroOutcome, type PathSnapshot } from '@orbit/core';
import { db } from '../db/schema';

const DAY = 86_400_000;
export const NO_RESPONSE_AFTER_DAYS = 21;

export interface IntroExample {
  suggestionId: string;
  connectorId: string;
  targetId: string;
  askedAt: string;
  snapshot: PathSnapshot;
  outcome: IntroOutcome;
}

const AGREED = new Set(['referral', 'interested', 'scheduling', 'thanks']);
const DECLINED = new Set(['decline', 'not_now', 'unsubscribe']);

export async function introOutcomes(userId: string, now: Date = new Date()): Promise<IntroExample[]> {
  const asks = await db.suggestions
    .where('userId')
    .equals(userId)
    .filter((s) => s.kind === 'intro_request' && !!(s.payload as { path?: unknown }).path)
    .toArray();
  const out: IntroExample[] = [];
  for (const s of asks) {
    const path = (s.payload as { path: PathSnapshot & { at?: string } }).path;
    const connectorId = s.personId;
    const targetId = path.hops.at(-1)?.toId;
    if (!connectorId || !targetId || !path.hops.length) continue;
    const draft = s.outboundMessageId ? await db.outbound.get(s.outboundMessageId) : undefined;
    const sentAt =
      draft && (draft.status === 'sent' || draft.status === 'handed_off')
        ? (draft.sentAt ?? draft.createdAt)
        : undefined;
    const askedAt = sentAt ?? path.at ?? s.createdAt;
    const base = {
      suggestionId: s.id,
      connectorId,
      targetId,
      askedAt,
      snapshot: { score: path.score, hops: path.hops },
    };
    // an introduction email from them to the target after the ask is the best outcome there is
    const made = await db.threads
      .where('userId')
      .equals(userId)
      .filter(
        (t) =>
          !!t.introduction &&
          t.introduction.introducerId === connectorId &&
          t.introduction.introducedIds.includes(targetId) &&
          t.introduction.at > askedAt,
      )
      .first();
    if (made) {
      out.push({ ...base, outcome: 'intro_made' });
      continue;
    }
    if (!sentAt) continue;
    const replies = (
      await db.messages
        .where('fromPersonId')
        .equals(connectorId)
        .filter(
          (m) => m.userId === userId && m.direction === 'inbound' && m.sentAt > sentAt && !m.isAutomated,
        )
        .toArray()
    ).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    const reply = replies[0];
    if (reply) {
      const cls = classifyReply(reply.bodyText ?? '', {
        now,
        direction: 'inbound',
        awaitingAnswer: true,
      }).class;
      if (AGREED.has(cls)) out.push({ ...base, outcome: 'agreed' });
      else if (DECLINED.has(cls)) out.push({ ...base, outcome: 'declined' });
      continue;
    }
    if (now.getTime() - Date.parse(sentAt) > NO_RESPONSE_AFTER_DAYS * DAY)
      out.push({ ...base, outcome: 'no_response' });
  }
  return out;
}
