import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { type ConversationItem, conversationWith } from '../engine/conversation';
import { cx, relDate } from '../ui';

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
 * follow-up is what is being written), as written, with the rest of the conversation one tap away. Nothing for a first
 * message. Real words, not a summary: a reply answers what they actually said.
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
  const recent = sorted.slice(-SHOWN);
  const who = (m: ConversationItem) => (m.out ? 'You' : firstName);
  return (
    <div
      className={cx('rounded-[10px] border border-line-2 bg-canvas-2/70 px-3 py-2.5 text-[13px]', className)}
      data-testid="thread-context"
    >
      {open ? (
        <ol
          className="space-y-2.5 max-h-[320px] overflow-y-auto scroll-thin pr-1"
          data-testid="thread-context-all"
        >
          {recent.map((m) => (
            <li key={m.id} className={cx('flex flex-col', m.out ? 'items-end' : 'items-start')}>
              <span className="text-[11.5px] text-ink-3 mb-0.5">
                {who(m)} · {CHANNEL[m.channel]} · {relDate(m.at)}
              </span>
              <span
                className={cx(
                  'max-w-[92%] whitespace-pre-line rounded-[12px] px-2.5 py-1.5 leading-snug',
                  m.out ? 'bg-accent-soft text-ink' : 'bg-canvas border border-line-2 text-ink-2',
                )}
              >
                {m.text.trim()}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div data-testid="thread-context-last">
          <div className="text-[11.5px] text-ink-3 mb-0.5">
            {last.out ? 'You wrote' : `${firstName} wrote`} · {CHANNEL[last.channel]} · {relDate(last.at)}
          </div>
          <p className="text-ink-2 line-clamp-3 whitespace-pre-line leading-snug">{preview(last.text)}</p>
        </div>
      )}
      {sorted.length > 1 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
          aria-expanded={open}
          data-testid="thread-context-toggle"
        >
          {open ? 'Show less' : `Show conversation (${sorted.length})`}
          <ChevronDown size={12} className={cx('transition-transform', open && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}
