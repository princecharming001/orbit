import { zonedParts } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import {
  BATCH_GAP_MIN,
  companyKey,
  nextWorkdayOpen,
  perDayFor,
  planBatch,
  planDays,
  studentDay,
} from './batchTime';

const NY = 'America/New_York';
// Monday Nov 9 2026, 7:00 in New York
const MON_7AM = new Date('2026-11-09T12:00:00Z');

function local(d: Date, zone = NY) {
  const p = zonedParts(d, zone);
  return { ...p, minutes: p.hour * 60 + p.minute };
}

const items = (n: number, opts: { zone?: string; company?: (i: number) => string | undefined } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    zone: opts.zone ?? NY,
    company: opts.company ? opts.company(i) : `co${i}`,
  }));

describe('the pace', () => {
  it('Steady is 8 a day, Faster the daily limit, Gentle 4, and none above the limit', () => {
    expect(perDayFor('steady', 15)).toBe(8);
    expect(perDayFor('faster', 15)).toBe(15);
    expect(perDayFor('gentle', 15)).toBe(4);
    expect(perDayFor('steady', 5)).toBe(5);
    expect(perDayFor('faster', 3)).toBe(3);
  });
});

describe('planBatch', () => {
  it('40 recruiters at Steady: 8 a weekday, inside 8:00 to 11:30 or 13:00 to 16:00 their time', () => {
    const plan = planBatch({ items: items(40), pace: 'steady', cap: 15, start: MON_7AM, seed: 3 });
    expect(plan).toHaveLength(40);
    const days = planDays(plan.map((p) => p.at));
    expect(days.map((d) => d.count)).toEqual([8, 8, 8, 8, 8]);
    for (const p of plan) {
      const l = local(p.at);
      expect([1, 2, 3, 4, 5]).toContain(l.weekday);
      const inMorning = l.minutes >= 8 * 60 && l.minutes < 11 * 60 + 30;
      const inAfternoon = l.minutes >= 13 * 60 && l.minutes < 16 * 60;
      expect(inMorning || inAfternoon).toBe(true);
    }
  });

  it('keeps 6 to 20 minutes between two emails on the same day, and never sends two at once', () => {
    const plan = planBatch({ items: items(30), pace: 'faster', cap: 15, start: MON_7AM, seed: 9 });
    const sorted = plan.map((p) => p.at.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const sameDay = studentDay(new Date(sorted[i]!)) === studentDay(new Date(sorted[i - 1]!));
      if (!sameDay) continue;
      const gap = (sorted[i]! - sorted[i - 1]!) / 60_000;
      expect(gap).toBeGreaterThanOrEqual(BATCH_GAP_MIN.min - 1);
    }
    expect(new Set(sorted).size).toBe(sorted.length);
  });

  it('never two people at one company on the same day, unless the student turns that off', () => {
    const google = items(6, { company: (i) => (i < 4 ? 'google' : `co${i}`) });
    const plan = planBatch({ items: google, pace: 'faster', cap: 15, start: MON_7AM, seed: 1 });
    const googleDays = plan.filter((p) => Number(p.id.slice(1)) < 4).map((p) => studentDay(p.at));
    expect(new Set(googleDays).size).toBe(4);
    const together = planBatch({
      items: google,
      pace: 'faster',
      cap: 15,
      start: MON_7AM,
      seed: 1,
      oneCompanyADay: false,
    });
    const togetherDays = together.filter((p) => Number(p.id.slice(1)) < 4).map((p) => studentDay(p.at));
    expect(new Set(togetherDays).size).toBe(1);
  });

  it('counts what is already scheduled that day against the limit', () => {
    const taken = Array.from({ length: 6 }, (_, i) => ({
      at: new Date(MON_7AM.getTime() + (90 + i * 10) * 60_000),
      company: `other${i}`,
    }));
    const plan = planBatch({ items: items(5), pace: 'steady', cap: 15, start: MON_7AM, taken, seed: 2 });
    const monday = plan.filter((p) => studentDay(p.at) === studentDay(MON_7AM));
    expect(monday).toHaveLength(2);
    // and the new ones go after the day's last one already planned
    const lastTaken = taken[taken.length - 1]!.at.getTime();
    for (const p of monday) expect(p.at.getTime()).toBeGreaterThan(lastTaken);
  });

  it('skips the weekend and a US holiday', () => {
    // Friday Nov 27 2026 (the day after Thanksgiving) is a weekday; Thanksgiving Thu Nov 26 is a holiday
    const wedNoon = new Date('2026-11-25T21:30:00Z'); // Wed 16:30 NY, after the hours
    const plan = planBatch({ items: items(3), pace: 'steady', cap: 15, start: wedNoon, seed: 4 });
    const days = new Set(plan.map((p) => local(p.at).key));
    expect(days.has('2026-11-26')).toBe(false);
    for (const k of days) expect(['2026-11-28', '2026-11-29']).not.toContain(k);
  });

  it('Gentle keeps to Tuesday to Thursday mornings', () => {
    const plan = planBatch({ items: items(10), pace: 'gentle', cap: 15, start: MON_7AM, seed: 5 });
    for (const p of plan) {
      const l = local(p.at);
      expect([2, 3, 4]).toContain(l.weekday);
      expect(l.minutes).toBeGreaterThanOrEqual(8 * 60);
      expect(l.minutes).toBeLessThanOrEqual(10 * 60 + 30);
    }
    expect(Math.max(...planDays(plan.map((p) => p.at)).map((d) => d.count))).toBeLessThanOrEqual(4);
  });

  it('each person in their own hours: a London recruiter in the London morning', () => {
    const london = [{ id: 'l', zone: 'Europe/London', company: 'a' }];
    const [p] = planBatch({ items: london, pace: 'steady', cap: 15, start: MON_7AM, seed: 6 });
    const l = local(p!.at, 'Europe/London');
    expect(l.minutes).toBeGreaterThanOrEqual(8 * 60);
    expect(l.minutes).toBeLessThan(16 * 60);
  });

  it('the first goes at least ten minutes after the start, and the same seed gives the same plan', () => {
    const inHours = new Date('2026-11-10T14:00:00Z'); // Tue 9:00 NY
    const a = planBatch({ items: items(5), pace: 'steady', cap: 15, start: inHours, seed: 8 });
    const b = planBatch({ items: items(5), pace: 'steady', cap: 15, start: inHours, seed: 8 });
    expect(a.map((x) => x.at.toISOString())).toEqual(b.map((x) => x.at.toISOString()));
    expect(Math.min(...a.map((x) => x.at.getTime())) - inHours.getTime()).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('a limit of 1 a day still places everyone, one a day', () => {
    const plan = planBatch({ items: items(4), pace: 'faster', cap: 1, start: MON_7AM, seed: 1 });
    expect(planDays(plan.map((p) => p.at)).map((d) => d.count)).toEqual([1, 1, 1, 1]);
  });
});

describe('nextWorkdayOpen', () => {
  it('Saturday goes to Monday 8:00 plus a little', () => {
    const sat = new Date('2026-11-14T15:00:00Z');
    const l = local(nextWorkdayOpen(sat, NY, () => 0));
    expect(l.weekday).toBe(1);
    expect(l.minutes).toBe(8 * 60);
  });
  it('lunch goes to 13:00', () => {
    const lunch = new Date('2026-11-10T17:00:00Z'); // Tue 12:00 NY
    const l = local(nextWorkdayOpen(lunch, NY, () => 0));
    expect(l.minutes).toBe(13 * 60);
  });
});

describe('companyKey', () => {
  it('drops case and the usual suffixes', () => {
    expect(companyKey('Google LLC')).toBe('google');
    expect(companyKey('Stripe, Inc.')).toBe('stripe');
    expect(companyKey('')).toBeUndefined();
  });
});
