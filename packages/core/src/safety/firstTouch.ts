/**
 * First messages on autopilot (plan 29 §B2.2, §B6): the last rung of the ladder, the evening review around each
 * morning send, and the conditions a person must meet before Orbit writes to them first on its own. Pure, so the
 * server's plan step, the browser's local plan step, the send job, the chat and the tests all read one answer.
 */
import type { MessageKind } from '../types';
import { AUTO_FIRST_TOUCH_RUNG, REVIEW_WINDOW_HOURS } from './rules';

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
