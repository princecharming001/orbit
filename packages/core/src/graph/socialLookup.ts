/**
 * Who on Instagram or X could introduce the student to a target (plan 43 §3.6), and the cheapest next read when Orbit
 * does not know yet. Pure: the server job runs it between reads, the demo runs it on made-up lists.
 *
 * A bridge is an account in the student's circle that the target follows and that follows the target. Only following
 * each other carries a path; a one-way follow is kept as support. A missing follow means "no" only when the list that
 * would show it was read to the end.
 */
import type { SocialPlatform } from '../entity/social';

/** No list longer than this is read in one lookup; past it Orbit checks from the candidates' side. */
export const MAX_LIST_READ = 2000;
/** A list counts as complete when the read reached the end and holds at least this share of the profile's count. */
export const COMPLETE_SHARE = 0.9;

export interface ListRead {
  /** the account ids on the list, as far as it was read */
  ids: ReadonlySet<string>;
  /** the read reached the end of the list */
  ended: boolean;
  /** the count the profile shows, when known */
  total?: number;
}

/** Whether a read list can say "not on it" (plan 43 §3.5). */
export function listComplete(l: ListRead | undefined): boolean {
  if (!l?.ended) return false;
  if (typeof l.total !== 'number' || l.total <= 0) return true;
  return l.ids.size >= COMPLETE_SHARE * l.total;
}

export interface AccountLists {
  followers?: ListRead;
  following?: ListRead;
  /** counts from the profile */
  followerCount?: number;
  followingCount?: number;
  isPrivate?: boolean;
}

export interface CircleAccount {
  accountId: string;
  personId: string;
  /** the student follows this account (the Instagram count only sees these) */
  studentFollows: boolean;
}

export interface LookupState {
  platform: SocialPlatform;
  targetAccountId: string;
  /** the student's circle on this platform (plan 43 §3.3): accounts they follow each other with, and accounts of people they know */
  circle: readonly CircleAccount[];
  target: AccountLists;
  /** what Orbit holds of each circle account's own lists */
  candidates: ReadonlyMap<string, AccountLists>;
  /**
   * Instagram's count on the target's profile, read fresh this lookup: how many accounts the student follows that
   * also follow the target. Undefined until read; X has no such count.
   */
  count?: number;
  /** the profile was read this lookup */
  profileRead: boolean;
  /** lists already read this lookup, `${accountId}.${list}`: a list that could only be read in part is not asked again */
  tried?: ReadonlySet<string>;
}

export type Direction = 'yes' | 'no' | 'unknown';

export interface BridgeStatus {
  accountId: string;
  personId: string;
  /** the target follows the bridge */
  targetFollows: Direction;
  /** the bridge follows the target */
  followsTarget: Direction;
}

/** What Orbit can say about every circle account from the lists it holds. */
export function bridgeStatuses(s: LookupState): BridgeStatus[] {
  const t = s.target;
  const tFollowingDone = listComplete(t.following);
  const tFollowersDone = listComplete(t.followers);
  return s.circle
    .filter((c) => c.accountId !== s.targetAccountId)
    .map((c) => {
      const own = s.candidates.get(c.accountId);
      // the target follows c: c is on the target's following, or the target is on c's followers
      let targetFollows: Direction = 'unknown';
      if (t.following?.ids.has(c.accountId) || own?.followers?.ids.has(s.targetAccountId))
        targetFollows = 'yes';
      else if (tFollowingDone || listComplete(own?.followers)) targetFollows = 'no';
      // c follows the target: c is on the target's followers, or the target is on c's following
      let followsTarget: Direction = 'unknown';
      if (t.followers?.ids.has(c.accountId) || own?.following?.ids.has(s.targetAccountId))
        followsTarget = 'yes';
      else if (tFollowersDone || listComplete(own?.following)) followsTarget = 'no';
      return { accountId: c.accountId, personId: c.personId, targetFollows, followsTarget };
    });
}

/** Bridges: the two follow each other. */
export const isBridge = (b: BridgeStatus) => b.targetFollows === 'yes' && b.followsTarget === 'yes';
/** One-way follows, kept as support (plan 43 §3.7). */
export const isOneWay = (b: BridgeStatus) =>
  (b.targetFollows === 'yes') !== (b.followsTarget === 'yes') &&
  (b.targetFollows === 'no' || b.followsTarget === 'no');
