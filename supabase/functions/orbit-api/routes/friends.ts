/**
 * Friends (plan 29 Part A, §A4): two Orbit users pool their networks as signal, never content.
 *   POST /friends/invite {email?}                → {code, link, status, invite}: a request to someone on Orbit, an
 *                                                  emailed sign-in link to someone not on it (when a mailer is set),
 *                                                  or a link to copy
 *   POST /friends/accept {code | friendshipId, mode, companyDomains?}
 *                                                → the friendship goes active; the acceptor's side shares in `mode`
 *   POST /friends/decline {code | friendshipId}
 *   POST /friends/end {friendshipId}             → visibility ends both ways in the same statement
 *   GET|POST /friends                            → the friends with their counts, and what is pending either way
 *   POST /friends/settings {friendshipId?, mode, companyDomains?}
 *                                                → what the student shares back, with one friend or with all
 *   GET|POST /friends/preview { friendshipId? }  → the student's own projection, row for row as a friend (or one friend) sees it
 *   GET /friends/shares/:friendUserId?company=   → a friend's projection, paged (also POST /friends/shares {friendUserId})
 *   POST /friends/asks {friendUserId, targetPersonId, note}
 *                                                → an intro asked of the friend; the friend's next list shows it
 *   GET|POST /friends/asks                       → asked and received
 *   POST /friends/asks/:id/respond {action, body?} (also POST /friends/asks/respond {id, ...})
 *                                                → forward makes the forward_intro draft on the friend's side, cc the
 *                                                  asker; decline closes it
 * Every read of a friend's rows goes through orbit.friend_visible; every write checks the friendship. Rate limits:
 * 20 invites a day, 10 asks a day per friendship (counted from the rows, so they hold across isolates).
 */
import type {
  Friend,
  FriendAskRespondResponse,
  FriendAskResponse,
  FriendAsksResponse,
  FriendIntroAsk,
  FriendInvite,
  FriendPreviewResponse,
  FriendShareMode,
  FriendSharesResponse,
  FriendsAcceptResponse,
  FriendsInviteResponse,
  FriendsListResponse,
  FriendsSettingsResponse,
} from '@orbit/core/server/api';
import { normalizeEmail } from '@orbit/core/text/normalize';
import { toServerDraft } from '../../_shared/compose/drafts.ts';
import { randomToken } from '../../_shared/crypto.ts';
import type { Db } from '../../_shared/db.ts';
import { forwardBody, forwardSubject } from '../../_shared/friends/forward.ts';
import {
  matchShares,
  publicShare,
  type ShareRow,
  type SharingFriend,
  shareRefreshKey,
  sharingFriends,
  underMode,
  visibleShares,
} from '../../_shared/friends/shares.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { settleCard } from '../../_shared/replies/cards.ts';
import { iso } from '../../_shared/rows.ts';
import { linkedinSend } from '../../_shared/sending/transport.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, text, uuid } from './body.ts';

export const INVITES_PER_DAY = 20;
export const ASKS_PER_DAY_PER_FRIEND = 10;
export const INVITE_DAYS = 14;
export const SHARES_PAGE = 50;
const MODES: FriendShareMode[] = ['all', 'companies', 'none'];
const DAY_MS = 86_400_000;

const forbidden = () => new HttpError(403, 'forbidden', 'not a friend who shares with you');

function modeOf(b: Record<string, unknown>, required = true): FriendShareMode | undefined {
  const m = b.mode;
  if (m === undefined && !required) return undefined;
  if (typeof m !== 'string' || !MODES.includes(m as FriendShareMode))
    throw badRequest('mode is all, companies or none');
  return m as FriendShareMode;
}

