/**
 * Replies (§8, plan 29 §B2.3): the list of inbound replies to the user's outreach, a reply drafted in their voice
 * (with free slots when they want to meet), and the next step per class, from the one class table in core
 * (`REPLY_NEXT_ACTION`): `maybeAutoReply` closes what should close (unsubscribe, decline: do_not_contact, the chat
 * declined, the student told, the breaker), raises Needs you for a question (no draft until the student answers),
 * drafts the classes that get a draft, and at autonomy level 2 approves for sending only what `autonomyAllows` says
 * may go on its own. `answerReply` takes the student's one line for a question and drafts the reply around it.
 */
import { holdsQuestion, REPLY_NEXT_ACTION } from '@orbit/core/email/nextAction';
import type { ReplyClass } from '@orbit/core/email/replyClass';
import { autonomyAllows, messageHash } from '@orbit/core/safety/rules';
import type { ReplyItem } from '@orbit/core/server/api';
import { stripQuotedReply } from '@orbit/core/text/email';
import { type ComposeResult, composeDraft, historyWith, loadReplyMessage } from '../compose/compose.ts';
import type { DraftMeta, DraftRow } from '../compose/drafts.ts';
import { askUserMarkers } from '../compose/prompts.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { firstNameOf, iso, num } from '../rows.ts';
import { type AgentConfig, makeServices, type Services } from '../services.ts';
import { moveChat } from '../slots/slots.ts';
import { validZone, zonedTime } from '../zones.ts';
import { DECLINES_PER_DAY, declinesToday, pushbackOnAutoFirst, tripBreaker } from './breaker.ts';
import { mailIfAway, raiseCard, settleCard } from './cards.ts';

export const REPLY_WINDOW_DAYS = 30;

/** The dedupe key of the Needs you card for one reply. */
export const needsYouKey = (messageId: string) => `needs_you:${messageId}`;

