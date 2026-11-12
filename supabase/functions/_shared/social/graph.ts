/**
 * The follow graph Orbit keeps (plan 43 §3.5), for any platform:
 *   social_accounts    one row per account Orbit has a reason to know, public profile fields only
 *   social_follows     "A follows B", ids only; a row from the student's own list carries them as its owner, a row
 *                      from a public account's list is shared (owner null)
 *   social_list_reads  per account and list: rows read, whether the read reached the end, the count the profile
 *                      shows, the cursor to resume from, who read it and when the read started
 *   social_suppressed  accounts never stored or used: checked before every store and every reuse
 *
 * A list read is a run of pages. Rows seen in it get `seen_at` at or after the read's start, so a read that reaches
 * the end of a complete list removes the follows it did not see again (an unfollow), and a list read long ago is read
 * again rather than trusted. A list counts as complete by core `listComplete`.
 */
import { accountKind, type SocialAccount, type SocialPlatform } from '@orbit/core/entity/social';
import { type ListRead, listComplete } from '@orbit/core/graph/socialLookup';
import type { Db } from '../db.ts';
import type { SocialAdapter, SocialList } from './adapter.ts';

const DAY = 86_400_000;
/** Shared rows are kept this long (plan 43 §3.5). */
export const GRAPH_KEEP_MS = 30 * DAY;
/** A complete list read this recently answers a lookup without being read again. */
export const LIST_FRESH_MS = 7 * DAY;
const NO_OWNER = '00000000-0000-0000-0000-000000000000';

/** The suppressed ids among `ids`. */
export async function suppressedOf(db: Db, platform: SocialPlatform, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.sql<{ account_id: string }>`
    select account_id from orbit.social_suppressed where platform = ${platform} and account_id = any(${ids}::text[])`;
  return new Set(rows.map((r) => r.account_id));
}

export type AccountRow = {
  account_id: string;
  username: string;
  name: string | null;
  bio: string | null;
  links: string[];
  email: string | null;
  phone: string | null;
  followers: number | null;
  following: number | null;
  verified: boolean;
  is_private: boolean;
  business: boolean;
  category: string | null;
  picture_hash: string | null;
  default_picture: boolean;
  kind: string;
  read_at: Date | string;
};

export function accountOfRow(platform: SocialPlatform, r: AccountRow): SocialAccount {
  return {
    platform,
    id: r.account_id,
    username: r.username,
    name: r.name ?? undefined,
    bio: r.bio ?? undefined,
    links: r.links ?? [],
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    followers: r.followers ?? undefined,
    following: r.following ?? undefined,
    verified: !!r.verified,
    isPrivate: !!r.is_private,
    business: !!r.business,
    category: r.category ?? undefined,
    pictureHash: r.picture_hash ?? undefined,
    defaultPicture: !!r.default_picture,
  };
}

export async function loadAccounts(
  db: Db,
  platform: SocialPlatform,
  ids: string[],
): Promise<Map<string, AccountRow>> {
  if (!ids.length) return new Map();
  const rows = await db.sql<AccountRow>`
    select account_id, username, name, bio, links, email, phone, followers, following, verified, is_private, business,
           category, picture_hash, default_picture, kind, read_at
      from orbit.social_accounts where platform = ${platform} and account_id = any(${ids}::text[])`;
  return new Map(rows.map((r) => [r.account_id, r]));
}

/**
 * Stores accounts, leaving out suppressed ones. `full` is a profile read: every public field is written and the kind
 * sorted again. Otherwise the fields a list page carries (handle, name, verified, private) are written and the rest
 * kept. Returns the ids stored.
 */
