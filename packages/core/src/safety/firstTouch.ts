/**
 * First messages on autopilot (plan 29 §B2.2, §B6): the last rung of the ladder, the evening review around each
 * morning send, and the conditions a person must meet before Orbit writes to them first on its own. Pure, so the
 * server's plan step, the browser's local plan step, the send job, the chat and the tests all read one answer.
 */
import { ACADEMIC_TITLE, isRecruiter } from '../drafts/sector';
import { normalizeCompany } from '../text/normalize';
import type { GoalKind, MessageKind } from '../types';
import {
  AUTO_FIRST_TOUCH_RUNG,
  AUTO_SEND_MIN_SCORE,
  looksLikeMinor,
  REVIEW_WINDOW_HOURS,
  SEND_CAPS,
} from './rules';

/** The kinds that are a first message: what the rung counts and the first-message caps limit. */
export const AUTO_FIRST_TOUCH_KINDS = [
  'outreach',
  'first_touch',
  'warm_first_touch',
] as const satisfies readonly MessageKind[];

export function isFirstTouchKind(kind: string | undefined | null): boolean {
  return !!kind && (AUTO_FIRST_TOUCH_KINDS as readonly string[]).includes(kind);
}

// ---- the rung ----------------------------------------------------------------------------------------------------

/** One approval as the rung reads it: what kind, whether the student changed the words, whether Orbit sent it alone. */
export interface RungApproval {
  kind: string;
  /** the student changed the words before it went */
  edited: boolean;
  /** Orbit sent it on its own: it never counts toward a rung */
  auto?: boolean;
}

export interface FirstTouchRung {
  /** first messages approved by hand without an edit (capped at `needed` for display) */
  unchanged: number;
  needed: number;
  /** silence after the evening review is consent from here on */
  earned: boolean;
}

/**
 * The first-message rung: every first message the student approved by hand without changing a word counts, whenever it
 * was. Unlike the ladder's streaks an edit does not start it over; it only does not count. Orbit's own sends never
 * count, so the rung is earned by the student's taps alone.
 */
export function firstTouchRung(approvals: readonly RungApproval[]): FirstTouchRung {
  const n = approvals.filter((a) => isFirstTouchKind(a.kind) && !a.edited && !a.auto).length;
  return {
    unchanged: Math.min(n, AUTO_FIRST_TOUCH_RUNG),
    needed: AUTO_FIRST_TOUCH_RUNG,
    earned: n >= AUTO_FIRST_TOUCH_RUNG,
  };
}

/** The rung said in a sentence, for Settings, the trust card and the chat. */
export function firstTouchRungLine(r: Pick<FirstTouchRung, 'unchanged' | 'needed' | 'earned'>): string {
  if (r.earned)
    return `You approved ${r.needed} first messages without changing a word, so Tomorrow's batch now goes in the morning unless you hold one.`;
  const left = r.needed - r.unchanged;
  return `${r.unchanged} of ${r.needed} first messages approved unchanged. Until ${left === 1 ? 'one more goes' : `${left} more go`} out as Orbit wrote ${left === 1 ? 'it' : 'them'}, each first message in the evening batch waits for your tap.`;
}

// ---- the evening review ------------------------------------------------------------------------------------------

const HOUR = 3_600_000;

/**
 * The times around one autopilot first message: it goes at `sendAt` (the recipient's morning window), nothing sends it
 * before `reviewUntil` (the same moment: the review lasts until it goes), and the evening review opens
 * REVIEW_WINDOW_HOURS before, when the batch card tells the student it is ready.
 */
export interface ReviewWindow {
  sendAt: string;
  reviewUntil: string;
  reviewOpensAt: string;
}

export function reviewWindow(sendAt: Date | string): ReviewWindow {
  const at = typeof sendAt === 'string' ? new Date(sendAt) : sendAt;
  return {
    sendAt: at.toISOString(),
    reviewUntil: at.toISOString(),
    reviewOpensAt: new Date(at.getTime() - REVIEW_WINDOW_HOURS * HOUR).toISOString(),
  };
}

