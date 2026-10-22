import { useEffect, useRef } from 'react';
import { cleanUpGuesses } from '../engine/cleanup';
import { enrichFromLinkedIn } from '../engine/enrich';
import { autoSyncFathom } from '../engine/fathom';
import { liveLinkedInAccount, syncLinkedInLive } from '../engine/linkedinLive';
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
    // first, once: clear what older versions saved from guesses (chats from mail never answered, and so on)
    void cleanUpGuesses(u)
      .catch(() => undefined)
      .then(() => {
        void autoSyncFathom(u).catch(() => undefined);
        void autoSyncMeetingApps(u).catch(() => undefined);
        // a LinkedIn connected whose first sync never finished syncs now; then today's few LinkedIn lookups for
        // people the student knows (both quiet no-ops without live LinkedIn)
        void liveLinkedInAccount(u.id)
          .then((row) =>
            row && row.status !== 'revoked' && row.externalAccountId && !row.lastSyncedAt
              ? syncLinkedInLive(u)
              : undefined,
          )
          .catch(() => undefined)
          .finally(() => void enrichFromLinkedIn(u).catch(() => undefined));
      });
  }, [userId]);
  return null;
}
