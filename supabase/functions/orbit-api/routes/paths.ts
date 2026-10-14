/**
 * Warm paths and introductions (§4):
 *   POST /paths/find {target, goalId?}   → ranked paths (each with a stable id and its nodes' names), or a direct tie,
 *                                          or {fallback: 'cold'}; Unipile mutuals and Village introducers included
 *   POST /intros/ask {introducerPersonId, targetPersonId, goalId?, pathScore, path}
 *                                        → an intro_request draft and a forwardable blurb (never sent here), and the
 *                                          orbit.intro_requests row their outcome is tracked on
 */
import type { IntroAskResponse, PathsFindRequest } from '@orbit/core/server/api';
import { composeDraft } from '../../_shared/compose/compose.ts';
import { loadPerson } from '../../_shared/compose/context.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { findPaths } from '../../_shared/paths/find.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

async function find(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const target = b.target as PathsFindRequest['target'] | undefined;
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw badRequest('target is required');
  return json(200, await findPaths(ctx.services(), ctx.userId!, { target, goalId: optUuid(b, 'goalId') }));
}

async function ask(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const introducerId = uuid(b, 'introducerPersonId');
  const targetId = uuid(b, 'targetPersonId');
  const goalId = optUuid(b, 'goalId') ?? null;
  const pathScore = Number(b.pathScore);
  if (!Number.isFinite(pathScore) || pathScore < 0 || pathScore > 1) throw badRequest('pathScore is 0–1');
  if (!b.path || typeof b.path !== 'object' || Array.isArray(b.path)) throw badRequest('path is required');
  if (introducerId === targetId) throw badRequest('the introducer and the target are the same person');
  const s = ctx.services();
  const userId = ctx.userId!;
  const introducer = await loadPerson(ctx.db, userId, introducerId);
  const target = await loadPerson(ctx.db, userId, targetId);
  if (target.do_not_contact) throw new HttpError(409, 'do_not_contact', 'they asked not to be contacted');
  const channel = introducer.primary_email || !introducer.linkedin_member_id ? 'gmail' : 'linkedin';
  const [row] = await ctx.db.sql<{ id: string }>`
    insert into orbit.intro_requests (user_id, target_person_id, introducer_person_id, goal_id, path, path_score, rank,
                                      status, asked_at)
    values (${userId}::uuid, ${targetId}::uuid, ${introducerId}::uuid, ${goalId}::uuid, ${b.path}::jsonb,
            ${pathScore}::real, 1, 'asked', ${ctx.now()}::timestamptz)
    returning id`;
  const via = { introducerId, pathScore, introRequestId: row!.id };
  const common = { userId, personId: introducerId, channel, goalId, targetPersonId: targetId, via } as const;
  const request = await composeDraft(s, { ...common, kind: 'intro_request' });
  const blurb = await composeDraft(s, { ...common, kind: 'forwardable_blurb' });
  const out: IntroAskResponse = { introRequestId: row!.id, draftIds: [request.draft.id, blurb.draft.id] };
  return json(200, out);
}

export const pathRoutes: Record<string, Route> = {
  '/paths/find': { method: 'POST', auth: true, run: find },
  '/intros/ask': { method: 'POST', auth: true, run: ask },
};
