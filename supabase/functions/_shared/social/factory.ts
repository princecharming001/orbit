/**
 * The adapter for one student's connected account on a platform, paid for from that account's budget as one caller.
 *
 * Instagram (`adapterFor`, synchronous): Unipile, counted in rolling windows (budget.ts). X (`socialAdapterFor`, the
 * async variant every caller that may serve X uses): X's own API through `xAdapterFor`, paid by money from the
 * student's monthly X budget (x/spend.ts), with tokens from Vault. Matching, the first days and the lookup job go
 * through `socialAdapterFor`, so they work for both without knowing which.
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import type { SocialAdapter, SocialBudget } from './adapter.ts';
import { type SocialCaller, sqlSocialBudget } from './budget.ts';
import { createInstagramAdapter } from './instagram.ts';
import { type XDeps, xAdapterFor } from './x/client.ts';

export interface AdapterEnv {
  fetch: typeof fetch;
  unipile?: { apiKey?: string; baseUrl?: string };
  now: () => Date;
  /** X's settings (and Vault, tests' base URL); X has no adapter without them */
  x?: Omit<XDeps, 'now'>;
}

export interface ConnectedAccount {
  userId: string;
  /** the provider's account id (Unipile's for Instagram; the student's own X id for X) */
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
  // X has no provider account apart from the student's own X id
  const externalId = a?.external_account_id ?? (platform === 'x' ? a?.social_account_id : null);
  if (!a || !externalId) return undefined;
  return {
    userId,
    externalId,
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

/**
 * The adapter for a connected account on either platform, or undefined when the platform is not configured or the
 * account cannot be read. X's is money-budgeted: `ceilingUsd` caps what this adapter may charge in all (the price the
 * student was shown for a check).
 */
export async function socialAdapterFor(
  db: Db,
  env: AdapterEnv,
  platform: SocialPlatform,
  account: ConnectedAccount,
  caller: SocialCaller | string,
  opts: { ceilingUsd?: number } = {},
): Promise<SocialAdapter | undefined> {
  if (platform === 'x') {
    if (!env.x?.cfg) return undefined;
    const client = await xAdapterFor(
      db,
      account.userId,
      { ...env.x, fetch: env.x.fetch ?? env.fetch, now: env.now },
      { caller, ceilingUsd: opts.ceilingUsd },
    );
    return client?.adapter;
  }
  return adapterFor(db, env, platform, account, caller as SocialCaller);
}
