import { useEffect, useRef } from 'react';
import { autoCheckReplies, CHECK_EVERY_MS, checkReplies } from '../engine/checkReplies';
import { useSession } from '../state/session';

/**
 * Checks for replies while the app is open (engine/checkReplies.ts): once when it opens, every few minutes after
 * that, and when the window comes back after a minute away. Mounted once in the app shell, next to the outbox
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
    const tick = () => {
      const cur = u();
      if (!cur || document.hidden) return;
      void checkReplies(cur, { reason: 'interval' }).catch(() => undefined);
    };
    const back = () => {
      const cur = u();
      if (!cur || document.hidden) return;
      void autoCheckReplies(cur, { reason: 'focus' }).catch(() => undefined);
    };
    const t = setInterval(tick, CHECK_EVERY_MS);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      stopped = true;
      clearInterval(t);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [userId, ready]);
  return null;
}
