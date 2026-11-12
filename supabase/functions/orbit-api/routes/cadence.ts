/**
 * Cadence (§9): POST /cadence/due → what the hourly scan would do now (bumps, went quiet, thank-yous, stage timers,
 * nurture notes, sends due), without doing it.
 */
import { dueItems } from '../../_shared/cadence/cadence.ts';
import { json } from '../../_shared/http.ts';
import { sourcesFor } from '../../_shared/sources/states.ts';
import type { Ctx, Route } from '../api.ts';

async function due(ctx: Ctx): Promise<Response> {
  const src = await sourcesFor(ctx.db, ctx.userId!, ctx.offered);
  return json(200, { items: await dueItems(ctx.db, ctx.userId!, ctx.now(), src) });
}

export const cadenceRoutes: Record<string, Route> = {
  '/cadence/due': { method: 'POST', auth: true, run: due },
};