/**
 * The earliest moment a plan made now may send: a full review window from now, so a batch planned at ten in the
 * morning goes the next morning and is in front of the student that evening, never within the hour.
 */
export function earliestPlannedSend(now: Date): Date {
  return new Date(now.getTime() + REVIEW_WINDOW_HOURS * HOUR);
}

/**
 * What happens to an autopilot first message when its time comes: it goes once the rung is earned or the student
 * tapped it; before the rung, silence is not consent and it waits as a draft (`needs_tap`).
 */
export type FirstTouchGate = 'sends' | 'needs_tap';

export function firstTouchGate(p: { rungEarned: boolean; tapped: boolean }): FirstTouchGate {
  return p.rungEarned || p.tapped ? 'sends' : 'needs_tap';
}

// ---- who autopilot may write to first (§B6) ---------------------------------------------------------------------

/** Why a person was not written to first on Orbit's own: one rule each, said in a sentence by `skipReason`. */
export type FirstTouchSkipRule =
  | 'do_not_contact'
  | 'hidden'
  | 'private'
  | 'minor'
  | 'already_written'
  | 'open_chat'
  | 'pending'
  | 'recruiter'
  | 'faculty'
  | 'not_target_company'
  | 'not_close'
  | 'no_email'
  | 'no_hook'
  | 'target_met'
  | 'paced'
  | 'weekly_cap'
  | 'daily_cap'
  | 'same_firm_today';

/** One person the plan step weighs, from the student's own people or a friend's share. */
export interface FirstTouchCandidate {
  personId: string;
  name: string;
  company?: string | null;
  title?: string | null;
  headline?: string | null;
  isAlumni?: boolean;
  /** the tie score, 0 to 100 */
  score: number;
  /**
   * Reachable through a friend on Orbit (plan 29 §A): the friend is asked and forwards, so nothing is ever drafted to
   * the person. Set for a friend's contact the student does not have, and beside a person the student has.
   */
  viaFriend?: { userId: string; name: string; sharePersonId: string };
  /** something researched about them with a source id a first message can open with */
  hasHook: boolean;
  hasEmail: boolean;
  hidden?: boolean;
  private?: boolean;
  doNotContact?: boolean;
  /** the profile says they are under 18 (`looksLikeMinor` reads the title and headline too) */
  isMinor?: boolean;
  /** a chat with them is still going */
  openChat?: boolean;
  /** the student has written to them before: autopilot only writes first messages */
  written?: boolean;
  /** a first message to them is already drafted, queued or held */
  pending?: boolean;
}

/** The goal a plan runs for: its kind (faculty only for research goals) and its target companies. */
export interface FirstTouchGoal {
  kind: GoalKind;
  /** company names, as the goal keeps them */
  targets: string[];
}

/** How a pick is reached: a first message from the student, or an ask to the friend who knows them. */
export type FirstTouchRoute = 'direct' | 'friend';

export interface FirstTouchPick {
  candidate: FirstTouchCandidate;
  route: FirstTouchRoute;
}

export interface FirstTouchSkip {
  personId: string;
  name: string;
  company: string | null;
  rule: FirstTouchSkipRule;
  reason: string;
}

/** The same firm, however the student or the profile spells it. */
export function firmKey(company: string | null | undefined): string {
  return normalizeCompany(company ?? '');
}

/** True for a professor, lecturer, dean or postdoc: written to on Orbit's own only for a research goal. */
export function isFaculty(c: Pick<FirstTouchCandidate, 'title' | 'headline'>): boolean {
  return ACADEMIC_TITLE.test(`${c.title ?? ''} ${c.headline ?? ''}`);
}

/** Close enough to write to first on Orbit's own: an alum, closeness 40 or more, or a friend's contact. */
export function closeEnough(c: Pick<FirstTouchCandidate, 'isAlumni' | 'score' | 'viaFriend'>): boolean {
  return !!c.isAlumni || c.score >= AUTO_SEND_MIN_SCORE || !!c.viaFriend;
}

