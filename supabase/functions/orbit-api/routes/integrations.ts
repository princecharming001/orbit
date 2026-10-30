/**
 * Integration routes (§12.3, contract in packages/core/src/server/api.ts):
 *
 *   POST /google/sync {mode: 'backfill' | 'incremental'}  → QueuedResponse
 *   POST /linkedin/connect/start                          → {url}: Unipile hosted auth for this user (name = user id,
 *                                                           notify_url = orbit-webhooks/unipile/account?token=…)
 *   POST /linkedin/status                                 → LinkedinStatusResponse
 *   POST /linkedin/sync                                   → QueuedResponse
 *
 * Work is queued, never done inline. Without Unipile's key (or the webhook secret) the LinkedIn routes answer 503
 * unconfigured.
 */
import type {
  GoogleSyncRequest,
  LinkedinConnectStartResponse,
  LinkedinStatusResponse,
  QueuedResponse,
} from '@orbit/core/server/api';
import { accountToken } from '../../_shared/accountToken.ts';
import { badRequest, HttpError, json, readJson, unconfigured } from '../../_shared/http.ts';
import { slot } from '../../_shared/ingest/util.ts';
import { createUnipileSync } from '../../_shared/providers/unipileSync.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { resolveSecret } from '../../_shared/secrets.ts';
import type { Ctx } from '../api.ts';

const queued = (q: QueuedResponse) => json(200, q);

async function googleAccount(ctx: Ctx) {
  const [a] = await ctx.db.sql<{
    status: string;
    scopes: string[];
    sync_state: Record<string, Record<string, unknown>>;
  }>`
    select status, scopes, sync_state from orbit.integration_accounts
     where user_id = ${ctx.userId!}::uuid and provider = 'google'`;
  return a;
}

export async function googleSync(ctx: Ctx): Promise<Response> {
  const body = (await readJson(ctx.req, { optional: true })) as Partial<GoogleSyncRequest>;
  const mode = body.mode ?? 'incremental';
  if (mode !== 'backfill' && mode !== 'incremental') throw badRequest('mode must be backfill or incremental');
  const userId = ctx.userId!;
  const acct = await googleAccount(ctx);
  if (!acct?.scopes.some((s) => s.endsWith('gmail.readonly')))
    return queued({ queued: false, reason: 'not_connected' });
  if (acct.status !== 'active') return queued({ queued: false, reason: acct.status });
  const q = sqlQueue(ctx.db);
  if (mode === 'backfill') {
    const phase = acct.sync_state?.gmail?.backfill as { phase?: string } | undefined;
    if (phase?.phase && phase.phase !== 'complete')
      return queued({ queued: false, reason: 'already_running' });
    const id = await q.enqueue({
      kind: 'sync.gmail.backfill',
      userId,
      payload: phase?.phase === 'complete' ? { phase: 'recent', restart: true } : { phase: 'recent' },
      dedupeKey: `gmail-backfill:${userId}:manual:${slot(ctx.now())}`,
    });
    return queued(id === null ? { queued: false, reason: 'already_running' } : { queued: true });
  }
  const id = await q.enqueue({
    kind: 'sync.gmail.incremental',
    userId,
    payload: { reason: 'manual' },
    dedupeKey: `gmail-manual:${userId}:${slot(ctx.now())}`,
  });
  if (acct.scopes.some((s) => /calendar\.(readonly|events)$/.test(s)))
    await q.enqueue({
      kind: 'sync.calendar',
      userId,
      payload: { reason: 'manual' },
      dedupeKey: `calendar-manual:${userId}:${slot(ctx.now())}`,
    });
  return queued(id === null ? { queued: false, reason: 'already_running' } : { queued: true });
}

function unipileFor(ctx: Ctx) {
  return createUnipileSync({ fetch: ctx.fetch, apiKey: ctx.env.unipileKey, baseUrl: ctx.env.unipileBase });
}

const missingUnipile = (ctx: Ctx) => [
  ...(ctx.env.unipileKey ? [] : ['UNIPILE_API_KEY']),
  ...(ctx.env.unipileBase ? [] : ['UNIPILE_BASE_URL']),
];

