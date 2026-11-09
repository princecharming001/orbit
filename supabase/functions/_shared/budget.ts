/**
 * Per-user spending caps (§13.5), read from orbit.usage_ledger before a paid call:
 *   per day   Claude $1.50 for server work, Claude $4.50 for chat and server work together, Exa $0.50, Village 50 credits, Apollo match 10 credits, Hunter 10 credits, Unipile profile views 40
 *   per month $25 across every provider (calendar month, UTC)
 *   in total $100 per user, counting the chat's Claude spend too (public.orbit_proxy_spend): a stop against a
 *   runaway account, never a limit a real student meets in a year of normal use
 *   for everyone together, Hunter 40 credits a month (plan 34 A4): under the plan's 50, so tests and a busy day
 *   cannot spend it
 * The combined day cap counts the chat: orbit-claude writes a signed-in student's chat spend under
 * `user:<uuid>:<YYYY-MM-DD>` in public.orbit_proxy_spend (plan 34 A3).
 * Over a cap the task gets `budget_exceeded` with the cap and when it resets, and makes no call. Credit providers
 * reserve before the call and settle after it (`reserveUsage`), so two lookups running at once cannot both pass a cap
 * with one credit left.
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
  /** whose spend is summed: the user's own (default) or everyone's */
  scope?: 'user' | 'global';
  /** add the student's chat spend today (public.orbit_proxy_spend) to the sum */
  includeChat?: boolean;
}

