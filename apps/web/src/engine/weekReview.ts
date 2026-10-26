/**
 * The weekly review (plan 23 §4.8): on Sunday evening, four cards about the week that ends: how many people the
 * student reached, who replied, what got booked and who went quiet (against the weekly target); who moved; what is
 * waiting on them (the nudges and thank-yous, a promise past due); and next week (the target, the chats already
 * booked, and a line from a plan when there is one). Every line comes from a stored row; a week with nothing in it
 * says so, and names the holiday when the week held one.
 *
 * `weekReviewFrom` is pure over the rows it is given; `buildWeekReview` reads them, and `storeWeekReview` keeps the
 * numbers as the week's recap brief (Brief.kind 'recap') and leaves a weekly_recap notification.
 */
import {
  type ActionItem,
  type Brief,
  type CalendarEvent,
  type CoffeeChat,
  type EmailMessage,
  type EmailThread,
  type MeetingNote,
  newId,
  type OutboundMessage,
  type Person,
  type PersonFact,
  type StageEvent,
  type Suggestion,
  type TargetPlan,
  type User,
  type UserSettings,
  usHolidayName,
  wentQuiet,
} from '@orbit/core';
import { db } from '../db/schema';

const DAY = 86_400_000;
/** The review is due from Sunday at this hour, local time. */
export const REVIEW_HOUR = 17;
/** A student is not shown an empty review in their first week. */
export const FIRST_REVIEW_AFTER_DAYS = 7;
const REACH_KINDS = new Set<OutboundMessage['kind']>(['outreach', 'first_touch']);
const WAITING_KINDS = new Set<Suggestion['kind']>([
  'follow_up_bump',
  'thank_you',
  'schedule_confirm',
  'schedule_propose',
  'report_back',
]);

/** "2026-10-25" in the student's zone. */
export function dayKeyIn(d: Date | string, tz: string): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