/** <project>/functions/v1, from the configured value, the Google redirect, or this request's own URL. */
export function functionsBase(ctx: Pick<Ctx, 'env' | 'url'>): string {
  if (ctx.env.functionsUrl) return ctx.env.functionsUrl.replace(/\/+$/, '');
  const fromRedirect = ctx.env.googleRedirectUri?.match(/^(https?:\/\/[^/]+\/functions\/v1)\//)?.[1];
  if (fromRedirect) return fromRedirect;
  const href = `${ctx.url.origin}${ctx.url.pathname}`;
  const i = href.indexOf('/orbit-api');
  return i > 0 ? href.slice(0, i) : ctx.url.origin;
}

export async function linkedinConnectStart(ctx: Ctx): Promise<Response> {
  await readJson(ctx.req, { optional: true });
  const missing = missingUnipile(ctx);
  const secret = await resolveSecret(
    (name) => (name === 'ORBIT_UNIPILE_WEBHOOK_SECRET' ? ctx.env.unipileWebhookSecret : undefined),
    ctx.db,
    'ORBIT_UNIPILE_WEBHOOK_SECRET',
    'orbit_unipile_webhook_secret',
  );
  if (!secret) missing.push('ORBIT_UNIPILE_WEBHOOK_SECRET');
  if (missing.length) return unconfigured({}, missing);
  const userId = ctx.userId!;
  const r = await unipileFor(ctx).hostedLink({
    name: userId,
    notifyUrl: `${functionsBase(ctx)}/orbit-webhooks/unipile/account?token=${encodeURIComponent(secret!)}`,
    successRedirectUrl: `${ctx.env.appUrl}/settings?linkedin=connected`,
    failureRedirectUrl: `${ctx.env.appUrl}/settings?linkedin=failed`,
    expiresOn: new Date(ctx.now().getTime() + 3_600_000).toISOString(),
  });
  if (!r.ok) throw new HttpError(502, 'upstream', 'LinkedIn connection is unavailable right now');
  await ctx.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status)
    values (${userId}::uuid, 'linkedin', 'connecting')
    on conflict (user_id, provider) do update set
      status = case when orbit.integration_accounts.status = 'active' then 'active' else 'connecting' end`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table)
    values (${userId}::uuid, 'user', 'linkedin.connect_start', 'integration_accounts')`;
  const out: LinkedinConnectStartResponse = { url: r.value.url };
  return json(200, out);
}

export async function linkedinStatus(ctx: Ctx): Promise<Response> {
  const userId = ctx.userId!;
  const [a] = await ctx.db.sql<{
    status: string;
    external_account_id: string | null;
    last_synced_at: Date | null;
  }>`
    select status, external_account_id, last_synced_at from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin'`;
  const [n] = await ctx.db.sql<{ n: number }>`
    select count(distinct pi.person_id)::int as n from orbit.person_identities pi
      join orbit.people p on p.id = pi.person_id
     where pi.user_id = ${userId}::uuid and pi.kind = 'linkedin_member' and pi.source = 'linkedin_relation'
       and p.merged_into is null and p.deleted_at is null`;
  const status: LinkedinStatusResponse['status'] = !a
    ? 'not_connected'
    : a.status === 'active' || a.status === 'connecting' || a.status === 'needs_reauth'
      ? a.status
      : a.status === 'revoked'
        ? 'not_connected'
        : 'error';
  const out: LinkedinStatusResponse = {
    status,
    accountId: a?.external_account_id ?? null,
    lastSyncedAt: a?.last_synced_at ? new Date(a.last_synced_at).toISOString() : null,
    relations: n?.n ?? 0,
  };
  return json(200, out);
}

export async function linkedinSync(ctx: Ctx): Promise<Response> {
  await readJson(ctx.req, { optional: true });
  const missing = missingUnipile(ctx);
  if (missing.length) return unconfigured({}, missing);
  const userId = ctx.userId!;
  const [a] = await ctx.db.sql<{ status: string; external_account_id: string | null }>`
    select status, external_account_id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin'`;
  if (!a?.external_account_id) return queued({ queued: false, reason: 'not_connected' });
  if (a.status !== 'active') return queued({ queued: false, reason: a.status });
  const id = await sqlQueue(ctx.db).enqueue({
    kind: 'sync.linkedin',
    userId,
    payload: { mode: 'sync' },
    dedupeKey: `linkedin-manual:${userId}:${slot(ctx.now())}`,
  });
  return queued(id === null ? { queued: false, reason: 'already_running' } : { queued: true });
}

