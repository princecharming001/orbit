import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/seed';

describe('demo dataset', () => {
  it('always schedules the upcoming coffee chat inside the 30 hour prep window, whatever the time of day', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 48]) {
        const now = new Date(2026, 9, 7, h, m);
        const ev = buildDemoDataset({ now }).events.find((e) => e.id === 'ev_tomorrow');
        expect(ev).toBeDefined();
        const hours = (new Date(ev!.startAt).getTime() - now.getTime()) / 3_600_000;
        expect(hours, `loaded at ${h}:${m}`).toBeGreaterThan(1);
        expect(hours, `loaded at ${h}:${m}`).toBeLessThanOrEqual(30);
      }
    }
  });
});
