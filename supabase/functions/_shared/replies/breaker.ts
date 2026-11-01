/**
 * The circuit breaker (plan 29 §B2.7): an unsubscribe, two declines in a day, a bounce, a Gmail send error, or a
 * decline or concern answering a first message Orbit sent on its own (§B2.2) pauses what Orbit sends on its own for
 * that goal, and tells the student. The pause is one key in users.settings,
 * `autopilot_paused_goals`, read by the cadence and the plan step (no outreach of that goal is approved on its own) and
 * the send job (an approved auto send of outreach for that goal waits; see breakerHolds). Replies inside a live thread
 * still finish themselves: the breaker stops new outreach, not answers to people who wrote back. The student lifts it
 * from Settings or the chat (`/autopilot/pause {until: null, goalId}`).
 */
import type { Db } from '../db.ts';
import { raiseCard } from './cards.ts';

export type BreakerReason = 'unsubscribe' | 'declines' | 'bounce' | 'send_error' | 'pushback';

export interface GoalPause {
  reason: BreakerReason | 'student';
  /** a sentence for the card and the status */
  text: string;
  /** ISO, or null when it holds until lifted */
  until: string | null;
  at: string;
}

export type PausedGoals = Record<string, GoalPause>;

/** Declines in one day that trip the breaker. */
export const DECLINES_PER_DAY = 2;

