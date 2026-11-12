/**
 * X (plan 43 §5):
 *   x.dms      with no user: queue a DM read for each student whose read is due (hourly while waiting on a reply over
 *              X, daily otherwise); with a user: read their new DM events and hand them to the personal-lane writer
 *   x.expire   delete X rows in the shared graph past their 30 days
 * Both are queued by orbit.enqueue_x (hourly, 20261203_orbit_x.sql). Without X set up, or without a writer for DMs,
 * the jobs end as skipped and nothing is read.
 */
import { SocialSignInNeeded } from '../../_shared/social/adapter.ts';
import { type XDeps, xAdapterFor } from '../../_shared/social/x/client.ts';
import { xMissing } from '../../_shared/social/x/config.ts';
import { enqueueDueXDms, pollXDms, type XDmWriter, xDmsDue } from '../../_shared/social/x/dms.ts';
import { expireX } from '../../_shared/social/x/lists.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

/** What the X jobs need: X's settings and, once it exists, the personal-lane writer (_shared/social/chats.ts). */
export interface XWorkerDeps extends Omit<XDeps, 'now'> {
  writer?: XDmWriter;
}

export function xHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const x = deps.x;
  return {
    'x.dms': async (job, ctx) => {
      if (!x || xMissing(x.cfg).length) throw new JobSkipped('unconfigured');
      if (!job.userId) {
        await enqueueDueXDms(ctx.db, x.cfg, ctx.now());
        return;
      }
      // TODO(plan 43 §3.9): x.writer is the writer in _shared/social/chats.ts; until it is wired nothing is read
      if (!x.writer) throw new JobSkipped('no_writer');
      if (!job.payload.force && !(await xDmsDue(ctx.db, job.userId, x.cfg, ctx.now())))
        throw new JobSkipped('not_due');
      const client = await xAdapterFor(ctx.db, job.userId, { ...x, now: ctx.now }, { caller: 'dms' });
      if (!client) throw new JobSkipped('not_connected');
      try {
        await pollXDms(ctx.db, job.userId, { adapter: client.adapter, writer: x.writer, now: ctx.now });
      } catch (e) {
        if (e instanceof SocialSignInNeeded) throw new JobSkipped('needs_reauth');
        throw e;
      }
    },
    'x.expire': async (_job, ctx) => {
      await expireX(ctx.db, ctx.now());
    },
  };
}
