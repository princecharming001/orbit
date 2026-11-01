/**
 * Autopilot on the server (plan 29 §B4): the mode, what is queued for the morning, held, sent today on Orbit's own,
 * the replies that need the student, the rungs as the server can count them, the caps, and the two taps that change
 * it: hold one send, pause everything or one goal. Phase 3 builds this for the replies; phase 5 adds tomorrow's first
 * messages to the same shapes.
 */
import {
  AUTO_FIRST_TOUCH_KINDS,
  type FirstTouchRung,
  type FirstTouchSkipRule,
  firstTouchRung,
  skipReason,
} from '@orbit/core/safety/firstTouch';
import {
  AUTO_FIRST_TOUCH_RUNG,
  AUTOPILOT_MODE_LEVEL,
  type AutopilotMode,
  REVIEW_WINDOW_HOURS,
  SEND_CAPS,
} from '@orbit/core/safety/rules';
import type {
  AutopilotFriendAsk,
  AutopilotItem,
  AutopilotRung,
  AutopilotSkip,
  AutopilotStatus,
} from '@orbit/core/server/api';
import { VOICE_HOLD_REASON } from '@orbit/core/style/voice';
import type { MessageKind } from '@orbit/core/types';
import type { DraftMeta } from '../compose/drafts.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { type GoalPause, pausedGoalsOf, setGoalPause } from '../replies/breaker.ts';
import { questionOf } from '../replies/replies.ts';
import { iso } from '../rows.ts';
import { validZone, zonedTime } from '../zones.ts';

const FIRST_TOUCH: string[] = [...AUTO_FIRST_TOUCH_KINDS];

/** Approvals without an edit that unlock a rung: the ladder's kinds at ten, first messages at twenty (plan 29 §B2.2). */
export const RUNG_NEEDED: Record<AutopilotRung['kind'], number> = {
  bump: 10,
  thank_you: 10,
  schedule: 10,
  first_touch: AUTO_FIRST_TOUCH_RUNG,
};

/** Why a draft was held, in a sentence the student reads. */
export const HOLD_REASONS: Record<string, string> = {
  review_window: 'It waits for your evening review.',
  autopilot_paused: 'Autopilot is paused.',
  goal_paused: 'The breaker paused this goal.',
  held: 'You held it.',
  needs_input: 'It needs one answer from you.',
  needs_tap:
    'It waited for your tap. Until twenty first messages go out as Orbit wrote them, each one in the evening batch needs one.',
  not_approved: 'It was never approved.',
  linkedin_never_auto: 'LinkedIn messages always wait for your own tap.',
  auto_daily_cap: `Orbit already sent ${SEND_CAPS.autoPerDay} on its own today.`,
  auto_first_touch_daily_cap: `Orbit already sent ${SEND_CAPS.autoFirstTouchesPerDay} first messages on its own today.`,
  auto_first_touch_weekly_cap: `Orbit already sent ${SEND_CAPS.autoFirstTouchesPerWeek} first messages on its own this week.`,
  gmail_daily_cap: `Your ${SEND_CAPS.gmailPerDay} emails a day are used up.`,
  validator: 'Orbit wrote it, but it did not pass its own checks, so it waits for you to read it.',
  no_hook: 'Orbit found nothing researched about them to open with, so it waits for you.',
  voice: `It ${VOICE_HOLD_REASON}, so it waits for your tap.`,
  same_firm_today:
    'Someone at the same firm got a first message this morning, so this one moved to the next morning.',
};

/**
 * Why a draft was held, in a sentence: the table above, or for a first message the rule that no longer holds
 * (`first_touch:<rule>`), said with the person's name the way the plan says it.
 */
export function holdReason(
  r: Pick<ItemRow, 'error' | 'display_name' | 'org_name' | 'org_raw'>,
): string | undefined {
  const e = r.error ?? '';
  if (e.startsWith('first_touch:'))
    return skipReason(e.slice('first_touch:'.length) as FirstTouchSkipRule, {
      name: r.display_name,
      company: r.org_name ?? r.org_raw,
    });
  return HOLD_REASONS[e] ?? (e || undefined);
}

