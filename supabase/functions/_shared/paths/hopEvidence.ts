/**
 * How well a target's LinkedIn mutuals know the target (plan 21 §4, account mode §5.3): public LinkedIn activity read
 * through the student's own account, in the plan's order, matched by member id, turned into core's `PairEvidenceInput`
 * and from there into ties with `pairEvidenceTies`. No scoring here: core decides what the evidence is worth.
 *
 * Order (§4): the target's profile first (followers for the popularity discount, recommendations) → the target's
 * posts, reactions and comments → for the top five mutuals, their reactions and comments, matched against the
 * target's post ids locally (no per-post lookups) → the comment threads of the target's three latest commented posts,
 * which tell whose comment the target replied to (the target's own comments carry the thread id, the thread its
 * author). Mutuals past the top five are matched from pages already cached, never read.
 *
 * Every page is cached 30 days per person (ids, dates and counts only: never comment text, post text or a
 * recommendation's body), and every upstream read is taken from the day's allowance of the LinkedIn account before it
 * is made (hopJob.ts: this job's own `HOP_READS_PER_DAY` and the account's shared ledgers): when it runs out the
 * gathering stops where it is and works with what it has. A private profile (403/422) is remembered as "could not check" for the 30 days.
 */
import {
  type EngagementItem,
  type PairEvidenceInput,
  pairEvidenceTies,
  type Tie,
  type TieKind,
} from '@orbit/core/graph/ties';
import { cacheKey, type ProviderResult } from '../providers/request';
import {
  type ActivityComment,
  type ActivityPost,
  type ActivityReaction,
  HOP_PROFILE_SECTIONS,
  type ProfileRecommendation,
  postKeys,
  profileSignals,
  type ThreadComment,
  type UnipileResearch,
} from '../providers/unipileResearch';
import type { CacheDep, Clock } from '../research/deps';

export const HOP_CACHE_MS = 30 * 86_400_000;
/** LinkedIn reads plan 21 may make per Unipile account per day (of Unipile's ~100 non-messaging reads, §6) */
export const HOP_READS_PER_DAY = 40;
export const HOP_TOP_MUTUALS = 5;
export const HOP_THREAD_POSTS = 3;
/** the kinds the hop_evidence job writes (and replaces) */
export const HOP_EVIDENCE_KINDS: readonly TieKind[] = [
  'linkedin_engagement',
  'linkedin_mention',
  'linkedin_recommendation',
];
/** the usage_ledger operation one read is recorded under */
export const HOP_READ_OPERATION = 'hop_read';

/** Which of the shared per-account LinkedIn ledgers (plan 21 §6) a read comes out of. */
export type HopLedger = 'profile' | 'posts';

/** Today's LinkedIn reads on one account: `take` spends one before a read, false when the day's allowance is gone. */
export interface HopBudget {
  take(accountId: string, userId: string, ledger: HopLedger): Promise<boolean>;
}

export interface HopEvidenceDeps {
  unipile: UnipileResearch;
  cache: CacheDep;
  budget: HopBudget;
  clock: Clock;
  /** the jittered wait between two upstream reads (calls are spaced, never a burst; tests pass an instant one) */
  pace?: () => Promise<void>;
}

export interface HopRef {
  personId: string;
  memberId: string;
}

export interface HopEvidenceInput {
  userId: string;
  unipileAccountId: string;
  target: HopRef;
  /** the target's mutuals with member ids, best first (the first five are read; the rest only from the cache) */
  mutuals: HopRef[];
  /** LinkedIn follower counts Orbit already holds, by person id */
  followers?: Record<string, number>;
}

/** One pair (target, mutual) and the kinds whose evidence was checked from every side it needs. */
export interface CheckedPair {
  aId: string;
  bId: string;
  kinds: TieKind[];
}

export interface HopEvidenceResult {
  evidence: PairEvidenceInput;
  ties: Tie[];
  checked: CheckedPair[];
  /** what the target's profile said (when read) */
  target: { followers?: number; connections?: number };
  /** upstream reads made (each counted against the budget) */
  reads: number;
  /** pages answered from the 30-day cache */
  cached: number;
  stoppedBy?: 'budget';
  errors: string[];
  /** every step ran: nothing left to read for this target for 30 days */
  complete: boolean;
  /** the pages in the order they were wanted, e.g. "posts:<memberId>" (cache hits included) */
  steps: string[];
}