/** The local hour and weekday (0 = Sunday) in the student's zone. */
function localParts(d: Date, tz: string): { dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

/** The Sunday the review is about: today on Sunday, else the last one. */
export function reviewSunday(now: Date, tz: string): string {
  const { dow } = localParts(now, tz);
  return dayKeyIn(new Date(now.getTime() - dow * DAY), tz);
}

/**
 * Due: Sunday from 17:00 local or any time after, this week's not seen yet, and the student has had Orbit a week (so
 * a new student never gets an empty one).
 */
export function weekReviewDue(
  settings: Pick<UserSettings, 'weekReviewSeenOn'> | undefined,
  firstBriefAt: string | undefined,
  now: Date,
  tz: string,
): boolean {
  if (!firstBriefAt || now.getTime() - Date.parse(firstBriefAt) < FIRST_REVIEW_AFTER_DAYS * DAY) return false;
  const sunday = reviewSunday(now, tz);
  if (settings?.weekReviewSeenOn === sunday) return false;
  const { dow, hour } = localParts(now, tz);
  // on Sunday only from the evening; Monday to Saturday it is last week's, still unseen
  return dow !== 0 || hour >= REVIEW_HOUR;
}

export interface Named {
  personId: string;
  name: string;
}

export interface WeekReview {
  /** the Sunday the week ends on, YYYY-MM-DD */
  weekEnding: string;
  reached: Named[];
  replied: Named[];
  booked: Named[];
  quiet: Named[];
  target: number;
  moved: (Named & { text: string })[];
  waiting: { suggestionIds: string[]; overdue: { id: string; text: string; personId?: string }[] };
  next: { target: number; booked: (Named & { day: string })[]; planLine?: string };
  holiday?: string;
  /** what Orbit sent on its own this week (plan 23 §4.9) */
  sentForYou: number;
  /** nothing moved this week */
  empty: boolean;
  /** "6 reached · 3 replied · 2 chats booked · 1 went quiet", or "Nothing moved this week" */
  headline: string;
}

export interface WeekRows {
  people: Person[];
  outbound: OutboundMessage[];
  messages: EmailMessage[];
  threads: EmailThread[];
  chats: CoffeeChat[];
  stageEvents: StageEvent[];
  events: CalendarEvent[];
  notes: MeetingNote[];
  facts: PersonFact[];
  suggestions: Suggestion[];
  actionItems: ActionItem[];
  plans: TargetPlan[];
  weeklyTarget: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function weekReviewFrom(rows: WeekRows, now: Date, tz: string): WeekReview {
  const sunday = reviewSunday(now, tz);
  // the week: Monday 00:00 to the end of Sunday, local; found by day keys, so a zone's offset never shifts it
  const keys = new Set(
    Array.from({ length: 7 }, (_, i) =>
      dayKeyIn(new Date(Date.parse(`${sunday}T12:00:00Z`) - i * DAY), 'UTC'),
    ),
  );
  const inWeek = (iso: string | undefined) => !!iso && keys.has(dayKeyIn(iso, tz));
  const weekEnd = new Date(Date.parse(`${sunday}T23:59:59Z`) + 14 * 3_600_000);
  const people = new Map(rows.people.map((p) => [p.id, p]));
  const named = (id: string): Named => ({ personId: id, name: people.get(id)?.displayName ?? 'Someone' });
  const first = (id: string) => people.get(id)?.firstName || people.get(id)?.displayName || 'Someone';
  const uniq = (ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))];
  const weekday = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz });
  const chatsById = new Map(rows.chats.map((c) => [c.id, c]));

  const reached = uniq(
    rows.outbound
      .filter((o) => o.status === 'sent' && REACH_KINDS.has(o.kind) && inWeek(o.sentAt))
      .map((o) => o.personId),
  );
  // a human reply from someone the student has a chat with (mail, or a stage move to replied from LinkedIn)
  const withChat = new Set(rows.chats.map((c) => c.personId));
  const repliedMail = rows.messages.filter(
    (m) =>
      m.direction === 'inbound' &&
      !m.isAutomated &&
      !!m.fromPersonId &&
      withChat.has(m.fromPersonId) &&
      inWeek(m.sentAt),
  );
  const applied = rows.stageEvents.filter((e) => e.status === 'applied' && inWeek(e.createdAt));
  const repliedIds = uniq([
    ...repliedMail.map((m) => m.fromPersonId),
    ...applied.filter((e) => e.toStage === 'replied').map((e) => chatsById.get(e.chatId)?.personId),
  ]);
  const bookedIds = uniq(
    applied.filter((e) => e.toStage === 'scheduled').map((e) => chatsById.get(e.chatId)?.personId),
  );
  const quietIds = uniq(
    rows.chats
      .filter(
        (c) =>
          !c.archivedAt &&
          wentQuiet(c, weekEnd) &&
          !!c.lastOutboundAt &&
          inWeek(new Date(Date.parse(c.lastOutboundAt) + 7 * DAY).toISOString()),
      )
      .map((c) => c.personId),
  );
  // who moved: the newest change per person this week, in the words a student would use
  const moved: WeekReview['moved'] = [];
  const seen = new Set<string>();
  const lastReply = new Map<string, string>();
  for (const m of repliedMail)
    if (!lastReply.has(m.fromPersonId!) || m.sentAt > lastReply.get(m.fromPersonId!)!)
      lastReply.set(m.fromPersonId!, m.sentAt);
  for (const e of [...applied].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const c = chatsById.get(e.chatId);
    if (!c || seen.has(c.personId)) continue;
    const name = first(c.personId);
    let text: string | undefined;
    if (e.toStage === 'completed') {
      const facts = rows.facts.filter(
        (f) => f.personId === c.personId && !f.deletedAt && f.sourceTable === 'notes' && inWeek(f.createdAt),
      ).length;
      const ev = rows.events.find((x) => x.id === c.scheduledEventId);
      text = `${name}'s chat happened ${weekday(ev?.startAt ?? e.createdAt)}${facts ? ` (${plural(facts, 'fact')})` : ''}`;
    } else if (e.toStage === 'scheduled') text = `${name} booked a chat`;
    else if (e.toStage === 'scheduling') text = `${name} agreed to talk`;
    else if (e.toStage === 'replied')
      text = `${name} replied ${weekday(lastReply.get(c.personId) ?? e.createdAt)}`;
    if (!text) continue;
    seen.add(c.personId);
    moved.push({ ...named(c.personId), text });
  }
  for (const [pid, at] of lastReply)
    if (!seen.has(pid)) {
      seen.add(pid);
      moved.push({ ...named(pid), text: `${first(pid)} replied ${weekday(at)}` });
    }
  for (const t of rows.threads)
    if (t.introduction && inWeek(t.introduction.at) && !seen.has(t.introduction.introducerId)) {
      seen.add(t.introduction.introducerId);
      moved.push({
        ...named(t.introduction.introducerId),
        text: `${first(t.introduction.introducerId)} made the intro`,
      });
    }
  const waiting = {
    suggestionIds: rows.suggestions
      .filter((s) => s.status === 'pending' && WAITING_KINDS.has(s.kind) && !!s.outboundMessageId)
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, 5)
      .map((s) => s.id),
    overdue: rows.actionItems
      .filter((a) => a.status === 'open' && !!a.dueAt && Date.parse(a.dueAt) < now.getTime())
      .slice(0, 3)
      .map((a) => ({ id: a.id, text: a.text, personId: a.personId })),
  };
  // next week: the chats already on the calendar, and the next step of a plan that is waiting on a reply
  const nextStart = Date.parse(`${sunday}T23:59:59Z`);
  const nextBooked = rows.events
    .filter(
      (e) =>
        e.status !== 'cancelled' &&
        (!!e.isCoffeeChat || !!e.chatId) &&
        Date.parse(e.startAt) > Math.max(now.getTime(), nextStart - DAY) &&
        Date.parse(e.startAt) < nextStart + 8 * DAY,
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((e) => {
      const pid = (e.chatId ? chatsById.get(e.chatId)?.personId : undefined) ?? e.attendeePersonIds[0];
      return pid ? { ...named(pid), day: weekday(e.startAt) } : undefined;
    })
    .filter((x): x is Named & { day: string } => !!x);
  let planLine: string | undefined;
  for (const p of rows.plans) {
    const held = p.steps.find((s) => s.status === 'held' && s.when.afterPersonId);
    if (held && p.steps.some((s) => s.status === 'drafted' || s.status === 'done')) {
      planLine = `${first(held.personId)} is next in your ${p.posting.company} plan once ${first(held.when.afterPersonId!)} replies.`;
      break;
    }
  }
  const holiday = [...keys]
    .sort()
    .map((k) => usHolidayName(k))
    .find(Boolean);
  const empty =
    !reached.length && !repliedIds.length && !bookedIds.length && !quietIds.length && !moved.length;
  const headline = empty
    ? `Nothing moved this week${holiday ? `. It was ${holiday} week` : ''}`
    : [
        `${reached.length} reached`,
        `${repliedIds.length} replied`,
        `${plural(bookedIds.length, 'chat')} booked`,
        `${quietIds.length} went quiet`,
      ].join(' · ');
  return {
    weekEnding: sunday,
    reached: reached.map(named),
    replied: repliedIds.map(named),
    booked: bookedIds.map(named),
    quiet: quietIds.map(named),
    target: rows.weeklyTarget,
    moved: moved.slice(0, 6),
    waiting,
    next: { target: rows.weeklyTarget, booked: nextBooked, planLine },
    holiday,
    sentForYou: rows.outbound.filter((o) => o.autoSent && o.status === 'sent' && inWeek(o.sentAt)).length,
    empty,
    headline,
  };
}

