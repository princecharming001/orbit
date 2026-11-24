import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
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
 *
 * `onChecked` runs after a check the student asked for (Drafts rebuilds today's cards from what was just read, so
 * the page needs no Refresh button of its own). `more` is a quiet link or two at the end of the same line.
 */
export function RepliesChecked({
  fallback,
  className,
  onChecked,
  more,
}: {
  fallback?: string;
  className?: string;
  onChecked?: () => Promise<void> | void;
  more?: ReactNode;
}) {
  const { user, userId } = useSession();
  const sources = useLiveQuery(() => (userId ? replySources(userId) : undefined), [userId]);
  const state = useLiveQuery(
    async () => (userId ? ((await db.kv.get(replyCheckKey(userId)))?.value as ReplyCheckState) : undefined),
    [userId],
  );
  const [reading, setReading] = useState(checkingReplies());
  useEffect(() => watchReplyCheck(() => setReading(checkingReplies())), []);
  // the page's own work after the check (Drafts rebuilding its cards) is part of "checking" to the student
  const [after, setAfter] = useState(false);
  const checking = reading || after;
  const check = async () => {
    if (!user || checking) return;
    await checkReplies(user, { reason: 'manual' }).catch(() => undefined);
    if (!onChecked) return;
    setAfter(true);
    try {
      await onChecked();
    } finally {
      setAfter(false);
    }
  };
  const quiet =
    'underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded';
  // "2 min ago" keeps up with the clock
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!user || !sources) return null;
  if (!sources.gmail && !sources.linkedin && !sources.demo) {
    // nothing to check for replies; the page can still rebuild itself, and its link stays
    if (!fallback && !onChecked && !more) return null;
    return (
      <span className={cx('inline-flex flex-wrap items-center gap-x-1.5', className)}>
        {fallback ? <span>{fallback}</span> : null}
        {onChecked ? (
          <>
            {fallback ? <span aria-hidden>·</span> : null}
            <button
              type="button"
              disabled={after}
              onClick={async () => {
                setAfter(true);
                try {
                  await onChecked();
                } finally {
                  setAfter(false);
                }
              }}
              className={quiet}
              data-testid="replies-check-now"
            >
              {after ? 'Updating…' : 'Update'}
            </button>
          </>
        ) : null}
        {more ? (
          <>
            {fallback || onChecked ? <span aria-hidden>·</span> : null}
            {more}
          </>
        ) : null}
      </span>
    );
  }
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
            onClick={() => void check()}
            className={quiet}
            data-testid="replies-check-now"
          >
            Check now
          </button>
        </>
      )}
      {more ? (
        <>
          <span aria-hidden>·</span>
          {more}
        </>
      ) : null}
    </span>
  );
}
