/**
 * Friends (plan 29 Part A): the projection an owner's side rebuilds for their friends, the identity join that puts a
 * friend's person next to the viewer's own row for the same human (§A2.6), and what a friend may see of a row.
 *
 * The projection holds signal, never content: name, title, company, the public LinkedIn slug, school, whether the
 * person is the owner's alum, and a closeness word cut from tie_scores.share_score (the tie score with every
 * Google-derived feature zeroed, core shareScore). The join keys (member id, slug, a hash of the address) stay on the
 * server; the address itself is never stored here and never leaves.
 */
import { shareCloseness, TIE_LABEL_MIDPOINTS } from '@orbit/core/scoring/tieScore';
import type { FriendCloseness, FriendShare, FriendShareMode } from '@orbit/core/server/api';
import { normalizeCompany, normalizeEmail } from '@orbit/core/text/normalize';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { NO_SOURCES, type SourcesInUse } from '../sources/states.ts';

/** The join key for an address: a hash of the normalized email, never the address. */
export function emailHash(email: string): Promise<string> {
  return sha256Hex(`orbit-friend:${normalizeEmail(email)}`);
}

/** One projection row as the table holds it. */
export type ShareRow = {
  owner_user_id: string;
  person_id: string;
  display_name: string;
  title: string | null;
  company: string | null;
  company_domain: string | null;
  linkedin_member_id: string | null;
  linkedin_slug: string | null;
  email_hash: string | null;
  school: string | null;
  is_alumni: boolean;
  closeness: number;
  updated_at?: Date | string;
};

/** What a friend may read of a row (plan 29 §A1): never a join key beyond the public slug. */
export function publicShare(r: ShareRow): FriendShare {
  return {
    personId: r.person_id,
    displayName: r.display_name,
    title: r.title,
    company: r.company,
    companyDomain: r.company_domain,
    linkedinSlug: r.linkedin_slug,
    school: r.school,
    isAlumni: r.is_alumni,
    closeness: Math.max(1, Math.min(3, Number(r.closeness))) as FriendCloseness,
  };
}

/** The rows an owner's mode lets a friend see: all, only those at the chosen companies, or none. */
export function underMode<T extends { company: string | null; company_domain: string | null }>(
  rows: T[],
  mode: FriendShareMode,
  domains: readonly string[],
): T[] {
  if (mode === 'none') return [];
  if (mode === 'all') return rows;
  const want = new Set(domains.map((d) => d.toLowerCase().trim()).filter(Boolean));
  const names = new Set([...want].map((d) => normalizeCompany(d.replace(/\.[a-z]+$/, ''))).filter(Boolean));
  return rows.filter(
    (r) =>
      (r.company_domain && want.has(r.company_domain.toLowerCase())) ||
      (r.company && names.has(normalizeCompany(r.company))),
  );
}

/**
 * Rebuild one owner's projection in a single transaction (plan 29 §A4): every person they have who may be shared, with
 * the closeness word from share_score (the label's midpoint stands in until the scorer has run). Private, hidden and
 * do-not-contact people, merged or deleted rows and anyone with nothing to join on are left out; the database's own
 * guard refuses them too. Plan 43: so are people not listed (made from an account, no real exchange yet), and people
 * known only from an optional source the owner has out of use.
 */
