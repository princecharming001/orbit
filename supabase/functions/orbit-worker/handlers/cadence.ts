/**
 * cadence.user (§9.3): the hourly follow-up scan for one user: bump, thank-you and nurture drafts (templates when
 * Claude is not configured), stage timers, and sends whose time has come queued with dedupe key send:<draftId>.
 */
import { runCadence } from '../../_shared/cadence/cadence.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';

export function cadenceUser(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    if (!job.userId) throw new Error('cadence.user needs a user');
    await runCadence(makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue }), job.userId);
  };
}
