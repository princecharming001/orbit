/**
 * Sign-in and sessions (§12.1, §11.2).
 *
 *   GET  /auth/google/start?redirect=<app url>  → 302 to Google's consent screen (PKCE S256, phase-1 scopes)
 *   GET  /auth/google/callback?code&state       → user, self person, Vault refresh token, integration row,
 *                                                 login code → 302 <app>/auth/done#code=…  (errors: #error=…)
 *   POST /auth/session {code}                   → {accessToken, refreshToken, expiresAt, user}
 *   POST /auth/refresh {refreshToken}           → a rotated pair
 *   POST /auth/logout {refreshToken?}           → revokes this session
 *   GET  /auth/me                               → the user
 */
import { normalizeEmail, parseName } from '@orbit/core/text/normalize';
import { randomToken } from '../_shared/crypto.ts';
import type { Db } from '../_shared/db.ts';
import { authUrl, exchangeCode, PHASE1_SCOPES, pkcePair, verifyIdToken } from '../_shared/google.ts';
import { badRequest, json, readJson, redirect, unauthorized } from '../_shared/http.ts';
import { sqlQueue } from '../_shared/queue.ts';
import {
  createLoginCode,
  createSession,
  redeemLoginCode,
  refreshSession,
  revokeSession,
} from '../_shared/session.ts';
import { googleRefreshName, sqlVault } from '../_shared/vault.ts';
import type { Ctx } from './api.ts';

const STATE_TTL_MS = 10 * 60_000;

/**
 * Where a sign-in may return to: the configured app's origin, or a local dev server. Returns the base URL (origin +
 * path, no query or hash, no trailing slash), or undefined when it is not allowed.
 */
export function safeRedirect(raw: string | null, appUrl: string): string | undefined {
  if (!raw) return appUrl;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const app = new URL(appUrl);
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.origin !== app.origin && !local) return undefined;
  if (u.username || u.password) return undefined;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

function done(base: string, fragment: Record<string, string>): Response {
  return redirect(`${base}/auth/done#${new URLSearchParams(fragment)}`);
}

export async function googleStart(ctx: Ctx): Promise<Response> {
  const target = safeRedirect(ctx.url.searchParams.get('redirect'), ctx.env.appUrl);
  if (!target) return done(ctx.env.appUrl, { error: 'bad_redirect' });
  const state = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  const now = ctx.now();
  await ctx.db.sql`
    insert into orbit.oauth_states (state, code_verifier, redirect_to, scopes, created_at, expires_at)
    values (${state}, ${verifier}, ${target}, ${PHASE1_SCOPES}::text[], ${now}::timestamptz,
            ${new Date(now.getTime() + STATE_TTL_MS)}::timestamptz)`;
  return redirect(authUrl(ctx.google!, { state, challenge, scopes: PHASE1_SCOPES }));
}

export async function googleCallback(ctx: Ctx): Promise<Response> {
  const q = ctx.url.searchParams;
  const state = q.get('state');
  if (!state) return done(ctx.env.appUrl, { error: 'invalid_state' });
  const [st] = await ctx.db.sql<{ code_verifier: string; redirect_to: string; expires_at: Date }>`
    delete from orbit.oauth_states where state = ${state} returning code_verifier, redirect_to, expires_at`;
  if (!st || new Date(st.expires_at).getTime() < ctx.now().getTime())
    return done(ctx.env.appUrl, { error: 'invalid_state' });
  const back = st.redirect_to;
  const googleError = q.get('error');
  if (googleError)
    return done(back, { error: /^[a-z_]{1,40}$/.test(googleError) ? googleError : 'google_error' });
  const code = q.get('code');
  if (!code) return done(back, { error: 'no_code' });

  try {
    const tokens = await exchangeCode(ctx.google!, code, st.code_verifier);
    if (!tokens.id_token) return done(back, { error: 'no_id_token' });
    const claims = await verifyIdToken(ctx.google!, tokens.id_token);
    if (!claims.emailVerified) return done(back, { error: 'email_unverified' });
    const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    const userId = await ctx.db.begin((tx) =>
      upsertGoogleUser(tx, { ...claims, scopes, refreshToken: tokens.refresh_token }),
    );
    if (!userId) return done(back, { error: 'account_deleted' });
    if (scopes.some((s) => s.endsWith('gmail.readonly')))
      await sqlQueue(ctx.db).enqueue({
        kind: 'sync.gmail.backfill',
        userId,
        payload: { phase: 'recent' },
        dedupeKey: `gmail-backfill:${userId}:recent`,
      });
    const loginCode = await createLoginCode(ctx.db, userId, ctx.now());
    return done(back, { code: loginCode });
  } catch {
    return done(back, { error: 'sign_in_failed' });
  }
}

export interface GoogleSignIn {
  sub: string;
  email: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  scopes: string[];
  refreshToken?: string;
}

/**
 * The user by Google `sub`, their self person with an email identity, the refresh token in Vault and the Google
 * integration row. Returns the user id, or null when the account is being deleted.
 */
