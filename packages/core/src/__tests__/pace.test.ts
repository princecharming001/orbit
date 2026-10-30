import { describe, expect, it } from 'vitest';
import { paceLine, weeklyCapacity, weekPace } from '../suggestions/pace';

// Wednesday 2026-11-04, 10:00 in New York; the week runs Mon 2 to Sun 8, no holidays in it
const WED = new Date('2026-11-04T15:00:00Z');
const TZ = 'America/New_York';
const base = { now: WED, tz: TZ, dailyCap: 25, sentToday: 0 };

describe('weekPace', () => {
  it('spreads what the week still needs over the working days left, today included', () => {
    const p = weekPace({ ...base, target: 10, sentThisWeek: 4 });
    expect(p).toMatchObject({ target: 10, remaining: 6, workDays: 5, daysLeft: 3, today: 2, leftToday: 2 });
    expect(p.status).toBe('on_pace');
    expect(p.days.map((d) => d.when)).toEqual([
      'past',
      'past',
      'today',
      'future',
      'future',
      'future',
      'future',
    ]);
    expect(p.days.map((d) => d.counted)).toEqual([true, true, true, true, true, false, false]);
  });

  it('catches up after a slow start and holds back after a fast one', () => {
    const slow = weekPace({ ...base, target: 10, sentThisWeek: 0 });
    expect(slow.status).toBe('behind');
    expect(slow.today).toBe(4); // 10 over Wed, Thu, Fri
    const fast = weekPace({ ...base, target: 10, sentThisWeek: 8 });
    expect(fast.status).toBe('ahead');
    expect(fast.today).toBe(1);
  });

  it("holds today's number still while today's messages go out", () => {
    const morning = weekPace({ ...base, target: 10, sentThisWeek: 0 });
    const noon = weekPace({ ...base, target: 10, sentThisWeek: 3, sentToday: 3 });
    expect(noon.today).toBe(morning.today);
    expect(noon.leftToday).toBe(1);
  });

  it('holds a day at the sending limits', () => {
    const p = weekPace({ ...base, target: 350, sentThisWeek: 0, dailyCap: 25 });
    expect(p.today).toBe(25);
    expect(p.capped).toBe(true);
    expect(paceLine(p)).toBe('25 first messages today, the most your sending limits allow.');
  });

  it('says today in a sentence with the verb matching the count', () => {
    expect(paceLine(weekPace({ ...base, target: 10, sentThisWeek: 0 }))).toBe(
      '4 first messages today catch you up.',
    );
    expect(paceLine(weekPace({ ...base, target: 5, sentThisWeek: 2 }))).toBe(
      '1 first message today keeps you on pace.',
    );
  });

  it('plans nothing on the day setup ends, and cuts the week to the days after it', () => {
    const p = weekPace({ ...base, target: 10, sentThisWeek: 0, startedAt: '2026-11-04T14:00:00Z' });
    expect(p.status).toBe('starting');
    expect(p.today).toBe(0);
    expect(p.workDays).toBe(2); // Thursday and Friday
    expect(p.target).toBe(4);
    expect(paceLine(p, 'tomorrow')).toBe('Your pace starts tomorrow.');
    const thursday = weekPace({
      ...base,
      now: new Date('2026-11-05T15:00:00Z'),
      target: 10,
      sentThisWeek: 0,
      startedAt: '2026-11-04T14:00:00Z',
    });
    expect(thursday.today).toBe(2);
  });

  it('rests on weekends and quiet days, and is done once the target is met', () => {
    const sat = weekPace({ ...base, now: new Date('2026-11-07T15:00:00Z'), target: 10, sentThisWeek: 7 });
    expect(sat).toMatchObject({ status: 'resting', today: 0, leftToday: 0 });
    const quiet = weekPace({ ...base, target: 10, sentThisWeek: 4, quietDays: [3] });
    expect(quiet.status).toBe('resting');
    expect(quiet.workDays).toBe(4);
    const done = weekPace({ ...base, target: 4, sentThisWeek: 4 });
    expect(done.status).toBe('done');
    expect(done.leftToday).toBe(0);
  });

  it('skips holidays: Thanksgiving week has three working days', () => {
    const p = weekPace({ ...base, now: new Date('2026-11-23T15:00:00Z'), target: 9, sentThisWeek: 0 });
    expect(p.workDays).toBe(3);
    expect(p.today).toBe(3);
  });
});

describe('weeklyCapacity', () => {
  it('is a full day of both limits on each working weekday', () => {
    expect(weeklyCapacity({ dailySendCapGmail: 15, dailySendCapLinkedin: 10 })).toBe(125);
    expect(weeklyCapacity({ dailySendCapGmail: 15, dailySendCapLinkedin: 10, quietDays: [5, 0] })).toBe(100);
  });
});
