import { describe, expect, it } from 'vitest';
import { costDays } from './Costs';

describe('the owner cost view', () => {
  it('reads either digest shape into days with totals, cache share, alerts and thresholds', () => {
    const days = costDays([
      {
        at: '2026-11-10T07:50:00Z',
        details: {
          day: '2026-11-09',
          providers: [
            { provider: 'hunter', usd: 0, units: 3, calls: 3 },
            { provider: 'anthropic', usd: 1.25, units: 0, calls: 40 },
          ],
          chat: { cacheShare: 72.4 },
          alerts: ['Anthropic over $1 yesterday', { text: 'Hunter at 30 credits this month' }],
          thresholds: { anthropic_daily_usd: 5, hunter_monthly_credits: 30 },
        },
      },
      { at: '2026-11-09T07:50:00Z', details: { providers: { anthropic: { cost_usd: '0.4' }, exa: 0.01 } } },
      { at: '2026-11-08T07:50:00Z', details: {} },
    ]);
    expect(days[0]).toMatchObject({
      day: '2026-11-09',
      totalUsd: 1.25,
      alerts: ['Anthropic over $1 yesterday', 'Hunter at 30 credits this month'],
      thresholds: { anthropic_daily_usd: 5, hunter_monthly_credits: 30 },
    });
    expect(days[0]!.providers.map((p) => p.provider)).toEqual(['anthropic', 'hunter']);
    expect(days[0]!.cacheShare).toBeCloseTo(0.724, 3);
    expect(days[1]!.day).toBe('2026-11-09');
    expect(days[1]!.totalUsd).toBeCloseTo(0.41, 6);
    expect(days[2]).toMatchObject({ day: '2026-11-08', totalUsd: 0, providers: [], cacheShare: undefined });
  });
});
