/**
 * Where a friend's network stands, for the one line under their name on the Friends tab ("Ready to search", "Still
 * syncing", "Not sharing their network"). Only what the server holds is said: what their side shares with the viewer
 * (friend_share_settings), whether an import of theirs is still running (integration_accounts.sync_state, read the
 * way /sync/status reads it for the student's own setup), and how many of their people the viewer can see.
 */
import type { FriendNetworkState, FriendShareMode } from '@orbit/core/server/api';
import type { Db } from '../db.ts';

export type AccountSync = {
  provider: string;
  status: string;
  sync_state: Record<string, Record<string, unknown> | undefined> | null;
};

/**
 * An import still bringing people in: LinkedIn's first full pass (a stage that is not done and no finished pass yet),
 * or Gmail's backfill in its recent or deep phase. An account that is revoked, parked or waiting on a new sign-in is
 * not running anything, whatever its last saved stage says.
 */
export function importRunning(accounts: AccountSync[]): boolean {
  return accounts.some((a) => {
    if (a.provider === 'linkedin') {
      if (a.status !== 'active' && a.status !== 'connecting') return false;
      const li = a.sync_state?.linkedin;
      return !!li && !li.syncedAt && typeof li.stage === 'string' && li.stage !== 'done';
    }
    if (a.provider === 'google') {
      if (a.status !== 'active') return false;
      const phase = (a.sync_state?.gmail?.backfill as { phase?: unknown } | undefined)?.phase;
      return phase === 'recent' || phase === 'deep';
    }
    return false;
  });
}

/** Whether an import is still running for one user. */
export async function stillImporting(db: Db, userId: string): Promise<boolean> {
  const accounts = await db.sql<AccountSync>`
    select provider, status, sync_state from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider in ('google', 'linkedin')`;
  return importRunning(accounts);
}

/**
 * The friend's state as the viewer may know it. Not sharing comes first (nothing else matters then), a running import
 * next (more people are still on their way), then whether anyone is visible at all.
 */
export function networkState(mode: FriendShareMode, visible: number, importing: boolean): FriendNetworkState {
  if (mode === 'none') return 'not_sharing';
  if (importing) return 'syncing';
  return visible > 0 ? 'ready' : 'empty';
}
