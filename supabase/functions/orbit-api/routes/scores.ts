/**
 * Tie scores (§3):
 *   POST /scores/explain {personId}            → score, band, explanation, contributions, label
 *   POST /scores/label {personId, closeness}   → the user's own 1–5 label; re-scored at once from the stored
 *                                                features (the label's band midpoint, §3.5), else score.person queued
 */

import { TIE_LABEL_MIDPOINTS, type TieBand, tieBand } from '@orbit/core/scoring/tieScore';
import type { ScoreExplainResponse } from '@orbit/core/server/api';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { iso, num } from '../../_shared/rows.ts';
import type { Ctx, Route } from '../api.ts';
import { body, uuid } from './body.ts';

type ScoreRow = {
  score: number;
  band: string;
  features: Record<string, number> | null;
  contributions: Record<string, number> | null;
  explanation: string[];
  model_version: string;
  computed_at: Date;
  closeness: number | null;
};

async function scoreRow(ctx: Ctx, personId: string): Promise<ScoreRow | undefined> {
  const [r] = await ctx.db.sql<ScoreRow>`
    select ts.score, ts.band, ts.features, ts.contributions, ts.explanation, ts.model_version, ts.computed_at,
           tl.closeness
      from orbit.tie_scores ts
      left join orbit.tie_labels tl on tl.user_id = ts.user_id and tl.person_id = ts.person_id
     where ts.user_id = ${ctx.userId!}::uuid and ts.person_id = ${personId}::uuid`;
  return r;
}

function explainOf(personId: string, r: ScoreRow): ScoreExplainResponse {
  const contributions: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.contributions ?? {})) contributions[k] = num(v);
  return {
    personId,
    score: num(r.score),
    band: r.band as TieBand,
    explanation: r.explanation ?? [],
    contributions,
    modelVersion: r.model_version,
    computedAt: iso(r.computed_at)!,
    ...(r.closeness ? { labelled: r.closeness as 1 | 2 | 3 | 4 | 5 } : {}),
  };
}

async function ownPerson(ctx: Ctx, personId: string) {
  const [p] = await ctx.db.sql`
    select 1 from orbit.people where id = ${personId}::uuid and user_id = ${ctx.userId!}::uuid and deleted_at is null`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
}

async function explain(ctx: Ctx): Promise<Response> {
  const personId = uuid(await body(ctx), 'personId');
  await ownPerson(ctx, personId);
  const r = await scoreRow(ctx, personId);
  if (!r) throw new HttpError(404, 'not_scored', 'this person has no score yet');
  return json(200, explainOf(personId, r));
}

async function label(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const personId = uuid(b, 'personId');
  const closeness = Number(b.closeness);
  if (![1, 2, 3, 4, 5].includes(closeness)) throw badRequest('closeness is 1–5');
  await ownPerson(ctx, personId);
  const userId = ctx.userId!;
  const now = ctx.now();
  await ctx.db.sql`
    insert into orbit.tie_labels (user_id, person_id, closeness)
    values (${userId}::uuid, ${personId}::uuid, ${closeness}::smallint)
    on conflict (user_id, person_id) do update set closeness = excluded.closeness`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'score.label', 'people', ${personId}, ${{ closeness }}::jsonb)`;
  const r = await scoreRow(ctx, personId);
  if (r?.features && Object.keys(r.features).length) {
    // §3.5: a labelled tie shows the label's band midpoint until new evidence arrives (scoreTie does the same)
    const score = TIE_LABEL_MIDPOINTS[closeness]!;
    const line = `You rated this tie ${closeness} of 5`;
    const explanation = [
      line,
      ...(r.explanation ?? []).filter((x) => !x.startsWith('You rated this tie')),
    ].slice(0, 5);
    await ctx.db.sql`
      update orbit.tie_scores set score = ${score}::smallint, band = ${tieBand(score)}, explanation = ${explanation}::text[],
             computed_at = ${now}::timestamptz
       where user_id = ${userId}::uuid and person_id = ${personId}::uuid`;
    await ctx.db.sql`update orbit.people set strength = ${score / 100}::real where id = ${personId}::uuid`;
    return json(200, explainOf(personId, (await scoreRow(ctx, personId))!));
  }
  const queued = await sqlQueue(ctx.db).enqueue({
    kind: 'score.person',
    userId,
    payload: { personId, reason: 'label' },
    dedupeKey: `score.person:${personId}:label:${now.toISOString().slice(0, 16)}`,
  });
  return json(202, { queued: queued !== null });
}

export const scoreRoutes: Record<string, Route> = {
  '/scores/explain': { method: 'POST', auth: true, run: explain },
  '/scores/label': { method: 'POST', auth: true, run: label },
};
