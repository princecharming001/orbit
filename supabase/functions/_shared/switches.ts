/**
 * Per-provider kill switches (plan 34 A5): orbit_private.provider_switches, read through public.orbit_providers_off()
 * (service role only) and kept 5 minutes per database handle, so flipping a row stops a provider within 5 minutes and
 * with no deploy. A provider with no row is on; when the switches cannot be read at all, everything stays on.
 * Names: anthropic, hunter, apollo, exa, unipile_reads, village, web_search.
 */
import type { Db } from './db.ts';

export type SwitchedProvider =
  | 'anthropic'
  | 'hunter'
  | 'apollo'
  | 'exa'
  | 'unipile_reads'
  | 'village'
  | 'web_search';

export const SWITCH_TTL_MS = 5 * 60_000;

interface Entry {
  at: number;
  off: Promise<Set<string>>;
}
const cache = new WeakMap<object, Entry>();

/** The providers switched off, cached SWITCH_TTL_MS per database handle. */
export function providersOff(db: Db, clock: () => number = Date.now): Promise<Set<string>> {
  const hit = cache.get(db);
  if (hit && clock() - hit.at < SWITCH_TTL_MS) return hit.off;
  const off = db.sql<{ off: string[] | null }>`select public.orbit_providers_off() as off`
    .then((rows) => new Set(rows[0]?.off ?? []))
    .catch(() => new Set<string>());
  cache.set(db, { at: clock(), off });
  return off;
}

/** A gate for one provider: resolves false while its switch is off. */
export function switchGate(
  db: Db | undefined,
  provider: SwitchedProvider,
  clock?: () => number,
): (() => Promise<boolean>) | undefined {
  if (!db) return undefined;
  return async () => !(await providersOff(db, clock)).has(provider);
}

/** Forget the cached switches (tests, and a route that has just flipped one). */
export function forgetSwitches(db: Db): void {
  cache.delete(db);
}
