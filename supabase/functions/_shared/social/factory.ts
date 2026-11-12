/**
 * The adapter for one student's connected account on a platform, paid for from that account's budget as one caller.
 * Instagram is built here; X adds its own entry to `ADAPTERS` (and its budget) without touching the callers.
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import type { SocialAdapter, SocialBudget } from './adapter.ts';
import { type SocialCaller, sqlSocialBudget } from './budget.ts';
import { createInstagramAdapter } from './instagram.ts';

export interface AdapterEnv {
  fetch: typeof fetch;
  unipile?: { apiKey?: string; baseUrl?: string };
  now: () => Date;
}

export interface ConnectedAccount {
  /** the provider's account id (Unipile's for Instagram) */
  externalId: string;
  /** the platform's id for the student's own account, once read */
  socialAccountId: string | null;
  status: string;
  syncState: Record<string, unknown>;
}

export async function connectedAccount(
  db: Db,
  userId: string,
  platform: SocialPlatform,
): Promise<ConnectedAccount | undefined> {
  const [a] = await db.sql<{
    external_account_id: string | null;
    social_account_id: string | null;
    status: string;
    sync_state: Record<string, unknown> | null;
  }>`
    select external_account_id, social_account_id, status, sync_state from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = ${platform}`;
  if (!a?.external_account_id) return undefined;
  return {
    externalId: a.external_account_id,
    socialAccountId: a.social_account_id,
    status: a.status,
    syncState: (a.sync_state?.[platform] as Record<string, unknown> | undefined) ?? {},
  };
}

type Build = (env: AdapterEnv, account: ConnectedAccount, budget: SocialBudget) => SocialAdapter | undefined;

const ADAPTERS: Partial<Record<SocialPlatform, Build>> = {
  instagram: (env, account, budget) =>
    env.unipile?.apiKey && env.unipile.baseUrl
      ? createInstagramAdapter({
          fetch: env.fetch,
          apiKey: env.unipile.apiKey,
          baseUrl: env.unipile.baseUrl,
          accountId: account.externalId,
          budget,
        })
      : undefined,
};

/** The adapter for a connected account, or undefined when the platform is not configured or not built. */
export function adapterFor(
  db: Db,
  env: AdapterEnv,
  platform: SocialPlatform,
  account: ConnectedAccount,
  caller: SocialCaller,
): SocialAdapter | undefined {
  const build = ADAPTERS[platform];
  if (!build) return undefined;
  return build(
    env,
    account,
    sqlSocialBudget(db, { platform, account: account.externalId, caller, now: env.now }),
  );
}
