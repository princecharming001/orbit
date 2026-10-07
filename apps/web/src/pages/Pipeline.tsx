import type { ChatStage, CoffeeChat, Person, Suggestion } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, STAGE_HELP, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { KIND_LABEL } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { applyStage } from '../engine/stages';
import { useHints } from '../state/hints';
import { useSession } from '../state/session';
import {
  Avatar,
  Button,
  Chip,
  cx,
  EmptyState,
  FirstRunHint,
  Input,
  PageHeader,
  relDate,
  Select,
  Tabs,
  useToast,
} from '../ui';

const DAY = 86_400_000;
/** Days without an answer after the student's last message before a chat counts as gone quiet. */
export const QUIET_DAYS = 7;
const WAITING_STAGES: ChatStage[] = ['outreach_sent', 'replied', 'scheduling'];

/** True when the student wrote last, at least a week ago, and the chat is still waiting on the other person. */
export function wentQuiet(chat: CoffeeChat, now = new Date()): boolean {
  if (!WAITING_STAGES.includes(chat.stage) || !chat.lastOutboundAt) return false;
  if (chat.lastInboundAt && chat.lastInboundAt >= chat.lastOutboundAt) return false;
  return now.getTime() - new Date(chat.lastOutboundAt).getTime() >= QUIET_DAYS * DAY;
}

type SortKey = 'person' | 'company' | 'stage' | 'inStage' | 'lastSent' | 'lastReply' | 'closeness';

export const STAGE_COLOR: Record<ChatStage, string> = {
  identified: '#9aa1ad',
  warming: '#b7791f',
  outreach_sent: '#5b5bd6',
  replied: '#1f8a4c',
  scheduling: '#5b5bd6',
  scheduled: '#1f8a4c',
  completed: '#1f8a4c',
  followed_up: '#1f8a4c',
  nurturing: '#3f4650',
  declined: '#c43d3d',
  no_response: '#9aa1ad',
  archived: '#c7cbd3',
};

