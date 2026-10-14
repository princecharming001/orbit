/**
 * Tie scores (§2.3, §3):
 *   score.person {personIds | personId}   after new mail, meetings or LinkedIn activity: the interaction ties of
 *                                         those people are recounted, then they are re-scored
 *   score.user                            nightly and after a backfill: every inferred tie kind is rebuilt with
 *                                         decay, the user's calibration is refit when they have ≥ 8 labels, and
 *                                         everyone is re-scored
 */

import { isUuid } from '../../_shared/crypto.ts';
import { scorePeople } from '../../_shared/ingest/score.ts';
import { refreshTies } from '../../_shared/ingest/ties.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

export function scoreHandlers(_deps: HandlerDeps): Record<string, JobHandler> {
  return {
    'score.person': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      const raw = Array.isArray(job.payload.personIds) ? job.payload.personIds : [job.payload.personId];
      const ids = [...new Set(raw.filter(isUuid))];
      if (!ids.length) return;
      const now = ctx.now();
      await refreshTies(ctx.db, job.userId, now, { personIds: ids });
      await scorePeople(ctx.db, job.userId, { now, personIds: ids });
    },
    'score.user': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      await refreshTies(ctx.db, job.userId, now);
      await scorePeople(ctx.db, job.userId, { now, fit: true });
    },
  };
}
