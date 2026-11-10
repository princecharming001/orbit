/**
 * The queue (plan 38 §C): every email that is going out at a set time, whoever set it (autopilot, a batch the student
 * scheduled, an account's email the server holds), by day, with Send now, Move to the next day and Cancel. A move is
 * a new time in the same hours of the recipient's next working day; the server never sends a held email before its
 * time, so moving one later is safe.
 */
import type { OutboundMessage, Person, User } from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { cancelScheduled } from './autopilot';
import { nextBatchOpen, seeded, studentDay } from './batchTime';
import { undoQueued } from './send';
import { personZone } from './trust';

/** Whether a row is waiting for its time: queued here with a time, or held by the server for one. */
export function isScheduled(
  o: Pick<OutboundMessage, 'status' | 'sendAt' | 'autopilot'>,
  now = Date.now(),
): boolean {
  if (!o.sendAt) return false;
  if (o.status === 'queued') return !!o.autopilot;
  // an account's email approved on the server: the undo window's few seconds are not "scheduled"
  return o.status === 'approved' && Date.parse(o.sendAt) - now > 90_000;
}

export interface QueueDay {
  key: string;
  label: string;
  rows: OutboundMessage[];
}

/** The scheduled rows by the student's day, soonest first. */
export function queueDays(rows: OutboundMessage[], now = new Date()): QueueDay[] {
  const by = new Map<string, OutboundMessage[]>();
  for (const o of rows
    .filter((x) => isScheduled(x, now.getTime()))
    .sort((a, b) => a.sendAt!.localeCompare(b.sendAt!))) {
    const k = studentDay(new Date(o.sendAt!));
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(o);
  }
  const today = studentDay(now);
  const tomorrow = studentDay(new Date(now.getTime() + 86_400_000));
  return [...by.entries()].map(([key, rows]) => ({
    key,
    label:
      key === today
        ? 'Today'
        : key === tomorrow
          ? 'Tomorrow'
          : new Date(rows[0]!.sendAt!).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            }),
    rows,
  }));
}

async function setServerTime(user: User, o: OutboundMessage, at: Date): Promise<boolean> {
  const sync = await import('./serverSync');
  const id = sync.serverIdOf(o.id);
  if (!id) return false;
  const r = await callApi('/drafts/approve', { draftId: id, sendAt: at.toISOString() });
  if (!r.ok) return false;
  await sync.keepServerDraft(r.value.draft, user.id);
  return true;
}

async function setTime(user: User, o: OutboundMessage, at: Date): Promise<boolean> {
  if (o.status === 'approved' && isServerUser(user.id)) return setServerTime(user, o, at);
  if (o.status !== 'queued') return false;
  const iso = at.toISOString();
  await db.outbound.update(o.id, {
    sendAt: iso,
    queuedAt: iso,
    ...(o.reviewUntil ? { reviewUntil: iso } : {}),
  });
  return true;
}

/** Send it now (in a few seconds). */
export async function sendNow(user: User, o: OutboundMessage, now = new Date()): Promise<boolean> {
  return setTime(user, o, new Date(now.getTime() + 5_000));
}

/** The same kind of time on the recipient's next working day. */
export async function moveToNextDay(user: User, o: OutboundMessage): Promise<Date | undefined> {
  const person: Person | undefined = await db.people.get(o.personId);
  const zone = (person && personZone(person)) || user.timezone || 'America/New_York';
  const from = new Date(o.sendAt!);
  const next = new Date(from);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  const at = nextBatchOpen(next, zone, 'steady', seeded(o.id.length * 7 + from.getUTCMinutes()));
  // keep the minute it had, inside the hours, so the day's spacing holds
  const ok = await setTime(user, o, at);
  return ok ? at : undefined;
}

/** Take it out of the queue: back to a draft, untouched. */
export async function cancelSend(user: User, o: OutboundMessage): Promise<boolean> {
  if (o.status === 'approved' && isServerUser(user.id)) return undoQueued(user, o.id);
  return cancelScheduled(user.id, o.id);
}
