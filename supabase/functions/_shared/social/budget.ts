/**
 * Instagram's budget (plan 43 §4, §3.10): Unipile advises about 10 actions an hour and 100 a day per account, at
 * uneven intervals. Both are rolling windows, counted per Unipile account in orbit.social_call_log by
 * orbit.social_take (supabase/migrations/20261202_orbit_instagram.sql), which also adds to the daily counts in
 * orbit.social_calls.
 *
 * Callers fill a window only to their own ceiling, as the LinkedIn ledgers do: the student's own request (a lookup
 * they asked for, a message they tapped send on) may use the whole window; background work (the first days' reads,
 * refreshes, matching) stops at 60 percent of each, so the student's request always has room; looking for a target's
 * account by name has a small daily share of its own on top.
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import type { SocialBudget, SocialCallKind } from './adapter.ts';

/** Unipile's advice for one Instagram account. */
export const INSTAGRAM_WINDOWS = { hour: 10, day: 100 } as const;
/** How far background work may fill each window. */
export const BACKGROUND_SHARE = 0.6;
/** Calls a day spent looking for the accounts of people the student is going after (plan 43 §3.4 "Targets"). */
export const TARGET_SEARCH_PER_DAY = 10;

/**
 * Who is asking: `student` for what the student asked for and is waiting on (a lookup, a send), `background` for
 * the first days' reads, refreshes and matching, `targets` for finding a target's account.
 */
export type SocialCaller = 'student' | 'background' | 'targets';

export interface WindowLimits {
  hour: number;
  day: number;
  /** a ceiling of the caller's own within the day, counted apart */
  callerDay?: number;
}

export function callerLimits(
  caller: SocialCaller,
  windows: { hour: number; day: number } = INSTAGRAM_WINDOWS,
): WindowLimits {
  if (caller === 'student') return { hour: windows.hour, day: windows.day };
  const bg = {
    hour: Math.floor(windows.hour * BACKGROUND_SHARE),
    day: Math.floor(windows.day * BACKGROUND_SHARE),
  };
  return caller === 'targets' ? { ...bg, callerDay: TARGET_SEARCH_PER_DAY } : bg;
}

export interface SqlBudgetOptions {
  platform: SocialPlatform;
  /** the Unipile account id the windows are kept for */
  account: string;
  caller: SocialCaller;
  now: () => Date;
  windows?: { hour: number; day: number };
}

/** A budget over orbit.social_take: every call is counted, refused calls too, and `retryAt` says when room opens. */
export function sqlSocialBudget(db: Db, o: SqlBudgetOptions): SocialBudget & { lastRetryAt?: Date } {
  const limits = callerLimits(o.caller, o.windows);
  const budget: SocialBudget & { lastRetryAt?: Date } = {
    async spend(kind: SocialCallKind, opts = {}) {
      const units = Math.max(1, Math.floor(opts.units ?? 1));
      const [r] = await db.sql<{ allowed: boolean; retry_at: Date | string | null }>`
        select allowed, retry_at from orbit.social_take(
          ${o.platform}, ${o.account}, ${kind}, ${opts.caller ?? o.caller}, ${limits.hour}::int, ${limits.day}::int,
          ${units}::int, ${o.now().toISOString()}::timestamptz, ${limits.callerDay ?? null}::int)`;
      if (r?.allowed) return true;
      budget.lastRetryAt = r?.retry_at ? new Date(r.retry_at) : undefined;
      return false;
    },
    async retryAt() {
      return budget.lastRetryAt;
    },
  };
  return budget;
}

/** A budget that refuses nothing (the fake graph's own tests, and readers that pay elsewhere). */
export const UNLIMITED: SocialBudget = { spend: async () => true };

/** An uneven wait around `baseMs` (half to one and a half times it), so calls never fall at fixed times. */
export function unevenMs(baseMs: number, random: () => number = Math.random): number {
  return Math.round(baseMs * (0.5 + random()));
}
