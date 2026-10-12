import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { connectGoogle, disconnectGoogle, googleScopeWarning } from '../integrations/google';
import { writePrefs } from '../integrations/prefs';
import { type SyncProgress, syncGoogle } from './sync';

/** The Google row for a user, if any. */
export async function googleAccount(userId: string): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'google')
    .first();
}

/**
 * Record a Google sign-in as the connected account. `fresh` (setup) starts the sync state over; Settings'
 * "Reconnect and sync now" keeps the checkpoint and the original connection date.
 */
export async function recordGoogleConnection(
  userId: string,
  token: { email?: string; scopes?: string[] },
  opts: { fresh?: boolean; now?: Date } = {},
): Promise<IntegrationAccount> {
  const existing = await googleAccount(userId);
  const at = (opts.now ?? new Date()).toISOString();
  const row: IntegrationAccount = {
    id: existing?.id ?? newId('int'),
    userId,
    provider: 'google',
    externalAccountId: token.email,
    status: 'active',
    scopes: token.scopes ?? [],
    syncState: opts.fresh ? {} : (existing?.syncState ?? {}),
    connectedAt: opts.fresh ? at : (existing?.connectedAt ?? at),
  };
  await db.integrations.put(row);
  return row;
}

/** A connect or sync failed: Today's problems card points at Settings until it is fixed. */
export async function markGoogleNeedsReauth(userId: string, error: string): Promise<void> {
  const g = await googleAccount(userId);
  if (g) await db.integrations.update(g.id, { status: 'needs_reauth', lastError: error });
}

/** Disconnect Google: the token is revoked and the account row goes; imported mail stays. */
export async function disconnectGoogleAccount(userId: string): Promise<boolean> {
  disconnectGoogle();
  const g = await googleAccount(userId);
  if (!g) return false;
  await db.integrations.delete(g.id);
  return true;
}

/**
 * Connect Google and sync: the optional developer client id is saved, the sign-in popup opens, the account row is
 * written, and the first sync runs. Returns the missing-permission warning, if any. Needs the live page (the popup).
 */
export async function connectAndSyncGoogle(
  user: User,
  opts: { clientId?: string; fresh?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<{ email?: string; warning?: string }> {
  if (opts.clientId !== undefined) writePrefs({ googleClientId: opts.clientId.trim() || undefined });
  const t = await connectGoogle();
  await recordGoogleConnection(user.id, t, { fresh: opts.fresh });
  if (t.email && !user.email) await db.users.update(user.id, { email: t.email });
  const fresh = (await db.users.get(user.id)) ?? user;
  await syncGoogle(fresh, { onProgress: opts.onProgress });
  return { email: t.email, warning: googleScopeWarning(t.scopes) };
}

/** Record a LinkedIn import done in setup (the full import in Settings and Today does this itself). */
export async function recordLinkedInImport(userId: string, rows: number, now = new Date()): Promise<void> {
  const earlier = await db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'linkedin_csv')
    .first();
  await db.integrations.put({
    id: earlier?.id ?? newId('int'),
    userId,
    provider: 'linkedin_csv',
    status: 'active',
    scopes: [],
    syncState: { rows },
    connectedAt: earlier?.connectedAt ?? now.toISOString(),
    lastSyncedAt: now.toISOString(),
  });
}
