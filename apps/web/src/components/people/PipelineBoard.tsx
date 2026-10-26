import type { ChatStage, CoffeeChat, Person, Suggestion } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, STAGE_HELP, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { Avatar, cx, relDate, Skeleton } from '../../ui';
import { LogoText } from '../CompanyLogo';
import { chatTimeLabel } from '../ScheduleChat';
import { KIND_LABEL } from '../SuggestionCard';
import { daysLabel, STAGE_COLOR, wentQuiet } from './shared';

export type ChatRow = { chat: CoffeeChat; person: Person };

/** A card being dragged: it follows the pointer, and the column under it lights up. */
type Drag = {
  row: ChatRow;
  x: number;
  y: number;
  /** where on the card it was picked up, so it does not jump under the pointer */
  dx: number;
  dy: number;
  width: number;
  over?: ChatStage;
  /** the drag has begun (the pointer moved far enough); before that a press is still a click */
  live: boolean;
};

/** A press becomes a drag once the pointer moves this far, so a click still opens the person. */
const DRAG_START_PX = 6;

/**
 * Dragging cards between columns with the mouse or a pen. Touch keeps the Move to menu: a finger drag scrolls.
 * Dropping on another column moves the chat there (with the usual undo); the board scrolls sideways near its edges.
 */
function useCardDrag(move: (chat: CoffeeChat, to: ChatStage) => void) {
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag | undefined>(undefined);
  dragRef.current = drag;
  /** set after a drag, so the click that ends it does not open the person */
  const justDragged = useRef(false);
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const live = d.live || Math.hypot(e.clientX - (d.x + d.dx), e.clientY - (d.y + d.dy)) > DRAG_START_PX;
      if (!live) return;
      e.preventDefault();
      const col = document
        .elementsFromPoint(e.clientX, e.clientY)
        .map((el) => (el as HTMLElement).closest<HTMLElement>('[data-stage]'))
        .find(Boolean);
      // near the board's sides, it scrolls to the stages off screen
      const board = document.querySelector<HTMLElement>('[data-testid="pipeline-board"]');
      if (board) {
        const r = board.getBoundingClientRect();
        if (e.clientX > r.right - 48) board.scrollBy({ left: 18 });
        else if (e.clientX < r.left + 48) board.scrollBy({ left: -18 });
      }
      setDrag({
        ...d,
        live: true,
        x: e.clientX - d.dx,
        y: e.clientY - d.dy,
        over: (col?.dataset.stage as ChatStage | undefined) ?? undefined,
      });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(undefined);
      if (!d?.live) return;
      justDragged.current = true;
      setTimeout(() => {
        justDragged.current = false;
      }, 0);
      document.body.style.cursor = '';
      if (d.over && d.over !== d.row.chat.stage) move(d.row.chat, d.over);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [!!drag, move]);
  useEffect(() => {
    document.body.style.cursor = drag?.live ? 'grabbing' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [drag?.live]);
  const start = (e: ReactPointerEvent<HTMLElement>, row: ChatRow) => {
    // a finger scrolls; buttons, the Move to menu and links inside the card keep their own clicks
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('select, button, [data-testid="chat-next"]')) return;
    const r = e.currentTarget.getBoundingClientRect();
    setDrag({
      row,
      x: r.left,
      y: r.top,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      width: r.width,
      live: false,
    });
  };
  return { drag, start, justDragged };
}

/**
 * The board: one column per stage, a card per chat. Drag a card to another column, or use its Move to menu. On a
 * narrow box the stages stack, and the empty ones are named in one line above them instead of taking room.
 */
