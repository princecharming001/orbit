/**
 * The swarm limit (supabase/migrations/20261206_orbit_linkedin_spread.sql). LinkedIn bans the pattern of many accounts
 * opening the same profile to harvest who they know, and every account in it. So every Unipile read aimed at one
 * person (their profile, their connections, their activity) first asks public.orbit_linkedin_target_take: one account
 * may look again at someone it looked at today, a new account waits a gap after another account's look, and at most a
 * few accounts look at one person in a day. A refused look is "not now", never "nothing there": callers store nothing
 * and try again later. Refusals are counted in orbit.linkedin_calls_daily as kind 'swarm'.
 *
 * The browser path (orbit-connectors) asks over PostgREST (postgrestTargetTake in connectors.ts); the server path asks
 * here, over its own database connection. Without a take (tests, a deployment without the migration) nothing is asked.
 */
import type { Db } from './db.ts';

export interface TargetLimits {
  /** ORBIT_LINKEDIN_TARGET_ACCOUNTS_PER_DAY: how many accounts may look one person up in 24 hours */
  accountsPerDay: number;
  /** ORBIT_LINKEDIN_TARGET_GAP_SECONDS: how long a new account waits after another account's look */
  gapSeconds: number;
}

export const DEFAULT_TARGET_LIMITS: TargetLimits = { accountsPerDay: 3, gapSeconds: 1200 };

/** What the take said: refused looks carry when to try again (ISO), when the database said. */
export interface TargetVerdict {
  allowed: boolean;
  retryAt?: string;
}

/** May this Unipile account look this person up now? `caller` names the part of Orbit asking, for the daily count. */
export type TargetTake = (accountId: string, target: string, caller?: string) => Promise<TargetVerdict>;

/** The kind refusals are counted under in orbit.linkedin_calls_daily. */
export const SWARM_KIND = 'swarm';

/** A person's identifier as every caller writes it before asking (the database hashes it the same way). */
export const normTarget = (id: string) => id.trim().toLowerCase();

/** The limits from the environment, the defaults for anything unset or not a positive number. */
export function targetLimitsFrom(get: (name: string) => string | undefined): TargetLimits {
  const num = (name: string, fallback: number) => {
    const v = Number(get(name));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  return {
    accountsPerDay: num('ORBIT_LINKEDIN_TARGET_ACCOUNTS_PER_DAY', DEFAULT_TARGET_LIMITS.accountsPerDay),
    gapSeconds: num('ORBIT_LINKEDIN_TARGET_GAP_SECONDS', DEFAULT_TARGET_LIMITS.gapSeconds),
  };
}

/** The verdict as the function returns it (jsonb), read tolerantly. */
export function targetVerdict(v: unknown): TargetVerdict {
  const o = (v && typeof v === 'object' ? v : {}) as { allowed?: unknown; retryAt?: unknown };
  return {
    allowed: o.allowed === true,
    ...(typeof o.retryAt === 'string' && o.retryAt ? { retryAt: o.retryAt } : {}),
  };
}

/**
 * The server's take, over its own connection. When the database cannot be asked the look is refused (a read is never
 * made uncounted), with a retry after the gap.
 */
export function sqlTargetTake(
  db: Db,
  limits: Partial<TargetLimits> = {},
  opts: { now?: () => Date } = {},
): TargetTake {
  const { accountsPerDay, gapSeconds } = { ...DEFAULT_TARGET_LIMITS, ...limits };
  const now = opts.now ?? (() => new Date());
  return async (accountId, target, caller = 'server') => {
    const id = normTarget(target);
    if (!accountId || !id) return { allowed: false };
    let verdict: TargetVerdict;
    try {
      const [row] = await db.sql<{ v: unknown }>`
        select public.orbit_linkedin_target_take(${id}, ${accountId}, ${accountsPerDay}::int, ${gapSeconds}::int) as v`;
      verdict = targetVerdict(row?.v);
    } catch {
      return { allowed: false, retryAt: new Date(now().getTime() + gapSeconds * 1000).toISOString() };
    }
    if (!verdict.allowed)
      await db.sql`
        select public.orbit_linkedin_calls_add(${accountId}, ${SWARM_KIND}, ${caller}, 0, 0, 1)`.catch(
        () => undefined,
      );
    return verdict;
  };
}
