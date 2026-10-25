/**
 * The notes check (plan 23 §4.5): the notes from a coffee chat should be in Orbit before the student thinks to look.
 * For every coffee-chat event that ended in the last three hours with no note yet, the connected notetaker is asked
 * at the end plus 10, 30, 60 and 120 minutes, then never again; also whenever the Chats page or the person's page
 * opens. Each ask is one call: the sync reads from the meeting's start only. What a check found is filed by the same
 * pipeline as any import (facts, promises, the chat completed, the thank-you), and the Chats row updates from it.
 *
 * Like the reply check, it is a timer in the open page and nothing more. The demo's notes come from its mock apps.
 */
import type { CalendarEvent, User } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { isServerUser } from '../integrations/orbitApi';
import { fathomAccount, syncFathom } from './fathom';
import { isMeetingAppOn } from './meetingAppSwitch';
import { MEETING_APP_META, type MeetingApp, syncMeetingApp } from './meetingApps';

const MIN = 60_000;
/** Minutes after the end of a chat at which the notetaker is asked. */
export const CHECK_OFFSETS_MIN = [10, 30, 60, 120] as const;
/** Chats that ended longer ago than this are left to the regular import. */
export const CHECK_WINDOW_MS = 3 * 60 * MIN;
/** A page opening asks again only when the last ask for that chat is older than this. */
export const ON_OPEN_AFTER_MS = 5 * MIN;

/** The notetaker that is on (only one is at a time), by its key and name. */
export async function connectedNotetaker(
  userId: string,
): Promise<{ app: 'fathom' | MeetingApp; name: string; row: IntegrationAccount } | undefined> {
  const fathom = await fathomAccount(userId);
  if (fathom && isMeetingAppOn(fathom) && fathom.status !== 'needs_reauth')
    return { app: 'fathom', name: 'Fathom', row: fathom };
  const rows = await db.integrations.where('userId').equals(userId).toArray();
  for (const app of Object.keys(MEETING_APP_META) as MeetingApp[]) {
    const row = rows.find((r) => r.provider === app);
    if (row && isMeetingAppOn(row) && row.status !== 'needs_reauth')
      return { app, name: MEETING_APP_META[app].name, row };
  }
  return undefined;
}

/** Per event, the offsets already asked at (and when the last ask was), kept in db.kv. */
type Done = Record<string, { offsets: number[]; lastAt?: string }>;
const doneKey = (userId: string) => `notes-check:${userId}`;

async function readDone(userId: string): Promise<Done> {
  return ((await db.kv.get(doneKey(userId)))?.value as Done | undefined) ?? {};
}

/**
 * The offsets due now for one event: those passed and not asked yet, at most the latest of them (a check that runs
 * late asks once, not four times). Never for a cancelled event, one with a note already, or one ended long ago.
 */
export function dueOffset(
  ev: Pick<CalendarEvent, 'endAt' | 'status'>,
  asked: number[],
  hasNote: boolean,
  now: Date,
): number | undefined {
  if (ev.status === 'cancelled' || hasNote) return undefined;
  const end = Date.parse(ev.endAt);
  const since = now.getTime() - end;
  if (since < 0 || since > CHECK_WINDOW_MS) return undefined;
  const passed = CHECK_OFFSETS_MIN.filter((m) => since >= m * MIN && !asked.includes(m));
  return passed.at(-1);
}

/** Coffee-chat events that ended recently, with whether a note already came in for each. */
async function recentChatEvents(userId: string, now: Date) {
  const events = await db.events
    .where('userId')
    .equals(userId)
    .filter(
      (e) =>
        (!!e.isCoffeeChat || !!e.chatId) &&
        e.status !== 'cancelled' &&
        Date.parse(e.endAt) <= now.getTime() &&
        now.getTime() - Date.parse(e.endAt) <= CHECK_WINDOW_MS,
    )
    .toArray();
  const notes = await db.notes.where('userId').equals(userId).toArray();
  return events.map((e) => ({
    event: e,
    hasNote: notes.some(
      (n) =>
        n.calendarEventId === e.id ||
        (!!e.chatId && n.chatId === e.chatId) ||
        (n.personIds.some((id) => e.attendeePersonIds.includes(id)) &&
          Math.abs(Date.parse(n.occurredAt) - Date.parse(e.startAt)) <= 3 * 60 * MIN),
    ),
  }));
}

