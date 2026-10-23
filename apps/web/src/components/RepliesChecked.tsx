import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import {
  checkedAgo,
  checkingReplies,
  checkReplies,
  type ReplyCheckState,
  replyCheckKey,
  replySources,
  watchReplyCheck,
} from '../engine/checkReplies';
import { useSession } from '../state/session';
import { cx } from '../ui';

/**
 * "Checked for replies 2 min ago · Check now": when Orbit last read Gmail, the calendar and LinkedIn for this
 * student, and a way to read them again this second. Shown under the board's title and in Drafts. With nothing
 * connected there is nothing to check, and the line says so instead (`fallback`), or shows nothing.
 */
export function RepliesChecked({ fallback, className }: { fallback?: string; className?: string }) {
  const { user, userId } = useSession();
  const sources = useLiveQuery(() => (userId ? replySources(userId) : undefined), [userId]);
  const state = useLiveQuery(
    async () => (userId ? ((await db.kv.get(replyCheckKey(userId)))?.value as ReplyCheckState) : undefined),
    [userId],
  );
  const [checking, setChecking] = useState(checkingReplies());
  useEffect(() => watchReplyCheck(() => setChecking(checkingReplies())), []);
  // "2 min ago" keeps up with the clock
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!user || !sources) return null;
  if (!sources.gmail && !sources.linkedin && !sources.demo)
    return fallback ? <span className={className}>{fallback}</span> : null;
  const problem = state?.problems?.[0];
  return (
    <span
      className={cx('inline-flex flex-wrap items-center gap-x-1.5', className)}
      data-testid="replies-checked"
    >
      {checking ? (
        <span data-testid="replies-checking">Checking for replies…</span>
      ) : state ? (
        <span data-testid="replies-checked-at">Checked for replies {checkedAgo(state.checkedAt, now)}</span>
      ) : (
        <span>Not checked for replies yet</span>
      )}
      {problem && !checking && (
        <>
          <span aria-hidden>·</span>
          <span className="text-warn" data-testid="replies-problem">
            {problem.message}
          </span>
          <Link to="/settings/integrations" className="underline underline-offset-2 hover:text-ink">
            Fix
          </Link>
        </>
      )}
      {!checking && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => void checkReplies(user, { reason: 'manual' }).catch(() => undefined)}
            className="underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
            data-testid="replies-check-now"
          >
            Check now
          </button>
        </>
      )}
    </span>
  );
}
