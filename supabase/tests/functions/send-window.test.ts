import { sendDayAllowed as coreDay, nextSendWindow as coreWindow, zonedParts } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import {
  sendDayAllowed as serverDay,
  nextSendWindow as serverWindow,
} from '../../functions/_shared/compose/window';

/**
 * Plan 23 §4.9 and plan 29 §B2.1: the browser's send window (packages/core, which the browser planner now
 * schedules with) answers what the server's does. The server keeps a copy because a function cannot import the
 * browser package; this test holds the two together.
 */
describe('the send window, in the browser and on the server', () => {
  const zones = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'Europe/London', 'Asia/Tokyo'];
  const moments = [
    '2026-10-20T10:30:00Z',
    '2026-10-20T13:05:00Z',
    '2026-10-22T16:00:00Z',
    '2026-10-24T09:00:00Z',
    '2026-11-25T20:00:00Z',
    '2026-11-26T14:00:00Z',
    '2026-12-31T12:00:00Z',
    '2026-03-08T12:00:00Z',
    '2026-11-01T06:00:00Z',
    '2027-01-01T13:00:00Z',
  ];

  it('agrees in five zones, both channels, across holidays, the new year and both DST changes, at every jitter', () => {
    for (const tz of zones)
      for (const m of moments)
        for (const channel of ['gmail', 'linkedin'] as const)
          for (const r of [0, 0.37, 0.5, 0.999])
            expect(coreWindow(new Date(m), tz, channel, () => r)).toEqual(
              serverWindow(new Date(m), tz, channel, () => r),
            );
  });

  it('agrees on which days may send, a whole year of them', () => {
    let key = '2026-01-01';
    for (let i = 0; i < 365; i++) {
      for (const channel of ['gmail', 'linkedin'] as const)
        expect(coreDay(key, channel)).toBe(serverDay(key, channel));
      key = new Date(Date.parse(`${key}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
  });

  it('never answers a weekend, a holiday or an evening in the recipient’s zone', () => {
    for (const tz of zones)
      for (const m of moments) {
        const w = serverWindow(new Date(m), tz, 'gmail', () => 0.5);
        const p = zonedParts(new Date(w.notBefore), tz);
        expect([2, 3, 4]).toContain(p.weekday);
        expect(p.hour * 60 + p.minute).toBeGreaterThanOrEqual(8 * 60);
        expect(p.hour * 60 + p.minute).toBeLessThanOrEqual(10 * 60 + 30);
      }
  });
});
