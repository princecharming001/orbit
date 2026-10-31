/**
 * Friends (plan 29 §A4):
 *   friend_shares_refresh     rewrite one owner's projection in one transaction, after their people, identities or tie
 *                             scores changed and nightly (orbit.enqueue_friend_refresh); the asks past their time
 *                             expire on the same run
 */
import { refreshFriendShares } from '../../_shared/friends/shares.ts';
import type { JobHandler } from '../worker.ts';
import { JobSkipped } from './deps.ts';

export function friendHandlers(): Record<string, JobHandler> {
  return {
    friend_shares_refresh: async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      await ctx.db.sql`select orbit.expire_friend_asks()`;
      await refreshFriendShares(ctx.db, job.userId, ctx.now());
    },
  };
}