type RouteSpec = {
  method: 'GET' | 'POST' | 'GET|POST';
  auth: boolean;
  run: (ctx: Ctx) => Promise<Response>;
};

export const INTEGRATION_ROUTES: Record<string, RouteSpec> = {
  '/google/sync': { method: 'POST', auth: true, run: googleSync },
  '/linkedin/connect/start': { method: 'POST', auth: true, run: linkedinConnectStart },
  '/linkedin/status': { method: 'GET|POST', auth: true, run: linkedinStatus },
  '/linkedin/sync': { method: 'POST', auth: true, run: linkedinSync },
  '/linkedin/search': { method: 'POST', auth: true, run: linkedinSearch },
  '/linkedin/reader': { method: 'POST', auth: true, run: linkedinReader },
};

/**
 * POST /linkedin/reader → {ok, accountId, token} | {ok: false, reason}: the signed-in student's own LinkedIn account
 * and its orbit-connectors token, so their browser reads a profile's work history when they open someone's page and
 * looks companies' logos up, through the same proxy (and the same daily allowances) as an account kept in a browser.
 * Only ever their own account: the id comes from their integration row, never from the request.
 */
export async function linkedinReader(ctx: Ctx): Promise<Response> {
  const [a] = await ctx.db.sql<{ status: string; external_account_id: string | null }>`
    select status, external_account_id from orbit.integration_accounts
     where user_id = ${ctx.userId!}::uuid and provider = 'linkedin'`;
  if (!a?.external_account_id || a.status !== 'active')
    return json(200, { ok: false, reason: 'not_connected' });
  if (!ctx.env.connectorsSigningKey) return json(200, { ok: false, reason: 'unconfigured' });
  return json(200, {
    ok: true,
    accountId: a.external_account_id,
    token: await accountToken(a.external_account_id, ctx.env.connectorsSigningKey),
  });
}

/** LinkedIn's people searches a day per student: a name typed into Add a person searches as it settles. */
export const LINKEDIN_SEARCHES_PER_DAY = 80;

/**
 * POST /linkedin/search {q} → {ok, people} | {ok: false, reason}: people on LinkedIn a typed name or role finds, from
 * the student's own connected account (any degree), each with photo and headline, for Add a person. The same query
 * within the day answers from the audit log's count, never past LINKEDIN_SEARCHES_PER_DAY.
 */
export async function linkedinSearch(ctx: Ctx): Promise<Response> {
  const body = (await readJson(ctx.req, { optional: true })) as { q?: unknown };
  const q = typeof body.q === 'string' ? body.q.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (q.length < 2) throw badRequest('q must be at least 2 characters');
  const userId = ctx.userId!;
  const [a] = await ctx.db.sql<{ status: string; external_account_id: string | null }>`
    select status, external_account_id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin'`;
  if (!a?.external_account_id || a.status !== 'active')
    return json(200, { ok: false, reason: 'not_connected' });
  const unipile = unipileFor(ctx);
  if (!unipile.configured) return json(200, { ok: false, reason: 'unconfigured' });
  const [n] = await ctx.db.sql<{ n: number }>`
    select count(*)::int as n from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'linkedin.search'
       and created_at > ${new Date(ctx.now().getTime() - 86_400_000)}::timestamptz`;
  if ((n?.n ?? 0) >= LINKEDIN_SEARCHES_PER_DAY) return json(200, { ok: false, reason: 'limit' });
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table) values (${userId}::uuid, 'user', 'linkedin.search', 'people')`;
  const r = await unipile.searchPeople(a.external_account_id, q);
  if (!r.ok) return json(200, { ok: false, reason: 'error' });
  return json(200, { ok: true, people: r.value });
}
