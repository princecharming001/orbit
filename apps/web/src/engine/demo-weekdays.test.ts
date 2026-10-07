// The other suites pin a Tuesday afternoon so the demo's cards exist whenever they run. That must not hide a demo that
// is empty on the days a student actually opens it: a Friday evening, a weekend, early on a Monday, late at night.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';

/** Local times, so the sweep means the same weekday and hour in any timezone the suite runs in. */
const LOADS = [
  ['Friday evening', '2026-10-09T18:00:00'],
  ['Saturday morning', '2026-10-10T10:00:00'],
  ['Sunday night', '2026-10-11T23:00:00'],
  ['Monday before work', '2026-10-05T07:00:00'],
] as const;

/** Cards the demo seeds a chat for: a scheduled chat, an unanswered outreach, a finished chat, two replies about times. */
const EXPECTED = ['prep_brief', 'follow_up_bump', 'thank_you', 'schedule_propose', 'schedule_confirm'];

afterEach(() => {
  vi.useRealTimers();
});

describe('demo loaded on any day of the week', () => {
  for (const [label, at] of LOADS)
    it(`shows prep, a pending bump and the scheduling cards on a ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(new Date(at));
      const user = await loadDemo({ reset: true });
      const kinds = new Set(
        (await db.suggestions.where('userId').equals(user.id).toArray())
          .filter((s) => s.status === 'pending')
          .map((s) => s.kind),
      );
      for (const k of EXPECTED) expect(kinds, `${k} on a ${label}`).toContain(k);
    }, 60_000);
});