export interface NotesCheckResult {
  /** events asked about this time */
  asked: string[];
  /** notes filed */
  imported: number;
}

let running: Promise<NotesCheckResult> | undefined;

/**
 * One pass: ask the notetaker about every chat whose next offset is due (or, with `eventIds`, about those chats now,
 * when the last ask is more than five minutes old). One sync covers them all, from the earliest start. Never throws.
 */
export function checkNotes(
  user: User,
  opts: { now?: Date; eventIds?: string[] } = {},
): Promise<NotesCheckResult> {
  if (running) return running;
  running = checkOnce(user, opts)
    .catch(() => ({ asked: [], imported: 0 }))
    .finally(() => {
      running = undefined;
    });
  return running;
}

async function checkOnce(user: User, opts: { now?: Date; eventIds?: string[] }): Promise<NotesCheckResult> {
  const now = opts.now ?? new Date();
  const out: NotesCheckResult = { asked: [], imported: 0 };
  if (isServerUser(user.id)) return out;
  const taker = await connectedNotetaker(user.id);
  if (!taker) return out;
  const done = await readDone(user.id);
  const due: { ev: CalendarEvent; offset?: number }[] = [];
  for (const { event, hasNote } of await recentChatEvents(user.id, now)) {
    const rec = done[event.id] ?? { offsets: [] };
    if (opts.eventIds?.includes(event.id)) {
      if (hasNote) continue;
      if (rec.lastAt && now.getTime() - Date.parse(rec.lastAt) < ON_OPEN_AFTER_MS) continue;
      due.push({ ev: event });
      continue;
    }
    const offset = dueOffset(event, rec.offsets, hasNote, now);
    if (offset !== undefined) due.push({ ev: event, offset });
  }
  if (!due.length) return out;
  const since = new Date(Math.min(...due.map((d) => Date.parse(d.ev.startAt))) - 15 * MIN).toISOString();
  const r =
    taker.app === 'fathom'
      ? await syncFathom(user, { now, since })
      : await syncMeetingApp(user, taker.app, { now, since });
  if (r.ok) out.imported = r.imported;
  for (const d of due) {
    const rec = done[d.ev.id] ?? { offsets: [] };
    // a check that runs late marks every offset it passed, so the schedule never fires twice for one moment
    const passed = d.offset === undefined ? [] : CHECK_OFFSETS_MIN.filter((m) => m <= d.offset!);
    done[d.ev.id] = { offsets: [...new Set([...rec.offsets, ...passed])], lastAt: now.toISOString() };
    out.asked.push(d.ev.id);
  }
  // forget events asked about long ago: they left the window
  for (const [id, rec] of Object.entries(done))
    if (!rec.lastAt || now.getTime() - Date.parse(rec.lastAt) > 2 * CHECK_WINDOW_MS) delete done[id];
  await db.kv.put({ key: doneKey(user.id), value: done });
  return out;
}

/** When the next check is due, so the page's timer can sleep until then (undefined: nothing to watch). */
export async function nextNotesCheckAt(userId: string, now = new Date()): Promise<number | undefined> {
  const done = await readDone(userId);
  let next: number | undefined;
  for (const { event, hasNote } of await recentChatEvents(userId, now)) {
    if (hasNote) continue;
    const asked = done[event.id]?.offsets ?? [];
    const end = Date.parse(event.endAt);
    for (const m of CHECK_OFFSETS_MIN)
      if (!asked.includes(m)) {
        const at = end + m * MIN;
        next = next === undefined ? at : Math.min(next, at);
        break;
      }
  }
  return next;
}
