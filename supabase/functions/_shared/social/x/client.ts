/**
 * One student's X adapter, wired: tokens from Vault, the money budget, and the student's own X id. Everything that
 * reads X on the server (the quote, the check, DM polling, sending) builds its adapter here.
 */
import type { Db } from '../../db.ts';
import { isOffered } from '../../sources/states.ts';
import { sqlVault, type Vault } from '../../vault.ts';
import { createXAdapter, type XAdapter } from './adapter.ts';
import { type XConfig, xMissing } from './config.ts';
import { loadXState, type XOAuthConfig, type XTokens, xTokens } from './oauth.ts';
import { type XSpend, xSpend } from './spend.ts';

export interface XDeps {
  cfg: XConfig;
  fetch?: typeof fetch;
  /** Vault; orbit.vault_* by default */
  vault?: Vault;
  now?: () => Date;
  /** X's API base, for tests */
  base?: string;
}

export interface XClient {
  adapter: XAdapter;
  spend: XSpend;
  tokens: XTokens;
  /** the student's own X account id */
  meId: string | null;
}

/** X is offered right now: listed in ORBIT_EXTRA_SOURCES, or launched by the owner (plan 43 §3.1). */
export function xOfferedNow(db: Db, cfg: Pick<XConfig, 'offered'> | undefined): Promise<boolean> {
  return isOffered(db, 'x', cfg?.offered ? ['x'] : []);
}

/** What X needs that is missing right now, the owner's switch included. */
export async function xSetupMissing(db: Db, cfg: XConfig | undefined): Promise<string[]> {
  return xMissing(cfg, await xOfferedNow(db, cfg));
}

export function xOAuth(deps: XDeps, redirectUri = ''): XOAuthConfig | undefined {
  if (!deps.cfg.clientId || !deps.cfg.clientSecret) return undefined;
  return {
    clientId: deps.cfg.clientId,
    clientSecret: deps.cfg.clientSecret,
    redirectUri: deps.cfg.redirectUri ?? redirectUri,
    fetch: deps.fetch,
  };
}

/** The student's adapter, or undefined when X is not set up or the student has no working X sign-in. */
export async function xAdapterFor(
  db: Db,
  userId: string,
  deps: XDeps,
  opts: { caller?: string; ceilingUsd?: number } = {},
): Promise<XClient | undefined> {
  const oauth = xOAuth(deps);
  if (!oauth) return undefined;
  const row = await loadXState(db, userId);
  if (row?.status !== 'active') return undefined;
  const now = deps.now ?? (() => new Date());
  const tokens = xTokens(db, deps.vault ?? sqlVault(db), oauth, userId, now);
  const spend = xSpend(db, {
    userId,
    limits: deps.cfg,
    caller: opts.caller,
    ceilingUsd: opts.ceilingUsd,
    now,
  });
  const adapter = createXAdapter({
    tokens,
    budget: spend,
    meId: row.socialAccountId ?? undefined,
    fetch: deps.fetch,
    base: deps.base,
  });
  return { adapter, spend, tokens, meId: row.socialAccountId };
}
