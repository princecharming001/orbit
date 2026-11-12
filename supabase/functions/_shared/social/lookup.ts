/**
 * Who could introduce the student to a target on Instagram or X (plan 43 §3.6), as a job that resumes. Between reads
 * it asks core `nextLookupStep` what the cheapest next read is, given what Orbit holds:
 *
 * 1. The source must be on and the target's account attached (`startLookup`).
 * 2. The graph first: bridges are accounts in the student's circle that the target follows and that follow the target.
 *    Held lists answer for free; nothing about an earlier answer is kept, so a list another student read yesterday,
 *    or a friend followed this morning, counts at once.
 * 3. The count (Instagram): one profile read, fresh every lookup, never kept after it.
 * 4.-5. The target's shorter list, then the other direction from whichever side is cheaper.
 * 6. The follow ties are rewritten from the graph (`rewriteFollowTies`), bridges become (unlisted) people if needed,
 *    and the student is told.
 *
 * Shared lists are public lists (owner null) and record who read them. Before one is reused, the account's stored
 * privacy is checked: a list of an account that turned private is dropped, not reused. Suppressed accounts are never
 * stored (graph.ts checks before every store). The planner's memory (`tried`, the count) and each list's cursor are
 * saved, so a lookup the budget stops picks up where it was.
 */
import type { SocialAccount, SocialPlatform } from '@orbit/core/entity/social';
import {
  type AccountLists,
  type BridgeStatus,
  type CircleAccount,
  isBridge,
  isOneWay,
  type ListRead,
  type LookupState,
  nextLookupStep,
} from '@orbit/core/graph/socialLookup';
import type { OptionalSource } from '@orbit/core/sources';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import type { Queue } from '../queue.ts';
import { sourceIsOn } from '../sources/states.ts';
import { type SocialAdapter, SocialBudgetSpent, SocialSignInNeeded } from './adapter.ts';
import {
  CountedSet,
  dropSharedLists,
  LIST_FRESH_MS,
  loadAccounts,
  loadListRead,
  readListPage,
  suppressedOf,
  upsertAccounts,
} from './graph.ts';
import { platformName } from './keys.ts';
import { ensureAccountPerson, knownPeople, ownAccountId, personForAccount } from './people.ts';
import { type FollowPair, rewriteFollowTies } from './ties.ts';

/** Reads one lookup job makes before it hands on, so calls are spread out. */
export const CALLS_PER_RUN = 3;

export type LookupStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed';

export interface LookupResult {
  bridges: { personId: string; accountId: string; name: string }[];
  oneWay: { personId: string; accountId: string; followerId: string }[];
  /** some of the circle could not be settled: never read as "no one" */
  partial: boolean;
  reason?: 'private' | 'none' | 'no_circle' | 'source_off' | 'sign_in' | 'suppressed';
}

interface SavedState {
  tried?: string[];
  /** Instagram's count on the target's profile, read this lookup */
  count?: number;
  profileRead?: boolean;
  calls?: number;
}

/** The account attached to a person on a platform, the newest when there are several. */
export async function attachedAccount(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  personId: string,
): Promise<string | undefined> {
  const [l] = await db.sql<{ account_id: string }>`
    select account_id from orbit.social_links
     where user_id = ${userId}::uuid and platform = ${platform} and person_id = ${personId}::uuid
     order by created_at desc limit 1`;
  return l?.account_id;
}

