/** When autopilot sends: sending hours, the gaps between sends, and the plan of times. No database, no sending. */

/** Sending hours, local time. */
export const AUTOPILOT_WINDOW = { start: 9, end: 17 } as const;
/** Gap between two autopilot sends, in minutes: a random point in this range, so the rhythm is never mechanical. */
export const AUTOPILOT_GAP_MIN = { min: 25, max: 70 } as const;
/** The default number a day, under the daily limits. */
export const AUTOPILOT_DEFAULT_PER_DAY = 6;

const MINUTE = 60_000;

/** A small seeded random, so a plan shown on the Approve card is the plan that runs. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const weekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

function atHour(d: Date, h: number, m = 0): Date {
  const x = new Date(d);
  x.setHours(h, m, 0, 0);
  return x;
}

/** The next moment inside sending hours, on a weekday, at or after `from`. */
export function nextOpen(from: Date): Date {
  let d = new Date(from);
  for (let i = 0; i < 14; i++) {
    if (!weekend(d)) {
      const open = atHour(d, AUTOPILOT_WINDOW.start);
      const close = atHour(d, AUTOPILOT_WINDOW.end);
      if (d < open) return open;
      if (d < close) return d;
    }
    d = atHour(new Date(d.getTime() + 24 * 60 * MINUTE), AUTOPILOT_WINDOW.start);
  }
  return d;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Times for `count` sends from `start`: weekdays, inside sending hours, a random gap between each, at most `perDay`
 * a day counting the sends already planned (`taken`). The first one is at least ten minutes away, so the student
 * can still change their mind.
 */
export function planSpread(opts: {
  count: number;
  start: Date;
  perDay: number;
  taken?: Date[];
  seed?: number;
}): Date[] {
  const rand = rng(opts.seed ?? 7);
  const perDay = Math.max(1, Math.floor(opts.perDay));
  const used = new Map<string, number>();
  for (const t of opts.taken ?? []) used.set(dayKey(t), (used.get(dayKey(t)) ?? 0) + 1);
  const out: Date[] = [];
  let at = nextOpen(new Date(opts.start.getTime() + 10 * MINUTE + Math.floor(rand() * 15) * MINUTE));
  while (out.length < opts.count) {
    const close = atHour(at, AUTOPILOT_WINDOW.end);
    if ((used.get(dayKey(at)) ?? 0) >= perDay || at >= close) {
      // the day is full or over: the next weekday, a little after the window opens
      at = nextOpen(atHour(new Date(at.getTime() + 24 * 60 * MINUTE), AUTOPILOT_WINDOW.start));
      at = new Date(at.getTime() + Math.floor(rand() * 40) * MINUTE);
      continue;
    }
    out.push(at);
    used.set(dayKey(at), (used.get(dayKey(at)) ?? 0) + 1);
    const gap = AUTOPILOT_GAP_MIN.min + rand() * (AUTOPILOT_GAP_MIN.max - AUTOPILOT_GAP_MIN.min);
    at = new Date(at.getTime() + Math.round(gap) * MINUTE);
  }
  return out;
}

/** When the next autopilot send may go: a gap after the last one sent, so a backlog never goes out at once. */
export function nextSlotAfter(last: Date | undefined, now: Date, seed: number): Date {
  const rand = rng(seed);
  const gap = (AUTOPILOT_GAP_MIN.min + rand() * (AUTOPILOT_GAP_MIN.max - AUTOPILOT_GAP_MIN.min)) * MINUTE;
  const earliest = last ? new Date(Math.max(now.getTime(), last.getTime() + gap)) : now;
  return nextOpen(earliest);
}
