/**
 * The automated LinkedIn warm-up (docs/plan/13-linkedin-warm-up.md §8, _shared/warmup/warmup.ts):
 *   POST /warmups/preview {personId, warmUpDays?}  → {ok: true, preview} | {ok: false, reason, run?}
 *        reads the person's recent posts once from the student's own LinkedIn, picks one and drafts the comment.
 *        Nothing is scheduled and nothing is posted.
 *   POST /warmups/start {warmupId, comment}         → {ok: true, run} | {ok: false, reason, run?}
 *        `comment` is the text the student saw in the sheet (edited or not), or null to leave the comment out. It is
 *        stored as it came and is the only text the run ever posts.
 *   POST /warmups/stop {warmupId | personId}        → {stopped, run?}
 *   POST /warmups/told {warmupId}                   → {ok}: the student saw that it is done
 */
import { badRequest, json } from '../../_shared/http.ts';
import { markWarmupTold, previewWarmup, startWarmup, stopWarmup } from '../../_shared/warmup/warmup.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

async function preview(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const personId = uuid(b, 'personId');
  const days = b.warmUpDays;
  if (days !== undefined && (!Number.isInteger(days) || Number(days) < 2 || Number(days) > 10))
    throw badRequest('warmUpDays is a whole number from 2 to 10');
  return json(
    200,
    await previewWarmup(ctx.services(), ctx.userId!, personId, { warmUpDays: days as number | undefined }),
  );
}

async function start(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const warmupId = uuid(b, 'warmupId');
  if (b.comment !== null && typeof b.comment !== 'string')
    throw badRequest('comment is the text to post, or null to leave it out');
  return json(200, await startWarmup(ctx.services(), ctx.userId!, { warmupId, comment: b.comment }));
}

async function stop(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const warmupId = optUuid(b, 'warmupId');
  const personId = optUuid(b, 'personId');
  if (!warmupId && !personId) throw badRequest('warmupId or personId is required');
  return json(200, await stopWarmup({ db: ctx.db, now: ctx.now }, ctx.userId!, { warmupId, personId }));
}

async function told(ctx: Ctx): Promise<Response> {
  const warmupId = uuid(await body(ctx), 'warmupId');
  return json(200, { ok: await markWarmupTold(ctx.db, ctx.userId!, warmupId, ctx.now()) });
}

export const warmupRoutes: Record<string, Route> = {
  '/warmups/preview': { method: 'POST', auth: true, run: preview },
  '/warmups/start': { method: 'POST', auth: true, run: start },
  '/warmups/stop': { method: 'POST', auth: true, run: stop },
  '/warmups/told': { method: 'POST', auth: true, run: told },
};
