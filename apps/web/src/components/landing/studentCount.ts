/**
 * The landing page's student count: 1,833 on launch day, then 10 to 20 more each day, arriving in a few ticks at
 * random times of day. The schedule is fixed by the day's number, so every visitor sees the same count at the same
 * moment, it never goes down, and the page knows when the next tick lands.
 */

/** Midnight Pacific on the day the count went up (Oct 22, 2026). */
export const COUNT_START = Date.parse('2026-10-22T00:00:00-07:00');
export const COUNT_BASE = 1833;
const DAY = 86_400_000;

/** A small seeded generator (mulberry32): the same day always draws the same numbers. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Day `day`'s ticks: when each lands (ms since the day began) and how many it adds; 10 to 20 in all. */
export function dayTicks(day: number): { at: number; add: number }[] {
  const r = rng(0x5eed + day * 7919);
  const total = 10 + Math.floor(r() * 11);
  const parts = 3 + Math.floor(r() * 4); // 3 to 6 ticks
  // where the day's total is cut into parts, and when each part lands
  const cuts = Array.from({ length: parts - 1 }, () => 1 + Math.floor(r() * (total - 1))).sort(
    (x, y) => x - y,
  );
  const sizes = [...cuts, total].map((c, i) => c - (i ? cuts[i - 1]! : 0));
  const times = Array.from({ length: parts }, () => Math.floor(r() * DAY)).sort((x, y) => x - y);
  return times.map((at, i) => ({ at, add: sizes[i]! })).filter((t) => t.add > 0);
}

/** The count at `now`, and when the next tick lands (undefined only if something is badly wrong). */
export function studentCount(now: number = Date.now()): { count: number; nextAt?: number } {
  if (now < COUNT_START) return { count: COUNT_BASE, nextAt: COUNT_START + dayTicks(0)[0]!.at };
  let count = COUNT_BASE;
  const days = Math.floor((now - COUNT_START) / DAY);
  for (let d = 0; d < days; d++) for (const t of dayTicks(d)) count += t.add;
  const start = COUNT_START + days * DAY;
  for (const t of dayTicks(days)) {
    if (start + t.at > now) return { count, nextAt: start + t.at };
    count += t.add;
  }
  return { count, nextAt: start + DAY + dayTicks(days + 1)[0]!.at };
}
