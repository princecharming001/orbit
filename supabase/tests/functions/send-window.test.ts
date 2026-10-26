import { nextSendWindow as coreWindow } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { nextSendWindow as serverWindow } from '../../functions/_shared/compose/window';

/** Plan 23 §4.9: the browser's send window (packages/core) answers what the server's does. */
describe('the send window, in the browser and on the server', () => {
  it('agrees in three zones, both channels, across a holiday, the new year and a DST change', () => {
    const zones = ['America/New_York', 'America/Los_Angeles', 'Europe/London'];
    const moments = [
      '2026-10-20T10:30:00Z',
      '2026-10-22T16:00:00Z',
      '2026-11-25T20:00:00Z',
      '2026-12-31T12:00:00Z',
      '2026-03-08T12:00:00Z',
      '2026-11-01T06:00:00Z',
    ];
    for (const tz of zones)
      for (const m of moments)
        for (const channel of ['gmail', 'linkedin'] as const)
          expect(coreWindow(new Date(m), tz, channel, () => 0.5)).toEqual(
            serverWindow(new Date(m), tz, channel, () => 0.5),
          );
  });
});