/**
 * The route a person takes: a first message when the student knows them (an alum, or closeness 40 or more) and has
 * their address; otherwise, when a friend knows them, the ask goes to the friend.
 */
export function firstTouchRoute(c: FirstTouchCandidate): FirstTouchRoute {
  const own = !!c.isAlumni || c.score >= AUTO_SEND_MIN_SCORE;
  return own && c.hasEmail ? 'direct' : c.viaFriend ? 'friend' : 'direct';
}

/**
 * The conditions about the person themselves (§B6), in the order the reason is told: the first that fails, or
 * undefined when Orbit may write to them first on its own. Caps and the one-firm-a-day rule depend on the day and are
 * applied by `planFirstTouchDay`.
 */
export function firstTouchBlock(
  c: FirstTouchCandidate,
  goal: FirstTouchGoal,
): FirstTouchSkipRule | undefined {
  if (c.doNotContact) return 'do_not_contact';
  if (c.hidden) return 'hidden';
  if (c.private) return 'private';
  if (looksLikeMinor({ isMinor: c.isMinor, title: c.title ?? undefined, headline: c.headline ?? undefined }))
    return 'minor';
  if (c.written) return 'already_written';
  if (c.openChat) return 'open_chat';
  if (c.pending) return 'pending';
  if (isRecruiter(c.title ?? undefined) || isRecruiter(c.headline ?? undefined)) return 'recruiter';
  if (isFaculty(c) && goal.kind !== 'collaboration') return 'faculty';
  const firm = firmKey(c.company);
  if (!firm || !goal.targets.some((t) => firmKey(t) === firm)) return 'not_target_company';
  if (!closeEnough(c)) return 'not_close';
  if (firstTouchRoute(c) === 'direct') {
    if (!c.hasEmail) return 'no_email';
    if (!c.hasHook) return 'no_hook';
  }
  return undefined;
}

const firstOf = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Why a person was not written to, in one sentence the student reads (the chat quotes it). */
export function skipReason(
  rule: FirstTouchSkipRule,
  c: Pick<FirstTouchCandidate, 'name' | 'company'>,
  ctx: { other?: string } = {},
): string {
  const f = firstOf(c.name);
  const at = c.company ? ` at ${c.company}` : '';
  switch (rule) {
    case 'do_not_contact':
      return `${f} asked not to be contacted, so Orbit never writes to them.`;
    case 'hidden':
      return `You hid ${f}, so Orbit leaves them out.`;
    case 'private':
      return `You marked ${f} private, so autopilot leaves them to you.`;
    case 'minor':
      return `${f} looks to be under 18, so Orbit never writes to them.`;
    case 'already_written':
      return `You have written to ${f} before. Autopilot only sends first messages; the follow ups are bumps.`;
    case 'open_chat':
      return `You are already talking with ${f}, so there is no first message to send.`;
    case 'pending':
      return `A first message to ${f} is already drafted or waiting in the batch.`;
    case 'recruiter':
      return `${f} is a recruiter${at}. Autopilot never writes a first message to a recruiter; that one is yours to send.`;
    case 'faculty':
      return `${f} is faculty. Autopilot writes to faculty only for a research goal.`;
    case 'not_target_company':
      return c.company
        ? `${f} is at ${c.company}, which is not one of the companies on your goals.`
        : `Orbit does not know where ${f} works, so it cannot tell they are at a company on your goals.`;
    case 'not_close':
      return `${f} is not an alum, not someone you know well (closeness ${AUTO_SEND_MIN_SCORE} or more) and not a friend's contact, so a first message to them is yours to send.`;
    case 'no_email':
      return `Orbit has no email address for ${f}, and autopilot sends by email only.`;
    case 'no_hook':
      return `Orbit has nothing researched about ${f} to open with yet, and a first message on its own needs one.`;
    case 'target_met':
      return `This week's target is met, so ${f} waits for next week.`;
    case 'paced':
      return `That morning's share of your weekly target is already planned, so ${f} moves to the next day.`;
    case 'weekly_cap':
      return `Autopilot already has ${SEND_CAPS.autoFirstTouchesPerWeek} first messages this week, its weekly limit, so ${f} waits for next week.`;
    case 'daily_cap':
      return `Autopilot already has ${SEND_CAPS.autoFirstTouchesPerDay} first messages for that morning, its daily limit, so ${f} moves to the next day.`;
    case 'same_firm_today':
      return `${ctx.other ?? 'Someone else'}${at} gets a first message that morning, and autopilot never writes to two people at one firm on the same day, so ${f} moves to the next day.`;
  }
}

