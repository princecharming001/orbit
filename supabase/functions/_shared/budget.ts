/**
 * Per-user spending caps (§13.5), read from orbit.usage_ledger before a paid call:
 *   per day   Claude $1.50 for server work, Claude $4.50 for chat and server work together, Exa $0.50, Village 50 credits, Apollo match 10 credits, Hunter 10 credits, Unipile profile views 40,
 *             Enrow 10 credits, Icypeas 10 credits, Reoon 25 checks (plan 35 E6)
 *   per month $25 across every provider (calendar month, UTC), and Claude $10 for chat and server work together (the
 *   allowance the subscription is priced on; the owner, ORBIT_OWNER_ID, has none)
 *   in total $100 per user, counting the chat's Claude spend too (public.orbit_proxy_spend): a stop against a
 *   runaway account, never a limit a real student meets in a year of normal use
 *   for everyone together, Hunter 40 credits a month (plan 34 A4): under the plan's 50, so tests and a busy day
 *   cannot spend it
 * The combined day cap counts the chat: orbit-claude writes a signed-in student's chat spend under
 * `user:<uuid>:<YYYY-MM-DD>` in public.orbit_proxy_spend (plan 34 A3).
 * X (plan 43 §5) is left out of the month and total caps: it has its own, ORBIT_X_STUDENT_MONTHLY_USD per student and
 * ORBIT_X_MONTHLY_USD for all of Orbit (`_shared/social/x/spend.ts`), so a student's X checks never stop their other work.
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
  /** add the student's chat spend in the cap's window (public.orbit_proxy_spend) to the sum */
  includeChat?: boolean;
  /** the owner (ORBIT_OWNER_ID) is not held to it */
  ownerExempt?: boolean;
}

/** Dollars of Claude a student may use in a calendar month, chat and server work together (orbit-claude holds the same). */
export const CLAUDE_MONTHLY_USD = 10;

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
  {
    id: 'claude_monthly_usd',
    provider: 'anthropic',
    measure: 'cost_usd',
    limit: CLAUDE_MONTHLY_USD,
    window: 'month',
    includeChat: true,
    ownerExempt: true,
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
  // the finders and verifier behind Hunter (plan 35 E6): a day's lookups for one student, as Hunter's
  { id: 'enrow_daily_credits', provider: 'enrow', measure: 'units', limit: 10, window: 'day' },
  { id: 'icypeas_daily_credits', provider: 'icypeas', measure: 'units', limit: 10, window: 'day' },
  { id: 'reoon_daily_checks', provider: 'reoon', measure: 'units', limit: 25, window: 'day' },
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
/** The provider with limits of its own, outside the month and total caps (plan 43 §5). */
const OWN_LIMIT_PROVIDER = 'x';
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
  const monthTotal = rows
    .filter((r) => r.provider !== OWN_LIMIT_PROVIDER)
    .reduce((s, r) => s + Number(r.month_usd), 0);
  const adding = spend.costUsd ?? 0;
  const [life] = await db.sql<{ usd: string }>`
    select (coalesce((select sum(cost_usd) from orbit.usage_ledger
                       where user_id = ${userId}::uuid and provider <> ${OWN_LIMIT_PROVIDER}), 0)
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
    // the chat's Claude spend in the window counts toward the combined caps, never the server-only one, so a student
    // who chatted a lot can still get drafts until chat and server work together reach the combined limit
    if (cap.includeChat) used += await chatSpend(db, userId, cap.window, now);
    const add = cap.measure === 'units' ? (spend.units ?? 1) : (spend.costUsd ?? 0);
    const over = used + add > cap.limit || (used >= cap.limit && add === 0);
    if (over && cap.ownerExempt && (await isOwner(db, userId))) continue;
    if (over)
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

/** Whether this is the owner's account (ORBIT_OWNER_ID, kept in the secrets table), who tests on the live site. */
async function isOwner(db: Db, userId: string): Promise<boolean> {
  try {
    const [r] = await db.sql<{ v: string | null }>`select public.orbit_secret('ORBIT_OWNER_ID') as v`;
    return !!r?.v && r.v.trim() === userId;
  } catch {
    return false;
  }
}

/**
 * What the student's chat has cost in the window, as orbit-claude metered it: `user:<uuid>:<YYYY-MM-DD>` for the day,
 * `user:<uuid>:m:<YYYY-MM>` for the month (0 before the proxy writes them).
 */
async function chatSpend(db: Db, userId: string, window: 'day' | 'month', now: Date): Promise<number> {
  const iso = now.toISOString();
  const subject =
    window === 'day' ? `user:${userId}:${iso.slice(0, 10)}` : `user:${userId}:m:${iso.slice(0, 7)}`;
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
  /** a Claude call's token split (plan 35 A5): uncached input, cache read, cache write, output */
  tokens?: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

/** Writes what a call actually cost; the row's id, for `settleUsage`. */
export async function recordUsage(db: Db, entry: UsageEntry): Promise<string | undefined> {
  const t = entry.tokens;
  const rows = await db.sql<{ id: string }>`
    insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, input_tokens, cache_read_tokens,
                                    cache_write_tokens, output_tokens)
    values (${entry.userId}::uuid, ${entry.provider}, ${entry.operation}, ${entry.units}::numeric,
            ${round(entry.costUsd)}::numeric, ${t ? t.input : null}::bigint, ${t ? t.cacheRead : null}::bigint,
            ${t ? t.cacheWrite : null}::bigint, ${t ? t.output : null}::bigint)
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
