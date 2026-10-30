/**
 * Replies (§8): the list of inbound replies to the user's outreach, a reply drafted in their voice (with free slots
 * when they want to meet), and autonomy level 2 (§8.4): `maybeAutoReply` drafts the answer to a classified reply and
 * approves it for sending only when `autonomyAllows` says every level-2 condition holds. Unsubscribe replies are
 * never answered; they set do_not_contact and close the chat.
 */
import type { ReplyClass } from '@orbit/core/email/replyClass';
import { autonomyAllows, messageHash } from '@orbit/core/safety/rules';
import type { ReplyItem } from '@orbit/core/server/api';
import { type ComposeResult, composeDraft, historyWith, loadReplyMessage } from '../compose/compose.ts';
import type { DraftMeta, DraftRow } from '../compose/drafts.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { iso, num } from '../rows.ts';
import { type AgentConfig, makeServices, type Services } from '../services.ts';
import { moveChat } from '../slots/slots.ts';
import { validZone, zonedTime } from '../zones.ts';

export const REPLY_WINDOW_DAYS = 30;

/** Inbound replies with a class, newest first, last 30 days, with the person, thread and any draft answering it. */
export async function listReplies(db: Db, userId: string, now: Date): Promise<ReplyItem[]> {
  const rows = await db.sql<{
    id: string;
    thread_external_id: string;
    from_person_id: string | null;
    display_name: string | null;
    from_addr: string | null;
    provider: 'gmail' | 'linkedin';
    reply_class: ReplyClass;
    reply_confidence: number | null;
    sent_at: Date;
    snippet: string | null;
    body_text: string | null;
    draft_id: string | null;
  }>`
    select m.id, t.external_id as thread_external_id, m.from_person_id, p.display_name, m.from_addr, m.provider,
           m.reply_class, m.reply_confidence, m.sent_at, m.snippet, m.body_text,
           (select d.id from orbit.drafts d
             where d.user_id = m.user_id and d.ask->>'replyToMessageId' = m.id::text
               and d.status not in ('discarded', 'cancelled')
             order by d.created_at desc limit 1) as draft_id
      from orbit.messages m
      join orbit.threads t on t.id = m.thread_id
      left join orbit.people p on p.id = m.from_person_id
     where m.user_id = ${userId}::uuid and m.direction = 'in' and m.reply_class is not null
       and m.sent_at >= ${new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000)}::timestamptz
     order by m.sent_at desc
     limit 200`;
  return rows.map((r) => ({
    messageId: r.id,
    threadId: r.thread_external_id,
    personId: r.from_person_id,
    personName: r.display_name ?? r.from_addr?.split('@')[0] ?? 'Someone',
    channel: r.provider,
    replyClass: r.reply_class,
    confidence: num(r.reply_confidence),
    receivedAt: iso(r.sent_at)!,
    snippet: (r.snippet ?? r.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    draftId: r.draft_id,
  }));
}

/** A reply in the user's voice to one inbound message (§8.3). */
export async function draftReply(
  s: Services,
  userId: string,
  messageId: string,
  actor: 'user' | 'agent' = 'user',
): Promise<ComposeResult> {
  const m = await loadReplyMessage(s.db, userId, messageId);
  if (m.reply_class === 'unsubscribe')
    throw new HttpError(409, 'unsubscribe', 'they asked not to be contacted; no reply is drafted');
  if (!m.from_person_id) throw new HttpError(409, 'unknown_sender', 'Orbit does not know who sent this yet');
  return composeDraft(s, {
    userId,
    personId: m.from_person_id,
    kind: 'reply',
    channel: m.provider,
    replyToMessageId: m.id,
    actor,
  });
}

/** Classes that get a draft answer without being asked (§8.3 next actions); the others wait for the user. */
const DRAFT_CLASSES: ReadonlySet<ReplyClass> = new Set([
  'interested',
  'scheduling',
  'question',
  'objection',
  'referral',
  'not_now',
  'decline',
]);

export type AutoReplyOutcome =
  | { action: 'none'; reason: string }
  | { action: 'unsubscribed' }
  | { action: 'drafted'; draftId: string; reasons: string[] }
  | { action: 'auto_sent'; draftId: string };

/**
 * After a reply is classified (P3's classify.message calls this): unsubscribe → do_not_contact and the chat closes;
 * a class that needs an answer → a draft (unless the message was read from the user's history, before Orbit; a newer
 * message in the thread retires the untouched draft answering an earlier one); and at level 2, a scheduling or thanks
 * answer that meets every §8.4 condition is approved by the agent and queued to send. Idempotent per message.
 */
export async function maybeAutoReply(
  db: Db,
  userId: string,
  messageId: string,
  deps: {
    services?: Services;
    config?: AgentConfig;
    now?: () => Date;
    /** the message was read from the user's history (a backfill): an unsubscribe counts, nothing is drafted */
    history?: boolean;
  } = {},
): Promise<AutoReplyOutcome> {
  const s = deps.services ?? makeServices(deps.config ?? { env: {} }, { db, now: deps.now });
  const now = s.now();
  const m = await loadReplyMessage(db, userId, messageId);
  const cls = m.reply_class as ReplyClass | null;
  if (!cls) return { action: 'none', reason: 'not_classified' };
  if (cls === 'unsubscribe') {
    if (m.from_person_id) {
      await db.sql`update orbit.people set do_not_contact = true where id = ${m.from_person_id}::uuid and user_id = ${userId}::uuid`;
      await db.sql`
        update orbit.drafts set status = 'cancelled', cancel_reason = 'unsubscribe'
         where user_id = ${userId}::uuid and person_id = ${m.from_person_id}::uuid
           and status in ('draft', 'approved', 'scheduled')`;
      const chats = await db.sql<{ id: string }>`
        select id from orbit.chats where user_id = ${userId}::uuid and person_id = ${m.from_person_id}::uuid
           and archived_at is null`;
      for (const c of chats) await moveChat(db, userId, c.id, 'declined', 'asked not to be contacted', now);
      await db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'agent', 'person.do_not_contact', 'people', ${m.from_person_id}, ${{ source: 'reply' }}::jsonb)`;
    }
    return { action: 'unsubscribed' };
  }
  if (!m.from_person_id) return { action: 'none', reason: 'unknown_sender' };
  // it came before Orbit: the user dealt with it then, or can ask for a draft from the replies list
  if (deps.history) return { action: 'none', reason: 'history' };
  // thanks needs no answer; an out-of-office is followed up by cadence after the return date
  if (!DRAFT_CLASSES.has(cls)) return { action: 'none', reason: `class ${cls}` };
  const autoClass = cls === 'scheduling';

  const [existing] = await db.sql<DraftRow>`
    select * from orbit.drafts
     where user_id = ${userId}::uuid and ask->>'replyToMessageId' = ${m.id}
       and status not in ('discarded', 'cancelled')
     order by created_at desc limit 1`;
  let draft: DraftRow;
  if (existing) {
    if (existing.status !== 'draft') return { action: 'auto_sent', draftId: existing.id };
    draft = existing;
  } else {
    // one answer per conversation: a newer message in the thread retires the draft answering an earlier one, unless
    // the user already changed it (an edit moves updated_at on)
    await db.sql`
      update orbit.drafts d set status = 'cancelled', cancel_reason = 'superseded'
       where d.user_id = ${userId}::uuid and d.kind = 'reply' and d.status = 'draft'
         and d.updated_at < d.created_at + interval '2 seconds'
         and d.ask->>'replyToMessageId' in (
           select id::text from orbit.messages
            where user_id = ${userId}::uuid and thread_id = ${m.thread_id}::uuid and id <> ${m.id}::uuid)`;
    try {
      draft = (await draftReply(s, userId, m.id, 'agent')).draft;
    } catch (e) {
      if (e instanceof HttpError) return { action: 'none', reason: e.code };
      throw e;
    }
  }

  const [u] = await db.sql<{
    email: string;
    full_name: string | null;
    autonomy_level: number;
    timezone: string;
    settings: Record<string, unknown>;
  }>`
    select email, full_name, autonomy_level, timezone, settings from orbit.users where id = ${userId}::uuid`;
  const [p] = await db.sql<{
    timezone: string | null;
    title: string | null;
    headline: string | null;
    do_not_contact: boolean;
    score: number | null;
  }>`
    select p.timezone, p.title, p.headline, p.do_not_contact, ts.score::int as score
      from orbit.people p left join orbit.tie_scores ts on ts.person_id = p.id and ts.user_id = p.user_id
     where p.id = ${draft.person_id}::uuid`;
  const [g] = draft.goal_id
    ? await db.sql<{
        autonomy_level: number | null;
      }>`select autonomy_level from orbit.goals where id = ${draft.goal_id}::uuid`
    : [];
  const userTz = validZone(u!.timezone) ?? 'America/New_York';
  const dayStart = zonedTime(
    new Intl.DateTimeFormat('en-CA', { timeZone: userTz }).format(now),
    0,
    0,
    userTz,
  );
  const [today] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'draft.auto_approve' and created_at >= ${dayStart}::timestamptz`;
  const meta = (draft.ask ?? {}) as DraftMeta;
  const history = await historyWith(db, userId, draft.person_id);
  const level = (n: number | null | undefined) => (n === 0 || n === 1 || n === 2 ? n : undefined);
  const verdict = autonomyAllows(
    {
      kind: 'reply',
      channel: draft.channel,
      personId: draft.person_id,
      subject: draft.subject,
      body: draft.body,
    },
    {
      now,
      userEmails: [u!.email],
      userName: u!.full_name ?? '',
      recipient: {
        doNotContact: p?.do_not_contact,
        title: p?.title ?? undefined,
        headline: p?.headline ?? undefined,
      },
      history,
      schedulingLink:
        typeof u!.settings?.scheduling_link === 'string' ? u!.settings.scheduling_link : undefined,
      offeredSlots: meta.slots,
      timeZone: userTz,
      userAutonomy: level(u!.autonomy_level) ?? 0,
      goalAutonomy: level(g?.autonomy_level),
      replyClass: cls,
      inThread: !!draft.thread_external_id,
      recipientScore: p?.score ?? 0,
      validatorOk: !!draft.validator?.ok,
      autoSentToday: today?.n ?? 0,
      recipientTimeZone: validZone(p?.timezone) ?? userTz,
    },
  );
  if (!autoClass || !verdict.allowed)
    return { action: 'drafted', draftId: draft.id, reasons: autoClass ? verdict.reasons : [`class ${cls}`] };

  const [approved] = await db.sql<{ id: string }>`
    update orbit.drafts set status = 'approved', send_at = ${now}::timestamptz, autonomy_level = 2
     where id = ${draft.id}::uuid and status = 'draft' returning id`;
  if (!approved) return { action: 'drafted', draftId: draft.id, reasons: ['changed meanwhile'] };
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${draft.id},
            ${{ hash: messageHash({ channel: draft.channel, subject: draft.subject, body: draft.body }), reply_class: cls }}::jsonb)`;
  await s.queue.enqueue({
    kind: 'send.draft',
    userId,
    payload: { draftId: draft.id },
    dedupeKey: `send:${draft.id}`,
  });
  return { action: 'auto_sent', draftId: draft.id };
}
