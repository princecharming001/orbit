/**
 * The morning debrief: once a day, after the student's brief time, a small deck in the middle of the screen walks
 * them through the day: how the week stands, the decisions waiting on them one at a time, and what is worth doing
 * today. It is built from what Orbit already has (the day's cards, the outbox, chats, the calendar, Discover), so it
 * never says anything Drafts or People would not. Every decision can be finished inside the deck; the few that need a
 * page of their own (prep, matching a note) say so on the button.
 */
import type {
  ActionItem,
  CalendarEvent,
  ChatStage,
  EmailThread,
  FeedbackEvent,
  MergeSuggestion,
  Person,
  Suggestion,
  User,
  UserSettings,
} from '@orbit/core';
import { cardReason, STAGE_LABELS, warmUpProgress } from '@orbit/core';
import { db } from '../db/schema';
import { isMessageSuggestion } from './brief';
import { type PersonSnapshot, restorePerson, snapshotPerson } from './send';
import { draftLists, notYetWritten, todayCards, weekStats } from './today';

/** At most this many decisions; the rest wait in Drafts, and the overview and the last slide say how many. */
export const MORNING_MAX_DECISIONS = 6;
/** At most this many lines under "Worth doing today". */
export const MORNING_MAX_MOVES = 4;

/** Cards that ask the student a question with a yes or no: they take a second each. */
const QUESTIONS = new Set<Suggestion['kind']>(['confirm_stage', 'confirm_intro', 'confirm_merge']);
/** Cards tied to a time today (a chat to prep, a time someone is waiting on): they go first. */
const TIMELY = new Set<Suggestion['kind']>(['prep_brief', 'schedule_confirm']);

export interface MorningStats {
  sentThisWeek: number;
  weeklyTarget: number;
  /** people who wrote back in the last day */
  replies: number;
  /** coffee chats on the calendar today */
  chatsToday: number;
  replyRate?: number;
}

/**
 * Something worth doing today beyond the decisions. `prep` opens the person's prep page (the one move that needs a
 * page); the rest are done inside the deck: a warm-up step on LinkedIn in a new tab, then Done, or a first message
 * drafted and approved right there.
 */
export interface MorningMove {
  id: string;
  kind: 'prep' | 'warm_up' | 'write' | 'reach_out';
  text: string;
  sub?: string;
  /** the page this move is about, for the person's name and for prep */
  href: string;
  personId: string;
  /** warm_up: the chat and the step to mark done, and where the step happens */
  chatId?: string;
  actionId?: string;
  url?: string;
  /** reach_out: the Discover pick it came from */
  recommendationId?: string;
}

export interface MorningDeck {
  greeting: string;
  dateLabel: string;
  /** one plain sentence about the day, under the greeting */
  headline: string;
  stats: MorningStats;
  /** the decisions, most pressing first: a time today, then quick questions, then messages, then the rest */
  decisions: Suggestion[];
  /** cards for today that did not fit as decisions; Drafts holds them */
  moreInDrafts: number;
  moves: MorningMove[];
  /** people the student has in Orbit (an empty account gets a different first line) */
  peopleCount: number;
}

function partOfDay(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capitalize = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

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

/** A recommendation's saved reason still holds for the person as Orbit knows them now. */
export function reasonHolds(
  reason: { code: string; text: string },
  person: Pick<Person, 'isAlumni' | 'strength' | 'currentTitle'>,
): boolean {
  if (reason.code === 'alumni') return !!person.isAlumni;
  if (reason.code === 'warm') return person.strength >= 0.3;
  // "Cornell alum, now an Analyst at Evercore": still an alum, still in that role
  if (reason.code === 'alumni_field')
    return !!person.isAlumni && !!person.currentTitle && reason.text.includes(` ${person.currentTitle}`);
  // "Analyst at Evercore, the role you're targeting" (or, saved before, "Works in investment banking (Analyst)"):
  // the title it names is still theirs
  if (reason.code === 'function_match' || reason.code === 'role_industry') {
    const quoted =
      reason.text.match(/\(([^)]+)\)$/)?.[1] ?? reason.text.match(/^(.+?)(?: at .+)?, (?:the role|in )/)?.[1];
    if (quoted && person.currentTitle !== quoted) return false;
  }
  return true;
}

