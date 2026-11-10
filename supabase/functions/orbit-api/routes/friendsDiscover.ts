/**
 * Finding friends (plan 37 follow-up): who on Orbit the student may know, who in their People is worth inviting, a
 * search for someone they are looking for, a request by id, and one standing invite link for a group chat.
 *
 *   POST /friends/suggest              → FriendsSuggestResponse
 *   POST /friends/search {q}           → FriendsSearchResponse
 *   POST /friends/request {userId}     → FriendsRequestResponse
 *   POST /friends/link {reset?}        → FriendsLinkResponse
 *
 * Privacy: someone on Orbit is suggested, or found by name, only with a real tie to the student (in their contacts,
 * the student in theirs, a mutual friend, the same school or company); an exact email finds anyone, as the invite by
 * email always could. No address ever crosses: an invite to someone in the student's People names them by id.
 */
import type {
  FriendSuggestion,
  FriendsLinkResponse,
  FriendsRequestResponse,
  FriendsSearchResponse,
  FriendsSuggestResponse,
  InviteSuggestion,
} from '@orbit/core/server/api';
import { normalizeEmail } from '@orbit/core/text/normalize';
import { randomToken } from '../../_shared/crypto.ts';
import type { Db } from '../../_shared/db.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { iso } from '../../_shared/rows.ts';
import type { Ctx, Route } from '../api.ts';
import { body, uuid } from './body.ts';
import { nameOf, requestFriendship, userLite } from './friends.ts';

export const SUGGEST_ON_ORBIT = 30;
export const SUGGEST_TO_INVITE = 24;
export const SEARCH_RESULTS = 20;
/** A standing link lasts this long; reset makes a new one at once. */
export const LINK_DAYS = 90;
const DAY_MS = 86_400_000;

type Candidate = {
  id: string;
  full_name: string | null;
  first_name: string | null;
  email: string;
  avatar_url: string | null;
  school: string | null;
  grad_year: number | null;
  current_title: string | null;
  current_org: string | null;
  last_seen_at: Date | string | null;
  in_contacts: number | null;
  knows_me: boolean;
  mutual: number;
  same_school: boolean;
  near_year: boolean;
  same_org: boolean;
  connections: number;
  rel_status: string | null;
  requested_by: string | null;
  friendship_id: string | null;
};

/**
 * Everyone on Orbit except the student and their friends, with every tie to the student read in one statement. `tied`
 * keeps only those with at least one tie; `q` narrows by name, `email` to one exact address (which skips the tie test).
 */
