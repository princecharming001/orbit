/**
 * The status line (plan 23 §4.7): one quiet line at the foot of the sidebar (and at the top of the phone's More
 * sheet) saying what Orbit is doing right now, that it is up to date, or what needs the student. A click opens
 * "What Orbit is doing": what runs, today's counts and the problems with their fix. It must not draw the eye: 12px,
 * a 6px dot that breathes while something runs, no spinner.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import {
  type ActivityCounts,
  activityCounts,
  activityLine,
  activityProblems,
  activityVersion,
  itemText,
  LINE_EVERY_MS,
  type ActivityLine as Line,
  liveActivities,
  subscribeActivity,
} from '../engine/activity';
import { type ReplyCheckState, replyCheckKey } from '../engine/checkReplies';
import { useFlag } from '../engine/flags';
import { useSession } from '../state/session';
import { cx } from '../ui';

/** The line as it should read now, held for LINE_EVERY_MS so it never flickers between quick jobs. */
function useActivity() {
  const { user, userId } = useSession();
  useSyncExternalStore(subscribeActivity, activityVersion, activityVersion);
  const problems = useLiveQuery(() => (user ? activityProblems(user) : []), [user?.id]) ?? [];
  const lastCheck = useLiveQuery(
    async () =>
      userId ? ((await db.kv.get(replyCheckKey(userId)))?.value as ReplyCheckState | undefined) : undefined,
    [userId],
  );
  // "2 min ago" keeps up with the clock, and stuck items are dropped as time passes
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = liveActivities(Date.now());
  const line = activityLine(items, problems, lastCheck?.checkedAt, Math.max(now, Date.now()));
  const [shown, setShown] = useState(line);
  const shownAt = useRef(0);
  const key = `${line.state}|${line.text}`;
  useEffect(() => {
    const wait = shownAt.current + LINE_EVERY_MS - Date.now();
    if (wait <= 0) {
      shownAt.current = Date.now();
      setShown(line);
      return;
    }
    const t = setTimeout(() => {
      shownAt.current = Date.now();
      setShown(line);
    }, wait);
    return () => clearTimeout(t);
    // the line's words are what matter: a new object with the same words is no change
  }, [key]);
  return { line: shown, items, problems };
}

function Dot({ state }: { state: Line['state'] }) {
  return (
    <span
      aria-hidden
      className={cx(
        'w-1.5 h-1.5 rounded-full shrink-0',
        state === 'running' && 'bg-accent breathe',
        state === 'idle' && 'bg-[#b9b5ae]',
        state === 'problem' && 'bg-[#d08a1c]',
      )}
      data-testid="activity-dot"
      data-state={state}
    />
  );
}

/**
 * The line. `compact` is the collapsed sidebar: the dot alone, with the line as its tooltip.
 */
export function ActivityLine({
  compact,
  below,
  className,
}: {
  compact?: boolean;
  /** the popover opens under the line (the phone's More sheet, where the line is at the top) */
  below?: boolean;
  className?: string;
}) {
  const on = useFlag('activityLine');
  const { line } = useActivity();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!on) return null;
  return (
    <div ref={box} className={cx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={compact ? `What Orbit is doing: ${line.text}` : undefined}
        data-tip={compact ? line.text : undefined}
        className={cx(
          'w-full flex items-center gap-2 text-left text-[12px] text-ink-3 rounded-md hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20',
          compact ? 'tip h-8 justify-center' : 'min-h-7 px-2.5 py-1',
        )}
        data-testid="activity-line"
        data-state={line.state}
      >
        <Dot state={line.state} />
        {!compact && (
          <span className="truncate" aria-live="polite" data-testid="activity-text">
            {line.text}
            {line.fix && <span className="text-warn"> · {line.fix.text}</span>}
          </span>
        )}
      </button>
      {open && <ActivityPopover onClose={() => setOpen(false)} inline={below} />}
    </div>
  );
}

/** "What Orbit is doing": the live items, today's counts, the problems with their fix. Nothing else. */
export function ActivityPopover({ onClose, inline }: { onClose: () => void; inline?: boolean }) {
  const { user } = useSession();
  const { items, problems } = useActivity();
  const counts = useLiveQuery(() => (user ? activityCounts(user) : undefined), [user?.id]);
  return (
    <div
      role="dialog"
      aria-label="What Orbit is doing"
      className={cx(
        'z-50 w-[280px] rounded-[12px] border border-line bg-canvas p-3 text-[12.5px] shadow-[0_16px_40px_-12px_rgba(0,0,0,0.18)]',
        inline ? 'relative w-full mt-1' : 'absolute bottom-full left-0 mb-1.5 pop-in',
      )}
      data-testid="activity-popover"
    >
      <div className="font-medium text-[13px] mb-1.5">What Orbit is doing</div>
      {items.length === 0 ? (
        <p className="text-ink-3">Nothing right now. Up to date.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2" data-testid="activity-item">
              <Dot state="running" />
              <span>{itemText(a)}</span>
            </li>
          ))}
        </ul>
      )}
      {counts && <Today counts={counts} />}
      {problems.length > 0 && (
        <>
          <div className="label-mono mt-3 mb-1">Problems</div>
          <ul className="space-y-1">
            {problems.map((p) => (
              <li key={p.id} className="flex items-center gap-2" data-testid="activity-problem">
                <Dot state="problem" />
                <span>{p.text}</span>
                <Link
                  to={p.link}
                  onClick={onClose}
                  className="ml-auto shrink-0 underline underline-offset-2 hover:text-ink"
                >
                  {p.fix}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Today({ counts: c }: { counts: ActivityCounts }) {
  const rows: [string, string, string][] = [
    ['profiles', 'LinkedIn profiles read', `${c.profiles} of ${c.profilesOf}`],
    ['searches', 'LinkedIn searches', `${c.searches} of ${c.searchesOf}`],
    ['posts', 'Posts read for routes', String(c.posts)],
    ['photos', 'Photos', String(c.photos)],
    ['logos', 'Logos', String(c.logos)],
    ['replies', 'Replies checked', `${c.repliesChecked} ${c.repliesChecked === 1 ? 'time' : 'times'}`],
    ['notes', 'Meeting notes filed', String(c.notes)],
  ];
  return (
    <>
      <div className="label-mono mt-3 mb-1">Today</div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-ink-2">
        {rows.map(([k, label, value]) => (
          <div key={k} className="contents">
            <dt>{label}</dt>
            <dd className="tabular text-right" data-testid={`activity-count-${k}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-ink-3" data-testid="activity-profiles-filled">
        {c.profilesFilled} {c.profilesFilled === 1 ? 'profile' : 'profiles'} filled in from LinkedIn so far
      </p>
    </>
  );
}
