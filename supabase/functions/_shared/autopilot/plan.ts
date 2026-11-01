/**
 * The plan step (plan 29 §B4, §B6, §C1 phase 5): once an hour, as part of `cadence.user`, autopilot plans the next
 * send morning's first messages for every goal that runs on autopilot (the goal's own level 2, or the student's
 * when the goal has none), unless the account or the goal is paused.
 *
 * It paces to the week's target (`weekPace` over users.settings.weekly_target), weighs the people at the goal's
 * companies against every first-message condition (core `planFirstTouchDay`: alumni, closeness 40 or more or a
 * friend's contact; a hook with a source id; not a recruiter, not under 18, not faculty outside a research goal, not
 * hidden, private or do not contact, no chat already going; never two at one firm in a morning; at most three a day
 * and twelve a week), and for each pick:
 *
 *   - a person the student knows is written to: `composeDraft` (the playbook's rules 13 and 14 ride along for every
 *     first message), the validator, a hook that cites a source, and the voice gate (`firstMessageVoiceOk`). A draft
 *     that passes is approved by Orbit for the recipient's next morning window, at least the review window from now,
 *     with `review_until` equal to that time and `auto_rung = 'first_touch'`, so it sits in Tomorrow's batch from the
 *     moment it exists. One that fails stays a draft with the reason, under Held.
 *   - a friend's contact is never written to: the plan drafts the ask to the friend (the note they forward) as a card
 *     the student sends with one tap, and queues nothing to the contact.
 *
 * Who was left out and why is kept in the audit log (`autopilot.plan`), for the status and "why didn't you send to
 * Priya". At 18:00 the student's time, once a day, a non-empty batch raises the `batch_ready` card.
 */
import { yearLabel } from '@orbit/core/drafts/sector';
import {
  earliestPlannedSend,
  type FirstTouchCandidate,
  type FirstTouchGoal,
  type FirstTouchSkip,
  firmKey,
  planFirstTouchDay,
  reviewWindow,
} from '@orbit/core/safety/firstTouch';
import { messageHash, SEND_CAPS } from '@orbit/core/safety/rules';
import { voiceCheck } from '@orbit/core/style/voice';
import { weekKeys, weekPace } from '@orbit/core/suggestions/pace';
import type { GoalKind, MessageKind } from '@orbit/core/types';
import { composeDraft } from '../compose/compose.ts';
import { loadUserRow, styleCardOf, userFirstName } from '../compose/context.ts';
import type { DraftRow } from '../compose/drafts.ts';
import { askUserMarkers } from '../compose/prompts.ts';
import { nextSendWindow, sendDayAllowed } from '../compose/window.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { loadFriendLayer } from '../paths/find.ts';
import { goalPaused } from '../replies/breaker.ts';
import { raiseCard } from '../replies/cards.ts';
import type { Services } from '../services.ts';
import { localParts, validZone, zonedTime } from '../zones.ts';
import { firstTouchRungOf } from './autopilot.ts';

const DAY = 86_400_000;
const FIRST_TOUCH = ['outreach', 'first_touch', 'warm_first_touch'];
/** The week's target when the student never set one (the browser's default). */
export const DEFAULT_WEEKLY_TARGET = 4;
/** The hour, the student's time, the evening batch card is raised. */
export const BATCH_CARD_HOUR = 18;
/** At most this many skips are kept per plan, the goals' companies first. */
const SKIPS_KEPT = 40;

export interface PlanSummary {
  /** why nothing was planned, when nothing was */
  reason?: 'paused' | 'no_autopilot_goal';
  goals: number;
  considered: number;
  queued: number;
  asks: number;
  /** drafted but held back (the validator, the hook or the voice), each a draft with its reason */
  held: number;
  skipped: number;
  batchCard: boolean;
}

type PersonCandidateRow = {
  id: string;
  display_name: string;
  first_name: string | null;
  title: string | null;
  headline: string | null;
  org: string | null;
  is_alumni: boolean;
  primary_email: string | null;
  hidden_at: Date | null;
  do_not_contact: boolean;
  private: boolean;
  timezone: string | null;
  score: number;
  written: boolean;
  open_chat: boolean;
  pending: boolean;
  has_hook: boolean;
};

