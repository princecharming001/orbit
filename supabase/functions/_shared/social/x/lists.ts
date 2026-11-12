/**
 * X's follow lists and how long Orbit keeps what X returned (plan 43 §5, §3.5, §9).
 *
 * - **To the end or not at all.** A partial list can never prove there is no bridge and can never be reused, so a list
 *   is read only when its profile count is within the limit, every page is priced before it is read, and nothing is
 *   stored unless the read reached the end. A read stopped part way (the budget, a list that grew past the limit, the
 *   account going protected) stores nothing.
 * - **Keeping current.** Every X row expires 30 days after it was read and is deleted (`expireX`, job kind
 *   `x.expire`). An account seen protected, suspended or gone is dropped at once (`dropXAccount`).
 * - **Deleting on request** within 24 hours: `forgetXAccount` does it at once and suppresses the account so a later
 *   read does not store it again.
 * - **Never shared between students.** A student's own list carries their id (owner_user_id) and answers only them; a
 *   public account's list (owner null) is shared, which X allows because it holds ids only.
 */
import { accountKind, type SocialAccount } from '@orbit/core/entity/social';
import type { Db } from '../../db.ts';
import { SocialBudgetSpent, type SocialList } from '../adapter.ts';
import {
  XAccountGone,
  XAccountProtected,
  type XAdapter,
  type XProfileRead,
  XRateLimited,
} from './adapter.ts';
import { LIST_SLACK, X_KEEP_DAYS } from './config.ts';

const DAY = 86_400_000;
const expiry = (now: Date) => new Date(now.getTime() + X_KEEP_DAYS * DAY);
/** Fewer pages than this always reach the end of a list within the limit (1000 a page); more means something is off. */
const MAX_PAGES = 20;

