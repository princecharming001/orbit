import type { Brief, CalendarEvent, Suggestion } from '@orbit/core';
import { briefSummaryText } from './brief';

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
  const cards = [...inBrief, ...rest].sort((a, b) => b.priorityScore - a.priorityScore);
  const more = live
    .filter((s) => s.deferred && !latest?.suggestionIds.includes(s.id))
    .sort((a, b) => b.priorityScore - a.priorityScore);
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