export async function upsertAccounts(
  db: Db,
  accounts: SocialAccount[],
  o: { full: boolean; now: Date },
): Promise<string[]> {
  if (!accounts.length) return [];
  const platform = accounts[0]!.platform;
  const blocked = await suppressedOf(
    db,
    platform,
    accounts.map((a) => a.id),
  );
  const out: string[] = [];
  const expires = new Date(o.now.getTime() + GRAPH_KEEP_MS);
  for (const a of accounts) {
    if (blocked.has(a.id) || a.platform !== platform) continue;
    const kind = accountKind(a);
    if (o.full)
      await db.sql`
        insert into orbit.social_accounts (platform, account_id, username, name, bio, links, email, phone, followers,
                                           following, verified, is_private, business, category, picture_hash,
                                           default_picture, kind, read_at, expires_at)
        values (${platform}, ${a.id}, ${a.username}, ${a.name ?? null}, ${a.bio ?? null}, ${a.links ?? []}::text[],
                ${a.email ?? null}, ${a.phone ?? null}, ${a.followers ?? null}::int, ${a.following ?? null}::int,
                ${!!a.verified}, ${!!a.isPrivate}, ${!!a.business}, ${a.category ?? null}, ${a.pictureHash ?? null},
                ${!!a.defaultPicture}, ${kind}, ${o.now}::timestamptz, ${expires}::timestamptz)
        on conflict (platform, account_id) do update set
          username = excluded.username, name = excluded.name, bio = excluded.bio, links = excluded.links,
          email = excluded.email, phone = excluded.phone, followers = excluded.followers,
          following = excluded.following, verified = excluded.verified, is_private = excluded.is_private,
          business = excluded.business, category = excluded.category,
          picture_hash = coalesce(excluded.picture_hash, orbit.social_accounts.picture_hash),
          default_picture = excluded.default_picture, kind = excluded.kind, read_at = excluded.read_at,
          expires_at = excluded.expires_at`;
    else
      await db.sql`
        insert into orbit.social_accounts (platform, account_id, username, name, verified, is_private, default_picture,
                                           kind, read_at, expires_at)
        values (${platform}, ${a.id}, ${a.username}, ${a.name ?? null}, ${!!a.verified}, ${!!a.isPrivate},
                ${!!a.defaultPicture}, ${kind}, ${o.now}::timestamptz, ${expires}::timestamptz)
        on conflict (platform, account_id) do update set
          username = excluded.username, name = coalesce(excluded.name, orbit.social_accounts.name),
          verified = excluded.verified, is_private = excluded.is_private,
          kind = case when orbit.social_accounts.kind = 'unknown' or excluded.verified then excluded.kind
                      else orbit.social_accounts.kind end,
          expires_at = greatest(orbit.social_accounts.expires_at, excluded.expires_at)`;
    out.push(a.id);
  }
  return out;
}

export type ListReadRow = {
  rows_read: number;
  total: number | null;
  ended: boolean;
  cursor: string | null;
  read_at: Date | string;
  read_by: string | null;
};

export async function getListRead(
  db: Db,
  platform: SocialPlatform,
  accountId: string,
  list: SocialList,
  owner: string | null,
): Promise<ListReadRow | undefined> {
  const [r] = await db.sql<ListReadRow>`
    select rows_read, total, ended, cursor, read_at, read_by from orbit.social_list_reads
     where platform = ${platform} and account_id = ${accountId} and list = ${list}
       and coalesce(owner_user_id, ${NO_OWNER}::uuid) = coalesce(${owner}::uuid, ${NO_OWNER}::uuid)
       and expires_at > now()`;
  return r;
}

/** The follow rows a list page means: who follows the account, or whom it follows. */
const followRows = (accountId: string, list: SocialList, ids: string[]) =>
  ids.map((id) =>
    list === 'followers' ? { follower: id, followed: accountId } : { follower: accountId, followed: id },
  );