export async function isXSuppressed(db: Db, accountId: string): Promise<boolean> {
  const [r] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit.social_suppressed where platform = 'x' and account_id = ${accountId}`;
  return (r?.n ?? 0) > 0;
}

/**
 * A complete, fresh copy of a list Orbit already holds that may answer this student: a public account's list, or the
 * student's own. Never another student's own list (plan 43 §3.6: X lists are never shared between friends).
 */
export async function heldXList(
  db: Db,
  accountId: string,
  list: SocialList,
  userId: string,
  now = new Date(),
): Promise<string[] | undefined> {
  const [read] = await db.sql<{ owner_user_id: string | null }>`
    select owner_user_id from orbit.social_list_reads
     where platform = 'x' and account_id = ${accountId} and list = ${list} and ended
       and expires_at > ${now}::timestamptz
       and (owner_user_id is null or owner_user_id = ${userId}::uuid)
     order by owner_user_id nulls last limit 1`;
  if (!read) return undefined;
  const rows =
    list === 'followers'
      ? await db.sql<{ id: string }>`
          select follower_id as id from orbit.social_follows
           where platform = 'x' and followed_id = ${accountId} and expires_at > ${now}::timestamptz
             and owner_user_id is not distinct from ${read.owner_user_id}::uuid`
      : await db.sql<{ id: string }>`
          select followed_id as id from orbit.social_follows
           where platform = 'x' and follower_id = ${accountId} and expires_at > ${now}::timestamptz
             and owner_user_id is not distinct from ${read.owner_user_id}::uuid`;
  return rows.map((r) => r.id);
}

/** Keeps an account's public profile for 30 days; a protected account is dropped instead, a suppressed one skipped. */
export async function upsertXAccount(db: Db, a: SocialAccount, now = new Date()): Promise<void> {
  if (a.isPrivate) return dropXAccount(db, a.id, 'protected');
  if (await isXSuppressed(db, a.id)) return;
  await db.sql`
    insert into orbit.social_accounts (platform, account_id, username, name, bio, links, followers, following,
                                       verified, is_private, default_picture, kind, read_at, expires_at)
    values ('x', ${a.id}, ${a.username}, ${a.name ?? null}, ${a.bio ?? null}, ${a.links ?? []}::text[],
            ${a.followers ?? null}::int, ${a.following ?? null}::int, ${a.verified ?? false}, false,
            ${a.defaultPicture ?? false}, ${accountKind(a)}, ${now}::timestamptz, ${expiry(now)}::timestamptz)
    on conflict (platform, account_id) do update set
      username = excluded.username, name = excluded.name, bio = excluded.bio, links = excluded.links,
      followers = excluded.followers, following = excluded.following, verified = excluded.verified,
      is_private = false, default_picture = excluded.default_picture, kind = excluded.kind,
      read_at = excluded.read_at, expires_at = excluded.expires_at`;
}

/**
 * Drops what Orbit holds from an account that went protected, was suspended or is gone (X's rule: stored data follows
 * the platform). Its profile, its list reads and every shared follow naming it go. A student's own follows of a
 * protected account stay (that is the student's own list); for a suspended or missing account they go too.
 */
export async function dropXAccount(
  db: Db,
  accountId: string,
  why: 'protected' | 'suspended' | 'not_found',
): Promise<void> {
  await db.begin(async (tx) => {
    await tx.sql`delete from orbit.social_accounts where platform = 'x' and account_id = ${accountId}`;
    await tx.sql`delete from orbit.social_list_reads where platform = 'x' and account_id = ${accountId}`;
    if (why === 'protected')
      await tx.sql`
        delete from orbit.social_follows
         where platform = 'x' and owner_user_id is null
           and (follower_id = ${accountId} or followed_id = ${accountId})`;
    else
      await tx.sql`
        delete from orbit.social_follows
         where platform = 'x' and (follower_id = ${accountId} or followed_id = ${accountId})`;
  });
}

export type XProfileResult =
  | { ok: true; profile: XProfileRead }
  | { ok: false; reason: 'gone' | 'limit' | 'protected' | 'rate_limited' };

/**
 * A profile read that keeps Orbit current with X: a suspended or missing account is dropped, and so is what Orbit held
 * of an account now protected (which still comes back as read, so the caller can tell).
 */
export async function readXProfile(db: Db, adapter: XAdapter, ref: string): Promise<XProfileResult> {
  try {
    const profile = await adapter.profile(ref);
    if (profile.account.isPrivate) await dropXAccount(db, profile.account.id, 'protected');
    return { ok: true, profile };
  } catch (e) {
    if (e instanceof XAccountGone) {
      if (/^\d+$/.test(e.ref)) await dropXAccount(db, e.ref, e.why);
      return { ok: false, reason: 'gone' };
    }
    if (e instanceof SocialBudgetSpent) return { ok: false, reason: 'limit' };
    if (e instanceof XRateLimited) return { ok: false, reason: 'rate_limited' };
    throw e;
  }
}

export interface XListRead {
  accountId: string;
  list: SocialList;
  ids: string[];
  accounts: SocialAccount[];
  relations: Record<string, { following: boolean; followedBy: boolean }>;
}

export type XListResult =
  | (XListRead & { ok: true; held: boolean })
  | {
      ok: false;
      reason: 'protected' | 'too_big' | 'budget' | 'gone' | 'rate_limited' | 'suppressed';
      size?: number;
    };

/**
 * Reads one list to the end, or refuses before spending anything on it (plan 43 §5).
 *
 * The size comes from the profile (`size`, or one profile read when not given). Over `limit` → refused. Each page is
 * asked for no more than what is left plus a little room, so the reservation for the whole read is the price
 * `quoteXCheck` showed. Only a read that reached the end is stored (`storeXListRead`); anything else is discarded.
 */
export async function readXListToEnd(
  db: Db,
  adapter: XAdapter,
  o: {
    accountId: string;
    list: SocialList;
    limit: number;
    /** the count on the account's profile, when already read */
    size?: number;
    /** the student whose own list this is; null or undefined for a public account's list */
    ownerUserId?: string | null;
    /** who pays for the read */
    readBy: string;
    /** the student's own X id, for writing who follows them back from their own list's relations */
    meId?: string | null;
    now?: () => Date;
  },
): Promise<XListResult> {
  const now = o.now ?? (() => new Date());
  if (await isXSuppressed(db, o.accountId)) return { ok: false, reason: 'suppressed' };
  const held = await heldXList(db, o.accountId, o.list, o.readBy, now());
  if (held)
    return {
      ok: true,
      held: true,
      accountId: o.accountId,
      list: o.list,
      ids: held,
      accounts: [],
      relations: {},
    };
  let size = o.size;
  if (size === undefined) {
    const p = await readXProfile(db, adapter, o.accountId);
    if (!p.ok) return { ok: false, reason: p.reason === 'limit' ? 'budget' : p.reason };
    if (p.profile.account.isPrivate) return { ok: false, reason: 'protected' };
    size = (o.list === 'following' ? p.profile.account.following : p.profile.account.followers) ?? 0;
  }
  if (size > o.limit) return { ok: false, reason: 'too_big', size };

  const ids: string[] = [];
  const seen = new Set<string>();
  const accounts: SocialAccount[] = [];
  const relations: XListRead['relations'] = {};
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const want = Math.max(1, Math.min(1000, size - ids.length + LIST_SLACK));
      const p = await adapter.listPage(o.accountId, o.list, cursor, want);
      for (const id of p.ids)
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      accounts.push(...(p.accounts ?? []));
      Object.assign(relations, p.relations ?? {});
      cursor = p.cursor;
      if (!cursor) break;
      // the list grew past what it was priced for (its count plus a little room): stop, keep nothing
      if (ids.length >= size + LIST_SLACK) return { ok: false, reason: 'too_big', size: ids.length };
    }
    if (cursor) return { ok: false, reason: 'too_big', size: ids.length };
  } catch (e) {
    if (e instanceof SocialBudgetSpent) return { ok: false, reason: 'budget' };
    if (e instanceof XRateLimited) return { ok: false, reason: 'rate_limited' };
    if (e instanceof XAccountProtected) {
      await dropXAccount(db, o.accountId, 'protected');
      return { ok: false, reason: 'protected' };
    }
    if (e instanceof XAccountGone) {
      await dropXAccount(db, o.accountId, e.why);
      return { ok: false, reason: 'gone' };
    }
    throw e;
  }
  const read: XListRead = { accountId: o.accountId, list: o.list, ids, accounts, relations };
  await storeXListRead(db, read, {
    ownerUserId: o.ownerUserId ?? null,
    readBy: o.readBy,
    total: size,
    meId: o.meId ?? null,
    now: now(),
  });
  return { ok: true, held: false, ...read };
}

/**
 * Stores a list that was read to the end, in one transaction: the follows (ids only), the read itself as ended, and
 * profiles only for the accounts that matter (on the student's own list, the accounts they follow each other with).
 * Suppressed and protected accounts are left out.
 */
export async function storeXListRead(
  db: Db,
  r: XListRead,
  o: { ownerUserId: string | null; readBy: string; total: number; meId: string | null; now: Date },
): Promise<void> {
  const suppressed = new Set(
    (
      await db.sql<{ account_id: string }>`
        select account_id from orbit.social_suppressed where platform = 'x' and account_id = any(${r.ids}::text[])`
    ).map((s) => s.account_id),
  );
  const ids = r.ids.filter((id) => !suppressed.has(id));
  const until = expiry(o.now);
  // the student's own list says who follows them back (connection_status), so that list is never read
  const own = !!o.ownerUserId && !!o.meId && r.accountId === o.meId;
  await db.begin(async (tx) => {
    if (r.list === 'followers')
      await tx.sql`
        delete from orbit.social_follows
         where platform = 'x' and followed_id = ${r.accountId}
           and owner_user_id is not distinct from ${o.ownerUserId}::uuid`;
    else
      await tx.sql`
        delete from orbit.social_follows
         where platform = 'x' and follower_id = ${r.accountId}
           and owner_user_id is not distinct from ${o.ownerUserId}::uuid`;
    const follower = r.list === 'followers' ? ids : ids.map(() => r.accountId);
    const followed = r.list === 'followers' ? ids.map(() => r.accountId) : ids;
    if (own && r.list === 'following')
      for (const id of ids)
        if (r.relations[id]?.followedBy) {
          follower.push(id);
          followed.push(o.meId!);
        }
    if (follower.length)
      await tx.sql`
        insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id, seen_at, expires_at)
        select 'x', f, t, ${o.ownerUserId}::uuid, ${o.now}::timestamptz, ${until}::timestamptz
          from unnest(${follower}::text[], ${followed}::text[]) as u(f, t)
        on conflict do nothing`;
    await tx.sql`
      delete from orbit.social_list_reads
       where platform = 'x' and account_id = ${r.accountId} and list = ${r.list}
         and owner_user_id is not distinct from ${o.ownerUserId}::uuid`;
    await tx.sql`
      insert into orbit.social_list_reads (platform, account_id, list, owner_user_id, read_by, rows_read, total, ended,
                                           read_at, expires_at)
      values ('x', ${r.accountId}, ${r.list}, ${o.ownerUserId}::uuid, ${o.readBy}::uuid, ${ids.length}::int,
              ${o.total}::int, true, ${o.now}::timestamptz, ${until}::timestamptz)`;
  });
  if (own)
    for (const a of r.accounts) {
      if (suppressed.has(a.id)) continue;
      const rel = r.relations[a.id];
      if (a.isPrivate) await dropXAccount(db, a.id, 'protected');
      else if (rel?.following && rel.followedBy) await upsertXAccount(db, a, o.now);
    }
  else for (const a of r.accounts) if (a.isPrivate) await dropXAccount(db, a.id, 'protected');
}

/** Deletes every X row in the shared graph past its 30 days (job kind `x.expire`). */
export async function expireX(
  db: Db,
  now = new Date(),
): Promise<{ follows: number; lists: number; accounts: number }> {
  const f = await db.sql`
    delete from orbit.social_follows where platform = 'x' and expires_at <= ${now}::timestamptz returning 1 as x`;
  const l = await db.sql`
    delete from orbit.social_list_reads where platform = 'x' and expires_at <= ${now}::timestamptz returning 1 as x`;
  const a = await db.sql`
    delete from orbit.social_accounts where platform = 'x' and expires_at <= ${now}::timestamptz returning 1 as x`;
  return { follows: f.length, lists: l.length, accounts: a.length };
}

/**
 * Everything Orbit holds about one X account, gone at once (a deletion request, honoured well inside X's 24 hours):
 * the shared graph, every student's attachment, questions and answers about it, the identity, and the X messages and
 * threads it took part in. The account is suppressed so no later read stores it again. People rows stay: a person may
 * be known from elsewhere, and loses only what came from this account.
 */
export async function forgetXAccount(db: Db, accountId: string): Promise<void> {
  await db.begin(async (tx) => {
    await tx.sql`
      insert into orbit.social_suppressed (platform, account_id, reason) values ('x', ${accountId}, 'request')
      on conflict (platform, account_id) do update set reason = 'request'`;
    await tx.sql`delete from orbit.social_accounts where platform = 'x' and account_id = ${accountId}`;
    await tx.sql`delete from orbit.social_list_reads where platform = 'x' and account_id = ${accountId}`;
    await tx.sql`
      delete from orbit.social_follows
       where platform = 'x' and (follower_id = ${accountId} or followed_id = ${accountId})`;
    await tx.sql`delete from orbit.social_links where platform = 'x' and account_id = ${accountId}`;
    await tx.sql`delete from orbit.social_match_asks where platform = 'x' and account_id = ${accountId}`;
    await tx.sql`delete from orbit.social_not_same where platform = 'x' and account_id = ${accountId}`;
    await tx.sql`
      delete from orbit.person_identities
       where (kind = 'x_id' and value_norm = ${accountId}) or social_account_id = ${accountId}`;
    await tx.sql`delete from orbit.messages where provider = 'x' and social_account_id = ${accountId}`;
    await tx.sql`delete from orbit.threads where provider = 'x' and social_account_id = ${accountId}`;
    await tx.sql`
      update orbit.people set source_account = null where source_account = ${`x:${accountId}`}`;
  });
}
