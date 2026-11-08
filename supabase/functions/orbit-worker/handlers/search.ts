/**
 * Network search (plan 32 §6):
 *   company_facts_sync   nightly, for everyone: YC's directory into orbit_private.company_facts
 *   search_census        every three hours per student with LinkedIn: one step of the sweep of their connections
 *   search_reading       every two hours per student with LinkedIn (plan 33): company pages, a few profiles' About
 *                        sections and jobs, and Claude's reading of them
 */

import { loadAccount } from '../../_shared/ingest/util.ts';
import { runCensusStep } from '../../_shared/search/census.ts';
import { syncCompanyFacts, syncYcFounders } from '../../_shared/search/companyFacts.ts';
import { runReadingStep } from '../../_shared/search/reading.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

export function searchHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const doFetch = deps.fetch ?? fetch;
  return {
    company_facts_sync: async (_job, ctx) => {
      const clock = deps.clock ?? Date.now;
      const started = clock();
      const r = await syncCompanyFacts(ctx.db, doFetch, ctx.now());
      if (r.skipped === 'fetch_failed') throw new Error('yc-oss fetch failed');
      if (r.skipped) throw new JobSkipped(r.skipped);
      // founder lists from YC's pages, everyone's network companies first, in what is left of the job's time
      const f = await syncYcFounders(ctx.db, doFetch, {
        userId: null,
        n: 80,
        deadline: started + 45_000,
        clock,
      });
      console.log(JSON.stringify({ fn: 'orbit-worker', step: 'yc_founders', ...f }));
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
    search_reading: async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const { apiKey, baseUrl } = deps.unipile ?? {};
      if (!apiKey || !baseUrl) throw new JobSkipped('unconfigured');
      const acct = await loadAccount(ctx.db, userId, 'linkedin');
      if (!acct?.externalAccountId) throw new JobSkipped('not_connected');
      if (acct.status !== 'active') throw new JobSkipped(acct.status);
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const clock = deps.clock ?? Date.now;
      // YC founder lists for this student's companies run beside the reading (both wait on the network)
      const founders = syncYcFounders(ctx.db, doFetch, {
        userId,
        n: 16,
        deadline: clock() + 40_000,
        clock,
        networkOnly: true,
      })
        .then((f) =>
          console.log(JSON.stringify({ fn: 'orbit-worker', step: 'yc_founders', userJob: true, ...f })),
        )
        .catch((e) =>
          console.log(
            JSON.stringify({
              fn: 'orbit-worker',
              step: 'yc_founders',
              error: String(e?.message ?? e).slice(0, 200),
            }),
          ),
        );
      await runReadingStep(
        ctx.db,
        {
          fetch: doFetch,
          apiKey,
          baseUrl,
          claude: deps.claude,
          sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
          random: deps.random ?? Math.random,
          clock: deps.clock ?? Date.now,
        },
        userId,
        acct.externalAccountId,
        ctx.now(),
      );
      await founders;
    },
  };
}
