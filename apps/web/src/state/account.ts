import { useEffect, useState } from 'react';
import { statusMark, subscribeSyncStatus, syncStatusNow } from '../engine/serverSync';
import {
  type AccountUser,
  accountUser,
  isAccountMode,
  isSignedIn,
  type SyncStatus,
  subscribeSession,
} from '../integrations/orbitApi';

export interface AccountState {
  /** this build talks to an Orbit server */
  mode: boolean;
  signedIn: boolean;
  user?: AccountUser;
}

function read(): AccountState {
  return { mode: isAccountMode(), signedIn: isSignedIn(), user: accountUser() };
}

/** The Orbit account in this browser, kept current across sign-in, sign-out and other tabs. */
export function useAccount(): AccountState {
  const [s, setS] = useState(read);
  useEffect(() => subscribeSession(() => setS(read())), []);
  return s;
}

/** The last /sync/status answer (account mode), updated as the sync loop polls. */
export function useSyncStatus(): SyncStatus | undefined {
  const [s, setS] = useState(syncStatusNow);
  useEffect(() => subscribeSyncStatus(setS), []);
  return s;
}

/**
 * One of the status's marks (plan 35 B3): it changes when what /linkedin/status or /autopilot/status answers changed
 * on the server, so a screen reads that route again only then. Undefined before the first status, or from a server
 * from before the marks.
 */
export function useStatusMark(kind: 'linkedin' | 'autopilot'): string | undefined {
  const [m, setM] = useState(() => statusMark(kind, syncStatusNow()));
  useEffect(() => subscribeSyncStatus((s) => setM(s ? statusMark(kind, s) : undefined)), [kind]);
  return m;
}
