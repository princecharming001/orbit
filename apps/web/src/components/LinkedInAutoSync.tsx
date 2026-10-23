import { useEffect, useRef } from 'react';
import { autoSyncLinkedInActivity } from '../engine/linkedinActivity';
import { autoSyncLinkedInLive } from '../engine/linkedinLive';
import { startPhotoQueue } from '../engine/photoQueue';
import { useSession } from '../state/session';

/**
 * Re-syncs live LinkedIn when the app opens and the last sync is more than a day old (which reads the student's
 * LinkedIn messages and post engagement too), then carries on a message history read that was cut short. Replies
 * are read by the reply check (ReplyWatch), every few minutes. Keeps the photo queue going while the app is open
 * (engine/photoQueue: missing and expired LinkedIn photos, a few a minute). Mounted once in the app shell, next to
 * the outbox scheduler. Quiet: it never toasts, and a failure is recorded on the integration row, where Settings
 * and the chat show it.
 */
export function LinkedInAutoSync() {
  const { user } = useSession();
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id;
  useEffect(() => {
    const u = userRef.current;
    if (!userId || !u?.onboardingCompletedAt) return;
    void autoSyncLinkedInLive(u)
      .catch(() => undefined)
      // a LinkedIn message history read that was cut short carries on
      .then(() => autoSyncLinkedInActivity(u))
      .catch(() => undefined);
    return startPhotoQueue(u);
  }, [userId]);
  return null;
}
