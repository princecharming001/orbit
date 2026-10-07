import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/seed';
import { endOfNextBusinessDay, generateCandidates } from '../suggestions/rules';

const prepFor = (now: Date) => {
  const ds = buildDemoDataset({ now });
  return generateCandidates({
    userId: ds.user.id,
    now,
    settings: ds.settings,
    people: new Map(ds.people.map((p) => [p.id, p])),
    chats: [],
    lastInboundByChat: new Map(),
    events: ds.events,
    actionItems: [],
    factsByPerson: new Map(),
    targetCompanies: ds.targetCompanies,
    recommendations: [],
    dismissCounts: new Map(),
    outreachSentThisWeek: 0,
    freeSlotsIso: [],
    recentlyContacted: new Set(),
  }).filter((c) => c.kind === 'prep_brief');
};

describe('prep brief window', () => {
  it('looks ahead to the next business day', () => {
    const at = (s: string) => new Date(endOfNextBusinessDay(new Date(s)));
    expect(at('2026-10-06T14:00:00').getDate()).toBe(7); // Tuesday -> Wednesday
    for (const s of ['2026-10-09T09:00:00', '2026-10-10T09:00:00', '2026-10-11T20:00:00'])
      expect(at(s).getDate(), s).toBe(12); // Friday, Saturday, Sunday -> Monday
  });

  // the demo skips Christmas Eve, Christmas, New Year's Eve and New Year's Day, and so does the prep window
  it('looks past the holidays, the way the demo books its chats', () => {
    const at = (s: string) => new Date(endOfNextBusinessDay(new Date(s))).toDateString();
    expect(at('2026-12-23T09:00:00')).toBe('Mon Dec 28 2026'); // Wednesday, before Christmas Eve and Day
    expect(at('2026-12-24T19:00:00')).toBe('Mon Dec 28 2026');
    expect(at('2026-12-30T09:00:00')).toBe('Mon Jan 04 2027'); // Wednesday, before New Year's Eve and Day
    expect(at('2026-12-31T19:00:00')).toBe('Mon Jan 04 2027');
    expect(at('2026-12-22T09:00:00')).toBe('Wed Dec 23 2026'); // an ordinary day in the break still counts
  });

  it("ends the student's next working day in their own timezone, not the machine's", () => {
    // 22:00 Friday in Los Angeles is already Saturday 06:00 in UTC; either way Monday ends at midnight in Los Angeles
    const now = new Date('2026-10-10T05:00:00Z');
    expect(new Date(endOfNextBusinessDay(now, 'America/Los_Angeles')).toISOString()).toBe(
      '2026-10-13T06:59:59.999Z',
    );
    // Thursday 21:00 in Tokyo, Thursday noon in UTC: Tokyo looks ahead to Friday, its own next working day
    expect(new Date(endOfNextBusinessDay(new Date('2026-10-08T12:00:00Z'), 'Asia/Tokyo')).toISOString()).toBe(
      '2026-10-09T14:59:59.999Z',
    );
  });

  for (const s of [
    '2026-12-23T09:00:00',
    '2026-12-24T19:00:00',
    '2026-12-30T09:00:00',
    '2026-12-31T19:00:00',
  ])
    it(`preps the Monday chat when the brief runs before a holiday, on ${s}`, () => {
      expect(prepFor(new Date(s))).toHaveLength(1);
    });

  // the demo's next chat is on the next business day, so every brief, whatever the day, has a prep card
  for (const s of [
    '2026-10-06T14:00:00',
    '2026-10-09T09:00:00',
    '2026-10-09T19:00:00',
    '2026-10-10T09:00:00',
    '2026-10-11T20:00:00',
    '2026-10-12T18:30:00',
  ])
    it(`preps the next chat when the brief runs on ${s}`, () => {
      expect(prepFor(new Date(s))).toHaveLength(1);
    });

  it('has a prep card whatever day of the year the demo is loaded', { timeout: 120_000 }, () => {
    const start = new Date('2026-10-01T00:00:00');
    for (let i = 0; i < 366; i++) {
      const now = new Date(start);
      now.setDate(start.getDate() + i);
      now.setHours(i % 2 ? 19 : 9);
      expect(prepFor(now), now.toString()).toHaveLength(1);
    }
  });

  it('waits when the chat is two business days out', () => {
    // Tuesday 09:00, with the demo's Wednesday chat moved to Thursday afternoon
    const now = new Date('2026-10-06T09:00:00');
    const ds = buildDemoDataset({ now });
    const ev = ds.events.find((e) => new Date(e.startAt) > now)!;
    expect(prepFor(now)).toHaveLength(1);
    ev.startAt = new Date('2026-10-08T15:00:00').toISOString();
    const cands = generateCandidates({
      userId: ds.user.id,
      now,
      settings: ds.settings,
      people: new Map(ds.people.map((p) => [p.id, p])),
      chats: [],
      lastInboundByChat: new Map(),
      events: [ev],
      actionItems: [],
      factsByPerson: new Map(),
      targetCompanies: [],
      recommendations: [],
      dismissCounts: new Map(),
      outreachSentThisWeek: 0,
      freeSlotsIso: [],
      recentlyContacted: new Set(),
    });
    expect(cands.some((c) => c.kind === 'prep_brief')).toBe(false);
  });
});
