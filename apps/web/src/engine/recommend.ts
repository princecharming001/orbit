import type { ChatStage, DismissSignal, OutreachExample, Person, Recommendation } from '@orbit/core';
import { feedback } from '../db/repo';
import { db } from '../db/schema';

/** Why a recommendation was not a fit, as Discover offers them. */
export const RECOMMENDATION_DISMISS_REASONS = {
  wrong_role: 'Wrong role',
  wrong_company: 'Wrong company',
  know_them: 'Already know them',
  not_now: 'Not now',
} as const;
export type RecommendationDismissReason = keyof typeof RECOMMENDATION_DISMISS_REASONS;

/** Saved people stay at the top of Discover until the student writes to them. */
export async function saveRecommendation(id: string): Promise<boolean> {
  const r = await db.recommendations.get(id);
  if (!r) return false;
  await db.recommendations.update(id, { status: 'saved' });
  return true;
}

/** Unsave: back among the others, ranked by its score. */
export async function unsaveRecommendation(id: string): Promise<boolean> {
  const r = await db.recommendations.get(id);
  if (r?.status !== 'saved') return false;
  await db.recommendations.update(id, { status: 'new' });
  return true;
}

/** Not a fit: Orbit learns from the reason for the next list. Undo puts it back as new. */
export async function dismissRecommendation(
  userId: string,
  id: string,
  reason: RecommendationDismissReason,
): Promise<boolean> {
  const r = await db.recommendations.get(id);
  if (!r || r.userId !== userId) return false;
  await db.recommendations.update(id, { status: 'dismissed', dismissedReason: reason });
  await feedback(userId, 'recommendation_dismiss', { reason, refTable: 'recommendations', refId: id });
  return true;
}

export async function restoreRecommendation(id: string): Promise<boolean> {
  const r = await db.recommendations.get(id);
  if (!r) return false;
  await db.recommendations.update(id, { status: 'new', dismissedReason: undefined });
  return true;
}

/**
 * A cold recommendation: someone known only from LinkedIn, never talked to, and not pointed to by anyone or in the
 * student's own club. Discover suggests a warm-up (or an intro, when someone on the best route knows them).
 */
export function isColdRecommendation(
  person: Pick<Person, 'strength' | 'primaryEmail'>,
  rec: Pick<Recommendation, 'reasons'>,
): boolean {
  return (
    person.strength < 0.2 &&
    !person.primaryEmail &&
    !rec.reasons.some((x) => x.code === 'referred' || x.code === 'shared_org_now')
  );
}

/** The channel a first message to this person goes on: email when there is an address, LinkedIn otherwise. */
export function outreachChannelFor(person: Pick<Person, 'primaryEmail'>): 'gmail' | 'linkedin' {
  return person.primaryEmail ? 'gmail' : 'linkedin';
}

/** Who on the best route could introduce the student: the first hop of a route with at least two hops. */
export function introducerIdFor(rec: Pick<Recommendation, 'bestPath'>): string | undefined {
  return rec.bestPath && rec.bestPath.hops.length >= 2 ? rec.bestPath.hops[0]!.toId : undefined;
}

/** Stages a chat reaches once the student's first message went out. */
const SENT_STAGES = new Set<ChatStage>([
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
  'declined',
  'no_response',
]);
/** Stages that mean the person wrote back and the conversation went on. */
const REPLIED_STAGES = new Set<ChatStage>([
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
]);

/**
 * What Discover learns from: the people the student wrote to (their titles and companies; those who replied count
 * double when ranked) and the cards they turned down with a reason (a wrong company or role). Read by the network
 * recommendations and by the feed of new people alike.
 */
export async function loadDiscoverSignals(
  userId: string,
  extraDismissed: DismissSignal[] = [],
): Promise<{ outreach: OutreachExample[]; dismissed: DismissSignal[] }> {
  const [chats, recs] = await Promise.all([
    db.chats.where('userId').equals(userId).toArray(),
    db.recommendations
      .where('userId')
      .equals(userId)
      .filter((r) => r.status === 'dismissed' && !!r.dismissedReason)
      .toArray(),
  ]);
  const sent = chats.filter((c) => SENT_STAGES.has(c.stage));
  const ids = [...new Set([...sent.map((c) => c.personId), ...recs.map((r) => r.personId)])];
  const people = new Map(
    (await db.people.bulkGet(ids)).filter((p): p is Person => !!p).map((p) => [p.id, p]),
  );
  const outreach: OutreachExample[] = [];
  const seen = new Set<string>();
  for (const c of sent) {
    const p = people.get(c.personId);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    outreach.push({
      name: p.firstName || undefined,
      title: p.currentTitle,
      company: p.currentOrganizationRaw,
      replied:
        REPLIED_STAGES.has(c.stage) || chats.some((x) => x.personId === p.id && REPLIED_STAGES.has(x.stage)),
    });
  }
  const dismissed: DismissSignal[] = [
    ...recs.map((r) => {
      const p = people.get(r.personId);
      return { reason: r.dismissedReason!, title: p?.currentTitle, company: p?.currentOrganizationRaw };
    }),
    ...extraDismissed,
  ];
  return { outreach, dismissed };
}
