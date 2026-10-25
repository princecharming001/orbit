/**
 * hop_evidence (plan 21 §5.3): one target's LinkedIn hop evidence, gathered and stored by _shared/paths/hopJob.ts.
 * Unipile not configured, LinkedIn not connected or nobody with a member id ends the job as skipped (not retried).
 */
import { runHopEvidenceJob } from '../../_shared/paths/hopJob.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';
import { JobSkipped } from './deps.ts';

export function hopEvidenceHandler(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    if (!job.userId) throw new Error('hop_evidence needs a user');
    const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
    const r = await runHopEvidenceJob(s, job.userId, job.payload);
    if (r.status === 'skipped') throw new JobSkipped(r.reason);
  };
}
