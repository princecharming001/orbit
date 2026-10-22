/**
 * Agent settings (§8.4, §9.3, §14.3):
 *   POST /settings/autonomy {level, goalId?}  → the user's autonomy level, or one goal's override
 *   POST /settings/pause {until}              → users.settings.quiet_until (null resumes)
 *   POST /settings/profile {postalAddress?, schedulingLink?, timezone?, onboardingCompletedAt?}
 *        → users.settings.postal_address / scheduling_link (null or '' removes), users.timezone, and
 *          users.onboarding.completed_at (set once setup is finished; never cleared)
 */
import type { ProfileSettingsResponse } from '@orbit/core/server/api';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { validZone } from '../../_shared/zones.ts';
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

export const POSTAL_ADDRESS_MAX = 500;
export const SCHEDULING_LINK_MAX = 500;

/** A setting to keep, to remove (null), or to leave alone (undefined). */
function optText(b: Record<string, unknown>, key: string): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw badRequest(`${key} must be text or null`);
  return v.trim() || null;
}

/** Time zones by IANA name (America/New_York, UTC), known to this runtime; offsets and abbreviations are refused. */
export function ianaZone(tz: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz) && tz.length <= 64
    ? validZone(tz)
    : undefined;
}

function isHttpsLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

async function profile(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const postal = optText(b, 'postalAddress');
  if (postal && postal.length > POSTAL_ADDRESS_MAX)
    throw badRequest(`postalAddress is at most ${POSTAL_ADDRESS_MAX} characters`);
  const link = optText(b, 'schedulingLink');
  if (link && (!isHttpsLink(link) || link.length > SCHEDULING_LINK_MAX))
    throw badRequest('schedulingLink must be an https link');
  let tz: string | undefined;
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== 'string' || !ianaZone(b.timezone.trim()))
      throw badRequest('timezone must be an IANA time zone, like America/New_York');
    tz = b.timezone.trim();
  }
  let done: string | undefined;
  if (b.onboardingCompletedAt !== undefined) {
    const t = new Date(String(b.onboardingCompletedAt));
    if (typeof b.onboardingCompletedAt !== 'string' || Number.isNaN(t.getTime()))
      throw badRequest('onboardingCompletedAt must be an ISO time');
    done = t.toISOString();
  }
  const userId = ctx.userId!;
  // the keys given are replaced (or removed when null); the rest of settings is kept
  const given: Record<string, string | null> = {};
  if (postal !== undefined) given.postal_address = postal;
  if (link !== undefined) given.scheduling_link = link;
  const keep = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null));
  const [after] = await ctx.db.sql<{ settings: Record<string, unknown>; timezone: string }>`
    update orbit.users
       set settings = (settings - ${Object.keys(given)}::text[]) || ${keep}::jsonb,
           timezone = coalesce(${tz ?? null}::text, timezone),
           onboarding = case when ${done ?? null}::text is null then onboarding
                             else coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('completed_at', ${done ?? null}::text) end
     where id = ${userId}::uuid
    returning settings, timezone`;
  if (!after) throw new HttpError(404, 'not_found', 'no such user');
  const changed = [...Object.keys(given), ...(tz ? ['timezone'] : []), ...(done ? ['onboarding'] : [])];
  if (changed.length)
    await ctx.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'settings.profile', 'users', ${userId}, ${{ fields: changed }}::jsonb)`;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const out: ProfileSettingsResponse = {
    postalAddress: str(after.settings?.postal_address),
    schedulingLink: str(after.settings?.scheduling_link),
    timezone: after.timezone,
  };
  return json(200, out);
}

export const settingsRoutes: Record<string, Route> = {
  '/settings/autonomy': { method: 'POST', auth: true, run: autonomy },
  '/settings/pause': { method: 'POST', auth: true, run: pause },
  '/settings/profile': { method: 'POST', auth: true, run: profile },
};