async function candidates(
  db: Db,
  me: string,
  opts: { tied: boolean; q?: string; email?: string; limit: number },
): Promise<Candidate[]> {
  const pattern = opts.q ? `%${opts.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  return db.sql<Candidate>`
    with me as (
      select id, lower(email) as email, school_domain, lower(coalesce(school, '')) as school, grad_year,
             lower(coalesce(current_org, '')) as org
        from orbit.users where id = ${me}::uuid),
    rel as (
      select id, case when a = ${me}::uuid then b else a end as other, status, requested_by
        from orbit.friendships where a = ${me}::uuid or b = ${me}::uuid),
    my_friends as (select other from rel where status = 'active'),
    mine as (
      select pi.value_norm as email,
             max(coalesce(ts.score, round(coalesce(p.strength, 0) * 100)))::int as closeness
        from orbit.person_identities pi
        join orbit.people p on p.id = pi.person_id and p.deleted_at is null and p.merged_into is null
        left join orbit.tie_scores ts on ts.person_id = p.id and ts.user_id = p.user_id
       where pi.user_id = ${me}::uuid and pi.kind = 'email'
       group by 1),
    c as (
      select u.id, u.full_name, u.first_name, u.last_name, u.email, u.avatar_url, u.school, u.grad_year,
             u.current_title, u.current_org, u.last_seen_at,
             (select closeness from mine where mine.email = lower(u.email)) as in_contacts,
             exists (
               select 1 from orbit.person_identities pi2
                 join orbit.people p2 on p2.id = pi2.person_id and p2.deleted_at is null
                where pi2.user_id = u.id and pi2.kind = 'email' and pi2.value_norm = (select email from me)
             ) as knows_me,
             (select count(*) from orbit.friendships f
               where f.status = 'active' and (f.a = u.id or f.b = u.id)
                 and (case when f.a = u.id then f.b else f.a end) in (select other from my_friends))::int as mutual,
             ((select school_domain from me) is not null and u.school_domain = (select school_domain from me))
               or ((select school from me) <> '' and lower(coalesce(u.school, '')) = (select school from me))
               as same_school,
             (u.grad_year is not null and (select grad_year from me) is not null
               and abs(u.grad_year - (select grad_year from me)) <= 1) as near_year,
             ((select org from me) <> '' and lower(coalesce(u.current_org, '')) = (select org from me)) as same_org,
             (select count(*) from orbit.people p3
               where p3.user_id = u.id and p3.deleted_at is null and p3.merged_into is null
                 and not coalesce(p3.is_self, false))::int as connections,
             r.status as rel_status, r.requested_by, r.id as friendship_id
        from orbit.users u
        left join rel r on r.other = u.id
       where u.id <> ${me}::uuid and u.deleted_at is null
         and coalesce(r.status, '') not in ('active', 'blocked'))
    select * from c
     where (${opts.email ?? null}::text is null or lower(c.email) = ${opts.email ?? null}::text)
       and (${pattern}::text is null
            or lower(coalesce(c.full_name, '')) like ${pattern}::text
            or lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) like ${pattern}::text)
       and (not ${opts.tied}::boolean
            or c.in_contacts is not null or c.knows_me or c.mutual > 0 or c.same_school or c.same_org)
     limit ${opts.limit * 4}`;
}

/** How strongly the student is likely to know them, from the ties, plus a little for being active lately. */
export function tieScore(c: Candidate, now: Date): number {
  let s = 0;
  if (c.in_contacts !== null) s += 5 + Math.min(4, Math.max(0, c.in_contacts) / 25);
  if (c.knows_me) s += 3;
  s += 2 * Math.min(3, c.mutual);
  if (c.same_school) s += c.near_year ? 3 : 2;
  if (c.same_org) s += 1;
  const seen = c.last_seen_at ? new Date(c.last_seen_at).getTime() : 0;
  if (seen && now.getTime() - seen < 14 * DAY_MS) s += 0.5;
  return s;
}

const yy = (y: number | null) => (y ? ` '${String(y).slice(-2)}` : '');

/** The one reason the card shows, the strongest tie first. */
export function reasonFor(c: Candidate): string {
  if (c.in_contacts !== null) return c.in_contacts >= 60 ? 'You know them well' : 'In your contacts';
  if (c.mutual > 0) return c.mutual === 1 ? '1 mutual friend' : `${c.mutual} mutual friends`;
  if (c.knows_me) return 'Has you in their network';
  if (c.same_school && c.school) return `${c.school}${yy(c.grad_year)}`;
  if (c.same_org && c.current_org) return `Also at ${c.current_org}`;
  return 'On Orbit';
}

function view(c: Candidate, me: string): FriendSuggestion {
  const headline =
    c.current_title && c.current_org
      ? `${c.current_title} at ${c.current_org}`
      : c.current_org || (c.school ? `${c.school}${yy(c.grad_year)}` : null);
  const pending = c.rel_status === 'pending';
  const reason = reasonFor(c);
  return {
    userId: c.id,
    name: nameOf(c),
    avatarUrl: c.avatar_url,
    // the reason and the headline are never the same words twice ("Cornell '26" under "Cornell '26")
    headline: headline === reason ? null : headline,
    connections: c.connections,
    reason,
    state: !pending ? 'none' : c.requested_by === me ? 'requested' : 'incoming',
    ...(pending && c.requested_by !== me && c.friendship_id ? { friendshipId: c.friendship_id } : {}),
  };
}

