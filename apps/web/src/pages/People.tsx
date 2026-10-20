import type { CoffeeChat, Person } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, normalizeCompany, STAGE_HELP, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { CompaniesView } from '../components/people/CompaniesView';
import { PeopleList } from '../components/people/PeopleList';
import { type ChatRow, PipelineBoard } from '../components/people/PipelineBoard';
import { QUIET_DAYS, STAGE_COLOR, useNarrow, wentQuiet } from '../components/people/shared';
import { useChatMove } from '../components/people/useChatMove';
import { type PeopleFilter, type PeopleView, peopleFilterOf, peopleViewOf } from '../components/people/view';
import { db } from '../db/schema';
import { filterPeople, type PeopleSort } from '../engine/search';
import { useHints } from '../state/hints';
import { useSession } from '../state/session';
import { Button, cx, EmptyState, FirstRunHint, Input, PageHeader, Select } from '../ui';

const STAGE_ORDER = [...ACTIVE_STAGES, ...CLOSED_STAGES];
/** How many people the list draws at once; "Show more" adds as many again. */
const PAGE = 300;

const VIEWS: { value: PeopleView; label: string }[] = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
  { value: 'companies', label: 'Companies' },
];

/**
 * Everyone in the student's orbit and where each chat stands, on one page: the board (a column per stage), the list
 * (everyone, with or without a chat) and the companies. One search and one filter serve all three, and the address
 * keeps the view and the filter (`?view=list&f=quiet`), so the chat and old links can open the page on either.
 */
