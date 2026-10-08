import type { WarmUpAction, WarmUpPlan } from '../types';

/**
 * LinkedIn warm-up: before a cold LinkedIn message, spend a few days being visible to the person
 * (view profile, react to a recent post, leave one thoughtful comment). Done by the student by hand via deep links;
 * Orbit schedules, reminds, tracks, and only then suggests the outreach. No automation touches LinkedIn.
 */
export function linkedinActivityUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}/recent-activity/all/`;
}
export function linkedinProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}/`;
}
export function linkedinMessageUrl(slug: string): string {
  return `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(slug)}`;
}

/** Allowed warm-up lengths in days (the Settings field enforces the same range). */
export const WARMUP_DAYS_MIN = 2;
export const WARMUP_DAYS_MAX = 10;

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Wall-clock parts of `ms` in `tz` (or in the runtime's zone when tz is unset), as a UTC timestamp. */
function wallClock(ms: number, tz?: string): number {
  if (!tz) {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
}

/** The instant that reads `hour`:00 on calendar day `key` (YYYY-MM-DD) in `tz`. */
function atLocalHour(key: string, hour: number, tz?: string): Date {
  const target = Date.parse(`${key}T${pad2(hour)}:00:00Z`);
  let guess = target;
  // two passes settle the offset across a DST change
  for (let i = 0; i < 2; i++) guess = target - (wallClock(guess, tz) - guess);
  return new Date(guess);
}

/**
 * The warm-up schedule, in the student's timezone, counted in working days (Saturdays and Sundays are skipped). The
 * first action is due when the plan starts (or at 10:00 that day if they start in the early morning), never earlier,
 * so a plan started in the afternoon is not born overdue. The react and the comment fall on later days, and every
 * action is due before the ready date (working day n, 09:00). `warmUpDays` is clamped to 2..10; with 2 days the
 * react and the comment share day 1.
 */
export function buildWarmUpPlan(slug: string, startedAt: Date, warmUpDays = 4, tz?: string): WarmUpPlan {
  const n = Math.min(
    WARMUP_DAYS_MAX,
    Math.max(WARMUP_DAYS_MIN, Number.isFinite(warmUpDays) ? Math.round(warmUpDays) : 4),
  );
  const startDay = Date.parse(`${wallKey(startedAt, tz)}T00:00:00Z`);
  // the k-th working day after the start: people are on LinkedIn during the week, so no step is due on a Saturday
  // or a Sunday (a warm-up started on Friday reacts on Tuesday, not Sunday)
  const dayKey = (k: number) => {
    let at = startDay;
    for (let added = 0; added < k; ) {
      at += DAY_MS;
      const wd = new Date(at).getUTCDay();
      if (wd !== 0 && wd !== 6) added++;
    }
    return new Date(at).toISOString().slice(0, 10);
  };
  const day = (k: number, h = 10) => atLocalHour(dayKey(k), h, tz).toISOString();
  const first = new Date(Math.max(startedAt.getTime(), Date.parse(day(0)))).toISOString();
  const commentDay = Math.max(1, n - 1);
  const actions: WarmUpAction[] = [
    {
      id: 'w1',
      kind: 'view_profile',
      label: 'Look at their profile and what they post about',
      url: linkedinProfileUrl(slug),
      dueAt: first,
    },
    {
      id: 'w2',
      kind: 'react_post',
      label: 'React to one recent post that you genuinely find useful',
      url: linkedinActivityUrl(slug),
      dueAt: day(Math.min(commentDay, Math.max(1, Math.floor(n / 2)))),
    },
    {
      id: 'w3',
      kind: 'comment_post',
      label: 'Leave one substantive comment: a question or an added point, not praise',
      url: linkedinActivityUrl(slug),
      dueAt: day(commentDay),
    },
  ];
  return { startedAt: startedAt.toISOString(), readyAt: day(n, 9), actions };
}

/**
 * Whether a warm-up step's day has come, in the student's timezone. A step is offered on its own day, not the moment
 * the previous one is done: three steps in ten minutes is not a warm-up.
 */
export function warmUpStepDue(action: WarmUpAction, now: Date, tz?: string): boolean {
  return wallKey(new Date(action.dueAt), tz) <= wallKey(now, tz);
}

/** YYYY-MM-DD of `d` in `tz` (or the runtime's zone when tz is unset). */
function wallKey(d: Date, tz?: string): string {
  return new Date(wallClock(d.getTime(), tz)).toISOString().slice(0, 10);
}

/**
 * Visible activity needs some spread: even with every action done, the message waits until this many calendar
 * days after the warm-up started (or the planned ready date, if sooner).
 */
export const WARMUP_MIN_SPREAD_DAYS = 2;

export function warmUpProgress(
  plan: WarmUpPlan,
  now: Date,
  /** the student's IANA timezone: the spread counts calendar days there (the runtime's zone when unset) */
  tz?: string,
): {
  done: number;
  skipped: number;
  total: number;
  ready: boolean;
  /** the student skipped every action: the message goes out cold, by their choice */
  skippedAll: boolean;
  /** when the outreach becomes due, once every action is resolved (or at the planned date) */
  readyFrom: string;
  nextAction?: WarmUpAction;
  overdue: boolean;
} {
  const done = plan.actions.filter((a) => a.doneAt).length;
  const skipped = plan.actions.filter((a) => a.skippedAt && !a.doneAt).length;
  const next = plan.actions.find((a) => !a.doneAt && !a.skippedAt);
  const resolved = done + skipped === plan.actions.length;
  const skippedAll = resolved && done === 0;
  const plannedReady = new Date(plan.readyAt).getTime();
  // the spread is counted in calendar days in the student's timezone: from the start of the day two days after the
  // warm-up began there (the browser's zone would move the boundary for a student whose machine is set elsewhere)
  const spreadKey = new Date(
    Date.parse(`${wallKey(new Date(plan.startedAt), tz)}T00:00:00Z`) + WARMUP_MIN_SPREAD_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const spread = atLocalHour(spreadKey, 0, tz).getTime();
  // three actions in ten minutes is not a warm-up: done early still waits for the spread (or the planned date)
  const readyFromMs = skippedAll ? now.getTime() : resolved ? Math.min(plannedReady, spread) : plannedReady;
  const ready = skippedAll || (now.getTime() >= readyFromMs && done >= 1);
  const overdue = !!next && new Date(next.dueAt).getTime() < now.getTime() - 86_400_000;
  return {
    done,
    skipped,
    total: plan.actions.length,
    ready,
    skippedAll,
    readyFrom: new Date(readyFromMs).toISOString(),
    nextAction: next,
    overdue,
  };
}

/**
 * A warm-up the student fell behind on: its next step's day has passed. The steps left (and the first-message date)
 * move forward so the next step is today, keeping their spacing and skipping weekends, so the card never lists dates
 * that are already over. Returns undefined when nothing needs to move.
 */
export function replanWarmUp(plan: WarmUpPlan, now: Date, tz?: string): WarmUpPlan | undefined {
  const next = plan.actions.find((a) => !a.doneAt && !a.skippedAt);
  if (!next) return undefined;
  const today = wallKey(now, tz);
  const due = wallKey(new Date(next.dueAt), tz);
  if (due >= today) return undefined;
  const shift = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY_MS);
  const move = (iso: string): string => {
    const at = new Date(iso);
    const hour = new Date(wallClock(at.getTime(), tz)).getUTCHours();
    let ms = Date.parse(`${wallKey(at, tz)}T00:00:00Z`) + shift * DAY_MS;
    while ([0, 6].includes(new Date(ms).getUTCDay())) ms += DAY_MS;
    const key = new Date(ms).toISOString().slice(0, 10);
    // the first step moved to today is due now, not later today
    const t = atLocalHour(key, hour, tz);
    return (key === today && t.getTime() > now.getTime() && iso === next.dueAt ? now : t).toISOString();
  };
  return {
    ...plan,
    readyAt: move(plan.readyAt),
    actions: plan.actions.map((a) => (a.doneAt || a.skippedAt ? a : { ...a, dueAt: move(a.dueAt) })),
  };
}
