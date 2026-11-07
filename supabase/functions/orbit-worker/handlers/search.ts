/**
 * Network search (plan 32 §6):
 *   company_facts_sync   nightly, for everyone: YC's directory into orbit_private.company_facts
 *   search_census        every three hours per student with LinkedIn: one step of the sweep of their connections
 */

import { loadAccount } from '../../_shared/ingest/util.ts';
import { runCensusStep } from '../../_shared/search/census.ts';
import { syncCompanyFacts } from '../../_shared/search/companyFacts.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

export function searchHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const doFetch = deps.fetch ?? fetch;
  return {
    company_facts_sync: async (_job, ctx) => {
      const r = await syncCompanyFacts(ctx.db, doFetch, ctx.now());
      if (r.skipped === 'fetch_failed') throw new Error('yc-oss fetch failed');
      if (r.skipped) throw new JobSkipped(r.skipped);
    },
    search_census: async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const { apiKey, baseUrl } = deps.unipile ?? {};
      if (!apiKey || !baseUrl) throw new JobSkipped('unconfigured');
      const acct = await loadAccount(ctx.db, userId, 'linkedin');
      if (!acct?.externalAccountId) throw new JobSkipped('not_connected');
      if (acct.status !== 'active') throw new JobSkipped(acct.status);
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      await runCensusStep(
        ctx.db,
        {
          fetch: doFetch,
          apiKey,
          baseUrl,
          sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
          random: deps.random ?? Math.random,
          clock: deps.clock ?? Date.now,
        },
        userId,
        acct.externalAccountId,
        ctx.now(),
      );
    },
  };
}
