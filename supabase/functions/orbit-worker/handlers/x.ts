/**
 * X (plan 43 §5):
 *   sync.x     the first days on connect: the student's own following list, read to the end (`readXListToEnd`) under
 *              the list limit, which also says who follows them back (connection_status); the accounts they follow
 *              each other with go to matching (public proof only). Then their DMs are read once.
 *   x.dms      with no user: queue a DM read for each student whose read is due (hourly while waiting on a reply over
 *              X, daily otherwise); with a user: read their new DM events and hand them to the personal-lane writer
 *   x.expire   delete X rows in the shared graph past their 30 days
 * Both are queued by orbit.enqueue_x (hourly, 20261203_orbit_x.sql). Without X set up, or without a writer for DMs,
 * the jobs end as skipped and nothing is read.
 */
import { sqlQueue } from '../../_shared/queue.ts';
import { SocialSignInNeeded } from '../../_shared/social/adapter.ts';
import { afterInbound, storeSocialChat } from '../../_shared/social/chats.ts';
import { type XDeps, xAdapterFor, xSetupMissing } from '../../_shared/social/x/client.ts';
import { enqueueDueXDms, pollXDms, type XDmWriter, xDmsDue } from '../../_shared/social/x/dms.ts';
import { expireX, readXListToEnd } from '../../_shared/social/x/lists.ts';
import { saveXState } from '../../_shared/social/x/oauth.ts';
import { sourceIsOn } from '../../_shared/sources/states.ts';
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
  const offered = deps.offered ?? [];
  return {
    'sync.x': async (job, ctx) => {
      if (!x || (await xSetupMissing(ctx.db, x.cfg)).length) throw new JobSkipped('unconfigured');
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      if (!(await sourceIsOn(ctx.db, userId, 'x', offered))) throw new JobSkipped('source_off');
      const client = await xAdapterFor(ctx.db, userId, { ...x, now: ctx.now }, { caller: 'own' });
      if (!client?.meId) throw new JobSkipped('not_connected');
      let r: Awaited<ReturnType<typeof readXListToEnd>>;
      try {
        r = await readXListToEnd(ctx.db, client.adapter, {
          accountId: client.meId,
          list: 'following',
          limit: x.cfg.listLimit,
          ownerUserId: userId,
          readBy: userId,
          meId: client.meId,
          now: ctx.now,
        });
      } catch (e) {
        if (e instanceof SocialSignInNeeded) throw new JobSkipped('needs_reauth');
        throw e;
      }
      await saveXState(ctx.db, userId, {
        following: r.ok
          ? { readAt: ctx.now().toISOString(), size: r.ids.length }
          : {
              readAt: ctx.now().toISOString(),
              reason: r.reason,
              ...(r.size !== undefined ? { size: r.size } : {}),
            },
      });
      if (!r.ok) {
        // X asked Orbit to slow down: once more a little later; anything else waits for the student
        if (r.reason === 'rate_limited')
          await ctx.queue.enqueue(
            {
              kind: 'sync.x',
              userId,
              payload: {},
              dedupeKey: `sync.x:${userId}:retry:${ctx.now().toISOString()}`,
            },
            { delaySec: 15 * 60 },
          );
        return;
      }
      // the accounts they follow each other with: matched by public proof only
      const mutual = r.ids.filter((id) => r.relations[id]?.followedBy);
      if (mutual.length)
        await ctx.queue.enqueue({
          kind: 'social.match',
          userId,
          payload: { platform: 'x', accountIds: mutual },
          dedupeKey: `social.match:${userId}:x:connect:${ctx.now().toISOString()}`,
        });
      await ctx.queue.enqueue(
        // the first read is due at once; it still needs the consent and X on (xDmsDue)
        {
          kind: 'x.dms',
          userId,
          payload: {},
          dedupeKey: `x-dms:${userId}:connect:${ctx.now().toISOString()}`,
        },
        { queue: 'orbit_sync' },
      );
    },
    'x.dms': async (job, ctx) => {
      if (!x || (await xSetupMissing(ctx.db, x.cfg)).length) throw new JobSkipped('unconfigured');
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