export async function storeFollows(
  db: Db,
  platform: SocialPlatform,
  rows: { follower: string; followed: string }[],
  o: { owner: string | null; now: Date },
): Promise<number> {
  if (!rows.length) return 0;
  const blocked = await suppressedOf(db, platform, [
    ...new Set(rows.flatMap((r) => [r.follower, r.followed])),
  ]);
  const keep = rows.filter((r) => !blocked.has(r.follower) && !blocked.has(r.followed));
  if (!keep.length) return 0;
  const expires = new Date(o.now.getTime() + GRAPH_KEEP_MS);
  await db.sql`
    insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id, seen_at, expires_at)
    select ${platform}, f, t, ${o.owner}::uuid, ${o.now}::timestamptz, ${expires}::timestamptz
      from unnest(${keep.map((r) => r.follower)}::text[], ${keep.map((r) => r.followed)}::text[]) as x(f, t)
    on conflict (platform, follower_id, followed_id, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set seen_at = excluded.seen_at, expires_at = excluded.expires_at`;
  return keep.length;
}

export interface PageResult {
  ended: boolean;
  complete: boolean;
  ids: string[];
  accounts: SocialAccount[];
}

/**
 * Reads the next page of one list and stores it: a new read starts when there is none in progress (the caller only
 * asks when the list is needed). At the end of a complete list the follows it no longer shows are removed.
 */
export async function readListPage(
  db: Db,
  adapter: SocialAdapter,
  o: {
    accountId: string;
    list: SocialList;
    /** the student, for their own lists; null for a public account's list, which is shared */
    owner: string | null;
    readBy: string;
    now: Date;
    /** the count on the profile, when known */
    total?: number;
    /** store the profile fields the page carries (the student's own lists: these are their circle) */
    keepAccounts?: boolean;
  },
): Promise<PageResult> {
  const platform = adapter.platform;
  let row = await getListRead(db, platform, o.accountId, o.list, o.owner);
  if (!row || row.ended) {
    const expires = new Date(o.now.getTime() + GRAPH_KEEP_MS);
    await db.sql`
      insert into orbit.social_list_reads (platform, account_id, list, owner_user_id, read_by, rows_read, total, ended,
                                           cursor, read_at, expires_at)
      values (${platform}, ${o.accountId}, ${o.list}, ${o.owner}::uuid, ${o.readBy}::uuid, 0, ${o.total ?? null}::int,
              false, null, ${o.now}::timestamptz, ${expires}::timestamptz)
      on conflict (platform, account_id, list, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set read_by = excluded.read_by, rows_read = 0, total = coalesce(excluded.total, orbit.social_list_reads.total),
                    ended = false, cursor = null, read_at = excluded.read_at, expires_at = excluded.expires_at`;
    row = {
      rows_read: 0,
      total: o.total ?? row?.total ?? null,
      ended: false,
      cursor: null,
      read_at: o.now,
      read_by: o.readBy,
    };
  }
  const page = await adapter.listPage(o.accountId, o.list, row.cursor ?? undefined);
  const blocked = await suppressedOf(db, platform, page.ids);
  const ids = page.ids.filter((id) => !blocked.has(id));
  const accounts = (page.accounts ?? []).filter((a) => !blocked.has(a.id));
  await storeFollows(db, platform, followRows(o.accountId, o.list, ids), { owner: o.owner, now: o.now });
  if (o.keepAccounts) await upsertAccounts(db, accounts, { full: false, now: o.now });
  const ended = !page.cursor;
  const total = page.total ?? o.total ?? row.total ?? null;
  const rowsRead = row.rows_read + page.ids.length;
  await db.sql`
    update orbit.social_list_reads
       set rows_read = ${rowsRead}::int, cursor = ${page.cursor ?? null}, ended = ${ended},
           total = ${total}::int, read_by = ${o.readBy}::uuid
     where platform = ${platform} and account_id = ${o.accountId} and list = ${o.list}
       and coalesce(owner_user_id, ${NO_OWNER}::uuid) = coalesce(${o.owner}::uuid, ${NO_OWNER}::uuid)`;
  const complete =
    ended &&
    listComplete({ ids: { size: rowsRead } as ReadonlySet<string>, ended, total: total ?? undefined });
  if (complete) {
    // the follows this complete read did not see again are gone (an unfollow)
    const start = new Date(row.read_at);
    if (o.list === 'followers')
      await db.sql`
        delete from orbit.social_follows
         where platform = ${platform} and followed_id = ${o.accountId} and seen_at < ${start}::timestamptz
           and coalesce(owner_user_id, ${NO_OWNER}::uuid) = coalesce(${o.owner}::uuid, ${NO_OWNER}::uuid)`;
    else
      await db.sql`
        delete from orbit.social_follows
         where platform = ${platform} and follower_id = ${o.accountId} and seen_at < ${start}::timestamptz
           and coalesce(owner_user_id, ${NO_OWNER}::uuid) = coalesce(${o.owner}::uuid, ${NO_OWNER}::uuid)`;
  }
  return { ended, complete, ids, accounts };
}

