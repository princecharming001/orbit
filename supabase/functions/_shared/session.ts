/**
 * Orbit sessions (§11.2): an HS256 access token `{sub: user_id, sid: session_id, aud: "orbit", iat, exp: +1h}` signed
 * with ORBIT_SESSION_SECRET, and a 30-day refresh token (32 random bytes, base64url) stored only as its sha256 in
 * orbit.sessions and rotated on every refresh. Login codes (the one-time code the OAuth callback hands the SPA) live
 * here too: 32 random bytes, stored hashed, valid for 2 minutes, usable once.
 */
import { jwtVerify, SignJWT } from 'jose';
import { fromBase64, isUuid, randomToken, sha256Hex } from './crypto.ts';
import type { Db } from './db.ts';
import { unauthorized } from './http.ts';

export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_DAYS = 30;
export const LOGIN_CODE_TTL_SEC = 120;
const AUDIENCE = 'orbit';

export interface SessionConfig {
  secret: string;
  now?: () => Date;
}

/** The HMAC key: the secret's bytes when it is base64 of ≥ 32 bytes (as generated), else its UTF-8 bytes. */
export function sessionKey(secret: string): Uint8Array {
  const decoded = fromBase64(secret.trim());
  if (decoded && decoded.length >= 32) return decoded;
  return new TextEncoder().encode(secret);
}

/** A secret too short to sign with counts as missing. */
export function sessionSecretUsable(secret: string | undefined): secret is string {
  return !!secret && secret.trim().length >= 32;
}

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

export async function signAccess(
  cfg: SessionConfig,
  claims: AccessClaims,
): Promise<{ token: string; expiresAt: string }> {
  const now = (cfg.now ?? (() => new Date()))();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ACCESS_TTL_SEC;
  const token = await new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(sessionKey(cfg.secret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The claims of a valid access token; anything else is a 401. */
export async function verifyAccess(cfg: SessionConfig, token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(cfg.secret), {
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: (cfg.now ?? (() => new Date()))(),
    });
    if (!isUuid(payload.sub) || !isUuid(payload.sid)) throw new Error('claims');
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    throw unauthorized('the access token is not valid');
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  sessionId: string;
}

/** A new session for a user: one orbit.sessions row and a token pair. */
export async function createSession(
  db: Db,
  cfg: SessionConfig,
  userId: string,
  userAgent?: string | null,
): Promise<Tokens> {
  const now = (cfg.now ?? (() => new Date()))();
  const refreshToken = randomToken(32);
  const expires = new Date(now.getTime() + REFRESH_TTL_DAYS * 86_400_000);
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.sessions (user_id, refresh_hash, user_agent, created_at, last_used_at, expires_at)
    values (${userId}::uuid, ${await sha256Hex(refreshToken)}, ${userAgent?.slice(0, 300) ?? null},
            ${now}::timestamptz, ${now}::timestamptz, ${expires}::timestamptz)
    returning id`;
  const access = await signAccess(cfg, { userId, sessionId: row!.id });
  return { accessToken: access.token, refreshToken, expiresAt: access.expiresAt, sessionId: row!.id };
}

/**
 * Rotates a refresh token: the old one stops working in the same statement that issues the new one, so a token
 * can be redeemed once. Null when the token is unknown, expired, revoked, or its user is gone.
 */
export async function refreshSession(
  db: Db,
  cfg: SessionConfig,
  refreshToken: string,
): Promise<(Tokens & { userId: string }) | null> {
  if (typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 200) return null;
  const now = (cfg.now ?? (() => new Date()))();
  const next = randomToken(32);
  const expires = new Date(now.getTime() + REFRESH_TTL_DAYS * 86_400_000);
  const [row] = await db.sql<{ id: string; user_id: string }>`
    update orbit.sessions s
       set refresh_hash = ${await sha256Hex(next)}, last_used_at = ${now}::timestamptz, expires_at = ${expires}::timestamptz
      from orbit.users u
     where s.refresh_hash = ${await sha256Hex(refreshToken)} and s.revoked_at is null
       and s.expires_at > ${now}::timestamptz and u.id = s.user_id and u.deleted_at is null
    returning s.id, s.user_id`;
  if (!row) return null;
  const access = await signAccess(cfg, { userId: row.user_id, sessionId: row.id });
  return {
    accessToken: access.token,
    refreshToken: next,
    expiresAt: access.expiresAt,
    sessionId: row.id,
    userId: row.user_id,
  };
}

/** Revokes the session a refresh token belongs to. True when one was revoked. */
export async function revokeSession(db: Db, refreshToken: string, now = new Date()): Promise<boolean> {
  if (typeof refreshToken !== 'string' || !refreshToken) return false;
  const rows = await db.sql`
    update orbit.sessions set revoked_at = ${now}::timestamptz
     where refresh_hash = ${await sha256Hex(refreshToken)} and revoked_at is null
    returning id`;
  return rows.length > 0;
}

/**
 * The signed-in user behind an `Authorization: Bearer` header. The token must verify, and its session must still be
 * live (so logout and account deletion take effect before the hour is up).
 */
export async function authenticate(db: Db, cfg: SessionConfig, header: string | null): Promise<AccessClaims> {
  const claims = await verifyBearer(cfg, header);
  await checkSession(db, cfg, claims);
  return claims;
}

/** The access token's claims, checked by signature and expiry only (no database). */
export async function verifyBearer(cfg: SessionConfig, header: string | null): Promise<AccessClaims> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) throw unauthorized('sign in first');
  return verifyAccess(cfg, m[1]!);
}

/** The session behind verified claims is still live (not signed out, expired or deleted). */
export async function checkSession(db: Db, cfg: SessionConfig, claims: AccessClaims): Promise<void> {
  const now = (cfg.now ?? (() => new Date()))();
  const rows = await db.sql`
    select 1 from orbit.sessions s join orbit.users u on u.id = s.user_id
     where s.id = ${claims.sessionId}::uuid and s.user_id = ${claims.userId}::uuid
       and s.revoked_at is null and s.expires_at > ${now}::timestamptz and u.deleted_at is null`;
  if (!rows.length) throw unauthorized('the session has ended');
}

// ---- login codes ------------------------------------------------------------------------------------------------

export async function createLoginCode(db: Db, userId: string, now = new Date()): Promise<string> {
  const code = randomToken(32);
  await db.sql`
    insert into orbit.login_codes (code_hash, user_id, expires_at)
    values (${await sha256Hex(code)}, ${userId}::uuid, ${new Date(now.getTime() + LOGIN_CODE_TTL_SEC * 1000)}::timestamptz)`;
  return code;
}

/** The user a login code was issued for, marking it used; null when unknown, used or expired. */
export async function redeemLoginCode(db: Db, code: string, now = new Date()): Promise<string | null> {
  if (typeof code !== 'string' || code.length < 20 || code.length > 200) return null;
  const [row] = await db.sql<{ user_id: string }>`
    update orbit.login_codes set used_at = ${now}::timestamptz
     where code_hash = ${await sha256Hex(code)} and used_at is null and expires_at > ${now}::timestamptz
    returning user_id`;
  return row?.user_id ?? null;
}
