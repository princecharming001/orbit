/**
 * Your chats (plan 23 §4.4): the week's coffee chats as the student needs them on a phone at 2:50 pm. Pure: every
 * table it reads is passed in, so the page, the chat tool and the tests read the same days.
 *
 * Rows come from calendar events that are coffee chats (or carry a chat), not cancelled, from 48 hours back to 14 days
 * ahead, plus chats agreed to with no time set yet. A chat that already happened says what came back from it: the
 * notes and the facts they added, the thank-you waiting, or that the notetaker has nothing yet.
 */
import type {
  ActionItem,
  CalendarEvent,
  CoffeeChat,
  EmailMessage,
  MeetingNote,
  Person,
  PersonFact,
  Suggestion,
} from '@orbit/core';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back "Just happened" looks, and how far ahead the week goes. */
export const CHATS_BACK_MS = 48 * HOUR;
export const CHATS_AHEAD_MS = 14 * DAY;
/** A notetaker gets this long after the end before the row says it has no recording. */
export const NOTES_GRACE_MS = 2 * HOUR;

/** What came back from a chat that happened. */
export type ChatAfter =
  | { kind: 'notes_in'; facts: number; thankYou: boolean; noteId: string }
  | { kind: 'waiting'; app: string }
  | { kind: 'no_recording'; app: string }
  | { kind: 'no_notetaker' };

export interface ChatRow {
  key: string;
  person: Person;
  chat?: CoffeeChat;
  event?: CalendarEvent;
  startAt?: string;
  endAt?: string;
  minutes?: number;
  joinUrl?: string;
  /** the disclosure's three lines; each only when there is a stored row behind it */
  lines: { goal?: string; lastSaid?: string; fact?: string };
  after?: ChatAfter;
}

export interface ChatDay {
  /** YYYY-MM-DD in the student's zone */
  key: string;
  /** "Today", "Tomorrow", "Wednesday", "Mon, Oct 19" */
  label: string;
  rows: ChatRow[];
}

export interface ChatsView {
  justHappened: ChatRow[];
  days: ChatDay[];
  noTime: ChatRow[];
  /** chats today that have not ended yet: the sidebar badge */
  todayCount: number;
  /** the next chat still ahead, for the chat home's line */
  next?: ChatRow;
}

export interface ChatsInput {
  events: CalendarEvent[];
  chats: CoffeeChat[];
  people: Person[];
  notes: MeetingNote[];
  facts: PersonFact[];
  suggestions: Suggestion[];
  messages?: EmailMessage[];
  actionItems?: ActionItem[];
  /** the notetaker connected now (Fathom, Granola, ...), by name; none when nothing records meetings */
  notetaker?: string;
}

export function dayKey(d: Date | string, tz: string): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

