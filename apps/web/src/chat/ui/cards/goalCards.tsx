/**
 * The chats and the week as pictures rather than lines of text: chats grouped by when, each with the face, the time
 * and what came back; the week as four numbers (reached against the target, replied, booked, went quiet) with the
 * faces behind each, then what moved.
 */
import { Check, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Avatar, cx } from '../../../ui';
import { CardHead, GlassCard, type NextStep, NextSteps } from './parts';
import type { ChatCardRow, WeekCardView, WeekFace } from './shapes';

export function ChatsCard({
  rows,
  href,
  steps,
  send,
}: {
  rows: ChatCardRow[];
  href?: string;
  steps: NextStep[];
  send: (text: string) => Promise<void> | void;
}) {
  const groups: { when: string; rows: ChatCardRow[] }[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.when === r.when);
    if (g) g.rows.push(r);
    else groups.push({ when: r.when, rows: [r] });
  }
  return (
    <GlassCard kind="list">
      <CardHead title="Your chats" href={href} />
      <div className="space-y-4" data-testid="chats-card">
        {groups.map((g) => (
          <section key={g.when}>
            <h4 className="text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3 mb-1">
              {g.when}
            </h4>
            <ul className="divide-y divide-line-2">
              {g.rows.map((r) => (
                <li
                  key={`${r.personId}:${r.time ?? r.when}`}
                  className="flex items-center gap-3 py-2.5 min-w-0"
                >
                  <Link to={`/people/${r.personId}`} className="shrink-0" tabIndex={-1} aria-hidden>
                    <Avatar name={r.name} src={r.photoUrl} id={r.personId} size={36} />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link to={r.href ?? `/people/${r.personId}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    {r.role && <div className="text-[12.5px] text-ink-3 truncate mt-0.5">{r.role}</div>}
                    {!!r.after?.length && (
                      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2">
                        {r.after.map((a) => (
                          <li key={a} className="inline-flex items-center gap-1">
                            <Check size={12} className="text-good" aria-hidden /> {a}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {r.time ? (
                    <div className="shrink-0 text-right">
                      <div className="text-[15px] font-semibold tabular leading-tight">{r.time}</div>
                      <div className="mt-0.5 flex items-center justify-end gap-2 text-[12px] text-ink-3">
                        {r.minutes ? <span>{r.minutes} min</span> : null}
                        {r.join && (
                          <a
                            href={r.join}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-ink"
                          >
                            <Video size={12} aria-hidden /> Join
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    !r.after?.length && <span className="shrink-0 text-[12px] text-ink-3">No time yet</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <NextSteps steps={steps} send={send} />
    </GlassCard>
  );
}

function Faces({ people }: { people: WeekFace[] }) {
  if (!people.length) return <div className="h-6" />;
  const shown = people.slice(0, 4);
  return (
    <div className="flex items-center" title={people.map((p) => p.name).join(', ')}>
      {shown.map((p, i) => (
        <Link
          key={p.personId}
          to={`/people/${p.personId}`}
          className={cx('rounded-full ring-2 ring-canvas', i > 0 && '-ml-1.5')}
          aria-label={p.name}
        >
          <Avatar name={p.name} src={p.photoUrl} id={p.personId} size={24} />
        </Link>
      ))}
      {people.length > shown.length && (
        <span className="ml-1.5 text-[12px] text-ink-3">+{people.length - shown.length}</span>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  of,
  people,
  tone,
}: {
  label: string;
  value: number;
  of?: number;
  people: WeekFace[];
  tone?: 'warn' | 'good';
}) {
  return (
    <div className="min-w-0 py-3 pr-3" data-testid={`week-${label.replace(/\s+/g, '-')}`}>
      <div className="flex items-baseline gap-1">
        <span
          className={cx(
            'text-[26px] font-semibold tabular leading-none',
            tone === 'warn' && value > 0 && 'text-warn',
            tone === 'good' && value > 0 && 'text-good',
          )}
        >
          {value}
        </span>
        {of !== undefined && <span className="text-[13px] text-ink-3 tabular">of {of}</span>}
      </div>
      <div className="mt-1 text-[12.5px] text-ink-3">{label}</div>
      {of !== undefined && of > 0 && (
        <div className="mt-2 h-1 w-full max-w-[120px] bg-line-2" aria-hidden>
          <div
            className="h-full bg-ink"
            style={{ width: `${Math.min(100, Math.round((value / of) * 100))}%` }}
          />
        </div>
      )}
      <div className="mt-2">
        <Faces people={people} />
      </div>
    </div>
  );
}

export function WeekCard({
  week,
  href,
  steps,
  send,
}: {
  week: WeekCardView;
  href?: string;
  steps: NextStep[];
  send: (text: string) => Promise<void> | void;
}) {
  return (
    <GlassCard kind="list">
      <CardHead title="Your week" href={href} />
      <div
        className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-line-2 border-y border-line-2 [&>*:not(:first-child)]:pl-3"
        data-testid="week-card"
      >
        <Stat
          label="first messages"
          value={week.reached.length}
          of={week.target || undefined}
          people={week.reached}
        />
        <Stat label="replied" value={week.replied.length} people={week.replied} tone="good" />
        <Stat label="chats booked" value={week.booked.length} people={week.booked} tone="good" />
        <Stat label="went quiet" value={week.quiet.length} people={week.quiet} tone="warn" />
      </div>
      {week.moved.length > 0 && (
        <div className="mt-4">
          <div className="text-[11.5px] font-medium text-ink-3 mb-1">What moved</div>
          <ul className="divide-y divide-line-2">
            {week.moved.map((m) => (
              <li key={`${m.personId}:${m.text}`} className="flex items-center gap-3 py-2 min-w-0">
                <Avatar name={m.name || m.text} id={m.personId} size={24} />
                <Link to={`/people/${m.personId}`} className="min-w-0 truncate hover:underline">
                  {m.text}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <NextSteps steps={steps} send={send} />
    </GlassCard>
  );
}
