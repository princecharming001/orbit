/**
 * Per-user spending caps (§13.5), read from orbit.usage_ledger before a paid call:
 *   per day   Claude $1.50, Exa $0.50, Village 50 credits, Apollo match 10 credits, Unipile profile views 40
 *   per month $25 across every provider (calendar month, UTC)
 * Over a cap the task gets `budget_exceeded` with the cap and when it resets, and makes no call.
 */
import type { Db } from './db.ts';

export interface Cap {
  id: string;
  provider: string;
  operation?: string;
  /** what is summed: dollars or units (credits, views) */
  measure: 'cost_usd' | 'units';
  limit: number;
  window: 'day' | 'month';
}

export const CAPS: Cap[] = [
  { id: 'claude_daily_usd', provider: 'anthropic', measure: 'cost_usd', limit: 1.5, window: 'day' },
  { id: 'exa_daily_usd', provider: 'exa', measure: 'cost_usd', limit: 0.5, window: 'day' },
  { id: 'village_daily_credits', provider: 'village', measure: 'units', limit: 50, window: 'day' },
  {
    id: 'apollo_match_daily_credits',
    provider: 'apollo',
    operation: 'match',
    measure: 'units',
    limit: 10,
    window: 'day',
  },
  {
    id: 'unipile_profile_views_daily',
    provider: 'unipile',
    operation: 'profile_view',
    measure: 'units',
    limit: 40,
    window: 'day',
  },
];
export const MONTHLY_TOTAL_USD = 25;

export interface Spend {
  provider: string;
  operation?: string;
  /** what this call is expected to add */
  units?: number;
  costUsd?: number;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: 'budget_exceeded'; cap: string; limit: number; used: number; resetsAt: string };

function windowStart(window: 'day' | 'month', now: Date): Date {
  return window === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function windowEnd(window: 'day' | 'month', now: Date): Date {
  return window === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Whether a call that would add `spend` stays inside every cap that applies to it. */
export async function checkBudget(
  db: Db,
  userId: string,
  spend: Spend,
  now = new Date(),
): Promise<BudgetVerdict> {
  const day = windowStart('day', now);
  const month = windowStart('month', now);
  const rows = await db.sql<{
    provider: string;
    operation: string;
    day_units: string;
    day_usd: string;
    month_usd: string;
  }>`
    select provider, operation,
           coalesce(sum(units) filter (where created_at >= ${day}::timestamptz), 0)::text as day_units,
           coalesce(sum(cost_usd) filter (where created_at >= ${day}::timestamptz), 0)::text as day_usd,
           coalesce(sum(cost_usd), 0)::text as month_usd
      from orbit.usage_ledger
     where user_id = ${userId}::uuid and created_at >= ${month}::timestamptz
     group by provider, operation`;
  const monthTotal = rows.reduce((s, r) => s + Number(r.month_usd), 0);
  const adding = spend.costUsd ?? 0;
  if (monthTotal + adding > MONTHLY_TOTAL_USD || (monthTotal >= MONTHLY_TOTAL_USD && adding === 0))
    return {
      ok: false,
      reason: 'budget_exceeded',
      cap: 'monthly_total_usd',
      limit: MONTHLY_TOTAL_USD,
      used: round(monthTotal),
      resetsAt: windowEnd('month', now).toISOString(),
    };
  for (const cap of CAPS) {
    if (cap.provider !== spend.provider) continue;
    if (cap.operation && cap.operation !== spend.operation) continue;
    const used = rows
      .filter((r) => r.provider === cap.provider && (!cap.operation || r.operation === cap.operation))
      .reduce((s, r) => s + Number(cap.measure === 'units' ? r.day_units : r.day_usd), 0);
    const add = cap.measure === 'units' ? (spend.units ?? 1) : (spend.costUsd ?? 0);
    if (used + add > cap.limit || (used >= cap.limit && add === 0))
      return {
        ok: false,
        reason: 'budget_exceeded',
        cap: cap.id,
        limit: cap.limit,
        used: round(used),
        resetsAt: windowEnd(cap.window, now).toISOString(),
      };
  }
  return { ok: true };
}

/** Writes what a call actually cost. */
export async function recordUsage(
  db: Db,
  entry: { userId: string | null; provider: string; operation: string; units: number; costUsd: number },
): Promise<void> {
  await db.sql`
    insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd)
    values (${entry.userId}::uuid, ${entry.provider}, ${entry.operation}, ${entry.units}::numeric,
            ${round(entry.costUsd)}::numeric)`;
}

const round = (n: number) => Math.round(n * 100_000) / 100_000;
