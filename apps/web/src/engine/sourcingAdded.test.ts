/**
 * "Added, open" must open a page. A pull right after an add leaves out rows written in the last couple of seconds, so
 * adding pulls until the new people are in the browser's own copy.
 */
import type { Person } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';

const pulls = vi.hoisted(() => ({ n: 0, arriveOn: 2 }));
vi.mock('./serverSync', async (orig) => ({
  ...(await orig<typeof import('./serverSync')>()),
  pullNow: vi.fn(async () => {
    pulls.n++;
    if (pulls.n === pulls.arriveOn)
      await db.people.put({ id: 'p-new', userId: 'u1', displayName: 'New Person' } as Person);
    return { ok: true } as never;
  }),
}));

import { pullUntilHere } from './sourcing';

beforeEach(async () => {
  await wipeDatabase();
  pulls.n = 0;
  pulls.arriveOn = 2;
});

describe('pulling until the added people are here', () => {
  it('pulls again when the first pull came too soon, and stops once they are here', async () => {
    expect(await pullUntilHere('u1', ['p-new'], [0, 1, 1, 1])).toBe(true);
    expect(pulls.n).toBe(2);
    expect((await db.people.get('p-new'))?.displayName).toBe('New Person');
  });

  it('gives up quietly after its tries', async () => {
    pulls.arriveOn = 99;
    expect(await pullUntilHere('u1', ['p-new'], [0, 1, 1])).toBe(false);
    expect(pulls.n).toBe(3);
  });
});
