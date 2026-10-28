/**
 * Orbit's own Google OAuth (§12.1, §14.1): the consent URL with PKCE (S256), the code exchange, id_token
 * verification against Google's JWKS, access tokens minted from the stored refresh token (cached per function
 * instance for their lifetime minus 5 minutes), `invalid_grant` → the account needs reconnecting, and revocation.
 * fetch, the JWKS and the clock are injectable for tests.
 */
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { base64url, randomToken, sha256Bytes } from './crypto.ts';
import type { Db } from './db.ts';
import type { Vault } from './vault.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const G = 'https://www.googleapis.com/auth/';
/** Sign-in plus the onboarding consent of §14.1 (Gmail read + send, Calendar read, contacts), on one screen. */
export const PHASE1_SCOPES = [
  'openid',
  'email',
  'profile',
  `${G}gmail.readonly`,
  `${G}gmail.send`,
  `${G}calendar.readonly`,
  `${G}contacts.other.readonly`,
  `${G}contacts.readonly`,
];
/** Asked incrementally the first time the user books a call from Orbit. */
export const CALENDAR_EVENTS_SCOPE = `${G}calendar.events`;

/**
 * Where Google sends sign-in back: a page on Orbit's own site (apps/web/public/auth/google/callback) that passes the
 * code on to this server, so every domain on the consent screen is one Orbit can show it owns. A local app keeps the
 * server's own address.
 */
export function googleRedirectUri(
  appUrl: string | undefined,
  functionsUrl: string | undefined,
): string | undefined {
  const site = (appUrl || 'https://tryorbit.today').replace(/\/+$/, '');
  if (/^https:\/\//.test(site) && !/\/\/(localhost|127\.0\.0\.1)\b/.test(site))
    return `${site}/auth/google/callback`;
  return functionsUrl ? `${functionsUrl}/orbit-api/auth/google/callback` : undefined;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  /** the key set id_tokens are verified against; Google's published JWKS by default */
  jwks?: JWTVerifyGetKey;
  now?: () => Date;
}

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`google ${status} ${code}`);
  }
}

/** The refresh token no longer works (revoked, expired, or a Testing-mode token past 7 days). */
export class NeedsReauth extends Error {
  constructor() {
    super('needs_reauth');
  }
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: base64url(await sha256Bytes(verifier)) };
}

export function authUrl(
  cfg: Pick<GoogleConfig, 'clientId' | 'redirectUri'>,
  p: { state: string; challenge: string; scopes: string[]; loginHint?: string },
): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
    state: p.state,
    scope: p.scopes.join(' '),
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${GOOGLE_AUTH_URL}?${q}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

async function tokenCall(cfg: GoogleConfig, form: Record<string, string>): Promise<TokenResponse> {
  const res = await (cfg.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) throw new GoogleError(res.status, String(body.error ?? 'token_error'));
  if (typeof body.access_token !== 'string') throw new GoogleError(502, 'no_access_token');
  return body as unknown as TokenResponse;
}

export function exchangeCode(cfg: GoogleConfig, code: string, verifier: string): Promise<TokenResponse> {
  return tokenCall(cfg, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
}

export interface IdClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

let googleJwks: JWTVerifyGetKey | undefined;

/** Verifies signature, issuer, audience and expiry of a Google id_token. */
export async function verifyIdToken(cfg: GoogleConfig, idToken: string): Promise<IdClaims> {
  const keys = cfg.jwks ?? (googleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)));
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: GOOGLE_ISSUERS,
    audience: cfg.clientId,
    currentDate: (cfg.now ?? (() => new Date()))(),
  });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string')
    throw new GoogleError(400, 'id_token_claims');
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: str(payload.name),
    givenName: str(payload.given_name),
    familyName: str(payload.family_name),
    picture: str(payload.picture),
  };
}

/** A fresh access token from a refresh token; `invalid_grant` → NeedsReauth. */
export async function refreshAccessToken(cfg: GoogleConfig, refreshToken: string): Promise<TokenResponse> {
  try {
    return await tokenCall(cfg, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
  } catch (e) {
    if (e instanceof GoogleError && e.code === 'invalid_grant') throw new NeedsReauth();
    throw e;
  }
}

/** Revokes a refresh or access token. True when Google accepted it (or it was already invalid). */
export async function revokeToken(cfg: Pick<GoogleConfig, 'fetch'>, token: string): Promise<boolean> {
  const res = await (cfg.fetch ?? fetch)(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  await res.body?.cancel();
  return res.ok || res.status === 400;
}

export interface TokenSource {
  /** An access token for the user's Google account; throws NeedsReauth when it must be reconnected. */
  accessToken(userId: string): Promise<string>;
  /** Drops the cached token (after a 401 from Google). */
  invalidate(userId: string): void;
}

/**
 * Access tokens per user, minted from the refresh token in Vault and cached for their lifetime minus 5 minutes.
 * On `invalid_grant` the account is marked needs_reauth so the chat's Setup line asks to reconnect.
 */
export function googleTokenSource(cfg: GoogleConfig, deps: { db: Db; vault: Vault }): TokenSource {
  const cache = new Map<string, { token: string; until: number }>();
  const clock = () => (cfg.now ?? (() => new Date()))().getTime();
  return {
    invalidate: (userId) => {
      cache.delete(userId);
    },
    async accessToken(userId) {
      const hit = cache.get(userId);
      if (hit && hit.until > clock()) return hit.token;
      const [acct] = await deps.db.sql<{ token_secret_id: string | null; status: string }>`
        select token_secret_id, status from orbit.integration_accounts
         where user_id = ${userId}::uuid and provider = 'google'`;
      if (!acct?.token_secret_id || acct.status === 'needs_reauth' || acct.status === 'revoked')
        throw new NeedsReauth();
      const refresh = await deps.vault.get(acct.token_secret_id);
      if (!refresh) throw new NeedsReauth();
      try {
        const t = await refreshAccessToken(cfg, refresh);
        cache.set(userId, { token: t.access_token, until: clock() + Math.max(0, t.expires_in - 300) * 1000 });
        return t.access_token;
      } catch (e) {
        if (e instanceof NeedsReauth)
          await deps.db.sql`
            update orbit.integration_accounts set status = 'needs_reauth', last_error = 'invalid_grant'
             where user_id = ${userId}::uuid and provider = 'google'`;
        throw e;
      }
    },
  };
}