/** A set whose size is the count the read reported, for lists Orbit only needs to ask one question of. */
export class CountedSet extends Set<string> {
  constructor(
    items: Iterable<string>,
    private readonly n: number,
  ) {
    super(items);
  }
  override get size() {
    return Math.max(this.n, super.size);
  }
}

/**
 * One list as a lookup may use it. A list read to the end recently answers as it is; one read long ago, or a read in
 * progress, counts only the rows seen since the read started (an older "yes" is not trusted until seen again).
 * `only` narrows the rows loaded to the ones the caller asks about (a candidate's list is only ever asked about the
 * target); the size is still the read's count.
 */
export async function loadListRead(
  db: Db,
  platform: SocialPlatform,
  accountId: string,
  list: SocialList,
  o: { userId: string; now: Date; owner?: string | null; only?: string[]; freshMs?: number },
): Promise<ListRead | undefined> {
  const owner = o.owner ?? null;
  const row = await getListRead(db, platform, accountId, list, owner);
  if (!row) return undefined;
  const fresh = o.now.getTime() - new Date(row.read_at).getTime() <= (o.freshMs ?? LIST_FRESH_MS);
  const usable = row.ended && fresh;
  // a read that ended long ago says nothing until it is read again
  if (row.ended && !fresh)
    return { ids: new Set(), ended: false, ...(row.total != null ? { total: row.total } : {}) };
  const since = usable ? new Date(0) : new Date(row.read_at);
  const only = o.only ?? null;
  const rows =
    list === 'followers'
      ? await db.sql<{ id: string }>`
          select distinct follower_id as id from orbit.social_follows
           where platform = ${platform} and followed_id = ${accountId} and seen_at >= ${since}::timestamptz
             and expires_at > now() and (owner_user_id is null or owner_user_id = ${o.userId}::uuid)
             and (${only}::text[] is null or follower_id = any(${only}::text[]))`
      : await db.sql<{ id: string }>`
          select distinct followed_id as id from orbit.social_follows
           where platform = ${platform} and follower_id = ${accountId} and seen_at >= ${since}::timestamptz
             and expires_at > now() and (owner_user_id is null or owner_user_id = ${o.userId}::uuid)
             and (${only}::text[] is null or followed_id = any(${only}::text[]))`;
  const ids = rows.map((r) => r.id);
  return {
    ids: only ? new CountedSet(ids, usable ? row.rows_read : 0) : new Set(ids),
    ended: usable,
    ...(row.total != null ? { total: row.total } : {}),
  };
}

/** Drops what is shared about an account that turned private or asked out: its lists, and the follows they held. */
export async function dropSharedLists(db: Db, platform: SocialPlatform, accountId: string): Promise<void> {
  await db.sql`
    delete from orbit.social_list_reads
     where platform = ${platform} and account_id = ${accountId} and owner_user_id is null`;
  await db.sql`
    delete from orbit.social_follows
     where platform = ${platform} and owner_user_id is null and (followed_id = ${accountId} or follower_id = ${accountId})`;
}