export interface FirstTouchDayInput {
  candidates: FirstTouchCandidate[];
  goal: FirstTouchGoal;
  /** first messages the week still needs (`weekPace(...).remaining`) */
  remaining: number;
  /** working days left in the week, today included (`weekPace(...).daysLeft`) */
  daysLeft: number;
  /** Orbit's own first messages already sent or queued for the send day, and this week */
  onDay: number;
  thisWeek: number;
  /** the firms already written to first on the send day, with who it was */
  firmsOnDay: { firm: string; name: string }[];
}

export interface FirstTouchDay {
  picks: FirstTouchPick[];
  skipped: FirstTouchSkip[];
  /** how many the day could still take */
  quota: number;
}

/**
 * The first messages for one send day (§B6): the people who pass every condition, alumni first, then the people the
 * student knows best, then a friend's contacts; never two at one firm that day; at most three a day and twelve a week
 * of Orbit's own, and no more than the week's remaining target spread over the days left. Everyone else is skipped
 * with the rule that stopped them.
 */
export function planFirstTouchDay(i: FirstTouchDayInput): FirstTouchDay {
  const quota = Math.max(
    0,
    Math.min(
      SEND_CAPS.autoFirstTouchesPerDay - i.onDay,
      SEND_CAPS.autoFirstTouchesPerWeek - i.thisWeek,
      i.remaining > 0 ? Math.ceil(i.remaining / Math.max(1, i.daysLeft)) : 0,
    ),
  );
  const order = (c: FirstTouchCandidate) =>
    (c.isAlumni ? 200 : 0) + (firstTouchRoute(c) === 'direct' ? 100 : 0) + c.score;
  const sorted = [...i.candidates].sort((a, b) => order(b) - order(a) || a.name.localeCompare(b.name));
  const firms = new Map(i.firmsOnDay.map((f) => [f.firm, f.name]));
  const picks: FirstTouchPick[] = [];
  const skipped: FirstTouchSkip[] = [];
  const skip = (c: FirstTouchCandidate, rule: FirstTouchSkipRule, other?: string) =>
    skipped.push({
      personId: c.personId,
      name: c.name,
      company: c.company ?? null,
      rule,
      reason: skipReason(rule, c, { other }),
    });
  for (const c of sorted) {
    const block = firstTouchBlock(c, i.goal);
    if (block) {
      skip(c, block);
      continue;
    }
    if (picks.length >= quota) {
      skip(
        c,
        i.remaining <= picks.length
          ? 'target_met'
          : i.thisWeek + picks.length >= SEND_CAPS.autoFirstTouchesPerWeek
            ? 'weekly_cap'
            : i.onDay + picks.length >= SEND_CAPS.autoFirstTouchesPerDay
              ? 'daily_cap'
              : 'paced',
      );
      continue;
    }
    const firm = firmKey(c.company);
    const other = firms.get(firm);
    if (other !== undefined) {
      skip(c, 'same_firm_today', other);
      continue;
    }
    firms.set(firm, c.name);
    picks.push({ candidate: c, route: firstTouchRoute(c) });
  }
  return { picks, skipped, quota };
}
