import { ArrowDown, CircleDashed } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActivityLine } from '../../components/ActivityLine';
import { CurrentJobPlan } from '../../components/CurrentJobPlan';
import { NextChatLine } from '../../components/NextChatLine';
import { useSession } from '../../state/session';
import { cx } from '../../ui';
import { chipRows, homeChips } from '../agent/chips';
import { useChatEngine } from '../engineContext';
import { Composer } from './Composer';
import { ConnectStrip, useConnectStripDismissed } from './ConnectStrip';
import { homeStatusLine, useHomeStatus } from './homeStatus';
import { Thread } from './Thread';
import { threadActions, useThread } from './threadStore';

export const DISCLAIMER = 'Orbit can make mistakes. Nothing is sent without your approval.';

/** The chat home: greeting, composer and chips, then the thread once the first message is sent. */
export function ChatHome() {
  const { user } = useSession();
  const engine = useChatEngine();
  const thread = useThread();
  const actions = useMemo(() => threadActions(engine), [engine]);
  const status = useHomeStatus();
  const [stripDismissed, dismissStrip] = useConnectStripDismissed(user?.id);
  // an account with nobody in it gets three starter chips; the full set comes once there are people
  const chips = status.ready ? homeChips(engine.chips(), status.empty) : [];
  // once the strip is dismissed, the line under the greeting stops asking too
  const statusLine = homeStatusLine(stripDismissed ? { ...status, linkedin: true, gmail: true } : status);
  const showStrip =
    status.ready &&
    !status.demo &&
    !stripDismissed &&
    (!status.linkedin || (!status.gmail && status.gmailAvailable !== false));
  const mode = engine.mode();
  const modeNote = engine.modeNote();
  const inConversation = thread.turns.length > 0;
  // coming back to the page: pick up anything the engine stored since (a reply that finished while away)
  useEffect(() => {
    actions.refresh();
  }, [actions]);
  const { scrollRef, onScroll, pinned, jump } = useAutoScroll(thread.turns, thread.running);
  const first = user?.firstName?.trim() || 'there';
  const chipFile = useRef<HTMLInputElement | null>(null);
  const cardActions = useMemo(
    () => ({
      approve: actions.approve.bind(actions),
      cancel: actions.cancel.bind(actions),
      retry: actions.retry.bind(actions),
      send: actions.send,
    }),
    [actions],
  );
  const composer = (size: 'home' | 'thread') => (
    <Composer
      size={size}
      onSend={actions.send}
      onStop={actions.stop}
      onAttach={actions.attach}
      running={thread.running}
      mode={mode}
      modeNote={modeNote}
      autoFocus={!inConversation}
    />
  );
  const footer = (
    <div className="mt-2 text-center text-[12.5px] text-ink-3 space-y-0.5 px-2" data-testid="composer-footer">
      {thread.temporary && (
        <p data-testid="temporary-note">Temporary chat: it is not saved to your history.</p>
      )}
      {mode === 'router' && modeNote && (
        <p data-testid="router-note">
          {firstSentence(modeNote.text)}{' '}
          {modeNote.href && (
            <Link
              to={modeNote.href}
              className="font-medium text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
            >
              Open Settings
            </Link>
          )}
        </p>
      )}
    </div>
  );
  // in a conversation the pill floats over the thread, so on phones it shrinks to its icon
  const temporaryPill = (compact = false) => (
    <button
      type="button"
      className={cx(
        'glass glass-hover h-10 rounded-full inline-flex items-center justify-center gap-2 text-[13.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        compact ? 'w-10 sm:w-auto sm:px-3.5' : 'px-3.5',
        thread.temporary ? 'text-accent' : 'text-ink-2',
      )}
      aria-pressed={thread.temporary}
      onClick={() => actions.setTemporary(!thread.temporary)}
      title={
        thread.temporary
          ? 'Temporary chat on: this chat is not saved'
          : 'Start a chat that is not saved to your history'
      }
      data-testid="temporary-toggle"
    >
      <CircleDashed size={16} aria-hidden />{' '}
      <span className={compact ? 'max-sm:sr-only' : undefined}>Temporary</span>
    </button>
  );
  if (!inConversation)
    return (
      <div className="relative h-full flex flex-col px-4 sm:px-6" data-testid="chat-home">
        <div className="absolute right-4 top-3 sm:right-6 sm:top-4 z-10">{temporaryPill()}</div>
        <div className="flex-[1.25] min-h-[56px]" />
        <div className="w-full max-w-[980px] mx-auto pt-12">
          <h1 className="type-greeting text-center mb-6 sm:mb-7 px-2" data-testid="greeting">
            Hey {first}, what&rsquo;s on your mind today?
          </h1>
          {statusLine && (
            <p
              className="text-center text-[14px] text-ink-3 -mt-3 mb-5 sm:-mt-4 sm:mb-6"
              data-testid="home-status"
            >
              {statusLine}
            </p>
          )}
          <NextChatLine />
          {/* plan 23 §4.1: the job pasted while setting up, planned once the network is in */}
          <CurrentJobPlan networkIn={status.ready && !status.empty && status.linkedin} />
          {/* on a phone the status line has no sidebar: it sits here, quietly (plan 23 §4.7) */}
          <div className="md:hidden flex justify-center -mt-2 mb-3">
            <ActivityLine below className="max-w-[320px]" />
          </div>
          {composer('home')}
          {footer}
          {showStrip && (
            <ConnectStrip
              linkedin={status.linkedin}
              gmail={status.gmail}
              gmailAvailable={status.gmailAvailable !== false}
              onConnect={(what) => void actions.connect(what)}
              onDismiss={dismissStrip}
              disabled={thread.running}
            />
          )}
          <div className="mt-6 sm:mt-8 space-y-2.5" data-testid="chips">
            {chipRows(chips).map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-center sm:gap-2.5"
              >
                {row.map((c, j) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cx(
                      'glass glass-hover type-chip min-h-11 sm:min-h-10 px-3.5 sm:px-4 rounded-full text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 text-center',
                      // an odd chip out fills its row on a phone
                      row.length % 2 === 1 && j === row.length - 1 && 'col-span-2 sm:col-auto',
                    )}
                    onClick={() =>
                      // a chip that needs a file opens the picker; the file then goes in like a "+" attachment
                      c.message
                        ? actions.send(c.message)
                        : c.tool === 'import_linkedin'
                          ? chipFile.current?.click()
                          : actions.runChip(c.id)
                    }
                    disabled={thread.running}
                    data-testid={`chip-${c.id}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <input
            ref={chipFile}
            type="file"
            accept=".csv,.zip,text/csv"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-testid="linkedin-chip-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) actions.attach(f, 'linkedin');
            }}
          />
        </div>
        <div className="flex-1 min-h-[40px]" />
        <p
          className="text-center text-[12.5px] text-ink-3 max-w-[680px] mx-auto pb-5 sm:pb-7"
          data-testid="disclaimer"
        >
          {DISCLAIMER}
        </p>
      </div>
    );
  return (
    <div className="relative h-full flex flex-col" data-testid="chat-thread">
      <div className="absolute right-4 top-3 sm:right-6 sm:top-4 z-20">{temporaryPill(true)}</div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 sm:px-6"
        data-testid="thread-scroll"
      >
        <div className="@container max-w-[760px] mx-auto pt-16 sm:pt-6 pb-44">
          <Thread turns={thread.turns} actions={cardActions} running={thread.running} />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 px-4 sm:px-6 pb-3 sm:pb-5 pt-6 bg-gradient-to-t from-page via-page/95 via-60% to-transparent pointer-events-none">
        <div className="pointer-events-auto max-w-[800px] mx-auto">
          {!pinned && (
            <div className="flex justify-center mb-2">
              <button
                type="button"
                onClick={jump}
                className="glass glass-hover h-9 px-3 rounded-full inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2 fade-up focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                data-testid="jump-latest"
              >
                <ArrowDown size={14} aria-hidden /> Latest
              </button>
            </div>
          )}
          {composer('thread')}
          {footer}
        </div>
      </div>
    </div>
  );
}

/** Keeps the thread scrolled to the newest line while the student stays at the bottom; stops when they scroll up. */
function useAutoScroll(turns: unknown, running: boolean) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const toEnd = () => {
    const el = elRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  };
  // the scroller mounts with the first turn; cards keep growing after their events (an editor sizing itself, a live
  // query landing), so the column's size is watched, not only the turns
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    elRef.current = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(toEnd);
    if (el.firstElementChild) observer.current.observe(el.firstElementChild);
  }, []);
  const lastTop = useRef(0);
  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // content that grows under a pinned thread (a card's live data landing) is not the student scrolling away:
    // only a move up unpins it
    const movedUp = el.scrollTop < lastTop.current - 4;
    lastTop.current = el.scrollTop;
    const next = atBottom || (pinnedRef.current && !movedUp);
    pinnedRef.current = next;
    setPinned(next);
    if (next && !atBottom) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(toEnd, [turns, running]);
  const jump = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedRef.current = true;
    setPinned(true);
  }, []);
  return { scrollRef, onScroll, pinned, jump };
}

/** The mode note's first sentence: the rest (what the commands cover) is in the Templates menu. */
function firstSentence(text: string): string {
  const m = text.match(/^.+?[.?](?=\s|$)/);
  return m ? m[0] : text;
}
