/**
 * Signing in with X (plan 43 §5 "Connect"): OAuth 2.0 Authorization Code with PKCE, as Orbit's Google sign-in does it.
 * The access and refresh tokens live in Vault (`x_access:<user>`, `x_refresh:<user>`); the integration row keeps the
 * refresh token's secret id in token_secret_id and the access token's id and expiry in sync_state.x. X rotates the
 * refresh token on every refresh, so the new one is written back each time.
 *
 * A 401 from X is answered by one refresh and one retry. When the refresh itself is refused, the row is marked
 * needs_reauth and `SocialSignInNeeded('x')` is thrown, so the student is asked to sign in again and the rest of
 * Orbit carries on. fetch and the clock are injectable for tests.
 */
import type { Db } from '../../db.ts';
import type { Vault } from '../../vault.ts';
import { SocialSignInNeeded } from '../adapter.ts';
import { X_AUTHORIZE_URL, X_REVOKE_URL, X_SCOPES, X_TOKEN_URL } from './config.ts';

export const xAccessName = (userId: string) => `x_access:${userId}`;
export const xRefreshName = (userId: string) => `x_refresh:${userId}`;

export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface XTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export class XTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`x token ${status} ${code}`);
  }
}

export function xAuthUrl(
  cfg: Pick<XOAuthConfig, 'clientId' | 'redirectUri'>,
  p: { state: string; challenge: string },
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: X_SCOPES.join(' '),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${X_AUTHORIZE_URL}?${q}`;
}

/** X's confidential clients send their id and secret as Basic auth. */
const basic = (cfg: XOAuthConfig) => `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`;

async function tokenCall(cfg: XOAuthConfig, form: Record<string, string>): Promise<XTokenResponse> {
  const res = await (cfg.fetch ?? fetch)(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: basic(cfg),
    },
    body: new URLSearchParams({ ...form, client_id: cfg.clientId }),
    signal: AbortSignal.timeout(15_000),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) throw new XTokenError(res.status, String(body.error ?? 'token_error'));
  if (typeof body.access_token !== 'string') throw new XTokenError(502, 'no_access_token');
  return body as unknown as XTokenResponse;
}

export function xExchangeCode(cfg: XOAuthConfig, code: string, verifier: string): Promise<XTokenResponse> {
  return tokenCall(cfg, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri,
  });
}

export function xRefreshToken(cfg: XOAuthConfig, refreshToken: string): Promise<XTokenResponse> {
  return tokenCall(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Revokes a token at X. True when X accepted it; a failure is not fatal to disconnecting. */
export async function xRevoke(
  cfg: XOAuthConfig,
  token: string,
  hint: 'refresh_token' | 'access_token',
): Promise<boolean> {
  try {
    const res = await (cfg.fetch ?? fetch)(X_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(cfg) },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: cfg.clientId }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export interface XSyncState {
  username?: string;
  accessSecretId?: string;
  accessExpiresAt?: string;
  consent?: { version: string; at: string };
  /** the newest DM event id read */
  dmCursor?: string;
  /** when the DMs were last read */
  dmReadAt?: string;
}

export async function loadXState(
  db: Db,
  userId: string,
): Promise<
  | {
      status: string;
      socialAccountId: string | null;
      refreshSecretId: string | null;
      state: XSyncState;
    }
  | undefined
> {
  const [a] = await db.sql<{
    status: string;
    social_account_id: string | null;
    token_secret_id: string | null;
    x: XSyncState | null;
  }>`
    select status, social_account_id, token_secret_id, sync_state->'x' as x
      from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'x'`;
  if (!a) return undefined;
  return {
    status: a.status,
    socialAccountId: a.social_account_id,
    refreshSecretId: a.token_secret_id,
    state: a.x ?? {},
  };
}

/** Merges fields into sync_state.x. */
export async function saveXState(db: Db, userId: string, patch: Partial<XSyncState>): Promise<void> {
  await db.sql`
    update orbit.integration_accounts
       set sync_state = jsonb_set(coalesce(sync_state, '{}'::jsonb), '{x}',
                                  coalesce(sync_state->'x', '{}'::jsonb) || ${patch}::jsonb)
     where user_id = ${userId}::uuid and provider = 'x'`;
}

/** Stores a fresh pair of tokens in Vault and returns the ids and expiry to keep on the row. */
export async function storeXTokens(
  vault: Vault,
  userId: string,
  t: XTokenResponse,
  now: Date,
): Promise<{ accessSecretId: string; refreshSecretId?: string; accessExpiresAt: string }> {
  const accessSecretId = await vault.put(xAccessName(userId), t.access_token);
  const refreshSecretId = t.refresh_token
    ? await vault.put(xRefreshName(userId), t.refresh_token)
    : undefined;
  const accessExpiresAt = new Date(now.getTime() + Math.max(60, t.expires_in ?? 7200) * 1000).toISOString();
  return { accessSecretId, refreshSecretId, accessExpiresAt };
}

export interface XTokens {
  /** a usable access token: the stored one while it lasts, else a refreshed one */
  accessToken(): Promise<string>;
  /** after a 401: refresh now; a refused refresh marks the row needs_reauth and throws SocialSignInNeeded */
  refreshed(): Promise<string>;
}

/** Access tokens for one student's X account, from Vault, refreshed when they run out or X says 401. */
export function xTokens(
  db: Db,
  vault: Vault,
  cfg: XOAuthConfig,
  userId: string,
  now: () => Date = () => new Date(),
): XTokens {
  let cached: string | undefined;
  const needsReauth = async (why: string) => {
    await db.sql`
      update orbit.integration_accounts set status = 'needs_reauth', last_error = ${why}
       where user_id = ${userId}::uuid and provider = 'x'`;
    return new SocialSignInNeeded('x');
  };
  async function refresh(): Promise<string> {
    const row = await loadXState(db, userId);
    if (!row?.refreshSecretId || row.status === 'revoked') throw new SocialSignInNeeded('x');
    const refreshToken = await vault.get(row.refreshSecretId);
    if (!refreshToken) throw await needsReauth('no_refresh_token');
    let t: XTokenResponse;
    try {
      t = await xRefreshToken(cfg, refreshToken);
    } catch (e) {
      // X said no (revoked, expired, used twice): only signing in again helps. A 5xx or a timeout is passing.
      if (e instanceof XTokenError && e.status >= 400 && e.status < 500)
        throw await needsReauth(`refresh_${e.code}`.slice(0, 80));
      throw e;
    }
    const s = await storeXTokens(vault, userId, t, now());
    if (s.refreshSecretId && s.refreshSecretId !== row.refreshSecretId)
      await db.sql`update orbit.integration_accounts set token_secret_id = ${s.refreshSecretId}::uuid
                    where user_id = ${userId}::uuid and provider = 'x'`;
    await saveXState(db, userId, { accessSecretId: s.accessSecretId, accessExpiresAt: s.accessExpiresAt });
    cached = t.access_token;
    return t.access_token;
  }
  return {
    async accessToken() {
      if (cached) return cached;
      const row = await loadXState(db, userId);
      if (!row || row.status === 'revoked' || row.status === 'needs_reauth')
        throw new SocialSignInNeeded('x');
      const s = row.state;
      const fresh = s.accessExpiresAt && Date.parse(s.accessExpiresAt) - 60_000 > now().getTime();
      if (s.accessSecretId && fresh) {
        const token = await vault.get(s.accessSecretId);
        if (token) return (cached = token);
      }
      return refresh();
    },
    refreshed: () => {
      cached = undefined;
      return refresh();
    },
  };
}