export function Pipeline() {
  const { userId, user } = useSession();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as 'board' | 'table' | 'companies') ?? 'board';
  const [q, setQ] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [onlyTargets, setOnlyTargets] = useState(false);
  const [onlyQuiet, setOnlyQuiet] = useState(params.get('quiet') === '1');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'lastSent', dir: 1 });
  const nav = useNavigate();
  const toast = useToast();
  const hints = useHints();
  const chats =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const suggestions =
    useLiveQuery(
      () =>
        userId
          ? db.suggestions
              .where('userId')
              .equals(userId)
              .filter((s) => s.status === 'pending')
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const tcs =
    useLiveQuery(
      () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
      [userId],
    ) ?? [];
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const targetNames = useMemo(() => new Set(tcs.map((t) => t.nameRaw.toLowerCase())), [tcs]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return chats
      .map((c) => ({ chat: c, person: byId.get(c.personId) }))
      .filter(
        (r): r is { chat: CoffeeChat; person: Person } =>
          !!r.person && r.person.isHuman && !r.person.hiddenAt,
      )
      .filter(
        (r) =>
          !s ||
          r.person.displayName.toLowerCase().includes(s) ||
          (r.person.currentOrganizationRaw ?? '').toLowerCase().includes(s),
      )
      .filter((r) => !onlyTargets || targetNames.has((r.person.currentOrganizationRaw ?? '').toLowerCase()))
      .filter((r) => !onlyQuiet || wentQuiet(r.chat))
      .sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt));
  }, [chats, byId, q, onlyTargets, onlyQuiet, targetNames]);
  const quietCount = useMemo(
    () => chats.filter((c) => wentQuiet(c) && !byId.get(c.personId)?.hiddenAt).length,
    [chats, byId],
  );
  const nextFor = (chatId: string, personId: string) =>
    suggestions.find((s) => s.chatId === chatId || (s.personId === personId && !s.chatId));
  const move = async (chat: CoffeeChat, to: ChatStage) => {
    if (chat.stage === to) return;
    const from = chat.stage;
    await applyStage(chat, to, 'user', 'user:drag');
    const name = byId.get(chat.personId)?.firstName ?? 'This chat';
    toast.push({
      text: `Moved ${name} to ${STAGE_LABELS[to]}.`,
      action: {
        label: 'Undo',
        onClick: async () => {
          const now = await db.chats.get(chat.id);
          if (now) await applyStage(now, from, 'user', 'user:undo');
        },
      },
      ttl: 6000,
    });
  };
  const stages: ChatStage[] = showClosed ? [...ACTIVE_STAGES, ...CLOSED_STAGES] : ACTIVE_STAGES;
  const sortVal = (r: { chat: CoffeeChat; person: Person }): string | number => {
    switch (sort.key) {
      case 'person':
        return r.person.displayName.toLowerCase();
      case 'company':
        return (r.person.currentOrganizationRaw ?? '').toLowerCase();
      case 'stage':
        return [...ACTIVE_STAGES, ...CLOSED_STAGES].indexOf(r.chat.stage);
      case 'inStage':
        return r.chat.stageEnteredAt;
      case 'lastSent':
        return r.chat.lastOutboundAt ?? '9';
      case 'lastReply':
        return r.chat.lastInboundAt ?? '9';
      case 'closeness':
        return -r.person.strength;
    }
  };
  const tableRows = rows
    .filter((r) => showClosed || !CLOSED_STAGES.includes(r.chat.stage))
    .slice()
    .sort((a, b) => {
      const x = sortVal(a);
      const y = sortVal(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  const header = (key: SortKey, label: string) => (
    <th
      key={key}
      className="text-left font-medium px-3 h-9 whitespace-nowrap"
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <button
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink"
        onClick={() => setSort((cur) => ({ key, dir: cur.key === key ? (cur.dir === 1 ? -1 : 1) : 1 }))}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
  return (
    <div>
      <PageHeader
        title="Pipeline"
        subtitle="Every coffee chat and where it stands. Orbit moves chats along as emails and meetings happen; you can move one yourself too."
        actions={<AddPersonButton label="Add a person" />}
      />
      <FirstRunHint
        id="pipeline"
        title="Reading the board"
        dismissed={hints.seen('pipeline') || chats.length === 0}
        onDismiss={hints.dismiss}
      >
        Each column is a stage, left to right from first message to staying in touch. Drag a card or use its
        Move to menu to change the stage. The chip on a card is the next thing to do; it opens that card on
        Today.
      </FirstRunHint>
      <details className="mb-4 text-[13px]" data-testid="stage-legend">
        <summary className="cursor-pointer text-ink-2 w-fit">What the stages mean</summary>
        <dl className="mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg bg-canvas-2 p-3">
          {[...ACTIVE_STAGES, ...CLOSED_STAGES].map((st) => (
            <div key={st} className="flex gap-2 min-w-0">
              <dt className="font-medium shrink-0 inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: STAGE_COLOR[st] }} />
                {STAGE_LABELS[st]}
              </dt>
              <dd className="text-ink-2 min-w-0">{STAGE_HELP[st]}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Tabs
          value={view}
          onChange={(v) => setParams({ view: v })}
          items={[
            { value: 'board', label: 'Board' },
            { value: 'table', label: 'Table' },
            { value: 'companies', label: 'Companies' },
          ]}
        />
        <div className="sm:ml-auto flex flex-wrap items-center gap-2 sm:-mt-4 w-full sm:w-auto">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or company"
            aria-label="Search chats by name or company"
            className="w-full sm:w-56"
          />
          <label className="text-[13px] inline-flex items-center gap-1.5">
            <input type="checkbox" checked={onlyTargets} onChange={(e) => setOnlyTargets(e.target.checked)} />{' '}
            Targets only
          </label>
          <label
            className="text-[13px] inline-flex items-center gap-1.5"
            title={`You wrote last, ${QUIET_DAYS} or more days ago, and they have not answered`}
          >
            <input
              type="checkbox"
              checked={onlyQuiet}
              onChange={(e) => setOnlyQuiet(e.target.checked)}
              data-testid="filter-quiet"
            />{' '}
            Went quiet{quietCount ? ` (${quietCount})` : ''}
          </label>
          <label className="text-[13px] inline-flex items-center gap-1.5">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />{' '}
            Show closed
          </label>
        </div>
      </div>
      {chats.length === 0 && (
        <EmptyState
          title="No chats yet"
          body="A chat starts when you send someone a first message or start a warm-up. Add the people you want to talk to, or pick someone Orbit recommends."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <AddPersonButton variant="primary" />
              <Link to="/discover">
                <Button>Find people to meet</Button>
              </Link>
            </div>
          }
        />
      )}
      {view === 'board' && chats.length > 0 && (
        <Board count={stages.length}>
          {stages.map((stage) => {
            const items = rows.filter((r) => r.chat.stage === stage);
            return (
              <div
                key={stage}
                className="w-[228px] shrink-0"
                data-stage={stage}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/chat');
                  const c = chats.find((x) => x.id === id);
                  if (c) move(c, stage);
                }}
              >
                <div className="flex items-center gap-2 mb-2 px-1" title={STAGE_HELP[stage]}>
                  <span className="w-2 h-2 rounded-full" style={{ background: STAGE_COLOR[stage] }} />
                  <span className="text-[13px] font-medium whitespace-nowrap">{STAGE_LABELS[stage]}</span>
                  <span className="text-[12px] text-ink-3 tabular">{items.length}</span>
                </div>
                <div className="space-y-2 min-h-[80px] rounded-[12px] bg-canvas-2/70 p-2">
                  {items.map(({ chat, person }) => {
                    const next = nextFor(chat.id, person.id);
                    return (
                      <div
                        key={chat.id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/chat', chat.id)}
                        title="Drag to another stage, or use Move to"
                        className="relative bg-canvas border border-line rounded-[10px] p-3 cursor-grab active:cursor-grabbing hover:shadow-[var(--shadow-card)] focus-within:ring-2 focus-within:ring-accent/40 transition-shadow"
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
                              <div className="text-[12px] text-ink-3 truncate" title={person.currentTitle}>
                                {person.currentTitle}
                              </div>
                            )}
                            {person.currentOrganizationRaw && (
                              <div className="text-[12px] text-ink-3 truncate">
                                {person.currentOrganizationRaw}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px] text-ink-3">
                          <span className="whitespace-nowrap">
                            {daysLabel(chat.stageEnteredAt)} in stage
                            {wentQuiet(chat) && <span className="text-warn"> · quiet</span>}
                          </span>
                          {next && <NextLink s={next} />}
                        </div>
                        {chat.warmUp && stage === 'warming' && (
                          <div className="mt-2 h-1 rounded bg-line">
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
                  })}
                </div>
              </div>
            );
          })}
        </Board>
      )}
      {view === 'table' &&
        chats.length > 0 &&
        (rows.length ? (
          <div className="border border-line rounded-[var(--radius-card)] overflow-x-auto">
            <table className="w-full text-[13.5px] min-w-[760px]">
              <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
                <tr>
                  {header('person', 'Person')}
                  {header('company', 'Company')}
                  {header('stage', 'Stage')}
                  {header('inStage', 'In stage')}
                  {header('lastSent', 'Last sent')}
                  {header('lastReply', 'Last reply')}
                  <th className="text-left font-medium px-3 h-9">Next</th>
                  {header('closeness', 'Closeness')}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tableRows.map(({ chat, person }) => {
                  const next = nextFor(chat.id, person.id);
                  return (
                    <tr
                      key={chat.id}
                      className="hover:bg-canvas-2/60 cursor-pointer"
                      onClick={() => nav(`/people/${person.id}`)}
                    >
                      <td className="px-3 h-11">
                        <span className="inline-flex items-center gap-2">
                          <Avatar name={person.displayName} id={person.id} size={24} />{' '}
                          <Link
                            to={`/people/${person.id}`}
                            className="font-medium hover:underline whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {person.displayName}
                          </Link>
                        </span>
                      </td>
                      <td className="px-3 text-ink-2 whitespace-nowrap">
                        {person.currentOrganizationRaw ?? '—'}
                      </td>
                      <td className="px-3" onClick={(e) => e.stopPropagation()}>
                        <Select
                          value={chat.stage}
                          onChange={(e) => move(chat, e.target.value as ChatStage)}
                          className="h-7 text-[12px]"
                          aria-label={`Stage for ${person.displayName}`}
                        >
                          {[...ACTIVE_STAGES, ...CLOSED_STAGES].map((s) => (
                            <option key={s} value={s}>
                              {STAGE_LABELS[s]}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-3 tabular text-ink-2 whitespace-nowrap">
                        {daysLabel(chat.stageEnteredAt)}
                      </td>
                      <td className="px-3 text-ink-2 whitespace-nowrap">
                        {relDate(chat.lastOutboundAt)}
                        {wentQuiet(chat) && <span className="text-warn"> · quiet</span>}
                      </td>
                      <td className="px-3 text-ink-2 whitespace-nowrap">{relDate(chat.lastInboundAt)}</td>
                      <td className="px-3" onClick={(e) => e.stopPropagation()}>
                        {next ? <NextLink s={next} /> : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="px-3">
                        <StrengthDots v={person.strength} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={onlyQuiet ? 'Nobody has gone quiet' : 'No chats yet'}
            body={
              onlyQuiet
                ? `Every chat waiting on a reply heard back within ${QUIET_DAYS} days.`
                : 'A chat starts when you write to someone. Add a person, or pick someone from Discover.'
            }
          />
        ))}
      {view === 'companies' && chats.length > 0 && <CompaniesView rows={rows} targetNames={targetNames} />}
      {user && rows.length === 0 && chats.length > 0 && view === 'board' && (
        <p className="text-[13px] text-ink-3 mt-2">
          {onlyQuiet
            ? `Nobody has gone quiet: every chat waiting on a reply heard back within ${QUIET_DAYS} days.`
            : 'No chats match these filters.'}
        </p>
      )}
    </div>
  );
}

/** The board scrolls sideways; a fade and a "More stages" button say so while columns are still hidden. */
function Board({ children, count }: { children: React.ReactNode; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(0);
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const cols = [...el.querySelectorAll<HTMLElement>('[data-stage]')];
    const right = el.scrollLeft + el.clientWidth;
    setMore(cols.filter((c) => c.offsetLeft + c.offsetWidth / 2 > right).length);
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={measure}
        className="flex gap-3 overflow-x-auto pb-4 scroll-thin -mx-4 px-4 md:mx-0 md:px-0"
        role="region"
        aria-label={`Pipeline board, ${count} stages`}
      >
        {children}
      </div>
      {more > 0 && (
        <>
          <div className="pointer-events-none absolute top-0 right-0 bottom-4 w-16 bg-gradient-to-l from-canvas to-transparent" />
          <button
            onClick={() => ref.current?.scrollBy({ left: 480, behavior: 'smooth' })}
            className="absolute top-9 right-1 h-8 pl-3 pr-2 rounded-full border border-line bg-canvas text-[12px] text-ink-2 shadow-md inline-flex items-center gap-0.5 hover:text-ink"
            data-testid="board-more"
          >
            {more} more stage{more === 1 ? '' : 's'} <ChevronRight size={14} />
          </button>
        </>
      )}
    </div>
  );
}

/** The next step for a chat. It looks like a chip and is a link: it opens that card on Today. */
function NextLink({ s }: { s: Suggestion }) {
  return (
    <Link
      to={`/today?card=${s.id}`}
      className="relative z-10 inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent px-2 h-6 text-[12px] font-medium whitespace-nowrap hover:bg-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title="Open this on Today"
      data-testid="chat-next"
    >
      {KIND_LABEL[s.kind].label}
    </Link>
  );
}

function daysLabel(since: string): string {
  const d = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));
  return d === 0 ? 'Under a day' : d === 1 ? '1 day' : `${d} days`;
}

export function StrengthDots({
  v,
  label = 'Closeness',
  showValue,
}: {
  v: number;
  label?: string;
  /** also print the number (out of 100), so two people with four dots can still be told apart */
  showValue?: boolean;
}) {
  const n = v >= 0.6 ? 4 : v >= 0.4 ? 3 : v >= 0.2 ? 2 : v > 0.02 ? 1 : 0;
  const text = `${label} ${Math.round(v * 100)} of 100`;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={text}>
      <span className="inline-flex gap-0.5" role="img" aria-label={text}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx('w-1.5 h-1.5 rounded-full', i < n ? 'bg-accent' : 'bg-line')} />
        ))}
      </span>
      {showValue && (
        <span className="tabular text-[12px] text-ink-3" aria-hidden>
          {Math.round(v * 100)}
        </span>
      )}
    </span>
  );
}

function CompaniesView({
  rows,
  targetNames,
}: {
  rows: { chat: CoffeeChat; person: Person }[];
  targetNames: Set<string>;
}) {
  const groups = new Map<
    string,
    { name: string; orgId?: string; people: Set<string>; byStage: Map<ChatStage, number>; last?: string }
  >();
  for (const { chat, person } of rows) {
    const key = person.currentOrganizationId ?? person.currentOrganizationRaw ?? 'Independent';
    const g = groups.get(key) ?? {
      name: person.currentOrganizationRaw ?? 'Independent',
      orgId: person.currentOrganizationId,
      people: new Set(),
      byStage: new Map(),
      last: undefined,
    };
    g.people.add(person.id);
    g.byStage.set(chat.stage, (g.byStage.get(chat.stage) ?? 0) + 1);
    if (!g.last || chat.updatedAt > g.last) g.last = chat.updatedAt;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.people.size - a.people.size);
  if (!list.length) return <EmptyState title="No companies yet" />;
  return (
    <div className="border border-line rounded-[var(--radius-card)] overflow-x-auto">
      <table className="w-full text-[13.5px] min-w-[560px]">
        <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
          <tr>
            {['Company', 'People', 'Stages', 'Target', 'Last activity'].map((h) => (
              <th key={h} className="text-left font-medium px-3 h-9">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {list.map((g) => (
            <tr key={g.name}>
              <td className="px-3 h-11 font-medium">
                {g.orgId ? (
                  <Link to={`/companies/${g.orgId}`} className="hover:underline">
                    {g.name}
                  </Link>
                ) : (
                  g.name
                )}
              </td>
              <td className="px-3 tabular">{g.people.size}</td>
              <td className="px-3">
                <span className="flex flex-wrap gap-1">
                  {[...g.byStage.entries()].map(([s, n]) => (
                    <Chip key={s}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: STAGE_COLOR[s] }} />
                      {STAGE_LABELS[s]} {n}
                    </Chip>
                  ))}
                </span>
              </td>
              <td className="px-3">
                {targetNames.has(g.name.toLowerCase()) ? (
                  <Chip tone="accent">Target</Chip>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </td>
              <td className="px-3 text-ink-2">{relDate(g.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
