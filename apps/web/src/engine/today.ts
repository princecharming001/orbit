import type { Brief, CalendarEvent, CoffeeChat, OutboundMessage, Person, Suggestion } from '@orbit/core';
import { briefSummaryText, isMessageSuggestion } from './brief';

const DAY = 86_400_000;

/**
 * A pending card whose moment has passed (a time to confirm or a chat to prep that already started) is hidden at once,
 * even before the engine retires it.
 */
export function stillTrue(s: Suggestion, now: Date): boolean {
  if (s.kind === 'schedule_confirm') {
    const start = (s.payload.time as { startIso?: string } | undefined)?.startIso;
    if (start && new Date(start) <= now) return false;
  }
  if (s.kind === 'prep_brief') {
    const start = s.signals.startAt as string | undefined;
    if (start && new Date(start) <= now) return false;
  }
  return true;
}

/**
 * What Today shows: the cards (the brief's picks plus anything raised since, such as a stage to confirm) and the
 * deferred ones behind "N more suggestions".
 */
export function todayCards(
  suggestions: Suggestion[],
  latest: Pick<Brief, 'suggestionIds'> | undefined,
  now: Date,
): { cards: Suggestion[]; more: Suggestion[] } {
  const live = suggestions.filter((s) => stillTrue(s, now));
  const inBrief = latest ? live.filter((s) => latest.suggestionIds.includes(s.id)) : [];
  const rest = live.filter((s) => !s.deferred && !latest?.suggestionIds.includes(s.id));
  // ties keep one order from load to load (the card that was first stays first)
  const order = (a: Suggestion, b: Suggestion) =>
    b.priorityScore - a.priorityScore || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const cards = [...inBrief, ...rest].sort(order);
  const more = live.filter((s) => s.deferred && !latest?.suggestionIds.includes(s.id)).sort(order);
  return { cards, more };
}

/**
 * The line under the greeting, counted from the cards on screen right now. The brief's stored summary was written
 * when the brief was made, so it misses cards raised since (a stage to confirm) and still counts the ones already
 * handled or retired.
 */
export function todaySummaryText(
  cards: Pick<Suggestion, 'kind'>[],
  events: Pick<CalendarEvent, 'startAt' | 'status' | 'isCoffeeChat'>[],
  peopleCount: number,
  now: Date,
): string {
  const counts = new Map<string, number>();
  for (const s of cards) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const upcoming = events.filter(
    (e) =>
      e.status !== 'cancelled' &&
      e.isCoffeeChat &&
      new Date(e.startAt) > now &&
      new Date(e.startAt).getTime() - now.getTime() < 7 * DAY,
  ).length;
  const n = cards.length;
  const coming = upcoming ? ` ${upcoming} chat${upcoming > 1 ? 's' : ''} coming up this week.` : '';
  // a count, not a list of every kind: the cards below already say what each one is
  if (n) return `${n} thing${n > 1 ? 's' : ''} for today, most urgent first.${coming}`;
  return briefSummaryText(counts, upcoming, peopleCount);
}

const IN_FLIGHT: OutboundMessage['status'][] = ['queued', 'sending', 'handed_off', 'failed'];

/**
 * The drafts page's lists: message cards waiting to be sent, split the way Today splits them (worth sending today,
 * and the ones that can wait). A draft already opened in the mail app or LinkedIn is not counted again here; it is
 * waiting for "I sent it" instead. The nav badge is `forToday.length`, so it matches Today and the page.
 */
export function draftLists(
  suggestions: Suggestion[],
  outbound: Pick<OutboundMessage, 'id' | 'status'>[],
  latest: Pick<Brief, 'suggestionIds'> | undefined,
  now: Date,
): { forToday: Suggestion[]; later: Suggestion[] } {
  const inFlight = new Set(outbound.filter((o) => IN_FLIGHT.includes(o.status)).map((o) => o.id));
  const pending = suggestions
    .filter(
      (s) =>
        s.status === 'pending' &&
        isMessageSuggestion(s.kind) &&
        !(s.outboundMessageId && inFlight.has(s.outboundMessageId)),
    )
    .sort((a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id));
  const { cards } = todayCards(pending, latest, now);
  const ids = new Set(cards.map((s) => s.id));
  return { forToday: pending.filter((s) => ids.has(s.id)), later: pending.filter((s) => !ids.has(s.id)) };
}

/**
 * Drafts the student started themselves (Write to on a person, a first message from Discover or the Map) and has not
 * sent or discarded, newest first. They belong to no card, so without this list they would only live on the person's
 * page; Drafts and Today list them too, so leaving the page never loses one.
 */
export function startedDrafts<T extends Pick<OutboundMessage, 'status' | 'suggestionId' | 'createdAt'>>(
  outbound: T[],
): T[] {
  return outbound
    .filter((o) => o.status === 'draft' && !o.suggestionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const NEW_PERSON_DAYS = 30;

/**
 * People the student added by hand recently and has done nothing with yet: no chat, no message in any state, no card.
 * Today names them with a "Write to" button, so adding someone always leads to a next step. A bulk import (LinkedIn,
 * the demo) is left out: Discover ranks those.
 */
export function notYetWritten<
  P extends Pick<Person, 'id' | 'isHuman' | 'hiddenAt' | 'sources' | 'createdAt'>,
>(
  people: P[],
  chats: Pick<CoffeeChat, 'personId'>[],
  outbound: Pick<OutboundMessage, 'personId' | 'status'>[],
  suggestions: Pick<Suggestion, 'personId' | 'status'>[],
  now: Date,
): P[] {
  const busy = new Set([
    ...chats.map((c) => c.personId),
    ...outbound.filter((o) => o.status !== 'cancelled').map((o) => o.personId),
    ...suggestions.filter((s) => s.status === 'pending' && s.personId).map((s) => s.personId!),
  ]);
  return people
    .filter(
      (p) =>
        p.isHuman &&
        !p.hiddenAt &&
        p.sources.includes('manual') &&
        !busy.has(p.id) &&
        now.getTime() - new Date(p.createdAt).getTime() < NEW_PERSON_DAYS * DAY,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
