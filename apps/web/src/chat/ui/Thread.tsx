import {
  Check,
  ChevronDown,
  Copy,
  Globe,
  ListChecks,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
} from 'lucide-react';
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

/** Cards the student acts on or came for: never folded away, however much work came before them. */
const OUTCOME_KINDS = new Set([
  'needs_confirmation',
  'choices',
  'setup',
  'draft',
  'drafts',
  'plan',
  'prep',
  'import',
]);
/** A turn that looked this many things up reads as work, then an answer: the lookups fold into one line. */
export const WORK_FOLD_AT = 3;

export type TurnPiece =
  | { type: 'block'; b: Block; i: number }
  /** the folded lookups, with the words said between them, in order */
  | { type: 'work'; items: { b: Block; i: number }[] };

/**
 * How a turn reads. A quick answer (a card or two) shows as it came. A turn that looked many things up (a search
 * across the network, several reads) is work, then an answer: the lookups, the reasoning notes and the words said
 * between them fold into one quiet line where the work began, and what stays out is the answer (the words after the
 * last lookup), the cards to act on (a draft, an approval, choices, a setup) and the web's sources.
 */
export function turnLayout(blocks: Block[]): TurnPiece[] {
  const ordered = inReadingOrder(blocks);
  const isLookup = (b: Block) =>
    b.type === 'tool' && b.status !== 'pending' && !(b.envelope && OUTCOME_KINDS.has(b.envelope.kind));
  const lookups = ordered.filter(({ b }) => isLookup(b)).length;
  if (lookups < WORK_FOLD_AT) return ordered.map(({ b, i }) => ({ type: 'block', b, i }));
  let lastTool = -1;
  blocks.forEach((b, i) => {
    if (b.type === 'tool' || b.type === 'web') lastTool = i;
  });
  const isWork = ({ b, i }: { b: Block; i: number }) =>
    isLookup(b) || b.type === 'progress' || (b.type === 'text' && i < lastTool);
  const out: TurnPiece[] = [];
  let work: { type: 'work'; items: { b: Block; i: number }[] } | undefined;
  for (const x of ordered) {
    if (!isWork(x)) {
      out.push({ type: 'block', b: x.b, i: x.i });
      continue;
    }
    if (!work) {
      work = { type: 'work', items: [] };
      out.push(work);
    }
    work.items.push(x);
  }
  return out;
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
  const folded = turnLayout(turn.blocks).some((p) => p.type === 'work');
  const waiting =
    streaming &&
    !folded &&
    (!lastBlock ||
      lastBlock.type === 'progress' ||
      (lastBlock.type === 'tool' && lastBlock.status === 'running'));
  return (
    <div className="group min-w-0" data-testid="turn-assistant" data-status={turn.status}>
      <div aria-live="polite" aria-busy={streaming}>
        <ChoicesContext.Provider value={{ running, laterUserText }}>
          {turnLayout(turn.blocks).map((piece) =>
            piece.type === 'work' ? (
              <WorkLog
                key={`work-${piece.items[0]!.i}`}
                items={piece.items}
                live={streaming}
                showReasoning={showReasoning}
                actions={actions}
              />
            ) : (
              <BlockView
                key={blockKey(piece.b, piece.i)}
                b={piece.b}
                i={piece.i}
                last={turn.blocks.length - 1}
                streaming={streaming}
                showReasoning={showReasoning}
                actions={actions}
              />
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

const blockKey = (b: Block, i: number) =>
  b.type === 'tool' ? b.toolUseId : b.type === 'web' ? b.id : `b${i}`;

/** One block of a turn as it reads in the thread. */
function BlockView({
  b,
  i,
  last,
  streaming,
  showReasoning,
  actions,
}: {
  b: Block;
  i: number;
  last: number;
  streaming: boolean;
  showReasoning: boolean;
  actions: CardActions;
}) {
  if (b.type === 'text') return <Markdown text={b.text} />;
  if (b.type === 'progress')
    return showReasoning ? <ProgressLine text={b.text} live={streaming && i === last} /> : null;
  if (b.type === 'web') return <WebSearchLine block={b} live={streaming} />;
  // a playbook lookup is the assistant reading its own notes: one quiet line, the answer follows in words
  if (QUIET_TOOLS.has(b.toolName) && b.status !== 'pending' && b.envelope?.kind !== 'error')
    return <ProgressLine text="Checked the playbook" live={false} />;
  return <ToolView block={b} actions={actions} />;
}

/** Read tools whose result is for the assistant, not the student: shown as a line, never a card. */
const QUIET_TOOLS = new Set(['lookup_playbook']);

/** What one folded step says in a line: the tool's own summary, its running label, or the words themselves. */
function stepText(b: Block): string {
  if (b.type === 'tool') return b.envelope?.summary?.trim() || b.progress || humanTool(b.toolName);
  if (b.type === 'text' || b.type === 'progress') return b.text.trim();
  return '';
}

/**
 * The work of a turn, folded: while it runs, one line with the step under way; after, "Looked through N things" with
 * the first few in brief, opening to every card and note in the order they came. The answer stays outside it.
 */
function WorkLog({
  items,
  live,
  showReasoning,
  actions,
}: {
  items: { b: Block; i: number }[];
  live: boolean;
  showReasoning: boolean;
  actions: CardActions;
}) {
  const [open, setOpen] = useState(false);
  const tools = items.filter(({ b }) => b.type === 'tool');
  const steps = tools.map(({ b }) => stepText(b)).filter(Boolean);
  const backwards = [...items].reverse();
  const running = backwards.find(({ b }) => b.type === 'tool' && b.status === 'running');
  const latest = running ?? backwards.find(({ b }) => b.type === 'tool' || b.type === 'text');
  const now = latest ? stepText(latest.b) : '';
  const label = live
    ? 'Working on it'
    : `Looked through ${tools.length} ${tools.length === 1 ? 'thing' : 'things'}`;
  return (
    <div className="my-2" data-testid="work-log" data-open={open || undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group/work flex w-full min-w-0 items-center gap-2 rounded-[12px] border border-line bg-canvas px-3 py-2 text-left text-[13px] shadow-[var(--shadow-pill)] hover:bg-canvas-2"
        data-testid="work-log-toggle"
      >
        <ListChecks
          size={15}
          className={cx('shrink-0', live ? 'text-accent animate-pulse' : 'text-ink-3')}
          aria-hidden
        />
        <span className="shrink-0 font-medium text-ink">{label}</span>
        <span
          className={cx('min-w-0 flex-1 truncate text-ink-3', live && 'shimmer')}
          data-testid="work-log-now"
        >
          {live ? now : steps.slice(0, 3).join(' · ')}
        </span>
        <ChevronDown
          size={15}
          className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div className="mt-2 border-l-2 border-line-2 pl-3" data-testid="work-log-items">
          {items.map(({ b, i }) =>
            b.type === 'text' ? (
              <p key={`t${i}`} className="my-1.5 text-[13px] text-ink-3">
                {b.text.trim()}
              </p>
            ) : b.type === 'progress' ? (
              showReasoning ? (
                <ProgressLine key={`p${i}`} text={b.text} live={false} />
              ) : null
            ) : b.type === 'tool' ? (
              <ToolView key={b.toolUseId} block={b} actions={actions} />
            ) : null,
          )}
        </div>
      )}
    </div>
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
