/**
 * Agent settings (§8.4, §9.3):
 *   POST /settings/autonomy {level, goalId?}  → the user's autonomy level, or one goal's override
 *   POST /settings/pause {until}              → users.settings.quiet_until (null resumes)
 */
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid } from './body.ts';

async function autonomy(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const level = Number(b.level);
  if (![0, 1, 2].includes(level)) throw badRequest('level is 0, 1 or 2');
  const goalId = optUuid(b, 'goalId');
  const userId = ctx.userId!;
  if (goalId) {
    const r = await ctx.db.sql`
      update orbit.goals set autonomy_level = ${level}::smallint
       where id = ${goalId}::uuid and user_id = ${userId}::uuid and deleted_at is null returning id`;
    if (!r.length) throw new HttpError(404, 'not_found', 'no such goal');
  } else
    await ctx.db.sql`update orbit.users set autonomy_level = ${level}::smallint where id = ${userId}::uuid`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'settings.autonomy', ${goalId ? 'goals' : 'users'}, ${goalId ?? userId},
            ${{ level }}::jsonb)`;
  return json(200, { ok: true, level, goalId: goalId ?? null });
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
  const userId = ctx.userId!;
  await ctx.db.sql`
    update orbit.users
       set settings = case when ${until}::text is null then settings - 'quiet_until'
                           else jsonb_set(settings, '{quiet_until}', to_jsonb(${until}::text)) end
     where id = ${userId}::uuid`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'settings.pause', 'users', ${userId}, ${{ until }}::jsonb)`;
  return json(200, { ok: true, until });
}

export const settingsRoutes: Record<string, Route> = {
  '/settings/autonomy': { method: 'POST', auth: true, run: autonomy },
  '/settings/pause': { method: 'POST', auth: true, run: pause },
};
