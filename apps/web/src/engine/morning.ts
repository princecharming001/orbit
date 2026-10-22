/**
 * The morning debrief: once a day, after the student's brief time, a small deck in the corner of the screen walks
 * them through the day: how the week stands, the decisions waiting on them one at a time, and what is worth doing
 * today. It is built from what Orbit already has (the day's cards, the outbox, chats, the calendar, Discover), so it
 * never says anything Drafts or People would not.
 */
import type { CalendarEvent, Suggestion, User, UserSettings } from '@orbit/core';
import { warmUpProgress } from '@orbit/core';
import { db } from '../db/schema';
import { isMessageSuggestion } from './brief';
import { draftLists, notYetWritten, todayCards, weekStats } from './today';

/** At most this many decisions; the rest wait in Drafts, and the last slide says how many. */
export const MORNING_MAX_DECISIONS = 6;

/** Cards that ask the student a question with a yes or no: they come first, they take a second each. */
const QUESTIONS = new Set<Suggestion['kind']>(['confirm_stage', 'confirm_intro', 'confirm_merge']);

export interface MorningStats {
  sentThisWeek: number;
  weeklyTarget: number;
  /** people who wrote back in the last day */
  replies: number;
  /** coffee chats on the calendar today */
  chatsToday: number;
  replyRate?: number;
}

export interface MorningMove {
  id: string;
  text: string;
  sub?: string;
  href: string;
  personId?: string;
}

export interface MorningDeck {
  greeting: string;
  dateLabel: string;
  /** one plain sentence about the day, under the greeting */
  headline: string;
  stats: MorningStats;
  decisions: Suggestion[];
  /** cards for today that did not fit as decisions; Drafts holds them */
  moreInDrafts: number;
  moves: MorningMove[];
}

