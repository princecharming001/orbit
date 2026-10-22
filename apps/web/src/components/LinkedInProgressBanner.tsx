/**
 * While LinkedIn connects and Orbit reads it, a small card in the corner of every page says where it stands: signing
 * in, waiting on LinkedIn, reading the connections, looking for who to meet, done. It stays put across pages, so the
 * student can keep working.
 */
import { Check, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { clearLinkedInProgress, linkedInProgress, subscribeLinkedInProgress } from '../engine/linkedinLive';
import { cx, Spinner } from '../ui';

const DONE_SHOWN_MS = 12_000;

export function LinkedInProgressBanner() {
  const p = useSyncExternalStore(subscribeLinkedInProgress, linkedInProgress, linkedInProgress);
  useEffect(() => {
    if (p?.phase !== 'done') return;
    const t = setTimeout(clearLinkedInProgress, DONE_SHOWN_MS);
    return () => clearTimeout(t);
  }, [p]);
  if (!p) return null;
  const working = p.phase !== 'done' && p.phase !== 'failed';
  const title =
    p.phase === 'signin'
      ? 'Connecting LinkedIn'
      : p.phase === 'finishing'
        ? 'Waiting for LinkedIn'
        : p.phase === 'reading'
          ? 'Reading your LinkedIn'
          : p.phase === 'analyzing'
            ? 'Looking through your network'
            : p.phase === 'done'
              ? 'LinkedIn is connected'
              : 'LinkedIn did not connect';
  const line =
    p.phase === 'signin'
      ? 'Sign in in the LinkedIn window.'
      : p.phase === 'finishing'
        ? 'If LinkedIn asked you to approve the sign-in in its app, do that now. Orbit keeps waiting.'
        : p.phase === 'reading'
          ? p.count
            ? `${p.count.toLocaleString('en-US')} connections so far`
            : 'Starting with your connections'
          : p.phase === 'analyzing'
            ? `Adding ${p.count?.toLocaleString('en-US') ?? 'your'} connections and finding who to meet`
            : p.message;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pop-in fixed z-[90] bottom-4 right-4 left-4 @[40rem]:left-auto sm:left-auto sm:w-[340px] rounded-[var(--radius-card)] border border-line bg-canvas p-3 shadow-[var(--shadow-card)]"
      data-testid="linkedin-progress"
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cx(
            'mt-0.5 w-6 h-6 shrink-0 rounded-full inline-flex items-center justify-center',
            p.phase === 'done'
              ? 'bg-good-soft text-good'
              : p.phase === 'failed'
                ? 'bg-bad-soft text-bad'
                : 'bg-[#0a66c2] text-white',
          )}
          aria-hidden
        >
          {working ? (
            <Spinner className="w-3.5 h-3.5 border-white/40 border-t-white" />
          ) : p.phase === 'done' ? (
            <Check size={13} />
          ) : (
            <X size={13} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{title}</div>
          {line && <div className="text-[12.5px] text-ink-3 mt-0.5">{line}</div>}
          {p.phase === 'done' && (
            <Link
              to="/people?view=list"
              className="mt-1 inline-block text-[12.5px] text-accent hover:underline"
            >
              See your people
            </Link>
          )}
          {p.phase === 'failed' && (
            <Link
              to="/settings/integrations"
              className="mt-1 inline-block text-[12.5px] text-accent hover:underline"
            >
              Open Integrations
            </Link>
          )}
        </div>
        {!working && (
          <button
            type="button"
            onClick={clearLinkedInProgress}
            className="shrink-0 -mr-1 -mt-1 w-7 h-7 rounded-full inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-canvas-2"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