/** The week's review, read from this browser's tables. */
export async function buildWeekReview(user: User, now = new Date()): Promise<WeekReview> {
  const by = <T>(t: { where(k: string): { equals(v: string): { toArray(): Promise<T[]> } } }) =>
    t.where('userId').equals(user.id).toArray();
  const [
    people,
    outbound,
    messages,
    threads,
    chats,
    stageEvents,
    events,
    notes,
    facts,
    suggestions,
    actionItems,
    plans,
    settings,
  ] = await Promise.all([
    by<Person>(db.people),
    by<OutboundMessage>(db.outbound),
    by<EmailMessage>(db.messages),
    by<EmailThread>(db.threads),
    by<CoffeeChat>(db.chats),
    by<StageEvent>(db.stageEvents),
    by<CalendarEvent>(db.events),
    by<MeetingNote>(db.notes),
    by<PersonFact>(db.facts),
    by<Suggestion>(db.suggestions),
    by<ActionItem>(db.actionItems),
    by<TargetPlan>(db.targetPlans),
    db.settings.get(user.id),
  ]);
  return weekReviewFrom(
    {
      people,
      outbound,
      messages,
      threads,
      chats,
      stageEvents,
      events,
      notes,
      facts,
      suggestions,
      actionItems,
      plans,
      weeklyTarget: settings?.weeklyOutreachTarget ?? 4,
    },
    now,
    user.timezone || 'UTC',
  );
}

/** Keep the week's numbers as its recap brief, once per Sunday, with a weekly_recap notification. */
export async function storeWeekReview(user: User, now = new Date()): Promise<Brief> {
  const r = await buildWeekReview(user, now);
  const existing = await db.briefs
    .where('[userId+kind+briefDate]')
    .equals([user.id, 'recap', r.weekEnding])
    .first();
  const brief: Brief = {
    id: existing?.id ?? newId('b'),
    userId: user.id,
    kind: 'recap',
    briefDate: r.weekEnding,
    generatedAt: now.toISOString(),
    openedAt: existing?.openedAt,
    suggestionIds: r.waiting.suggestionIds,
    summaryText: r.headline,
    stats: {
      reached: r.reached.length,
      replied: r.replied.length,
      booked: r.booked.length,
      quiet: r.quiet.length,
      target: r.target,
      waiting: r.waiting.suggestionIds.length,
    },
  };
  await db.briefs.put(brief);
  if (!existing)
    await db.notifications.add({
      id: newId('nt'),
      userId: user.id,
      kind: 'weekly_recap',
      title: 'Your week in review',
      body: r.headline,
      link: '/inbox?review=1',
      createdAt: now.toISOString(),
    });
  return brief;
}
