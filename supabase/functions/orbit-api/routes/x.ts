/**
 * X sign-in and spending (plan 43 §5):
 *
 *   POST /x/connect/start {consent: true} → {url}: X's consent screen (PKCE S256). The student must have agreed to
 *                                            what Orbit stores first; the agreement is written to the audit log with
 *                                            its time and the consent screen's version.
 *   GET  /x/callback?code&state          → tokens into Vault, the integration row (social_account_id from
 *                                            /2/users/me), 302 <app>/settings?x=connected (or x=failed)
 *   GET  /x/status                       → {status, username?, spentThisMonthUsd, limitUsd, orbitLimitReached}
 *   POST /x/disconnect                   → revokes the token at X, deletes it from Vault, marks the row revoked
 *
 * Without ORBIT_X_CLIENT_ID and ORBIT_X_CLIENT_SECRET, or with `x` missing from ORBIT_EXTRA_SOURCES, every route
 * answers 503 "X is not set up".
 */

import { randomToken } from '../../_shared/crypto.ts';
import { pkcePair } from '../../_shared/google.ts';
import { badRequest, json, readJson, redirect } from '../../_shared/http.ts';
import { SocialBudgetSpent } from '../../_shared/social/adapter.ts';
import { createXAdapter } from '../../_shared/social/x/adapter.ts';
import {
  X_CONSENT_VERSION,
  X_NOT_SET_UP,
  X_SCOPES,
  type XConfig,
  xMissing,
} from '../../_shared/social/x/config.ts';
import {
  loadXState,
  storeXTokens,
  type XOAuthConfig,
  xAuthUrl,
  xExchangeCode,
  xRevoke,
} from '../../_shared/social/x/oauth.ts';
import { xOrbitLimitReached, xSpend, xSpendThisMonth } from '../../_shared/social/x/spend.ts';
import { sqlVault } from '../../_shared/vault.ts';
import type { Ctx, Route } from '../api.ts';
import { functionsBase } from './integrations.ts';

const STATE_TTL_MS = 10 * 60_000;

export interface XStatusResponse {
  status: 'not_connected' | 'connecting' | 'active' | 'needs_reauth' | 'error';
  username?: string;
  spentThisMonthUsd: number;
  limitUsd: number;
  orbitLimitReached: boolean;
}

function notSetUp(missing: string[]): Response {
  return json(
    503,
    { error: { code: 'unconfigured', message: X_NOT_SET_UP, missing } },
    { 'x-orbit-connector': 'unconfigured' },
  );
}

function setup(ctx: Ctx): { cfg: XConfig; oauth: XOAuthConfig } | Response {
  const cfg = ctx.env.x;
  const missing = xMissing(cfg);
  if (missing.length || !cfg) return notSetUp(missing);
  return {
    cfg,
    oauth: {
      clientId: cfg.clientId!,
      clientSecret: cfg.clientSecret!,
      redirectUri: cfg.redirectUri ?? `${functionsBase(ctx)}/orbit-api/x/callback`,
      fetch: ctx.fetch,
    },
  };
}

const settings = (ctx: Ctx, outcome: 'connected' | 'failed') =>
  redirect(`${ctx.env.appUrl}/settings?x=${outcome}`);

export async function xConnectStart(ctx: Ctx): Promise<Response> {
  const s = setup(ctx);
  if (s instanceof Response) return s;
  const body = await readJson(ctx.req, { optional: true });
  if (body.consent !== true) throw badRequest('consent is required before signing in with X');
  const userId = ctx.userId!;
  const now = ctx.now();
  const consent = { version: X_CONSENT_VERSION, at: now.toISOString() };
  const state = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  await ctx.db.sql`
    insert into orbit.oauth_states (state, code_verifier, redirect_to, user_id, scopes, created_at, expires_at)
    values (${state}, ${verifier}, ${`${ctx.env.appUrl}/settings`}, ${userId}::uuid, ${X_SCOPES}::text[],
            ${now}::timestamptz, ${new Date(now.getTime() + STATE_TTL_MS)}::timestamptz)`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'user', 'x.consent', 'integration_accounts', ${consent}::jsonb)`;
  await ctx.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status, sync_state)
    values (${userId}::uuid, 'x', 'connecting', ${{ x: { consent } }}::jsonb)
    on conflict (user_id, provider) do update set
      status = case when orbit.integration_accounts.status = 'active' then 'active' else 'connecting' end,
      sync_state = jsonb_set(coalesce(orbit.integration_accounts.sync_state, '{}'::jsonb), '{x}',
                             coalesce(orbit.integration_accounts.sync_state->'x', '{}'::jsonb)
                               || ${{ consent }}::jsonb)`;
  return json(200, { url: xAuthUrl(s.oauth, { state, challenge }) });
}

