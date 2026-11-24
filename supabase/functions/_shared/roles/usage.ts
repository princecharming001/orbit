/**
 * The source side's daily counts in `orbit_private.roles_usage` (plan 44 §9.5): boards read and failed, roles added
 * and closed, discovery requests and refusals, the SimplifyJobs reads. The digest reads them; the day's markers
 * ("Simplify read today", "top-up queued tonight") make a step run once a day. Every kind starts with `src:` so it
 * never meets the search side's counts. The day is the caller's clock in UTC, so tests can drive it.
 */
import type { Db } from '../db.ts';

export const dayOf = (now: Date) => now.toISOString().slice(0, 10);

export type SourceCount =
  | 'boards_read'
  | 'boards_failed'
  | 'boards_too_large'
  | 'roles_added'
  | 'roles_updated'
  | 'roles_closed'
  | 'roles_deleted'
  | 'texts_read'
  | 'discovery_companies'
  | 'discovery_requests'
  | 'discovery_refused'
  | 'discovery_found'
  | 'boards_harvested'
  | 'simplify_listings';

/** Add to today's count. */
export async function count(db: Db, now: Date, kind: SourceCount | string, n = 1): Promise<void> {
  if (!n) return;
  await db.sql`
    insert into orbit_private.roles_usage (day, kind, n) values (${dayOf(now)}::date, ${`src:${kind}`}, ${n}::int)
    on conflict (day, kind) do update set n = orbit_private.roles_usage.n + excluded.n`;
}

/** Take one unit of today's allowance; false when the limit is reached. */
export async function take(db: Db, now: Date, kind: string, limit: number, n = 1): Promise<boolean> {
  const [row] = await db.sql<{ n: number }>`
    insert into orbit_private.roles_usage (day, kind, n) values (${dayOf(now)}::date, ${`src:${kind}`}, ${n}::int)
    on conflict (day, kind) do update set n = orbit_private.roles_usage.n + excluded.n
      where orbit_private.roles_usage.n + excluded.n <= ${limit}::int
    returning n`;
  return !!row && Number(row.n) <= limit;
}

/** Today's value of a count or a marker (0 when none). */
export async function counted(db: Db, now: Date | string, kind: string): Promise<number> {
  const day = typeof now === 'string' ? now : dayOf(now);
  const [row] = await db.sql<{ n: number }>`
    select n from orbit_private.roles_usage where day = ${day}::date and kind = ${`src:${kind}`}`;
  return Number(row?.n ?? 0);
}

/** Set a marker or a cursor for today to `n`. */
export async function setMark(db: Db, now: Date, kind: string, n: number): Promise<void> {
  await db.sql`
    insert into orbit_private.roles_usage (day, kind, n) values (${dayOf(now)}::date, ${`src:${kind}`}, ${n}::int)
    on conflict (day, kind) do update set n = excluded.n`;
}
