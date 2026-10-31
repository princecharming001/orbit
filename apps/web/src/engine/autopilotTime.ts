/**
 * When autopilot sends (plan 29 §B2.1): the one send window everything else uses, core's `nextSendWindow` (the
 * recipient's Tuesday to Thursday, 8:00 to 10:30, never a US holiday), with the spread kept from before: a
 * different 25 to 70 minute gap between sends and at most so many a day. No database, no sending. The 9 to 17
 * weekday window this file once had is retired; the server's copy of the window answers the same.
 */
import { nextSendWindow } from '@orbit/core';

/** Gap between two autopilot sends, in minutes: a random point in this range, so the rhythm is never mechanical. */
export const AUTOPILOT_GAP_MIN = { min: 25, max: 70 } as const;
/** The default number a day, under the daily limits. */
export const AUTOPILOT_DEFAULT_PER_DAY = 6;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A small seeded random, so a plan shown on the Approve card is the plan that runs. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The student's local day, which is how the daily limits count (`checkSendAllowed` starts its day at local midnight). */
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** The next moment inside the recipient's send window at or after `from` (jitter included, seeded when given). */
export function nextOpen(from: Date, zone: string, random: () => number = Math.random): Date {
  return new Date(nextSendWindow(from, zone, 'gmail', random).notBefore);
}

/** Local midnight (the student's) after `d`: the first instant of the next day the limits count. */
function nextLocalDay(d: Date): Date {
  const x = new Date(d.getTime() + DAY);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Times for `count` sends from `start`: each in its recipient's next send window, a random gap between each, at most
 * `perDay` a day counting the sends already planned (`taken`). `zones` gives the recipient zone per send (one zone
 * for all is fine). The first one is at least ten minutes away, so the student can still change their mind.
 */
export function planSpread(opts: {
  count: number;
  start: Date;
  perDay: number;
  zones: string | string[];
  taken?: Date[];
  seed?: number;
}): Date[] {
  const rand = rng(opts.seed ?? 7);
  const perDay = Math.max(1, Math.floor(opts.perDay));
  const used = new Map<string, number>();
  for (const t of opts.taken ?? []) used.set(dayKey(t), (used.get(dayKey(t)) ?? 0) + 1);
  const zoneOf = (i: number) => (typeof opts.zones === 'string' ? opts.zones : opts.zones[i]!);
  const out: Date[] = [];
  let cursor = new Date(opts.start.getTime() + 10 * MINUTE + Math.floor(rand() * 15) * MINUTE);
  for (let i = 0; i < opts.count; i++) {
    const zone = zoneOf(i);
    // at most a few weeks of full days before giving up on the cap and taking the window anyway
    let at = nextOpen(cursor, zone, rand);
    for (let guard = 0; guard < 60 && (used.get(dayKey(at)) ?? 0) >= perDay; guard++)
      at = nextOpen(nextLocalDay(at), zone, rand);
    out.push(at);
    used.set(dayKey(at), (used.get(dayKey(at)) ?? 0) + 1);
    const gap = AUTOPILOT_GAP_MIN.min + rand() * (AUTOPILOT_GAP_MIN.max - AUTOPILOT_GAP_MIN.min);
    cursor = new Date(at.getTime() + Math.round(gap) * MINUTE);
  }
  return out;
}

/**
 * When the next autopilot send may go: a gap after the last one sent, inside the recipient's window, so a backlog
 * never goes out at once.
 */
export function nextSlotAfter(last: Date | undefined, now: Date, seed: number, zone: string): Date {
  const rand = rng(seed);
  const gap = (AUTOPILOT_GAP_MIN.min + rand() * (AUTOPILOT_GAP_MIN.max - AUTOPILOT_GAP_MIN.min)) * MINUTE;
  const earliest = last ? new Date(Math.max(now.getTime(), last.getTime() + gap)) : now;
  return nextOpen(earliest, zone, rand);
}
