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
  const [offset, setOffset] = useState(0);
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
                  className={cx('min-h-[150px] p-1.5', past && 'bg-canvas-2/40')}
                >
                  <div className="mb-1.5 flex items-baseline justify-between px-1">
                    <span
                      className={cx(
                        'text-[11.5px] uppercase tracking-wide',
                        isToday ? 'text-accent font-semibold' : 'text-ink-3',
                      )}
                    >
                      {d.date.toLocaleDateString('en-US', { weekday: 'short' })}
                    </span>
                    <span
                      className={cx(
                        'text-[12.5px] tabular',
                        isToday
                          ? 'h-6 w-6 inline-flex items-center justify-center rounded-full bg-accent text-white font-medium'
                          : 'text-ink-2',
                      )}
                    >
                      {d.date.getDate()}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {d.calls.map((c) => {
                      const p = c.personId ? people.get(c.personId) : undefined;
                      return (
                        <li key={c.id} data-testid="chats-week-call">
                          <Link
                            to={p ? `/people/${p.id}?prep=1` : '/chats'}
                            className={cx(
                              'block rounded-[8px] border-l-[3px] px-2 py-1.5 hover:brightness-[0.98] transition',
                              past ? 'border-line bg-canvas text-ink-3' : 'border-accent bg-accent-soft',
                            )}
                          >
                            <span className="block text-[11.5px] tabular text-ink-2">
                              {clockTime(new Date(c.startAt))}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1.5 min-w-0">
                              {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={18} />}
                              <span className="text-[12.5px] font-medium truncate">
                                {p?.firstName ?? c.title.replace(/^Coffee chat with /i, '')}
                              </span>
                            </span>
                            {p?.currentOrganizationRaw && (
                              <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-ink-3 min-w-0">
                                <PersonCompanyLogo person={p} size={11} />
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
          {week && !week.total && (
            <p className="hidden @3xl:block mt-2 text-[12.5px] text-ink-3" data-testid="chats-week-empty">
              No calls this week. Calls Orbit books from replies land here.
            </p>
          )}
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
                      ? 'h-6 w-6 inline-flex items-center justify-center rounded-full bg-accent text-white font-medium'
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
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
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

/** The list: what is coming by day, then what happened, each call a row with the person and their company. */
function CallList({
  list,
  people,
}: {
  list: Awaited<ReturnType<typeof callsList>> | undefined;
  people: Map<string, Person>;
}) {
  if (!list) return null;
  const group = (calls: WeekCall[]) => {
    const out: { day: string; calls: WeekCall[] }[] = [];
    for (const c of calls) {
      const day = new Date(c.startAt).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });
      const last = out[out.length - 1];
      if (last?.day === day) last.calls.push(c);
      else out.push({ day, calls: [c] });
    }
    return out;
  };
  const section = (title: string, calls: WeekCall[], empty: string, testId: string): ReactNode => (
    <div className="mb-6" data-testid={testId}>
      <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-ink-3">{title}</h3>
      {calls.length === 0 ? (
        <p className="py-2 text-[13px] text-ink-3">{empty}</p>
      ) : (
        group(calls).map((g) => (
          <div key={g.day} className="border-t border-line-2 py-2">
            <div className="mb-1 text-[12.5px] text-ink-2">{g.day}</div>
            <ul>
              {g.calls.map((c) => {
                const p = c.personId ? people.get(c.personId) : undefined;
                return (
                  <li key={c.id} className="flex items-center gap-3 py-1.5" data-testid="chats-list-call">
                    <span className="w-[68px] shrink-0 text-[13px] tabular text-ink-2">
                      {clockTime(new Date(c.startAt))}
                    </span>
                    {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={26} />}
                    <span className="min-w-0 flex-1">
                      {p ? (
                        <Link
                          to={`/people/${p.id}`}
                          className="block text-[13.5px] font-medium truncate hover:underline"
                        >
                          {p.displayName}
                        </Link>
                      ) : (
                        <span className="block text-[13.5px] font-medium truncate">{c.title}</span>
                      )}
                      {p?.currentOrganizationRaw && (
                        <span className="flex items-center gap-1 text-[12px] text-ink-3 min-w-0">
                          <PersonCompanyLogo person={p} size={12} />
                          <span className="truncate">
                            {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ')}
                          </span>
                        </span>
                      )}
                    </span>
                    {c.conferenceUrl && (
                      <a
                        href={c.conferenceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink"
                      >
                        <Video size={13} aria-hidden /> Join
                      </a>
                    )}
                    {p && (
                      <Link to={callHref(p)} className="text-[12.5px] text-ink-2 hover:text-ink">
                        Prep
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </div>
  );
  return (
    <div data-testid="chats-list">
      {section(
        'Coming up',
        list.upcoming,
        'No calls coming up. Calls Orbit books from replies land here.',
        'chats-list-upcoming',
      )}
      {section('Earlier', list.past, 'No calls in the last 30 days.', 'chats-list-past')}
    </div>
  );
}