type ItemRow = {
  id: string;
  person_id: string;
  display_name: string;
  org_raw: string | null;
  org_name: string | null;
  kind: string;
  reply_class: string | null;
  subject: string | null;
  send_at: Date | null;
  sent_at: Date | null;
  status: string;
  error: string | null;
  auto_rung: string | null;
  outcome: string | null;
  ask: DraftMeta | null;
  /** the student approved it by hand (a tap in the evening batch, or any approval of theirs) */
  tapped: boolean;
};

/**
 * The drafts one status list is made of, by kind of list: queued (what Orbit chose a time for and has not sent),
 * held (a draft the send job or the student put back, with the reason, in the last two days), sent (today, on Orbit's
 * own), or one draft by id.
 */
async function itemRows(
  db: Db,
  userId: string,
  mode: 'queued' | 'held' | 'sent' | 'one',
  now: Date,
  dayStart: Date,
  draftId?: string,
): Promise<ItemRow[]> {
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  return db.sql<ItemRow>`
    select d.id, d.person_id, p.display_name, p.org_raw, o.name as org_name, d.kind, d.subject, d.send_at, d.sent_at,
           d.status, d.error, d.auto_rung, d.outcome, d.ask,
           (select m.reply_class from orbit.messages m where m.id::text = d.ask->>'replyToMessageId') as reply_class,
           exists (select 1 from orbit.audit_log a where a.target_table = 'drafts' and a.target_id = d.id::text
                    and a.action = 'draft.approve' and a.actor = 'user') as tapped
      from orbit.drafts d
      join orbit.people p on p.id = d.person_id
      left join orbit.organizations o on o.id = p.org_id
     where d.user_id = ${userId}::uuid
       and ((${mode}::text = 'queued' and d.status in ('approved', 'scheduled')
               and d.send_at is not null and d.send_at > ${now}::timestamptz
               and (d.auto_rung is not null or d.autonomy_level >= 1))
         or (${mode}::text = 'held' and d.status = 'draft' and d.error is not null
               and d.updated_at >= ${twoDaysAgo}::timestamptz
               and (d.auto_rung is not null or d.autonomy_level >= 1 or d.error = 'held'))
         or (${mode}::text = 'sent' and d.status = 'sent' and d.sent_at >= ${dayStart}::timestamptz
               and exists (select 1 from orbit.audit_log a where a.target_table = 'drafts' and a.target_id = d.id::text
                            and a.action = 'draft.auto_sent'))
         or (${mode}::text = 'one' and d.id = ${draftId ?? null}::uuid))
     order by case when ${mode}::text = 'queued' then d.send_at end asc,
              case when ${mode}::text = 'held' then d.updated_at end desc,
              case when ${mode}::text = 'sent' then d.sent_at end desc
     limit 50`;
}

function item(r: ItemRow, status: AutopilotItem['status'], reason?: string): AutopilotItem {
  return {
    draftId: r.id,
    personId: r.person_id,
    personName: r.display_name,
    company: r.org_name ?? r.org_raw ?? null,
    kind: r.kind as MessageKind,
    ...(r.reply_class ? { replyClass: r.reply_class as AutopilotItem['replyClass'] } : {}),
    subject: r.subject,
    sendAt: iso(r.send_at),
    sentAt: iso(r.sent_at),
    status,
    ...(reason ? { reason } : {}),
    ...(r.auto_rung ? { autoRung: r.auto_rung as AutopilotRung['kind'] } : {}),
    ...(r.outcome ? { outcome: r.outcome as AutopilotItem['outcome'] } : {}),
    ...(r.ask?.replyToMessageId ? { messageId: r.ask.replyToMessageId } : {}),
  };
}

function modeOf(settings: Record<string, unknown>, level: number): AutopilotMode {
  const m = settings.autopilot_mode;
  if (m === 'off' || m === 'assist' || m === 'autopilot') return m;
  return level >= 2 ? 'autopilot' : level === 1 ? 'assist' : 'off';
}

/**
 * A queued draft as the batch shows it: an autopilot first message before the rung is earned, and not tapped yet,
 * waits for the student's tap (`needs_tap`); everything else is simply queued.
 */
function queuedStatus(r: ItemRow, rung: FirstTouchRung): AutopilotItem['status'] {
  return r.auto_rung === 'first_touch' && !rung.earned && !r.tapped ? 'needs_tap' : 'queued';
}

