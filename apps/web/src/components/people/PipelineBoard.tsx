import type { ChatStage, CoffeeChat, Person, Suggestion } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, STAGE_HELP, STAGE_LABELS } from '@orbit/core';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, cx, relDate } from '../../ui';
import { chatTimeLabel } from '../ScheduleChat';
import { KIND_LABEL } from '../SuggestionCard';
import { daysLabel, STAGE_COLOR, wentQuiet } from './shared';

export type ChatRow = { chat: CoffeeChat; person: Person };

/**
 * The board: one column per stage, a card per chat. Drag a card or use its Move to menu to change its stage. On a
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
                className={cx('w-full shrink-0', items.length ? '@3xl:w-[228px]' : '@3xl:w-[132px]')}
                data-stage={stage}
                data-needs={items.filter((r) => nextFor(r.chat.id, r.person.id)).length || undefined}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/chat');
                  const r = rows.find((x) => x.chat.id === id);
                  if (r) move(r.chat, stage);
                }}
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
                <div className="space-y-2 min-h-[80px] rounded-[12px] bg-canvas-2/70 p-2">
                  {items.map(({ chat, person }) => (
                    <BoardCard
                      key={chat.id}
                      chat={chat}
                      person={person}
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
    </>
  );
}

function BoardCard({
  chat,
  person,
  next,
  meetingAt,
  move,
  setTime,
}: {
  chat: CoffeeChat;
  person: Person;
  next?: Suggestion;
  meetingAt?: string;
  move: (chat: CoffeeChat, to: ChatStage) => void;
  setTime: (chat: CoffeeChat) => void;
}) {
  const stage = chat.stage;
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/chat', chat.id)}
      title="Drag to another stage, or use Move to"
      // pops in on mount, so a card moved to another stage lands visibly in its new column
      className="pop-in relative bg-canvas border border-line rounded-[10px] p-3 cursor-grab active:cursor-grabbing hover:shadow-[var(--shadow-card)] focus-within:ring-2 focus-within:ring-accent/40 transition-shadow"
      data-testid={`chat-card-${stage}`}
    >
      <div className="flex items-center gap-2">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={28} />
        <div className="min-w-0">
          {/* The name link stretches over the whole card, so the card is one tab stop and opens on Enter. */}
          <Link
            to={`/people/${person.id}`}
            className="block text-[13.5px] font-medium truncate focus:outline-none after:absolute after:inset-0 after:content-['']"
          >
            {person.displayName}
          </Link>
          {person.currentTitle && (
            <div className="text-[12px] text-ink-3 line-clamp-2 leading-snug" title={person.currentTitle}>
              {person.currentTitle}
            </div>
          )}
          {person.currentOrganizationRaw && (
            <div className="text-[12px] text-ink-3 truncate">{person.currentOrganizationRaw}</div>
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
      <select
        value=""
        onChange={(e) => e.target.value && move(chat, e.target.value as ChatStage)}
        className="relative z-10 mt-2 h-7 w-full rounded-md border border-line bg-canvas px-1.5 text-[12px] text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
        aria-label={`Move ${person.displayName} to another stage`}
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
            className="h-8 px-3 rounded-full bg-accent-soft text-accent text-[12px] font-medium inline-flex items-center gap-0.5 hover:bg-accent hover:text-white"
            data-testid="board-needs"
          >
            {needs.count} card{needs.count === 1 ? '' : 's'} with a next step off to the right{' '}
            <ChevronRight size={14} />
          </button>
        )}
        {more > 0 && (
          <button
            onClick={() => ref.current?.scrollBy({ left: 480, behavior: 'smooth' })}
            className="h-8 pl-3 pr-2 rounded-full border border-line bg-canvas text-[12px] text-ink-2 shadow-sm inline-flex items-center gap-0.5 hover:text-ink"
            data-testid="board-more"
          >
            {more} more stage{more === 1 ? '' : 's'} <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div
        ref={ref}
        onScroll={measure}
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
      <span className="whitespace-nowrap">
        You wrote {relDate(chat.lastOutboundAt)} <span className="text-warn">· quiet</span>
      </span>
    );
  return <span className="whitespace-nowrap">{daysLabel(chat.stageEnteredAt)} in stage</span>;
}