type InviteRow = {
  id: string;
  display_name: string;
  photo_url: string | null;
  title: string | null;
  org_raw: string | null;
  is_alumni: boolean | null;
  relationship_type: string | null;
  last_interaction_at: Date | string | null;
  closeness: number | null;
};

/** Why someone in the student's People is worth inviting, in a few words. */
export function inviteReason(r: InviteRow, school: string | null, now: Date): string {
  const days = r.last_interaction_at
    ? (now.getTime() - new Date(r.last_interaction_at).getTime()) / DAY_MS
    : null;
  if ((r.closeness ?? 0) >= 60) return 'You know them well';
  if (r.is_alumni && school) return `${school} alum`;
  if (days !== null && days <= 45) return 'You talked recently';
  return 'In your People';
}

/** People the student knows who are not on Orbit and have an address, closest first: the ones a pooled network gains. */
async function toInvite(db: Db, me: string, school: string | null, now: Date): Promise<InviteSuggestion[]> {
  const rows = await db.sql<InviteRow>`
    select p.id, p.display_name, p.photo_url, p.title, p.org_raw, p.is_alumni, p.relationship_type,
           p.last_interaction_at,
           coalesce(ts.score, round(coalesce(p.strength, 0) * 100))::int as closeness
      from orbit.people p
      left join (select person_id, max(score) as score from orbit.tie_scores
                  where user_id = ${me}::uuid group by 1) ts on ts.person_id = p.id
     where p.user_id = ${me}::uuid and p.deleted_at is null and p.merged_into is null and p.hidden_at is null
       and not p.do_not_contact and not coalesce(p.is_self, false) and not coalesce(p.private, false)
       and p.primary_email is not null
       and coalesce(p.relationship_type, '') <> 'recruiter'
       and not exists (select 1 from orbit.users u where lower(u.email) = lower(p.primary_email) and u.deleted_at is null)
       and not exists (select 1 from orbit.friend_invites fi
                        where fi.from_user_id = ${me}::uuid and fi.status = 'pending'
                          and fi.to_email = lower(p.primary_email))
     order by closeness desc nulls last, p.last_interaction_at desc nulls last
     limit ${SUGGEST_TO_INVITE * 3}`;
  const score = (r: InviteRow) => {
    const days = r.last_interaction_at
      ? (now.getTime() - new Date(r.last_interaction_at).getTime()) / DAY_MS
      : Number.POSITIVE_INFINITY;
    return (
      (r.closeness ?? 0) +
      (r.is_alumni ? 15 : 0) +
      (['peer', 'classmate', 'friend', 'family_friend', 'colleague'].includes(r.relationship_type ?? '')
        ? 10
        : 0) +
      (days <= 60 ? 10 : 0)
    );
  };
  return rows
    .filter((r) => (r.closeness ?? 0) >= 20 || r.is_alumni)
    .sort((a, b) => score(b) - score(a))
    .slice(0, SUGGEST_TO_INVITE)
    .map((r) => ({
      personId: r.id,
      name: r.display_name,
      photoUrl: r.photo_url,
      headline: r.title && r.org_raw ? `${r.title} at ${r.org_raw}` : (r.org_raw ?? r.title),
      reason: inviteReason(r, school, now),
    }));
}

async function suggest(ctx: Ctx): Promise<Response> {
  const me = ctx.userId!;
  const now = ctx.now();
  const u = await userLite(ctx.db, me);
  const found = await candidates(ctx.db, me, { tied: true, limit: SUGGEST_ON_ORBIT });
  // someone who already asked the student is under Requests, not suggested again beside it
  const onOrbit = found
    .filter((c) => !(c.rel_status === 'pending' && c.requested_by !== me))
    .map((c) => ({ c, s: tieScore(c, now) }))
    .sort((a, b) => b.s - a.s || b.c.connections - a.c.connections)
    .slice(0, SUGGEST_ON_ORBIT)
    .map(({ c }) => view(c, me));
  const out: FriendsSuggestResponse = { onOrbit, toInvite: await toInvite(ctx.db, me, u.school, now) };
  return json(200, out);
}

