import { useEffect, useRef } from 'react';
import { checkNotes } from '../engine/notesCheck';
import { useSession } from '../state/session';

/** How often the page looks whether a chat's notes are due; the check itself asks the notetaker only when one is. */
const LOOK_EVERY_MS = 60_000;

/**
 * The notes check (engine/notesCheck.ts) while the app is open: a look every minute, and once when it opens. Mounted
 * once in the app shell, next to the reply check. Quiet: the Chats view updates live when notes land.
 */
export function NotesWatch() {
  const { user } = useSession();
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id;
  const ready = !!user?.onboardingCompletedAt;
  useEffect(() => {
    if (!userId || !ready) return;
    let stopped = false;
    const tick = () => {
      const cur = stopped ? undefined : userRef.current;
      if (!cur || document.hidden) return;
      void checkNotes(cur).catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, LOOK_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [userId, ready]);
  return null;
}