type GoalRow = {
  id: string;
  kind: GoalKind;
  title: string;
  targets: { organizations?: string[] } | null;
  autonomy_level: number | null;
  priority: number;
};

/**
 * The voice gate before an autopilot first message (plan 29 §B2.4c), in one place: core `voiceCheck` against the
 * student's card and the notes they kept. The model judge ("written by the same person? 0 to 3", §B2.4c) is the voice
 * phase's; when it lands it is called here, and nothing else changes. A draft that fails falls to approval with the
 * reason "didn't sound like you".
 */
export function firstMessageVoiceOk(
  draft: Pick<DraftRow, 'body' | 'subject'>,
  ctx: { settings: Record<string, unknown>; card: ReturnType<typeof styleCardOf> },
): { ok: boolean; problems: string[] } {
  const notes = Array.isArray(ctx.settings.voice_notes)
    ? (ctx.settings.voice_notes as { text?: unknown; forgottenAt?: unknown; avoid?: unknown }[])
        .filter((n) => typeof n?.text === 'string' && !n.forgottenAt)
        .map((n) => ({
          text: n.text as string,
          forgottenAt: null,
          avoid: typeof n.avoid === 'string' ? n.avoid : null,
        }))
    : [];
  const r = voiceCheck({ body: draft.body, subject: draft.subject }, { card: ctx.card, notes });
  return { ok: r.ok, problems: r.problems.map((p) => p.detail) };
}

/** The student-time day key a moment falls on. */
const dayKeyOf = (d: Date, tz: string) => localParts(d, tz).key;

/** The send days (Tuesday to Thursday, no holidays) from `key` to the end of its week, `key` included. */
function sendDaysLeft(key: string): number {
  return weekKeys(new Date(`${key}T12:00:00Z`), 'UTC').filter((k) => k >= key && sendDayAllowed(k, 'gmail'))
    .length;
}

/** The first message to a friend's contact, for the friend to forward: who the student is, why them, the ask, an out. */
export function friendAskNote(p: {
  studentFirst: string;
  school?: string | null;
  year?: string;
  goalTitle: string;
  targetFirst: string;
  company?: string | null;
}): string {
  const who = [p.school, p.year].filter(Boolean).join(' ');
  return [
    `I'm ${p.studentFirst}${who ? `, a ${who}` : ''}, working toward ${p.goalTitle.replace(/[.]+$/, '').toLowerCase()}.`,
    `I'd love 15 minutes to hear how ${p.targetFirst} found ${p.company ? `the way to ${p.company}` : 'their way into the field'} and what they wish they had known earlier.`,
    'No worries at all if the timing is not right.',
  ].join(' ');
}

/** The plan step for one user (the part of `cadence.user` that writes first messages). */
export async function runAutopilotPlan(s: Services, userId: string): Promise<PlanSummary> {
  const db = s.db;
  const now = s.now();
  const out: PlanSummary = {
    goals: 0,
    considered: 0,
    queued: 0,
    asks: 0,
    held: 0,
    skipped: 0,
    batchCard: false,
  };
  const user = await loadUserRow(db, userId);
  const settings = user.settings ?? {};
  const tz = validZone(user.timezone) ?? 'America/New_York';
  const paused =
    typeof settings.autopilot_paused_until === 'string' &&
    new Date(settings.autopilot_paused_until).getTime() > now.getTime();
  if (paused) return { ...out, reason: 'paused' };

  const goals = (
    await db.sql<GoalRow>`
      select id, kind, title, targets, autonomy_level, priority from orbit.goals
       where user_id = ${userId}::uuid and status = 'active' and deleted_at is null
       order by priority asc, created_at asc`
  ).filter(
    (g) =>
      Number(g.autonomy_level ?? user.autonomy_level ?? 0) === 2 &&
      (g.targets?.organizations?.length ?? 0) > 0 &&
      !goalPaused(settings, g.id, now),
  );
  out.goals = goals.length;
  if (goals.length) await planGoals(s, userId, user, tz, goals, out);
  else out.reason = 'no_autopilot_goal';
  out.batchCard = await raiseBatchCard(db, userId, tz, now);
  return out;
}

