/**
 * source.search (§6): the sourcing run of /source/search in the background (the chat's find_people on a slow
 * provider); results land in orbit.recommendations under the request's batch.
 */
import type { SourceSearchRequest } from '@orbit/core/server/api';
import { HttpError } from '../../_shared/http.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import { runSourcing } from '../../_shared/sourcing/run.ts';
import type { JobHandler } from '../worker.ts';

export function sourceSearch(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    if (!job.userId) throw new Error('source.search needs a user');
    const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
    try {
      await runSourcing(s, job.userId, job.payload as unknown as SourceSearchRequest);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return;
      throw e;
    }
  };
}
