/**
 * The owner's cost view (plan 34 E3):
 *   GET or POST /admin/costs → the last 30 `cost.digest` rows the worker writes every morning (orbit.audit_log), newest
 *                      first: `{ rows: [{ at, details }] }`. Only the owner may read it: the signed-in user's id must
 *                      equal ORBIT_OWNER_ID (a function secret, else orbit_private.secrets); anyone else gets 404, so
 *                      the route does not say it exists.
 */
import { HttpError, json } from '../../_shared/http.ts';
import type { Ctx, Route } from '../api.ts';

export const COST_DIGEST_ROWS = 30;

async function costs(ctx: Ctx): Promise<Response> {
  const owner = ctx.env.ownerId?.trim().toLowerCase();
  if (!owner || ctx.userId?.toLowerCase() !== owner) throw new HttpError(404, 'not_found', 'not found');
  const rows = await ctx.db.sql<{ at: string | Date; details: Record<string, unknown> | null }>`
    select created_at as at, details from orbit.audit_log
     where action = 'cost.digest' order by created_at desc limit ${COST_DIGEST_ROWS}`;
  return json(200, {
    rows: rows.map((r) => ({
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      details: r.details ?? {},
    })),
  });
}

export const adminRoutes: Record<string, Route> = {
  '/admin/costs': { method: 'GET|POST', auth: true, run: costs },
};
