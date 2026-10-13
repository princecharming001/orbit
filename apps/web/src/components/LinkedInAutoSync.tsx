import { useEffect, useRef } from 'react';
import { autoSyncLinkedInLive } from '../engine/linkedinLive';
import { useSession } from '../state/session';

/**
 * Re-syncs live LinkedIn when the app opens and the last sync is more than a day old. Mounted once in the app shell,
 * next to the outbox scheduler. Quiet: it never toasts, and a failure is recorded on the integration row, where
 * Settings and the chat show it.
 */
export function LinkedInAutoSync() {
  const { user } = useSession();
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id;
  useEffect(() => {
    const u = userRef.current;
    if (!userId || !u?.onboardingCompletedAt) return;
    void autoSyncLinkedInLive(u).catch(() => undefined);
  }, [userId]);
  return null;
}
