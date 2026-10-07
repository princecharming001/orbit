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