function domainsOf(b: Record<string, unknown>): string[] {
  const v = b.companyDomains;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((d) => typeof d !== 'string')) throw badRequest('companyDomains is a list');
  return [...new Set((v as string[]).map((d) => d.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

/** A 22 character code for the link: base64url of 16 random bytes, letters and digits only. */
function inviteCode(): string {
  let code = '';
  while (code.length < 22) code += randomToken(24).replace(/[^A-Za-z0-9]/g, '');
  return code.slice(0, 22);
}

export type UserLite = {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  school: string | null;
  grad_year: number | null;
  avatar_url: string | null;
  settings: Record<string, unknown>;
};

export async function userLite(db: Db, userId: string): Promise<UserLite> {
  const [u] = await db.sql<UserLite>`
    select id, email, full_name, first_name, school, grad_year, avatar_url, settings
      from orbit.users where id = ${userId}::uuid and deleted_at is null`;
  if (!u) throw new HttpError(401, 'unauthorized', 'sign in again');
  return { ...u, settings: u.settings ?? {} };
}

export const nameOf = (u: Pick<UserLite, 'full_name' | 'first_name' | 'email'>) =>
  u.full_name?.trim() || u.first_name?.trim() || u.email.split('@')[0]!;
const firstOf = (u: Pick<UserLite, 'full_name' | 'first_name' | 'email'>) =>
  u.first_name?.trim() || nameOf(u).split(/\s+/)[0]!;

/** The student's default for what they share with a new friend: everyone, unless they chose otherwise. */
function defaultMode(u: UserLite): { mode: FriendShareMode; domains: string[] } {
  const m = u.settings.friend_share_mode;
  const d = u.settings.friend_share_domains;
  return {
    mode: typeof m === 'string' && MODES.includes(m as FriendShareMode) ? (m as FriendShareMode) : 'all',
    domains: Array.isArray(d) ? (d as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}

async function enqueueRefresh(ctx: Ctx, userIds: string[]) {
  const q = ctx.services().queue;
  for (const id of new Set(userIds))
    await q
      .enqueue({
        kind: 'friend_shares_refresh',
        userId: id,
        payload: {},
        dedupeKey: shareRefreshKey(id, ctx.now()),
      })
      .catch(() => undefined);
}

async function logAudit(ctx: Ctx, action: string, table: string, targetId: string, details: unknown) {
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${ctx.userId!}::uuid, 'user', ${action}, ${table}, ${targetId}, ${details}::jsonb)`;
}

// ---- the list and its counts -------------------------------------------------------------------------------------

type FriendshipRow = {
  id: string;
  a: string;
  b: string;
  status: string;
  requested_by: string;
  created_at: Date | string;
  accepted_at: Date | string | null;
};

/** The student's target company names, lowercased, from their active goals (the "at your targets" count). */
async function targetNames(db: Db, userId: string): Promise<string[]> {
  const goals = await db.sql<{ targets: { organizations?: string[] } | null }>`
    select targets from orbit.goals where user_id = ${userId}::uuid and status = 'active' and deleted_at is null`;
  const out: string[] = [];
  for (const g of goals) for (const o of g.targets?.organizations ?? []) if (!out.includes(o)) out.push(o);
  return out;
}

/** Where a friend's name leads: the student's own record of them (matched by their address), else their LinkedIn. */
async function friendLinks(
  db: Db,
  me: string,
  otherId: string,
): Promise<{ personId?: string; linkedinUrl?: string }> {
  const [r] = await db.sql<{ person_id: string | null; linkedin_url: string | null }>`
    with mine as (
      select p.id::text as person_id, p.linkedin_url
        from orbit.person_identities pi
        join orbit.people p on p.id = pi.person_id and p.deleted_at is null and p.merged_into is null
       where pi.user_id = ${me}::uuid and pi.kind = 'email'
         and pi.value_norm = (select lower(email) from orbit.users where id = ${otherId}::uuid)
       order by p.updated_at desc limit 1)
    select (select person_id from mine) as person_id,
           coalesce((select linkedin_url from mine),
                    (select p.linkedin_url from orbit.people p
                      where p.user_id = ${otherId}::uuid and p.is_self and p.deleted_at is null
                        and p.linkedin_url is not null limit 1)) as linkedin_url`;
  return {
    ...(r?.person_id ? { personId: r.person_id } : {}),
    ...(r?.linkedin_url ? { linkedinUrl: r.linkedin_url } : {}),
  };
}

async function friendView(db: Db, me: string, f: FriendshipRow, targets: string[]): Promise<Friend> {
  const otherId = f.a === me ? f.b : f.a;
  const other = await userLite(db, otherId);
  const [theirs] = await db.sql<{ mode: FriendShareMode; company_domains: string[] }>`
    select mode, company_domains from orbit.friend_share_settings
     where friendship_id = ${f.id}::uuid and owner_user_id = ${otherId}::uuid`;
  const [mine] = await db.sql<{ mode: FriendShareMode; company_domains: string[] }>`
    select mode, company_domains from orbit.friend_share_settings
     where friendship_id = ${f.id}::uuid and owner_user_id = ${me}::uuid`;
  const friend: SharingFriend = {
    friendshipId: f.id,
    userId: otherId,
    name: nameOf(other),
    firstName: firstOf(other),
    mode: theirs?.mode ?? 'none',
    domains: theirs?.company_domains ?? [],
  };
  const visible = friend.mode === 'none' ? [] : await visibleShares(db, friend);
  const lower = targets.map((t) => t.toLowerCase());
  const at = visible.filter((s) => s.company && lower.includes(s.company.toLowerCase()));
  const knowsAt = targets
    .map((company) => ({
      company,
      count: visible.filter((s) => s.company?.toLowerCase() === company.toLowerCase()).length,
    }))
    .filter((k) => k.count > 0);
  return {
    friendshipId: f.id,
    userId: otherId,
    name: friend.name,
    school: other.school,
    gradYear: other.grad_year,
    avatarUrl: other.avatar_url,
    shares: visible.length,
    atTargets: at.length,
    knowsAt,
    myMode: mine?.mode ?? 'none',
    myCompanyDomains: mine?.company_domains ?? [],
    since: iso(f.accepted_at ?? f.created_at)!,
    ...(await friendLinks(db, me, otherId)),
  };
}

async function list(ctx: Ctx): Promise<Response> {
  const db = ctx.db;
  const me = ctx.userId!;
  await db.sql`select orbit.expire_friend_asks()`;
  const rows = await db.sql<FriendshipRow>`
    select id, a, b, status, requested_by, created_at, accepted_at from orbit.friendships
     where (a = ${me}::uuid or b = ${me}::uuid) and status in ('active', 'pending') order by created_at`;
  const targets = await targetNames(db, me);
  const friends: Friend[] = [];
  const pending: FriendInvite[] = [];
  for (const f of rows) {
    if (f.status === 'active') friends.push(await friendView(db, me, f, targets));
    else if (f.requested_by !== me) {
      // a request waiting on the student: Accept or Decline
      const other = await userLite(db, f.a === me ? f.b : f.a);
      pending.push({
        id: f.id,
        direction: 'in',
        email: null,
        name: nameOf(other),
        status: 'pending',
        createdAt: iso(f.created_at)!,
      });
    } else {
      const other = await userLite(db, f.a === me ? f.b : f.a);
      pending.push({
        id: f.id,
        direction: 'out',
        email: null,
        name: nameOf(other),
        status: 'pending',
        createdAt: iso(f.created_at)!,
      });
    }
  }
  const invites = await db.sql<{
    id: string;
    to_email: string | null;
    status: FriendInvite['status'];
    created_at: Date;
  }>`
    select id, to_email, status, created_at from orbit.friend_invites
     where from_user_id = ${me}::uuid and status = 'pending' and to_email is not null
       and not exists (select 1 from orbit.users u where lower(u.email) = to_email and u.deleted_at is null)
     order by created_at`;
  for (const i of invites)
    pending.push({
      id: i.id,
      direction: 'out',
      email: i.to_email,
      name: null,
      status: i.status,
      createdAt: iso(i.created_at)!,
    });
  const out: FriendsListResponse = { friends, pending };
  return json(200, out);
}

// ---- invite, accept, decline, end -----------------------------------------------------------------------------------

interface MailLike {
  configured: boolean;
  send(m: { to: string; subject: string; text: string }): Promise<{ ok: boolean; error?: string }>;
}

/**
 * A friend request from `from` to someone already on Orbit, with the sender's side set to share as they chose. A
 * request already waiting is renewed; an active or blocked friendship is refused. Returns the friendship id.
 */
export async function requestFriendship(db: Db, from: UserLite, otherId: string, now: Date): Promise<string> {
  const me = from.id;
  if (otherId === me) throw badRequest('that is you');
  const [lo, hi] = me < otherId ? [me, otherId] : [otherId, me];
  const [existing] = await db.sql<{ id: string; status: string }>`
    select id, status from orbit.friendships where a = ${lo}::uuid and b = ${hi}::uuid`;
  if (existing?.status === 'active') throw new HttpError(409, 'already_friends', 'you are already friends');
  if (existing?.status === 'blocked') throw new HttpError(409, 'blocked', 'that request cannot be sent');
  const [f] = existing
    ? await db.sql<{ id: string }>`
        update orbit.friendships set status = 'pending', requested_by = ${me}::uuid, created_at = ${now}::timestamptz,
               accepted_at = null, ended_at = null, ended_by = null
         where id = ${existing.id}::uuid returning id`
    : await db.sql<{ id: string }>`
        insert into orbit.friendships (a, b, status, requested_by, created_at)
        values (${lo}::uuid, ${hi}::uuid, 'pending', ${me}::uuid, ${now}::timestamptz) returning id`;
  const mine = defaultMode(from);
  await db.sql`
    insert into orbit.friend_share_settings (friendship_id, owner_user_id, mode, company_domains)
    values (${f!.id}::uuid, ${me}::uuid, ${mine.mode}, ${mine.domains}::text[])
    on conflict (friendship_id, owner_user_id) do update set mode = excluded.mode,
      company_domains = excluded.company_domains, updated_at = now()`;
  return f!.id;
}

async function invite(ctx: Ctx): Promise<Response> {
  const b = await body(ctx, true);
  const db = ctx.db;
  const me = ctx.userId!;
  const now = ctx.now();
  // an invite to someone in the student's own People goes to the address Orbit has for them (it never crosses to the
  // browser in the suggestions)
  const personId = optUuid(b, 'personId');
  let personEmail: string | null = null;
  // someone with no address: the invite goes as a LinkedIn message from the student's own account
  let viaLinkedIn: { member: string; first: string; accountId: string } | undefined;
  if (personId) {
    const [p] = await db.sql<{
      primary_email: string | null;
      linkedin_member_id: string | null;
      first_name: string | null;
      display_name: string;
    }>`
      select primary_email, linkedin_member_id, first_name, display_name from orbit.people
       where id = ${personId}::uuid and user_id = ${me}::uuid and deleted_at is null and not do_not_contact`;
    if (!p) throw new HttpError(404, 'not_found', 'no such person');
    if (p.primary_email) personEmail = p.primary_email;
    else {
      const [acct] = await db.sql<{ id: string }>`
        select external_account_id as id from orbit.integration_accounts
         where user_id = ${me}::uuid and provider = 'linkedin' and status = 'active' and external_account_id is not null
         limit 1`;
      if (!p.linkedin_member_id || !acct)
        throw new HttpError(404, 'not_found', 'Orbit has no address or LinkedIn for them');
      viaLinkedIn = {
        member: p.linkedin_member_id,
        first: p.first_name || p.display_name.split(/\s+/)[0] || '',
        accountId: acct.id,
      };
    }
  }
  const rawEmail = personEmail ?? (typeof b.email === 'string' ? b.email : '');
  const email = rawEmail.trim() ? normalizeEmail(rawEmail.trim()) : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('that is not an email address');
  const u = await userLite(db, me);
  if (email && email === normalizeEmail(u.email)) throw badRequest('that is your own address');
  const [today] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit.friend_invites
     where from_user_id = ${me}::uuid and created_at > ${new Date(now.getTime() - DAY_MS)}::timestamptz`;
  if ((today?.n ?? 0) >= INVITES_PER_DAY)
    throw new HttpError(429, 'rate_limited', `at most ${INVITES_PER_DAY} invites a day`);
  const code = inviteCode();
  const expires = new Date(now.getTime() + INVITE_DAYS * DAY_MS);
  const [row] = await db.sql<{ id: string; created_at: Date }>`
    insert into orbit.friend_invites (from_user_id, to_email, to_person_id, code, status, created_at, expires_at)
    values (${me}::uuid, ${email}, ${viaLinkedIn ? personId! : null}::uuid, ${code}, 'pending', ${now}::timestamptz,
            ${expires}::timestamptz)
    returning id, created_at`;
  const link = `${ctx.env.appUrl}/friends/join/${code}`;
  let status: FriendsInviteResponse['status'] = 'link';
  let name: string | null = null;
  if (viaLinkedIn) {
    const sent = await linkedinSend(ctx.services(), {
      accountId: viaLinkedIn.accountId,
      attendeeId: viaLinkedIn.member,
      connected: true,
      text: `${viaLinkedIn.first ? `Hi ${viaLinkedIn.first}, ` : ''}I'm using Orbit to keep track of my network and make intros easier. Want to pool our networks? Here's my invite: ${link}`,
    });
    if (!sent.ok) {
      // nothing went out: the invite does not stay waiting on them
      await db.sql`update orbit.friend_invites set status = 'revoked' where id = ${row!.id}::uuid`;
      throw new HttpError(
        502,
        'linkedin_send_failed',
        'LinkedIn did not send the invite. Try again in a moment.',
      );
    }
    status = 'linkedin';
  }
  if (email) {
    const [other] = await db.sql<UserLite>`
      select id, email, full_name, first_name, school, grad_year, avatar_url, settings from orbit.users
       where lower(email) = ${email} and deleted_at is null`;
    if (other) {
      // already on Orbit: a request they accept, with the student's side already set to share
      await requestFriendship(db, u, other.id, now);
      status = 'requested';
      name = nameOf(other);
    } else {
      const mailer = (ctx.services() as unknown as { mailer?: MailLike }).mailer;
      if (mailer?.configured) {
        const r = await mailer.send({
          to: email,
          subject: `${firstOf(u)} wants to pool networks with you on Orbit`,
          text: [
            `${nameOf(u)} invited you to be friends on Orbit.`,
            'Friends pool their networks: you see who they know and how well, they see yours, and intros happen in one tap. Nothing else crosses: not your messages, notes or contact details.',
            `Open this link to sign in and accept: ${link}`,
            `It stops working in ${INVITE_DAYS} days.`,
          ].join('\n\n'),
        });
        if (r.ok) status = 'sent';
      }
    }
  }
  await logAudit(ctx, 'friends.invite', 'friend_invites', row!.id, { status, byEmail: !!email });
  const out: FriendsInviteResponse = {
    code,
    link,
    status,
    invite: {
      id: row!.id,
      direction: 'out',
      email,
      name,
      status: 'pending',
      createdAt: iso(row!.created_at)!,
    },
  };
  return json(200, out);
}

/** The pending friendship a code or an id names, as seen by the student answering it. */
async function pendingFor(
  db: Db,
  me: string,
  b: Record<string, unknown>,
): Promise<{ friendshipId?: string; inviteId?: string; fromUserId: string }> {
  const friendshipId = optUuid(b, 'friendshipId');
  if (friendshipId) {
    const [f] = await db.sql<FriendshipRow>`
      select id, a, b, status, requested_by, created_at, accepted_at from orbit.friendships
       where id = ${friendshipId}::uuid and (a = ${me}::uuid or b = ${me}::uuid)`;
    if (f?.status !== 'pending') throw new HttpError(404, 'not_found', 'no such request');
    if (f.requested_by === me) throw badRequest('that is your own request');
    return { friendshipId: f.id, fromUserId: f.a === me ? f.b : f.a };
  }
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!code) throw badRequest('code or friendshipId is required');
  const [inv] = await db.sql<{
    id: string;
    from_user_id: string;
    to_email: string | null;
    status: string;
    expires_at: Date;
  }>`
    select id, from_user_id, to_email, status, expires_at from orbit.friend_invites where code = ${code}`;
  if (inv?.status !== 'pending' || new Date(inv.expires_at).getTime() < Date.now())
    throw new HttpError(404, 'not_found', 'no such request, or it has expired');
  if (inv.from_user_id === me) throw badRequest('that is your own invite');
  const [u] = await db.sql<{ email: string }>`select email from orbit.users where id = ${me}::uuid`;
  if (inv.to_email && u && normalizeEmail(u.email) !== inv.to_email)
    throw new HttpError(403, 'forbidden', 'that invite was sent to a different address');
  // the friendship this invite stands for, when the inviter already requested it
  const [lo, hi] = me < inv.from_user_id ? [me, inv.from_user_id] : [inv.from_user_id, me];
  const [f] = await db.sql<{ id: string; status: string }>`
    select id, status from orbit.friendships where a = ${lo}::uuid and b = ${hi}::uuid`;
  return {
    friendshipId: f?.status === 'pending' ? f.id : undefined,
    inviteId: inv.id,
    fromUserId: inv.from_user_id,
  };
}

async function accept(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const db = ctx.db;
  const me = ctx.userId!;
  const now = ctx.now();
  const mode = modeOf(b)!;
  const domains = domainsOf(b);
  const p = await pendingFor(db, me, b);
  const inviter = await userLite(db, p.fromUserId);
  const theirs = defaultMode(inviter);
  const [lo, hi] = me < p.fromUserId ? [me, p.fromUserId] : [p.fromUserId, me];
  const friendshipId = await db.begin(async (tx) => {
    let id = p.friendshipId;
    if (id)
      await tx.sql`update orbit.friendships set status = 'active', accepted_at = ${now}::timestamptz where id = ${id}::uuid`;
    else {
      const [existing] = await tx.sql<{ id: string; status: string }>`
        select id, status from orbit.friendships where a = ${lo}::uuid and b = ${hi}::uuid`;
      if (existing?.status === 'active')
        throw new HttpError(409, 'already_friends', 'you are already friends');
      if (existing?.status === 'blocked')
        throw new HttpError(409, 'blocked', 'that request cannot be accepted');
      const [f] = existing
        ? await tx.sql<{ id: string }>`
            update orbit.friendships set status = 'active', requested_by = ${p.fromUserId}::uuid,
                   accepted_at = ${now}::timestamptz, ended_at = null, ended_by = null
             where id = ${existing.id}::uuid returning id`
        : await tx.sql<{ id: string }>`
            insert into orbit.friendships (a, b, status, requested_by, created_at, accepted_at)
            values (${lo}::uuid, ${hi}::uuid, 'active', ${p.fromUserId}::uuid, ${now}::timestamptz, ${now}::timestamptz)
            returning id`;
      id = f!.id;
    }
    // the inviter's side: what they share by default, unless they set it on this friendship already
    await tx.sql`
      insert into orbit.friend_share_settings (friendship_id, owner_user_id, mode, company_domains)
      values (${id}::uuid, ${p.fromUserId}::uuid, ${theirs.mode}, ${theirs.domains}::text[])
      on conflict (friendship_id, owner_user_id) do nothing`;
    await tx.sql`
      insert into orbit.friend_share_settings (friendship_id, owner_user_id, mode, company_domains)
      values (${id}::uuid, ${me}::uuid, ${mode}, ${domains}::text[])
      on conflict (friendship_id, owner_user_id) do update set mode = excluded.mode,
        company_domains = excluded.company_domains, updated_at = now()`;
    // an email invite is for one person; a link shared in a group chat stays open for the next friend until it
    // expires or the student resets it
    if (p.inviteId)
      await tx.sql`update orbit.friend_invites set status = 'accepted', answered_at = ${now}::timestamptz
                     where id = ${p.inviteId}::uuid and to_email is not null`;
    return id;
  });
  await enqueueRefresh(ctx, [me, p.fromUserId]);
  await logAudit(ctx, 'friends.accept', 'friendships', friendshipId, { mode });
  const [f] = await db.sql<FriendshipRow>`
    select id, a, b, status, requested_by, created_at, accepted_at from orbit.friendships where id = ${friendshipId}::uuid`;
  const out: FriendsAcceptResponse = { friend: await friendView(db, me, f!, await targetNames(db, me)) };
  return json(200, out);
}

async function decline(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const db = ctx.db;
  const me = ctx.userId!;
  const now = ctx.now();
  const p = await pendingFor(db, me, b);
  await db.begin(async (tx) => {
    // a declined request leaves no row behind: a later invite starts clean
    if (p.friendshipId) await tx.sql`delete from orbit.friendships where id = ${p.friendshipId}::uuid`;
    if (p.inviteId)
      await tx.sql`update orbit.friend_invites set status = 'declined', answered_at = ${now}::timestamptz where id = ${p.inviteId}::uuid`;
  });
  await logAudit(ctx, 'friends.decline', 'friendships', p.friendshipId ?? p.inviteId ?? '', {});
  return json(200, { ok: true });
}

async function end(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const db = ctx.db;
  const me = ctx.userId!;
  const now = ctx.now();
  const friendshipId = uuid(b, 'friendshipId');
  const rows = await db.begin(async (tx) => {
    const r = await tx.sql<{ id: string }>`
      update orbit.friendships set status = 'ended', ended_at = ${now}::timestamptz, ended_by = ${me}::uuid
       where id = ${friendshipId}::uuid and (a = ${me}::uuid or b = ${me}::uuid) and status in ('active', 'pending')
       returning id`;
    if (r.length)
      await tx.sql`
        update orbit.friend_intro_asks set status = 'expired', answered_at = ${now}::timestamptz
         where friendship_id = ${friendshipId}::uuid and status = 'asked'`;
    return r;
  });
  if (!rows.length) throw new HttpError(404, 'not_found', 'no such friend');
  await logAudit(ctx, 'friends.end', 'friendships', friendshipId, {});
  return json(200, { ok: true });
}

// ---- what the student shares ---------------------------------------------------------------------------------------

/** The student's own rows, under a mode: what a friend with that mode sees. */
async function ownRows(db: Db, me: string): Promise<ShareRow[]> {
  return db.sql<ShareRow>`
    select owner_user_id, person_id, display_name, title, company, company_domain, linkedin_member_id,
           linkedin_slug, email_hash, school, is_alumni, closeness::int as closeness, updated_at
      from orbit.friend_shares where owner_user_id = ${me}::uuid order by display_name`;
}

async function settings(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const db = ctx.db;
  const me = ctx.userId!;
  const mode = modeOf(b)!;
  const domains = domainsOf(b);
  const friendshipId = optUuid(b, 'friendshipId');
  if (friendshipId) {
    const r = await db.sql<{ id: string }>`
      update orbit.friend_share_settings set mode = ${mode}, company_domains = ${domains}::text[], updated_at = now()
       where friendship_id = ${friendshipId}::uuid and owner_user_id = ${me}::uuid
         and exists (select 1 from orbit.friendships f where f.id = ${friendshipId}::uuid and f.status = 'active'
                       and (f.a = ${me}::uuid or f.b = ${me}::uuid))
       returning friendship_id as id`;
    if (!r.length) throw new HttpError(404, 'not_found', 'no such friend');
  } else {
    await db.sql`
      update orbit.friend_share_settings set mode = ${mode}, company_domains = ${domains}::text[], updated_at = now()
       where owner_user_id = ${me}::uuid`;
    await db.sql`
      update orbit.users set settings = settings || jsonb_build_object('friend_share_mode', ${mode}::text,
                                                                        'friend_share_domains', ${JSON.stringify(domains)}::jsonb)
       where id = ${me}::uuid`;
  }
  await enqueueRefresh(ctx, [me]);
  await logAudit(ctx, 'friends.settings', 'friend_share_settings', friendshipId ?? me, { mode, domains });
  const out: FriendsSettingsResponse = {
    mode,
    companyDomains: domains,
    shares: underMode(await ownRows(db, me), mode, domains).length,
  };
  return json(200, out);
}

async function preview(ctx: Ctx): Promise<Response> {
  const db = ctx.db;
  const me = ctx.userId!;
  const b = ctx.req.method === 'POST' ? await body(ctx, true) : {};
  const friendshipId = optUuid(b, 'friendshipId') ?? ctx.url.searchParams.get('friendshipId') ?? undefined;
  const u = await userLite(db, me);
  let mine = defaultMode(u);
  // one friend's view: what this student shares with that friend alone (plan 29 §A1, "See exactly what Ana sees")
  if (friendshipId) {
    if (!/^[0-9a-f-]{36}$/i.test(friendshipId)) throw badRequest('friendshipId must be a uuid');
    const [own] = await db.sql<{ mode: FriendShareMode; company_domains: string[] }>`
      select mode, company_domains from orbit.friend_share_settings
       where friendship_id = ${friendshipId}::uuid and owner_user_id = ${me}::uuid`;
    if (!own) throw forbidden();
    mine = { mode: own.mode, domains: own.company_domains ?? [] };
  }
  const rows = underMode(await ownRows(db, me), mine.mode, mine.domains);
  const out: FriendPreviewResponse = {
    mode: mine.mode,
    companyDomains: mine.domains,
    shares: rows.map(publicShare),
    total: rows.length,
  };
  return json(200, out);
}

// ---- a friend's shares -----------------------------------------------------------------------------------------------

async function friendFor(db: Db, me: string, friendUserId: string): Promise<SharingFriend> {
  const [v] = await db.sql<{
    v: boolean;
  }>`select orbit.friend_visible(${me}::uuid, ${friendUserId}::uuid) as v`;
  if (!v?.v) throw forbidden();
  const f = (await sharingFriends(db, me)).find((x) => x.userId === friendUserId);
  if (!f) throw forbidden();
  return f;
}

async function shares(ctx: Ctx, friendUserId: string, b: Record<string, unknown> = {}): Promise<Response> {
  const db = ctx.db;
  const me = ctx.userId!;
  const company = (ctx.url.searchParams.get('company') ?? (typeof b.company === 'string' ? b.company : ''))
    .trim()
    .toLowerCase();
  const cursor = ctx.url.searchParams.get('cursor') ?? (typeof b.cursor === 'string' ? b.cursor : null);
  const offset = cursor && /^c\d+$/.test(cursor) ? Number(cursor.slice(1)) : 0;
  const friend = await friendFor(db, me, friendUserId);
  const all = (await visibleShares(db, friend)).filter(
    (s) => !company || s.company?.toLowerCase() === company || s.company_domain?.toLowerCase() === company,
  );
  const page = all.slice(offset, offset + SHARES_PAGE);
  const out: FriendSharesResponse = {
    friendUserId,
    shares: page.map(publicShare),
    total: all.length,
    nextCursor: offset + SHARES_PAGE < all.length ? `c${offset + SHARES_PAGE}` : null,
  };
  return json(200, out);
}

async function sharesFlat(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return shares(ctx, uuid(b, 'friendUserId'), b);
}

// ---- asks --------------------------------------------------------------------------------------------------------------

type AskRow = {
  id: string;
  friendship_id: string;
  asker_user_id: string;
  friend_user_id: string;
  target_person_id: string;
  asker_person_id: string | null;
  note: string;
  status: FriendIntroAsk['status'];
  created_at: Date | string;
  answered_at: Date | string | null;
  forwarded_message_id: string | null;
};

async function askView(db: Db, r: AskRow): Promise<FriendIntroAsk> {
  const [asker, friend] = await Promise.all([userLite(db, r.asker_user_id), userLite(db, r.friend_user_id)]);
  // the target as the friend's own row says, never more than the projection would: a name and a company
  const [t] = await db.sql<{ display_name: string; org_raw: string | null; org_name: string | null }>`
    select p.display_name, p.org_raw, o.name as org_name from orbit.people p
      left join orbit.organizations o on o.id = p.org_id where p.id = ${r.target_person_id}::uuid`;
  return {
    id: r.id,
    friendshipId: r.friendship_id,
    askerUserId: r.asker_user_id,
    askerName: nameOf(asker),
    friendUserId: r.friend_user_id,
    friendName: nameOf(friend),
    targetPersonId: r.target_person_id,
    targetName: t?.display_name ?? 'Someone',
    targetCompany: t?.org_name ?? t?.org_raw ?? null,
    askerPersonId: r.asker_person_id,
    note: r.note,
    status: r.status,
    createdAt: iso(r.created_at)!,
    answeredAt: iso(r.answered_at),
    forwardedDraftId: r.forwarded_message_id,
  };
}

const ASK_COLUMNS =
  'id, friendship_id, asker_user_id, friend_user_id, target_person_id, asker_person_id, note, status, created_at, answered_at, forwarded_message_id';

async function listAsks(ctx: Ctx): Promise<Response> {
  const db = ctx.db;
  const me = ctx.userId!;
  await db.sql`select orbit.expire_friend_asks()`;
  const rows = await db.query<AskRow>(
    `select ${ASK_COLUMNS} from orbit.friend_intro_asks where asker_user_id = $1 or friend_user_id = $1
      order by created_at desc limit 200`,
    [me],
  );
  const asked: FriendIntroAsk[] = [];
  const received: FriendIntroAsk[] = [];
  for (const r of rows) (r.asker_user_id === me ? asked : received).push(await askView(db, r));
  const out: FriendAsksResponse = { asked, received };
  return json(200, out);
}

async function ask(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  // GET-shaped use of the POST route: no friend named means the lists
  if (!('friendUserId' in b)) return listAsks(ctx);
  const db = ctx.db;
  const me = ctx.userId!;
  const now = ctx.now();
  const friendUserId = uuid(b, 'friendUserId');
  const targetPersonId = uuid(b, 'targetPersonId');
  const note = text(b, 'note', 1200);
  const friend = await friendFor(db, me, friendUserId);
  const target = (await visibleShares(db, friend)).find((s) => s.person_id === targetPersonId);
  if (!target) throw new HttpError(404, 'not_found', 'that person is not one your friend shares');
  const [today] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit.friend_intro_asks
     where friendship_id = ${friend.friendshipId}::uuid and asker_user_id = ${me}::uuid
       and created_at > ${new Date(now.getTime() - DAY_MS)}::timestamptz`;
  if ((today?.n ?? 0) >= ASKS_PER_DAY_PER_FRIEND)
    throw new HttpError(429, 'rate_limited', `at most ${ASKS_PER_DAY_PER_FRIEND} asks a day per friend`);
  const [open] = await db.sql<{ id: string }>`
    select id from orbit.friend_intro_asks
     where friendship_id = ${friend.friendshipId}::uuid and asker_user_id = ${me}::uuid
       and target_person_id = ${targetPersonId}::uuid and status = 'asked'`;
  if (open)
    throw new HttpError(409, 'already_asked', 'you already asked for this intro; it is waiting on them');
  const match = (await matchShares(db, me, [target])).get(target.person_id) ?? null;
  const [row] = await db.query<AskRow>(
    `insert into orbit.friend_intro_asks (friendship_id, asker_user_id, friend_user_id, target_person_id, asker_person_id,
                                          note, status, created_at)
     values ($1, $2, $3, $4, $5, $6, 'asked', $7) returning ${ASK_COLUMNS}`,
    [friend.friendshipId, me, friendUserId, targetPersonId, match, note, now],
  );
  await logAudit(ctx, 'friends.ask', 'friend_intro_asks', row!.id, { friendUserId });
  // the ask autopilot's plan drafted for this contact, if it did, is done (plan 29 §C1 phase 5)
  await settleCard(db, me, `friend_ask:${friendUserId}:${targetPersonId}`, 'done', now);
  const out: FriendAskResponse = { ask: await askView(db, row!) };
  return json(200, out);
}

async function respond(ctx: Ctx, askId: string, b: Record<string, unknown>): Promise<Response> {
  const db = ctx.db;
  const me = ctx.userId!;
  const now = ctx.now();
  const action = b.action;
  if (action !== 'forward' && action !== 'decline') throw badRequest('action is forward or decline');
  const [r] = await db.query<AskRow>(
    `select ${ASK_COLUMNS} from orbit.friend_intro_asks where id = $1 and friend_user_id = $2`,
    [askId, me],
  );
  if (!r) throw new HttpError(404, 'not_found', 'no such ask');
  if (r.status !== 'asked') throw new HttpError(409, 'already_answered', 'that ask was answered');
  if (action === 'decline') {
    await db.sql`
      update orbit.friend_intro_asks set status = 'declined', answered_at = ${now}::timestamptz where id = ${askId}::uuid`;
    await logAudit(ctx, 'friends.ask.decline', 'friend_intro_asks', askId, {});
    const out: FriendAskRespondResponse = {
      ask: await askView(db, { ...r, status: 'declined', answered_at: now }),
      draft: null,
    };
    return json(200, out);
  }
  // the forward goes to the student's own contact, by email, with the asker in cc: the student must still have them
  const [target] = await db.sql<{
    id: string;
    display_name: string;
    first_name: string | null;
    primary_email: string | null;
    do_not_contact: boolean;
    hidden_at: Date | null;
    private: boolean;
    deleted_at: Date | null;
  }>`
    select id, display_name, first_name, primary_email, do_not_contact, hidden_at, private, deleted_at
      from orbit.people where id = ${r.target_person_id}::uuid and user_id = ${me}::uuid`;
  if (!target || target.deleted_at || target.hidden_at || target.private)
    throw new HttpError(409, 'not_shared', 'that person is no longer one you share');
  if (target.do_not_contact) throw new HttpError(409, 'do_not_contact', 'they asked not to be contacted');
  if (!target.primary_email)
    throw new HttpError(
      409,
      'no_email',
      `you have no email address for ${target.display_name}, so there is nothing to forward with`,
    );
  const [asker, meRow] = await Promise.all([userLite(db, r.asker_user_id), userLite(db, me)]);
  const targetFirst = target.first_name?.trim() || target.display_name.split(/\s+/)[0]!;
  const input = {
    targetFirst,
    askerName: nameOf(asker),
    askerFirst: firstOf(asker),
    note: r.note,
    meFirst: firstOf(meRow),
  };
  const customBody = typeof b.body === 'string' && b.body.trim() ? b.body.trim() : null;
  const draftId = await db.begin(async (tx) => {
    const [d] = await tx.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, subject, body, status, via, generated_by, validator)
      values (${me}::uuid, ${target.id}::uuid, 'gmail', 'forward_intro', ${forwardSubject(input)},
              ${customBody ?? forwardBody(input)}, 'draft',
              ${{ friendAskId: askId, cc: asker.email, ccName: nameOf(asker), askerUserId: r.asker_user_id }}::jsonb,
              'template', ${{ ok: true, issues: [], words: 0, grade: 5 }}::jsonb)
      returning id`;
    await tx.sql`
      update orbit.friend_intro_asks set status = 'forwarded', answered_at = ${now}::timestamptz,
             forwarded_message_id = ${d!.id}::uuid
       where id = ${askId}::uuid`;
    return d!.id;
  });
  await logAudit(ctx, 'friends.ask.forward', 'friend_intro_asks', askId, { draftId });
  const [draft] = await db.sql<
    Record<string, unknown>
  >`select * from orbit.drafts where id = ${draftId}::uuid`;
  const out: FriendAskRespondResponse = {
    ask: await askView(db, { ...r, status: 'forwarded', answered_at: now, forwarded_message_id: draftId }),
    draft: toServerDraft(draft as never),
  };
  return json(200, out);
}

async function respondFlat(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return respond(ctx, uuid(b, 'id'), b);
}

/** The routes with a path parameter: matched by api.ts when no fixed route fits. */
export function friendPatternRoute(path: string): Route | undefined {
  const shareM = /^\/friends\/shares\/([0-9a-f-]{36})$/i.exec(path);
  if (shareM)
    return {
      method: 'GET|POST',
      auth: true,
      run: async (ctx) =>
        shares(ctx, shareM[1]!.toLowerCase(), ctx.req.method === 'POST' ? await body(ctx, true) : {}),
    };
  const respondM = /^\/friends\/asks\/([0-9a-f-]{36})\/respond$/i.exec(path);
  if (respondM)
    return {
      method: 'POST',
      auth: true,
      run: async (ctx) => respond(ctx, respondM[1]!.toLowerCase(), await body(ctx)),
    };
  return undefined;
}

export const friendRoutes: Record<string, Route> = {
  '/friends': { method: 'GET|POST', auth: true, run: list },
  '/friends/invite': { method: 'POST', auth: true, run: invite },
  '/friends/accept': { method: 'POST', auth: true, run: accept },
  '/friends/decline': { method: 'POST', auth: true, run: decline },
  '/friends/end': { method: 'POST', auth: true, run: end },
  '/friends/settings': { method: 'POST', auth: true, run: settings },
  '/friends/preview': { method: 'GET|POST', auth: true, run: preview },
  '/friends/shares': { method: 'POST', auth: true, run: sharesFlat },
  '/friends/asks': {
    method: 'GET|POST',
    auth: true,
    run: (ctx) => (ctx.req.method === 'GET' ? listAsks(ctx) : ask(ctx)),
  },
  '/friends/asks/respond': { method: 'POST', auth: true, run: respondFlat },
};
