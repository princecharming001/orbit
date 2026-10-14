import { useEffect, useState } from 'react';
import { subscribeSyncStatus, syncStatusNow } from '../engine/serverSync';
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