/** Inbound replies with a class, newest first, last 30 days, with the person, thread and any draft answering it. */
export async function listReplies(db: Db, userId: string, now: Date): Promise<ReplyItem[]> {
  const rows = await db.sql<{
    id: string;
    thread_external_id: string;
    from_person_id: string | null;
    display_name: string | null;
    org_raw: string | null;
    org_name: string | null;
    from_addr: string | null;
    provider: 'gmail' | 'linkedin';
    reply_class: ReplyClass;
    reply_confidence: number | null;
    sent_at: Date;
    snippet: string | null;
    body_text: string | null;
    extraction: Record<string, unknown> | null;
    answer: string | null;
    draft_id: string | null;
    outcome: string | null;
    offered: { draftId: string; slots: unknown } | null;
  }>`
    select m.id, t.external_id as thread_external_id, m.from_person_id, p.display_name, p.org_raw, o.name as org_name,
           m.from_addr, m.provider, m.reply_class, m.reply_confidence, m.sent_at, m.snippet, m.body_text, m.extraction,
           m.answer,
           (select d.id from orbit.drafts d
             where d.user_id = m.user_id and d.ask->>'replyToMessageId' = m.id::text
               and d.status not in ('discarded', 'cancelled')
             order by d.created_at desc limit 1) as draft_id,
           (select d.outcome from orbit.drafts d
             where d.user_id = m.user_id and d.status = 'sent' and d.replied_at = m.sent_at
               and d.person_id = m.from_person_id
             order by d.sent_at desc limit 1) as outcome,
           (select jsonb_build_object('draftId', d.id, 'slots', coalesce(d.offered_slots, d.ask->'slots'))
              from orbit.drafts d
             where d.user_id = m.user_id and d.status = 'sent' and d.person_id = m.from_person_id
               and d.sent_at <= m.sent_at and (d.offered_slots is not null or d.ask->'slots' is not null)
             order by d.sent_at desc limit 1) as offered
      from orbit.messages m
      join orbit.threads t on t.id = m.thread_id
      left join orbit.people p on p.id = m.from_person_id
      left join orbit.organizations o on o.id = p.org_id
     where m.user_id = ${userId}::uuid and m.direction = 'in' and m.reply_class is not null
       and m.sent_at >= ${new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000)}::timestamptz
     order by m.sent_at desc
     limit 200`;
  return rows.map((r) => ({
    messageId: r.id,
    threadId: r.thread_external_id,
    personId: r.from_person_id,
    personName: r.display_name ?? r.from_addr?.split('@')[0] ?? 'Someone',
    company: r.org_name ?? r.org_raw ?? null,
    channel: r.provider,
    replyClass: r.reply_class,
    confidence: num(r.reply_confidence),
    receivedAt: iso(r.sent_at)!,
    snippet: (r.snippet ?? r.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    draftId: r.draft_id,
    question: questionOf(r.extraction, r.body_text ?? r.snippet ?? ''),
    answer: r.answer,
    outcome: (r.outcome as ReplyItem['outcome']) ?? null,
    offered:
      r.offered && Array.isArray(r.offered.slots) && r.offered.slots.length
        ? {
            draftId: r.offered.draftId,
            slots: r.offered.slots.filter((x): x is string => typeof x === 'string'),
          }
        : null,
  }));
}

/** The question a reply asked, from the classifier's extraction, else the first sentence ending in a question mark. */
export function questionOf(extraction: Record<string, unknown> | null, text: string): string | null {
  const llm = (extraction?.llm as { question?: string | null } | undefined)?.question;
  if (typeof llm === 'string' && llm.trim()) return llm.trim();
  const own = extraction?.question;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const body = stripQuotedReply(text);
  const sentence = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .find((s) => s.endsWith('?'));
  return sentence ?? (holdsQuestion(body) ? body.trim().slice(0, 200) : null);
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

/** Classes that get a draft answer without being asked: the class table's rows with `drafts` (plan 29 §B2.3). */
export const DRAFT_CLASSES: ReadonlySet<ReplyClass> = new Set(
  (Object.keys(REPLY_NEXT_ACTION) as ReplyClass[]).filter((c) => REPLY_NEXT_ACTION[c].drafts),
);

export type AutoReplyOutcome =
  | { action: 'none'; reason: string }
  | { action: 'unsubscribed' }
  | { action: 'closed'; reason: 'decline' }
  | { action: 'needs_you'; suggestionId: string }
  | { action: 'drafted'; draftId: string; reasons: string[] }
  | { action: 'auto_sent'; draftId: string };

/**
 * After a reply is classified (classify.message calls this, and funnel.reply for interested and scheduling): the
 * class table's next step. Unsubscribe and decline close the person's chats, cancel their drafts, mark do not contact,
 * tell the student and check the breaker; a question raises Needs you and drafts nothing; a class with a draft gets
 * one (unless the message was read from the user's history, before Orbit; a newer message in the thread retires the
 * untouched draft answering an earlier one); and at level 2 a draft the table lets go on its own, when every §8.4
 * condition holds, is approved by the agent and queued to send. Idempotent per message.
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
  const step = REPLY_NEXT_ACTION[cls];
  // a decline or a concern answering one of autopilot's own first messages pauses that goal's first messages at once
  if (!deps.history) await pushbackOnAutoFirst(db, userId, m, now);

  if (cls === 'decline' || cls === 'unsubscribe') {
    if (m.from_person_id) await closeOnReply(s, userId, m.id, m.from_person_id, cls, now, deps.history);
    return cls === 'unsubscribe' ? { action: 'unsubscribed' } : { action: 'closed', reason: 'decline' };
  }
  if (!m.from_person_id) return { action: 'none', reason: 'unknown_sender' };
  // it came before Orbit: the user dealt with it then, or can ask for a draft from the replies list
  if (deps.history) return { action: 'none', reason: 'history' };

  if (step.action === 'needs_you') {
    const [full] = await db.sql<{
      body_text: string | null;
      snippet: string | null;
      extraction: unknown;
      answer: string | null;
    }>`
      select body_text, snippet, extraction, answer from orbit.messages where id = ${m.id}::uuid`;
    // answered already: the answer drafts the reply (answerReply did, or does now)
    if (full?.answer) return { action: 'none', reason: 'answered' };
    const id = await raiseNeedsYou(s, userId, {
      messageId: m.id,
      personId: m.from_person_id,
      question:
        questionOf(
          full?.extraction as Record<string, unknown> | null,
          full?.body_text ?? full?.snippet ?? '',
        ) ?? 'They asked you something.',
      now,
    });
    return { action: 'needs_you', suggestionId: id };
  }
  // thanks needs no answer beyond the table's acknowledgement; an out-of-office is followed up by cadence after the
  // return date; "other" waits for the student to ask
  if (!step.drafts) return { action: 'none', reason: `class ${cls}` };

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
  return approveIfAllowed(s, userId, draft, cls, now);
}

/**
 * At level 2 (the goal's level when it has one), approve a reply draft the table lets go on its own, when every
 * §8.4 condition holds, and queue it to send. Otherwise the draft waits for the student with the reasons.
 */
export async function approveIfAllowed(
  s: Services,
  userId: string,
  draft: DraftRow,
  cls: ReplyClass,
  now: Date,
  extra: { offeredSlots?: string[] } = {},
): Promise<AutoReplyOutcome> {
  const db = s.db;
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
  const replyTo = meta.replyToMessageId
    ? (
        await db.sql<{ body_text: string | null; snippet: string | null }>`
          select body_text, snippet from orbit.messages where id = ${meta.replyToMessageId}::uuid`
      )[0]
    : undefined;
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
      offeredSlots: [...(meta.slots ?? []), ...(extra.offeredSlots ?? [])],
      timeZone: userTz,
      userAutonomy: level(u!.autonomy_level) ?? 0,
      goalAutonomy: level(g?.autonomy_level),
      replyClass: cls,
      replyHoldsQuestion: holdsQuestion(replyTo?.body_text ?? replyTo?.snippet ?? ''),
      inThread: !!draft.thread_external_id,
      recipientScore: p?.score ?? 0,
      validatorOk: !!draft.validator?.ok,
      autoSentToday: today?.n ?? 0,
      recipientTimeZone: validZone(p?.timezone) ?? userTz,
    },
  );
  const reasons = [...verdict.reasons];
  // the account's pause (plan 29 §B2.7)
  const paused = u!.settings?.autopilot_paused_until;
  if (typeof paused === 'string' && new Date(paused).getTime() > now.getTime())
    reasons.push('autopilot paused');
  // the breaker's goal pause holds outreach only (breakerHolds): a reply to someone who wrote back still finishes
  if (askUserMarkers(`${draft.subject ?? ''}\n${draft.body}`).length) reasons.push('needs_input');
  if (reasons.length) return { action: 'drafted', draftId: draft.id, reasons: [...new Set(reasons)] };

  const [approved] = await db.sql<{ id: string }>`
    update orbit.drafts set status = 'approved', send_at = ${now}::timestamptz, autonomy_level = 2,
                            auto_rung = ${cls === 'scheduling' ? 'schedule' : 'reply'}
     where id = ${draft.id}::uuid and status = 'draft' returning id`;
  if (!approved) return { action: 'drafted', draftId: draft.id, reasons: ['changed meanwhile'] };
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${draft.id},
            ${{ hash: messageHash({ channel: draft.channel, subject: draft.subject, body: draft.body }), reply_class: cls }}::jsonb)`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'agent', 'reply.auto', 'drafts', ${draft.id}, ${{ reply_class: cls }}::jsonb)`;
  await s.queue.enqueue({
    kind: 'send.draft',
    userId,
    payload: { draftId: draft.id },
    dedupeKey: `send:${draft.id}`,
  });
  return { action: 'auto_sent', draftId: draft.id };
}