async function search(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const me = ctx.userId!;
  const now = ctx.now();
  const q = typeof b.q === 'string' ? b.q.trim().replace(/\s+/g, ' ') : '';
  if (q.length < 2) throw badRequest('type at least two letters');
  if (q.length > 120) throw badRequest('that is too long to search for');
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q) ? normalizeEmail(q) : undefined;
  const found = email
    ? await candidates(ctx.db, me, { tied: false, email, limit: 1 })
    : await candidates(ctx.db, me, { tied: true, q, limit: SEARCH_RESULTS });
  const results = found
    .map((c) => ({ c, s: tieScore(c, now) }))
    .sort((a, b) => b.s - a.s || nameOf(a.c).localeCompare(nameOf(b.c)))
    .slice(0, SEARCH_RESULTS)
    .map(({ c }) => view(c, me));
  const out: FriendsSearchResponse = { results };
  return json(200, out);
}

async function request(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const me = ctx.userId!;
  const otherId = uuid(b, 'userId');
  const db = ctx.db;
  const [other] = await db.sql<{
    id: string;
    email: string;
    full_name: string | null;
    first_name: string | null;
  }>`
    select id, email, full_name, first_name from orbit.users where id = ${otherId}::uuid and deleted_at is null`;
  if (!other) throw new HttpError(404, 'not_found', 'no such person on Orbit');
  // an id reaches the browser only in suggestions and search results, which hold only people with a tie or an exact
  // address the student typed
  const u = await userLite(db, me);
  const friendshipId = await requestFriendship(db, u, other.id, ctx.now());
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${me}::uuid, 'user', 'friends.request', 'friendships', ${friendshipId}, ${{}}::jsonb)`;
  const out: FriendsRequestResponse = { friendshipId, name: nameOf(other) };
  return json(200, out);
}

async function link(ctx: Ctx): Promise<Response> {
  const b = await body(ctx, true);
  const me = ctx.userId!;
  const now = ctx.now();
  const db = ctx.db;
  if (b.reset === true)
    await db.sql`
      update orbit.friend_invites set status = 'revoked', answered_at = ${now}::timestamptz
       where from_user_id = ${me}::uuid and to_email is null and status = 'pending'`;
  // the link already out, while it has more than a day left
  const [open] = await db.sql<{ code: string; expires_at: Date | string }>`
    select code, expires_at from orbit.friend_invites
     where from_user_id = ${me}::uuid and to_email is null and status = 'pending'
       and expires_at > ${new Date(now.getTime() + DAY_MS)}::timestamptz
     order by created_at desc limit 1`;
  let code = open?.code;
  let expires = open ? new Date(open.expires_at) : undefined;
  if (!code) {
    code = '';
    while (code.length < 22) code += randomToken(24).replace(/[^A-Za-z0-9]/g, '');
    code = code.slice(0, 22);
    expires = new Date(now.getTime() + LINK_DAYS * DAY_MS);
    await db.sql`
      insert into orbit.friend_invites (from_user_id, to_email, code, status, created_at, expires_at)
      values (${me}::uuid, null, ${code}, 'pending', ${now}::timestamptz, ${expires}::timestamptz)`;
  }
  const out: FriendsLinkResponse = {
    code,
    link: `${ctx.env.appUrl}/friends/join/${code}`,
    expiresAt: iso(expires!)!,
  };
  return json(200, out);
}

export const friendDiscoverRoutes: Record<string, Route> = {
  '/friends/suggest': { method: 'GET|POST', auth: true, run: suggest },
  '/friends/search': { method: 'POST', auth: true, run: search },
  '/friends/request': { method: 'POST', auth: true, run: request },
  '/friends/link': { method: 'POST', auth: true, run: link },
};
