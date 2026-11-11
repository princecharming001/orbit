/**
 * The calls, at a glance (plan 38 §F): a week of booked calls by day, and how the student's outreach turned into them
 * over the last 30 days (people written to first, of them who replied, and who booked a call). Read from this
 * browser's events, messages and chats; an account's come down with each pull.
 */
import type { CalendarEvent, OutboundMessage } from '@orbit/core';
import { db } from '../db/schema';

const DAY = 86_400_000;

/** Monday 00:00 of the week `at` falls in, in the student's own time. */
export function weekStart(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d;
}

export interface WeekCall {
  id: string;
  startAt: string;
  endAt: string;
  title: string;
  personId?: string;
  conferenceUrl?: string;
}

export interface WeekView {
  start: Date;
  days: { date: Date; calls: WeekCall[] }[];
  total: number;
}

/** A call: a coffee chat, or any meeting with someone the student knows, not cancelled. */
export function isCall(e: CalendarEvent): boolean {
  return e.status !== 'cancelled' && (!!e.isCoffeeChat || e.attendeePersonIds.length > 0);
}

/** Every call between two times, by start, one per person and time (a booking and the calendar's copy are one). */
export async function callsBetween(userId: string, from: Date, to: Date): Promise<WeekCall[]> {
  const events = await db.events
    .where('userId')
    .equals(userId)
    .filter((e) => isCall(e) && e.startAt >= from.toISOString() && e.startAt < to.toISOString())
    .toArray();
  const seen = new Set<string>();
  const out: WeekCall[] = [];
  for (const e of events.sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    const key = `${e.attendeePersonIds[0] ?? e.title}|${e.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id,
      startAt: e.startAt,
      endAt: e.endAt,
      title: e.title ?? 'Call',
      personId: e.attendeePersonIds[0],
      conferenceUrl: e.conferenceUrl,
    });
  }
  return out;
}

/** The calls of `count` days from `start` (a local midnight), placed on their own day. */
async function callsByDay(userId: string, start: Date, count: number): Promise<WeekView> {
  const days = Array.from({ length: count }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return { date, calls: [] as WeekCall[] };
  });
  const end = new Date(days[count - 1]!.date);
  end.setDate(end.getDate() + 1);
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const byKey = new Map(days.map((d) => [key(d.date), d]));
  for (const c of await callsBetween(userId, start, end)) byKey.get(key(new Date(c.startAt)))?.calls.push(c);
  return { start, days, total: days.reduce((n, d) => n + d.calls.length, 0) };
}

export async function callsWeek(userId: string, start: Date): Promise<WeekView> {
  return callsByDay(userId, start, 7);
}

/** The first of the month `offset` months from the one `at` falls in. */
export function monthStart(at: Date, offset = 0): Date {
  return new Date(at.getFullYear(), at.getMonth() + offset, 1);
}

/** A month as whole weeks, Monday to Sunday: the days around it are there, and `inMonth` says which are its own. */
export async function callsMonth(
  userId: string,
  month: Date,
): Promise<WeekView & { month: Date; weeks: number }> {
  const first = weekStart(month);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeks = Math.ceil((Math.round((last.getTime() - first.getTime()) / DAY) + 1) / 7);
  const v = await callsByDay(userId, first, weeks * 7);
  return { ...v, month, weeks };
}

/** The list: calls from today on (the next `ahead` days), and the last `behind` days' calls, latest first. */
export async function callsList(
  userId: string,
  now = new Date(),
  ahead = 90,
  behind = 30,
): Promise<{ upcoming: WeekCall[]; past: WeekCall[] }> {
  const all = await callsBetween(
    userId,
    new Date(now.getTime() - behind * DAY),
    new Date(now.getTime() + ahead * DAY),
  );
  const at = now.toISOString();
  return {
    upcoming: all.filter((c) => c.endAt >= at),
    past: all.filter((c) => c.endAt < at).reverse(),
  };
}

export interface OutreachFunnel {
  /** people written to first in the window */
  wrote: number;
  replied: number;
  booked: number;
}

const FIRST: OutboundMessage['kind'][] = ['outreach', 'bump', 'intro_request'];

/** Of the people the student wrote to first in the last `days` days: how many replied, how many booked a call. */
export async function outreachFunnel(userId: string, now = new Date(), days = 30): Promise<OutreachFunnel> {
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const sent = await db.outbound
    .where('userId')
    .equals(userId)
    .filter((o) => o.status === 'sent' && !!o.sentAt && o.sentAt >= since && FIRST.includes(o.kind))
    .toArray();
  const firstAt = new Map<string, string>();
  for (const o of sent) {
    const prev = firstAt.get(o.personId);
    if (!prev || o.sentAt! < prev) firstAt.set(o.personId, o.sentAt!);
  }
  if (!firstAt.size) return { wrote: 0, replied: 0, booked: 0 };
  const ids = [...firstAt.keys()];
  const chats = await db.chats.where('personId').anyOf(ids).toArray();
  const events = await db.events
    .where('userId')
    .equals(userId)
    .filter((e) => isCall(e) && e.attendeePersonIds.some((p) => firstAt.has(p)))
    .toArray();
  let replied = 0;
  let booked = 0;
  for (const id of ids) {
    const at = firstAt.get(id)!;
    const answered = chats.some((c) => c.personId === id && !!c.lastInboundAt && c.lastInboundAt > at);
    const call = events.some((e) => e.attendeePersonIds.includes(id) && (e.inviteSentAt ?? e.startAt) >= at);
    if (answered || call) replied++;
    if (call) booked++;
  }
  return { wrote: ids.length, replied, booked };
}
