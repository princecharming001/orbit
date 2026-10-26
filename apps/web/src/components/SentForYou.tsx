/**
 * Sent for you (plan 23 §4.9): what Orbit sent on its own, a kind the student handed over. Each says when it goes (in
 * the recipient's morning, never sooner than a minute) with Undo until then, then when it went, in their time.
 */
import { MESSAGE_KIND_LABELS, type OutboundMessage } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { undoQueued } from '../engine/send';
import { personZone } from '../engine/trust';
import { useSession } from '../state/session';
import { Button, Card, useToast } from '../ui';

const clock = (iso: string, tz?: string) =>
  new Date(iso)
    .toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz })
    .replace(/\s?([AP])M$/i, (_, x: string) => ` ${x.toLowerCase()}m`);

export function SentForYou() {
  const { user, userId } = useSession();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
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
  if (!user || !rows?.length) return null;
  const line = (o: OutboundMessage, tz?: string) => {
    if (o.status === 'sent' && o.sentAt) return `Sent ${clock(o.sentAt, tz)} their time`;
    const left = Math.ceil(((o.sendAt ? Date.parse(o.sendAt) : now) - now) / 1000);
    if (left <= 60) return left > 0 ? `Sending in ${left} s` : 'Sending now';
    return `Goes ${clock(o.sendAt!, tz)} their time`;
  };
  return (
    <Card data-testid="sent-for-you">
      <div className="font-medium mb-1">Sent for you</div>
      <p className="text-[12px] text-ink-3 mb-3">
        What Orbit sends on its own, the kinds you handed over in{' '}
        <Link to="/settings/limits" className="underline underline-offset-2 hover:text-ink">
          Settings
        </Link>
        .
      </p>
      <ul className="space-y-2.5">
        {rows.map(({ o, p }) => {
          const tz = p ? personZone(p) : undefined;
          return (
            <li key={o.id} className="text-[13px]" data-testid="sent-for-you-row">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{MESSAGE_KIND_LABELS[o.kind]}</span> to{' '}
                  {p?.displayName ?? 'them'}
                </span>
                {o.status === 'queued' && (
                  <Button
                    size="sm"
                    onClick={async () => {
                      const undone = await undoQueued(user, o.id);
                      // back in the student's hands: it counts as theirs again, and the undo is kept for the ladder's
                      // watch (plan 23 §6.5)
                      if (undone) {
                        await db.outbound.update(o.id, { autoSent: undefined });
                        const k = `trust:undone:${user.id}`;
                        const n = Number((await db.kv.get(k))?.value ?? 0);
                        await db.kv.put({ key: k, value: n + 1 });
                      }
                      toast.push({
                        text: undone
                          ? 'Not sent. The draft is back in Drafts.'
                          : 'Too late, it already went out.',
                      });
                    }}
                    data-testid="sent-for-you-undo"
                  >
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
      </ul>
    </Card>
  );
}
