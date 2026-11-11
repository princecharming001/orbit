import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { recommendationsRefresh } from './brief';
import { loadDemo } from './demo';

/**
 * Discover showed one person while the list refreshed: the refresh wrote each person on its own (removed, then put
 * back), the list changed dozens of times, and every change restarted the page's read for its network cards. The
 * whole list is now one write, so a reader sees the old list or the new one, never a list being rebuilt.
 */
describe('recommendationsRefresh', () => {
  it('writes the whole list in one transaction', async () => {
    const user = await loadDemo({ reset: true });
    const txs = new Set<unknown>();
    const onWrite = () => {
      txs.add(Dexie.currentTransaction);
    };
    db.recommendations.hook('creating', onWrite);
    db.recommendations.hook('deleting', onWrite);
    db.recommendations.hook('updating', onWrite);
    try {
      const n = await recommendationsRefresh(user, new Date());
      expect(n).toBeGreaterThan(1);
    } finally {
      db.recommendations.hook('creating').unsubscribe(onWrite);
      db.recommendations.hook('deleting').unsubscribe(onWrite);
      db.recommendations.hook('updating').unsubscribe(onWrite);
    }
    expect(txs.size).toBe(1);
    // and the list is there afterwards, one new card per person
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    const fresh = recs.filter((r) => r.status === 'new');
    expect(new Set(fresh.map((r) => r.personId)).size).toBe(fresh.length);
  }, 90_000);
});