export function pausedGoalsOf(settings: Record<string, unknown> | null | undefined): PausedGoals {
  const v = settings?.autopilot_paused_goals;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: PausedGoals = {};
  for (const [goalId, p] of Object.entries(v as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') continue;
    const g = p as Partial<GoalPause>;
    out[goalId] = {
      reason: (g.reason as GoalPause['reason']) ?? 'student',
      text: typeof g.text === 'string' ? g.text : 'Paused',
      until: typeof g.until === 'string' ? g.until : null,
      at: typeof g.at === 'string' ? g.at : '',
    };
  }
  return out;
}

/**
 * What the breaker holds (plan 29 §B2.7, as built 2026-11-01): the outreach Orbit starts on its own for the goal, first
 * messages, bumps and the notes that open or reopen a conversation. Never a reply inside a thread the other person
 * kept going by writing back (a scheduling confirmation, the slots for a yes, a thank-you): one person's unsubscribe
 * must not leave another person's requested call unconfirmed.
 */
const OUTREACH_KINDS: ReadonlySet<string> = new Set([
  'outreach',
  'first_touch',
  'warm_first_touch',
  'bump',
  'nurture',
  'reengage',
  'congratulate',
  'referral_ask',
  'intro_request',
  'report_back',
]);
export function breakerHolds(kind: string | null | undefined): boolean {
  return !kind || OUTREACH_KINDS.has(kind);
}

/** True while the goal's auto sends are paused: an entry with no end, or one whose end is still ahead. */
export function goalPaused(
  settings: Record<string, unknown> | null | undefined,
  goalId: string | null,
  now: Date,
) {
  if (!goalId) return false;
  const p = pausedGoalsOf(settings)[goalId];
  if (!p) return false;
  return p.until === null || new Date(p.until).getTime() > now.getTime();
}

export async function setGoalPause(
  db: Db,
  userId: string,
  goalId: string,
  pause: GoalPause | null,
): Promise<PausedGoals> {
  const [u] = await db.sql<{ settings: Record<string, unknown> }>`
    select settings from orbit.users where id = ${userId}::uuid`;
  const goals = pausedGoalsOf(u?.settings);
  if (pause) goals[goalId] = pause;
  else delete goals[goalId];
  await db.sql`
    update orbit.users set settings = settings || jsonb_build_object('autopilot_paused_goals', ${goals}::jsonb)
     where id = ${userId}::uuid`;
  return goals;
}

const WHAT: Record<BreakerReason, string> = {
  unsubscribe: 'asked to stop',
  declines: 'declined, the second today',
  bounce: 'bounced',
  send_error: 'could not be sent to',
  pushback: 'pushed back on a first message Orbit sent',
};

/**
 * Trip the breaker for a goal: the pause is written (once; a goal already paused is left as it is), an audit row
 * says why, and a `breaker` card tells the student: "Chloe Dubois asked to stop. Paused Ramp first messages."
 */
export async function tripBreaker(
  db: Db,
  userId: string,
  p: {
    goalId: string | null;
    reason: BreakerReason;
    personId: string | null;
    personName: string;
    company?: string | null;
    messageId?: string | null;
    now: Date;
  },
): Promise<{ tripped: boolean; text: string }> {
  const [u] = await db.sql<{ settings: Record<string, unknown> }>`
    select settings from orbit.users where id = ${userId}::uuid`;
  const goalTitle = p.goalId
    ? (await db.sql<{ title: string }>`select title from orbit.goals where id = ${p.goalId}::uuid`)[0]?.title
    : undefined;
  const where = p.company?.trim() || goalTitle || 'first messages';
  const text = `${p.personName} ${WHAT[p.reason]}. Paused ${where}${p.company?.trim() || goalTitle ? ' first messages' : ''}.`;
  if (p.goalId && goalPaused(u?.settings, p.goalId, p.now)) return { tripped: false, text };
  if (p.goalId)
    await setGoalPause(db, userId, p.goalId, {
      reason: p.reason,
      text,
      until: null,
      at: p.now.toISOString(),
    });
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'system', 'autopilot.breaker', 'goals', ${p.goalId ?? userId},
            ${{ reason: p.reason, personId: p.personId, messageId: p.messageId ?? null, goalId: p.goalId }}::jsonb)`;
  await raiseCard(db, userId, {
    kind: 'breaker',
    dedupeKey: `breaker:${p.goalId ?? 'account'}:${p.messageId ?? p.personId ?? p.now.toISOString()}`,
    reasonText: `${text} Read it?`,
    personId: p.personId,
    messageId: p.messageId ?? null,
    signals: { reason: p.reason, goalId: p.goalId },
    payload: { goalId: p.goalId, reason: p.reason, personName: p.personName, company: p.company ?? null },
    priority: 0.9,
    now: p.now,
    notify: {
      kind: 'system',
      title: text,
      link: p.personId ? `/people/${p.personId}` : '/settings/autopilot',
    },
  });
  return { tripped: true, text };
}

/** Declines from this goal's people today (the person's chats name the goal), for the two-a-day rule. */
export async function declinesToday(
  db: Db,
  userId: string,
  goalId: string | null,
  dayStart: Date,
): Promise<number> {
  const [r] = await db.sql<{ n: number }>`
    select count(distinct m.id)::int as n
      from orbit.messages m
      join orbit.chats c on c.user_id = m.user_id and c.person_id = m.from_person_id
     where m.user_id = ${userId}::uuid and m.direction = 'in' and m.reply_class = 'decline'
       and m.sent_at >= ${dayStart}::timestamptz
       and (${goalId}::uuid is null or c.goal_id = ${goalId}::uuid)`;
  return r?.n ?? 0;
}

/**
 * A decline or a concern answering a first message Orbit sent on its own trips the breaker for that goal at once
 * (plan 29 §B2.2): "Marcus Lee pushed back on a first message Orbit sent. Paused Stripe first messages."
 */
export async function pushbackOnAutoFirst(
  db: Db,
  userId: string,
  m: { id: string; from_person_id: string | null; sent_at: Date | string; reply_class: string | null },
  now: Date,
): Promise<boolean> {
  if (!m.from_person_id || (m.reply_class !== 'decline' && m.reply_class !== 'objection')) return false;
  const [d] = await db.sql<{ goal_id: string | null; display_name: string; org: string | null }>`
    select d.goal_id, p.display_name, coalesce(o.name, p.org_raw) as org from orbit.drafts d
      join orbit.people p on p.id = d.person_id
      left join orbit.organizations o on o.id = p.org_id
     where d.user_id = ${userId}::uuid and d.person_id = ${m.from_person_id}::uuid and d.auto_rung = 'first_touch'
       and d.status = 'sent' and d.sent_at <= ${new Date(m.sent_at)}::timestamptz
       and exists (select 1 from orbit.audit_log a where a.target_table = 'drafts' and a.target_id = d.id::text
                    and a.action = 'draft.auto_sent')
     order by d.sent_at desc limit 1`;
  if (!d) return false;
  const r = await tripBreaker(db, userId, {
    goalId: d.goal_id,
    reason: 'pushback',
    personId: m.from_person_id,
    personName: d.display_name,
    company: d.org,
    messageId: m.id,
    now,
  });
  return r.tripped;
}
