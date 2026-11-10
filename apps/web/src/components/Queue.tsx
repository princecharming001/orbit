/**
 * Drafts, Scheduled (plan 38 §C): every email waiting for its time, by day against the day's limit, the next one in
 * words, each batch's progress with Cancel the rest, and on each row Send now, Move to the next day and Cancel.
 */
import type { OutboundMessage, Person, User } from '@orbit/core';
import { draftKindLabel } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type BatchRow, db } from '../db/schema';
import { type BatchProgress, batchProgress, dailyEmailCap } from '../engine/batch';
import { clockTime } from '../engine/batchTime';
import { cancelSend, moveToNextDay, queueDays, sendNow } from '../engine/queue';
import { lastTouch } from '../engine/search';
import { Avatar, Button, EmptyState, useToast } from '../ui';
import { PersonCompanyLogo } from './CompanyLogo';

const TAP = 'pointer-coarse:min-h-11';

export function Queue({
  user,
  rows,
  byId,
}: {
  user: User;
  rows: OutboundMessage[];
  byId: Map<string, Person>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const [cap, setCap] = useState(15);
  useEffect(() => {
    void dailyEmailCap(user.id).then(setCap);
  }, [user.id]);
  const days = queueDays(rows);
  const total = days.reduce((n, d) => n + d.rows.length, 0);
  const batches = useLiveQuery(
    async () => {
      const bs = (await db.batches.where('userId').equals(user.id).toArray()).filter((b) => !!b.scheduledAt);
      const out: { batch: BatchRow; progress: BatchProgress }[] = [];
      for (const b of bs) {
        const progress = await batchProgress(b);
        if (progress.scheduled > 0) out.push({ batch: b, progress });
      }
      return out.sort((a, b) => (a.progress.nextAt ?? '').localeCompare(b.progress.nextAt ?? ''));
    },
    [user.id, rows.map((r) => `${r.id}:${r.status}`).join(',')],
    [],
  );
  if (!total)
    return (
      <EmptyState
        title="Nothing scheduled"
        body="Pick people on People and choose Write to them, and the emails wait here with the time each one goes."
        action={
          <Link to="/people?view=list">
            <Button variant="secondary">Pick people</Button>
          </Link>
        }
      />
    );
  const first = days[0]!.rows[0]!;
  const firstWho = byId.get(first.personId);
  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      const ok = await run();
      toast.push({
        text: ok ? done : 'That did not work. Try again in a moment.',
        tone: ok ? 'good' : 'bad',
      });
    } finally {
      setBusy(undefined);
    }
  };
  const cancelRest = (b: BatchRow) =>
    act(
      `rest:${b.id}`,
      async () => {
        const left = rows.filter((r) => b.draftIds.includes(r.id) && days.some((d) => d.rows.includes(r)));
        let n = 0;
        for (const o of left) if (await cancelSend(user, o)) n++;
        return n > 0;
      },
      'The rest are drafts again.',
    );
  return (
    <div data-testid="drafts-scheduled">
      <p className="text-[13.5px] text-ink-2" data-testid="queue-next">
        <span className="font-medium text-ink">
          {total} {total === 1 ? 'email' : 'emails'} scheduled.
        </span>{' '}
        Next: {firstWho?.displayName ?? 'someone'},{' '}
        {new Date(first.sendAt!).toLocaleDateString('en-US', { weekday: 'short' })}{' '}
        {clockTime(new Date(first.sendAt!))}.
      </p>
      <p className="mt-1 text-[12.5px] text-ink-3 max-w-[70ch]">
        Each one is checked again at its time and held back if they replied. Times are yours; each goes in its
        recipient's working hours.
      </p>
      {batches.length > 0 && (
        <ul className="mt-5 divide-y divide-line-2 border-y border-line-2" data-testid="queue-batches">
          {batches.map(({ batch: b, progress: p }) => (
            <li
              key={b.id}
              className="py-3 flex flex-wrap items-center gap-x-4 gap-y-2"
              data-testid="queue-batch"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{b.name}</div>
                <div className="text-[12.5px] text-ink-3 tabular">
                  {p.sent} sent · {p.replied} replied · {p.scheduled} to go
                </div>
              </div>
              <span className="h-1.5 w-28 rounded-full bg-line-2 overflow-hidden" aria-hidden>
                <span
                  className="block h-full bg-accent"
                  style={{ width: `${Math.round((p.sent / Math.max(1, p.total)) * 100)}%` }}
                />
              </span>
              <Button
                size="sm"
                variant="ghost"
                className={TAP}
                loading={busy === `rest:${b.id}`}
                onClick={() => void cancelRest(b)}
                data-testid="queue-cancel-rest"
              >
                Cancel the rest
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 space-y-7">
        {days.map((d) => (
          <section key={d.key} data-testid="queue-day">
            <div className="mb-2 flex items-center gap-3">
              <h3 className="text-[13.5px] font-semibold">{d.label}</h3>
              <span className="h-1.5 w-20 rounded-full bg-line-2 overflow-hidden" aria-hidden>
                <span
                  className="block h-full bg-accent"
                  style={{ width: `${Math.min(100, (d.rows.length / cap) * 100)}%` }}
                />
              </span>
              <span className="text-[12px] text-ink-3 tabular" data-testid="queue-day-count">
                {d.rows.length} of {cap}
              </span>
            </div>
            <ul className="divide-y divide-line-2 border-y border-line-2">
              {d.rows.map((o) => {
                const p = byId.get(o.personId);
                return (
                  <li
                    key={o.id}
                    className="group py-2.5 flex items-center gap-3"
                    data-testid="scheduled-item"
                  >
                    <span
                      className="w-[4.5rem] shrink-0 text-[12.5px] text-ink-2 tabular"
                      data-testid="scheduled-at"
                    >
                      {clockTime(new Date(o.sendAt!))}
                    </span>
                    {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={26} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[13.5px] min-w-0">
                        <Link
                          to={p ? `/people/${p.id}` : '#'}
                          className="font-medium truncate hover:underline"
                        >
                          {p?.displayName ?? 'Someone'}
                        </Link>
                        {p && <PersonCompanyLogo person={p} size={13} />}
                        <span className="text-[12px] text-ink-3 truncate">
                          {draftKindLabel(o.kind, p && lastTouch(p))}
                        </span>
                      </div>
                      <p className="text-[12.5px] text-ink-3 truncate">
                        {o.subject || (o.bodyFinal ?? o.bodyDraft)}
                      </p>
                    </div>
                    <span className="flex items-center gap-0.5 shrink-0 opacity-100 @3xl:opacity-60 @3xl:group-hover:opacity-100 focus-within:opacity-100">
                      <Button
                        size="sm"
                        variant="ghost"
                        className={TAP}
                        loading={busy === `now:${o.id}`}
                        onClick={() =>
                          void act(
                            `now:${o.id}`,
                            () => sendNow(user, o),
                            `Sending to ${p?.firstName ?? 'them'} now.`,
                          )
                        }
                        aria-label={`Send to ${p?.firstName ?? 'them'} now`}
                        data-testid="scheduled-send-now"
                      >
                        <Send size={13} aria-hidden />
                        <span className="hidden @2xl:inline">Send now</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className={TAP}
                        loading={busy === `move:${o.id}`}
                        onClick={() =>
                          void act(
                            `move:${o.id}`,
                            () => moveToNextDay(user, o),
                            `Moved to the next working day for ${p?.firstName ?? 'them'}.`,
                          )
                        }
                        aria-label={`Move ${p?.firstName ?? 'it'} to the next day`}
                        data-testid="scheduled-move"
                      >
                        <ArrowRight size={13} aria-hidden />
                        <span className="hidden @2xl:inline">Next day</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className={TAP}
                        loading={busy === `cancel:${o.id}`}
                        onClick={() =>
                          void act(
                            `cancel:${o.id}`,
                            () => cancelSend(user, o),
                            `The message to ${p?.firstName ?? 'them'} is a draft again.`,
                          )
                        }
                        aria-label={`Cancel the message to ${p?.firstName ?? 'them'}`}
                        data-testid="scheduled-cancel"
                      >
                        <X size={13} aria-hidden />
                        <span className="hidden @2xl:inline">Cancel</span>
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