async function planGoals(
  s: Services,
  userId: string,
  user: Awaited<ReturnType<typeof loadUserRow>>,
  tz: string,
  goals: GoalRow[],
  out: PlanSummary,
): Promise<void> {
  const db = s.db;
  const now = s.now();
  const settings = user.settings ?? {};
  // the morning this plan writes for: the student's next send window a full review window from now
  const earliest = earliestPlannedSend(now);
  const planAt = new Date(nextSendWindow(earliest, tz, 'gmail', () => 0).notBefore);
  const planDay = dayKeyOf(planAt, tz);
  const week = weekKeys(new Date(`${planDay}T12:00:00Z`), 'UTC');
  const weekStart = zonedTime(week[0]!, 0, 0, tz);
  const weekEnd = zonedTime(week[6]!, 23, 59, tz);
  const rollStart = new Date(zonedTime(planDay, 0, 0, tz).getTime() - 6 * DAY);
  const dayEnd = zonedTime(planDay, 23, 59, tz);

  // Orbit's own first messages around that morning: sent, queued or waiting for a tap
  const ownFirst = await db.sql<{ at: Date; org: string | null; name: string }>`
    select coalesce(d.send_at, d.sent_at) as at, coalesce(o.name, p.org_raw) as org, p.display_name as name
      from orbit.drafts d
      join orbit.people p on p.id = d.person_id
      left join orbit.organizations o on o.id = p.org_id
     where d.user_id = ${userId}::uuid and d.auto_rung = 'first_touch'
       and d.status in ('approved', 'scheduled', 'sending', 'sent')
       and coalesce(d.send_at, d.sent_at) >= ${rollStart}::timestamptz
       and coalesce(d.send_at, d.sent_at) <= ${dayEnd}::timestamptz`;
  const onDayRows = ownFirst.filter((r) => dayKeyOf(new Date(r.at), tz) === planDay);
  let onDay = onDayRows.length;
  let thisWeek = ownFirst.length;
  const firmsOnDay = onDayRows.map((r) => ({ firm: firmKey(r.org), name: r.name })).filter((f) => f.firm);

  // the week's pace: every first message the week holds, by hand or Orbit's own
  const [wk] = await db.sql<{ n: number; today: number }>`
    select count(*)::int as n,
           count(*) filter (where coalesce(send_at, sent_at) >= ${zonedTime(planDay, 0, 0, tz)}::timestamptz)::int as today
      from orbit.drafts
     where user_id = ${userId}::uuid and kind = any(${FIRST_TOUCH}::text[])
       and status in ('approved', 'scheduled', 'sending', 'sent')
       and coalesce(send_at, sent_at) >= ${weekStart}::timestamptz
       and coalesce(send_at, sent_at) <= ${weekEnd}::timestamptz`;
  const target =
    Number(settings.weekly_target) >= 1 ? Math.floor(Number(settings.weekly_target)) : DEFAULT_WEEKLY_TARGET;
  const pace = weekPace({
    target,
    sentThisWeek: wk?.n ?? 0,
    sentToday: wk?.today ?? 0,
    now: new Date(zonedTime(planDay, 12, 0, tz)),
    tz,
    dailyCap: SEND_CAPS.autoFirstTouchesPerDay,
  });
  let remaining = pace.remaining;
  const daysLeft = sendDaysLeft(planDay);

  const people = await candidateRows(db, userId);
  const layer = await loadFriendLayer(db, userId).catch(() => ({ friends: [], shares: [] }));
  // friend asks already made or drafted: the same contact is never asked twice
  const asked = new Set(
    (
      await db.sql<{ key: string }>`
        select friend_user_id::text || ':' || target_person_id::text as key from orbit.friend_intro_asks
         where asker_user_id = ${userId}::uuid and status in ('asked', 'forwarded')
        union
        select payload->>'friendUserId' || ':' || (payload->>'targetPersonId') as key from orbit.suggestions
         where user_id = ${userId}::uuid and kind = 'friend_ask_ready' and status in ('pending', 'snoozed', 'done')`
    ).map((r) => r.key),
  );
  const card = styleCardOf(user);
  const meFirst = userFirstName(user);
  const skipsAll: FirstTouchSkip[] = [];

  for (const goal of goals) {
    const g: FirstTouchGoal = { kind: goal.kind, targets: goal.targets?.organizations ?? [] };
    const firms = new Set(g.targets.map(firmKey).filter(Boolean));
    const byPerson = new Map<string, FirstTouchCandidate>();
    for (const p of people) {
      if (!firms.has(firmKey(p.org))) continue;
      byPerson.set(p.id, {
        personId: p.id,
        name: p.display_name,
        company: p.org,
        title: p.title,
        headline: p.headline,
        isAlumni: p.is_alumni,
        score: p.score,
        hasHook: p.has_hook,
        hasEmail: !!p.primary_email,
        hidden: !!p.hidden_at,
        private: p.private,
        doNotContact: p.do_not_contact,
        openChat: p.open_chat,
        written: p.written,
        pending: p.pending,
      });
    }
    // a friend's contacts at the goal's companies: beside the student's own row, or on their own
    for (const x of layer.shares) {
      if (!firms.has(firmKey(x.share.company))) continue;
      const via = { userId: x.friend.userId, name: x.friend.name, sharePersonId: x.share.person_id };
      const own = x.matchesPersonId ? byPerson.get(x.matchesPersonId) : undefined;
      if (own) {
        own.viaFriend ??= via;
        continue;
      }
      if (x.matchesPersonId) continue;
      const key = `friend_person:${x.share.person_id}`;
      if (byPerson.has(key)) continue;
      byPerson.set(key, {
        personId: key,
        name: x.share.display_name,
        company: x.share.company,
        title: x.share.title,
        score: 0,
        viaFriend: via,
        hasHook: false,
        hasEmail: false,
        pending: asked.has(`${x.friend.userId}:${x.share.person_id}`),
      });
    }
    const candidates = [...byPerson.values()];
    out.considered += candidates.length;
    const day = planFirstTouchDay({
      candidates,
      goal: g,
      remaining,
      daysLeft,
      onDay,
      thisWeek,
      firmsOnDay,
    });
    skipsAll.push(...day.skipped);
    for (const pick of day.picks) {
      const c = pick.candidate;
      if (pick.route === 'friend' && c.viaFriend) {
        const studentYear = yearLabel(user.grad_year ?? undefined, user.degree ?? undefined, now);
        const note = friendAskNote({
          studentFirst: meFirst,
          school: user.school,
          year: studentYear === 'student' ? undefined : studentYear,
          goalTitle: goal.title,
          targetFirst: c.name.split(/\s+/)[0]!,
          company: c.company,
        });
        const friendFirst = c.viaFriend.name.split(/\s+/)[0]!;
        await raiseCard(db, userId, {
          kind: 'friend_ask_ready',
          dedupeKey: `friend_ask:${c.viaFriend.userId}:${c.viaFriend.sharePersonId}`,
          reasonText: `${friendFirst} knows ${c.name}${c.company ? ` at ${c.company}` : ''}. Ask ${friendFirst} for the intro? Your note is ready for ${friendFirst} to forward, and nothing goes to ${c.name.split(/\s+/)[0]} from you.`,
          priority: 0.7,
          signals: { goalId: goal.id, route: 'friend' },
          payload: {
            friendUserId: c.viaFriend.userId,
            friendName: c.viaFriend.name,
            targetPersonId: c.viaFriend.sharePersonId,
            targetName: c.name,
            company: c.company ?? null,
            note,
            goalId: goal.id,
          },
          now,
        });
        asked.add(`${c.viaFriend.userId}:${c.viaFriend.sharePersonId}`);
        out.asks++;
        remaining--;
        continue;
      }
      const queued = await writeFirstTouch(s, userId, goal, c, { settings, card, now, tz });
      if (queued === 'queued') {
        out.queued++;
        onDay++;
        thisWeek++;
        remaining--;
        firmsOnDay.push({ firm: firmKey(c.company), name: c.name });
      } else if (queued === 'held') out.held++;
    }
  }
  out.skipped = skipsAll.length;
  await keepSkips(db, userId, planDay, skipsAll, now);
}