/**
 * A decline or an unsubscribe (plan 29 §B2.3): the person is not written to again, their open drafts are cancelled,
 * their chats move to declined, the student is told through a card, and the breaker looks at it (an unsubscribe trips
 * it at once, a decline when it is the second today for that goal). A reply read from the history still closes, but
 * raises no card and trips nothing: it was dealt with before Orbit.
 */
export async function closeOnReply(
  s: Services,
  userId: string,
  messageId: string,
  personId: string,
  cls: 'decline' | 'unsubscribe',
  now: Date,
  history = false,
): Promise<void> {
  const db = s.db;
  const reason = cls === 'unsubscribe' ? 'asked not to be contacted' : 'declined';
  const [p] = await db.sql<{
    display_name: string;
    first_name: string | null;
    org_raw: string | null;
    org_name: string | null;
    do_not_contact: boolean;
  }>`
    select p.display_name, p.first_name, p.org_raw, o.name as org_name, p.do_not_contact
      from orbit.people p left join orbit.organizations o on o.id = p.org_id
     where p.id = ${personId}::uuid and p.user_id = ${userId}::uuid`;
  if (!p) return;
  if (!p.do_not_contact) {
    await db.sql`update orbit.people set do_not_contact = true where id = ${personId}::uuid and user_id = ${userId}::uuid`;
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'agent', 'person.do_not_contact', 'people', ${personId}, ${{ source: 'reply', reply_class: cls }}::jsonb)`;
  }
  await db.sql`
    update orbit.drafts set status = 'cancelled', cancel_reason = ${cls}
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid
       and status in ('draft', 'approved', 'scheduled')`;
  const chats = await db.sql<{ id: string; goal_id: string | null }>`
    select id, goal_id from orbit.chats where user_id = ${userId}::uuid and person_id = ${personId}::uuid
       and archived_at is null`;
  for (const c of chats) await moveChat(db, userId, c.id, 'declined', reason, now);
  if (history) return;
  const goalId = chats.find((c) => c.goal_id)?.goal_id ?? null;
  const company = p.org_name ?? p.org_raw ?? null;
  await raiseCard(db, userId, {
    kind: 'needs_you',
    dedupeKey: `closed:${messageId}`,
    reasonText:
      cls === 'unsubscribe'
        ? `${p.display_name} asked to stop. Orbit closed the thread and will not write to them again.`
        : `${p.display_name} declined. Orbit closed the thread and will not write to them again.`,
    personId,
    chatId: chats[0]?.id ?? null,
    messageId,
    signals: { replyClass: cls, closed: true },
    payload: { replyClass: cls, closed: true, personName: p.display_name, company },
    priority: 0.6,
    now,
    notify: {
      kind: 'reply_received',
      title: `${p.display_name} ${cls === 'unsubscribe' ? 'asked to stop' : 'declined'}`,
      link: `/people/${personId}`,
    },
  });
  // the breaker (plan 29 §B2.7)
  const userTz = validZone(
    (await db.sql<{ timezone: string }>`select timezone from orbit.users where id = ${userId}::uuid`)[0]
      ?.timezone,
  );
  const dayStart = zonedTime(
    new Intl.DateTimeFormat('en-CA', { timeZone: userTz ?? 'America/New_York' }).format(now),
    0,
    0,
    userTz ?? 'America/New_York',
  );
  const trips =
    cls === 'unsubscribe' || (await declinesToday(db, userId, goalId, dayStart)) >= DECLINES_PER_DAY;
  if (trips)
    await tripBreaker(db, userId, {
      goalId,
      reason: cls === 'unsubscribe' ? 'unsubscribe' : 'declines',
      personId,
      personName: p.display_name,
      company,
      messageId,
      now,
    });
}

/** Needs you (plan 29 §B2.3): the card with the question, a notification, and the email when the app is closed. */
export async function raiseNeedsYou(
  s: Services,
  userId: string,
  p: { messageId: string; personId: string; question: string; now: Date },
): Promise<string> {
  const [person] = await s.db.sql<{
    display_name: string;
    first_name: string | null;
    org_raw: string | null;
  }>`
    select display_name, first_name, org_raw from orbit.people where id = ${p.personId}::uuid`;
  const name = person?.display_name ?? 'They';
  const first = person
    ? firstNameOf({ first_name: person.first_name, display_name: person.display_name })
    : 'They';
  const [chat] = await s.db.sql<{ id: string }>`
    select id from orbit.chats where user_id = ${userId}::uuid and person_id = ${p.personId}::uuid and archived_at is null
     order by updated_at desc limit 1`;
  const question = p.question.replace(/\s+/g, ' ').trim().slice(0, 300);
  const id = await raiseCard(s.db, userId, {
    kind: 'needs_you',
    dedupeKey: needsYouKey(p.messageId),
    reasonText: `${name} asked: "${question}" What should I say?`,
    personId: p.personId,
    chatId: chat?.id ?? null,
    messageId: p.messageId,
    signals: { replyClass: 'question' },
    payload: { question, personName: name, replyClass: 'question' },
    priority: 0.85,
    now: p.now,
    notify: {
      kind: 'reply_received',
      title: `${first} asked one thing`,
      body: 'Answer it in one line and Orbit drafts the reply.',
      link: '/inbox?tab=needs_you',
    },
  });
  await mailIfAway(s, userId, { personFirstName: first, now: p.now }).catch(() => undefined);
  return id;
}

/**
 * POST /replies/answer (plan 29 §B2.3): the student's one line answers what a reply asked. The answer is kept on the
 * message, the Needs you card is done, any draft still asking for it is retired, and the reply is drafted around the
 * answer (the compose prompt carries it; the template writes it in). Never sent on its own: the draft waits for the
 * student's approval, with the answer shown in place.
 */
export async function answerReply(
  s: Services,
  userId: string,
  req: { draftId?: string; messageId?: string; answer: string },
): Promise<ComposeResult> {
  const db = s.db;
  const answer = req.answer.replace(/\s+/g, ' ').trim();
  if (!answer) throw new HttpError(400, 'bad_request', 'an answer is needed');
  if (answer.length > 600) throw new HttpError(400, 'bad_request', 'keep the answer under 600 characters');
  let messageId = req.messageId;
  if (!messageId && req.draftId) {
    const [d] = await db.sql<{ ask: DraftMeta | null }>`
      select ask from orbit.drafts where id = ${req.draftId}::uuid and user_id = ${userId}::uuid`;
    if (!d) throw new HttpError(404, 'not_found', 'no such draft');
    messageId = d.ask?.replyToMessageId;
  }
  if (!messageId) throw new HttpError(400, 'bad_request', 'draftId or messageId is required');
  const m = await loadReplyMessage(db, userId, messageId);
  if (!m.from_person_id) throw new HttpError(409, 'unknown_sender', 'Orbit does not know who sent this yet');
  const now = s.now();
  await db.sql`
    update orbit.messages set answer = ${answer}, answered_at = ${now}::timestamptz
     where id = ${m.id}::uuid and user_id = ${userId}::uuid`;
  // the drafts that were waiting on the answer step aside for the one written around it
  await db.sql`
    update orbit.drafts set status = 'cancelled', cancel_reason = 'answered'
     where user_id = ${userId}::uuid and status = 'draft' and ask->>'replyToMessageId' = ${m.id}
       and (cardinality(needs) > 0 or body ~ '\\[ASK USER')`;
  await settleCard(db, userId, needsYouKey(m.id), 'done', now);
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'reply.answer', 'messages', ${m.id}, ${{ chars: answer.length }}::jsonb)`;
  return draftReply(s, userId, m.id, 'user');
}
