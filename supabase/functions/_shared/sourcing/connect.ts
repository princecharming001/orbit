/**
 * Connect on someone a people search found (POST /source/connect).
 *
 * The student pressed Connect on a row. That click is their approval of one thing: one LinkedIn connection request,
 * with no note, from their own LinkedIn. So this saves the person to People exactly as /source/add does (`addSourced`),
 * sends that one request, and puts their chat where a sent request belongs (`outreach_sent`, the stage a draft sent
 * as a connection note reaches). Nothing else goes: no message, no draft, no follow-up. A request is not a message, so
 * the chat gets no `lastOutboundAt`, which is what the bump and "no response" timers count from.
 *
 * It acts only through the student's own row in orbit.integration_accounts (provider linkedin, active). The Unipile
 * key is shared with another product, so nothing here lists accounts or touches a webhook: the two calls it can make
 * are GET /users/{slug} and POST /users/invite, both with the student's own account id.
 *
 * Once per student and person (orbit.linkedin_connects, its primary key: the student and who the person is on
 * LinkedIn): the row is inserted before LinkedIn is asked, so a second click, a second tab or a retry finds it and
 * sends nothing. A request that did not go removes the row again; one that may have gone (the call broke off after it
 * left) keeps it as `unconfirmed` and is never sent a second time.
 *
 * Every existing limit holds: the invite caps (SEND_CAPS, 15 a day and 60 a week, counted from the `linkedin.invite`
 * audit rows this writes too), the swarm limit on the profile look (`linkedinInvite`), and the hard rules about who
 * is never written to (do not contact, a profile that reads as under 18). Whatever stops it, the person is saved and
 * the answer says why in words the screen shows as they are.
 */
import { looksLikeMinor } from '@orbit/core/safety/rules';
import {
  SOURCE_CONNECT_REASONS,
  type SourceConnectCode,
  type SourceConnectResponse,
} from '@orbit/core/server/api';
import type { CoffeeChat } from '@orbit/core/types';
import { HttpError } from '../http.ts';
import { iso } from '../rows.ts';
import { inviteCapReached, STUCK_SENDING_MS } from '../sending/send.ts';
import { linkedinInvite } from '../sending/transport.ts';
import type { Services } from '../services.ts';
import { moveChat } from '../slots/slots.ts';
import { addSourced, ensureChat } from './run.ts';

/** Why the student's LinkedIn cannot send, by the status of their link. */
const NOT_ACTIVE: Record<string, string> = {
  parked: 'LinkedIn is paused because you were away. Saved to People instead.',
  needs_reauth: 'LinkedIn signed Orbit out. Saved to People instead.',
  connecting: 'LinkedIn is still connecting. Saved to People instead.',
  error: 'LinkedIn stopped working with Orbit. Saved to People instead.',
};

/** What the transport's refusal means to the student. */
function codeOf(error: string): SourceConnectCode {
  switch (error) {
    case 'linkedin_invite_daily_cap':
      return 'daily_limit';
    case 'linkedin_invite_weekly_cap':
      return 'weekly_limit';
    case 'linkedin_invite_limit':
      return 'linkedin_limit';
    case 'linkedin_already_invited':
      return 'already_requested';
    case 'linkedin_already_connected':
      return 'already_connected';
    case 'no_linkedin_member':
      return 'profile_not_found';
    case 'linkedin_busy':
    case 'network':
      return 'busy';
    case 'unipile_unconfigured':
      return 'unavailable';
    default:
      // LinkedIn or Unipile slow or over its own rate (429, 5xx before anything was sent) is "try again later"
      return /^unipile_(429|5\d\d)$/.test(error) ? 'busy' : 'refused';
  }
}

type PersonRow = {
  id: string;
  display_name: string;
  title: string | null;
  headline: string | null;
  do_not_contact: boolean;
  linkedin_member_id: string | null;
  linkedin_slug: string | null;
  linkedin_connected_on: string | null;
};

