/**
 * The calls (plan 38 §F), three ways: a week of seven columns (each call a block with its time, the face and the
 * company), a month of whole weeks (each day its calls in short), and a list (what is coming, then what happened),
 * with arrows to the weeks or months around. Above them, the outreach in three numbers: written to, replied, booked.
 * On a phone the week reads as a list of the days that have calls.
 */
import type { Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { clockTime } from '../../engine/batchTime';
import {
  callsList,
  callsMonth,
  callsWeek,
  monthStart,
  outreachFunnel,
  type WeekCall,
  weekStart,
} from '../../engine/callsWeek';
import { useViewState } from '../../state/viewState';
import { Avatar, cx } from '../../ui';
import { PersonCompanyLogo } from '../CompanyLogo';

const DAY = 86_400_000;

type CalView = 'week' | 'month' | 'list';
const VIEW_KEY = 'orbit:chats-view';
const readView = (): CalView => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'month' || v === 'list' ? v : 'week';
  } catch {
    return 'week';
  }
};

export function WeekCalendar({ userId }: { userId: string }) {
  const [view, setViewState] = useState<CalView>(readView);
  const setView = (v: CalView) => {
    setViewState(v);
    setOffset(0);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // a private window keeps the choice for this visit only
    }
  };
  // the week or month looked at is kept while the student is away (state/viewState)
  const [offset, setOffset] = useViewState(`chats:offset:${userId}`, 0);
  const start = useMemo(() => {
    const s = weekStart(new Date());
    s.setDate(s.getDate() + offset * 7);
    return s;
  }, [offset]);
  const week = useLiveQuery(() => callsWeek(userId, start), [userId, start.getTime()]);
  const month = useMemo(() => monthStart(new Date(), offset), [offset]);
  const monthView = useLiveQuery(
    () => (view === 'month' ? callsMonth(userId, month) : undefined),
    [userId, view, month.getTime()],
  );
  const list = useLiveQuery(() => (view === 'list' ? callsList(userId) : undefined), [userId, view]);
  const funnel = useLiveQuery(() => outreachFunnel(userId), [userId]);
  const people = useLiveQuery(
    async () => {
      const calls: WeekCall[] = [
        ...(week?.days.flatMap((d) => d.calls) ?? []),
        ...(monthView?.days.flatMap((d) => d.calls) ?? []),
        ...(list ? [...list.upcoming, ...list.past] : []),
      ];
      const ids = calls.map((c) => c.personId).filter((x): x is string => !!x);
      return new Map(
        (await db.people.bulkGet([...new Set(ids)])).filter((p): p is Person => !!p).map((p) => [p.id, p]),
      );
    },
    [week, monthView, list],
    new Map<string, Person>(),
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 6 * DAY);
  const range = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to ${end.toLocaleDateString('en-US', start.getMonth() === end.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
  return (
    <section className="mb-10" data-testid="chats-week">
      {funnel && funnel.wrote > 0 && (
        <dl className="mb-6 grid grid-cols-3 max-w-[460px] divide-x divide-line-2" data-testid="chats-funnel">
          {[
            ['Written to', funnel.wrote],
            ['Replied', funnel.replied],
            ['Calls booked', funnel.booked],
          ].map(([label, n], i) => (
            <div key={label as string} className={cx('px-4 first:pl-0')}>
              <dt className="text-[12px] text-ink-3">{label}</dt>
              <dd className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[24px] font-semibold tracking-[-0.02em] tabular">{n}</span>
                {i > 0 && funnel.wrote > 0 && (
                  <span className="text-[12px] text-ink-3 tabular">
                    {Math.round(((n as number) / funnel.wrote) * 100)}%
                  </span>
                )}
              </dd>
            </div>
          ))}
          <p className="col-span-3 pt-2 text-[12px] text-ink-3">The last 30 days.</p>
        </dl>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="section-title">
            {view === 'list'
              ? 'Your calls'
              : view === 'month'
                ? month.toLocaleDateString('en-US', {
                    month: 'long',
                    ...(month.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
                  })
                : offset === 0
                  ? 'This week'
                  : offset === 1
                    ? 'Next week'
                    : range}
          </h2>
          <span className="text-[12.5px] text-ink-3 tabular">
            {view === 'week' && week ? `${week.total} ${week.total === 1 ? 'call' : 'calls'}` : ''}
            {view === 'week' && (offset === 0 || offset === 1) ? ` · ${range}` : ''}
            {view === 'month' && monthView
              ? `${monthView.days.filter((d) => d.date.getMonth() === month.getMonth()).reduce((n, d) => n + d.calls.length, 0)} calls`
              : ''}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-[13px]" role="tablist" aria-label="Show calls by">
            {(['week', 'month', 'list'] as CalView[]).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cx(
                  'h-8 border-b-[1.5px] transition-colors',
                  view === v
                    ? 'border-ink text-ink font-medium'
                    : 'border-transparent text-ink-3 hover:text-ink',
                )}
                data-testid={`chats-view-${v}`}
              >
                {v === 'week' ? 'Week' : v === 'month' ? 'Month' : 'List'}
              </button>
            ))}
          </div>
          {view !== 'list' && (
            <div className="flex items-center gap-1">
              {offset !== 0 && (
                <button
                  type="button"
                  className="h-8 px-2.5 rounded-[6px] text-[12.5px] text-ink-2 hover:bg-canvas-2"
                  onClick={() => setOffset(0)}
                >
                  Today
                </button>
              )}
              <button
                type="button"
                className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-line hover:bg-canvas-2"
                onClick={() => setOffset((o) => o - 1)}
                aria-label={view === 'month' ? 'The month before' : 'The week before'}
                data-testid="chats-week-prev"
              >
                <ChevronLeft size={15} aria-hidden />
              </button>
              <button
                type="button"
                className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-line hover:bg-canvas-2"
                onClick={() => setOffset((o) => o + 1)}
                aria-label={view === 'month' ? 'The month after' : 'The week after'}
                data-testid="chats-week-next"
              >
                <ChevronRight size={15} aria-hidden />
              </button>
            </div>
          )}
        </div>
      </div>
      {view === 'month' && <MonthGrid view={monthView} month={month} today={today} people={people} />}
      {view === 'list' && <CallList list={list} people={people} />}
      {view === 'week' && (
        <>
          <div className="hidden @3xl:grid grid-cols-7 border-y border-line-2 divide-x divide-line-2">
            {(
              week?.days ??
              Array.from({ length: 7 }, (_, i) => ({ date: new Date(start.getTime() + i * DAY), calls: [] }))
            ).map((d) => {
              const isToday = d.date.getTime() === today.getTime();
              const past = d.date < today;
              return (
                <div
                  key={d.date.toISOString()}
                  className={cx('min-h-[168px] px-2 pt-2.5 pb-3', past && 'bg-canvas-2/40')}
                >
                  <div className="mb-2.5 flex items-baseline justify-between px-1">
                    <span
                      className={cx(
                        'text-[11.5px] uppercase tracking-wide',
                        isToday ? 'text-ink font-semibold' : 'text-ink-3',
                      )}
                    >
                      {d.date.toLocaleDateString('en-US', { weekday: 'short' })}
                    </span>
                    <span
                      className={cx(
                        'text-[12.5px] tabular',
                        isToday ? 'text-ink font-semibold' : 'text-ink-2',
                      )}
                      aria-current={isToday ? 'date' : undefined}
                    >
                      {d.date.getDate()}
                    </span>
                  </div>
                  {isToday && <div className="-mt-1.5 mb-2.5 mx-1 h-px bg-ink" aria-hidden />}
                  <ul className="space-y-2">
                    {d.calls.map((c) => {
                      const p = c.personId ? people.get(c.personId) : undefined;
                      const done = new Date(c.endAt || c.startAt).getTime() < Date.now();
                      return (
                        <li key={c.id} data-testid="chats-week-call">
                          <Link
                            to={callHref(p)}
                            className={cx(
                              'relative block rounded-[6px] border border-line-2 bg-canvas py-2.5 pl-3.5 pr-2.5 transition-colors hover:border-line hover:bg-canvas-2/60',
                              done && 'text-ink-3',
                            )}
                          >
                            {/* a straight mark down the left, inside the card: dark ahead, faint once it is over */}
                            <span
                              className={cx(
                                'absolute left-[5px] top-2.5 bottom-2.5 w-[2px]',
                                done ? 'bg-line' : 'bg-ink',
                              )}
                              aria-hidden
                            />
                            <span
                              className={cx(
                                'block text-[11.5px] tabular',
                                done ? 'text-ink-3' : 'text-ink-2',
                              )}
                            >
                              {clockTime(new Date(c.startAt))}
                            </span>
                            <span className="mt-1.5 flex items-center gap-2 min-w-0">
                              {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={20} />}
                              <span className={cx('text-[13px] font-medium truncate', !done && 'text-ink')}>
                                {callName(c, p)}
                              </span>
                            </span>
                            {p?.currentOrganizationRaw && (
                              <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-3 min-w-0">
                                <PersonCompanyLogo person={p} size={12} />
                                <span className="truncate">{p.currentOrganizationRaw}</span>
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
          {/* a phone: the days with calls, one under the other */}
          <ul className="@3xl:hidden divide-y divide-line-2 border-y border-line-2">
            {week?.days
              .filter((d) => d.calls.length)
              .map((d) => (
                <li key={d.date.toISOString()} className="py-2.5">
                  <div className="text-[12px] text-ink-3 mb-1">
                    {d.date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                  </div>
                  {d.calls.map((c) => {
                    const p = c.personId ? people.get(c.personId) : undefined;
                    return (
                      <div key={c.id} className="flex items-center gap-2.5 py-1 text-[13.5px]">
                        <span className="w-16 text-ink-2 tabular">{clockTime(new Date(c.startAt))}</span>
                        {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={22} />}
                        <span className="font-medium truncate">{p?.displayName ?? c.title}</span>
                        {c.conferenceUrl && <Video size={13} className="text-ink-3" aria-hidden />}
                      </div>
                    );
                  })}
                </li>
              ))}
            {week && !week.total && <li className="py-4 text-[13px] text-ink-3">No calls this week.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

/** Where a call opens: the person's prep, else the chats page. */
const callHref = (p: Person | undefined) => (p ? `/people/${p.id}?prep=1` : '/chats');
const callName = (c: WeekCall, p: Person | undefined, full = false) =>
  (full ? p?.displayName : p?.firstName) ?? c.title.replace(/^Coffee chat with /i, '');

/** A month of whole weeks: each day its number and its calls in short (time and first name), three at most. */
function MonthGrid({
  view,
  month,
  today,
  people,
}: {
  view: Awaited<ReturnType<typeof callsMonth>> | undefined;
  month: Date;
  today: Date;
  people: Map<string, Person>;
}) {
  const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div data-testid="chats-month">
      <div className="grid grid-cols-7 border-b border-line-2 text-[11.5px] uppercase tracking-wide text-ink-3">
        {heads.map((h) => (
          <div key={h} className="px-2 py-1.5">
            {h}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 divide-x divide-line-2 border-b border-line-2">
        {(view?.days ?? []).map((d, i) => {
          const own = d.date.getMonth() === month.getMonth();
          const isToday = d.date.getTime() === today.getTime();
          const shown = d.calls.slice(0, 3);
          return (
            <div
              key={d.date.toISOString()}
              className={cx(
                'min-h-[96px] p-1.5 border-line-2',
                i >= 7 && 'border-t',
                !own && 'bg-canvas-2/40',
              )}
            >
              <div className="mb-1 flex justify-end">
                <span
                  className={cx(
                    'text-[12px] tabular',
                    isToday
                      ? 'text-ink font-semibold underline decoration-ink underline-offset-4'
                      : own
                        ? 'text-ink-2'
                        : 'text-ink-3',
                  )}
                >
                  {d.date.getDate()}
                </span>
              </div>
              <ul className="space-y-0.5">
                {shown.map((c) => {
                  const p = c.personId ? people.get(c.personId) : undefined;
                  return (
                    <li key={c.id} data-testid="chats-month-call">
                      <Link
                        to={callHref(p)}
                        className="flex items-center gap-1.5 rounded-[4px] px-1 py-0.5 text-[12px] hover:bg-canvas-2 min-w-0"
                        title={`${clockTime(new Date(c.startAt))} ${callName(c, p, true)}`}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" aria-hidden />
                        <span className="tabular text-ink-3 shrink-0">{clockTime(new Date(c.startAt))}</span>
                        <span className="truncate font-medium">{callName(c, p)}</span>
                      </Link>
                    </li>
                  );
                })}
                {d.calls.length > shown.length && (
                  <li className="px-1 text-[11.5px] text-ink-3">{d.calls.length - shown.length} more</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Whole minutes a call runs, when it has an end ("30 min", "1 hr", "1 hr 30 min"). */
function callLength(c: WeekCall): string | undefined {
  const min = Math.round((new Date(c.endAt).getTime() - new Date(c.startAt).getTime()) / 60_000);
  if (!(min > 0) || min > 12 * 60) return undefined;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * The list, as an agenda: the day stands in a column at the left, said once for all its calls (a number with its
 * weekday, or Today, Tomorrow, Yesterday), then the time with how long the call runs, the person, and what to do
 * about it. A call that is over offers a note instead of a link to join. Months are named where they change, so a
 * long run of days reads as a calendar and not as a column of headings.
 */
function CallList({
  list,
  people,
}: {
  list: Awaited<ReturnType<typeof callsList>> | undefined;
  people: Map<string, Person>;
}) {
  if (!list) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const near = (d: Date): string | undefined => {
    const at = new Date(d);
    at.setHours(0, 0, 0, 0);
    const days = Math.round((at.getTime() - today.getTime()) / DAY);
    return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : undefined;
  };
  const section = (
    title: string,
    calls: WeekCall[],
    empty: string,
    testId: string,
    past: boolean,
  ): ReactNode => {
    let lastDay = '';
    let lastMonth = '';
    return (
      <section className="mb-8 max-w-[860px]" data-testid={testId}>
        <h3 className="mb-2 flex items-baseline gap-2 text-[12px] font-medium uppercase tracking-wide text-ink-3">
          {title}
          {calls.length > 0 && <span className="tabular font-normal normal-case">{calls.length}</span>}
        </h3>
        {calls.length === 0 ? (
          <p className="border-t border-line-2 py-3 text-[13px] text-ink-3">{empty}</p>
        ) : (
          <ul className="border-t border-line-2">
            {calls.map((c) => {
              const p = c.personId ? people.get(c.personId) : undefined;
              const at = new Date(c.startAt);
              const key = dayKey(at);
              const first = key !== lastDay;
              lastDay = key;
              const month = at.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
              const newMonth = month !== lastMonth;
              lastMonth = month;
              const length = callLength(c);
              const word = near(at);
              const role = p ? [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') : '';
              return (
                <li key={c.id} data-testid="chats-list-call">
                  {newMonth && (
                    <div
                      className="bg-canvas-2/50 px-3 py-1.5 text-[11.5px] text-ink-3 border-b border-line-2"
                      data-testid="chats-list-month"
                    >
                      {month}
                    </div>
                  )}
                  <div
                    className={cx(
                      'group grid grid-cols-[64px_84px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 transition-colors hover:bg-canvas-2/50',
                      // one rule between days; calls on the same day sit together
                      first && !newMonth && 'border-t border-line-2',
                    )}
                  >
                    <div className="self-start pt-0.5" data-testid="chats-list-day">
                      {first &&
                        (word ? (
                          <span className={cx('text-[12.5px] font-medium', past ? 'text-ink-2' : 'text-ink')}>
                            {word}
                          </span>
                        ) : (
                          <span className="flex items-baseline gap-1.5">
                            <span
                              className={cx(
                                'text-[17px] leading-none tabular font-medium',
                                past ? 'text-ink-2' : 'text-ink',
                              )}
                            >
                              {at.getDate()}
                            </span>
                            <span className="text-[11px] uppercase tracking-wide text-ink-3">
                              {at.toLocaleDateString('en-US', { weekday: 'short' })}
                            </span>
                          </span>
                        ))}
                    </div>
                    <div className="leading-tight">
                      <span className={cx('block text-[13px] tabular', past ? 'text-ink-3' : 'text-ink-2')}>
                        {clockTime(at)}
                      </span>
                      {length && <span className="block text-[11.5px] text-ink-3">{length}</span>}
                    </div>
                    <div className="flex min-w-0 items-center gap-2.5">
                      {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />}
                      <span className="min-w-0">
                        {p ? (
                          <Link
                            to={`/people/${p.id}`}
                            className="block truncate text-[13.5px] font-medium hover:underline"
                          >
                            {p.displayName}
                          </Link>
                        ) : (
                          <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                        )}
                        {p && role && (
                          <span className="flex min-w-0 items-center gap-1 text-[12px] text-ink-3">
                            {p.currentOrganizationRaw && <PersonCompanyLogo person={p} size={12} />}
                            <span className="truncate">{role}</span>
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {!past && c.conferenceUrl && (
                        <a
                          href={c.conferenceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-line px-2.5 text-[12.5px] text-ink hover:bg-canvas-2"
                          data-testid="chats-list-join"
                        >
                          <Video size={13} aria-hidden /> Join
                        </a>
                      )}
                      {p && !past && (
                        <Link
                          to={callHref(p)}
                          className="inline-flex h-7 items-center rounded-[6px] px-2.5 text-[12.5px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
                          data-testid="chats-list-prep"
                        >
                          Prep
                        </Link>
                      )}
                      {p && past && (
                        <Link
                          to={`/notes/new?person=${p.id}`}
                          className="inline-flex h-7 items-center rounded-[6px] px-2.5 text-[12.5px] text-ink-3 hover:bg-canvas-2 hover:text-ink"
                          data-testid="chats-list-note"
                        >
                          Add a note
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  };
  return (
    <div data-testid="chats-list">
      {section('Coming up', list.upcoming, 'No calls coming up.', 'chats-list-upcoming', false)}
      {section('Earlier', list.past, 'No calls in the last 30 days.', 'chats-list-past', true)}
    </div>
  );
}
