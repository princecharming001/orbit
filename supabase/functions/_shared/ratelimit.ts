/**
 * Request counters for the account-mode functions, in the same store orbit-claude and orbit-connectors use
 * (public.orbit_proxy_take, supabase/migrations/20261012_orbit_claude_proxy.sql), called over SQL here since these
 * functions already hold a database connection. Keys are prefixed per function so they never mix.
 */
import type { Db } from './db.ts';

export interface Bucket {
  key: string;
  limit: number;
  expires: string;
}
export type Take = (buckets: Bucket[]) => Promise<{ allowed: boolean; over?: string }>;

export function sqlTake(db: Db): Take {
  return async (bs) => {
    const [row] = await db.sql<{ allowed: boolean; over_bucket: string | null }>`
      select allowed, over_bucket from public.orbit_proxy_take(
        ${bs.map((b) => b.key)}::text[], ${bs.map((b) => b.limit)}::int[], ${bs.map((b) => b.expires)}::timestamptz[])`;
    if (!row) throw new Error('counter store returned nothing');
    return { allowed: row.allowed, over: row.over_bucket ?? undefined };
  };
}

/** Counters in this instance's memory (tests, or when no store is configured). */
export function memoryTake(clock: () => number = Date.now): Take {
  const counts = new Map<string, { n: number; expires: number }>();
  return async (bs) => {
    const now = clock();
    for (const [k, v] of counts) if (v.expires < now) counts.delete(k);
    for (const b of bs) {
      const c = counts.get(b.key) ?? { n: 0, expires: Date.parse(b.expires) };
      c.n++;
      counts.set(b.key, c);
      if (c.n > b.limit) return { allowed: false, over: b.key };
    }
    return { allowed: true };
  };
}

function windows(now: Date) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minute = iso.slice(0, 16);
  const endOfDay = new Date(`${day}T00:00:00Z`);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  const endOfMinute = new Date(`${minute}:00Z`);
  endOfMinute.setUTCMinutes(endOfMinute.getUTCMinutes() + 1);
  return { day, minute, endOfDay: endOfDay.toISOString(), endOfMinute: endOfMinute.toISOString() };
}

/** Per-minute bucket for a hashed caller IP. */
export function ipBuckets(prefix: string, visitor: string, now: Date, perMinute: number): Bucket[] {
  const w = windows(now);
  return [{ key: `${prefix}:min:${w.minute}:ip:${visitor}`, limit: perMinute, expires: w.endOfMinute }];
}

/** Per-minute and per-day buckets for a signed-in user (hashed). */
export function userBuckets(
  prefix: string,
  user: string,
  now: Date,
  limits: { perMinute: number; perDay: number },
): Bucket[] {
  const w = windows(now);
  return [
    { key: `${prefix}:min:${w.minute}:u:${user}`, limit: limits.perMinute, expires: w.endOfMinute },
    { key: `${prefix}:day:${w.day}:u:${user}`, limit: limits.perDay, expires: w.endOfDay },
  ];
}