/** The line under the greeting, from the same numbers the deck shows. */
export function morningHeadline(x: {
  decisions: number;
  moreInDrafts: number;
  chatsToday: number;
  replies: number;
  peopleCount: number;
}): string {
  const extras = [
    x.chatsToday ? `${plural(x.chatsToday, 'chat')} today` : '',
    x.replies ? plural(x.replies, 'new reply', 'new replies') : '',
  ].filter(Boolean);
  if (x.decisions) {
    const first = `${plural(x.decisions, 'thing')} to decide${x.moreInDrafts ? ` first, ${x.moreInDrafts} more in Drafts` : ''}`;
    return `${capitalize([first, ...extras].join(', '))}.`;
  }
  if (extras.length) return `Nothing to decide. ${capitalize(extras.join(', '))}.`;
  if (x.peopleCount === 0)
    return 'Add a few people you want to talk to, and Orbit lines up each morning for you here.';
  return 'Nothing is waiting on you. A good day to reach out to someone new.';
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
  const messages = forToday.filter((s) => visible(s.personId));
  const nonMessages = cards.filter((s) => !isMessageSuggestion(s.kind));
  // a time today first (a chat to prep, someone waiting on a time), then the quick questions, then the messages,
  // then the rest; each group keeps its priority order
  const ordered = [
    ...[...nonMessages, ...messages].filter((s) => TIMELY.has(s.kind)),
    ...nonMessages.filter((s) => QUESTIONS.has(s.kind)),
    ...messages.filter((s) => !TIMELY.has(s.kind)),
    ...nonMessages.filter((s) => !QUESTIONS.has(s.kind) && !TIMELY.has(s.kind)),
  ].filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);
  const decisions = ordered.slice(0, MORNING_MAX_DECISIONS);

  const week = weekStats(outbound, chats, people, settings?.weeklyOutreachTarget ?? 4, now);
  const dayAgo = now.getTime() - 86_400_000;
  const replies = chats.filter(
    (c) =>
      c.lastInboundAt &&
      new Date(c.lastInboundAt).getTime() >= dayAgo &&
      new Date(c.lastInboundAt).getTime() <= now.getTime() &&
      visible(c.personId),
  ).length;
  const sameDay = (iso: string) => localDay(new Date(iso)) === localDay(now);
  const todays: CalendarEvent[] = events
    // coffee chats only: a class or a team meeting on the calendar is not a chat to prep for
    .filter(
      (e) =>
        e.status !== 'cancelled' &&
        e.isCoffeeChat &&
        sameDay(e.startAt) &&
        e.attendeePersonIds.some((id) => byId.has(id) && visible(id)),
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  // what is worth doing today beyond the decisions: chats to prep, warm-up steps due, people to write to, Discover.
  // One line per person: someone already in a decision (or a line above) is not suggested again.
  const taken = new Set(decisions.map((s) => s.personId).filter(Boolean) as string[]);
  const moves: MorningMove[] = [];
  const add = (m: MorningMove) => {
    if (taken.has(m.personId) || !visible(m.personId)) return;
    taken.add(m.personId);
    moves.push(m);
  };
  const chatById = new Map(chats.map((c) => [c.id, c]));
  for (const e of todays) {
    // a chat that already started has nothing left to prep
    if (new Date(e.startAt) <= now) continue;
    // the person the chat is with, not whoever the invite lists first
    const p = byId.get((e.chatId && chatById.get(e.chatId)?.personId) || e.attendeePersonIds[0]!);
    if (!p) continue;
    add({
      id: `ev:${e.id}`,
      kind: 'prep',
      text: `Prep for ${p.firstName}`,
      sub: `Chat at ${new Date(e.startAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      href: `/people/${p.id}?tab=facts&prep=1`,
      personId: p.id,
    });
  }
  for (const c of chats) {
    if (c.stage !== 'warming' || !c.warmUp || !visible(c.personId) || !byId.has(c.personId)) continue;
    const p = byId.get(c.personId)!;
    const prog = warmUpProgress(c.warmUp, now, user.timezone);
    const next = c.warmUp.actions.find((a) => !a.doneAt && !a.skippedAt);
    if (prog.ready)
      add({
        id: `wu:${c.id}`,
        kind: 'write',
        text: `Write your first message to ${p.firstName}`,
        sub: 'The warm-up is done',
        href: `/people/${p.id}`,
        personId: p.id,
        chatId: c.id,
      });
    else if (next && new Date(next.dueAt) <= now) {
      // a step the student put off (Tomorrow) or turned down waits until it is due again
      const card = suggestions.find((s) => s.dedupeKey === `warm:${c.id}:${next.id}`);
      if (card && card.status !== 'pending' && !(card.status === 'snoozed' && live.includes(card))) continue;
      add({
        id: `wu:${c.id}`,
        kind: 'warm_up',
        text: `Warm-up step for ${p.firstName}`,
        sub: next.label,
        href: `/people/${p.id}`,
        personId: p.id,
        chatId: c.id,
        actionId: next.id,
        url: next.url,
      });
    }
  }
  for (const p of notYetWritten(people, chats, outbound, suggestions, now))
    add({
      id: `nw:${p.id}`,
      kind: 'write',
      text: `Write to ${p.firstName}`,
      sub: 'You added them and have not written yet',
      href: `/people/${p.id}`,
      personId: p.id,
    });
  // Discover's best picks fill what is left, while the list is short
  const picks = recs
    .filter((r) => visible(r.personId) && byId.has(r.personId) && !taken.has(r.personId))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (const r of picks) {
    if (moves.length >= MORNING_MAX_MOVES) break;
    const p = byId.get(r.personId)!;
    // a reason saved with the recommendation is said only while it still holds (an alum label taken off since)
    // the most specific one first (a target company or an alum in the field before the role alone)
    const reason = cardReason(r.reasons.filter((x) => reasonHolds(x, p)));
    add({
      id: `rec:${r.id}`,
      kind: 'reach_out',
      text: `Reach out to ${p.firstName}`,
      sub:
        reason?.text ??
        ([p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') || undefined),
      href: `/people/${p.id}`,
      personId: p.id,
      recommendationId: r.id,
    });
  }

  const moreInDrafts = Math.max(0, ordered.length - decisions.length);
  const peopleCount = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  return {
    greeting: `${partOfDay(now)}, ${user.firstName}`,
    dateLabel: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    headline: morningHeadline({
      decisions: decisions.length,
      moreInDrafts,
      chatsToday: todays.length,
      replies,
      peopleCount,
    }),
    stats: {
      sentThisWeek: week.sentThisWeek,
      weeklyTarget: week.weeklyTarget,
      replies,
      chatsToday: todays.length,
      replyRate: week.replyRate,
    },
    decisions,
    moreInDrafts,
    moves: moves.slice(0, MORNING_MAX_MOVES),
    peopleCount,
  };
}

// ---------- what each decision offers ----------

/**
 * What a button does: `resolve` decides the card right there, `compose` opens the draft inside the deck, `snooze`
 * puts it off until tomorrow, `tab` opens LinkedIn in a new tab (the deck stays), `page` goes to another page of
 * Orbit (the deck waits as a pill that brings the student back to the same step).
 */
export type MorningActionEffect = 'resolve' | 'compose' | 'snooze' | 'tab' | 'page';

export type MorningActionId =
  | 'yes'
  | 'no'
  | 'keep'
  | 'merge'
  | 'open_linkedin'
  | 'warm_done'
  | 'warm_skip'
  | 'prep_open'
  | 'prep_done'
  | 'item_done'
  | 'pick_person'
  | 'review'
  | 'start_warm_up'
  | 'tomorrow';

export interface MorningAction {
  id: MorningActionId;
  label: string;
  effect: MorningActionEffect;
  /** the one button Enter presses */
  primary?: boolean;
  /** what happens, in plain words, for the button's tooltip */
  hint: string;
}

export interface DecisionContext {
  firstName?: string;
  /** the card already has a draft to review */
  hasDraft: boolean;
  /** a first message to someone known only from LinkedIn: Orbit suggests a warm-up first */
  coldStart?: boolean;
  /** the stage a confirm_stage card proposes */
  toStage?: ChatStage;
  /** the student opened the warm-up step on LinkedIn already, so Done leads */
  openedLinkedIn?: boolean;
}

/** The "no" to a stage Orbit read from an email, in plain words rather than the stage's name. */
export function stageNoLabel(to: string | undefined, first: string): string {
  switch (to) {
    case 'declined':
      return `No, ${first} hasn't said no`;
    case 'replied':
      return `No, ${first} hasn't replied`;
    case 'scheduled':
      return 'No, nothing is booked yet';
    case 'scheduling':
      return 'No, not scheduling yet';
    case 'completed':
      return "No, we haven't talked yet";
    default:
      return 'No, leave it as it is';
  }
}

const TOMORROW: MorningAction = {
  id: 'tomorrow',
  label: 'Tomorrow',
  effect: 'snooze',
  hint: 'Hide it until tomorrow morning',
};

/** The buttons a decision shows, in order, with exactly one primary. The deck and its tests read the same list. */
export function decisionActions(
  s: Pick<Suggestion, 'kind' | 'chatId'>,
  ctx: DecisionContext,
): MorningAction[] {
  const first = ctx.firstName ?? 'them';
  switch (s.kind) {
    case 'confirm_stage':
      return [
        {
          id: 'yes',
          label: `Yes, mark as ${ctx.toStage ? STAGE_LABELS[ctx.toStage].toLowerCase() : 'changed'}`,
          effect: 'resolve',
          primary: true,
          hint: 'Moves the chat on your pipeline',
        },
        {
          id: 'no',
          label: stageNoLabel(ctx.toStage, first),
          effect: 'resolve',
          hint: 'Leaves the chat where it is',
        },
      ];
    case 'confirm_merge':
      return [
        {
          id: 'keep',
          label: 'Different people',
          effect: 'resolve',
          primary: true,
          hint: 'Keeps both records. Orbit will not ask again',
        },
        {
          id: 'merge',
          label: 'Same person, merge',
          effect: 'resolve',
          hint: 'Combines the two records into one. Asks first, since it cannot be undone',
        },
      ];
    case 'confirm_intro':
      return [
        {
          id: 'yes',
          label: 'Yes',
          effect: 'resolve',
          primary: true,
          hint: 'Adds them to your pipeline, noting who introduced you',
        },
        { id: 'no', label: 'No', effect: 'resolve', hint: 'Orbit will not ask about this thread again' },
      ];
    case 'warm_up_engage':
      if (!s.chatId)
        return [
          {
            id: 'open_linkedin',
            label: 'Open LinkedIn',
            effect: 'tab',
            primary: true,
            hint: 'Opens their profile in a new tab',
          },
          TOMORROW,
        ];
      return [
        {
          id: 'open_linkedin',
          label: 'Open LinkedIn',
          effect: 'tab',
          primary: !ctx.openedLinkedIn,
          hint: 'Opens their profile in a new tab. This stays open here',
        },
        {
          id: 'warm_done',
          label: 'Mark done',
          effect: 'resolve',
          primary: !!ctx.openedLinkedIn,
          hint: 'Logs the step; the next one shows on its day',
        },
        { id: 'warm_skip', label: 'Skip this step', effect: 'resolve', hint: 'Moves on to the next step' },
      ];
    case 'prep_brief':
      return [
        {
          id: 'prep_open',
          label: 'Open prep',
          effect: 'page',
          primary: true,
          hint: `Opens ${first}'s prep page. This brief waits at the bottom of the screen`,
        },
        { id: 'prep_done', label: 'Already prepped', effect: 'resolve', hint: 'Marks the prep done' },
      ];
    case 'action_item_reminder':
      return [
        { id: 'item_done', label: 'Done', effect: 'resolve', primary: true, hint: 'Marks the promise kept' },
        TOMORROW,
      ];
    case 'confirm_note_match':
      return [
        {
          id: 'pick_person',
          label: 'Pick the person',
          effect: 'page',
          primary: true,
          hint: 'Opens the note to pick who it was with. This brief waits at the bottom of the screen',
        },
        TOMORROW,
      ];
    default:
      if (!isMessageSuggestion(s.kind)) return [TOMORROW];
      if (ctx.coldStart)
        return [
          {
            id: 'start_warm_up',
            label: 'Start warm-up',
            effect: 'resolve',
            primary: true,
            hint: `A few light steps on LinkedIn before your first message to ${first}`,
          },
          {
            id: 'review',
            label: 'Write now instead',
            effect: 'compose',
            hint: 'Opens the draft here',
          },
          TOMORROW,
        ];
      return [
        {
          id: 'review',
          label: ctx.hasDraft ? 'Review and send' : 'Write it',
          effect: 'compose',
          primary: true,
          hint: ctx.hasDraft
            ? 'Opens the draft here. Nothing is sent until you approve it'
            : 'Orbit drafts it here. Nothing is sent until you approve it',
        },
        TOMORROW,
      ];
  }
}

// ---------- the last slide ----------

/** How a decision ended in the deck: a message approved, decided, put off until tomorrow, or skipped for now. */
export type MorningOutcome = 'sent' | 'done' | 'later' | 'skipped';

export interface MorningSummary {
  sent: number;
  done: number;
  later: number;
  skipped: number;
  /** decisions not reached or skipped, plus the cards that did not fit: all still in Drafts today */
  waitingInDrafts: number;
  /** short lines for the last slide, each one counted from the outcomes */
  lines: string[];
  /** one sentence about what is left */
  rest: string;
}

export function morningSummary(
  deck: Pick<MorningDeck, 'decisions' | 'moreInDrafts'>,
  outcomes: Record<string, MorningOutcome | undefined>,
): MorningSummary {
  const ids = new Set(deck.decisions.map((s) => s.id));
  const count = (o: MorningOutcome) =>
    Object.entries(outcomes).filter(([id, x]) => ids.has(id) && x === o).length;
  const sent = count('sent');
  const done = count('done');
  const later = count('later');
  const skipped = count('skipped');
  const untouched = deck.decisions.length - sent - done - later - skipped;
  const waitingInDrafts = skipped + untouched + deck.moreInDrafts;
  const lines = [
    sent ? `${plural(sent, 'message')} approved` : '',
    done ? `${done} decided` : '',
    later ? `${later} for tomorrow` : '',
    skipped ? `${skipped} skipped` : '',
  ].filter(Boolean);
  const rest = waitingInDrafts
    ? `${waitingInDrafts} ${sent + done + later + skipped ? 'more ' : ''}wait${waitingInDrafts === 1 ? 's' : ''} in Drafts whenever you are ready.`
    : 'Nothing else is waiting on you.';
  return { sent, done, later, skipped, waitingInDrafts, lines, rest };
}

// ---------- undo ----------

/** Everything one decision can change, kept so the deck's Undo puts it back. */
export interface DecisionSnapshot {
  at: string;
  suggestion?: Suggestion;
  people: PersonSnapshot[];
  merge?: MergeSuggestion;
  thread?: EmailThread;
  actionItem?: ActionItem;
  refs: string[];
}

export async function snapshotDecision(userId: string, s: Suggestion): Promise<DecisionSnapshot> {
  const thread =
    s.kind === 'confirm_intro' && typeof s.payload.threadId === 'string'
      ? await db.threads.get(s.payload.threadId)
      : undefined;
  const q = thread?.possibleIntroduction;
  const personIds = [
    ...new Set([s.personId, ...(q ? [q.introducerId, ...q.personIds] : [])].filter(Boolean) as string[]),
  ];
  const merge =
    s.kind === 'confirm_merge' && typeof s.payload.mergeId === 'string'
      ? await db.merges.get(s.payload.mergeId)
      : undefined;
  const actionItem =
    s.kind === 'action_item_reminder' && typeof s.payload.actionItemId === 'string'
      ? await db.actionItems.get(s.payload.actionItemId)
      : undefined;
  const refs = [s.id, s.chatId, s.payload.stageEventId, s.payload.mergeId, s.payload.threadId].filter(
    (x): x is string => typeof x === 'string',
  );
  return {
    at: new Date().toISOString(),
    suggestion: await db.suggestions.get(s.id),
    people: await Promise.all(personIds.map((id) => snapshotPerson(userId, id))),
    merge,
    thread,
    actionItem,
    refs,
  };
}

/** Put back what one decision changed: the card is pending again, the chat and the records as they were. */
export async function undoDecision(userId: string, snap: DecisionSnapshot): Promise<void> {
  for (const p of snap.people) await restorePerson(userId, p);
  if (snap.merge) await db.merges.put(snap.merge);
  if (snap.thread) await db.threads.put(snap.thread);
  if (snap.actionItem) await db.actionItems.put(snap.actionItem);
  if (snap.suggestion) await db.suggestions.put(snap.suggestion);
  // what the decision taught Orbit is taken back too, so an undone "keep both" can be asked again
  const refs = new Set(snap.refs);
  const learned = await db.feedback
    .where('userId')
    .equals(userId)
    .filter(
      (f: FeedbackEvent) =>
        f.createdAt >= snap.at && (refs.has(f.refId ?? '') || refs.has(f.suggestionId ?? '')),
    )
    .primaryKeys();
  if (learned.length) await db.feedback.bulkDelete(learned);
}
