import { describe, expect, it } from 'vitest';
import { composeKindFor, draftKindLabel, firstKindFor } from '../pipeline/transitions';

/** Someone the student has talked with before never gets a "First message" (plan 37 follow-up). */
const NOW = new Date('2026-11-12T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('the opening kind', () => {
  it('a stranger gets a first message; someone known a check-in, however long ago', () => {
    expect(firstKindFor(undefined)).toBe('outreach');
    expect(firstKindFor(daysAgo(9))).toBe('nurture');
    expect(firstKindFor(daysAgo(700))).toBe('nurture');
    expect(composeKindFor(undefined, NOW)).toEqual({ kind: 'outreach' });
    expect(composeKindFor(undefined, NOW, { talkedAt: daysAgo(9) })).toEqual({ kind: 'nurture' });
    expect(
      composeKindFor({ stage: 'identified' } as Parameters<typeof composeKindFor>[0], NOW, {
        talkedAt: daysAgo(400),
      }),
    ).toEqual({ kind: 'nurture' });
  });

  it('a started first message to someone known reads as the check-in it is', () => {
    expect(draftKindLabel('outreach', daysAgo(5))).toBe('Check-in');
    expect(draftKindLabel('outreach', daysAgo(400))).toBe('Check-in');
    expect(draftKindLabel('outreach', undefined)).toBe('First message');
    expect(draftKindLabel('bump', daysAgo(5))).toBe('Follow-up');
  });
});