/**
 * The first-message rung as the server counts it (plan 29 §B2.2): first messages that went out on the student's own
 * approval with the words Orbit wrote. Unchanged means no `orbit.draft_edits` row for the draft when that table exists
 * (the voice phase writes one for every edited approval); before it does, the approved words' hash equals the hash
 * the compose step recorded. A draft composed before hashes were recorded does not count, so the rung never
 * credits an edit it cannot see.
 */
export async function firstTouchRungOf(db: Db, userId: string): Promise<FirstTouchRung> {
  const [t] = await db.sql<{ has: boolean }>`select to_regclass('orbit.draft_edits') is not null as has`;
  const rows = t?.has
    ? await db.sql<{ kind: string; edited: boolean }>`
        select d.kind,
               exists (select 1 from orbit.draft_edits e where e.draft_id = d.id) as edited
          from orbit.drafts d
         where d.user_id = ${userId}::uuid and d.status = 'sent' and d.kind = any(${FIRST_TOUCH}::text[])
           and exists (select 1 from orbit.audit_log a where a.target_table = 'drafts' and a.target_id = d.id::text
                        and a.action = 'draft.approve' and a.actor = 'user')`
    : await db.sql<{ kind: string; edited: boolean }>`
        select d.kind,
               not exists (
                 select 1 from orbit.audit_log a
                   join orbit.audit_log c on c.target_table = 'drafts' and c.target_id = a.target_id
                                         and c.action = 'draft.compose' and c.details->>'hash' = a.details->>'hash'
                  where a.target_table = 'drafts' and a.target_id = d.id::text
                    and a.action = 'draft.approve' and a.actor = 'user') as edited
          from orbit.drafts d
         where d.user_id = ${userId}::uuid and d.status = 'sent' and d.kind = any(${FIRST_TOUCH}::text[])
           and exists (select 1 from orbit.audit_log a where a.target_table = 'drafts' and a.target_id = d.id::text
                        and a.action = 'draft.approve' and a.actor = 'user')`;
  return firstTouchRung(rows.map((r) => ({ kind: r.kind, edited: r.edited })));
}

