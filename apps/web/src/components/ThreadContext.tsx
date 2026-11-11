import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, MessagesSquare } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type ConversationItem, conversationWith } from '../engine/conversation';
import { cx, relDate } from '../ui';
import { bubbleClass } from './Conversation';

const CHANNEL: Record<ConversationItem['channel'], string> = {
  gmail: 'Email',
  linkedin: 'LinkedIn',
  text: 'Text',
};

/** The most a "Show conversation" opens: the last few messages, enough to remember where things stand. */
const SHOWN = 8;

/** The body of a message for a three-line preview: no greeting line, no blank lines, the words that matter first. */
function preview(text: string): string {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (
    lines.length > 1 &&
    /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^.?!]{0,40}[,!]?$/i.test(lines[0]!)
  )
    lines.shift();
  return lines.join('\n');
}

/**
 * What was said before, above a message being written to someone: their last message (or the student's own, when a
 * follow-up is what is being written) as a chat bubble with its date, nothing else. When there is more, faint edges
 * behind it show a stack; a tap opens the rest of the conversation above it, smoothly, and a tap on Collapse folds it
 * away. Nothing for a first message. Real words, not a summary: a reply answers what they actually said.
 */
export function ThreadContext({
  userId,
  personId,
  firstName,
  className,
}: {
  userId: string;
  personId: string;
  firstName: string;
  className?: string;
}) {
  const items = useLiveQuery(() => conversationWith(userId, personId), [userId, personId]);
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  const last = sorted[sorted.length - 1]!;
  const earlier = sorted.slice(-SHOWN, -1);
  const more = sorted.length > 1;
  const day = (iso: string) => relDate(iso);
  const bubble = (m: ConversationItem, lastOfRun: boolean, extra?: string) => (
    <span
      className={cx(
        bubbleClass(m.out, lastOfRun),
        'max-w-[86%] whitespace-pre-line text-[13.5px] text-left',
        extra,
      )}
    >
      {preview(m.text)}
    </span>
  );
  return (
    <section
      className={cx('text-[13px]', className)}
      data-testid="thread-context"
      aria-label={`Messages with ${firstName}`}
    >
      {/* the earlier messages: folded to nothing, opened with a smooth height and fade */}
      <div
        className={cx(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-ink"
              tabIndex={open ? 0 : -1}
              data-testid="thread-context-collapse"
            >
              Collapse <ChevronDown size={12} className="rotate-180" aria-hidden />
            </button>
          </div>
          <ol
            className="max-h-[260px] overflow-y-auto scroll-thin space-y-0.5 pb-1.5"
            data-testid="thread-context-all"
          >
            {earlier.map((m, i) => (
              <li key={m.id} className={cx('flex flex-col', m.out ? 'items-end' : 'items-start')}>
                {earlier[i - 1]?.out !== m.out && (
                  <span className="mt-1.5 mb-0.5 px-1 text-[11px] text-ink-3">{day(m.at)}</span>
                )}
                {bubble(m, (earlier[i + 1] ?? last).out !== m.out)}
              </li>
            ))}
          </ol>
        </div>
      </div>
      {/* the last message: the bubble alone, with its date; a stack behind it when there is more */}
      <div
        className={cx('flex flex-col', last.out ? 'items-end' : 'items-start')}
        data-testid="thread-context-last"
      >
        <span className="mb-0.5 px-1 text-[11px] text-ink-3">{day(last.at)}</span>
        {more && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="group relative flex max-w-[86%] flex-col items-stretch pb-1.5 text-left"
            aria-expanded={open}
            aria-label={`Show the ${sorted.length} messages with ${firstName}`}
            title="Show the conversation"
            data-testid="thread-context-toggle"
          >
            {/* two faint edges under the bubble: there is more behind it */}
            <span
              aria-hidden
              className={cx(
                'absolute inset-x-3 bottom-0 h-3 rounded-b-[14px] transition-transform group-hover:translate-y-0.5',
                last.out ? 'bg-accent/25' : 'bg-[#ecebe8]/70',
              )}
            />
            <span
              aria-hidden
              className={cx(
                'absolute inset-x-1.5 bottom-[3px] h-3 rounded-b-[16px] transition-transform group-hover:translate-y-px',
                last.out ? 'bg-accent/45' : 'bg-[#e3e1dd]',
              )}
            />
            <span className="relative">
              {bubble(last, true, 'block max-w-full transition group-hover:brightness-[0.97]')}
            </span>
          </button>
        ) : (
          bubble(last, true)
        )}
      </div>
    </section>
  );
}

/**
 * The conversation behind a message being written, out of the way: a small mark with how many messages there are,
 * and the last few as bubbles while the pointer rests on it (or it has focus). Nothing for someone never written to.
 */
export function HistoryPeek({
  userId,
  personId,
  firstName,
}: {
  userId: string;
  personId: string;
  firstName: string;
}) {
  const items = useLiveQuery(() => conversationWith(userId, personId), [userId, personId]);
  const [open, setOpen] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const list = useRef<HTMLOListElement>(null);
  // the newest message is the one that matters: the panel opens at the bottom
  useLayoutEffect(() => {
    if (open && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open]);
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  const recent = sorted.slice(-SHOWN);
  const show = () => {
    clearTimeout(leave.current);
    setOpen(true);
  };
  // a short grace so the pointer can travel from the mark into the panel
  const hide = () => {
    clearTimeout(leave.current);
    leave.current = setTimeout(() => setOpen(false), 160);
  };
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      data-testid="history-peek"
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 h-7 px-1.5 rounded-[6px] text-[12.5px] text-ink-3 hover:text-ink tabular"
        aria-label={`Your ${sorted.length} messages with ${firstName}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="history-peek-mark"
      >
        <MessagesSquare size={14} strokeWidth={1.75} aria-hidden /> {sorted.length}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1.5 w-[min(380px,calc(100vw-32px))] bg-canvas border border-line-2 rounded-[10px] shadow-[0_16px_40px_rgba(20,20,15,0.12)] fade-up"
          role="dialog"
          aria-label={`Messages with ${firstName}`}
          data-testid="history-peek-panel"
        >
          <div className="flex items-baseline justify-between px-3.5 pt-3 pb-2">
            <span className="text-[12.5px] font-medium">With {firstName}</span>
            <span className="text-[11.5px] text-ink-3">
              {sorted.length > recent.length
                ? `Last ${recent.length} of ${sorted.length}`
                : `${sorted.length}`}
            </span>
          </div>
          <ol ref={list} className="max-h-[300px] overflow-y-auto scroll-thin px-3.5 pb-3 space-y-0.5">
            {recent.map((m, i) => (
              <li key={m.id} className={cx('flex flex-col', m.out ? 'items-end' : 'items-start')}>
                {recent[i - 1]?.out !== m.out && (
                  <span className="mt-2 mb-0.5 px-1 text-[11px] text-ink-3">
                    {m.out ? 'You' : firstName} · {CHANNEL[m.channel]} · {relDate(m.at)}
                  </span>
                )}
                <span
                  className={cx(
                    bubbleClass(m.out, recent[i + 1]?.out !== m.out),
                    'max-w-[88%] whitespace-pre-line text-[13px] !py-1.5',
                  )}
                >
                  {preview(m.text)}
                </span>
              </li>
            ))}
          </ol>
          <Link
            to={`/people/${personId}?tab=conversation`}
            className="block border-t border-line-2 px-3.5 py-2 text-[12.5px] text-ink-2 hover:text-ink"
          >
            Open all messages
          </Link>
        </div>
      )}
    </span>
  );
}
