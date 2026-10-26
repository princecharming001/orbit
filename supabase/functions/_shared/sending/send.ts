/**
 * Approval and sending (§8.3–8.5, §14.6, §16.3).
 *
 * Approve: the user's approval binds the exact words (messageHash in the audit log). A draft with [ASK USER: …]
 * cannot be approved; LinkedIn needs `confirm: true` from a tap, recorded as a fresh approval that the send checks
 * is at most 15 minutes old; nothing on LinkedIn is ever scheduled or auto-sent.
 *
 * Send: claimed with one `update … set status = 'sending' where status = 'approved' returning *`, so two workers or
 * two taps send once. Before the provider call: a newer inbound message cancels it (`replied`); the hard rules
 * (`checkSend`) hold or forbid it; the daily caps (Gmail sales first touches 30, LinkedIn messages 25, invites 15 a
 * day and 60 a week) push it to the next window. Afterwards: sent_at, provider_message_id, the chat moves, and the
 * audit log records it. A 429 or 5xx hands it back as approved for the queue to retry.
 */
import { FIRST_TOUCH_KINDS } from '@orbit/core/drafts/compose';
import { placeholderIn } from '@orbit/core/drafts/validate';
import { cancelIfReplied } from '@orbit/core/pipeline/cadence';
import { checkSend, messageHash, type SafetyViolation } from '@orbit/core/safety/rules';
import type { DraftApproveRequest, ServerDraft } from '@orbit/core/server/api';
import type { CoffeeChat } from '@orbit/core/types';
import { historyWith } from '../compose/compose.ts';
import { type DraftMeta, type DraftRow, draftById, loadDraft, toServerDraft } from '../compose/drafts.ts';
import { askUserMarkers } from '../compose/prompts.ts';
import { nextSendWindow } from '../compose/window.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { iso } from '../rows.ts';
import type { Services } from '../services.ts';
import { moveChat } from '../slots/slots.ts';
import { validZone, zonedTime } from '../zones.ts';
import { rawMessage } from './mime.ts';
import { gmailSend, gmailThreadHasNewerInbound, linkedinSend, type SendOutcome } from './transport.ts';

export const CAPS = {
  gmailSalesFirstTouchesPerDay: 30,
  linkedinMessagesPerDay: 25,
  linkedinInvitesPerDay: 15,
  linkedinInvitesPerWeek: 60,
} as const;
/** A LinkedIn send needs the user's tap on that message within this window. */
export const LINKEDIN_CONFIRM_MS = 15 * 60_000;

const hashOf = (d: Pick<DraftRow, 'channel' | 'subject' | 'body'>) =>
  messageHash({ channel: d.channel, subject: d.subject, body: d.body });

