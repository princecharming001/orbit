/**
 * Sent for you (plan 23 §4.9, plan 29 §B1): what Orbit sent on its own, the kinds the student handed over, and now the
 * replies it answered and the calls it booked. Each says when it goes (in the recipient's morning, never sooner than a
 * minute) with Undo until then, then when it went, in their time, and "booked" when the reply booked a call. Local
 * mode reads this browser's outbox; an account also reads the server's status.
 */
import type { AutopilotItem, OutboundMessage } from '@orbit/core';
import { MESSAGE_KIND_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { undoQueued } from '../engine/send';
import { personZone } from '../engine/trust';
import { callApi } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Button, Card, useToast } from '../ui';
import type { AutopilotView } from './autopilot/useAutopilotStatus';

/** Undo is offered this long before a send Orbit chose a time for (plan 29 §B1). */
export const UNDO_MS = 60_000;

export const clock = (iso: string, tz?: string) =>
  new Date(iso)
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined })
    .replace(/\s?([AP])M$/i, (_, x: string) => ` ${x.toLowerCase()}m`);

/** "Sent 8:41 am their time · booked", or the countdown while it can still be undone. */
export function sentLine(
  i: Pick<AutopilotItem, 'status' | 'sentAt' | 'sendAt' | 'outcome'>,
  now: number,
  tz?: string,
): string {
  if (i.status === 'sent' && i.sentAt)
    return `Sent ${clock(i.sentAt, tz)} their time${i.outcome === 'booked' ? ' · booked' : ''}`;
  const left = Math.ceil(((i.sendAt ? Date.parse(i.sendAt) : now) - now) / 1000);
  if (left <= 60) return left > 0 ? `Sending in ${left} s` : 'Sending now';
  return `Goes ${clock(i.sendAt!, tz)} their time`;
}

/** Undo shows while the send is still ahead (and within the minute for a reply Orbit chose a time for). */
export function canUndo(i: Pick<AutopilotItem, 'status' | 'sendAt'>, now: number): boolean {
  return i.status === 'queued' && !!i.sendAt && Date.parse(i.sendAt) > now;
}

export function SentForYou({ view }: { view?: AutopilotView }) {
  const { user, userId } = useSession();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // a countdown on screen: nothing to redraw while the tab is hidden
    const t = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const rows = useLiveQuery(async () => {
    if (!userId) return [];
    const out = await db.outbound
      .where('userId')
      .equals(userId)
      .filter(
        (o) =>
          !!o.autoSent &&
          (o.status === 'queued' ||
            o.status === 'sending' ||
            (o.status === 'sent' && !!o.sentAt && Date.now() - Date.parse(o.sentAt) < 3 * 86_400_000)),
      )
      .toArray();
    const people = await db.people.bulkGet(out.map((o) => o.personId));
    return out
      .map((o, i) => ({ o, p: people[i] }))
      .sort((a, b) => (b.o.sendAt ?? b.o.sentAt ?? '').localeCompare(a.o.sendAt ?? a.o.sentAt ?? ''));
  }, [userId]);
  // the server's own (an account): the replies it answered and the calls it booked, and what is queued for the morning
  const local = new Set((rows ?? []).map((r) => r.o.id));
  const server: AutopilotItem[] = view?.local
    ? []
    : [
        ...(view?.status?.sentToday ?? []),
        ...(view?.status?.queued ?? []).filter((q) => q.kind === 'reply' || q.kind === 'schedule'),
      ].filter((i) => !local.has(i.draftId));
  if (!user || (!rows?.length && !server.length)) return null;
  const line = (o: OutboundMessage, tz?: string) =>
    sentLine(
      { status: o.status === 'sent' ? 'sent' : 'queued', sentAt: o.sentAt ?? null, sendAt: o.sendAt ?? null },
      now,
      tz,
    );
  const undoLocal = async (o: OutboundMessage) => {
    const undone = await undoQueued(user, o.id);
    // back in the student's hands: it counts as theirs again, and the undo is kept for the ladder's watch (plan 23 §6.5)
    if (undone) {
      await db.outbound.update(o.id, { autoSent: undefined });
      const k = `trust:undone:${user.id}`;
      const n = Number((await db.kv.get(k))?.value ?? 0);
      await db.kv.put({ key: k, value: n + 1 });
    }
    toast.push({
      text: undone ? 'Not sent. The draft is back in Drafts.' : 'Too late, it already went out.',
    });
  };
  const undoServer = async (i: AutopilotItem) => {
    const r = await callApi('/drafts/cancel', { draftId: i.draftId });
    toast.push({ text: r.ok ? 'Not sent. The draft is back in Drafts.' : r.message });
    await view?.refresh();
  };
  return (
    <Card data-testid="sent-for-you">
      <div className="font-medium mb-1">Sent for you</div>
      <p className="text-[12.5px] text-ink-3 mb-3">
        What Orbit sends on its own, the kinds you handed over in{' '}
        <Link to="/settings/limits" className="underline underline-offset-2 hover:text-ink">
          Settings
        </Link>
        , and the replies and bookings it finished.
      </p>
      <ul className="space-y-2.5">
        {(rows ?? []).map(({ o, p }) => {
          const tz = p ? personZone(p) : undefined;
          return (
            <li key={o.id} className="text-[13px]" data-testid="sent-item">
              <div className="flex items-center gap-2" data-testid="sent-for-you-row">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{MESSAGE_KIND_LABELS[o.kind]}</span> to{' '}
                  {p?.displayName ?? 'them'}
                </span>
                {o.status === 'queued' && (
                  <Button size="sm" onClick={() => void undoLocal(o)} data-testid="sent-for-you-undo">
                    Undo
                  </Button>
                )}
              </div>
              <div className="text-[12px] text-ink-3" data-testid="sent-for-you-when">
                {line(o, tz)}
              </div>
            </li>
          );
        })}
        {server.map((i) => (
          <li key={i.draftId} className="text-[13px]" data-testid="sent-item">
            <div className="flex items-center gap-2" data-testid="sent-for-you-row">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{MESSAGE_KIND_LABELS[i.kind]}</span> to {i.personName}
                {i.company ? <span className="text-ink-3"> · {i.company}</span> : null}
              </span>
              {canUndo(i, now) && (
                <Button size="sm" onClick={() => void undoServer(i)} data-testid="sent-for-you-undo">
                  Undo
                </Button>
              )}
            </div>
            <div className="text-[12px] text-ink-3" data-testid="sent-for-you-when">
              {sentLine(i, now, user.timezone)}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
