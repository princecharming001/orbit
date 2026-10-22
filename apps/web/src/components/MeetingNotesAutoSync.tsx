import { useEffect, useRef } from 'react';
import { autoSyncFathom } from '../engine/fathom';
import { autoSyncMeetingApps } from '../engine/meetingApps';
import { useSession } from '../state/session';

/**
 * Imports new meetings from the student's notetaker (Fathom, Granola, Fireflies or Wispr Flow) when the app opens and
 * the last import is more than half a day old. Mounted once in the app shell, next to the outbox scheduler. Quiet: a
 * failure is recorded on the app's row, where Settings shows it.
 */
export function MeetingNotesAutoSync() {
  const { user } = useSession();
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id;
  useEffect(() => {
    const u = userRef.current;
    if (!userId || !u?.onboardingCompletedAt) return;
    void autoSyncFathom(u).catch(() => undefined);
    void autoSyncMeetingApps(u).catch(() => undefined);
  }, [userId]);
  return null;
}
