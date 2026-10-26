/**
 * How well each person on a route knows the next (plan 21 §4): LinkedIn activity between the target and the people
 * who could introduce the student, read only when the student opens a target, and turned into evidence core weighs.
 *
 * Reads, in order, for a target T with mutuals M1…Mn ranked best-first (each part cached 30 days per person, so a
 * mutual read for one target serves every other target they know):
 *  1. T's profile (followers, recommendations) — popularity must be known before any engagement counts;
 *  2. T's recent posts, the posts T reacted to (with their authors) and T's comments;
 *  3. for the top five mutuals, the posts they reacted to and their comments, plus their profile;
 *  4. the comments under T's three latest posts (who commented, and which comments T answered).
 * One proxy call at a time; the proxy spaces LinkedIn calls at random and keeps the daily ledger, and a refusal
 * stops the round (what was read stays, and the rest says "not checked"). Nothing runs on a timer.
 *
 * Matching is by LinkedIn member id only; anyone Orbit does not have is ignored. No one's words are kept.
 */
import type { EngagementItem, PairEvidenceInput, Person, User } from '@orbit/core';
import { db, type EngagementPost, type EngagementRow } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { linkedInProfile } from '../integrations/enrichmentProxy';
import { type EngagementWant, linkedInEngagement, unipileConfigured } from '../integrations/unipile';
import { countActivity, endActivity, startActivity } from './activity';
import { liveLinkedInAccount } from './linkedinLive';

const DAY = 86_400_000;
/** A part of someone's activity is read again after this long. */
export const ENGAGEMENT_FRESH_MS = 30 * DAY;
/** Mutuals whose own activity is read for one target (the rest are matched from the target's side only). */
export const MUTUALS_READ = 5;
/** The target's latest posts whose comment threads are read. */
export const THREADS_READ = 3;

/** One page of someone's activity, as the proxy maps it (no text). */
export type EngagementPage =
  | { want: 'posts'; items: EngagementPost[] }
  | { want: 'reactions'; items: { postId: string; authorId: string }[] }
  | { want: 'comments'; items: { id: string; postId: string; at?: string; threadId?: string }[] }
  | { want: 'thread'; items: { id: string; commenterId: string; at?: string }[] };

export interface ProfileFacts {
  followers?: number;
  recommendations?: NonNullable<Person['linkedinRecommendations']>;
}

/** A read's outcome: LinkedIn's daily allowance ran out (`limit`), the person's activity is hidden, or it failed. */
export type ReadOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'limit' | 'unavailable' | 'error'; message: string };

/** How hop evidence reaches LinkedIn: the live proxy, or a test's stand-in. */
export interface HopReader {
  page(memberId: string, want: EngagementWant, postId?: string): Promise<ReadOutcome<EngagementPage>>;
  profile(memberId: string): Promise<ReadOutcome<ProfileFacts>>;
}

const failed = (reason: string | undefined, message: string): ReadOutcome<never> => ({
  ok: false,
  reason: reason === 'limit' || reason === 'unavailable' ? reason : 'error',
  message,
});

/** The live reader for a connected LinkedIn account in this browser; undefined when there is none. */
export async function liveHopReader(user: Pick<User, 'id'>): Promise<HopReader | undefined> {
  if (usesMockConnectors(user.id) || !unipileConfigured()) return undefined;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId || !row.accessToken) return undefined;
  const accountId = row.externalAccountId;
  const token = row.accessToken;
  return {
    async page(memberId, want, postId) {
      const r = await linkedInEngagement(accountId, { memberId, want, postId }, { token });
      if (!r.ok) return failed(r.reason, r.message);
      return { ok: true, value: { want, items: r.value.items } as EngagementPage };
    },
    async profile(memberId) {
      const r = await linkedInProfile(accountId, memberId, [], {
        token,
        recommendations: true,
        purpose: 'route',
        // followers and recommendations are what anyone sees: a copy another student read today will do
        shared: true,
      });
      if (!r.ok) return failed(r.reason, r.message);
      return {
        ok: true,
        value: {
          followers: r.value.followerCount,
          recommendations: (r.value.recommendations ?? []).map((x) => ({
            direction: x.direction,
            actorMemberId: x.actorId,
            ...(x.actorName ? { actorName: x.actorName } : {}),
            ...(x.year ? { year: x.year } : {}),
            ...(x.caption ? { caption: x.caption } : {}),
          })),
        },
      };
    },
  };
}