export function People() {
  const { userId } = useSession();
  const [params, setParams] = useSearchParams();
  // The router hands a functional update the params of the last render, so a filter picked right after a tab click
  // would write the old view back. Changes build on the newest params: the ones last written, until the address moves.
  const seenParams = useRef(params);
  const latestParams = useRef(params);
  if (seenParams.current !== params) seenParams.current = latestParams.current = params;
  const filter = peopleFilterOf(params);
  const [q, setQ] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [sort, setSort] = useState<PeopleSort | 'stage'>('strength');
  const [limit, setLimit] = useState(PAGE);
  const hints = useHints();
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const chatRows = useLiveQuery(
    () => (userId ? db.chats.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const chats = chatRows ?? [];
  // the board opens by default, but with no chat yet it would be empty: a plain /people then shows the list of
  // everyone, so a student who just imported their connections sees them. Derived, never written to the address, so
  // adding a first person (which moves on to their page) is never pulled back here.
  const view: PeopleView = params.get('view')
    ? peopleViewOf(params)
    : chatRows && people.length > 0 && !chats.some((c) => !c.archivedAt)
      ? 'list'
      : 'board';
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
  // with Google connected Orbit reads replies and meetings itself; without it the student moves chats along
  const googleOn =
    useLiveQuery(
      async () =>
        userId
          ? (await db.integrations.where('userId').equals(userId).toArray()).some(
              (i) => i.provider === 'google' && i.status === 'active',
            )
          : false,
      [userId],
    ) ?? false;
  // booked chats still ahead, so a Scheduled card says when, not how long it has sat there
  const meetings =
    useLiveQuery(
      () =>
        userId
          ? db.events
              .where('userId')
              .equals(userId)
              .filter((e) => e.status !== 'cancelled' && new Date(e.endAt).getTime() > Date.now())
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const tcs =
    useLiveQuery(
      () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
      [userId],
    ) ?? [];
  const meetingFor = (chat: CoffeeChat) =>
    meetings
      .filter((e) => e.chatId === chat.id || e.attendeePersonIds.includes(chat.personId))
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  // matched on the normalized name: a target typed as "McKinsey" covers "McKinsey & Company"
  const targetNames = useMemo(
    () => new Set(tcs.flatMap((t) => [normalizeCompany(t.nameRaw), t.nameRaw.toLowerCase()])),
    [tcs],
  );
  const isTarget = (p: Person) =>
    targetNames.has(normalizeCompany(p.currentOrganizationRaw)) ||
    targetNames.has((p.currentOrganizationRaw ?? '').toLowerCase());
  // a person's chat: the one touched last, when there is more than one
  const chatByPerson = useMemo(() => {
    const m = new Map<string, CoffeeChat>();
    for (const c of chats) {
      const cur = m.get(c.personId);
      if (!cur || c.updatedAt > cur.updatedAt) m.set(c.personId, c);
    }
    return m;
  }, [chats]);
  const { move, setTime, dialogs } = useChatMove({ byId, meetingFor });
  const [narrow, rootRef] = useNarrow();
  const nextFor = (chatId: string, personId: string) =>
    suggestions.find((s) => s.chatId === chatId || (s.personId === personId && !s.chatId));
  const s = q.trim().toLowerCase();
  const matches = (p: Person) =>
    !s ||
    p.displayName.toLowerCase().includes(s) ||
    (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
    (p.currentTitle ?? '').toLowerCase().includes(s);
  // the board and the companies: one row per chat, the newest activity first
  const rows: ChatRow[] = chats
    .map((c) => ({ chat: c, person: byId.get(c.personId) }))
    .filter(
      (r): r is ChatRow =>
        !!r.person && r.person.isHuman && (filter === 'hidden' ? !!r.person.hiddenAt : !r.person.hiddenAt),
    )
    .filter((r) => matches(r.person))
    .filter((r) =>
      filter === 'alumni'
        ? !!r.person.isAlumni
        : filter === 'strong'
          ? r.person.strength >= 0.6
          : filter === 'targets'
            ? isTarget(r.person)
            : filter === 'quiet'
              ? wentQuiet(r.chat)
              : true,
    )
    .sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt));
  const visibleChats = chats.filter((c) => byId.get(c.personId) && !byId.get(c.personId)!.hiddenAt);
  const quietCount = visibleChats.filter((c) => wentQuiet(c)).length;
  const hiddenCount = people.filter((p) => p.hiddenAt).length;
  const total = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  // the list: everyone, with or without a chat; "With a chat" leaves out closed chats unless they are shown
  const list = useMemo(() => {
    const withChat = new Set(
      chats.filter((c) => (showClosed ? true : !CLOSED_STAGES.includes(c.stage))).map((c) => c.personId),
    );
    const quiet = new Set(chats.filter((c) => wentQuiet(c)).map((c) => c.personId));
    const found = filterPeople(people, {
      query: q,
      filter,
      sort: sort === 'stage' ? 'strength' : sort,
      activeChat: withChat,
      targetNames,
      quiet,
    });
    if (sort !== 'stage') return found;
    // pipeline order first, the people without a chat after them; closer people first within each
    const rank = (p: Person) => {
      const c = chatByPerson.get(p.id);
      return c ? STAGE_ORDER.indexOf(c.stage) : STAGE_ORDER.length;
    };
    return found.slice().sort((a, b) => rank(a) - rank(b));
  }, [people, chats, chatByPerson, q, filter, sort, showClosed, targetNames]);
  const updateParams = (change: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(latestParams.current);
    change(next);
    latestParams.current = next;
    setParams(next, { replace: true });
  };
  const setView = (v: PeopleView) => updateParams((p) => p.set('view', v));
  const setFilter = (f: PeopleFilter) =>
    updateParams((p) => {
      p.delete('quiet');
      if (f === 'all') p.delete('f');
      else p.set('f', f);
    });
  const stages = showClosed ? STAGE_ORDER : ACTIVE_STAGES;
  const filtering = !!s || filter !== 'all';
  const boardRows = rows.filter((r) => stages.includes(r.chat.stage));
  const subtitle =
    view === 'list'
      ? filter === 'hidden'
        ? `${list.length} hidden ${list.length === 1 ? 'person' : 'people'}. Open one and choose Show again to bring them back.`
        : filtering
          ? `${list.length} of ${total} people`
          : `${total} ${total === 1 ? 'person' : 'people'} in your orbit`
      : view === 'companies'
        ? 'Every company where you have a chat.'
        : googleOn
          ? 'Every coffee chat and where it stands.'
          : 'Orbit cannot see your inbox: move a card when someone replies.';
  const quietNote = `Nobody has gone quiet: no one has been waiting more than ${QUIET_DAYS} days for a reply to your last message.`;
  return (
    <div ref={rootRef}>
      <PageHeader title="People" subtitle={subtitle} actions={<AddPersonButton />} />
      <FirstRunHint
        id="pipeline"
        title="Reading the board"
        dismissed={hints.seen('pipeline') || chats.length === 0 || view !== 'board'}
        onDismiss={hints.dismiss}
      >
        Each column is a stage. Drag a card to move it; a chip on a card is its next step.
      </FirstRunHint>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-5">
        <div
          className="inline-flex items-center rounded-full border border-line bg-canvas p-0.5 shadow-[var(--shadow-pill)]"
          role="tablist"
          aria-label="How to show your people"
        >
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={view === v.value}
              onClick={() => setView(v.value)}
              className={cx(
                'h-8 px-3.5 rounded-full text-[13px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20',
                view === v.value ? 'bg-ink text-white font-medium' : 'text-ink-2 hover:text-ink',
              )}
              data-testid={`people-view-${v.value}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view !== 'companies' && (
          <details className="text-[13px] w-full @[40rem]:w-auto" data-testid="stage-legend">
            <summary className="cursor-pointer text-ink-3 hover:text-ink w-fit">Stages</summary>
            <dl className="mt-2 grid @[40rem]:grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg bg-canvas-2 p-3">
              {STAGE_ORDER.map((st) => (
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
        )}
        {/* views, then search and filters on the same line: one row of controls above the people */}
        <div className="flex flex-wrap items-center gap-2 @[56rem]:ml-auto" data-testid="people-filters">
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Search name, company, title"
            aria-label="Search people"
            className="w-full @[40rem]:w-56"
          />
          <Select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as PeopleFilter);
              setLimit(PAGE);
            }}
            aria-label="Filter people"
            data-testid="people-filter"
          >
            <option value="all">Everyone</option>
            <option value="alumni">Alumni</option>
            <option value="strong">Close ties</option>
            <option value="chats">With a chat</option>
            <option value="targets">At target companies</option>
            <option
              value="quiet"
              data-testid="filter-quiet"
              title={`You wrote last, ${QUIET_DAYS} or more days ago, and they have not answered`}
            >
              Went quiet{quietCount ? ` (${quietCount})` : ''}
            </option>
            <option value="hidden">Hidden{hiddenCount ? ` (${hiddenCount})` : ''}</option>
          </Select>
          {view === 'list' && (
            <Select value={sort} onChange={(e) => setSort(e.target.value as never)} aria-label="Sort people">
              <option value="strength">By closeness</option>
              <option value="recent">Most recent</option>
              <option value="name">By name</option>
              <option value="stage">By stage</option>
            </Select>
          )}
          <label className="text-[13px] inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              data-testid="show-closed"
            />{' '}
            Show closed
          </label>
        </div>
      </div>
      {total === 0 && filter !== 'hidden' ? (
        <div data-testid="people-empty-network">
          <EmptyState
            title="No one here yet"
            body="Add the people you want to talk to, or import your LinkedIn connections to bring everyone in at once."
            action={
              <div className="flex flex-col items-center gap-4">
                <div className="flex flex-wrap justify-center gap-2">
                  <AddPersonButton variant="primary" />
                  <LinkedInImportButton />
                  <Link
                    to="/settings/integrations"
                    className="self-center text-[13px] text-accent underline underline-offset-2 hover:text-ink"
                  >
                    How to get the LinkedIn file
                  </Link>
                </div>
                {tcs.some((t) => t.status !== 'closed') && (
                  <div className="pt-4 border-t border-line-2 w-full">
                    <p className="text-[13px] text-ink-2">
                      Know someone at a company on your list? Add them and Orbit helps you write the first
                      message.
                    </p>
                    <div className="mt-2 flex flex-wrap justify-center gap-2">
                      {tcs
                        .filter((t) => t.status !== 'closed')
                        .slice(0, 6)
                        .map((t) => (
                          <AddPersonButton
                            key={t.id}
                            label={`Someone at ${t.nameRaw}`}
                            company={t.nameRaw}
                            variant="ghost"
                          />
                        ))}
                    </div>
                  </div>
                )}
              </div>
            }
          />
        </div>
      ) : view === 'list' ? (
        list.length ? (
          <>
            <PeopleList
              people={list.slice(0, limit)}
              chatFor={(id) => chatByPerson.get(id)}
              nextFor={nextFor}
              move={move}
            />
            {list.length > limit && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button onClick={() => setLimit((n) => n + PAGE)} data-testid="people-show-more">
                  Show more
                </Button>
                <span className="text-[12px] text-ink-3">
                  Showing {limit} of {list.length}. Search to find someone further down.
                </span>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            title={
              filter === 'hidden'
                ? 'Nobody is hidden'
                : filter === 'quiet'
                  ? 'Nobody has gone quiet'
                  : 'Nobody matches'
            }
            body={filter === 'quiet' ? quietNote : undefined}
          />
        )
      ) : visibleChats.length === 0 && filter !== 'hidden' ? (
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
      ) : view === 'companies' ? (
        <CompaniesView rows={rows} targetNames={targetNames} />
      ) : boardRows.length ? (
        <PipelineBoard
          rows={boardRows}
          stages={stages}
          filtering={filtering}
          narrow={narrow}
          nextFor={nextFor}
          meetingFor={meetingFor}
          move={move}
          setTime={setTime}
        />
      ) : (
        <p className="text-[13px] text-ink-3 mt-2">
          {filter === 'quiet' ? quietNote : 'No chats match these filters.'}
        </p>
      )}
      {dialogs}
    </div>
  );
}