export async function autopilotStatus(db: Db, userId: string, now: Date): Promise<AutopilotStatus> {
  const [u] = await db.sql<{ timezone: string; autonomy_level: number; settings: Record<string, unknown> }>`
    select timezone, autonomy_level, settings from orbit.users where id = ${userId}::uuid`;
  if (!u) throw new HttpError(404, 'not_found', 'no such user');
  const tz = validZone(u.timezone) ?? 'America/New_York';
  const dayStart = zonedTime(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now), 0, 0, tz);
  const weekStart = new Date(dayStart.getTime() - 6 * 86_400_000);
  const settings = u.settings ?? {};

  // queued: what Orbit chose a time for (its own approval, or a level 1 or 2 window) and has not sent yet
  const queued = await itemRows(db, userId, 'queued', now, dayStart);
  const held = await itemRows(db, userId, 'held', now, dayStart);
  const sentToday = await itemRows(db, userId, 'sent', now, dayStart);
  // replies that asked something only the student knows, unanswered
  const questions = await db.sql<{
    id: string;
    person_id: string;
    display_name: string;
    org_raw: string | null;
    org_name: string | null;
    sent_at: Date;
    body_text: string | null;
    snippet: string | null;
    extraction: Record<string, unknown> | null;
    subject: string | null;
    draft_id: string | null;
  }>`
    select m.id, m.from_person_id as person_id, p.display_name, p.org_raw, o.name as org_name, m.sent_at, m.body_text,
           m.snippet, m.extraction, m.subject,
           (select d.id from orbit.drafts d where d.user_id = m.user_id and d.ask->>'replyToMessageId' = m.id::text
              and d.status not in ('discarded', 'cancelled') order by d.created_at desc limit 1) as draft_id
      from orbit.messages m
      join orbit.people p on p.id = m.from_person_id
      left join orbit.organizations o on o.id = p.org_id
     where m.user_id = ${userId}::uuid and m.direction = 'in' and m.reply_class = 'question' and m.answer is null
       and m.sent_at >= ${new Date(now.getTime() - 30 * 86_400_000)}::timestamptz
       and not p.do_not_contact
     order by m.sent_at desc limit 20`;
  const needsYou: AutopilotItem[] = questions.map((q) => ({
    draftId: q.draft_id ?? q.id,
    personId: q.person_id,
    personName: q.display_name,
    company: q.org_name ?? q.org_raw ?? null,
    kind: 'reply',
    replyClass: 'question',
    subject: q.subject,
    sendAt: null,
    sentAt: null,
    status: 'needs_you',
    question: questionOf(q.extraction, q.body_text ?? q.snippet ?? '') ?? 'They asked you something.',
    messageId: q.id,
  }));

  // the rungs, as the server can count them: approvals by hand of each kind that went out; the ladder's kinds count
  // as unlocked once the student handed them over, first messages once twenty went out unchanged (plan 29 §B2.2)
  const approvals = await db.sql<{ kind: string; n: number }>`
    select d.kind, count(*)::int as n from orbit.drafts d
     where d.user_id = ${userId}::uuid and d.status = 'sent' and d.auto_rung is null
       and exists (select 1 from orbit.audit_log a where a.target_table = 'drafts' and a.target_id = d.id::text
                    and a.action = 'draft.approve')
     group by d.kind`;
  const count = (kinds: string[]) =>
    approvals.filter((a) => kinds.includes(a.kind)).reduce((s, a) => s + a.n, 0);
  const autoKinds = Array.isArray(settings.auto_kinds) ? (settings.auto_kinds as string[]) : [];
  const first = await firstTouchRungOf(db, userId);
  const rungs: AutopilotRung[] = (['bump', 'thank_you', 'schedule', 'first_touch'] as const).map((kind) => {
    if (kind === 'first_touch')
      return { kind, needed: first.needed, unchanged: first.unchanged, unlocked: first.earned };
    const needed = RUNG_NEEDED[kind];
    return {
      kind,
      needed,
      unchanged: Math.min(needed, count([kind])),
      unlocked: autoKinds.includes(kind),
    };
  });

  const [caps] = await db.sql<{ day: number; week_first: number }>`
    select count(*) filter (where created_at >= ${dayStart}::timestamptz)::int as day,
           count(*) filter (where details->>'kind' in ('first_touch', 'warm_first_touch', 'outreach'))::int as week_first
      from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'draft.auto_sent' and created_at >= ${weekStart}::timestamptz`;
  const pausedUntil =
    typeof settings.autopilot_paused_until === 'string' &&
    new Date(settings.autopilot_paused_until).getTime() > now.getTime()
      ? settings.autopilot_paused_until
      : null;
  const goalPauses = pausedGoalsOf(settings);
  const goalIds = Object.keys(goalPauses);
  const titles = goalIds.length
    ? await db.sql<{ id: string; title: string }>`
        select id, title from orbit.goals where user_id = ${userId}::uuid and id = any(${goalIds}::uuid[])`
    : [];
  const pausedGoals = goalIds
    .filter((id) => {
      const p = goalPauses[id]!;
      return p.until === null || new Date(p.until).getTime() > now.getTime();
    })
    .map((id) => ({
      goalId: id,
      title: titles.find((t) => t.id === id)?.title ?? 'a goal',
      until: goalPauses[id]!.until,
      reason: goalPauses[id]!.text,
    }));
  const reviews = queued.map((q) => q.send_at).filter((x): x is Date => !!x);
  const plan = await planCards(db, userId, now);
  return {
    mode: modeOf(settings, Number(u.autonomy_level) || 0),
    pausedUntil,
    pausedGoals,
    queued: queued.map((r) => item(r, queuedStatus(r, first))),
    held: held.map((r) => item(r, 'held', holdReason(r))),
    sentToday: sentToday.map((r) => item(r, 'sent')),
    needsYou,
    rungs,
    caps: {
      autoPerDay: SEND_CAPS.autoPerDay,
      firstTouchPerWeek: SEND_CAPS.autoFirstTouchesPerWeek,
      firstTouchPerDay: SEND_CAPS.autoFirstTouchesPerDay,
      usedToday: caps?.day ?? 0,
      firstTouchesThisWeek: caps?.week_first ?? 0,
    },
    reviewUntil: reviews.length
      ? iso(
          new Date(Math.min(...reviews.map((d) => new Date(d).getTime())) - REVIEW_WINDOW_HOURS * 3_600_000),
        )
      : null,
    ...plan,
  };
}

/**
 * What the plan step left for the status (plan 29 §B4): who it left out and why (the newest plan, in the last day and
 * a half), the asks to friends it drafted, and tonight's batch card.
 */