// --- status, for "Checking…" on the hops still being read -----------------------------------------------------------

export type CheckState = 'queued' | 'reading' | 'done' | 'not_checked';
const states = new Map<string, CheckState>();
const listeners = new Set<() => void>();
let version = 0;

/** Hear when a read finishes or a person's state changes (the routes are recomputed, hop words update). */
export function subscribeHopEvidence(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A number that changes whenever new evidence lands, for useSyncExternalStore. */
export function hopEvidenceVersion(): number {
  return version;
}

/** Where reading a person's activity stands (by member id): undefined when Orbit has not been asked to. */
export function checkState(memberId: string | undefined): CheckState | undefined {
  return memberId ? states.get(memberId) : undefined;
}

const emit = () => {
  version++;
  for (const fn of listeners) fn();
};
const setState = (memberIds: string[], s: CheckState) => {
  for (const m of memberIds) states.set(m, s);
  emit();
};

/** tests only */
export function resetHopEvidenceForTests(): void {
  states.clear();
  inflight.clear();
  version = 0;
}

// --- reading ---------------------------------------------------------------------------------------------------------

const fresh = (at: string | undefined, now: Date) =>
  !!at && now.getTime() - Date.parse(at) < ENGAGEMENT_FRESH_MS;
const rowId = (userId: string, memberId: string) => `${userId}:${memberId}`;

async function row(userId: string, memberId: string): Promise<EngagementRow> {
  return (
    (await db.engagement.get(rowId(userId, memberId))) ?? { id: rowId(userId, memberId), userId, memberId }
  );
}

export interface CheckResult {
  /** proxy calls made in this round */
  calls: number;
  /** LinkedIn's daily allowance ran out before the round finished */
  limited: boolean;
  /** people whose activity could not be read */
  failed: string[];
}

const inflight = new Map<string, Promise<CheckResult>>();

/**
 * Read what weighs the hops into one target, best-first, skipping what is fresh. Shared while running, so the Map's
 * routes and its "People who know them" make one round. Never throws.
 */
export function checkHops(
  user: Pick<User, 'id'>,
  target: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>,
  mutuals: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>[],
  opts: { reader?: HopReader; now?: Date } = {},
): Promise<CheckResult> {
  const key = `${user.id}:${target.id}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = runCheck(user, target, mutuals, opts)
    .catch((): CheckResult => ({ calls: 0, limited: false, failed: [] }))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function runCheck(
  user: Pick<User, 'id'>,
  target: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>,
  mutuals: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>[],
  opts: { reader?: HopReader; now?: Date },
): Promise<CheckResult> {
  const out: CheckResult = { calls: 0, limited: false, failed: [] };
  const tm = target.linkedinMemberId;
  if (!tm) return out;
  const reader = opts.reader ?? (await liveHopReader(user));
  if (!reader) return out;
  const now = opts.now ?? new Date();
  // the people as stored now: a profile read in an earlier round is not read again
  const current = async <P extends Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>>(p: P) =>
    ({ ...p, ...((await db.people.get(p.id)) ?? {}) }) as P;
  target = await current(target);
  mutuals = await Promise.all(mutuals.map(current));
  const top = mutuals.filter((m) => !!m.linkedinMemberId && m.id !== target.id).slice(0, MUTUALS_READ);
  const everyone = [tm, ...top.map((m) => m.linkedinMemberId!)];
  setState(everyone, 'queued');
  // the status line: whose LinkedIn activity is being read, for a route
  const first = async (id: string) => {
    const p = await db.people.get(id);
    return p?.firstName || p?.displayName;
  };
  const named = top.length === 1 ? await first(top[0]!.id) : undefined;
  const activityId = `hops:${target.id}`;
  startActivity(
    activityId,
    named ? `Reading ${named}'s posts for the route` : 'Reading LinkedIn posts for the routes',
  );
  try {
    return await readRound(user, target, top, everyone, reader, now, out);
  } finally {
    endActivity(activityId);
    void countActivity(user.id, 'posts', out.calls, now).catch(() => undefined);
  }
}

