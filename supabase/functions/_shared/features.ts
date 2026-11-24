/**
 * The owner's Launch switch for features (plan 44 §9.4), beside the source switches (sources/states.ts). A feature is
 * offered when ORBIT_FEATURES names it (a comma list, read once by each function's entry and passed in) or its row in
 * orbit_private.feature_launch is on (20261211_orbit_roles.sql), read through public.orbit_features_offered() and kept
 * a minute per database handle, so the owner turns a tab on or off with no redeploy, everywhere within a minute.
 * Off by default everywhere.
 */
import type { Db } from './db.ts';

export const KNOWN_FEATURES = ['roles'] as const;
export type Feature = (typeof KNOWN_FEATURES)[number];

export const isFeature = (s: string): s is Feature => (KNOWN_FEATURES as readonly string[]).includes(s);

/** ORBIT_FEATURES: the known names it lists, in order, once each; unset or empty is none. */
export function featuresFromEnv(raw: string | undefined | null): Feature[] {
  const out: Feature[] = [];
  for (const part of (raw ?? '').split(',')) {
    const f = part.trim().toLowerCase();
    if (isFeature(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

/** How long the launch switches are kept per database handle. */
export const FEATURES_TTL_MS = 60_000;

interface Entry {
  at: number;
  launched: Promise<Feature[]>;
}
const cache = new WeakMap<object, Entry>();

/** The features the owner launched (the switch rows that are on); none when they cannot be read. */
export function launchedFeatures(db: Db, clock: () => number = Date.now): Promise<Feature[]> {
  const hit = cache.get(db);
  if (hit && clock() - hit.at < FEATURES_TTL_MS) return hit.launched;
  const launched = Promise.resolve()
    .then(() => db.sql<{ offered: string[] | null }>`select public.orbit_features_offered() as offered`)
    .then((rows) => KNOWN_FEATURES.filter((f) => (rows[0]?.offered ?? []).includes(f)))
    .catch(() => [] as Feature[]);
  cache.set(db, { at: clock(), launched });
  return launched;
}

/** What is offered right now: the env list, then every launched feature it does not name. */
export async function featuresOffered(
  db: Db,
  envList: readonly string[] = [],
  clock?: () => number,
): Promise<Feature[]> {
  const out = envList.filter(isFeature);
  for (const f of await launchedFeatures(db, clock)) if (!out.includes(f)) out.push(f);
  return out;
}

export async function featureOffered(
  db: Db,
  feature: Feature,
  envList: readonly string[] = [],
): Promise<boolean> {
  return (await featuresOffered(db, envList)).includes(feature);
}

/** Forget the cached switches (tests, and the owner's route that has just flipped one). */
export function forgetFeatures(db: Db): void {
  cache.delete(db);
}
