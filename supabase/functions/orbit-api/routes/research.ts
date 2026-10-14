/**
 * Research (§5):
 *   POST /research/person {personId, goalId?, refresh?}  → {status, dossier}; a dossier from the last 30 days comes
 *                                                          back at once, otherwise enrich.dossier is queued
 *   POST /research/get {personId}                        → {dossier}
 *   POST /research/choose {personId, candidateIndex}     → answers needs_disambiguation and re-queues it
 */
import { json } from '../../_shared/http.ts';
import { chooseCandidate, getDossier, requestDossier } from '../../_shared/research/run.ts';
import type { Ctx, Route } from '../api.ts';
import { body } from './body.ts';

async function person(ctx: Ctx): Promise<Response> {
  const r = await requestDossier(ctx.services(), ctx.userId!, await body(ctx));
  return json(r.status === 'queued' ? 202 : 200, r);
}

async function get(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return json(200, { dossier: await getDossier(ctx.db, ctx.userId!, b.personId) });
}

async function choose(ctx: Ctx): Promise<Response> {
  return json(202, await chooseCandidate(ctx.services(), ctx.userId!, await body(ctx)));
}

export const researchRoutes: Record<string, Route> = {
  '/research/person': { method: 'POST', auth: true, run: person },
  '/research/get': { method: 'POST', auth: true, run: get },
  '/research/choose': { method: 'POST', auth: true, run: choose },
};
