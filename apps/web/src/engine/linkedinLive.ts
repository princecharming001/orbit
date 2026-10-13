// temporary stub, replaced by the real implementation
import type { User } from '@orbit/core';

export type LiveConnectResult =
  | { ok: true; rows: number; added: number }
  | { ok: false; reason: 'unconfigured' | 'cancelled' | 'error'; message: string };

/** True when live LinkedIn can be offered: the proxy is configured or this is the demo account. */
export function liveLinkedInAvailable(_user: User): boolean {
  return false;
}

/** Opens the hosted LinkedIn sign-in, waits for it, imports the connections. */
export async function connectLinkedInLive(
  _user: User,
  _opts?: { onProgress?: (count: number) => void; signal?: AbortSignal },
): Promise<LiveConnectResult> {
  return {
    ok: false,
    reason: 'unconfigured',
    message: 'Live LinkedIn is not switched on yet. Upload your export instead.',
  };
}
