import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { cancelScheduled, planSchedule, planSpread, scheduledSends, scheduleSends } from './autopilot';
import { loadDemo } from './demo';
import { sendDueQueued } from './send';
import { draftLists } from './today';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

const MIN = 60_000;

describe('autopilot timing', () => {
  it('spreads sends over weekdays, inside 9 to 5, a day at a time, never closer than 25 minutes', () => {
    // a Friday afternoon: what does not fit goes Monday
    const start = new Date(2026, 9, 9, 15, 30);
    const times = planSpread({ count: 9, start, perDay: 3, seed: 3 });
    expect(times).toHaveLength(9);
    const perDay = new Map<string, number>();
    for (const t of times) {
      expect([0, 6]).not.toContain(t.getDay());
      expect(t.getHours()).toBeGreaterThanOrEqual(9);
      expect(t.getHours()).toBeLessThan(17);
      const k = t.toDateString();
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(3);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]!.getTime() - times[i - 1]!.getTime();
      expect(gap).toBeGreaterThanOrEqual(25 * MIN);
    }
    // the first one is never right away
    expect(times[0]!.getTime() - start.getTime()).toBeGreaterThanOrEqual(10 * MIN);
  });
});

describe('autopilot in the demo', () => {
  it('schedules the day’s drafts, sends one at a time with a gap, spreads out what it missed, and can be cancelled', async () => {
    const [suggestions, outbound, briefs] = await Promise.all([
      db.suggestions.where('userId').equals(user.id).toArray(),
      db.outbound.where('userId').equals(user.id).toArray(),
      db.briefs.where('userId').equals(user.id).toArray(),
    ]);
    const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
    const now = new Date();
    const ids = draftLists(suggestions, outbound, latest, now)
      .forToday.map((s) => s.outboundMessageId)
      .filter((x): x is string => !!x);
    const drafts = (await db.outbound.bulkGet(ids)).filter((d) => d && d.status === 'draft').slice(0, 3);
    expect(drafts.length).toBeGreaterThan(1);
    const plan = await planSchedule(user, drafts as never, { perDay: 6, now });
    const results = await scheduleSends(user, plan, now);
    const scheduled = results.filter((r) => r.ok);
    expect(scheduled.length).toBeGreaterThan(1);
    const queue = await scheduledSends(user.id);
    expect(queue.map((o) => o.autopilot)).toEqual(queue.map(() => true));

    // Orbit was closed past every time: one goes, the rest move to later slots, never a burst
    const later = new Date(new Date(queue.at(-1)!.sendAt!).getTime() + 5 * MIN);
    const first = await sendDueQueued(user, later);
    expect(first.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const after = await scheduledSends(user.id);
    for (const o of after) expect(new Date(o.sendAt!).getTime()).toBeGreaterThanOrEqual(later.getTime());
    const moved = after.map((o) => new Date(o.sendAt!).getTime());
    for (let i = 1; i < moved.length; i++) expect(moved[i]! - moved[i - 1]!).toBeGreaterThanOrEqual(25 * MIN);

    // a planned send can be taken back: a draft again, untouched
    const one = after[0]!;
    expect(await cancelScheduled(user.id, one.id)).toBe(true);
    const back = (await db.outbound.get(one.id))!;
    expect(back.status).toBe('draft');
    expect(back.autopilot).toBeUndefined();
  });
});