export async function refreshFriendShares(
  db: Db,
  ownerId: string,
  now: Date,
  src: SourcesInUse = NO_SOURCES,
): Promise<number> {
  const rows = await db.sql<{
    id: string;
    display_name: string;
    title: string | null;
    headline: string | null;
    org_raw: string | null;
    org_name: string | null;
    domains: string[] | null;
    school: string | null;
    is_alumni: boolean;
    linkedin_member_id: string | null;
    linkedin_slug: string | null;
    primary_email: string | null;
    share_score: number | null;
    label: number | null;
  }>`
    select p.id, p.display_name, p.title, p.headline, p.org_raw, o.name as org_name, o.domains, p.school, p.is_alumni,
           p.linkedin_member_id, p.linkedin_slug, p.primary_email, ts.share_score::int as share_score,
           tl.closeness::int as label
      from orbit.people p
      left join orbit.organizations o on o.id = p.org_id
      left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
      left join orbit.tie_labels tl on tl.user_id = p.user_id and tl.person_id = p.id
     where p.user_id = ${ownerId}::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
       and p.hidden_at is null and not p.do_not_contact and not p.private and p.listed
       and orbit.person_in_use(p.sources, p.source_account, ${src.hidden}::text[])`;
  const identities = await db.sql<{ person_id: string; kind: string; value_norm: string }>`
    select person_id, kind, value_norm from orbit.person_identities
     where user_id = ${ownerId}::uuid and kind in ('email', 'linkedin_member', 'linkedin_slug')`;
  const byPerson = new Map<string, { email?: string; member?: string; slug?: string }>();
  for (const i of identities) {
    const cur = byPerson.get(i.person_id) ?? {};
    if (i.kind === 'email' && !cur.email) cur.email = i.value_norm;
    if (i.kind === 'linkedin_member' && !cur.member) cur.member = i.value_norm;
    if (i.kind === 'linkedin_slug' && !cur.slug) cur.slug = i.value_norm;
    byPerson.set(i.person_id, cur);
  }
  const out: ShareRow[] = [];
  for (const r of rows) {
    const ids = byPerson.get(r.id) ?? {};
    const member = r.linkedin_member_id ?? ids.member ?? null;
    const slug = (r.linkedin_slug ?? ids.slug)?.toLowerCase() ?? null;
    const email = r.primary_email ?? ids.email;
    const hash = email?.includes('@') ? await emailHash(email) : null;
    if (!member && !slug && !hash) continue;
    const closeness: FriendCloseness =
      r.share_score !== null
        ? shareCloseness(r.share_score)
        : r.label && TIE_LABEL_MIDPOINTS[r.label] !== undefined
          ? shareCloseness(TIE_LABEL_MIDPOINTS[r.label]!)
          : 1;
    out.push({
      owner_user_id: ownerId,
      person_id: r.id,
      display_name: r.display_name,
      title: r.title ?? r.headline ?? null,
      company: r.org_name ?? r.org_raw ?? null,
      company_domain: r.domains?.[0]?.toLowerCase() ?? null,
      linkedin_member_id: member,
      linkedin_slug: slug,
      email_hash: hash,
      school: r.school ?? null,
      is_alumni: !!r.is_alumni,
      closeness,
    });
  }
  await db.begin(async (tx) => {
    await tx.sql`delete from orbit.friend_shares where owner_user_id = ${ownerId}::uuid`;
    for (let i = 0; i < out.length; i += 500) {
      const json = JSON.stringify(out.slice(i, i + 500));
      await tx.sql`
        insert into orbit.friend_shares (owner_user_id, person_id, display_name, title, company, company_domain,
                                         linkedin_member_id, linkedin_slug, email_hash, school, is_alumni, closeness,
                                         updated_at)
        select ${ownerId}::uuid, (r ->> 'person_id')::uuid, r ->> 'display_name', r ->> 'title', r ->> 'company',
               r ->> 'company_domain', r ->> 'linkedin_member_id', r ->> 'linkedin_slug', r ->> 'email_hash',
               r ->> 'school', (r ->> 'is_alumni')::boolean, (r ->> 'closeness')::smallint, ${now}::timestamptz
          from jsonb_array_elements(${json}::jsonb) r`;
    }
  });
  return out.length;
}

/**
 * The dedupe key for one owner's refresh after one event. orbit.enqueue drops a key that ran in the last 24 hours, so
 * a fixed key let one refresh a day through and a later accept or a new backfill waited for the nightly run. The
 * events are rare (an accept, a settings change, a full re-score), so each gets its own key.
 */
export function shareRefreshKey(ownerId: string, now: Date, why = 'change'): string {
  return `friends:refresh:${ownerId}:${why}:${now.getTime()}`;
}

/** Whether the owner has an active friend, the only case where their projection is read. */
export async function hasActiveFriend(db: Db, ownerId: string): Promise<boolean> {
  const [r] = await db.sql<{ ok: boolean }>`
    select exists (select 1 from orbit.friendships f
                    where f.status = 'active' and (f.a = ${ownerId}::uuid or f.b = ${ownerId}::uuid)) as ok`;
  return !!r?.ok;
}

/** A friend who shares with the viewer, with what they share. */
export interface SharingFriend {
  friendshipId: string;
  userId: string;
  name: string;
  firstName: string;
  mode: FriendShareMode;
  domains: string[];
}

/** The viewer's active friends whose side shares something: the only people whose projection the viewer may read. */
export async function sharingFriends(db: Db, viewerId: string): Promise<SharingFriend[]> {
  const rows = await db.sql<{
    friendship_id: string;
    user_id: string;
    full_name: string | null;
    first_name: string | null;
    email: string;
    mode: FriendShareMode;
    company_domains: string[];
  }>`
    select f.id as friendship_id, u.id as user_id, u.full_name, u.first_name, u.email, s.mode, s.company_domains
      from orbit.friendships f
      join orbit.users u on u.id = case when f.a = ${viewerId}::uuid then f.b else f.a end
      join orbit.friend_share_settings s on s.friendship_id = f.id and s.owner_user_id = u.id
     where f.status = 'active' and (f.a = ${viewerId}::uuid or f.b = ${viewerId}::uuid)
       and s.mode <> 'none' and u.deleted_at is null`;
  return rows.map((r) => {
    const name = r.full_name?.trim() || r.first_name?.trim() || r.email.split('@')[0]!;
    return {
      friendshipId: r.friendship_id,
      userId: r.user_id,
      name,
      firstName: r.first_name?.trim() || name.split(/\s+/)[0]!,
      mode: r.mode,
      domains: r.company_domains ?? [],
    };
  });
}

