/**
 * Friends (plan 29 §A4):
 *   friend_shares_refresh     rewrite one owner's projection in one transaction, after their people, identities or tie
 *                             scores changed and nightly (orbit.enqueue_friend_refresh); the asks past their time
 *                             expire on the same run
 */
import { refreshFriendShares } from '../../_shared/friends/shares.ts';
import { sourcesFor } from '../../_shared/sources/states.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

export function friendHandlers(deps: Pick<HandlerDeps, 'offered'> = {}): Record<string, JobHandler> {
  return {
    friend_shares_refresh: async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      await ctx.db.sql`select orbit.expire_friend_asks()`;
      // plan 43 §3.2: people known only from an optional source out of use are not shared
      const src = await sourcesFor(ctx.db, job.userId, deps.offered ?? []);
      await refreshFriendShares(ctx.db, job.userId, ctx.now(), src);
    },
  };
}
