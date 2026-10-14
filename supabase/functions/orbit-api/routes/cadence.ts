/**
 * Cadence (§9): POST /cadence/due → what the hourly scan would do now (bumps, went quiet, thank-yous, stage timers,
 * nurture notes, sends due), without doing it.
 */
import { dueItems } from '../../_shared/cadence/cadence.ts';
import { json } from '../../_shared/http.ts';
import type { Ctx, Route } from '../api.ts';

async function due(ctx: Ctx): Promise<Response> {
  return json(200, { items: await dueItems(ctx.db, ctx.userId!, ctx.now()) });
}

export const cadenceRoutes: Record<string, Route> = {
  '/cadence/due': { method: 'POST', auth: true, run: due },
};
