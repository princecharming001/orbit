/**
 * The week's calls (plan 38 §F): seven columns, each call a block with its time, the face and the company, today
 * marked, arrows to the weeks around it. Above it, the outreach in three numbers: written to, replied, booked. On a
 * phone the week reads as a list of the days that have calls.
 */
import type { Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { clockTime } from '../../engine/batchTime';
import { callsWeek, outreachFunnel, weekStart } from '../../engine/callsWeek';
import { Avatar, cx } from '../../ui';
import { PersonCompanyLogo } from '../CompanyLogo';

const DAY = 86_400_000;

export function WeekCalendar({ userId }: { userId: string }) {
  const [offset, setOffset] = useState(0);
  const start = useMemo(() => {
    const s = weekStart(new Date());
    s.setDate(s.getDate() + offset * 7);
    return s;
  }, [offset]);
  const week = useLiveQuery(() => callsWeek(userId, start), [userId, start.getTime()]);
  const funnel = useLiveQuery(() => outreachFunnel(userId), [userId]);
  const people = useLiveQuery(
    async () => {
      const ids =
        week?.days.flatMap((d) => d.calls.map((c) => c.personId).filter((x): x is string => !!x)) ?? [];
      return new Map(
        (await db.people.bulkGet([...new Set(ids)])).filter((p): p is Person => !!p).map((p) => [p.id, p]),
      );
    },
    [week],
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="section-title">{offset === 0 ? 'This week' : offset === 1 ? 'Next week' : range}</h2>
          <span className="text-[12.5px] text-ink-3 tabular">
            {week ? `${week.total} ${week.total === 1 ? 'call' : 'calls'}` : ''}
            {offset === 0 || offset === 1 ? ` · ${range}` : ''}
          </span>
        </div>
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
            aria-label="The week before"
            data-testid="chats-week-prev"
          >
            <ChevronLeft size={15} aria-hidden />
          </button>
          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-line hover:bg-canvas-2"
            onClick={() => setOffset((o) => o + 1)}
            aria-label="The week after"
            data-testid="chats-week-next"
          >
            <ChevronRight size={15} aria-hidden />
          </button>
        </div>
      </div>
      <div className="hidden @3xl:grid grid-cols-7 border-y border-line-2 divide-x divide-line-2">
        {(
          week?.days ??
          Array.from({ length: 7 }, (_, i) => ({ date: new Date(start.getTime() + i * DAY), calls: [] }))
        ).map((d) => {
          const isToday = d.date.getTime() === today.getTime();
          const past = d.date < today;
          return (
            <div key={d.date.toISOString()} className={cx('min-h-[150px] p-1.5', past && 'bg-canvas-2/40')}>
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
    </section>
  );
}