/** The student's people with everything the first-message conditions read, in one query. */
async function candidateRows(db: Db, userId: string): Promise<PersonCandidateRow[]> {
  return db.sql<PersonCandidateRow>`
    select p.id, p.display_name, p.first_name, p.title, p.headline, coalesce(o.name, p.org_raw) as org, p.is_alumni,
           p.primary_email, p.hidden_at, p.do_not_contact, coalesce(p.private, false) as private, p.timezone,
           coalesce(ts.score, 0)::int as score,
           (exists (select 1 from orbit.messages m where m.user_id = p.user_id and m.direction = 'out'
                     and p.id = any(m.to_person_ids))
            or exists (select 1 from orbit.drafts d where d.user_id = p.user_id and d.person_id = p.id
                        and d.status = 'sent')) as written,
           exists (select 1 from orbit.chats c where c.user_id = p.user_id and c.person_id = p.id
                    and c.archived_at is null
                    and c.stage not in ('identified', 'declined', 'no_response', 'archived')) as open_chat,
           exists (select 1 from orbit.drafts d where d.user_id = p.user_id and d.person_id = p.id
                    and d.kind = any(${FIRST_TOUCH}::text[])
                    and d.status in ('draft', 'approved', 'scheduled', 'sending')) as pending,
           (exists (select 1 from orbit.dossiers ds where ds.user_id = p.user_id and ds.person_id = p.id
                     and ds.status in ('ready', 'partial')
                     and jsonb_array_length(coalesce(ds.content->'openers', '[]'::jsonb)) > 0)
            or exists (select 1 from orbit.facts f where f.user_id = p.user_id and f.person_id = p.id
                        and f.deleted_at is null)) as has_hook
      from orbit.people p
      left join orbit.organizations o on o.id = p.org_id
      left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
     where p.user_id = ${userId}::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
       and coalesce(o.name, p.org_raw) is not null`;
}