export async function xCallback(ctx: Ctx): Promise<Response> {
  const s = setup(ctx);
  if (s instanceof Response) return settings(ctx, 'failed');
  const q = ctx.url.searchParams;
  const state = q.get('state');
  if (!state) return settings(ctx, 'failed');
  const [st] = await ctx.db.sql<{
    code_verifier: string;
    user_id: string | null;
    scopes: string[];
    expires_at: Date;
  }>`
    delete from orbit.oauth_states where state = ${state}
    returning code_verifier, user_id, scopes, expires_at`;
  if (
    !st?.user_id ||
    !st.scopes.includes('dm.read') ||
    new Date(st.expires_at).getTime() < ctx.now().getTime()
  )
    return settings(ctx, 'failed');
  const userId = st.user_id;
  const fail = async (why: string) => {
    await ctx.db.sql`
      update orbit.integration_accounts set status = case when status = 'active' then status else 'error' end,
             last_error = ${why}
       where user_id = ${userId}::uuid and provider = 'x'`;
    return settings(ctx, 'failed');
  };
  if (q.get('error')) return fail('x_denied');
  const code = q.get('code');
  if (!code) return fail('no_code');

  const vault = sqlVault(ctx.db);
  let tokens: Awaited<ReturnType<typeof xExchangeCode>>;
  try {
    tokens = await xExchangeCode(s.oauth, code, st.code_verifier);
  } catch {
    return fail('token_exchange');
  }
  // who signed in: one user read, paid for like any other
  let me: { id: string; username: string };
  try {
    const adapter = createXAdapter({
      tokens: { accessToken: async () => tokens.access_token, refreshed: async () => tokens.access_token },
      budget: xSpend(ctx.db, { userId, limits: s.cfg, caller: 'connect', now: ctx.now }),
      fetch: ctx.fetch,
    });
    const read = await adapter.me();
    me = { id: read.account.id, username: read.account.username };
  } catch (e) {
    if (tokens.refresh_token) await xRevoke(s.oauth, tokens.refresh_token, 'refresh_token');
    return fail(e instanceof SocialBudgetSpent ? 'x_limit' : 'x_me');
  }
  const stored = await storeXTokens(vault, userId, tokens, ctx.now());
  const scopes = (tokens.scope ?? X_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  const before = await loadXState(ctx.db, userId);
  await ctx.db.begin(async (tx) => {
    // a different X account than before: what came from the old one's own lists goes first (plan 43 §3.1)
    if (before?.socialAccountId && before.socialAccountId !== me.id) {
      await tx.sql`delete from orbit.social_follows where platform = 'x' and owner_user_id = ${userId}::uuid`;
      await tx.sql`delete from orbit.social_list_reads where platform = 'x' and owner_user_id = ${userId}::uuid`;
      await tx.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, details)
        values (${userId}::uuid, 'user', 'x.account_changed', 'integration_accounts',
                ${{ from: before.socialAccountId, to: me.id }}::jsonb)`;
    }
    const x = {
      username: me.username,
      accessSecretId: stored.accessSecretId,
      accessExpiresAt: stored.accessExpiresAt,
      ...(before?.socialAccountId && before.socialAccountId !== me.id
        ? { dmCursor: null, dmReadAt: null }
        : {}),
    };
    await tx.sql`
      insert into orbit.integration_accounts (user_id, provider, status, scopes, social_account_id, token_secret_id,
                                              sync_state, last_error)
      values (${userId}::uuid, 'x', 'active', ${scopes}::text[], ${me.id}, ${stored.refreshSecretId ?? null}::uuid,
              ${{ x }}::jsonb, null)
      on conflict (user_id, provider) do update set
        status = case when coalesce(excluded.token_secret_id, orbit.integration_accounts.token_secret_id) is null
                      then 'needs_reauth' else 'active' end,
        scopes = excluded.scopes,
        social_account_id = excluded.social_account_id,
        token_secret_id = coalesce(excluded.token_secret_id, orbit.integration_accounts.token_secret_id),
        sync_state = jsonb_set(coalesce(orbit.integration_accounts.sync_state, '{}'::jsonb), '{x}',
                               jsonb_strip_nulls(coalesce(orbit.integration_accounts.sync_state->'x', '{}'::jsonb)
                                                 || ${x}::jsonb)),
        last_error = null`;
    await tx.sql`
      insert into orbit.source_states (user_id, source, state) values (${userId}::uuid, 'x', 'on')
      on conflict (user_id, source) do update set state = 'on', off_since = null`;
    await tx.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, details)
      values (${userId}::uuid, 'user', 'x.connected', 'integration_accounts', ${{ scopes: scopes.length }}::jsonb)`;
  });
  return settings(ctx, 'connected');
}

export async function xStatus(ctx: Ctx): Promise<Response> {
  const s = setup(ctx);
  if (s instanceof Response) return s;
  const userId = ctx.userId!;
  const row = await loadXState(ctx.db, userId);
  const spent = await xSpendThisMonth(ctx.db, userId, ctx.now());
  const status: XStatusResponse['status'] =
    !row || row.status === 'revoked'
      ? 'not_connected'
      : row.status === 'active' || row.status === 'connecting' || row.status === 'needs_reauth'
        ? row.status
        : 'error';
  const out: XStatusResponse = {
    status,
    ...(status !== 'not_connected' && row?.state.username ? { username: row.state.username } : {}),
    spentThisMonthUsd: spent.studentUsd,
    limitUsd: s.cfg.studentMonthlyUsd,
    orbitLimitReached: await xOrbitLimitReached(ctx.db, s.cfg, ctx.now()),
  };
  return json(200, out);
}

export async function xDisconnect(ctx: Ctx): Promise<Response> {
  const s = setup(ctx);
  if (s instanceof Response) return s;
  await readJson(ctx.req, { optional: true });
  const userId = ctx.userId!;
  const row = await loadXState(ctx.db, userId);
  if (!row) return json(200, { ok: true });
  const vault = sqlVault(ctx.db);
  let revoked = false;
  if (row.refreshSecretId) {
    const refresh = await vault.get(row.refreshSecretId);
    if (refresh) revoked = await xRevoke(s.oauth, refresh, 'refresh_token');
  }
  if (!revoked && row.state.accessSecretId) {
    const access = await vault.get(row.state.accessSecretId);
    if (access) revoked = await xRevoke(s.oauth, access, 'access_token');
  }
  if (row.refreshSecretId) await vault.delete(row.refreshSecretId);
  if (row.state.accessSecretId) await vault.delete(row.state.accessSecretId);
  await ctx.db.sql`
    update orbit.integration_accounts
       set status = 'revoked', token_secret_id = null, last_error = null,
           sync_state = jsonb_set(coalesce(sync_state, '{}'::jsonb), '{x}',
                                  coalesce(sync_state->'x', '{}'::jsonb) - 'accessSecretId' - 'accessExpiresAt')
     where user_id = ${userId}::uuid and provider = 'x'`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'user', 'x.disconnect', 'integration_accounts', ${{ revokedAtX: revoked }}::jsonb)`;
  return json(200, { ok: true, revokedAtX: revoked });
}

export const xRoutes: Record<string, Route> = {
  '/x/connect/start': { method: 'POST', auth: true, run: xConnectStart },
  '/x/callback': { method: 'GET', auth: false, run: xCallback },
  '/x/status': { method: 'GET|POST', auth: true, run: xStatus },
  '/x/disconnect': { method: 'POST', auth: true, run: xDisconnect },
};
