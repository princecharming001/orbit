/**
 * X (plan 43 §5):
 *   x.dms      with no user: queue a DM read for each student whose read is due (hourly while waiting on a reply over
 *              X, daily otherwise); with a user: read their new DM events and hand them to the personal-lane writer
 *   x.expire   delete X rows in the shared graph past their 30 days
 * Both are queued by orbit.enqueue_x (hourly, 20261203_orbit_x.sql). Without X set up, or without a writer for DMs,
 * the jobs end as skipped and nothing is read.
 */
import { sqlQueue } from '../../_shared/queue.ts';
import { SocialSignInNeeded } from '../../_shared/social/adapter.ts';
import { afterInbound, storeSocialChat } from '../../_shared/social/chats.ts';
import { type XDeps, xAdapterFor } from '../../_shared/social/x/client.ts';
import { xMissing } from '../../_shared/social/x/config.ts';
import { enqueueDueXDms, pollXDms, type XDmWriter, xDmsDue } from '../../_shared/social/x/dms.ts';
import { expireX } from '../../_shared/social/x/lists.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

/** What the X jobs need: X's settings, and the DM writer (the personal-lane writer by default; a fake in tests). */
export interface XWorkerDeps extends Omit<XDeps, 'now'> {
  writer?: XDmWriter;
}

/**
 * X DMs go through the same personal-lane writer as Instagram (plan 43 §3.9): no words unless the person is in the
 * pipeline, never classified or answered otherwise, and a reply on a chat the student is waiting on moves it.
 */
export const personalLaneXWriter =
  (now: () => Date): XDmWriter =>
  async (db, userId, { chat, message }) => {
    const stored = await storeSocialChat(db, userId, 'x', chat, [message], { now: now() });
    await afterInbound(db, sqlQueue(db), userId, 'x', stored, now());
  };

export function xHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const x = deps.x;
  return {
    'x.dms': async (job, ctx) => {
      if (!x || xMissing(x.cfg).length) throw new JobSkipped('unconfigured');
      if (!job.userId) {
        await enqueueDueXDms(ctx.db, x.cfg, ctx.now());
        return;
      }
      const writer = x.writer ?? personalLaneXWriter(ctx.now);
      if (!job.payload.force && !(await xDmsDue(ctx.db, job.userId, x.cfg, ctx.now())))
        throw new JobSkipped('not_due');
      const client = await xAdapterFor(ctx.db, job.userId, { ...x, now: ctx.now }, { caller: 'dms' });
      if (!client) throw new JobSkipped('not_connected');
      try {
        await pollXDms(ctx.db, job.userId, { adapter: client.adapter, writer, now: ctx.now });
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
