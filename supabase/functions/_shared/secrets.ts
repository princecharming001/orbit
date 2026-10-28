/**
 * Orbit's own secrets (session signing key, cron secret, webhook tokens) are generated inside the database by
 * supabase/migrations/20261014_orbit_secrets.sql and kept in Vault, so no person or tool ever handles their values.
 * A function reads the environment variable first (an operator override) and falls back to orbit.secret(<name>).
 */
import type { Db } from './db.ts';

export async function resolveSecret(
  env: (name: string) => string | undefined,
  db: Db | undefined,
  envName: string,
  vaultName: string,
): Promise<string | undefined> {
  const fromEnv = env(envName);
  if (fromEnv) return fromEnv;
  if (!db) return undefined;
  try {
    const rows = await db.sql<{ v: string | null }>`select orbit.secret(${vaultName}) as v`;
    return rows[0]?.v || undefined;
  } catch {
    // no Vault row or no orbit.secret yet: the route answers "unconfigured" until it exists
    return undefined;
  }
}

/**
 * A provider's key (Unipile, Anthropic, ...): the function secret when set, else the copy kept in
 * orbit_private.secrets, read through orbit_secret() (service role only), so a key stored once serves every function.
 */
export async function providerSecret(
  env: (name: string) => string | undefined,
  db: Db | undefined,
  name: string,
): Promise<string | undefined> {
  const fromEnv = env(name);
  if (fromEnv) return fromEnv;
  if (!db) return undefined;
  try {
    const rows = await db.sql<{ v: string | null }>`select public.orbit_secret(${name}) as v`;
    return rows[0]?.v || undefined;
  } catch {
    return undefined;
  }
}
