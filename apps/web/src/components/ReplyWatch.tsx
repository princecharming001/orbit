import { useEffect, useRef } from 'react';
import { autoCheckReplies, checkReplies, nextCheckDelay } from '../engine/checkReplies';
import { useSession } from '../state/session';

/**
 * Checks for replies while the app is open (engine/checkReplies.ts): once when it opens, about every ten minutes
 * after that (at random), and when the window comes back after five minutes away. Mounted once in the app shell, next to the outbox
 * scheduler. Quiet: the board and Drafts update live, and the line under their titles says when the last check was.
 * Nothing runs while the tab is hidden, and nothing at all when the app is closed.
 */
export function ReplyWatch() {
  const { user } = useSession();
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id;
  const ready = !!user?.onboardingCompletedAt;
  useEffect(() => {
    if (!userId || !ready) return;
    let stopped = false;
    const u = () => (stopped ? undefined : userRef.current);
    const first = u();
    if (first) void checkReplies(first, { reason: 'open' }).catch(() => undefined);
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const cur = u();
      if (!cur) return;
      if (!document.hidden) void checkReplies(cur, { reason: 'interval' }).catch(() => undefined);
      t = setTimeout(tick, nextCheckDelay());
    };
    const back = () => {
      const cur = u();
      if (!cur || document.hidden) return;
      void autoCheckReplies(cur, { reason: 'focus' }).catch(() => undefined);
    };
    t = setTimeout(tick, nextCheckDelay());
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      stopped = true;
      if (t) clearTimeout(t);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [userId, ready]);
  return null;
}