export async function connectSourced(
  s: Services,
  userId: string,
  who: { recommendationId?: string; personId?: string },
): Promise<SourceConnectResponse> {
  const db = s.db;
  const now = s.now();
  if (!who.recommendationId === !who.personId)
    throw new HttpError(400, 'bad_request', 'send one of recommendationId or personId');

  // 1. saved first, whatever happens next: the same code as Save
  let person: SourceConnectResponse['person'];
  /** what the search knew of them that the person's row may not hold yet */
  let found: { memberId?: string; degree?: number } = {};
  if (who.recommendationId) {
    const { people } = await addSourced(s, userId, [who.recommendationId]);
    person = people[0]!;
    const [rec] = await db.sql<{ candidate: { memberId?: string; networkDistance?: number } }>`
      select candidate from orbit.recommendations
       where id = ${who.recommendationId}::uuid and user_id = ${userId}::uuid`;
    found = { memberId: rec?.candidate?.memberId, degree: rec?.candidate?.networkDistance };
  } else {
    // someone merged into another person since is that person now
    const [p] = await db.sql<{ id: string; display_name: string }>`
      select q.id, q.display_name
        from orbit.people p join orbit.people q on q.id = coalesce(p.merged_into, p.id)
       where p.id = ${who.personId!}::uuid and p.user_id = ${userId}::uuid and p.deleted_at is null
         and q.deleted_at is null and not q.is_self`;
    if (!p)
      throw new HttpError(404, 'person_not_found', 'Orbit does not have this person on your account yet');
    const [open] = await db.sql<{ id: string }>`
      select id from orbit.chats
       where user_id = ${userId}::uuid and person_id = ${p.id}::uuid and archived_at is null
       order by created_at desc limit 1`;
    person = {
      id: p.id,
      displayName: p.display_name,
      chatId: open?.id ?? (await ensureChat(db, userId, p.id, null, now)),
    };
  }
  const saved = (code: SourceConnectCode, reason = SOURCE_CONNECT_REASONS[code]): SourceConnectResponse => ({
    person,
    sent: false,
    code,
    reason,
  });

  // 2. who they are, and whether a request may go to them at all
  const [p] = await db.sql<PersonRow>`
    select id, display_name, title, headline, do_not_contact, linkedin_member_id, linkedin_slug, linkedin_connected_on
      from orbit.people where id = ${person.id}::uuid and user_id = ${userId}::uuid`;
  if (!p) throw new HttpError(404, 'person_not_found', 'Orbit does not have this person on your account yet');
  if (p.do_not_contact) return saved('do_not_contact');
  if (looksLikeMinor({ title: p.title ?? undefined, headline: p.headline ?? undefined }))
    return saved('minor');
  const memberId = p.linkedin_member_id ?? found.memberId ?? null;
  if (!memberId && !p.linkedin_slug) return saved('no_profile');
  if (p.linkedin_connected_on || found.degree === 1) return saved('already_connected');

  // 3. a request already asked for: nothing is sent twice
  // who on LinkedIn the marker names: their profile name when Orbit has it, else their member id
  const targets = [
    ...(p.linkedin_slug ? [`in:${p.linkedin_slug.trim().toLowerCase()}`] : []),
    ...(memberId ? [`id:${memberId}`] : []),
  ];
  const target = targets[0]!;
  const [had] = await db.sql<{ status: string; created_at: Date }>`
    select status, created_at from orbit.linkedin_connects
     where user_id = ${userId}::uuid and (person_id = ${p.id}::uuid or target = any(${targets}::text[]))
     order by (status = 'sent') desc limit 1`;
  if (had) {
    // a row still `sending` long after its claim was left by a call that died mid-send: it may have gone
    const stuck =
      had.status === 'sending' && now.getTime() - new Date(had.created_at).getTime() > STUCK_SENDING_MS;
    return saved(had.status === 'unconfirmed' || stuck ? 'unconfirmed' : 'already_requested');
  }

  // 4. the student's own LinkedIn, and only that
  const [acct] = await db.sql<{ external_account_id: string | null; status: string }>`
    select external_account_id, status from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin'`;
  if (acct?.status !== 'active' || !acct.external_account_id)
    return saved('linkedin_not_active', (acct && NOT_ACTIVE[acct.status]) || undefined);

  // 5. the caps, before anything is asked of LinkedIn
  const cap = await inviteCapReached(db, userId, now);
  if (cap) return saved(codeOf(cap));

  // 6. the marker: whoever inserts it sends; anyone else finds it there
  const [claim] = await db.sql<{ target: string }>`
    insert into orbit.linkedin_connects (user_id, target, person_id, status, created_at)
    values (${userId}::uuid, ${target}, ${p.id}::uuid, 'sending', ${now}::timestamptz)
    on conflict (user_id, target) do nothing
    returning target`;
  if (!claim) return saved('already_requested');
  const mark = (status: 'sent' | 'unconfirmed', invitationId: string | null = null) =>
    db.sql`
      update orbit.linkedin_connects
         set status = ${status}, invitation_id = ${invitationId},
             sent_at = ${status === 'sent' ? now : null}::timestamptz
       where user_id = ${userId}::uuid and target = ${target}`;
  const release = () =>
    db.sql`
      delete from orbit.linkedin_connects
       where user_id = ${userId}::uuid and target = ${target} and status = 'sending'`;

  let out: Awaited<ReturnType<typeof linkedinInvite>>;
  try {
    out = await linkedinInvite(s, {
      accountId: acct.external_account_id,
      memberId,
      slug: p.linkedin_slug,
      // asked again just before the request goes, as for a draft sent as a request
      beforeInvite: () => inviteCapReached(db, userId, now),
    });
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  }
  // the member LinkedIn resolved is kept, so the next message needs no lookup
  if (out.memberId && !p.linkedin_member_id)
    await db.sql`
      update orbit.people set linkedin_member_id = ${out.memberId}
       where id = ${p.id}::uuid and linkedin_member_id is null`.catch(() => undefined);

  if (!out.ok) {
    if (out.ambiguous) {
      // LinkedIn may have it: kept, so it is never sent a second time; the student checks on LinkedIn
      await mark('unconfirmed');
      await audit(s, userId, 'linkedin.invite_unconfirmed', p.id, {
        error: out.error,
        chatId: person.chatId,
      });
      return saved('unconfirmed');
    }
    const code = codeOf(out.error);
    // a request the student sent on LinkedIn itself is waiting: the marker says so from now on
    if (code === 'already_requested') await mark('sent');
    else await release();
    await audit(s, userId, 'linkedin.invite_refused', p.id, {
      error: out.error,
      code,
      chatId: person.chatId,
    });
    return saved(
      code,
      code === 'already_requested'
        ? 'LinkedIn says you already have a connection request out to them. Saved to People.'
        : undefined,
    );
  }

  // 7. it went: the marker first, then the record, then the chat
  await mark('sent', out.invitationId);
  // `linkedin.invite` is the row the invite caps count, whoever sent the request
  await audit(s, userId, 'linkedin.invite', p.id, {
    at: iso(now),
    via: 'source.connect',
    note: false,
    chatId: person.chatId,
    ...(who.recommendationId ? { recommendationId: who.recommendationId } : {}),
    ...(out.invitationId ? { invitationId: out.invitationId } : {}),
  });
  await afterRequest(s, userId, person.chatId, now);
  return { person, sent: true };
}

async function audit(
  s: Services,
  userId: string,
  action: string,
  personId: string,
  details: Record<string, unknown>,
) {
  await s.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', ${action}, 'people', ${personId}, ${details}::jsonb)`;
}

/**
 * The chat after a request went: `outreach_sent` when it stood at "to contact" or warming (a chat further on stays
 * where it is), LinkedIn as its channel, and when the request went.
 */
async function afterRequest(s: Services, userId: string, chatId: string, now: Date) {
  const db = s.db;
  const [c] = await db.sql<{ stage: string; data: Partial<CoffeeChat> | null }>`
    select stage, data from orbit.chats where id = ${chatId}::uuid and user_id = ${userId}::uuid`;
  if (!c) return;
  const early = ['identified', 'warming'].includes(c.stage);
  const data: Partial<CoffeeChat> = {
    ...(c.data ?? {}),
    connectionRequestedAt: now.toISOString(),
    ...(early || !c.data?.outreachChannel ? { outreachChannel: 'linkedin' as const } : {}),
  };
  await db.sql`update orbit.chats set data = ${data}::jsonb where id = ${chatId}::uuid`;
  if (early) await moveChat(db, userId, chatId, 'outreach_sent', 'connection request sent', now, 'user');
}