function dayLabel(key: string, now: Date, tz: string): string {
  const today = dayKey(now, tz);
  const tomorrow = dayKey(new Date(now.getTime() + DAY), tz);
  if (key === today) return 'Today';
  if (key === tomorrow) return 'Tomorrow';
  const d = new Date(`${key}T12:00:00Z`);
  const days = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  if (days > 0 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The first sentence of what they last wrote, short enough for one line. */
function firstSentence(text: string | undefined): string | undefined {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const s = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  return s.length > 140 ? `${s.slice(0, 137).trimEnd()}…` : s;
}

const OPEN_STAGES = new Set(['scheduling', 'scheduled']);
const ENDED_STAGES = new Set(['declined', 'archived', 'no_response']);

export function upcomingChats(input: ChatsInput, now: Date, tz: string): ChatsView {
  const people = new Map(input.people.map((p) => [p.id, p]));
  const chatsById = new Map(input.chats.map((c) => [c.id, c]));
  const chatOf = (personId: string, eventId?: string) =>
    (eventId ? input.chats.find((c) => c.scheduledEventId === eventId) : undefined) ??
    input.chats.find((c) => c.personId === personId && !c.archivedAt && !ENDED_STAGES.has(c.stage));
  const t = now.getTime();
  const lastSaid = (personId: string) =>
    firstSentence(
      (input.messages ?? [])
        .filter((m) => m.fromPersonId === personId && m.direction === 'inbound' && !m.isAutomated)
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0]?.bodyText,
    );
  const factFor = (personId: string) =>
    input.facts
      .filter((f) => f.personId === personId && !f.deletedAt && f.type !== 'contact_info')
      .sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt))[0]?.text;
  const goalFor = (chat: CoffeeChat | undefined) => {
    if (!chat) return undefined;
    const q = chat.prepQuestions?.[0];
    if (q) return `Ask: ${q}`;
    if (chat.goalTags.length) return `For ${chat.goalTags.join(', ')}`;
    return undefined;
  };
  const afterOf = (person: Person, chat: CoffeeChat | undefined, ev: CalendarEvent): ChatAfter => {
    const start = Date.parse(ev.startAt);
    const end = Date.parse(ev.endAt);
    const note = input.notes
      .filter(
        (n) =>
          n.matchStatus !== 'rejected' &&
          ((!!chat && n.chatId === chat.id) ||
            n.calendarEventId === ev.id ||
            (n.personIds.includes(person.id) && Math.abs(Date.parse(n.occurredAt) - start) <= 3 * HOUR)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (note) {
      const facts = input.facts.filter(
        (f) =>
          f.personId === person.id && !f.deletedAt && f.sourceTable === 'notes' && f.sourceId === note.id,
      ).length;
      const thankYou = input.suggestions.some(
        (s) =>
          s.kind === 'thank_you' &&
          s.status === 'pending' &&
          (s.personId === person.id || (!!chat && s.chatId === chat.id)),
      );
      return { kind: 'notes_in', facts, thankYou, noteId: note.id };
    }
    if (!input.notetaker) return { kind: 'no_notetaker' };
    return t - end < NOTES_GRACE_MS
      ? { kind: 'waiting', app: input.notetaker }
      : { kind: 'no_recording', app: input.notetaker };
  };

  const rows: ChatRow[] = [];
  const seenChats = new Set<string>();
  for (const ev of input.events) {
    if (ev.status === 'cancelled') continue;
    const viaChat = ev.chatId ? chatsById.get(ev.chatId) : undefined;
    if (!ev.isCoffeeChat && !viaChat) continue;
    const start = Date.parse(ev.startAt);
    if (start < t - CHATS_BACK_MS || start > t + CHATS_AHEAD_MS) continue;
    const personId = viaChat?.personId ?? ev.attendeePersonIds[0];
    const person = personId ? people.get(personId) : undefined;
    if (!person || person.hiddenAt) continue;
    const chat = viaChat ?? chatOf(person.id, ev.id);
    if (chat) seenChats.add(chat.id);
    const ended = Date.parse(ev.endAt) <= t;
    rows.push({
      key: ev.id,
      person,
      chat,
      event: ev,
      startAt: ev.startAt,
      endAt: ev.endAt,
      minutes: Math.max(0, Math.round((Date.parse(ev.endAt) - start) / 60_000)),
      joinUrl: ev.conferenceUrl,
      lines: { goal: goalFor(chat), lastSaid: lastSaid(person.id), fact: factFor(person.id) },
      after: ended ? afterOf(person, chat, ev) : undefined,
    });
  }
  // agreed to talk, no time on the calendar yet
  const noTime: ChatRow[] = [];
  for (const c of input.chats) {
    if (seenChats.has(c.id) || c.archivedAt || !OPEN_STAGES.has(c.stage)) continue;
    const hasEvent =
      !!c.scheduledEventId &&
      input.events.some((e) => e.id === c.scheduledEventId && e.status !== 'cancelled');
    if (hasEvent) continue;
    const person = people.get(c.personId);
    if (!person || person.hiddenAt) continue;
    noTime.push({
      key: c.id,
      person,
      chat: c,
      lines: { goal: goalFor(c), lastSaid: lastSaid(person.id), fact: factFor(person.id) },
    });
  }
  rows.sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
  const justHappened = rows
    .filter((r) => r.after)
    .sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? ''));
  const ahead = rows.filter((r) => !r.after);
  const days: ChatDay[] = [];
  for (const r of ahead) {
    const key = dayKey(r.startAt!, tz);
    const day = days.at(-1)?.key === key ? days.at(-1)! : undefined;
    if (day) day.rows.push(r);
    else days.push({ key, label: dayLabel(key, now, tz), rows: [r] });
  }
  const today = dayKey(now, tz);
  return {
    justHappened,
    days,
    noTime: noTime.sort((a, b) => a.person.displayName.localeCompare(b.person.displayName)),
    todayCount: ahead.filter((r) => dayKey(r.startAt!, tz) === today).length,
    next: ahead[0],
  };
}

/** "3:00 pm" in the student's zone */
export function clockOf(iso: string, tz: string): string {
  return new Date(iso)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
    .replace(/\s?([AP])M$/i, (_, x: string) => ` ${x.toLowerCase()}m`);
}

/** What came back, in the row's words: "Notes in · 3 facts · Thank-you ready". */
export function afterText(a: ChatAfter): string {
  switch (a.kind) {
    case 'notes_in':
      return [
        'Notes in',
        a.facts ? `${a.facts} ${a.facts === 1 ? 'fact' : 'facts'}` : undefined,
        a.thankYou ? 'Thank-you ready' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'waiting':
      return `Waiting for ${a.app}'s notes`;
    case 'no_recording':
      return `${a.app} has no recording of this chat`;
    case 'no_notetaker':
      return 'No notetaker';
  }
}