async function readRound(
  user: Pick<User, 'id'>,
  target: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>,
  top: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>[],
  everyone: string[],
  reader: HopReader,
  now: Date,
  out: CheckResult,
): Promise<CheckResult> {
  const tm = target.linkedinMemberId!;

  /** one proxy call; false stops the round (the ledger ran out) */
  const step = async <T>(
    memberId: string,
    run: () => Promise<ReadOutcome<T>>,
    save: (v: T) => Promise<void>,
  ) => {
    if (out.limited) return false;
    states.set(memberId, 'reading');
    emit();
    out.calls++;
    const r = await run();
    if (!r.ok) {
      if (r.reason === 'limit') {
        out.limited = true;
        return false;
      }
      if (r.reason === 'unavailable') {
        const cur = await row(user.id, memberId);
        await db.engagement.put({ ...cur, unavailableAt: now.toISOString() });
      }
      if (!out.failed.includes(memberId)) out.failed.push(memberId);
      return true;
    }
    await save(r.value);
    emit();
    return true;
  };
  const savePart = async (memberId: string, patch: Partial<EngagementRow>) => {
    const cur = await row(user.id, memberId);
    await db.engagement.put({ ...cur, ...patch });
  };
  const needs = async (
    memberId: string,
    part: 'profileAt' | 'postsAt' | 'reactionsAt' | 'commentsAt' | 'threadsAt',
  ) => {
    const cur = await db.engagement.get(rowId(user.id, memberId));
    if (cur?.unavailableAt && fresh(cur.unavailableAt, now)) return false;
    return !fresh(cur?.[part], now);
  };
  const profileStep = async (person: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers'>) => {
    const m = person.linkedinMemberId!;
    if (person.linkedinFollowers !== undefined || !(await needs(m, 'profileAt'))) return true;
    return step(
      m,
      () => reader.profile(m),
      async (v: ProfileFacts) => {
        await db.people.update(person.id, {
          ...(v.followers !== undefined ? { linkedinFollowers: v.followers } : {}),
          ...(v.recommendations ? { linkedinRecommendations: v.recommendations } : {}),
        });
        await savePart(m, { profileAt: now.toISOString() });
      },
    );
  };
  const pageStep = async (memberId: string, want: 'posts' | 'reactions' | 'comments') => {
    const part = `${want}At` as const;
    if (!(await needs(memberId, part))) return true;
    return step(
      memberId,
      () => reader.page(memberId, want),
      (v: EngagementPage) => savePart(memberId, { [want]: v.items, [part]: now.toISOString() }),
    );
  };

  try {
    // 1–2: the target, profile first
    if (!(await profileStep(target))) return out;
    for (const want of ['posts', 'reactions', 'comments'] as const)
      if (!(await pageStep(tm, want))) return out;
    setState([tm], 'done');
    // 3: the best mutuals' side
    for (const m of top) {
      const mm = m.linkedinMemberId!;
      for (const want of ['reactions', 'comments'] as const) if (!(await pageStep(mm, want))) return out;
      if (!(await profileStep(m))) return out;
      setState([mm], 'done');
    }
    // 4: who commented under the target's latest posts
    if (await needs(tm, 'threadsAt')) {
      const posts = (await db.engagement.get(rowId(user.id, tm)))?.posts ?? [];
      const threads: Record<string, { id: string; commenterId: string; at?: string }[]> = {};
      for (const post of posts.slice(0, THREADS_READ)) {
        const ok = await step(
          tm,
          () => reader.page(tm, 'thread', post.id),
          async (v: EngagementPage) => {
            threads[post.id] = v.items as { id: string; commenterId: string; at?: string }[];
          },
        );
        if (!ok) break;
      }
      if (Object.keys(threads).length || !posts.length)
        await savePart(tm, { threads, threadsAt: now.toISOString() });
    }
    return out;
  } finally {
    for (const m of everyone)
      if (states.get(m) !== 'done')
        states.set(m, out.limited || out.failed.includes(m) ? 'not_checked' : 'done');
    emit();
  }
}

/** Drop everything read about other people's LinkedIn activity (on disconnecting LinkedIn, plan 21 §7). */
export async function forgetEngagement(userId: string): Promise<void> {
  await db.engagement.where('userId').equals(userId).delete();
  states.clear();
  emit();
}

// --- evidence ---------------------------------------------------------------------------------------------------------

/**
 * The stored activity as plan 21's pair evidence between the student's people (core `pairEvidenceTies`): reactions
 * and comments matched to the post's author, the target's answers to comments under their posts, reposts, mentions,
 * recommendations from profiles, followers for the popularity discount. Rows older than 30 days are ignored.
 */