/** Starts (or returns the one already running) lookup of who could introduce the student to a person. */
export async function startLookup(
  db: Db,
  queue: Queue,
  userId: string,
  platform: SocialPlatform,
  personId: string,
  /** the owner's env list (ORBIT_EXTRA_SOURCES); the launch switches are joined to it */
  envList: readonly OptionalSource[] = [],
): Promise<{ lookupId: string; status: LookupStatus }> {
  if (!(await sourceIsOn(db, userId, platform, envList)))
    throw new HttpError(409, 'source_off', `${platformName(platform)} is not on`);
  const account = await attachedAccount(db, userId, platform, personId);
  if (!account)
    throw new HttpError(
      409,
      'no_account',
      `Orbit does not know their ${platformName(platform)} account for sure, so it cannot look`,
    );
  const [open] = await db.sql<{ id: string; status: LookupStatus }>`
    select id, status from orbit.social_lookups
     where user_id = ${userId}::uuid and platform = ${platform} and target_person_id = ${personId}::uuid
       and status in ('queued', 'running', 'waiting')
     order by created_at desc limit 1`;
  if (open) return { lookupId: open.id, status: open.status };
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.social_lookups (user_id, platform, target_person_id, target_account_id, status, state)
    values (${userId}::uuid, ${platform}, ${personId}::uuid, ${account}, 'queued', '{}'::jsonb)
    returning id`;
  await queue.enqueue({
    kind: 'social.lookup',
    userId,
    payload: { lookupId: row!.id },
    dedupeKey: `social.lookup:${row!.id}:start`,
  });
  return { lookupId: row!.id, status: 'queued' };
}

/** The student's circle on a platform (plan 43 §3.3): accounts of people they know, and accounts they follow each other with. */
export async function loadCircle(
  db: Db,
  userId: string,
  platform: SocialPlatform,
): Promise<{ circle: CircleAccount[]; me: string | null }> {
  const me = await ownAccountId(db, userId, platform);
  const linked = await db.sql<{ account_id: string; person_id: string }>`
    select l.account_id, l.person_id from orbit.social_links l join orbit.people p on p.id = l.person_id
     where l.user_id = ${userId}::uuid and l.platform = ${platform} and p.deleted_at is null and p.merged_into is null
    union
    select split_part(p.source_account, ':', 2), p.id from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null
       and p.source_account like ${`${platform}:%`}`;
  const known = await knownPeople(
    db,
    userId,
    linked.map((l) => l.person_id),
  );
  const following = new Set(
    me
      ? (
          await db.sql<{ id: string }>`
            select followed_id as id from orbit.social_follows
             where platform = ${platform} and owner_user_id = ${userId}::uuid and follower_id = ${me}
               and expires_at > now()`
        ).map((r) => r.id)
      : [],
  );
  const mutual = me
    ? await db.sql<{ id: string }>`
        select f.follower_id as id from orbit.social_follows f
          join orbit.social_accounts a on a.platform = f.platform and a.account_id = f.follower_id and a.kind = 'person'
         where f.platform = ${platform} and f.owner_user_id = ${userId}::uuid and f.followed_id = ${me}
           and f.expires_at > now()
           and exists (select 1 from orbit.social_follows g where g.platform = f.platform
                         and g.owner_user_id = ${userId}::uuid and g.follower_id = ${me} and g.followed_id = f.follower_id
                         and g.expires_at > now())`
    : [];
  const byAccount = new Map<string, CircleAccount>();
  for (const l of linked)
    if (known.has(l.person_id) && l.account_id !== me)
      byAccount.set(l.account_id, {
        accountId: l.account_id,
        personId: l.person_id,
        studentFollows: following.has(l.account_id),
      });
  for (const m of mutual) {
    if (byAccount.has(m.id) || m.id === me) continue;
    const p = linked.find((l) => l.account_id === m.id);
    byAccount.set(m.id, { accountId: m.id, personId: p?.person_id ?? '', studentFollows: true });
  }
  const blocked = await suppressedOf(db, platform, [...byAccount.keys()]);
  return { circle: [...byAccount.values()].filter((c) => !blocked.has(c.accountId)), me };
}

/** What Orbit holds of each circle account's own lists, in two queries, as far as the target is concerned. */
async function candidateLists(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  accounts: string[],
  target: string,
  now: Date,
): Promise<Map<string, AccountLists>> {
  const out = new Map<string, AccountLists>();
  if (!accounts.length) return out;
  const reads = await db.sql<{
    account_id: string;
    list: 'followers' | 'following';
    rows_read: number;
    total: number | null;
    ended: boolean;
    read_at: Date | string;
  }>`
    select account_id, list, rows_read, total, ended, read_at from orbit.social_list_reads
     where platform = ${platform} and account_id = any(${accounts}::text[]) and owner_user_id is null
       and expires_at > now()`;
  const rows = await db.sql<{ follower_id: string; followed_id: string; seen_at: Date | string }>`
    select follower_id, followed_id, max(seen_at) as seen_at from orbit.social_follows
     where platform = ${platform} and expires_at > now()
       and (owner_user_id is null or owner_user_id = ${userId}::uuid)
       and ((follower_id = any(${accounts}::text[]) and followed_id = ${target})
         or (followed_id = any(${accounts}::text[]) and follower_id = ${target}))
     group by follower_id, followed_id`;
  const counts = await loadAccounts(db, platform, accounts);
  for (const a of accounts) {
    const lists: AccountLists = {
      followerCount: counts.get(a)?.followers ?? undefined,
      followingCount: counts.get(a)?.following ?? undefined,
      isPrivate: counts.get(a)?.is_private ?? undefined,
    };
    for (const r of reads.filter((x) => x.account_id === a)) {
      const usable = r.ended && now.getTime() - new Date(r.read_at).getTime() <= LIST_FRESH_MS;
      // a read that ended long ago says nothing until it is read again; one in progress, only what it has seen
      const since = usable ? 0 : r.ended ? Number.POSITIVE_INFINITY : new Date(r.read_at).getTime();
      const has =
        r.list === 'followers'
          ? rows.some(
              (x) =>
                x.followed_id === a && x.follower_id === target && new Date(x.seen_at).getTime() >= since,
            )
          : rows.some(
              (x) =>
                x.follower_id === a && x.followed_id === target && new Date(x.seen_at).getTime() >= since,
            );
      const read: ListRead = {
        ids: new CountedSet(has ? [target] : [], usable ? r.rows_read : 0),
        ended: usable,
        ...(r.total != null ? { total: r.total } : {}),
      };
      lists[r.list] = read;
    }
    // a follow seen lately from any other list (the target's, or a third account's) still says yes
    const recent = (x: { seen_at: Date | string }) =>
      now.getTime() - new Date(x.seen_at).getTime() <= LIST_FRESH_MS;
    if (!lists.followers && rows.some((x) => x.followed_id === a && x.follower_id === target && recent(x)))
      lists.followers = { ids: new Set([target]), ended: false };
    if (!lists.following && rows.some((x) => x.follower_id === a && x.followed_id === target && recent(x)))
      lists.following = { ids: new Set([target]), ended: false };
    out.set(a, lists);
  }
  return out;
}

async function buildState(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  target: string,
  saved: SavedState,
  now: Date,
): Promise<LookupState> {
  const { circle } = await loadCircle(db, userId, platform);
  const stored = (await loadAccounts(db, platform, [target])).get(target);
  // a shared list is reused only while the account is public
  if (stored?.is_private) await dropSharedLists(db, platform, target);
  const lists: AccountLists = {
    followerCount: stored?.followers ?? undefined,
    followingCount: stored?.following ?? undefined,
    isPrivate: stored?.is_private ?? undefined,
  };
  if (!stored?.is_private) {
    lists.followers = await loadListRead(db, platform, target, 'followers', { userId, now });
    lists.following = await loadListRead(db, platform, target, 'following', { userId, now });
  }
  return {
    platform,
    targetAccountId: target,
    circle,
    target: lists,
    candidates: await candidateLists(
      db,
      userId,
      platform,
      circle.map((c) => c.accountId),
      target,
      now,
    ),
    ...(saved.count !== undefined ? { count: saved.count } : {}),
    profileRead: !!saved.profileRead,
    tried: new Set(saved.tried ?? []),
  };
}

export interface RunOutcome {
  status: LookupStatus;
  retryAt?: Date;
  /** the run stopped at its call allowance with work left */
  more?: boolean;
}

/** Runs a lookup until it ends, the budget refuses a call, or this run's calls are spent. */
export async function runLookup(
  db: Db,
  adapter: SocialAdapter,
  lookupId: string,
  o: { now: Date; callsPerRun?: number; offered?: readonly OptionalSource[] },
): Promise<RunOutcome> {
  const [l] = await db.sql<{
    user_id: string;
    platform: SocialPlatform;
    target_person_id: string;
    target_account_id: string;
    status: LookupStatus;
    state: SavedState;
  }>`
    select user_id, platform, target_person_id, target_account_id, status, state from orbit.social_lookups
     where id = ${lookupId}::uuid`;
  if (!l) return { status: 'failed' };
  if (l.status === 'done' || l.status === 'failed') return { status: l.status };
  const userId = l.user_id;
  const platform = l.platform;
  const target = l.target_account_id;
  const saved: SavedState = { ...(l.state ?? {}) };
  const save = async (status: LookupStatus, result?: LookupResult) => {
    // the count is never kept past the lookup that read it
    const state = status === 'done' || status === 'failed' ? { ...saved, count: undefined } : saved;
    await db.sql`
      update orbit.social_lookups set status = ${status}, state = ${JSON.parse(JSON.stringify(state))}::jsonb,
             result = coalesce(${result ?? null}::jsonb, result)
       where id = ${lookupId}::uuid`;
  };
  const fail = async (reason: LookupResult['reason']) => {
    await save('failed', { bridges: [], oneWay: [], partial: true, reason });
    return { status: 'failed' as const };
  };
  if (!(await sourceIsOn(db, userId, platform, o.offered))) return fail('source_off');
  if ((await suppressedOf(db, platform, [target])).size) return fail('suppressed');
  await save('running');

  const allowance = o.callsPerRun ?? CALLS_PER_RUN;
  let calls = 0;
  try {
    for (;;) {
      const s = await buildState(db, userId, platform, target, saved, o.now);
      const step = nextLookupStep(s);
      if (step.do === 'done') {
        const result = await finish(db, adapter, userId, l.target_person_id, target, platform, s, step, {
          lookupId,
          now: o.now,
        });
        await save('done', result);
        await notifyLookup(db, userId, l.target_person_id, platform, result, lookupId);
        return { status: 'done' };
      }
      if (calls >= allowance) {
        await save('waiting');
        return { status: 'waiting', more: true };
      }
      calls++;
      saved.calls = (saved.calls ?? 0) + 1;
      if (step.do === 'profile') {
        const read = await adapter.profile(step.accountId);
        await upsertAccounts(db, [read.account], { full: true, now: o.now });
        saved.profileRead = true;
        if (read.mutualCount !== undefined) saved.count = read.mutualCount;
        if (read.account.isPrivate) await dropSharedLists(db, platform, step.accountId);
        continue;
      }
      const key = `${step.accountId}.${step.list}`;
      const total =
        step.accountId === target
          ? step.list === 'followers'
            ? s.target.followerCount
            : s.target.followingCount
          : step.list === 'followers'
            ? s.candidates.get(step.accountId)?.followerCount
            : s.candidates.get(step.accountId)?.followingCount;
      try {
        const page = await readListPage(db, adapter, {
          accountId: step.accountId,
          list: step.list,
          owner: null,
          readBy: userId,
          now: o.now,
          total,
        });
        // a list read to its end is not asked for again this lookup, complete or not (a verified account's sample)
        if (page.ended) saved.tried = [...new Set([...(saved.tried ?? []), key])];
      } catch (e) {
        if (e instanceof SocialBudgetSpent || e instanceof SocialSignInNeeded) throw e;
        // a list the platform will not give (a private candidate): not asked again this lookup
        saved.tried = [...new Set([...(saved.tried ?? []), key])];
      }
    }
  } catch (e) {
    if (e instanceof SocialBudgetSpent) {
      await save('waiting');
      return { status: 'waiting', retryAt: e.retryAt ?? new Date(o.now.getTime() + 3_600_000) };
    }
    if (e instanceof SocialSignInNeeded) return fail('sign_in');
    throw e;
  }
}

async function finish(
  db: Db,
  adapter: SocialAdapter,
  userId: string,
  targetPerson: string,
  target: string,
  platform: SocialPlatform,
  s: LookupState,
  step: Extract<ReturnType<typeof nextLookupStep>, { do: 'done' }>,
  o: { lookupId: string; now: Date },
): Promise<LookupResult> {
  const statuses = new Map<string, BridgeStatus>();
  for (const b of [...step.bridges, ...step.oneWay]) statuses.set(b.accountId, b);
  // every circle account's status, so ties the graph no longer backs are removed
  const all = s.circle.filter((c) => c.accountId !== target);
  const accounts = await loadAccounts(db, platform, [target, ...all.map((c) => c.accountId)]);
  const pairs: FollowPair[] = [];
  const result: LookupResult = {
    bridges: [],
    oneWay: [],
    partial: step.partial,
    ...(step.reason ? { reason: step.reason } : {}),
  };
  // a zero count proves there is no bridge (core stops on it only when that is safe): a whole answer
  if (result.reason === 'none') result.partial = false;
  for (const c of all) {
    const st = statuses.get(c.accountId);
    const bridge = !!st && isBridge(st);
    const oneWay = !!st && isOneWay(st);
    let personId = c.personId;
    if (!personId && (bridge || oneWay)) {
      let acct = accounts.get(c.accountId);
      let account: SocialAccount = acct
        ? { platform, id: c.accountId, username: acct.username, name: acct.name ?? undefined }
        : { platform, id: c.accountId, username: c.accountId };
      if (!acct?.name)
        try {
          const read = await adapter.profile(c.accountId);
          await upsertAccounts(db, [read.account], { full: true, now: o.now });
          account = read.account;
          acct = (await loadAccounts(db, platform, [c.accountId])).get(c.accountId);
        } catch (e) {
          if (!(e instanceof SocialBudgetSpent)) throw e;
        }
      personId = (await ensureAccountPerson(db, userId, account, o.now)).personId;
    }
    if (!personId) personId = (await personForAccount(db, userId, platform, c.accountId))?.personId ?? '';
    if (!personId || personId === targetPerson) continue;
    pairs.push({
      aPerson: personId,
      aAccount: c.accountId,
      bPerson: targetPerson,
      bAccount: target,
      aFollowsB: st?.followsTarget ?? 'unknown',
      bFollowsA: st?.targetFollows ?? 'unknown',
      aFollowing: accounts.get(c.accountId)?.following ?? undefined,
      bFollowing: accounts.get(target)?.following ?? undefined,
    });
    if (bridge)
      result.bridges.push({
        personId,
        accountId: c.accountId,
        name: accounts.get(c.accountId)?.name ?? accounts.get(c.accountId)?.username ?? c.accountId,
      });
    else if (oneWay)
      result.oneWay.push({
        personId,
        accountId: c.accountId,
        followerId: st!.followsTarget === 'yes' ? personId : targetPerson,
      });
  }
  await rewriteFollowTies(db, userId, platform, pairs, { now: o.now, lookupId: o.lookupId });
  if (result.bridges.length || result.oneWay.length)
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'system', 'social.lookup', 'social_lookups', ${o.lookupId},
              ${{ platform, bridges: result.bridges.length, oneWay: result.oneWay.length }}::jsonb)`;
  return result;
}