/**
 * Write one first message and queue it for the morning, or keep it back as a draft with the reason. Returns what
 * happened; a refusal from compose (a decline in the last 180 days, an unanswered limit) is a skip.
 */
async function writeFirstTouch(
  s: Services,
  userId: string,
  goal: GoalRow,
  c: FirstTouchCandidate,
  ctx: { settings: Record<string, unknown>; card: ReturnType<typeof styleCardOf>; now: Date; tz: string },
): Promise<'queued' | 'held' | 'skipped'> {
  const db = s.db;
  const { now } = ctx;
  const kind: MessageKind = c.score >= 40 ? 'warm_first_touch' : 'first_touch';
  let draft: DraftRow;
  try {
    draft = (
      await composeDraft(s, {
        userId,
        personId: c.personId,
        kind,
        channel: 'gmail',
        goalId: goal.id,
        reason: `autopilot plan for ${goal.title}`,
        actor: 'agent',
      })
    ).draft;
  } catch (e) {
    if (e instanceof HttpError) return 'skipped';
    throw e;
  }
  const hold = async (reason: string, detail?: string[]) => {
    await db.sql`
      update orbit.drafts set auto_rung = 'first_touch', error = ${reason}, autonomy_level = 2
       where id = ${draft.id}::uuid and status = 'draft'`;
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'agent', 'draft.hold', 'drafts', ${draft.id},
              ${{ reason, detail: detail ?? [], plan: 'autopilot' }}::jsonb)`;
    return 'held' as const;
  };
  if (!draft.validator?.ok || askUserMarkers(`${draft.subject ?? ''}\n${draft.body}`).length)
    return hold('validator', draft.validator?.issues ?? []);
  const hooks = Array.isArray(draft.hooks) ? draft.hooks : [];
  if (!hooks.some((h) => typeof h?.sourceId === 'string' && h.sourceId.trim())) return hold('no_hook');
  const voice = firstMessageVoiceOk(draft, ctx);
  if (!voice.ok) return hold('voice', voice.problems);

  const [p] = await db.sql<{ timezone: string | null }>`
    select timezone from orbit.people where id = ${c.personId}::uuid`;
  // the recipient's morning, at least a full review window from now
  const at = new Date(
    nextSendWindow(earliestPlannedSend(now), validZone(p?.timezone) ?? ctx.tz, 'gmail', s.random).notBefore,
  );
  const w = reviewWindow(at);
  const hash = messageHash({ channel: draft.channel, subject: draft.subject, body: draft.body });
  const [approved] = await db.sql<{ id: string }>`
    update orbit.drafts set status = 'approved', send_at = ${w.sendAt}::timestamptz,
                            review_until = ${w.reviewUntil}::timestamptz, autonomy_level = 2,
                            auto_rung = 'first_touch', error = null
     where id = ${draft.id}::uuid and status = 'draft' returning id`;
  if (!approved) return 'skipped';
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${draft.id},
            ${{ hash, standing: 'autopilot_plan', rung: 'first_touch', level: 2, goalId: goal.id, send_at: w.sendAt, review_until: w.reviewUntil }}::jsonb)`;
  await s.queue.enqueue(
    { kind: 'send.draft', userId, payload: { draftId: draft.id }, dedupeKey: `send:${draft.id}:${w.sendAt}` },
    { delaySec: Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000)) },
  );
  return 'queued';
}