/** The rows one friend lets the viewer see (the friend's own mode applied). Checks nothing: call after friend_visible. */
export async function visibleShares(db: Db, friend: SharingFriend): Promise<ShareRow[]> {
  const rows = await db.sql<ShareRow>`
    select owner_user_id, person_id, display_name, title, company, company_domain, linkedin_member_id,
           linkedin_slug, email_hash, school, is_alumni, closeness::int as closeness, updated_at
      from orbit.friend_shares where owner_user_id = ${friend.userId}::uuid
     order by display_name`;
  return underMode(rows, friend.mode, friend.domains);
}

/**
 * The identity join (plan 29 §A2.6): a friend's shared person matched to the viewer's own row for the same human by
 * LinkedIn member id, then slug, then the hashed address, then an exact name at the same company. Returns the
 * viewer's person id per shared person id, for the shares that match.
 */
export async function matchShares(
  db: Db,
  viewerId: string,
  shares: readonly Pick<
    ShareRow,
    'person_id' | 'display_name' | 'company' | 'linkedin_member_id' | 'linkedin_slug' | 'email_hash'
  >[],
  hidden: readonly string[] = NO_SOURCES.hidden,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!shares.length) return out;
  const people = await db.sql<{
    id: string;
    display_name: string;
    org_raw: string | null;
    org_name: string | null;
    linkedin_member_id: string | null;
    linkedin_slug: string | null;
    primary_email: string | null;
  }>`
    select p.id, p.display_name, p.org_raw, o.name as org_name, p.linkedin_member_id, p.linkedin_slug, p.primary_email
      from orbit.people p left join orbit.organizations o on o.id = p.org_id
     where p.user_id = ${viewerId}::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
       and orbit.person_in_use(p.sources, p.source_account, ${[...hidden]}::text[])`;
  const identities = await db.sql<{ person_id: string; kind: string; value_norm: string }>`
    select i.person_id, i.kind, i.value_norm from orbit.person_identities i
     where i.user_id = ${viewerId}::uuid and i.kind in ('email', 'linkedin_member', 'linkedin_slug')
       and not exists (select 1 from orbit.people q where q.id = i.person_id
                        and not orbit.person_in_use(q.sources, q.source_account, ${[...hidden]}::text[]))`;
  const byMember = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const emails = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const p of people) {
    if (p.linkedin_member_id) byMember.set(p.linkedin_member_id, p.id);
    if (p.linkedin_slug) bySlug.set(p.linkedin_slug.toLowerCase(), p.id);
    if (p.primary_email?.includes('@')) emails.set(normalizeEmail(p.primary_email), p.id);
    const key = `${p.display_name.trim().toLowerCase()}|${normalizeCompany(p.org_name ?? p.org_raw)}`;
    byName.set(key, [...(byName.get(key) ?? []), p.id]);
  }
  for (const i of identities) {
    if (i.kind === 'linkedin_member' && !byMember.has(i.value_norm)) byMember.set(i.value_norm, i.person_id);
    if (i.kind === 'linkedin_slug' && !bySlug.has(i.value_norm.toLowerCase()))
      bySlug.set(i.value_norm.toLowerCase(), i.person_id);
    if (i.kind === 'email' && !emails.has(i.value_norm)) emails.set(i.value_norm, i.person_id);
  }
  // hashes only for the addresses the shares carry: one pass over the viewer's addresses
  const wanted = new Set(shares.map((s) => s.email_hash).filter((h): h is string => !!h));
  const byHash = new Map<string, string>();
  if (wanted.size)
    for (const [email, id] of emails) {
      const h = await emailHash(email);
      if (wanted.has(h) && !byHash.has(h)) byHash.set(h, id);
    }
  for (const s of shares) {
    const hit =
      (s.linkedin_member_id && byMember.get(s.linkedin_member_id)) ||
      (s.linkedin_slug && bySlug.get(s.linkedin_slug.toLowerCase())) ||
      (s.email_hash && byHash.get(s.email_hash)) ||
      (() => {
        if (!s.company) return undefined;
        const ids = byName.get(`${s.display_name.trim().toLowerCase()}|${normalizeCompany(s.company)}`);
        return ids?.length === 1 ? ids[0] : undefined;
      })();
    if (hit) out.set(s.person_id, hit);
  }
  return out;
}

/** The hop chance a closeness word stands for (plan 29 §A4): the HOP_WEIGHTS scale of ties.ts. */
export const CLOSENESS_P: Record<FriendCloseness, number> = { 1: 0.35, 2: 0.6, 3: 0.85 };
/** How a friend's closeness reads in a route: "knows Dan", "knows Dan well", "is close to Dan". */
export function closenessPhrase(closeness: FriendCloseness, firstName: string): string {
  return closeness === 3
    ? `is close to ${firstName}`
    : closeness === 2
      ? `knows ${firstName} well`
      : `knows ${firstName}`;
}

/** A friend's user id as a route node, and back. */
export const friendNode = (userId: string) => `friend:${userId}`;
export const friendPersonNode = (personId: string) => `friend_person:${personId}`;
export const isFriendNode = (id: string) => id.startsWith('friend:');
