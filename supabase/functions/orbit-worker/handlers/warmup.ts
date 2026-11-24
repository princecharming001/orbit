/**
 * warmup.step: one step of an automated LinkedIn warm-up whose time has come (queued every five minutes by
 * orbit.enqueue_warmup_steps). `runWarmupStep` decides everything: whether the run should still go on, whether it is
 * working hours for the student, whether the daily caps and the spacing allow it, and what a failure means. The job
 * itself never throws for a LinkedIn failure, so the queue never retries one on its own schedule: a step is tried
 * again only by the plan (once, later that day), and a like or a comment is never repeated blindly.
 */
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import { runWarmupStep } from '../../_shared/warmup/warmup.ts';
import type { JobHandler } from '../worker.ts';

export function warmupStepHandler(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    const stepId = job.payload.stepId;
    if (!job.userId) throw new Error('warmup.step needs a user');
    if (typeof stepId !== 'string' || !/^[0-9a-f-]{36}$/i.test(stepId))
      throw new Error('warmup.step needs a stepId');
    const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
    const out = await runWarmupStep(s, job.userId, stepId);
    console.log(
      JSON.stringify({
        fn: 'orbit-worker',
        step: 'warmup.step',
        outcome: out.kind,
        ...('why' in out ? { why: out.why } : {}),
        ...('reason' in out ? { reason: out.reason } : {}),
        ...('note' in out ? { note: out.note } : {}),
        ...('error' in out ? { error: out.error } : {}),
      }),
    );
  };
}
