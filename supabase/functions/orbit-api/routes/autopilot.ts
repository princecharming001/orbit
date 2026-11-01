/**
 * Autopilot (plan 29 §B4):
 *   POST /autopilot/mode {mode, goalId?}   → {mode, goalId}: off, assist or autopilot, for the account or one goal
 *   GET|POST /autopilot/status             → what is queued, held, sent today on Orbit's own, the replies that need
 *                                            the student, the pauses, the rungs and the caps
 *   POST /autopilot/hold {draftId}         → {item}: the batch goes without this one
 *   POST /autopilot/pause {until, goalId?} → {pausedUntil, goalId, cancelled}: null lifts the pause
 *   POST /autopilot/dismiss {id}           → {id}: a plan card set aside (an ask to a friend, tonight's batch card)
 */
import { AUTOPILOT_MODES, type AutopilotMode } from '@orbit/core/safety/rules';
import {
  autopilotStatus,
  dismissPlanCard,
  holdSend,
  pauseAutopilot,
  setAutopilotMode,
} from '../../_shared/autopilot/autopilot.ts';
import { badRequest, json } from '../../_shared/http.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

async function mode(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (typeof b.mode !== 'string' || !AUTOPILOT_MODES.includes(b.mode as AutopilotMode))
    throw badRequest('mode is off, assist or autopilot');
  return json(
    200,
    await setAutopilotMode(ctx.db, ctx.userId!, {
      mode: b.mode as AutopilotMode,
      goalId: optUuid(b, 'goalId'),
    }),
  );
}

async function status(ctx: Ctx): Promise<Response> {
  if (ctx.req.method === 'POST') await ctx.req.body?.cancel();
  return json(200, await autopilotStatus(ctx.db, ctx.userId!, ctx.now()));
}

async function hold(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return json(200, { item: await holdSend(ctx.db, ctx.userId!, uuid(b, 'draftId'), ctx.now()) });
}

async function pause(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  let until: string | null = null;
  if (b.until !== null && b.until !== undefined) {
    const t = new Date(String(b.until));
    if (typeof b.until !== 'string' || Number.isNaN(t.getTime()))
      throw badRequest('until must be an ISO time or null');
    until = t.toISOString();
  }
  return json(
    200,
    await pauseAutopilot(ctx.db, ctx.userId!, { until, goalId: optUuid(b, 'goalId') }, ctx.now()),
  );
}

async function dismiss(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return json(200, await dismissPlanCard(ctx.db, ctx.userId!, uuid(b, 'id'), ctx.now()));
}

export const autopilotRoutes: Record<string, Route> = {
  '/autopilot/mode': { method: 'POST', auth: true, run: mode },
  '/autopilot/status': { method: 'GET|POST', auth: true, run: status },
  '/autopilot/hold': { method: 'POST', auth: true, run: hold },
  '/autopilot/pause': { method: 'POST', auth: true, run: pause },
  '/autopilot/dismiss': { method: 'POST', auth: true, run: dismiss },
};
