/**
 * Warm paths and introductions (§4):
 *   POST /paths/find {target, goalId?}   → ranked paths (each with a stable id and its nodes' names), or a direct tie,
 *                                          or {fallback: 'cold'}; Unipile mutuals and Village introducers included
 *   POST /intros/ask {introducerPersonId, targetPersonId, goalId?, pathScore, path}
 *                                        → an intro_request draft and a forwardable blurb (never sent here), and the
 *                                          orbit.intro_requests row their outcome is tracked on, with the path's hop
 *                                          features frozen for the outcome fit (plan 21 §8)
 *   POST /pairs/block|unblock {aPersonId, bPersonId}
 *                                        → "they don't really know each other" (plan 21 §3.5): the pair is never a
 *                                          hop until unblocked (orbit.blocked_pairs)
 *   POST /pairs/close|unclose {aPersonId, bPersonId}
 *                                        → "they're close": a student_says_close tie (w 0.8, c 0.9), which also lifts
 *                                          a block; unclose deletes it
 */
import { pairEvidenceTies } from '@orbit/core/graph/ties';
import type { IntroAskResponse, PairCorrectionResponse, PathsFindRequest } from '@orbit/core/server/api';
import { composeDraft } from '../../_shared/compose/compose.ts';
import { loadPerson } from '../../_shared/compose/context.ts';
import type { Db } from '../../_shared/db.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { upsertTie } from '../../_shared/ingest/ties.ts';
import { findPaths } from '../../_shared/paths/find.ts';
import { deleteTies } from '../../_shared/paths/hopJob.ts';
import { introHopFeatures } from '../../_shared/paths/outcomes.ts';
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
                                      status, asked_at, hop_features)
    values (${userId}::uuid, ${targetId}::uuid, ${introducerId}::uuid, ${goalId}::uuid, ${b.path}::jsonb,
            ${pathScore}::real, 1, 'asked', ${ctx.now()}::timestamptz,
            ${introHopFeatures(b.path, pathScore)}::jsonb)
    returning id`;
  const via = { introducerId, pathScore, introRequestId: row!.id };
  const common = { userId, personId: introducerId, channel, goalId, targetPersonId: targetId, via } as const;
  const request = await composeDraft(s, { ...common, kind: 'intro_request' });
  const blurb = await composeDraft(s, { ...common, kind: 'forwardable_blurb' });
  const out: IntroAskResponse = { introRequestId: row!.id, draftIds: [request.draft.id, blurb.draft.id] };
  return json(200, out);
}

// ---- the student's corrections on a hop (plan 21 §3.5) ------------------------------------------------------------

const STUDENT = { actor: 'user', reason: 'pair_correction' } as const;

/** The two people of a correction, both the user's own (not deleted, not merged away), as a < b. */
async function pairOf(ctx: Ctx): Promise<[string, string]> {
  const b = await body(ctx);
  const a = uuid(b, 'aPersonId');
  const c = uuid(b, 'bPersonId');
  if (a === c) throw badRequest('a pair is two different people');
  const rows = await ctx.db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${ctx.userId!}::uuid and id = any(${[a, c]}::uuid[]) and deleted_at is null
       and merged_into is null and not is_self`;
  if (rows.length !== 2) throw new HttpError(404, 'not_found', 'no such person');
  return a < c ? [a, c] : [c, a];
}

async function pairState(db: Db, userId: string, a: string, b: string): Promise<PairCorrectionResponse> {
  const [r] = await db.sql<{ blocked: boolean; close: boolean }>`
    select exists (select 1 from orbit.blocked_pairs
                    where user_id = ${userId}::uuid and a_person_id = ${a}::uuid and b_person_id = ${b}::uuid) as blocked,
           exists (select 1 from orbit.ties
                    where user_id = ${userId}::uuid and a_person_id = ${a}::uuid and b_person_id = ${b}::uuid
                      and kind = 'student_says_close') as close`;
  return { aPersonId: a, bPersonId: b, blocked: !!r?.blocked, close: !!r?.close };
}

async function block(ctx: Ctx): Promise<Response> {
  const [a, b] = await pairOf(ctx);
  const userId = ctx.userId!;
  await ctx.db.sql`
    insert into orbit.blocked_pairs (user_id, a_person_id, b_person_id, created_at)
    values (${userId}::uuid, ${a}::uuid, ${b}::uuid, ${ctx.now()}::timestamptz)
    on conflict do nothing`;
  // the latest word wins: "they don't know each other" takes back an earlier "they're close"
  await deleteTies(ctx.db, userId, a, b, ['student_says_close'], [], STUDENT);
  return json(200, await pairState(ctx.db, userId, a, b));
}

async function unblock(ctx: Ctx): Promise<Response> {
  const [a, b] = await pairOf(ctx);
  const userId = ctx.userId!;
  await ctx.db.sql`
    delete from orbit.blocked_pairs
     where user_id = ${userId}::uuid and a_person_id = ${a}::uuid and b_person_id = ${b}::uuid`;
  return json(200, await pairState(ctx.db, userId, a, b));
}

async function close(ctx: Ctx): Promise<Response> {
  const [a, b] = await pairOf(ctx);
  const userId = ctx.userId!;
  const now = ctx.now();
  const at = now.toISOString();
  const [t] = pairEvidenceTies({
    userId,
    people: new Set([a, b]),
    studentSays: [{ aId: a, bId: b, at }],
    now,
  });
  await upsertTie(
    ctx.db,
    userId,
    {
      a,
      b,
      kind: t!.kind,
      weight: t!.weight,
      confidence: t!.confidence,
      evidence: t!.evidence,
      firstSeenAt: at,
      lastSeenAt: at,
    },
    now,
  );
  await ctx.db.sql`
    delete from orbit.blocked_pairs
     where user_id = ${userId}::uuid and a_person_id = ${a}::uuid and b_person_id = ${b}::uuid`;
  return json(200, await pairState(ctx.db, userId, a, b));
}

async function unclose(ctx: Ctx): Promise<Response> {
  const [a, b] = await pairOf(ctx);
  const userId = ctx.userId!;
  await deleteTies(ctx.db, userId, a, b, ['student_says_close'], [], STUDENT);
  return json(200, await pairState(ctx.db, userId, a, b));
}

export const pathRoutes: Record<string, Route> = {
  '/paths/find': { method: 'POST', auth: true, run: find },
  '/intros/ask': { method: 'POST', auth: true, run: ask },
  '/pairs/block': { method: 'POST', auth: true, run: block },
  '/pairs/unblock': { method: 'POST', auth: true, run: unblock },
  '/pairs/close': { method: 'POST', auth: true, run: close },
  '/pairs/unclose': { method: 'POST', auth: true, run: unclose },
};