const settled = (b: BridgeStatus) =>
  b.targetFollows === 'no' ||
  b.followsTarget === 'no' ||
  (b.targetFollows === 'yes' && b.followsTarget === 'yes');

export type LookupStep =
  | { do: 'profile'; accountId: string }
  | { do: 'list'; accountId: string; list: 'followers' | 'following' }
  | {
      do: 'done';
      bridges: BridgeStatus[];
      oneWay: BridgeStatus[];
      partial: boolean;
      reason?: 'private' | 'none' | 'no_circle';
    };

const listSize = (l: AccountLists, which: 'followers' | 'following') =>
  which === 'followers' ? (l.followerCount ?? l.followers?.total) : (l.followingCount ?? l.following?.total);

function done(s: LookupState, reason?: 'private' | 'none' | 'no_circle'): LookupStep {
  const all = bridgeStatuses(s);
  const bridges = all.filter(isBridge);
  return {
    do: 'done',
    bridges,
    oneWay: all.filter(isOneWay),
    partial: all.some((b) => !settled(b)),
    ...(reason ? { reason } : !bridges.length && all.every(settled) ? { reason: 'none' as const } : {}),
  };
}

/**
 * The next read for one lookup, in the order of plan 43 §3.6: the graph Orbit holds first (free), then the count
 * (Instagram, one call, fresh every lookup), then the target's shorter list if it is small enough, then the other
 * direction for whatever candidates are left, from whichever side is cheaper.
 */
export function nextLookupStep(s: LookupState): LookupStep {
  const circle = s.circle.filter((c) => c.accountId !== s.targetAccountId);
  if (!circle.length) return done(s, 'no_circle');
  let open = bridgeStatuses(s).filter((b) => !settled(b));
  if (!open.length) return done(s);

  // the count, once per lookup on Instagram; it also says whether the target is private
  if (s.platform === 'instagram' && !s.profileRead) return { do: 'profile', accountId: s.targetAccountId };
  if (s.target.isPrivate) return done(s, 'private');
  // a zero count proves there is no bridge only when the whole circle is accounts the student follows
  if (s.platform === 'instagram' && s.count === 0 && circle.every((c) => c.studentFollows))
    return done(s, 'none');

  // the target's shorter list, if small enough to read whole
  const tried = (accountId: string, list: string) => !!s.tried?.has(`${accountId}.${list}`);
  const sizes = (['following', 'followers'] as const)
    .map((list) => ({ list, size: listSize(s.target, list) }))
    .filter((x) => !listComplete(s.target[x.list]) && !tried(s.targetAccountId, x.list))
    .sort((a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY));
  const readTarget = sizes.filter((x) => (x.size ?? Number.POSITIVE_INFINITY) <= MAX_LIST_READ);
  // only read a target list if some open candidate needs the direction it settles
  const needs = (list: 'followers' | 'following') =>
    open.some((b) => (list === 'following' ? b.targetFollows : b.followsTarget) === 'unknown');
  const first = readTarget.find((x) => needs(x.list));
  if (first) return { do: 'list', accountId: s.targetAccountId, list: first.list };

  // the other direction from the candidates' side: each candidate's own list, smallest first
  open = bridgeStatuses(s).filter((b) => !settled(b));
  const sides = open
    .flatMap((b) => {
      const own = s.candidates.get(b.accountId) ?? {};
      const out: { accountId: string; list: 'followers' | 'following'; size: number }[] = [];
      // c follows the target? read c's following
      if (b.followsTarget === 'unknown' && !listComplete(own.following) && !tried(b.accountId, 'following'))
        out.push({
          accountId: b.accountId,
          list: 'following',
          size: listSize(own, 'following') ?? MAX_LIST_READ,
        });
      // the target follows c? read c's followers
      if (b.targetFollows === 'unknown' && !listComplete(own.followers) && !tried(b.accountId, 'followers'))
        out.push({
          accountId: b.accountId,
          list: 'followers',
          size: listSize(own, 'followers') ?? MAX_LIST_READ,
        });
      return out;
    })
    .filter((x) => x.size <= MAX_LIST_READ)
    .sort((a, b) => a.size - b.size);
  if (sides[0]) return { do: 'list', accountId: sides[0].accountId, list: sides[0].list };
  return done(s);
}