async function planCards(
  db: Db,
  userId: string,
  now: Date,
): Promise<Pick<AutopilotStatus, 'skipped' | 'friendAsks' | 'batch' | 'week'>> {
  const [plan] = await db.sql<{ details: { skipped?: Omit<AutopilotSkip, 'at'>[] }; created_at: Date }>`
    select details, created_at from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'autopilot.plan'
       and created_at >= ${new Date(now.getTime() - 36 * 3_600_000)}::timestamptz
     order by created_at desc limit 1`;
  const skipped: AutopilotSkip[] = (plan?.details?.skipped ?? []).map((x) => ({
    ...x,
    at: iso(plan!.created_at)!,
  }));
  const cards = await db.sql<{
    id: string;
    kind: string;
    reason_text: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>`
    select id, kind, reason_text, payload, created_at from orbit.suggestions
     where user_id = ${userId}::uuid and status = 'pending' and kind in ('friend_ask_ready', 'batch_ready')
       and expires_at > ${now}::timestamptz
     order by created_at desc limit 20`;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const friendAsks: AutopilotFriendAsk[] = cards
    .filter((c) => c.kind === 'friend_ask_ready')
    .map((c) => ({
      id: c.id,
      friendUserId: str(c.payload.friendUserId) ?? '',
      friendName: str(c.payload.friendName) ?? 'your friend',
      targetPersonId: str(c.payload.targetPersonId) ?? '',
      targetName: str(c.payload.targetName) ?? 'them',
      company: str(c.payload.company),
      note: str(c.payload.note) ?? '',
      goalId: str(c.payload.goalId),
    }));
  const b = cards.find(
    (c) => c.kind === 'batch_ready' && now.getTime() - new Date(c.created_at).getTime() < 18 * 3_600_000,
  );
  // the last seven days on autopilot, for the weekly review (plan 29 §B1)
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [w] = await db.sql<{ sent: number; replies: number; calls: number }>`
    select count(*) filter (where a.action = 'draft.auto_sent')::int as sent,
           count(*) filter (where a.action = 'draft.auto_sent'
                              and exists (select 1 from orbit.drafts d where d.id::text = a.target_id
                                           and (d.replied_at is not null or d.outcome in ('replied', 'booked'))))::int as replies,
           count(*) filter (where a.action = 'call.booked')::int as calls
      from orbit.audit_log a
     where a.user_id = ${userId}::uuid and a.action in ('draft.auto_sent', 'call.booked')
       and a.created_at >= ${since}::timestamptz`;
  const trips = await db.sql<{ company: string | null; title: string | null }>`
    select s.payload->>'company' as company, g.title
      from orbit.suggestions s
      left join orbit.goals g on g.id::text = s.payload->>'goalId'
     where s.user_id = ${userId}::uuid and s.kind = 'breaker' and s.created_at >= ${since}::timestamptz`;
  const week = {
    sent: w?.sent ?? 0,
    replies: w?.replies ?? 0,
    calls: w?.calls ?? 0,
    pushbacks: trips.length,
    paused: [...new Set(trips.map((t) => t.company ?? t.title).filter((x): x is string => !!x))],
  };
  return {
    skipped,
    friendAsks,
    week,
    batch: b
      ? { at: iso(b.created_at)!, text: b.reason_text, firstTouches: Number(b.payload.firstTouches) || 0 }
      : null,
  };
}

/**
 * POST /autopilot/dismiss {id}: the student set a plan card aside (an ask to a friend they will not send, tonight's
 * batch card read). The ask is never drafted again for that contact.
 */
export async function dismissPlanCard(
  db: Db,
  userId: string,
  id: string,
  now: Date,
): Promise<{ id: string }> {
  const [row] = await db.sql<{ id: string }>`
    update orbit.suggestions set status = 'dismissed', decided_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
     where id = ${id}::uuid and user_id = ${userId}::uuid and kind in ('friend_ask_ready', 'batch_ready')
       and status in ('pending', 'snoozed')
    returning id`;
  if (!row) throw new HttpError(404, 'not_found', 'no such card');
  return { id: row.id };
}

/** POST /autopilot/hold: a queued send goes back to a draft, held by the student; the batch goes without it. */
export async function holdSend(db: Db, userId: string, draftId: string, now: Date): Promise<AutopilotItem> {
  const [row] = await itemRows(db, userId, 'one', now, now, draftId);
  if (!row) throw new HttpError(404, 'not_found', 'nothing queued with that id');
  if (row.status === 'sent' || row.status === 'sending')
    throw new HttpError(409, 'too_late', 'it has already gone out');
  const [held] = await db.sql<{ id: string }>`
    update orbit.drafts set status = 'draft', error = 'held', cancel_reason = null, send_at = null
     where id = ${draftId}::uuid and user_id = ${userId}::uuid and status in ('approved', 'scheduled', 'draft')
    returning id`;
  if (!held) throw new HttpError(409, 'not_holdable', `a ${row.status} draft cannot be held`);
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'draft.hold', 'drafts', ${draftId}, ${{ reason: 'held', at: iso(now) }}::jsonb)`;
  return item({ ...row, status: 'draft', error: 'held', send_at: null }, 'held', HOLD_REASONS.held);
}

/**
 * POST /autopilot/pause {until, goalId?}: for a goal, the breaker's key with the student as the reason (null lifts
 * it); for the account, autopilot_paused_until (null lifts it), and every send Orbit approved itself goes back to a
 * draft so nothing goes while the student thinks. Returns how many were cancelled.
 */
export async function pauseAutopilot(
  db: Db,
  userId: string,
  req: { until: string | null; goalId?: string },
  now: Date,
): Promise<{ pausedUntil: string | null; goalId: string | null; cancelled: number }> {
  if (req.goalId) {
    const [g] = await db.sql<{ id: string }>`
      select id from orbit.goals where id = ${req.goalId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
    if (!g) throw new HttpError(404, 'not_found', 'no such goal');
    const pause: GoalPause | null =
      req.until === null && req.until !== undefined
        ? null
        : {
            reason: 'student',
            text: 'You paused it',
            until: req.until ?? null,
            at: now.toISOString(),
          };
    await setGoalPause(db, userId, req.goalId, pause);
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'autopilot.pause', 'goals', ${req.goalId}, ${{ until: req.until ?? null }}::jsonb)`;
    return { pausedUntil: req.until ?? null, goalId: req.goalId, cancelled: 0 };
  }
  await db.sql`
    update orbit.users
       set settings = case when ${req.until}::text is null then settings - 'autopilot_paused_until'
                           else settings || jsonb_build_object('autopilot_paused_until', ${req.until}::text) end
     where id = ${userId}::uuid`;
  let cancelled = 0;
  if (req.until) {
    const rows = await db.sql<{ id: string }>`
      update orbit.drafts set status = 'draft', error = 'autopilot_paused', send_at = null
       where user_id = ${userId}::uuid and status in ('approved', 'scheduled') and auto_rung is not null
         and (send_at is null or send_at > ${now}::timestamptz)
      returning id`;
    cancelled = rows.length;
    for (const r of rows)
      await db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'user', 'draft.hold', 'drafts', ${r.id}, ${{ reason: 'autopilot_paused' }}::jsonb)`;
  }
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'autopilot.pause', 'users', ${userId}, ${{ until: req.until, cancelled }}::jsonb)`;
  return { pausedUntil: req.until, goalId: null, cancelled };
}

/** POST /autopilot/mode {mode, goalId?}: the account's mode (with autonomy_level to match), or one goal's level. */
export async function setAutopilotMode(
  db: Db,
  userId: string,
  req: { mode: AutopilotMode; goalId?: string },
): Promise<{ mode: AutopilotMode; goalId: string | null }> {
  const level = AUTOPILOT_MODE_LEVEL[req.mode];
  if (req.goalId) {
    const r = await db.sql`
      update orbit.goals set autonomy_level = ${level}::smallint
       where id = ${req.goalId}::uuid and user_id = ${userId}::uuid and deleted_at is null returning id`;
    if (!r.length) throw new HttpError(404, 'not_found', 'no such goal');
  } else
    await db.sql`
      update orbit.users set autonomy_level = ${level}::smallint,
             settings = settings || jsonb_build_object('autopilot_mode', ${req.mode}::text)
       where id = ${userId}::uuid`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'settings.autonomy', ${req.goalId ? 'goals' : 'users'}, ${req.goalId ?? userId},
            ${{ level, mode: req.mode }}::jsonb)`;
  return { mode: req.mode, goalId: req.goalId ?? null };
}