/**
 * Who the plan left out and why, as one audit row per change (the status reads the newest, the chat quotes it): the
 * people at the goals' companies, closest to going first, at most forty. A plan that left out the same people for
 * the same reasons as the last one writes nothing new.
 */
async function keepSkips(db: Db, userId: string, day: string, skips: FirstTouchSkip[], now: Date) {
  const order: Record<string, number> = {
    same_firm_today: 0,
    daily_cap: 1,
    paced: 1,
    weekly_cap: 1,
    target_met: 1,
    no_hook: 2,
    no_email: 2,
    not_close: 3,
    recruiter: 3,
    faculty: 3,
    minor: 4,
  };
  const kept = [...skips]
    .sort((a, b) => (order[a.rule] ?? 5) - (order[b.rule] ?? 5))
    .slice(0, SKIPS_KEPT)
    .map((x) => ({
      personId: x.personId.startsWith('friend_person:') ? null : x.personId,
      personName: x.name,
      company: x.company,
      rule: x.rule,
      reason: x.reason,
    }));
  const signature = kept.map((x) => `${x.personName}:${x.rule}`).join('|');
  const [last] = await db.sql<{ details: { signature?: string; day?: string } }>`
    select details from orbit.audit_log where user_id = ${userId}::uuid and action = 'autopilot.plan'
     order by created_at desc limit 1`;
  if (last?.details?.signature === signature && last.details.day === day) return;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details, created_at)
    values (${userId}::uuid, 'agent', 'autopilot.plan', 'users', ${userId},
            ${{ day, signature, skipped: kept }}::jsonb, ${now}::timestamptz)`;
}

/**
 * The evening batch card (plan 29 §B1): at 18:00 the student's time, once a day, when Orbit's own first messages are
 * queued for the coming morning. Before the rung is earned it says each one waits for a tap.
 */
export async function raiseBatchCard(db: Db, userId: string, tz: string, now: Date): Promise<boolean> {
  const local = localParts(now, tz);
  if (local.hour < BATCH_CARD_HOUR) return false;
  const [q] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit.drafts
     where user_id = ${userId}::uuid and auto_rung = 'first_touch' and status in ('approved', 'scheduled')
       and send_at > ${now}::timestamptz and send_at <= ${new Date(now.getTime() + 36 * 3_600_000)}::timestamptz`;
  const n = q?.n ?? 0;
  if (!n) return false;
  const key = `batch_ready:${local.key}`;
  const [had] = await db.sql<{ id: string }>`
    select id from orbit.suggestions where user_id = ${userId}::uuid and dedupe_key = ${key}`;
  if (had) return false;
  const rung = await firstTouchRungOf(db, userId);
  const many = n === 1 ? 'first message' : 'first messages';
  const text = rung.earned
    ? `Tomorrow's batch is ready: ${n} ${many} go in the morning unless you hold ${n === 1 ? 'it' : 'one'}.`
    : `Tomorrow's batch is ready: ${n} ${many} wait for your tap tonight. Until ${rung.needed} go out as Orbit wrote them, only the ones you tap are sent.`;
  await raiseCard(db, userId, {
    kind: 'batch_ready',
    dedupeKey: key,
    reasonText: text,
    priority: 0.8,
    signals: { firstTouches: n, rungEarned: rung.earned },
    payload: { firstTouches: n, day: local.key, rungEarned: rung.earned },
    now,
    notify: { kind: 'system', title: text, link: '/inbox' },
  });
  return true;
}
