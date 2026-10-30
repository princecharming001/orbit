import { Check, Copy, Globe, RefreshCw, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { copyText } from '../../components/approve';
import { isStaleChunk } from '../../components/ErrorBoundary';
import { useShowReasoning } from '../../state/showReasoning';
import { cx, useToast } from '../../ui';
import { ChoicesContext } from './cards/Choices';
import { DraftOwnersContext } from './cards/parts';
import { type CardActions, editingDraftId, ResultCard } from './cards/ResultCard';
import { Markdown } from './Markdown';
import type { AssistantTurn, Block, ErrorKind, ToolBlock, Turn, WebBlock } from './threadStore';

export interface ThreadActions extends CardActions {
  retry: (turnId: string) => void;
}

/** The thread: a Today divider, user bubbles on the right, assistant text and cards on the left. */
export function Thread({
  turns,
  actions,
  running,
}: {
  turns: Turn[];
  actions: ThreadActions;
  running: boolean;
}) {
  // each draft's editor lives in the newest card that shows it; older cards for the same draft fold to a line
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of turns)
      if (t.role === 'assistant')
        for (const b of t.blocks)
          if (b.type === 'tool') {
            const id = editingDraftId(b);
            if (id) m.set(id, b.toolUseId);
          }
    return m;
  }, [turns]);
  return (
    <DraftOwnersContext.Provider value={owners}>
      <div className="type-body" data-testid="thread">
        <ol className="space-y-4">
          {turns.map((t, i) => (
            <li key={t.id} className="min-w-0">
              {/* the day each part of the chat is from: a chat opened days later says so, instead of "Today" */}
              {(i === 0 || dayLabel(turns[i - 1]!.at) !== dayLabel(t.at)) && (
                <div
                  className={cx(
                    'flex items-center gap-3 text-[13px] font-semibold text-ink-2 mb-4',
                    i > 0 && 'mt-8',
                  )}
                  data-testid="thread-day"
                >
                  {dayLabel(t.at)} <span className="flex-1 h-px bg-line" aria-hidden />
                </div>
              )}
              {t.role === 'user' ? (
                <div className="flex justify-end">
                  <div
                    className="max-w-[85%] rounded-[20px] rounded-br-[8px] px-4 py-2.5 whitespace-pre-wrap break-words bg-[rgba(14,20,36,0.06)]"
                    data-testid="turn-user"
                  >
                    {t.text}
                  </div>
                </div>
              ) : t.role === 'assistant' ? (
                <Assistant
                  turn={t}
                  actions={actions}
                  running={running}
                  last={i === turns.length - 1}
                  laterUserText={turns.slice(i + 1).find((x) => x.role === 'user')?.text}
                />
              ) : (
                <div
                  className={cx(
                    'flex items-center justify-center gap-1.5 text-[12.5px] text-ink-3 py-1',
                    t.role === 'note' && 'text-bad',
                  )}
                  data-testid={`turn-${t.role}`}
                >
                  {t.role === 'decision' ? (
                    <Check size={13} aria-hidden />
                  ) : (
                    <TriangleAlert size={13} aria-hidden />
                  )}{' '}
                  {t.text}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </DraftOwnersContext.Provider>
  );
}

/**
 * A turn's blocks as they read: everything in the order it came, then the reply chips. The model often offers the
 * chips before it writes its last words; the chips are what to say next, so they always close the answer.
 */
export function inReadingOrder(blocks: Block[]): { b: Block; i: number }[] {
  const all = blocks.map((b, i) => ({ b, i }));
  const chips = ({ b }: { b: Block }) => b.type === 'tool' && b.envelope?.kind === 'choices';
  return [...all.filter((x) => !chips(x)), ...all.filter(chips)];
}

/** "Today", "Yesterday", "Monday, Oct 26", with the year once it is not this one: the day a part of a chat is from. */
export function dayLabel(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'Today';
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key(d) === key(now)) return 'Today';
  if (key(d) === key(yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function humanTool(name: string): string {
  const s = name.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Assistant({
  turn,
  actions,
  running,
  last,
  laterUserText,
}: {
  turn: AssistantTurn;
  actions: ThreadActions;
  running: boolean;
  /** the newest turn keeps its action row in view; older ones show it on hover or focus */
  last: boolean;
  /** the first thing the student said after this turn: tap-to-answer choices stop once there is one */
  laterUserText?: string;
}) {
  const toast = useToast();
  const [vote, setVote] = useState<'up' | 'down'>();
  // the model's notes to itself before each step stay out of the thread unless the student turned them on
  const showReasoning = useShowReasoning();
  const streaming = turn.status === 'streaming' && running;
  const text = turn.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const lastBlock = turn.blocks[turn.blocks.length - 1];
  const waiting =
    streaming &&
    (!lastBlock ||
      lastBlock.type === 'progress' ||
      (lastBlock.type === 'tool' && lastBlock.status === 'running'));
  return (
    <div className="group min-w-0" data-testid="turn-assistant" data-status={turn.status}>
      <div aria-live="polite" aria-busy={streaming}>
        <ChoicesContext.Provider value={{ running, laterUserText }}>
          {inReadingOrder(turn.blocks).map(({ b, i }) =>
            b.type === 'text' ? (
              <Markdown key={i} text={b.text} />
            ) : b.type === 'progress' ? (
              showReasoning ? (
                <ProgressLine key={i} text={b.text} live={streaming && i === turn.blocks.length - 1} />
              ) : null
            ) : b.type === 'web' ? (
              <WebSearchLine key={b.id} block={b} live={streaming} />
            ) : (
              <ToolView key={b.toolUseId} block={b} actions={actions} />
            ),
          )}
        </ChoicesContext.Provider>
        {waiting && (
          <div className="flex items-center gap-1 h-6 text-ink-3" role="status" aria-label="Working">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-pulse [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-pulse [animation-delay:300ms]" />
          </div>
        )}
      </div>
      {turn.status === 'stopped' && (
        <p className="text-[12.5px] text-ink-3 mt-1" data-testid="turn-stopped">
          Stopped. What came through is kept.
        </p>
      )}
      {turn.status === 'error' && turn.error && (
        <ErrorLine kind={turn.error.kind} message={turn.error.message} />
      )}
      {!streaming && (
        <div
          className={cx(
            'mt-1 -ml-1.5 flex items-center gap-0.5 transition-opacity',
            !last && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
          data-testid="turn-actions"
        >
          <IconButton
            label="Copy"
            onClick={async () =>
              toast.push({
                text: (await copyText(
                  text || turn.blocks.map((b) => (b.type === 'tool' ? b.envelope?.summary : '')).join(' '),
                ))
                  ? 'Copied.'
                  : 'Select the text and copy it.',
              })
            }
          >
            <Copy size={14} aria-hidden />
          </IconButton>
          <IconButton label="Retry" onClick={() => actions.retry(turn.id)} disabled={running}>
            <RefreshCw size={14} aria-hidden />
          </IconButton>
          <IconButton
            label="Good answer"
            pressed={vote === 'up'}
            onClick={() => setVote((v) => (v === 'up' ? undefined : 'up'))}
          >
            <ThumbsUp size={14} aria-hidden />
          </IconButton>
          <IconButton
            label="Bad answer"
            pressed={vote === 'down'}
            onClick={() => setVote((v) => (v === 'down' ? undefined : 'down'))}
          >
            <ThumbsDown size={14} aria-hidden />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        'w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
        pressed && 'text-ink bg-canvas-2',
      )}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function ProgressLine({ text, live }: { text: string; live: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-ink-3 my-1" data-testid="progress-line">
      <span
        className={cx('w-1.5 h-1.5 rounded-full shrink-0', live ? 'bg-accent animate-pulse' : 'bg-line')}
      />
      <span className={live ? 'shimmer' : undefined}>{text}</span>
    </div>
  );
}

/** The host of a link, without "www.", for a source chip. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const SOURCES_SHOWN = 4;

/**
 * Claude searched the web: the query while it runs, then what it found as small links to the pages, so the student
 * can check where an answer came from. A few at first, the rest a tap away.
 */
function WebSearchLine({ block, live }: { block: WebBlock; live: boolean }) {
  const [all, setAll] = useState(false);
  const q = block.query ? `“${block.query}”` : '';
  const searching = block.status === 'searching';
  const shown = all ? block.sources : block.sources.slice(0, SOURCES_SHOWN);
  return (
    <div className="my-2" data-testid="web-search" data-status={block.status}>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <Globe
          size={13}
          className={cx('shrink-0', searching && live && 'text-accent animate-pulse')}
          aria-hidden
        />
        <span className={cx('min-w-0 truncate', searching && live && 'shimmer')}>
          {block.status === 'failed'
            ? `The web search${q ? ` for ${q}` : ''} did not go through`
            : searching
              ? `Searching the web${q ? ` for ${q}` : ''}…`
              : `Searched the web${q ? ` for ${q}` : ''}`}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid="web-sources">
          {shown.map((s) => (
            <li key={s.url} className="max-w-[260px] min-w-0">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="flex items-center gap-1.5 h-7 rounded-full border border-line bg-canvas px-2.5 text-[12px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
                data-testid="web-source"
              >
                <span className="font-medium text-ink truncate">{hostOf(s.url)}</span>
                <span className="truncate text-ink-3">{s.title === s.url ? '' : s.title}</span>
              </a>
            </li>
          ))}
          {!all && block.sources.length > SOURCES_SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="h-7 rounded-full px-2.5 text-[12px] text-ink-3 hover:bg-canvas-2 hover:text-ink"
              >
                {block.sources.length - SOURCES_SHOWN} more
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** A tool while it runs: a status card with the running label; once the envelope arrives, the result card. */
function ToolView({ block, actions }: { block: ToolBlock; actions: CardActions }) {
  if (block.status === 'running' || !block.envelope)
    return (
      <div
        className="glass glass-strong rounded-[16px] px-4 py-3 my-2 max-w-[520px]"
        data-testid="tool-status"
        role="status"
      >
        <div className="shimmer text-[15px] font-medium">{block.progress ?? humanTool(block.toolName)}</div>
        <div className="text-[13px] text-ink-3 mt-0.5">{humanTool(block.toolName)}</div>
      </div>
    );
  return <ResultCard block={block} actions={actions} />;
}

const ERROR_COPY: Record<ErrorKind, { title: string; link?: { to: string; label: string } }> = {
  no_key: {
    title: 'This needs a Claude key.',
    link: { to: '/settings/integrations', label: 'Add one in Settings' },
  },
  cap: {
    title: 'Today’s Claude budget is used up.',
    link: { to: '/settings/limits', label: 'See your limits' },
  },
  refusal: { title: 'Claude declined this one.' },
  network: { title: 'Orbit could not reach Claude.' },
  aborted: { title: 'Stopped.' },
  other: { title: 'Something went wrong.' },
};

function ErrorLine({ kind, message }: { kind: ErrorKind; message: string }) {
  // a part of the chat this tab had not loaded yet was replaced by a deploy: the fix is a reload, said plainly
  if (isStaleChunk(message))
    return (
      <div
        className="glass glass-strong rounded-[16px] px-4 py-3 my-2 text-[13.5px] flex flex-wrap items-center gap-x-3 gap-y-2"
        role="alert"
        data-testid="turn-error"
        data-kind="updated"
      >
        <RefreshCw size={15} className="text-ink-2 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Orbit was just updated.</span>{' '}
          <span className="text-ink-2">Reload to get the new version, then ask again.</span>
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-white hover:bg-ink/90"
          data-testid="turn-error-reload"
        >
          Reload
        </button>
      </div>
    );
  const c = ERROR_COPY[kind];
  return (
    <div
      className="glass glass-strong rounded-[16px] px-4 py-3 my-2 border-bad/30 text-[13.5px] flex items-start gap-2"
      role="alert"
      data-testid="turn-error"
      data-kind={kind}
    >
      <TriangleAlert size={16} className="text-bad shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0">
        <span className="font-medium">{c.title}</span> <span className="text-ink-2">{message}</span>
        {c.link && (
          <>
            {' '}
            <Link
              to={c.link.to}
              className="font-medium text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
            >
              {c.link.label}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
