/**
 * X's settings and prices (plan 43 §5, §8.6, §10, decision 5).
 *
 * Everything X returns is paid for: $0.010 per user returned by a user lookup or a follow list, $0.010 per DM event,
 * $0.015 per DM sent. The $0.001 "owned read" rate only applies when the token's user owns the developer app, which a
 * student never does, so every read is priced at $0.010. X deduplicates a resource read twice in one UTC day, which
 * can make a real bill lower than Orbit's ledger; prices shown never count on it.
 *
 * The app's client id and secret come from the environment (ORBIT_X_CLIENT_ID, ORBIT_X_CLIENT_SECRET), never from code.
 * Two monthly limits hold every read: one per student (ORBIT_X_STUDENT_MONTHLY_USD, 15 by default) and one for all of
 * Orbit (ORBIT_X_MONTHLY_USD, 0 by default, which means X reads are off until the owner sets a number).
 */
import { parseExtraSources } from '@orbit/core/sources';

export const X_API = 'https://api.x.com';
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
export const X_SCOPES = ['tweet.read', 'users.read', 'follows.read', 'dm.read', 'dm.write', 'offline.access'];

/** Dollars per user returned (lookup or list) and per DM event read. */
export const X_READ_USD = 0.01;
/** Dollars per DM sent. */
export const X_SEND_USD = 0.015;

/** Which version of the consent screen the student agreed to; bump it when the screen's words change. */
export const X_CONSENT_VERSION = 'x-consent-2026-11';

/** What the student sees when X is not set up. */
export const X_NOT_SET_UP = 'X is not set up';

export const DEFAULT_STUDENT_MONTHLY_USD = 15;
export const DEFAULT_ORBIT_MONTHLY_USD = 0;
/** The largest list Orbit reads for one check (plan 5: "600 to start"). */
export const DEFAULT_LIST_LIMIT = 600;
/** Extra users a list read is priced for, in case the list grew a little since its profile was read. */
export const LIST_SLACK = 10;
/** X data is deleted this long after it was read (plan 43 §5 "keeping current"). */
export const X_KEEP_DAYS = 30;

export interface XConfig {
  clientId?: string;
  clientSecret?: string;
  /** where X sends the student back; <functions>/orbit-api/x/callback when not set */
  redirectUri?: string;
  /** dollars one student may spend on X in a calendar month (UTC) */
  studentMonthlyUsd: number;
  /** dollars all of Orbit may spend on X in a calendar month (UTC); 0 means X reads are off */
  orbitMonthlyUsd: number;
  /** the largest list read whole for one check */
  listLimit: number;
  /** the owner listed `x` in ORBIT_EXTRA_SOURCES */
  offered: boolean;
}

const nonNegative = (raw: string | undefined, fallback: number) => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

export function xConfigFromEnv(env: (name: string) => string | undefined): XConfig {
  return {
    clientId: env('ORBIT_X_CLIENT_ID') || undefined,
    clientSecret: env('ORBIT_X_CLIENT_SECRET') || undefined,
    redirectUri: env('ORBIT_X_REDIRECT_URI') || undefined,
    studentMonthlyUsd: nonNegative(env('ORBIT_X_STUDENT_MONTHLY_USD'), DEFAULT_STUDENT_MONTHLY_USD),
    orbitMonthlyUsd: nonNegative(env('ORBIT_X_MONTHLY_USD'), DEFAULT_ORBIT_MONTHLY_USD),
    listLimit: Math.floor(nonNegative(env('ORBIT_X_LIST_LIMIT'), DEFAULT_LIST_LIMIT)),
    offered: parseExtraSources(env('ORBIT_EXTRA_SOURCES')).includes('x'),
  };
}

/** The settings X needs that are missing, by their environment names. */
export function xMissing(cfg: XConfig | undefined): string[] {
  const m: string[] = [];
  if (!cfg?.offered) m.push('ORBIT_EXTRA_SOURCES');
  if (!cfg?.clientId) m.push('ORBIT_X_CLIENT_ID');
  if (!cfg?.clientSecret) m.push('ORBIT_X_CLIENT_SECRET');
  return m;
}

/** Cents are exact: costs are multiples of half a cent, kept to five places like orbit.usage_ledger. */
export const roundUsd = (n: number) => Math.round(n * 100_000) / 100_000;