async function audit(
  db: Db,
  userId: string,
  actor: 'user' | 'agent' | 'system',
  action: string,
  draftId: string,
  details: Record<string, unknown>,
) {
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, ${actor}, ${action}, 'drafts', ${draftId}, ${details}::jsonb)`;
}

async function goalKindOf(db: Db, goalId: string | null): Promise<string | null> {
  if (!goalId) return null;
  const [g] = await db.sql<{ kind: string }>`select kind from orbit.goals where id = ${goalId}::uuid`;
  return g?.kind ?? null;
}

async function postalAddress(db: Db, userId: string): Promise<string> {
  const [u] = await db.sql<{ settings: Record<string, unknown> }>`
    select settings from orbit.users where id = ${userId}::uuid`;
  const v = u?.settings?.postal_address;
  return typeof v === 'string' ? v.trim() : '';
}

/** A sales first touch on Gmail is commercial email: it needs the postal address and the opt-out footer. */
async function salesFirstTouch(db: Db, d: DraftRow): Promise<boolean> {
  return (
    d.channel === 'gmail' &&
    FIRST_TOUCH_KINDS.has(d.kind as never) &&
    (await goalKindOf(db, d.goal_id)) === 'sales'
  );
}

// ---- approve ---------------------------------------------------------------------------------------------------

export async function approveDraft(
  s: Services,
  userId: string,
  req: Partial<DraftApproveRequest>,
): Promise<ServerDraft> {
  const db = s.db;
  const d = await loadDraft(db, userId, req.draftId);
  if (d.status === 'sending' || d.status === 'sent') return toServerDraft(d);
  if (!['draft', 'approved', 'scheduled', 'failed'].includes(d.status))
    throw new HttpError(409, 'not_approvable', `a ${d.status} draft cannot be approved`);
  const text = `${d.subject ?? ''}\n${d.body}`;
  const needs = askUserMarkers(text);
  const gap = needs.length ? undefined : placeholderIn(text);
  if (needs.length || gap)
    throw new HttpError(
      409,
      'needs_input',
      `fill in what the draft asks for first: ${needs.length ? needs.join('; ') : gap}`,
    );
  const [p] = await db.sql<{ do_not_contact: boolean; timezone: string | null }>`
    select do_not_contact, timezone from orbit.people where id = ${d.person_id}::uuid`;
  if (p?.do_not_contact) throw new HttpError(409, 'do_not_contact', 'they asked not to be contacted');
  if (d.channel === 'linkedin' && req.confirm !== true)
    throw new HttpError(409, 'needs_confirmation', 'every LinkedIn message needs your tap to send');
  if ((await salesFirstTouch(db, d)) && !(await postalAddress(db, userId)))
    throw new HttpError(
      409,
      'needs_postal_address',
      'add a postal address in Settings before the first sales email',
    );

  const now = s.now();
  let sendAt: Date;
  if (d.channel === 'linkedin') sendAt = now;
  else if (req.sendAt) {
    const t = new Date(req.sendAt);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'bad_request', 'sendAt must be an ISO time');
    sendAt = t.getTime() < now.getTime() ? now : t;
  } else {
    const [u] = await db.sql<{
      timezone: string;
    }>`select timezone from orbit.users where id = ${userId}::uuid`;
    const tz = validZone(p?.timezone) ?? validZone(u?.timezone) ?? 'America/New_York';
    sendAt = new Date(nextSendWindow(now, tz, d.channel, s.random).notBefore);
  }
  const [row] = await db.sql<DraftRow>`
    update orbit.drafts set status = 'approved', send_at = ${sendAt}::timestamptz, error = null,
                            cancel_reason = null
     where id = ${d.id}::uuid and user_id = ${userId}::uuid and status in ('draft', 'approved', 'scheduled', 'failed')
    returning *`;
  if (!row) return toServerDraft((await draftById(db, d.id))!);
  const hash = hashOf(row);
  await audit(db, userId, 'user', 'draft.approve', row.id, {
    hash,
    send_at: iso(sendAt),
    channel: row.channel,
  });
  if (row.channel === 'linkedin') await audit(db, userId, 'user', 'draft.confirm', row.id, { hash });

  if (sendAt.getTime() <= now.getTime()) {
    try {
      await sendDraft(s, row.id);
    } catch (e) {
      if (!(e instanceof SendRetry)) throw e;
      // the provider is busy: the queue tries again in a minute
      await s.queue.enqueue(
        {
          kind: 'send.draft',
          userId,
          payload: { draftId: row.id },
          dedupeKey: `send:${row.id}:retry:${iso(now)}`,
        },
        { delaySec: 60 },
      );
    }
  } else {
    await s.queue.enqueue(
      {
        kind: 'send.draft',
        userId,
        payload: { draftId: row.id },
        dedupeKey: `send:${row.id}:${iso(sendAt)}`,
      },
      { delaySec: Math.ceil((sendAt.getTime() - now.getTime()) / 1000) },
    );
  }
  return toServerDraft((await draftById(db, row.id))!);
}

export async function cancelDraft(db: Db, userId: string, draftId: unknown): Promise<ServerDraft> {
  const d = await loadDraft(db, userId, draftId);
  if (d.status === 'sending' || d.status === 'sent')
    throw new HttpError(409, 'too_late', 'it has already gone out');
  const [row] = await db.sql<DraftRow>`
    update orbit.drafts set status = 'cancelled', cancel_reason = 'user'
     where id = ${d.id}::uuid and status in ('draft', 'approved', 'scheduled', 'failed') returning *`;
  if (row) await audit(db, userId, 'user', 'draft.cancel', d.id, {});
  return toServerDraft(row ?? (await draftById(db, d.id))!);
}

export async function discardDraft(db: Db, userId: string, draftId: unknown): Promise<ServerDraft> {
  const d = await loadDraft(db, userId, draftId);
  if (d.status === 'sending' || d.status === 'sent')
    throw new HttpError(409, 'too_late', 'it has already gone out');
  const [row] = await db.sql<DraftRow>`
    update orbit.drafts set status = 'discarded'
     where id = ${d.id}::uuid and status in ('draft', 'approved', 'scheduled', 'failed', 'cancelled') returning *`;
  if (row) await audit(db, userId, 'user', 'draft.discard', d.id, {});
  return toServerDraft(row ?? (await draftById(db, d.id))!);
}

// ---- send ------------------------------------------------------------------------------------------------------

export type SendResult =
  | { status: 'sent'; providerMessageId: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'held'; reason: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

/** Thrown for a 429 or 5xx so the queue retries; the draft is approved again. */
export class SendRetry extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'SendRetry';
  }
}

/** Sends one approved draft whose time has come. Safe to call twice: only one call claims it. */
export async function sendDraft(s: Services, draftId: string): Promise<SendResult> {
  const db = s.db;
  const now = s.now();
  const [d] = await db.sql<DraftRow>`
    update orbit.drafts set status = 'sending'
     where id = ${draftId}::uuid and status = 'approved'
       and (send_at is null or send_at <= ${new Date(now.getTime() + 1000)}::timestamptz)
    returning *`;
  if (!d) return { status: 'skipped', reason: 'not_claimed' };
  const userId = d.user_id;

  const settle = async (
    status: 'approved' | 'draft' | 'failed' | 'cancelled',
    fields: Record<string, unknown>,
  ) => {
    await db.sql`
      update orbit.drafts set status = ${status},
             error = ${(fields.error as string | undefined) ?? null},
             cancel_reason = ${(fields.cancel_reason as string | undefined) ?? null},
             send_at = coalesce(${(fields.send_at as Date | undefined) ?? null}::timestamptz, send_at)
       where id = ${d.id}::uuid`;
  };

  // [ASK USER: …], or any other blank left for the user (one with its brackets deleted too), never goes out
  if (
    askUserMarkers(`${d.subject ?? ''}\n${d.body}`).length ||
    placeholderIn(`${d.subject ?? ''}\n${d.body}`)
  ) {
    await settle('draft', { error: 'needs_input' });
    return { status: 'held', reason: 'needs_input' };
  }

  // 1. a newer inbound message cancels it (§9.3)
  const [person] = await db.sql<{
    display_name: string;
    first_name: string | null;
    primary_email: string | null;
    title: string | null;
    headline: string | null;
    do_not_contact: boolean;
    linkedin_member_id: string | null;
  }>`
    select display_name, first_name, primary_email, title, headline, do_not_contact, linkedin_member_id
      from orbit.people where id = ${d.person_id}::uuid`;
  if (!person) {
    await settle('failed', { error: 'no_person' });
    return { status: 'failed', error: 'no_person' };
  }
  const history = await historyWith(db, userId, d.person_id);
  const createdAt = iso(d.created_at)!;
  const replied = cancelIfReplied(
    { personId: d.person_id, createdAt },
    history.map((h) => ({
      personId: d.person_id,
      direction: h.direction,
      at: h.at,
      channel: 'email' as const,
    })),
  );
  let live: boolean | undefined;
  if (!replied.cancel && d.channel === 'gmail' && d.thread_external_id)
    live = await gmailThreadHasNewerInbound(s, userId, d.thread_external_id, new Date(createdAt));
  if (replied.cancel || live) {
    await settle('cancelled', { cancel_reason: 'replied' });
    await audit(db, userId, 'system', 'draft.cancel', d.id, { reason: 'replied' });
    return { status: 'cancelled', reason: 'replied' };
  }

  // 2. who approved these exact words
  const approvals = await db.sql<{
    actor: string;
    action: string;
    details: { hash?: string };
    created_at: Date;
  }>`
    select actor, action, details, created_at from orbit.audit_log
     where user_id = ${userId}::uuid and target_table = 'drafts' and target_id = ${d.id}
       and action in ('draft.approve', 'draft.confirm', 'draft.auto_approve')
     order by created_at desc`;
  const hash = hashOf(d);
  const userApproved = approvals.some((a) => a.action === 'draft.approve' && a.details?.hash === hash);
  const agentApproved = approvals.some((a) => a.action === 'draft.auto_approve' && a.details?.hash === hash);
  if (d.channel === 'linkedin') {
    const fresh = approvals.some(
      (a) =>
        a.action === 'draft.confirm' &&
        a.actor === 'user' &&
        a.details?.hash === hash &&
        now.getTime() - new Date(a.created_at).getTime() <= LINKEDIN_CONFIRM_MS,
    );
    if (!fresh) {
      await settle('draft', { error: 'linkedin_needs_fresh_approval' });
      await audit(db, userId, 'system', 'draft.hold', d.id, { reason: 'linkedin_needs_fresh_approval' });
      return { status: 'held', reason: 'linkedin_needs_fresh_approval' };
    }
  }
  if (!userApproved && !agentApproved) {
    await settle('draft', { error: 'not_approved' });
    return { status: 'held', reason: 'not_approved' };
  }

  // 3. hard rules (§14.6)
  const [u] = await db.sql<{
    email: string;
    full_name: string | null;
    first_name: string | null;
    timezone: string;
    settings: Record<string, unknown>;
  }>`
    select email, full_name, first_name, timezone, settings from orbit.users where id = ${userId}::uuid`;
  const meta = (d.ask ?? {}) as DraftMeta;
  const violations: SafetyViolation[] = checkSend(
    { kind: d.kind as never, channel: d.channel, personId: d.person_id, subject: d.subject, body: d.body },
    {
      now,
      userEmails: [u!.email],
      userName: u!.full_name ?? u!.first_name ?? '',
      recipient: {
        doNotContact: person.do_not_contact,
        title: person.title ?? undefined,
        headline: person.headline ?? undefined,
      },
      history,
      schedulingLink:
        typeof u!.settings?.scheduling_link === 'string' ? u!.settings.scheduling_link : undefined,
      offeredSlots: meta.slots,
      timeZone: u!.timezone,
      approvedHash: userApproved ? hash : undefined,
    },
  );
  const forbidden = violations.find((v) => v.kind === 'forbidden');
  if (forbidden) {
    await settle('cancelled', { cancel_reason: forbidden.rule });
    await audit(db, userId, 'system', 'draft.blocked', d.id, { rule: forbidden.rule });
    return { status: 'cancelled', reason: forbidden.rule };
  }
  if (violations.length) {
    // an agent approval does not cover anything a hard rule says needs the user
    await settle('draft', { error: `needs_approval:${violations.map((v) => v.rule).join(',')}` });
    return { status: 'held', reason: violations[0]!.rule };
  }
  if ((await salesFirstTouch(db, d)) && (!(await postalAddress(db, userId)) || !meta.footer)) {
    await settle('draft', { error: 'needs_postal_address' });
    return { status: 'held', reason: 'needs_postal_address' };
  }

  // 4. caps
  const cap = await capReached(db, userId, d, now, u!.timezone);
  if (cap) {
    const next = new Date(
      nextSendWindow(new Date(now.getTime() + 86_400_000), u!.timezone, d.channel, s.random).notBefore,
    );
    await settle(d.channel === 'linkedin' ? 'draft' : 'approved', { error: cap, send_at: next });
    return { status: 'held', reason: cap };
  }

  // 5. send
  let out: SendOutcome & { chatId?: string };
  if (d.channel === 'gmail') {
    if (!person.primary_email) {
      await settle('failed', { error: 'no_email' });
      return { status: 'failed', error: 'no_email' };
    }
    const subject = d.subject ?? (await threadSubject(db, userId, d.thread_external_id)) ?? '';
    const refs = d.in_reply_to ?? (await lastMessageId(db, userId, d.thread_external_id));
    const raw = rawMessage({
      from: u!.email,
      fromName: u!.full_name ?? undefined,
      to: person.primary_email,
      toName: person.display_name,
      subject: d.subject ? subject : subject && !/^re:/i.test(subject) ? `Re: ${subject}` : subject,
      body: d.body,
      inReplyTo: refs,
      references: refs,
      draftId: d.id,
      date: now,
    });
    out = await gmailSend(s, userId, raw, d.thread_external_id);
  } else {
    const [acct] = await db.sql<{ external_account_id: string | null }>`
      select external_account_id from orbit.integration_accounts
       where user_id = ${userId}::uuid and provider = 'linkedin' and status = 'active'`;
    if (!acct?.external_account_id) {
      await settle('failed', { error: 'linkedin_not_connected' });
      return { status: 'failed', error: 'linkedin_not_connected' };
    }
    const chatId = d.thread_external_id ?? (await linkedinChatId(db, userId, d.person_id));
    const attendee = chatId
      ? null
      : await linkedinAttendee(db, userId, d.person_id, person.linkedin_member_id);
    out = await linkedinSend(s, {
      accountId: acct.external_account_id,
      chatId,
      attendeeId: attendee,
      text: d.body,
    });
  }
  if (!out.ok) {
    if (out.retry) {
      await settle('approved', { error: out.error });
      throw new SendRetry(out.error);
    }
    await settle('failed', { error: out.error });
    await audit(db, userId, 'system', 'draft.failed', d.id, { error: out.error });
    return { status: 'failed', error: out.error };
  }

  // 6. record
  const threadId = out.chatId ?? out.threadId ?? d.thread_external_id;
  await db.sql`
    update orbit.drafts set status = 'sent', sent_at = ${now}::timestamptz, provider_message_id = ${out.providerMessageId},
                            thread_external_id = ${threadId ?? null}, error = null
     where id = ${d.id}::uuid`;
  await audit(
    db,
    userId,
    userApproved ? 'user' : 'agent',
    agentApproved && !userApproved ? 'draft.auto_sent' : 'draft.sent',
    d.id,
    {
      channel: d.channel,
      kind: d.kind,
    },
  );
  if (d.chat_id) await afterSend(db, userId, d, now);
  const via = d.via as { introRequestId?: string } | null;
  if (d.kind === 'intro_request' && via?.introRequestId)
    await db.sql`update orbit.intro_requests set asked_at = ${now}::timestamptz where id = ${via.introRequestId}::uuid`;
  return { status: 'sent', providerMessageId: out.providerMessageId };
}

/** The chat after a send: last outbound, first outreach, bump count, and outreach_sent for a first message. */
async function afterSend(db: Db, userId: string, d: DraftRow, now: Date) {
  const [c] = await db.sql<{ stage: string; data: Partial<CoffeeChat> }>`
    select stage, data from orbit.chats where id = ${d.chat_id}::uuid`;
  if (!c) return;
  const at = now.toISOString();
  const data: Partial<CoffeeChat> = {
    ...c.data,
    lastOutboundAt: at,
    outreachChannel: (d.channel === 'gmail' ? 'email' : 'linkedin') as CoffeeChat['outreachChannel'],
  };
  if (!data.firstOutreachAt && d.kind !== 'forwardable_blurb' && d.kind !== 'intro_request')
    data.firstOutreachAt = at;
  if (d.kind === 'bump') data.bumpCount = (data.bumpCount ?? 0) + 1;
  await db.sql`update orbit.chats set data = ${data}::jsonb where id = ${d.chat_id}::uuid`;
  if (
    ['identified', 'warming'].includes(c.stage) &&
    d.kind !== 'forwardable_blurb' &&
    d.kind !== 'intro_request'
  )
    await moveChat(db, userId, d.chat_id!, 'outreach_sent', `${d.kind} sent`, now);
}

async function capReached(
  db: Db,
  userId: string,
  d: DraftRow,
  now: Date,
  tz: string,
): Promise<string | null> {
  const zone = validZone(tz) ?? 'America/New_York';
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  const dayStart = zonedTime(key, 0, 0, zone);
  if (d.channel === 'linkedin') {
    const [r] = await db.sql<{ n: number }>`
      select count(*)::int as n from orbit.drafts
       where user_id = ${userId}::uuid and channel = 'linkedin' and status = 'sent'
         and sent_at >= ${dayStart}::timestamptz`;
    return (r?.n ?? 0) >= CAPS.linkedinMessagesPerDay ? 'linkedin_daily_cap' : null;
  }
  if (await salesFirstTouch(db, d)) {
    const [r] = await db.sql<{ n: number }>`
      select count(*)::int as n from orbit.drafts dr join orbit.goals g on g.id = dr.goal_id
       where dr.user_id = ${userId}::uuid and dr.channel = 'gmail' and dr.status = 'sent' and g.kind = 'sales'
         and dr.kind in ('first_touch', 'warm_first_touch', 'outreach') and dr.sent_at >= ${dayStart}::timestamptz`;
    return (r?.n ?? 0) >= CAPS.gmailSalesFirstTouchesPerDay ? 'gmail_sales_daily_cap' : null;
  }
  return null;
}

/** LinkedIn invites: 15 a day and 60 a week, counted from the audit log (invites go out only on a tap). */
export async function inviteCapReached(db: Db, userId: string, now: Date): Promise<string | null> {
  const [r] = await db.sql<{ day: number; week: number }>`
    select count(*) filter (where created_at >= ${new Date(now.getTime() - 86_400_000)}::timestamptz)::int as day,
           count(*)::int as week
      from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'linkedin.invite'
       and created_at >= ${new Date(now.getTime() - 7 * 86_400_000)}::timestamptz`;
  if ((r?.day ?? 0) >= CAPS.linkedinInvitesPerDay) return 'linkedin_invite_daily_cap';
  if ((r?.week ?? 0) >= CAPS.linkedinInvitesPerWeek) return 'linkedin_invite_weekly_cap';
  return null;
}

async function threadSubject(
  db: Db,
  userId: string,
  threadExternalId: string | null,
): Promise<string | null> {
  if (!threadExternalId) return null;
  const [t] = await db.sql<{ subject: string | null }>`
    select subject from orbit.threads where user_id = ${userId}::uuid and external_id = ${threadExternalId}`;
  return t?.subject ?? null;
}

async function lastMessageId(
  db: Db,
  userId: string,
  threadExternalId: string | null,
): Promise<string | null> {
  if (!threadExternalId) return null;
  const [m] = await db.sql<{ rfc_message_id: string | null }>`
    select m.rfc_message_id from orbit.messages m join orbit.threads t on t.id = m.thread_id
     where t.user_id = ${userId}::uuid and t.external_id = ${threadExternalId} and m.rfc_message_id is not null
     order by m.sent_at desc limit 1`;
  return m?.rfc_message_id ?? null;
}

async function linkedinChatId(db: Db, userId: string, personId: string): Promise<string | null> {
  const [t] = await db.sql<{ external_id: string }>`
    select external_id from orbit.threads
     where user_id = ${userId}::uuid and provider = 'linkedin' and ${personId}::uuid = any(participant_person_ids)
     order by last_at desc nulls last limit 1`;
  return t?.external_id ?? null;
}

async function linkedinAttendee(
  db: Db,
  userId: string,
  personId: string,
  memberId: string | null,
): Promise<string | null> {
  const [i] = await db.sql<{ value_raw: string | null; value_norm: string }>`
    select value_raw, value_norm from orbit.person_identities
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and kind in ('unipile_attendee', 'linkedin_member')
     order by (kind = 'unipile_attendee') desc limit 1`;
  return i?.value_raw ?? i?.value_norm ?? memberId;
}
