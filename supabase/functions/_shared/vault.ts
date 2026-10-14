/**
 * Secrets in Supabase Vault through orbit.vault_put/get/delete (security definer, service role only). Refresh
 * tokens are stored under `google_refresh:<user id>`; rows keep only the returned secret id.
 */
import type { Db } from './db.ts';

export interface Vault {
  put(name: string, secret: string): Promise<string>;
  get(id: string): Promise<string | null>;
  delete(id: string): Promise<void>;
}

export function sqlVault(db: Db): Vault {
  return {
    async put(name, secret) {
      const [row] = await db.sql<{ id: string }>`select orbit.vault_put(${name}, ${secret}) as id`;
      return row!.id;
    },
    async get(id) {
      const [row] = await db.sql<{ v: string | null }>`select orbit.vault_get(${id}::uuid) as v`;
      return row?.v ?? null;
    },
    async delete(id) {
      await db.sql`select orbit.vault_delete(${id}::uuid)`;
    },
  };
}

export const googleRefreshName = (userId: string) => `google_refresh:${userId}`;
