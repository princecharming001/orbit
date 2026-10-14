/**
 * enrich.dossier (§5.2): builds one person's dossier with the real providers (Exa, Unipile), Opus 5.5 synthesis,
 * the per-dossier $0.25 cap and the daily caps (Exa $0.50, Claude $1.50), usage in orbit.usage_ledger, and the
 * needs_disambiguation stop when two people share the name. A person who is gone is not retried.
 */
import { HttpError } from '../../_shared/http.ts';
import { runDossierJob } from '../../_shared/research/run.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';

export function enrichDossier(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    if (!job.userId) throw new Error('enrich.dossier needs a user');
    const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
    try {
      await runDossierJob(s, job.userId, job.payload);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return;
      throw e;
    }
  };
}