export function evidenceFrom(
  rows: EngagementRow[],
  people: Pick<Person, 'id' | 'linkedinMemberId' | 'linkedinFollowers' | 'linkedinRecommendations'>[],
  now: Date = new Date(),
): Omit<PairEvidenceInput, 'userId' | 'people' | 'now' | 'studentSays'> {
  const byMember = new Map<string, string>();
  for (const p of people) if (p.linkedinMemberId) byMember.set(p.linkedinMemberId, p.id);
  const live = rows.filter((r) =>
    [r.postsAt, r.reactionsAt, r.commentsAt, r.threadsAt].some((at) => fresh(at, now)),
  );
  // every post Orbit has seen, with its author and date
  const posts = new Map<string, { author: string; at?: string }>();
  for (const r of live) for (const p of r.posts ?? []) posts.set(p.id, { author: r.memberId, at: p.at });
  const threadComments = new Map<string, { commenter: string; postAuthor: string }>();
  for (const r of live)
    for (const items of Object.values(r.threads ?? {}))
      for (const c of items) threadComments.set(c.id, { commenter: c.commenterId, postAuthor: r.memberId });

  const engagement: EngagementItem[] = [];
  const mentions: NonNullable<PairEvidenceInput['mentions']> = [];
  const reactionVolume = new Map<string, number>();
  const add = (
    actorM: string,
    otherM: string,
    item: Omit<EngagementItem, 'actorId' | 'otherId' | 'postAuthorId'>,
    postAuthorM: string,
  ) => {
    const actorId = byMember.get(actorM);
    const otherId = byMember.get(otherM);
    const postAuthorId = byMember.get(postAuthorM);
    if (!actorId || !otherId || !postAuthorId || actorId === otherId) return;
    engagement.push({ ...item, actorId, otherId, postAuthorId });
  };
  for (const r of live) {
    const actor = r.memberId;
    if (r.reactions) {
      const pid = byMember.get(actor);
      if (pid) reactionVolume.set(pid, r.reactions.length);
      for (const x of r.reactions)
        add(
          actor,
          x.authorId,
          { kind: 'reaction', postId: x.postId, at: posts.get(x.postId)?.at },
          x.authorId,
        );
    }
    for (const c of r.comments ?? []) {
      const post = posts.get(c.postId);
      if (!post) continue;
      if (post.author !== actor) {
        add(
          actor,
          post.author,
          { kind: 'comment', postId: c.postId, commentId: c.id, at: c.at },
          post.author,
        );
        continue;
      }
      // a comment on their own post under someone else's: an answer to that person
      const parent = c.threadId ? threadComments.get(c.threadId) : undefined;
      if (parent && parent.commenter !== actor)
        add(actor, parent.commenter, { kind: 'reply', postId: c.postId, commentId: c.id, at: c.at }, actor);
    }
    for (const p of r.posts ?? []) {
      if (p.repostOf) add(actor, p.repostOf, { kind: 'repost', postId: p.id, at: p.at }, p.repostOf);
      const authorId = byMember.get(actor);
      for (const m of p.mentions) {
        const mentionedId = byMember.get(m);
        if (authorId && mentionedId && mentionedId !== authorId)
          mentions.push({
            authorId,
            mentionedId,
            postId: p.id,
            at: p.at,
            tagged: Math.max(p.tagged, p.mentions.length),
          });
      }
    }
    for (const [postId, items] of Object.entries(r.threads ?? {}))
      for (const c of items)
        add(c.commenterId, actor, { kind: 'comment', postId, commentId: c.id, at: c.at }, actor);
  }

  const followers = new Map<string, number>();
  const recommendations: NonNullable<PairEvidenceInput['recommendations']> = [];
  for (const p of people) {
    if (p.linkedinFollowers !== undefined) followers.set(p.id, p.linkedinFollowers);
    for (const rec of p.linkedinRecommendations ?? []) {
      const other = byMember.get(rec.actorMemberId);
      if (!other || other === p.id) continue;
      const [authorId, subjectId] = rec.direction === 'given' ? [p.id, other] : [other, p.id];
      recommendations.push({ authorId, subjectId, year: rec.year, caption: rec.caption });
    }
  }
  return { engagement, mentions, recommendations, followers, reactionVolume };
}

/** Everything stored for this student, as pair evidence (engine/graph.ts merges it into the routes' pairs). */
export async function storedEvidence(
  userId: string,
  people: Person[],
  now: Date = new Date(),
): Promise<ReturnType<typeof evidenceFrom>> {
  const rows = await db.engagement.where('userId').equals(userId).toArray();
  return evidenceFrom(rows, people, now);
}
