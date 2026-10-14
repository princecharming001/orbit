/**
 * Goals (§1.3, §2.1):
 *   POST /goals/list                → {goals}
 *   POST /goals/upsert {goal}       → {goal}; no id creates; at most 5 active goals (409 too_many_goals)
 *   POST /goals/archive {id}        → {goal} (soft delete)
 */
import type { GoalUpsertRequest } from '@orbit/core/server/api';
import { GOAL_KINDS, type Goal } from '@orbit/core/types';
import { goalFrom } from '../../_shared/cadence/cadence.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

export const MAX_ACTIVE_GOALS = 5;

const strList = (v: unknown, max = 25): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .map((x) => x.trim().slice(0, 200))
        .slice(0, max)
    : [];

async function goalsList(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db.sql<Record<string, unknown>>`
    select * from orbit.goals where user_id = ${ctx.userId!}::uuid and deleted_at is null
     order by (status = 'active') desc, priority, created_at`;
  return json(200, { goals: rows.map(goalFrom) });
}

async function goalsUpsert(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const g = b.goal as GoalUpsertRequest['goal'] | undefined;
  if (!g || typeof g !== 'object') throw badRequest('goal is required');
  if (!GOAL_KINDS.includes(g.kind)) throw badRequest('goal.kind is not a goal kind');
  if (typeof g.title !== 'string' || !g.title.trim() || g.title.length > 200)
    throw badRequest('goal.title is required');
  const id = optUuid(g as Record<string, unknown>, 'id');
  const status = g.status ?? 'active';
  if (!['active', 'paused', 'done'].includes(status)) throw badRequest('goal.status is not valid');
  const priority = g.priority ?? 2;
  if (![1, 2, 3].includes(priority)) throw badRequest('goal.priority is 1, 2 or 3');
  const autonomy = g.autonomyLevel ?? null;
  if (autonomy !== null && ![0, 1, 2].includes(autonomy)) throw badRequest('goal.autonomyLevel is 0, 1 or 2');
  if (g.dueAt !== undefined && g.dueAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(g.dueAt)))
    throw badRequest('goal.dueAt is YYYY-MM-DD');
  const t = (g.targets ?? {}) as Partial<Goal['targets']>;
  const targets = {
    organizations: strList(t.organizations),
    roles: strList(t.roles),
    geographies: strList(t.geographies),
    people: strList(t.people, 200),
  };
  const criteria =
    g.criteria && typeof g.criteria === 'object' && !Array.isArray(g.criteria) ? g.criteria : {};
  const userId = ctx.userId!;

  const row = await ctx.db.begin(async (tx) => {
    await tx.sql`select pg_advisory_xact_lock(hashtextextended(${`orbit.goals:${userId}`}, 0))`;
    if (status === 'active') {
      const [n] = await tx.sql<{ n: number }>`
        select count(*)::int as n from orbit.goals
         where user_id = ${userId}::uuid and status = 'active' and deleted_at is null
           and (${id ?? null}::uuid is null or id <> ${id ?? null}::uuid)`;
      if ((n?.n ?? 0) >= MAX_ACTIVE_GOALS)
        throw new HttpError(
          409,
          'too_many_goals',
          `at most ${MAX_ACTIVE_GOALS} active goals; pause or finish one first`,
        );
    }
    if (id) {
      const [r] = await tx.sql<Record<string, unknown>>`
        update orbit.goals set kind = ${g.kind}, title = ${g.title.trim()}, description = ${g.description ?? null},
               targets = ${targets}::jsonb, criteria = ${criteria}::jsonb, success_metric = ${g.successMetric ?? null},
               priority = ${priority}::smallint, status = ${status}, autonomy_level = ${autonomy}::smallint,
               due_at = ${g.dueAt ?? null}::date, evidence = coalesce(${g.evidence ?? null}, evidence)
         where id = ${id}::uuid and user_id = ${userId}::uuid and deleted_at is null
        returning *`;
      if (!r) throw new HttpError(404, 'not_found', 'no such goal');
      return r;
    }
    const source = g.source && ['user', 'onboarding', 'inferred'].includes(g.source) ? g.source : 'user';
    const [r] = await tx.sql<Record<string, unknown>>`
      insert into orbit.goals (user_id, kind, title, description, targets, criteria, success_metric, priority, status,
                               autonomy_level, due_at, source, evidence)
      values (${userId}::uuid, ${g.kind}, ${g.title.trim()}, ${g.description ?? null}, ${targets}::jsonb,
              ${criteria}::jsonb, ${g.successMetric ?? null}, ${priority}::smallint, ${status},
              ${autonomy}::smallint, ${g.dueAt ?? null}::date, ${source}, ${g.evidence ?? null})
      returning *`;
    return r!;
  });
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', ${id ? 'goal.update' : 'goal.create'}, 'goals', ${row.id as string},
            ${{ kind: g.kind, status }}::jsonb)`;
  return json(200, { goal: goalFrom(row) });
}

async function goalsArchive(ctx: Ctx): Promise<Response> {
  const id = uuid(await body(ctx), 'id');
  const [r] = await ctx.db.sql<Record<string, unknown>>`
    update orbit.goals set deleted_at = ${ctx.now()}::timestamptz, status = 'done'
     where id = ${id}::uuid and user_id = ${ctx.userId!}::uuid and deleted_at is null
    returning *`;
  if (!r) throw new HttpError(404, 'not_found', 'no such goal');
  return json(200, { goal: goalFrom(r) });
}

export const goalRoutes: Record<string, Route> = {
  '/goals/list': { method: 'POST', auth: true, run: goalsList },
  '/goals/upsert': { method: 'POST', auth: true, run: goalsUpsert },
  '/goals/archive': { method: 'POST', auth: true, run: goalsArchive },
};
