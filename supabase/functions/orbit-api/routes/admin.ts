/**
 * The owner's views (plan 34 E3, plan 43 §3.1). Only the owner may use them: the signed-in user's id must equal
 * ORBIT_OWNER_ID (a function secret, else orbit_private.secrets).
 *
 *   GET or POST /admin/costs → the last 30 `cost.digest` rows the worker writes every morning (orbit.audit_log), newest
 *                      first: `{ rows: [{ at, details }] }`. Anyone else gets 404, so the route does not say it exists.
 *   GET /admin/sources → `{ sources: [{ source, offered, env, ready, missing, students: { on, connected } }] }`: each
 *                      optional source, whether students are offered it now (ORBIT_EXTRA_SOURCES, `env`, or the
 *                      launch switch), whether what it needs is set (`missing` in plain words; no key is ever
 *                      returned), and how many students have it on and connected. Anyone else gets 403.
 *   PUT /admin/sources/:source {offered: boolean} → `{ ok: true }`: the launch switch (orbit_private.source_launch,
 *                      20261204_orbit_launch.sql), in effect everywhere within a minute with no redeploy. Turning a
 *                      source off keeps what students took and stops reading, as the student's Off does; turning it
 *                      on brings it back. Each student who has it on gets the switch job (sources/switch.ts
 *                      `queueOwnerSwitch`). Audit-logged. 409 when a source listed in ORBIT_EXTRA_SOURCES is turned
 *                      off (that list wins), or when one is launched before what it needs is set. Anyone else: 403.
 */
import { OPTIONAL_SOURCES, type OptionalSource } from '@orbit/core/sources';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { resolveSecret } from '../../_shared/secrets.ts';
import { forgetOffered } from '../../_shared/sources/states.ts';
import { queueOwnerSwitch } from '../../_shared/sources/switch.ts';
import type { Ctx, Route } from '../api.ts';
import { body } from './body.ts';

export const COST_DIGEST_ROWS = 30;

/** The signed-in user is the owner (ORBIT_OWNER_ID). */
export function isOwner(ctx: Pick<Ctx, 'env' | 'userId'>): boolean {
  const owner = ctx.env.ownerId?.trim().toLowerCase();
  return !!owner && ctx.userId?.toLowerCase() === owner;
}

