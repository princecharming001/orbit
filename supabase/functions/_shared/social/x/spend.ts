/**
 * What X costs, kept by money (plan 43 §5, §8.6, decision 5).
 *
 * Every X call is priced before it is made and reserved in orbit.usage_ledger (provider 'x'), then settled with what X
 * actually returned: a list page is reserved for `max_results` users and the difference is refunded once the page
 * arrives. orbit.social_calls counts each call made or refused, with its settled cost (orbit.social_calls_add).
 *
 * Two limits, both checked before every call, in the same transaction as the reservation and under one advisory lock,
 * so two reads at once cannot both pass a limit with a cent left:
 *   - per student per calendar month (UTC): ORBIT_X_STUDENT_MONTHLY_USD, 15 by default
 *   - for all of Orbit per calendar month: ORBIT_X_MONTHLY_USD, 0 by default, which means every X read is refused
 *     until the owner sets a number
 * A check the student asked for also carries a ceiling, the price they were shown (`quoteXCheck`): a call that would
 * take the check past it is refused, so what is charged is never more than what was quoted.
 */
import type { Db } from '../../db.ts';
import type { SocialCallKind, SocialList } from '../adapter.ts';
import type { XBudget, XReservation } from './adapter.ts';
import { type XDeps, xAdapterFor } from './client.ts';
import { LIST_SLACK, roundUsd, X_READ_USD, X_SEND_USD, type XConfig } from './config.ts';
import { heldXList, readXProfile, upsertXAccount } from './lists.ts';

/** Dollars for `units` of one kind of call: users or events read at $0.01, messages sent at $0.015. */
export function xPrice(kind: SocialCallKind, units: number): number {
  if (kind === 'send') return roundUsd(units * X_SEND_USD);
  return roundUsd(units * X_READ_USD);
}