export async function upsertGoogleUser(db: Db, g: GoogleSignIn): Promise<string | null> {
  const name = parseName(g.name ?? [g.givenName, g.familyName].filter(Boolean).join(' '));
  const first = g.givenName ?? (name.first || null);
  const last = g.familyName ?? (name.last || null);
  const full = g.name ?? (name.full || null);
  const [user] = await db.sql<{ id: string; deleted_at: Date | null }>`
    insert into orbit.users (google_sub, email, full_name, first_name, last_name, avatar_url, last_seen_at)
    values (${g.sub}, ${g.email}, ${full}, ${first}, ${last}, ${g.picture ?? null}, now())
    on conflict (google_sub) do update set
      email = excluded.email,
      full_name = coalesce(orbit.users.full_name, excluded.full_name),
      first_name = coalesce(orbit.users.first_name, excluded.first_name),
      last_name = coalesce(orbit.users.last_name, excluded.last_name),
      avatar_url = coalesce(excluded.avatar_url, orbit.users.avatar_url),
      last_seen_at = now()
    returning id, deleted_at`;
  if (!user || user.deleted_at) return null;
  const userId = user.id;

  const display = full ?? g.email;
  await db.sql`
    insert into orbit.people (user_id, is_self, display_name, first_name, last_name, name_norm, primary_email,
                              photo_url, sources, first_seen_at)
    values (${userId}::uuid, true, ${display}, ${first}, ${last}, ${name.normalized || normalizeEmail(g.email)},
            ${g.email}, ${g.picture ?? null}, ${['google']}::text[], now())
    on conflict (user_id) where is_self do nothing`;
  const [self] = await db.sql<{ id: string }>`
    select id from orbit.people where user_id = ${userId}::uuid and is_self`;
  await db.sql`
    insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
    values (${userId}::uuid, ${self!.id}::uuid, 'email', ${normalizeEmail(g.email)}, ${g.email}, 'google')
    on conflict (user_id, kind, value_norm) do nothing`;

  const secretId = g.refreshToken ? await sqlVault(db).put(googleRefreshName(userId), g.refreshToken) : null;
  await db.sql`
    insert into orbit.integration_accounts (user_id, provider, email, scopes, status, token_secret_id, last_error)
    values (${userId}::uuid, 'google', ${g.email}, ${g.scopes}::text[],
            ${secretId ? 'active' : 'needs_reauth'}, ${secretId}::uuid, null)
    on conflict (user_id, provider) do update set
      email = excluded.email,
      scopes = excluded.scopes,
      token_secret_id = coalesce(excluded.token_secret_id, orbit.integration_accounts.token_secret_id),
      status = case when coalesce(excluded.token_secret_id, orbit.integration_accounts.token_secret_id) is null
                    then 'needs_reauth' else 'active' end,
      last_error = null`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'auth.sign_in', 'users', ${userId}, ${{ scopes: g.scopes.length }}::jsonb)`;
  return userId;
}

export interface UserView {
  id: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  school: string | null;
  gradYear: number | null;
  timezone: string;
  autonomyLevel: number;
  settings: Record<string, unknown>;
  onboarding: Record<string, unknown>;
  createdAt: string;
}

export async function loadUser(db: Db, userId: string): Promise<UserView | null> {
  const [u] = await db.sql<Record<string, unknown>>`
    select id, email, full_name, first_name, last_name, avatar_url, school, grad_year, timezone, autonomy_level,
           settings, onboarding, created_at
      from orbit.users where id = ${userId}::uuid and deleted_at is null`;
  if (!u) return null;
  return {
    id: u.id as string,
    email: u.email as string,
    fullName: (u.full_name as string) ?? null,
    firstName: (u.first_name as string) ?? null,
    lastName: (u.last_name as string) ?? null,
    avatarUrl: (u.avatar_url as string) ?? null,
    school: (u.school as string) ?? null,
    gradYear: (u.grad_year as number) ?? null,
    timezone: u.timezone as string,
    autonomyLevel: Number(u.autonomy_level),
    settings: (u.settings as Record<string, unknown>) ?? {},
    onboarding: (u.onboarding as Record<string, unknown>) ?? {},
    createdAt: new Date(u.created_at as string).toISOString(),
  };
}

export async function session(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  if (typeof body.code !== 'string') throw badRequest('code is required');
  const userId = await redeemLoginCode(ctx.db, body.code, ctx.now());
  if (!userId) throw unauthorized('that sign-in link has expired; sign in again');
  const user = await loadUser(ctx.db, userId);
  if (!user) throw unauthorized('sign in again');
  const t = await createSession(ctx.db, ctx.session, userId, ctx.req.headers.get('user-agent'));
  return json(200, {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
    user,
  });
}

export async function refresh(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  if (typeof body.refreshToken !== 'string') throw badRequest('refreshToken is required');
  const t = await refreshSession(ctx.db, ctx.session, body.refreshToken);
  if (!t) throw unauthorized('the session has ended; sign in again');
  return json(200, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
}

export async function logout(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, { optional: true });
  const now = ctx.now();
  await ctx.db.sql`
    update orbit.sessions set revoked_at = ${now}::timestamptz
     where id = ${ctx.sessionId!}::uuid and user_id = ${ctx.userId!}::uuid and revoked_at is null`;
  if (typeof body.refreshToken === 'string') await revokeSession(ctx.db, body.refreshToken, now);
  return json(200, { ok: true });
}

export async function me(ctx: Ctx): Promise<Response> {
  const user = await loadUser(ctx.db, ctx.userId!);
  if (!user) throw unauthorized();
  return json(200, { user });
}
