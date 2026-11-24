/**
 * roles.topup (plan 44 §5, last paragraph): the nightly top-up for one student who opened Roles lately. Payload {},
 * userId set. Reads at most 20 roles the student has no match for yet, for their current profile, so the tab has
 * something new without waiting. The source side's tick enqueues it.
 */
import type { RolesDeps } from '../../_shared/roles/score.ts';
import { topup } from '../../_shared/roles/search.ts';
import { roleSources } from '../../_shared/roles/sources.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';

export function rolesTopupHandlers(
  config: AgentConfig = { env: {} },
  deps: RolesDeps = { sources: roleSources },
): Record<string, JobHandler> {
  return {
    'roles.topup': async (job, ctx) => {
      if (!job.userId) throw new Error('roles.topup needs a user');
      const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
      const r = await topup(s, deps, job.userId);
      console.log(JSON.stringify({ fn: 'orbit-worker', step: 'roles.topup', ...r }));
    },
  };
}