/** Users a whole list of `size` is priced for: the list, plus a little room in case it grew since the profile read. */
export const xListUnits = (size: number) => Math.max(0, Math.floor(size)) + LIST_SLACK;

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** What X has cost this calendar month (UTC): this student, and all of Orbit. */
export async function xSpendThisMonth(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<{ studentUsd: number; orbitUsd: number }> {
  const [r] = await db.sql<{ student: string; orbit: string }>`
    select coalesce(sum(cost_usd) filter (where user_id = ${userId}::uuid), 0)::text as student,
           coalesce(sum(cost_usd), 0)::text as orbit
      from orbit.usage_ledger
     where provider = 'x' and created_at >= ${monthStart(now)}::timestamptz`;
  return { studentUsd: roundUsd(Number(r?.student ?? 0)), orbitUsd: roundUsd(Number(r?.orbit ?? 0)) };
}

/** Whether Orbit's own monthly limit leaves nothing to spend (a limit of 0 always does). */
export async function xOrbitLimitReached(db: Db, cfg: XConfig, now = new Date()): Promise<boolean> {
  if (cfg.orbitMonthlyUsd <= 0) return true;
  const [r] = await db.sql<{ orbit: string }>`
    select coalesce(sum(cost_usd), 0)::text as orbit from orbit.usage_ledger
     where provider = 'x' and created_at >= ${monthStart(now)}::timestamptz`;
  return Number(r?.orbit ?? 0) + X_READ_USD > cfg.orbitMonthlyUsd + 1e-9;
}

export interface XSpendOptions {
  userId: string;
  limits: Pick<XConfig, 'studentMonthlyUsd' | 'orbitMonthlyUsd'>;
  /** who asked, for orbit.social_calls: 'connect', 'quote', 'check', 'dms', 'send' */
  caller?: string;
  /** the most this budget may charge in all, the price the student was shown for a check */
  ceilingUsd?: number;
  now?: () => Date;
}

export interface XSpend extends XBudget {
  /** what this budget has charged so far, settled calls and open reservations together */
  chargedUsd(): number;
}

const SPEND_LOCK = 'orbit:x:spend';

export function xSpend(db: Db, o: XSpendOptions): XSpend {
  const now = o.now ?? (() => new Date());
  const caller = o.caller ?? 'x';
  let charged = 0;
  const count = (kind: SocialCallKind, made: number, refused: number, cost: number) =>
    db.sql`select orbit.social_calls_add('x', ${o.userId}, ${kind}, ${caller}, ${made}::int, 0, ${refused}::int,
                                         ${cost}::numeric)`;

  async function reserve(kind: SocialCallKind, units: number): Promise<XReservation | undefined> {
    const n = Math.max(0, Math.floor(units));
    const cost = xPrice(kind, n);
    // X matching is by public proof only: a search by name is never made
    if (kind === 'search') {
      await count(kind, 0, 1, 0);
      return undefined;
    }
    if (o.ceilingUsd !== undefined && charged + cost > o.ceilingUsd + 1e-9) {
      await count(kind, 0, 1, 0);
      return undefined;
    }
    const at = now();
    const id = await db.begin(async (tx) => {
      await tx.sql`select pg_advisory_xact_lock(hashtext(${SPEND_LOCK}))`;
      const [row] = await tx.sql<{ id: string }>`
        insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, created_at)
        values (${o.userId}::uuid, 'x', ${kind}, ${n}::numeric, ${cost}::numeric, ${at}::timestamptz)
        returning id::text as id`;
      const [s] = await tx.sql<{ student: string; orbit: string }>`
        select coalesce(sum(cost_usd) filter (where user_id = ${o.userId}::uuid), 0)::text as student,
               coalesce(sum(cost_usd), 0)::text as orbit
          from orbit.usage_ledger
         where provider = 'x' and created_at >= ${monthStart(at)}::timestamptz`;
      const over =
        Number(s!.student) > o.limits.studentMonthlyUsd + 1e-9 ||
        Number(s!.orbit) > o.limits.orbitMonthlyUsd + 1e-9 ||
        // a limit of 0 is off, even for a call priced at nothing
        o.limits.orbitMonthlyUsd <= 0 ||
        o.limits.studentMonthlyUsd <= 0;
      if (over) {
        await tx.sql`delete from orbit.usage_ledger where id = ${row!.id}::bigint`;
        return undefined;
      }
      return row!.id;
    });
    if (!id) {
      await count(kind, 0, 1, 0);
      return undefined;
    }
    charged = roundUsd(charged + cost);
    let settled = false;
    return {
      async settle(unitsUsed) {
        if (settled) return;
        settled = true;
        const used = Math.max(0, Math.min(n, Math.floor(unitsUsed)));
        const actual = xPrice(kind, used);
        charged = roundUsd(charged - cost + actual);
        await db.sql`
          update orbit.usage_ledger set units = ${used}::numeric, cost_usd = ${actual}::numeric
           where id = ${id}::bigint`;
        await count(kind, 1, 0, actual);
      },
    };
  }

  return {
    reserve,
    async spend(kind, opts = {}) {
      const units = opts.units ?? 1;
      const r = await reserve(kind, units);
      if (!r) return false;
      await r.settle(units);
      return true;
    },
    retryAt: async () => undefined,
    chargedUsd: () => charged,
  };
}

// ---- the quote ---------------------------------------------------------------------------------------------------

export interface XQuote {
  /** what the check will cost at most; the check is stopped before it charges more */
  quoteUsd: number;
  /** the target's list the check reads to the end, or null when none will be read */
  list: SocialList | null;
  /** how many accounts are on that list (the profile's count) */
  size: number;
  reason?: 'protected' | 'gone' | 'too_big' | 'held' | 'limit' | 'rate_limited' | 'not_connected';
  targetAccountId?: string;
  /** the bridge-confirmation side of the price, included in quoteUsd */
  confirmUsd?: number;
}

/**
 * The student's circle on X (plan 43 §3.3), from what Orbit holds: accounts attached to their people, and accounts
 * they and the student follow each other on, from the student's own list.
 */
export async function xCircle(db: Db, userId: string, meId: string | null): Promise<string[]> {
  const rows = await db.sql<{ id: string }>`
    select account_id as id from orbit.social_links where user_id = ${userId}::uuid and platform = 'x'
    union
    select f.followed_id as id from orbit.social_follows f
     where f.platform = 'x' and f.owner_user_id = ${userId}::uuid and f.follower_id = ${meId ?? ''}
       and exists (select 1 from orbit.social_follows g
                    where g.platform = 'x' and g.owner_user_id = ${userId}::uuid
                      and g.follower_id = f.followed_id and g.followed_id = ${meId ?? ''})`;
  return rows.map((r) => r.id).filter((id) => id && id !== meId);
}

/**
 * The price of checking one target on X before anything else is read (plan 43 §5 "Check X for Priya"). Reads the
 * target's profile (one $0.01 user read, counted like any other), then prices:
 *   - the target's shorter list, if it has at most ORBIT_X_LIST_LIMIT people: read to the end or not at all, free when
 *     a complete copy is already held (another student checked them this month)
 *   - confirming the other direction for the bridges it may find, from whichever side is cheaper given what Orbit
 *     holds: the target's other list, or each circle account's own list (an upper bound: every circle account is
 *     priced as if it were a candidate)
 * The check that follows is run with the quote as its ceiling (`xSpend({ ceilingUsd })`), so it is never charged more.
 */
export async function quoteXCheck(db: Db, userId: string, targetRef: string, deps: XDeps): Promise<XQuote> {
  const now = deps.now ?? (() => new Date());
  const limit = deps.cfg.listLimit;
  const client = await xAdapterFor(db, userId, deps, { caller: 'quote' });
  if (!client) return { quoteUsd: 0, list: null, size: 0, reason: 'not_connected' };
  const read = await readXProfile(db, client.adapter, targetRef, userId);
  if (!read.ok) return { quoteUsd: 0, list: null, size: 0, reason: read.reason };
  const t = read.profile.account;
  // protected accounts are never read (readXProfile has dropped what Orbit held of them)
  if (t.isPrivate) return { quoteUsd: 0, list: null, size: 0, reason: 'protected', targetAccountId: t.id };
  // the target matters: their public profile is kept (30 days, like every X row)
  await upsertXAccount(db, t, now());
  const sizes = { following: t.following ?? 0, followers: t.followers ?? 0 };
  const held = {
    following: !!(await heldXList(db, t.id, 'following', userId, now())),
    followers: !!(await heldXList(db, t.id, 'followers', userId, now())),
  };
  if (held.following && held.followers)
    return { quoteUsd: 0, list: null, size: 0, reason: 'held', targetAccountId: t.id };
  const list: SocialList = sizes.following <= sizes.followers ? 'following' : 'followers';
  const other: SocialList = list === 'following' ? 'followers' : 'following';
  const size = sizes[list];
  if (size > limit) return { quoteUsd: 0, list: null, size, reason: 'too_big', targetAccountId: t.id };
  const listUsd = held[list] ? 0 : xPrice('list', xListUnits(size));

  // the other direction: the target's other list, or the circle's own lists of the same name (plan 43 §3.6 step 5)
  let confirmUsd = 0;
  const circle = await xCircle(db, userId, client.meId);
  if (circle.length && !held[other]) {
    const viaTarget =
      sizes[other] <= limit ? xPrice('list', xListUnits(sizes[other])) : Number.POSITIVE_INFINITY;
    let viaCircle = 0;
    const known = await db.sql<{ account_id: string; following: number | null; followers: number | null }>`
      select account_id, following, followers from orbit.social_accounts
       where platform = 'x' and account_id = any(${circle}::text[])`;
    const counts = new Map(known.map((k) => [k.account_id, k]));
    for (const id of circle) {
      if (await heldXList(db, id, list, userId, now())) continue;
      const k = counts.get(id);
      const n = list === 'following' ? k?.following : k?.followers;
      // an unknown size is priced at the limit: the most a readable list can cost
      const s = typeof n === 'number' ? n : limit;
      if (s > limit) continue;
      viaCircle = roundUsd(viaCircle + xPrice('list', xListUnits(s)));
    }
    confirmUsd = Math.min(viaTarget, viaCircle);
  }
  return {
    quoteUsd: roundUsd(listUsd + confirmUsd),
    list,
    size,
    targetAccountId: t.id,
    confirmUsd,
  };
}