export function PipelineBoard({
  rows,
  stages,
  filtering,
  narrow,
  nextFor,
  meetingFor,
  move,
  setTime,
}: {
  rows: ChatRow[];
  stages: ChatStage[];
  /** a search or filter is on: only the stages that hold a match are shown */
  filtering: boolean;
  narrow: boolean;
  nextFor: (chatId: string, personId: string) => Suggestion | undefined;
  meetingFor: (chat: CoffeeChat) => { startAt: string } | undefined;
  move: (chat: CoffeeChat, to: ChatStage) => void;
  setTime: (chat: CoffeeChat) => void;
}) {
  const { drag, start, justDragged } = useCardDrag(move);
  const dragging = drag?.live ? drag : undefined;
  return (
    <>
      {narrow && !filtering && (
        <p className="text-[12px] text-ink-3 mb-2" data-testid="board-empty-stages">
          {(() => {
            const empty = stages.filter((st) => !rows.some((r) => r.chat.stage === st));
            return empty.length ? `Nobody in: ${empty.map((st) => STAGE_LABELS[st]).join(', ')}.` : '';
          })()}
        </p>
      )}
      {rows.length > 0 && (
        <Board count={stages.length}>
          {stages.map((stage) => {
            const items = rows.filter((r) => r.chat.stage === stage);
            // with a filter on, only the stages that hold a match; on a phone, empty stages are listed in one line
            if (!items.length && (filtering || narrow)) return null;
            return (
              <div
                key={stage}
                // an empty stage takes less room, so the stages that hold someone fit on screen
                // a stage with people grows to share the board's width, so a wide screen shows every stage at once;
                // never narrower than a card's name and foot line need (the board scrolls sideways instead)
                className={cx(
                  'w-full',
                  items.length
                    ? '@3xl:flex-1 @3xl:min-w-[224px] @3xl:max-w-[320px]'
                    : '@3xl:w-[108px] @3xl:shrink-0',
                )}
                data-stage={stage}
                data-needs={items.filter((r) => nextFor(r.chat.id, r.person.id)).length || undefined}
              >
                <div className="flex items-center gap-2 mb-2 px-1" title={STAGE_HELP[stage]}>
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: STAGE_COLOR[stage] }}
                  />
                  <span
                    className={cx(
                      'text-[13px] font-medium',
                      items.length ? 'whitespace-nowrap' : 'leading-tight',
                    )}
                  >
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className="text-[12px] text-ink-3 tabular">{items.length}</span>
                </div>
                <div
                  className={cx(
                    'space-y-2 min-h-[80px] rounded-[12px] p-2 transition-colors',
                    dragging && dragging.over === stage && dragging.row.chat.stage !== stage
                      ? 'bg-accent-soft ring-2 ring-accent/50'
                      : 'bg-canvas-2/70',
                  )}
                  data-testid={`board-column-${stage}`}
                >
                  {items.map(({ chat, person }) => (
                    <BoardCard
                      key={chat.id}
                      chat={chat}
                      person={person}
                      lifted={dragging?.row.chat.id === chat.id}
                      onPointerDown={(e) => start(e, { chat, person })}
                      onClickCapture={(e) => {
                        if (!justDragged.current) return;
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      next={nextFor(chat.id, person.id)}
                      meetingAt={meetingFor(chat)?.startAt}
                      move={move}
                      setTime={setTime}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </Board>
      )}
      {dragging &&
        // the card in the hand: a light copy that follows the pointer, over everything (a portal, so no transformed
        // parent can clip it while it is between columns)
        createPortal(
          <div
            className="pointer-events-none fixed left-0 top-0 z-[100] rounded-[10px] border border-line bg-canvas p-3 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.28)] will-change-transform"
            style={{
              width: dragging.width,
              transform: `translate3d(${dragging.x}px, ${dragging.y}px, 0) rotate(1.5deg)`,
            }}
            aria-hidden
            data-testid="board-drag-ghost"
          >
            <div className="flex items-center gap-2">
              <Avatar
                name={dragging.row.person.displayName}
                src={dragging.row.person.photoUrl}
                id={dragging.row.person.id}
                size={28}
              />
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium">{dragging.row.person.displayName}</div>
                {dragging.over && dragging.over !== dragging.row.chat.stage && (
                  <div className="text-[12px] text-accent">Move to {STAGE_LABELS[dragging.over]}</div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The board while the chats load: the real stage columns with their names, and soft placeholder cards in the first
 * few, so a moment of loading never reads as an empty pipeline.
 */
export function BoardSkeleton() {
  const cards = [2, 2, 1, 1, 0, 0];
  return (
    <div
      className="flex flex-col @3xl:flex-row gap-3 loading-in"
      role="status"
      aria-busy="true"
      aria-label="Loading your chats"
      data-testid="board-loading"
    >
      {ACTIVE_STAGES.map((stage, i) => (
        <div key={stage} className="w-full @3xl:flex-1 @3xl:min-w-[200px] @3xl:max-w-[320px]">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STAGE_COLOR[stage] }} />
            <span className="text-[13px] font-medium whitespace-nowrap text-ink-3">
              {STAGE_LABELS[stage]}
            </span>
          </div>
          <div className="space-y-2 min-h-[80px] rounded-[12px] p-2 bg-canvas-2/70">
            {Array.from({ length: cards[i] ?? 0 }, (_, j) => (
              <div
                key={j}
                className="rounded-[10px] bg-canvas border border-line p-3 flex items-center gap-2.5"
              >
                <Skeleton className="w-7 h-7 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-2.5" style={{ width: j ? '50%' : '64%' }} />
                  <Skeleton className="h-2 w-2/5" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BoardCard({
  chat,
  person,
  next,
  meetingAt,
  move,
  setTime,
  lifted,
  onPointerDown,
  onClickCapture,
}: {
  chat: CoffeeChat;
  person: Person;
  /** this card is being dragged: its place stays, faded */
  lifted?: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (e: React.MouseEvent) => void;
  next?: Suggestion;
  meetingAt?: string;
  move: (chat: CoffeeChat, to: ChatStage) => void;
  setTime: (chat: CoffeeChat) => void;
}) {
  const stage = chat.stage;
  return (
    <div
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
      // the browser's own drag of the name link would fight the card's drag
      onDragStart={(e) => e.preventDefault()}
      title="Drag to another stage"
      // pops in on mount, so a card moved to another stage lands visibly in its new column
      className={cx(
        'group pop-in relative bg-canvas border border-line rounded-[10px] p-3 cursor-grab select-none hover:shadow-[var(--shadow-card)] focus-within:ring-2 focus-within:ring-accent/40 transition-[box-shadow,opacity]',
        lifted && 'opacity-40',
      )}
      data-testid={`chat-card-${stage}`}
    >
      <div className="flex items-center gap-2">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={28} />
        {/* room for the corner menu on the name's line only; the title line below runs to the edge */}
        <div className="min-w-0 flex-1">
          {/* The name link stretches over the whole card, so the card is one tab stop and opens on Enter. */}
          <Link
            to={`/people/${person.id}`}
            // a long name takes a second line rather than being cut to a first name and a letter
            className="block pr-6 text-[13.5px] font-medium leading-snug line-clamp-2 break-words focus:outline-none after:absolute after:inset-0 after:content-['']"
          >
            {person.displayName}
          </Link>
          {(person.currentTitle || person.currentOrganizationRaw) && (
            // one meta line, like a Linear card: the company is the part that matters, so it comes first
            <div
              className="text-[12px] text-ink-3"
              title={[person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' · ')}
            >
              <LogoText person={person} size={13} wrap>
                <span className="line-clamp-2 break-words">
                  {person.currentTitle ?? person.currentOrganizationRaw}
                </span>
              </LogoText>
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px] text-ink-3">
        <CardWhen chat={chat} meetingAt={meetingAt} onSetTime={() => setTime(chat)} />
        {next && <NextLink s={next} />}
      </div>
      {chat.warmUp && stage === 'warming' && (
        <div className="mt-2 text-[11px] text-ink-3">
          Warm-up: {chat.warmUp.actions.filter((a) => a.doneAt || a.skippedAt).length} of{' '}
          {chat.warmUp.actions.length} steps
        </div>
      )}
      {chat.warmUp && stage === 'warming' && (
        <div className="mt-1 h-1 rounded bg-line" aria-hidden>
          <div
            className="h-1 rounded bg-warn"
            style={{
              width: `${(chat.warmUp.actions.filter((a) => a.doneAt).length / chat.warmUp.actions.length) * 100}%`,
            }}
          />
        </div>
      )}
      {/* Move to: a quiet menu in the corner, shown on hover (always on touch); dragging the card does the same */}
      <div className="absolute top-2 right-2 z-10 h-7 w-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink focus-within:ring-2 focus-within:ring-accent/40 @3xl:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <MoreHorizontal size={16} className="absolute inset-0 m-auto pointer-events-none" aria-hidden />
        <select
          value=""
          onChange={(e) => e.target.value && move(chat, e.target.value as ChatStage)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={`Move ${person.displayName} to another stage`}
          title="Move to another stage"
          data-testid="chat-card-move"
        >
          <option value="" disabled>
            Move to…
          </option>
          {[...ACTIVE_STAGES, ...CLOSED_STAGES]
            .filter((s) => s !== chat.stage)
            .map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

/** The board scrolls sideways; a fade and a "More stages" button say so while columns are still hidden. */
function Board({ children, count }: { children: React.ReactNode; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(0);
  // cards with a next step in the stages off to the right: the board says so, so nothing that needs you hides there
  const [needs, setNeeds] = useState<{ count: number; first?: HTMLElement }>({ count: 0 });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const cols = [...el.querySelectorAll<HTMLElement>('[data-stage]')];
    const right = el.scrollLeft + el.clientWidth;
    const hidden = cols.filter((c) => c.offsetLeft + c.offsetWidth / 2 > right);
    setMore(hidden.length);
    const withNeeds = hidden.filter((c) => Number(c.dataset.needs ?? 0) > 0);
    const count = withNeeds.reduce((n, c) => n + Number(c.dataset.needs), 0);
    setNeeds((cur) =>
      cur.count === count && cur.first === withNeeds[0] ? cur : { count, first: withNeeds[0] },
    );
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  return (
    <div className="relative">
      {/* above the columns, never on top of a card; on a phone the stages stack, so there is nothing to scroll to */}
      <div className="hidden @3xl:flex justify-end items-center gap-2 h-8 -mt-2 mb-1">
        {needs.count > 0 && needs.first && (
          <button
            onClick={() => {
              const el = ref.current;
              const col = needs.first;
              if (el && col) el.scrollTo({ left: col.offsetLeft - el.offsetLeft, behavior: 'smooth' });
            }}
            className="h-8 px-2 rounded-md text-accent text-[12px] font-medium inline-flex items-center gap-0.5 hover:bg-accent-soft"
            data-testid="board-needs"
          >
            {needs.count} next step{needs.count === 1 ? '' : 's'} off to the right <ChevronRight size={14} />
          </button>
        )}
        {more > 0 && (
          <button
            onClick={() => ref.current?.scrollBy({ left: 480, behavior: 'smooth' })}
            className="h-8 px-2 rounded-md text-[12px] text-ink-3 inline-flex items-center gap-0.5 hover:text-ink hover:bg-canvas-2"
            data-testid="board-more"
          >
            {more} more stage{more === 1 ? '' : 's'} <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div
        ref={ref}
        onScroll={measure}
        data-testid="pipeline-board"
        className="stagger flex flex-col @3xl:flex-row gap-4 @3xl:gap-3 @3xl:overflow-x-auto pb-4 scroll-thin @3xl:items-start"
        role="region"
        aria-label={`Board, ${count} stages`}
      >
        {children}
      </div>
      {more > 0 && (
        <div className="hidden @3xl:block pointer-events-none absolute top-9 right-0 bottom-4 w-16 bg-gradient-to-l from-page to-transparent" />
      )}
    </div>
  );
}

/** The next step for a chat. It looks like a chip and is a link: it opens that card in Drafts. */
export function NextLink({ s }: { s: Suggestion }) {
  return (
    <Link
      to={`/inbox?card=${s.id}`}
      className="relative z-10 inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent px-2 h-6 text-[12px] font-medium whitespace-nowrap hover:bg-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title="Open this in Drafts"
      data-testid="chat-next"
    >
      {KIND_LABEL[s.kind].label}
    </Link>
  );
}

/** "Sending in 8s…" or "Sending…" while an approved message of this chat waits in the outbox; a clock keeps it true. */
function useSending(chatId: string): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  const queued = useLiveQuery(
    () =>
      db.outbound
        .where('chatId')
        .equals(chatId)
        .filter((o) => o.status === 'queued' || o.status === 'sending')
        .first(),
    [chatId],
  );
  useEffect(() => {
    if (!queued) return;
    // a countdown on screen: nothing to redraw while the tab is hidden
    const t = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [queued]);
  if (!queued) return undefined;
  if (queued.autopilot) return undefined;
  const left = queued.sendAt ? Math.ceil((new Date(queued.sendAt).getTime() - now) / 1000) : 0;
  return left > 0 ? `Sending in ${left}s…` : 'Sending…';
}

/**
 * The line at the foot of a board card: when a booked chat is (or a button to set it), who went quiet and since when
 * (the same words as Drafts), otherwise how long the card has sat in its stage.
 */
function CardWhen({
  chat,
  meetingAt,
  onSetTime,
}: {
  chat: CoffeeChat;
  meetingAt?: string;
  onSetTime: () => void;
}) {
  const sending = useSending(chat.id);
  // an approved message on its way: the card says so at once, and moves stage the moment it goes out
  if (sending)
    return (
      <span className="whitespace-nowrap text-accent" data-testid="chat-card-sending">
        {sending}
      </span>
    );
  if (chat.stage === 'scheduled')
    return meetingAt ? (
      <span className="relative z-10 inline-flex items-center gap-1" data-testid="chat-card-time">
        Chat {chatTimeLabel(meetingAt)}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-ink"
          onClick={onSetTime}
          aria-label="Change the time"
        >
          Change
        </button>
      </span>
    ) : (
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <span className="text-warn">Time not set</span>
        <button
          type="button"
          className="h-6 px-2 rounded-full border border-line text-ink-2 hover:bg-canvas-2"
          onClick={onSetTime}
          data-testid="chat-card-set-time"
        >
          Set time
        </button>
      </span>
    );
  if (wentQuiet(chat))
    return (
      // the two parts wrap as wholes on a narrow card, never clipped mid-word
      <span>
        <span className="whitespace-nowrap">You wrote {relDate(chat.lastOutboundAt)}</span>{' '}
        <span className="whitespace-nowrap text-warn">· quiet</span>
      </span>
    );
  return <span className="whitespace-nowrap">{daysLabel(chat.stageEnteredAt)} in stage</span>;
}
