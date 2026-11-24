/**
 * Plan 44, the source side of Roles:
 *   roles.tick   every 10 minutes (cron orbit-roles), for everyone: the boards that are due, the SimplifyJobs lists
 *                once a day, looking for more boards, closing and deleting old roles, and once a night the
 *                roles.topup jobs for students who searched in the last 14 days (_shared/roles/tick.ts)
 * roles.topup is the search side's (scores a few new roles for one student); this file only queues it.
 */
import { type RolesTickDeps, runRolesTick } from '../../_shared/roles/tick.ts';
import type { JobHandler } from '../worker.ts';
import type { HandlerDeps } from './deps.ts';

export function rolesHandlers(
  deps: HandlerDeps & { roles?: Partial<Omit<RolesTickDeps, 'net' | 'queue' | 'clock'>> } = {},
): Record<string, JobHandler> {
  return {
    'roles.tick': async (_job, ctx) => {
      const r = await runRolesTick(ctx.db, {
        net: { fetch: deps.fetch ?? fetch, now: ctx.now, sleep: deps.sleep },
        queue: ctx.queue,
        clock: deps.clock ?? Date.now,
        ...deps.roles,
      });
      console.log(JSON.stringify({ fn: 'orbit-worker', step: 'roles_tick', ...r }));
    },
  };
}