/** Tells the student a lookup ended, once (the X check uses it too). */
export async function notifyLookup(
  db: Db,
  userId: string,
  personId: string,
  platform: SocialPlatform,
  r: LookupResult,
  lookupId: string,
) {
  const [p] = await db.sql<{ display_name: string; first_name: string | null }>`
    select display_name, first_name from orbit.people where id = ${personId}::uuid`;
  const first = p?.first_name || p?.display_name?.split(/\s+/)[0] || 'them';
  const where = platformName(platform);
  const names = r.bridges.map((b) => b.name.split(/\s+/)[0]);
  const body = r.bridges.length
    ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} ${
        names.length === 1 ? 'follows' : 'follow'
      } each other with ${first} on ${where}.`
    : r.reason === 'private'
      ? `${first}'s account is private, so Orbit cannot see who they follow.`
      : r.partial
        ? `Orbit could read only part of ${first}'s lists, so this is not the whole answer yet.`
        : `No one you know follows each other with ${first} on ${where}.`;
  const updated = await db.sql<{ id: string }>`
    update orbit.social_lookups set notified = true where id = ${lookupId}::uuid and not notified returning id`;
  if (!updated.length) return;
  await db.sql`
    insert into orbit.notifications (user_id, kind, title, body, link)
    values (${userId}::uuid, 'social_lookup', ${`Finished checking ${where} for ${first}`}, ${body},
            ${`/people/${personId}`})`;
}