async function costs(ctx: Ctx): Promise<Response> {
  if (!isOwner(ctx)) throw new HttpError(404, 'not_found', 'not found');
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

export interface AdminSourceView {
  source: OptionalSource;
  /** students are offered it now */
  offered: boolean;
  /** ORBIT_EXTRA_SOURCES lists it, so it stays offered whatever the switch says */
  env: boolean;
  /** everything it needs is set */
  ready: boolean;
  /** what is not set, in plain words */
  missing: string[];
  students: { on: number; connected: number };
}

export interface AdminSourcesResponse {
  sources: AdminSourceView[];
}

function owner(ctx: Ctx): void {
  if (!isOwner(ctx)) throw new HttpError(403, 'forbidden', 'Only the owner of this Orbit can do this.');
}

/** The owner's env list: ORBIT_EXTRA_SOURCES, and X's own reading of it. */
const envList = (ctx: Ctx): OptionalSource[] =>
  ctx.env.x?.offered && !ctx.offered.includes('x') ? [...ctx.offered, 'x'] : [...ctx.offered];

/** What each source needs that is not set, in words the owner reads (never a value). */
async function missingFor(ctx: Ctx, source: OptionalSource): Promise<string[]> {
  const m: string[] = [];
  if (source === 'instagram') {
    if (!ctx.env.unipileKey) m.push('The Unipile API key (UNIPILE_API_KEY)');
    if (!ctx.env.unipileBase) m.push('The Unipile base URL (UNIPILE_BASE_URL)');
    const hook = await resolveSecret(
      (name) => (name === 'ORBIT_UNIPILE_WEBHOOK_SECRET' ? ctx.env.unipileWebhookSecret : undefined),
      ctx.db,
      'ORBIT_UNIPILE_WEBHOOK_SECRET',
      'orbit_unipile_webhook_secret',
    ).catch(() => undefined);
    if (!hook) m.push('The Unipile webhook secret (ORBIT_UNIPILE_WEBHOOK_SECRET)');
  }
  if (source === 'x') {
    const x = ctx.env.x;
    if (!x?.clientId) m.push('The X app client ID (ORBIT_X_CLIENT_ID)');
    if (!x?.clientSecret) m.push('The X app client secret (ORBIT_X_CLIENT_SECRET)');
    if (!x || !(x.orbitMonthlyUsd > 0))
      m.push('A monthly X spending limit above 0 dollars (ORBIT_X_MONTHLY_USD)');
  }
  return m;
}

async function sourcesList(ctx: Ctx): Promise<Response> {
  owner(ctx);
  const env = envList(ctx);
  const launch = await ctx.db.sql<{ source: string; offered: boolean }>`
    select source, offered from orbit_private.source_launch`;
  const counts = await ctx.db.sql<{ source: string; on: number; connected: number }>`
    select s.source,
           (select count(*)::int from orbit.source_states st join orbit.users u on u.id = st.user_id
             where st.source = s.source and st.state = 'on' and u.deleted_at is null) as on,
           case when s.source = 'imessage'
                then (select count(distinct t.user_id)::int from orbit.text_days t)
                else (select count(*)::int from orbit.integration_accounts a join orbit.users u on u.id = a.user_id
                       where a.provider = s.source and a.status <> 'revoked' and u.deleted_at is null) end as connected
      from unnest(${[...OPTIONAL_SOURCES]}::text[]) as s(source)`;
  const sources: AdminSourceView[] = [];
  for (const source of OPTIONAL_SOURCES) {
    const missing = await missingFor(ctx, source);
    const c = counts.find((r) => r.source === source);
    sources.push({
      source,
      offered: env.includes(source) || !!launch.find((r) => r.source === source)?.offered,
      env: env.includes(source),
      ready: missing.length === 0,
      missing,
      students: { on: c?.on ?? 0, connected: c?.connected ?? 0 },
    });
  }
  const out: AdminSourcesResponse = { sources };
  return json(200, out);
}

async function sourcesPut(ctx: Ctx, raw: string): Promise<Response> {
  owner(ctx);
  const source = raw.toLowerCase() as OptionalSource;
  if (!(OPTIONAL_SOURCES as readonly string[]).includes(source))
    throw new HttpError(404, 'not_found', 'no such source');
  const b = await body(ctx);
  if (typeof b.offered !== 'boolean') throw badRequest('offered is true or false');
  const env = envList(ctx);
  if (!b.offered && env.includes(source))
    throw new HttpError(
      409,
      'env_listed',
      'It is listed in ORBIT_EXTRA_SOURCES, so it stays on until that setting is changed.',
    );
  if (b.offered) {
    const missing = await missingFor(ctx, source);
    if (missing.length)
      return json(409, {
        error: { code: 'not_ready', message: `Set these first: ${missing.join('; ')}.` },
        missing,
      });
  }
  const [r] = await ctx.db.sql<{ was: boolean }>`
    select public.orbit_source_launch_set(${source}, ${b.offered}, ${ctx.userId!}::uuid) as was`;
  const was = !!r?.was || env.includes(source);
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${ctx.userId!}::uuid, 'user', ${b.offered ? 'source.launch' : 'source.unlaunch'}, 'source_launch',
            ${source}, ${{ offered: b.offered, was }}::jsonb)`;
  forgetOffered(ctx.db);
  // what students are offered changed: each who has it on is rescored with it in or out, and Off pauses their drafts
  if (was !== b.offered) await queueOwnerSwitch(ctx.db, sqlQueue(ctx.db), source, b.offered, ctx.now());
  return json(200, { ok: true });
}

export const adminRoutes: Record<string, Route> = {
  '/admin/costs': { method: 'GET|POST', auth: true, run: costs },
  '/admin/sources': { method: 'GET', auth: true, run: sourcesList },
};

/** PUT /admin/sources/:source, matched by pattern. */
export function adminPatternRoute(path: string): Route | undefined {
  const m = /^\/admin\/sources\/([a-z]{1,20})$/i.exec(path);
  if (!m) return undefined;
  return { method: 'PUT', auth: true, run: (ctx) => sourcesPut(ctx, m[1]!) };
}