interface ProfileRecord {
  followers?: number;
  connections?: number;
  received: ProfileRecommendation[];
  given: ProfileRecommendation[];
  throttled: boolean;
  /** 403/422: LinkedIn would not show it */
  failed?: true;
}
interface PageRecord<T> {
  items: T[];
  failed?: true;
}

type Op = 'profile' | 'posts' | 'reactions' | 'comments' | 'thread';

/** The trailing number of an urn-like id, else the id: comment ids meet whichever form each endpoint uses. */
function normId(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const keys = postKeys(v);
  return keys[keys.length - 1];
}

const byDateDesc = (a: { at?: string }, b: { at?: string }) => (b.at ?? '').localeCompare(a.at ?? '');

/** Gather a target's hop evidence (§4) and the ties it gives. Never throws on a provider error. */
export async function gatherHopEvidence(
  deps: HopEvidenceDeps,
  input: HopEvidenceInput,
): Promise<HopEvidenceResult> {
  const now = new Date(deps.clock());
  const acct = input.unipileAccountId;
  const T = input.target;
  const mutuals = dedupeRefs(input.mutuals.filter((m) => m.personId !== T.personId));
  const out: HopEvidenceResult = {
    evidence: { userId: input.userId, people: new Set(), now },
    ties: [],
    checked: [],
    target: {},
    reads: 0,
    cached: 0,
    errors: [],
    complete: false,
    steps: [],
  };

  /** A page from the cache, or read when `network` and the budget allows; undefined when neither. */
  async function page<R>(
    op: Op,
    id: string,
    network: boolean,
    fetcher: () => Promise<ProviderResult<R>>,
  ): Promise<R | undefined> {
    out.steps.push(`${op}:${id}`);
    const key = await cacheKey('unipile', { op: `hop_${op}`, accountId: acct, id });
    const hit = (await deps.cache.get(input.userId, key)) as R | undefined;
    if (hit !== undefined) {
      out.cached++;
      return hit;
    }
    if (!network || out.stoppedBy) return undefined;
    if (!(await deps.budget.take(acct, input.userId, op === 'profile' ? 'profile' : 'posts'))) {
      out.stoppedBy = 'budget';
      return undefined;
    }
    if (out.reads > 0) await deps.pace?.();
    const r = await fetcher();
    out.reads++;
    if (!r.ok && r.kind === 'unconfigured') {
      out.errors.push(`${op}: ${r.message}`);
      return undefined;
    }
    let value: R;
    if (r.ok) value = r.value;
    else if (r.kind === 'http' && (r.status === 403 || r.status === 422)) {
      // private or locked: "could not check", and not asked again for 30 days (§10)
      value = { items: [], received: [], given: [], throttled: true, failed: true } as unknown as R;
    } else {
      out.errors.push(`${op}: ${r.message}`);
      return undefined;
    }
    await deps.cache.put(input.userId, {
      key,
      provider: 'unipile',
      response: value,
      expiresAt: new Date(deps.clock() + HOP_CACHE_MS),
    });
    return value;
  }

  const profile = await page<ProfileRecord>('profile', T.memberId, true, async () => {
    const r = await deps.unipile.profile(acct, T.memberId, { sections: HOP_PROFILE_SECTIONS });
    if (!r.ok) return r;
    const s = profileSignals(r.value);
    return {
      ok: true,
      value: {
        ...(s.followers !== undefined ? { followers: s.followers } : {}),
        ...(s.connections !== undefined ? { connections: s.connections } : {}),
        received: s.received,
        given: s.given,
        throttled: s.recommendationsThrottled,
      },
    };
  });
  const pages = <X>(
    op: Op,
    memberId: string,
    network: boolean,
    read: () => Promise<ProviderResult<{ items: X[] }>>,
  ) =>
    page<PageRecord<X>>(op, memberId, network, async () => {
      const r = await read();
      return r.ok ? { ok: true, value: { items: r.value.items } } : r;
    });
  const tPosts = await pages<ActivityPost>('posts', T.memberId, true, () =>
    deps.unipile.postsOf(acct, T.memberId),
  );
  const tReactions = await pages<ActivityReaction>('reactions', T.memberId, true, () =>
    deps.unipile.reactionsOf(acct, T.memberId),
  );
  const tComments = await pages<ActivityComment>('comments', T.memberId, true, () =>
    deps.unipile.commentsOf(acct, T.memberId),
  );

  const mPages = new Map<
    string,
    { reactions?: PageRecord<ActivityReaction>; comments?: PageRecord<ActivityComment> }
  >();
  for (const [i, m] of mutuals.entries()) {
    const network = i < HOP_TOP_MUTUALS;
    const reactions = await pages<ActivityReaction>('reactions', m.memberId, network, () =>
      deps.unipile.reactionsOf(acct, m.memberId),
    );
    const comments = await pages<ActivityComment>('comments', m.memberId, network, () =>
      deps.unipile.commentsOf(acct, m.memberId),
    );
    mPages.set(m.personId, { reactions, comments });
  }

  // the target's own posts, as an index of every id a post is known by
  const posts = tPosts?.items ?? [];
  const postBy = new Map<string, ActivityPost>();
  for (const p of posts) for (const k of p.keys) postBy.set(k, p);
  const postOf = (keys: string[]) => keys.map((k) => postBy.get(k)).find((p) => !!p);

  // the target's replies on their own posts, and the threads that say whose comment each answered
  const ownReplies = (tComments?.items ?? []).filter((c) => c.threadId && postOf(c.postKeys));
  const repliedPosts = new Set(ownReplies.map((c) => postOf(c.postKeys)!.id));
  const threadPosts = posts
    .filter((p) => !p.repostOf && p.comments !== 0)
    .sort((a, b) => Number(repliedPosts.has(b.id)) - Number(repliedPosts.has(a.id)) || byDateDesc(a, b))
    .slice(0, HOP_THREAD_POSTS);
  const threads = new Map<string, PageRecord<ThreadComment>>();
  for (const p of threadPosts) {
    const th = await pages<ThreadComment>('thread', p.id, true, () => deps.unipile.postComments(acct, p.id));
    if (th) threads.set(p.id, th);
  }

  // ---- matching, by member id only -------------------------------------------------------------------------------
  const personOf = new Map<string, string>([[T.memberId, T.personId]]);
  for (const m of mutuals) if (!personOf.has(m.memberId)) personOf.set(m.memberId, m.personId);
  const isMutual = (memberId: string | undefined) =>
    !!memberId && memberId !== T.memberId && personOf.has(memberId);
  const engagement: EngagementItem[] = [];
  const reactionVolume = new Map<string, number>();
  if (tReactions && !tReactions.failed) reactionVolume.set(T.personId, tReactions.items.length);

  for (const m of mutuals) {
    const pg = mPages.get(m.personId)!;
    if (pg.reactions && !pg.reactions.failed) reactionVolume.set(m.personId, pg.reactions.items.length);
    // the mutual's reactions to the target's posts (dated by the post when Orbit read it)
    for (const r of pg.reactions?.items ?? []) {
      if (r.onComment || r.authorId !== T.memberId) continue;
      const post = postOf(r.postKeys);
      engagement.push({
        actorId: m.personId,
        otherId: T.personId,
        kind: 'reaction',
        postAuthorId: T.personId,
        postId: post?.id ?? r.postKeys[0]!,
        ...(post?.at ? { at: post.at } : {}),
      });
    }
    // the mutual's comments on the target's posts
    for (const c of pg.comments?.items ?? []) {
      const post = postOf(c.postKeys);
      if (!post) continue;
      engagement.push({
        actorId: m.personId,
        otherId: T.personId,
        kind: 'comment',
        postAuthorId: T.personId,
        postId: post.id,
        commentId: normId(c.id) ?? `${post.id}:${c.at ?? ''}`,
        ...(c.at ? { at: c.at } : {}),
      });
    }
  }
  // the target's reactions to a mutual's posts (no date: LinkedIn gives none, and the mutual's posts are not read)
  for (const r of tReactions?.items ?? []) {
    if (r.onComment || !isMutual(r.authorId)) continue;
    const other = personOf.get(r.authorId!)!;
    engagement.push({
      actorId: T.personId,
      otherId: other,
      kind: 'reaction',
      postAuthorId: other,
      postId: r.postKeys[0]!,
    });
  }
  // top-level comments on the target's posts by any mutual, and the target's replies to them
  const threadAuthor = new Map<string, string>();
  for (const [postId, th] of threads) {
    const post = postBy.get(postId);
    for (const c of th.items) {
      const id = normId(c.id);
      if (id && c.authorId) threadAuthor.set(id, c.authorId);
      if (!isMutual(c.authorId)) continue;
      engagement.push({
        actorId: personOf.get(c.authorId!)!,
        otherId: T.personId,
        kind: 'comment',
        postAuthorId: T.personId,
        postId,
        commentId: id ?? c.id,
        ...((c.at ?? post?.at) ? { at: c.at ?? post?.at } : {}),
      });
    }
  }
  for (const c of ownReplies) {
    const author = threadAuthor.get(normId(c.threadId) ?? '');
    if (!isMutual(author)) continue;
    const post = postOf(c.postKeys)!;
    engagement.push({
      actorId: T.personId,
      otherId: personOf.get(author!)!,
      kind: 'reply',
      postAuthorId: T.personId,
      postId: post.id,
      commentId: normId(c.id) ?? `${post.id}:${c.threadId}`,
      ...(c.at ? { at: c.at } : {}),
    });
  }
  // the target reposting a mutual, and naming one in a post
  const mentions: NonNullable<PairEvidenceInput['mentions']> = [];
  for (const p of posts) {
    if (isMutual(p.repostOf)) {
      const other = personOf.get(p.repostOf!)!;
      engagement.push({
        actorId: T.personId,
        otherId: other,
        kind: 'repost',
        postAuthorId: other,
        postId: p.id,
        ...(p.at ? { at: p.at } : {}),
      });
    }
    if (p.repostOf) continue;
    for (const mm of p.mentions) {
      if (!isMutual(mm)) continue;
      mentions.push({
        authorId: T.personId,
        mentionedId: personOf.get(mm)!,
        postId: p.id,
        ...(p.at ? { at: p.at } : {}),
        tagged: p.mentions.length,
      });
    }
  }
  // recommendations on the target's profile
  const recommendations: NonNullable<PairEvidenceInput['recommendations']> = [];
  if (profile && !profile.failed) {
    for (const r of profile.received)
      if (isMutual(r.actorId))
        recommendations.push({
          authorId: personOf.get(r.actorId)!,
          subjectId: T.personId,
          year: r.year,
          caption: r.caption,
        });
    for (const r of profile.given)
      if (isMutual(r.actorId))
        recommendations.push({
          authorId: T.personId,
          subjectId: personOf.get(r.actorId)!,
          year: r.year,
          caption: r.caption,
        });
  }

  const followers = new Map<string, number>();
  for (const [id, n] of Object.entries(input.followers ?? {}))
    if (typeof n === 'number' && Number.isFinite(n)) followers.set(id, n);
  if (profile?.followers !== undefined) {
    followers.set(T.personId, profile.followers);
    out.target.followers = profile.followers;
  }
  if (profile?.connections !== undefined) out.target.connections = profile.connections;

  out.evidence = {
    userId: input.userId,
    people: new Set([T.personId, ...mutuals.map((m) => m.personId)]),
    engagement,
    followers,
    reactionVolume,
    recommendations,
    mentions,
    now,
  };
  out.ties = pairEvidenceTies(out.evidence);

  // which kinds each pair was checked for from every side it needs (only those rows may be replaced)
  const seen = (p: { failed?: true } | undefined) => !!p && !p.failed;
  const tSide = seen(tPosts) && seen(tReactions) && seen(tComments);
  const recChecked = seen(profile) && !profile!.throttled;
  for (const m of mutuals) {
    const pg = mPages.get(m.personId)!;
    const kinds: TieKind[] = [];
    if (tSide && seen(pg.reactions) && seen(pg.comments)) kinds.push('linkedin_engagement');
    if (seen(tPosts)) kinds.push('linkedin_mention');
    if (recChecked) kinds.push('linkedin_recommendation');
    if (!kinds.length) continue;
    const [aId, bId] = m.personId < T.personId ? [m.personId, T.personId] : [T.personId, m.personId];
    out.checked.push({ aId, bId, kinds });
  }
  out.complete =
    !out.stoppedBy &&
    !!profile &&
    !!tPosts &&
    !!tReactions &&
    !!tComments &&
    mutuals.slice(0, HOP_TOP_MUTUALS).every((m) => {
      const pg = mPages.get(m.personId)!;
      return !!pg.reactions && !!pg.comments;
    }) &&
    threadPosts.every((p) => threads.has(p.id));
  return out;
}

function dedupeRefs(refs: HopRef[]): HopRef[] {
  const seen = new Set<string>();
  const out: HopRef[] = [];
  for (const r of refs) {
    if (!r.personId || !r.memberId || seen.has(r.personId)) continue;
    seen.add(r.personId);
    out.push(r);
  }
  return out;
}
