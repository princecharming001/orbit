/**
 * Network search (plan 32 §6):
 *   company_facts_sync   nightly, for everyone: YC's directory into orbit_private.company_facts
 *   search_census        every three hours per student with LinkedIn: one step of the sweep of their connections
 *   search_reading       every two hours per student with LinkedIn (plan 33): company pages, a few profiles' About
 *                        sections and jobs, and Claude's reading of them
 *   logos.sweep          weekly, for everyone (plan 35 B4): LinkedIn logos for companies 3 or more people work at
 *                        across all students, into the shared company list; queues its next part while names are left
 *   logos.user           daily per student with LinkedIn (plan 37 follow-up): every company in their network, most
 *                        people first, from their own account; queues its next part while names and the day's share
 *                        are left
 */

import type { Db } from '../../_shared/db.ts';
import { loadAccount } from '../../_shared/ingest/util.ts';
import { sqlTargetTake } from '../../_shared/linkedinTargets.ts';
import {
  keepProfileLogos,
  logosPublicBase,
  storageLogoWriter,
} from '../../_shared/providers/linkedinCompanies.ts';
import { runCensusStep } from '../../_shared/search/census.ts';
import { syncCompanyFacts, syncYcFounders } from '../../_shared/search/companyFacts.ts';
import {
  runLogoSweep,
  runUserLogos,
  SWEEP_MAX_PARTS,
  sqlCompanyCache,
  USER_MAX_PARTS,
} from '../../_shared/search/logoSweep.ts';
import { runReadingStep } from '../../_shared/search/reading.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

export function searchHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const doFetch = deps.fetch ?? fetch;
  // the swarm limit, asked before each background profile read (linkedinTargets.ts)
  const targetTake = (db: Db) => (deps.linkedinTarget ? sqlTargetTake(db, deps.linkedinTarget) : undefined);
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
    'logos.sweep': async (job, ctx) => {
      const { apiKey, baseUrl } = deps.unipile ?? {};
      const { url, serviceKey } = deps.storage ?? {};
      if (!apiKey || !baseUrl || !url || !serviceKey) throw new JobSkipped('unconfigured');
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const r = await runLogoSweep(
        ctx.db,
        {
          fetch: doFetch,
          apiKey,
          baseUrl,
          storeLogo: storageLogoWriter(url, serviceKey, doFetch),
          sleep: deps.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms))),
          random: deps.random ?? Math.random,
          clock: deps.clock ?? Date.now,
        },
        now,
      );
      console.log(JSON.stringify({ fn: 'orbit-worker', step: 'logos_sweep', ...r }));
      if (r.stopped === 'no_accounts') throw new JobSkipped('no_accounts');
      // time ran out with names left: the next part, this week, a few minutes on; spent shares wait for next week
      const part = Number(job.payload.part ?? 0) || 0;
      if (r.stopped === 'time' && r.remaining > 0 && part + 1 < SWEEP_MAX_PARTS)
        await ctx.queue.enqueue(
          {
            kind: 'logos.sweep',
            userId: null,
            payload: { part: part + 1 },
            dedupeKey: `weekly:logos.sweep:${isoWeek(now)}:${part + 1}`,
          },
          { delaySec: 300 },
        );
    },
    'logos.user': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const { apiKey, baseUrl } = deps.unipile ?? {};
      const { url, serviceKey } = deps.storage ?? {};
      if (!apiKey || !baseUrl || !url || !serviceKey) throw new JobSkipped('unconfigured');
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const r = await runUserLogos(
        ctx.db,
        userId,
        {
          fetch: doFetch,
          apiKey,
          baseUrl,
          storeLogo: storageLogoWriter(url, serviceKey, doFetch),
          logosBase: logosPublicBase(url),
          sleep: deps.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms))),
          random: deps.random ?? Math.random,
          clock: deps.clock ?? Date.now,
          targetTake: targetTake(ctx.db),
        },
        now,
      );
      console.log(JSON.stringify({ fn: 'orbit-worker', step: 'logos_user', ...r }));
      if (r.stopped === 'no_accounts') throw new JobSkipped('not_connected');
      // time ran out with names left: the next part in two minutes; a spent share waits for tomorrow's run
      const part = Number(job.payload.part ?? 0) || 0;
      const day = now.toISOString().slice(0, 10);
      if (r.stopped === 'time' && r.remaining > 0 && part + 1 < USER_MAX_PARTS)
        await ctx.queue.enqueue(
          {
            kind: 'logos.user',
            userId,
            payload: { part: part + 1 },
            dedupeKey: `logos.user:${userId}:${day}:${part + 1}`,
          },
          { delaySec: 120 },
        );
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
          targetTake: targetTake(ctx.db),
          // the logos a profile read shows, kept as Orbit's own copies for everyone (no extra read)
          keepLogos:
            deps.storage?.url && deps.storage.serviceKey
              ? (orgs) =>
                  keepProfileLogos(
                    sqlCompanyCache(
                      ctx.db,
                      storageLogoWriter(deps.storage!.url!, deps.storage!.serviceKey!, doFetch),
                    ),
                    orgs,
                    doFetch,
                    ctx.now(),
                    { accountId: acct.externalAccountId ?? undefined },
                  )
              : undefined,
        },
        userId,
        acct.externalAccountId,
        ctx.now(),
      );
      await founders;
    },
  };
}

/** "2026-45": the ISO year and week, the same as orbit.enqueue_logos_sweep's to_char(..., 'IYYY-IW'). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}