function partOfDay(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The local calendar day, as YYYY-MM-DD. */
export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The debrief is due: it is on, the brief time has passed today, and today's has not been opened or closed yet. */
export function morningDue(
  settings: Pick<UserSettings, 'briefTimeLocal' | 'morningBrief' | 'morningSeenOn'> | undefined,
  now: Date,
): boolean {
  if (!settings || settings.morningBrief === false) return false;
  if (settings.morningSeenOn === localDay(now)) return false;
  const [h, m] = (settings.briefTimeLocal ?? '07:00').split(':').map(Number);
  const at = new Date(now);
  at.setHours(Number.isFinite(h) ? h! : 7, Number.isFinite(m) ? m! : 0, 0, 0);
  return now.getTime() >= at.getTime();
}

/** Today's debrief was seen (finished or closed): it does not come back until tomorrow. */
export async function markMorningSeen(userId: string, now = new Date()): Promise<void> {
  await db.settings.update(userId, { morningSeenOn: localDay(now) });
}

export async function setMorningBrief(userId: string, on: boolean): Promise<void> {
  await db.settings.update(userId, { morningBrief: on });
}

export async function morningDeck(
  user: Pick<User, 'id' | 'firstName' | 'timezone'>,
  now = new Date(),
): Promise<MorningDeck> {
  const [settings, suggestions, outbound, chats, people, briefs, events, recs] = await Promise.all([
    db.settings.get(user.id),
    db.suggestions.where('userId').equals(user.id).toArray(),
    db.outbound.where('userId').equals(user.id).toArray(),
    db.chats.where('userId').equals(user.id).toArray(),
    db.people.where('userId').equals(user.id).toArray(),
    db.briefs.where('userId').equals(user.id).toArray(),
    db.events.where('userId').equals(user.id).toArray(),
    db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((r) => r.status === 'new')
      .toArray(),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const visible = (id?: string) => !id || (byId.has(id) && !byId.get(id)!.hiddenAt);
  const latest = briefs
    .filter((b) => b.kind === 'daily')
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const live = suggestions.filter(
    (s) =>
      visible(s.personId) &&
      (s.status === 'pending' ||
        (s.status === 'snoozed' && !!s.snoozedUntil && new Date(s.snoozedUntil) <= now)),
  );
  const { cards } = todayCards(live, latest, now);
  const { forToday } = draftLists(suggestions, outbound, latest, now);
  // questions first (a tap each), then the messages to send, then anything else for today
  const questions = cards.filter((s) => QUESTIONS.has(s.kind));
  const messages = forToday.filter((s) => visible(s.personId));
  const others = cards.filter((s) => !QUESTIONS.has(s.kind) && !isMessageSuggestion(s.kind));
  const ordered = [...questions, ...messages, ...others].filter(
    (s, i, all) => all.findIndex((x) => x.id === s.id) === i,
  );
  const decisions = ordered.slice(0, MORNING_MAX_DECISIONS);

  const week = weekStats(outbound, chats, people, settings?.weeklyOutreachTarget ?? 4, now);
  const dayAgo = now.getTime() - 86_400_000;
  const replies = chats.filter(
    (c) => c.lastInboundAt && new Date(c.lastInboundAt).getTime() >= dayAgo && visible(c.personId),
  ).length;
  const sameDay = (iso: string) => localDay(new Date(iso)) === localDay(now);
  const todays: CalendarEvent[] = events
    // coffee chats only: a class or a team meeting on the calendar is not a chat to prep for
    .filter(
      (e) =>
        e.status !== 'cancelled' && e.isCoffeeChat && sameDay(e.startAt) && e.attendeePersonIds.length > 0,
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  // what is worth doing today beyond the decisions: chats to prep, warm-up steps due, people to write to, Discover
  const moves: MorningMove[] = [];
  for (const e of todays) {
    const p = byId.get(e.attendeePersonIds[0]!);
    if (!p) continue;
    moves.push({
      id: `ev:${e.id}`,
      text: `Prep for ${p.firstName}`,
      sub: `Chat at ${new Date(e.startAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      href: `/people/${p.id}?tab=prep`,
      personId: p.id,
    });
  }
  for (const c of chats) {
    if (c.stage !== 'warming' || !c.warmUp || !visible(c.personId)) continue;
    const p = byId.get(c.personId)!;
    const prog = warmUpProgress(c.warmUp, now, user.timezone);
    const next = c.warmUp.actions.find((a) => !a.doneAt && !a.skippedAt);
    if (prog.ready)
      moves.push({
        id: `wu:${c.id}`,
        text: `Write your first message to ${p.firstName}`,
        sub: 'The warm-up is done',
        href: `/people/${p.id}?draft=outreach`,
        personId: p.id,
      });
    else if (next && new Date(next.dueAt) <= now)
      moves.push({
        id: `wu:${c.id}`,
        text: `Warm-up step for ${p.firstName}`,
        sub: next.label,
        href: `/inbox?person=${p.id}`,
        personId: p.id,
      });
  }
  for (const p of notYetWritten(people, chats, outbound, suggestions, now).slice(0, 2))
    moves.push({
      id: `nw:${p.id}`,
      text: `Write to ${p.firstName}`,
      sub: 'You added them and have not written yet',
      href: `/people/${p.id}?draft=outreach`,
      personId: p.id,
    });
  const decided = new Set(decisions.map((s) => s.personId).filter(Boolean));
  const picks = recs
    .filter((r) => visible(r.personId) && !decided.has(r.personId))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, 4 - moves.length));
  for (const r of picks) {
    const p = byId.get(r.personId)!;
    moves.push({
      id: `rec:${r.id}`,
      text: `Reach out to ${p.firstName}`,
      sub: r.reasons[0]?.text ?? [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at '),
      href: '/discover',
      personId: p.id,
    });
  }

  const remaining = Math.max(0, ordered.length - decisions.length);
  const headline =
    decisions.length || todays.length
      ? [
          decisions.length ? plural(decisions.length, 'thing', 'things') + ' to decide' : '',
          todays.length ? plural(todays.length, 'chat') + ' today' : '',
          replies ? plural(replies, 'new reply', 'new replies') : '',
        ]
          .filter(Boolean)
          .join(', ')
          .replace(/^./, (c) => c.toUpperCase()) + '.'
      : 'Nothing is waiting on you. A good day to reach out to someone new.';
  return {
    greeting: `${partOfDay(now)}, ${user.firstName}`,
    dateLabel: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    headline,
    stats: {
      sentThisWeek: week.sentThisWeek,
      weeklyTarget: week.weeklyTarget,
      replies,
      chatsToday: todays.length,
      replyRate: week.replyRate,
    },
    decisions,
    moreInDrafts: remaining,
    moves: moves.slice(0, 4),
  };
}