export const CAPS: Cap[] = [
  { id: 'claude_daily_usd', provider: 'anthropic', measure: 'cost_usd', limit: 1.5, window: 'day' },
  {
    id: 'claude_total_daily_usd',
    provider: 'anthropic',
    measure: 'cost_usd',
    limit: 4.5,
    window: 'day',
    includeChat: true,
  },
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
  { id: 'hunter_daily_credits', provider: 'hunter', measure: 'units', limit: 10, window: 'day' },
  {
    id: 'hunter_monthly_credits_global',
    provider: 'hunter',
    measure: 'units',
    limit: 40,
    window: 'month',
    scope: 'global',
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
/**
 * Everything one user may cost Orbit, server tasks and chat together: a stop against a runaway account. At the
 * month cap of $25 a normal student takes years to reach it (orbit-claude's ORBIT_USER_CAP_USD meters the chat).
 */
export const USER_TOTAL_USD = 100;
/** When the total cap "resets": it does not, so the verdict names a date far enough out to read as "not soon". */
const NEVER = '9999-12-31T00:00:00.000Z';

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
  const rows = await db.sql<LedgerSums>`
    select provider, operation,
           coalesce(sum(units) filter (where created_at >= ${day}::timestamptz), 0)::text as day_units,
           coalesce(sum(cost_usd) filter (where created_at >= ${day}::timestamptz), 0)::text as day_usd,
           coalesce(sum(units), 0)::text as month_units,
           coalesce(sum(cost_usd), 0)::text as month_usd
      from orbit.usage_ledger
     where user_id = ${userId}::uuid and created_at >= ${month}::timestamptz
     group by provider, operation`;
  const monthTotal = rows.reduce((s, r) => s + Number(r.month_usd), 0);
  const adding = spend.costUsd ?? 0;
  const [life] = await db.sql<{ usd: string }>`
    select (coalesce((select sum(cost_usd) from orbit.usage_ledger where user_id = ${userId}::uuid), 0)
          + coalesce((select usd from public.orbit_proxy_spend where subject = ${`user:${userId}`}), 0))::text as usd`;
  const lifetime = Number(life?.usd ?? 0);
  if (lifetime + adding > USER_TOTAL_USD || (lifetime >= USER_TOTAL_USD && adding === 0))
    return {
      ok: false,
      reason: 'budget_exceeded',
      cap: 'user_total_usd',
      limit: USER_TOTAL_USD,
      used: round(lifetime),
      resetsAt: NEVER,
    };
  if (monthTotal + adding > MONTHLY_TOTAL_USD || (monthTotal >= MONTHLY_TOTAL_USD && adding === 0))
    return {
      ok: false,
      reason: 'budget_exceeded',
      cap: 'monthly_total_usd',
      limit: MONTHLY_TOTAL_USD,
      used: round(monthTotal),
      resetsAt: windowEnd('month', now).toISOString(),
    };
  let globalRows: LedgerSums[] | undefined;
  for (const cap of CAPS) {
    if (cap.provider !== spend.provider) continue;
    if (cap.operation && cap.operation !== spend.operation) continue;
    let source = rows;
    if (cap.scope === 'global') {
      globalRows ??= await db.sql<LedgerSums>`
        select provider, operation,
               coalesce(sum(units) filter (where created_at >= ${day}::timestamptz), 0)::text as day_units,
               coalesce(sum(cost_usd) filter (where created_at >= ${day}::timestamptz), 0)::text as day_usd,
               coalesce(sum(units), 0)::text as month_units,
               coalesce(sum(cost_usd), 0)::text as month_usd
          from orbit.usage_ledger
         where provider = ${spend.provider} and created_at >= ${month}::timestamptz
         group by provider, operation`;
      source = globalRows;
    }
    const field: keyof LedgerSums =
      cap.window === 'month'
        ? cap.measure === 'units'
          ? 'month_units'
          : 'month_usd'
        : cap.measure === 'units'
          ? 'day_units'
          : 'day_usd';
    let used = source
      .filter((r) => r.provider === cap.provider && (!cap.operation || r.operation === cap.operation))
      .reduce((s, r) => s + Number(r[field]), 0);
    // the chat's Claude spend today counts toward the combined day cap, never the server-only one, so a student who
    // chatted a lot can still get drafts until chat and server work together reach the combined limit
    if (cap.includeChat) used += await chatSpendToday(db, userId, now);
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

type LedgerSums = {
  provider: string;
  operation: string;
  day_units: string;
  day_usd: string;
  month_units: string;
  month_usd: string;
};

/** What the student's chat has cost today, as orbit-claude metered it (0 before the proxy writes user rows). */
async function chatSpendToday(db: Db, userId: string, now: Date): Promise<number> {
  const subject = `user:${userId}:${now.toISOString().slice(0, 10)}`;
  try {
    const [r] = await db.sql<{ usd: string | null }>`
      select usd::text as usd from public.orbit_proxy_spend where subject = ${subject}`;
    return Number(r?.usd ?? 0);
  } catch {
    return 0;
  }
}

export interface UsageEntry {
  userId: string | null;
  provider: string;
  operation: string;
  units: number;
  costUsd: number;
}

/** Writes what a call actually cost; the row's id, for `settleUsage`. */
export async function recordUsage(db: Db, entry: UsageEntry): Promise<string | undefined> {
  const rows = await db.sql<{ id: string }>`
    insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd)
    values (${entry.userId}::uuid, ${entry.provider}, ${entry.operation}, ${entry.units}::numeric,
            ${round(entry.costUsd)}::numeric)
    returning id::text as id`;
  return rows[0]?.id;
}

/** Sets what a reserved call really cost; an operation renames the row (a miss becomes `<op>:attempt`). */
export async function settleUsage(
  db: Db,
  id: string,
  actual: { units: number; costUsd?: number; operation?: string },
): Promise<void> {
  await db.sql`
    update orbit.usage_ledger set units = ${actual.units}::numeric,
           cost_usd = coalesce(${actual.costUsd === undefined ? null : round(actual.costUsd)}::numeric, cost_usd),
           operation = coalesce(${actual.operation ?? null}, operation)
     where id = ${id}::bigint`;
}

export type Reservation =
  | { ok: true; settle(actual: { units: number; costUsd?: number; operation?: string }): Promise<void> }
  | { ok: false; verdict: Exclude<BudgetVerdict, { ok: true }> };

/**
 * Check, then write the expected spend before the call, so a second call checked a moment later already counts it.
 * The caller settles the row with what the call really cost (0 units for a miss, which then shows as an attempt).
 */
export async function reserveUsage(db: Db, entry: UsageEntry, now = new Date()): Promise<Reservation> {
  if (entry.userId) {
    const v = await checkBudget(
      db,
      entry.userId,
      { provider: entry.provider, operation: entry.operation, units: entry.units, costUsd: entry.costUsd },
      now,
    );
    if (!v.ok) return { ok: false, verdict: v };
  }
  const id = await recordUsage(db, entry);
  return {
    ok: true,
    async settle(actual) {
      if (id) await settleUsage(db, id, actual);
    },
  };
}

const round = (n: number) => Math.round(n * 100_000) / 100_000;
