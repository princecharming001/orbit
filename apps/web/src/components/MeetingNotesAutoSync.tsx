import { useEffect, useRef } from 'react';
import { fillWhyThemGaps } from '../engine/brief';
import { cleanUpGuesses } from '../engine/cleanup';
import { runEnrichment } from '../engine/enrichment';
import { autoSyncFathom } from '../engine/fathom';
import { liveLinkedInAccount, resumeLinkedInConnect, syncLinkedInLive } from '../engine/linkedinLive';
import { autoSyncMeetingApps } from '../engine/meetingApps';
import { repairHeadlineCompanies } from '../engine/people';
import { repairClaims } from '../engine/repair';
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
    if (!userId || !u) return;
    // before setup ends too: what older versions said without evidence (alum labels, meetings from a mention) is
    // repaired; after setup, cleanUpGuesses runs it
    if (!u.onboardingCompletedAt) {
      void repairClaims(u).catch(() => undefined);
      return;
    }
    // a LinkedIn sign-in that was still finishing when the page closed: keep waiting for it in the background
    void resumeLinkedInConnect(u).catch(() => undefined);
    // first, once: clear what older versions saved from guesses (chats from mail never answered, and so on)
    void cleanUpGuesses(u)
      .catch(() => undefined)
      .then(() => repairHeadlineCompanies(u.id))
      .catch(() => undefined)
      .then(() => {
        void autoSyncFathom(u).catch(() => undefined);
        void autoSyncMeetingApps(u).catch(() => undefined);
        // a LinkedIn connected whose first sync never finished syncs now; then today's share of the enrichment
        // waterfall for people the student knows (engine/enrichment; a quiet no-op with nothing to look up with)
        void liveLinkedInAccount(u.id)
          .then((row) =>
            row && row.status !== 'revoked' && row.externalAccountId && !row.lastSyncedAt
              ? syncLinkedInLive(u)
              : undefined,
          )
          .catch(() => undefined)
          // then drafts still waiting on a "Why them" line get one written from what Orbit now knows
          .finally(
            () =>
              void runEnrichment(u)
                .catch(() => undefined)
                .then(() => fillWhyThemGaps(u))
                .catch(() => undefined),
          );
      });
  }, [userId]);
  return null;
}
