import { unsupportedDetails } from '../drafts/validate';
import type { ReplyClass } from '../email/replyClass';
import { extractProposedTimes } from '../email/triage';
import { normalizeEmail } from '../text/normalize';
import type { MessageKind } from '../types';

/**
 * Hard rules (plan 16 §14.6), enforced in code by the send path and by compose, not only by prompts. Two kinds:
 * `needs_approval` rules hold a message until the student approves that exact message (its hash); `forbidden` rules
 * hold it whatever anyone approves. Each rule is its own pure check so it can be tested and reported on its own.
 */

export type SafetyRule =
  | 'linkedin_needs_approval'
  | 'first_message_needs_approval'
  | 'money_needs_approval'
  | 'attachment_needs_approval'
  | 'link_needs_approval'
  | 'time_commitment_needs_approval'
  | 'calendar_needs_approval'
  | 'intro_ask_needs_approval'
  | 'cross_thread_needs_approval'
  | 'do_not_contact'
  | 'unanswered_limit'
  | 'impersonation'
  | 'invented_fact'
  | 'minor'
  | 'sensitive_category';

export interface SafetyViolation {
  rule: SafetyRule;
  kind: 'needs_approval' | 'forbidden';
  detail: string;
}

/** What the send path is about to do. */
export interface OutgoingAction {
  /** a message, or a calendar event created or changed for the student */
  action?: 'message' | 'calendar_event';
  kind?: MessageKind;
  channel: 'gmail' | 'linkedin';
  personId: string;
  subject?: string | null;
  body: string;
  attachments?: string[];
  /** the address it goes out from */
  fromEmail?: string;
  /** the name it is signed with */
  signedAs?: string;
}

export interface SendContext {
  now: Date;
  /** the student's own addresses (send-as aliases included) and name */
  userEmails: string[];
  userName: string;
  recipient: {
    doNotContact?: boolean;
    /** the profile says they are under 18, or a school year says so (see `looksLikeMinor`) */
    isMinor?: boolean;
    title?: string;
    headline?: string;
  };
  /** messages already exchanged with this person, any channel, oldest first or not */
  history: { direction: 'in' | 'out'; at: string }[];
  /** the student's scheduling link: the one link a message may carry without approval */
  schedulingLink?: string;
  /** slots the student offered or accepted (ISO starts): times beyond these are new commitments */
  offeredSlots?: string[];
  timeZone?: string;
  /** everything the message may draw on, for the invented-fact check (§7.5); skipped when absent */
  inputs?: string;
  /** text from other people's threads that must not leak into this message without approval */
  otherThreads?: string[];
  /** the hash of the exact message the student approved (`messageHash`) */
  approvedHash?: string;
}

/** A stable hash of the exact message (channel, subject, body, attachments): approval is for these words only. */
export function messageHash(m: Pick<OutgoingAction, 'channel' | 'subject' | 'body' | 'attachments'>): string {
  const s = [m.channel, m.subject ?? '', m.body, ...(m.attachments ?? [])].join('\u0000');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export const MAX_UNANSWERED_MESSAGES = 3;

const MONEY =
  /(?:[$€£]\s?\d[\d,.]*\s?(?:k|m|mm|bn|million|billion|thousand)?\b)|\b\d[\d,.]*\s?(?:k|m|mm|bn|million|billion|thousand)?\s?(?:dollars|usd|eur|euros|gbp|pounds)\b/i;
const ATTACHED = /\b(attached|attaching|see the attachment|in the attachment|enclosed)\b/i;
const URL = /https?:\/\/[^\s)>"']+/g;
/** Words that put a person under 18: a profile in high school or younger, or a stated age. */
const MINOR =
  /\b(high school|highschool|middle school|hs (freshman|sophomore|junior|senior)|(9|10|11|12)th grade|grade (9|10|11|12)|class of 20(2[7-9]|3\d) at .*high|aged? 1[0-7]\b|1[0-7] years old)\b/i;
/** Sensitive categories (GDPR art. 9 and the like) said about the recipient. */
const SENSITIVE =
  /\b(your|you are|you're|as an? \w+ yourself)\b[^.?!]{0,40}\b(religio\w*|faith|church|mosque|synagogue|diagnos\w*|illness|disease|cancer|pregnan\w*|disabilit\w*|mental health|therapy|sexual\w*|orientation|gay|lesbian|transgender|ethnicit\w*|race|immigration status|visa status|undocumented|political (views|party|affiliation)|union member\w*|criminal record|arrest\w*)\b/i;

/** Saying the recipient is a member of a sensitive group ("as a fellow Christian yourself", "since you're an immigrant"). */
const SENSITIVE_IDENTITY =
  /\b(?:as an? (?:fellow )?|you are an? |you're an? |since you(?: are|'re) an? )(?:christian|muslim|jewish|jew|hindu|buddhist|sikh|catholic|mormon|atheist|gay|lesbian|bisexual|queer|transgender|immigrant|undocumented|disabled|pregnant|black|latino|latina|latinx|asian|hispanic|democrat|republican)\b/i;

const approval = (rule: SafetyRule, detail: string): SafetyViolation => ({
  rule,
  kind: 'needs_approval',
  detail,
});
const forbid = (rule: SafetyRule, detail: string): SafetyViolation => ({ rule, kind: 'forbidden', detail });

// --- one check per rule ------------------------------------------------------------------------------------------

export function checkLinkedIn(d: OutgoingAction): SafetyViolation[] {
  return d.channel === 'linkedin'
    ? [approval('linkedin_needs_approval', 'every LinkedIn message is approved')]
    : [];
}

export function checkFirstMessage(d: OutgoingAction, ctx: SendContext): SafetyViolation[] {
  if (d.action === 'calendar_event') return [];
  return ctx.history.some((m) => m.direction === 'out')
    ? []
    : [approval('first_message_needs_approval', 'a first message to anyone is approved')];
}

export function checkMoney(d: OutgoingAction): SafetyViolation[] {
  const hit = `${d.subject ?? ''}\n${d.body}`.match(MONEY);
  return hit ? [approval('money_needs_approval', `mentions ${hit[0].trim()}`)] : [];
}

export function checkAttachments(d: OutgoingAction): SafetyViolation[] {
  if (d.attachments?.length) return [approval('attachment_needs_approval', d.attachments.join(', '))];
  return ATTACHED.test(d.body) ? [approval('attachment_needs_approval', 'says something is attached')] : [];
}

export function checkLinks(d: OutgoingAction, ctx: Pick<SendContext, 'schedulingLink'>): SafetyViolation[] {
  const links = (d.body.match(URL) ?? []).filter(
    (u) => !(ctx.schedulingLink && u.startsWith(ctx.schedulingLink)),
  );
  return links.length ? [approval('link_needs_approval', links.join(', '))] : [];
}

/** Times in the message that are not among the offered slots (±15 minutes) are new commitments. */
export function checkTimeCommitments(
  d: OutgoingAction,
  ctx: Pick<SendContext, 'now' | 'offeredSlots' | 'timeZone'>,
): SafetyViolation[] {
  const offered = (ctx.offeredSlots ?? []).map((s) => new Date(s).getTime());
  const extra = extractProposedTimes(d.body, ctx.now, ctx.timeZone).filter(
    (t) => !offered.some((o) => Math.abs(o - new Date(t.startIso).getTime()) <= 15 * 60_000),
  );
  return extra.length
    ? [approval('time_commitment_needs_approval', `commits to ${extra.map((t) => t.raw).join(', ')}`)]
    : [];
}

export function checkCalendar(d: OutgoingAction): SafetyViolation[] {
  return d.action === 'calendar_event'
    ? [approval('calendar_needs_approval', 'calendar events are created only after approval')]
    : [];
}

export function checkIntroAsk(d: OutgoingAction): SafetyViolation[] {
  return d.kind === 'intro_request' || d.kind === 'forwardable_blurb'
    ? [approval('intro_ask_needs_approval', 'asking a third party for an introduction is approved')]
    : [];
}

/** A run of eight or more words from another person's thread in this message. */
export function checkCrossThread(
  d: OutgoingAction,
  ctx: Pick<SendContext, 'otherThreads'>,
): SafetyViolation[] {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const body = ` ${words(d.body).join(' ')} `;
  for (const t of ctx.otherThreads ?? []) {
    const w = words(t);
    for (let i = 0; i + 8 <= w.length; i++) {
      const run = ` ${w.slice(i, i + 8).join(' ')} `;
      if (body.includes(run))
        return [approval('cross_thread_needs_approval', `repeats another thread: "${run.trim()}"`)];
    }
  }
  return [];
}

export function checkDoNotContact(ctx: Pick<SendContext, 'recipient'>): SafetyViolation[] {
  return ctx.recipient.doNotContact ? [forbid('do_not_contact', 'they asked not to be contacted')] : [];
}

/** Messages to this person since their last answer; the one being sent would be the (n + 1)th. */
export function unansweredBefore(history: SendContext['history']): number {
  let n = 0;
  for (const m of [...history].sort((a, b) => a.at.localeCompare(b.at))) n = m.direction === 'in' ? 0 : n + 1;
  return n;
}

export function checkUnanswered(d: OutgoingAction, ctx: Pick<SendContext, 'history'>): SafetyViolation[] {
  if (d.action === 'calendar_event') return [];
  const n = unansweredBefore(ctx.history);
  return n >= MAX_UNANSWERED_MESSAGES
    ? [forbid('unanswered_limit', `${n} messages already without an answer`)]
    : [];
}

export function checkImpersonation(
  d: OutgoingAction,
  ctx: Pick<SendContext, 'userEmails' | 'userName'>,
): SafetyViolation[] {
  const out: SafetyViolation[] = [];
  const mine = new Set(ctx.userEmails.map(normalizeEmail));
  if (d.fromEmail && !mine.has(normalizeEmail(d.fromEmail)))
    out.push(forbid('impersonation', `sent from ${d.fromEmail}, not the student's address`));
  if (d.signedAs) {
    const names = ctx.userName.toLowerCase().split(/\s+/);
    const signed = d.signedAs.toLowerCase().split(/\s+/);
    if (!signed.every((w) => names.includes(w))) out.push(forbid('impersonation', `signed as ${d.signedAs}`));
  }
  return out;
}

export function checkInventedFacts(d: OutgoingAction, ctx: Pick<SendContext, 'inputs'>): SafetyViolation[] {
  if (ctx.inputs === undefined) return [];
  return unsupportedDetails(`${d.subject ?? ''}\n${d.body}`, ctx.inputs).map((u) =>
    forbid('invented_fact', `${u} is not in the inputs`),
  );
}

/** True when a profile reads as someone under 18. */
export function looksLikeMinor(r: SendContext['recipient']): boolean {
  return !!r.isMinor || MINOR.test(`${r.title ?? ''} ${r.headline ?? ''}`);
}

export function checkMinor(ctx: Pick<SendContext, 'recipient'>): SafetyViolation[] {
  return looksLikeMinor(ctx.recipient) ? [forbid('minor', 'the recipient appears to be under 18')] : [];
}

export function checkSensitive(d: OutgoingAction): SafetyViolation[] {
  const hit = d.body.match(SENSITIVE) ?? d.body.match(SENSITIVE_IDENTITY);
  return hit ? [forbid('sensitive_category', `says something sensitive about them: "${hit[0]}"`)] : [];
}

/**
 * Every hard rule against one outgoing message or calendar change. Approval rules are dropped when the student
 * approved this exact message (`approvedHash` equals `messageHash`); forbidden rules never are.
 */
export function checkSend(d: OutgoingAction, ctx: SendContext): SafetyViolation[] {
  const all = [
    ...checkDoNotContact(ctx),
    ...checkMinor(ctx),
    ...checkUnanswered(d, ctx),
    ...checkImpersonation(d, ctx),
    ...checkInventedFacts(d, ctx),
    ...checkSensitive(d),
    ...checkLinkedIn(d),
    ...checkFirstMessage(d, ctx),
    ...checkMoney(d),
    ...checkAttachments(d),
    ...checkLinks(d, ctx),
    ...checkTimeCommitments(d, ctx),
    ...checkCalendar(d),
    ...checkIntroAsk(d),
    ...checkCrossThread(d, ctx),
  ];
  const approved = !!ctx.approvedHash && ctx.approvedHash === messageHash(d);
  return approved ? all.filter((v) => v.kind === 'forbidden') : all;
}

/** True when nothing holds the message. */
export function sendAllowed(violations: SafetyViolation[]): boolean {
  return violations.length === 0;
}

// --- the cap table (plan 29 §B2.1): one rulebook for the browser's outbox and the server's send job ---------------

/**
 * How much may go out, by hand and on Orbit's own. The browser (`checkSendAllowed`) and the server (`sendDraft`)
 * both read this table; a lower limit the student set for themselves still wins. "By hand" counts every approval,
 * one tap or a plan approved once; "auto" counts what Orbit sent without a tap at send time (the ladder's kinds, and
 * later the first messages autopilot writes). LinkedIn is never sent on Orbit's own, at any level.
 */
export const SEND_CAPS = {
  /** emails a day, by hand */
  gmailPerDay: 15,
  /** LinkedIn messages a day, by hand (every one a tap) */
  linkedinPerDay: 10,
  /** a sales goal's first touches by email a day: commercial email, with the postal address and the opt-out (§7.7) */
  gmailSalesFirstTouchesPerDay: 30,
  /** what Orbit sends on its own, a day */
  autoPerDay: 5,
  /** first messages Orbit sends on its own, a day and a week (plan 29 §B6) */
  autoFirstTouchesPerDay: 3,
  autoFirstTouchesPerWeek: 12,
  /** LinkedIn on Orbit's own: never */
  linkedinAutoPerDay: 0,
  /** LinkedIn invites (taps only), a day and a week, as the server counts them */
  linkedinInvitesPerDay: 15,
  linkedinInvitesPerWeek: 60,
} as const;

/**
 * The kinds the trust ladder (plan 23 §4.9) can hand to Orbit, in the order it offers them: bumps, then thank-yous,
 * then scheduling replies. `settings.autoKinds` holds the ones the student handed over; the server reads the same
 * list as `users.settings.auto_kinds` and auto-approves cadence drafts of those kinds under the same conditions.
 */
export const AUTO_KINDS = ['bump', 'thank_you', 'schedule'] as const satisfies readonly MessageKind[];
export type AutoKind = (typeof AUTO_KINDS)[number];

/** The three modes Settings offers (plan 29 §B1), one per autonomy level: off is 0, assist is 1, autopilot is 2. */
export type AutopilotMode = 'off' | 'assist' | 'autopilot';
export const AUTOPILOT_MODES: readonly AutopilotMode[] = ['off', 'assist', 'autopilot'];
export const AUTOPILOT_MODE_LEVEL: Record<AutopilotMode, 0 | 1 | 2> = { off: 0, assist: 1, autopilot: 2 };

// --- autonomy level 2 (§8.4) --------------------------------------------------------------------------------------

export const AUTO_SEND_DAILY_CAP = SEND_CAPS.autoPerDay;
export const AUTO_SEND_MIN_SCORE = 40;
export const AUTO_SEND_CLASSES: ReadonlySet<ReplyClass> = new Set(['scheduling', 'thanks', 'out_of_office']);

export interface AutonomyContext extends SendContext {
  /** the student's level, and the goal's override when it has one */
  userAutonomy: 0 | 1 | 2;
  goalAutonomy?: 0 | 1 | 2;
  /** the class of the reply this message answers */
  replyClass: ReplyClass;
  /** the message answers inside an existing thread */
  inThread: boolean;
  /** the recipient's tie score */
  recipientScore: number;
  /** compose validation passed (`validateComposed(...).ok`) */
  validatorOk: boolean;
  /** auto-sends already made today */
  autoSentToday: number;
  /** the recipient's time zone (the student's when unknown) */
  recipientTimeZone?: string;
}

function localHour(d: Date, tz?: string): number {
  if (!tz) return d.getUTCHours();
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d),
  );
}

/**
 * Whether level 2 may send this reply without asking (§8.4). All must hold: the effective level is 2; Gmail; a reply
 * inside a thread where both sides have written; a scheduling, thanks or out-of-office follow-up; the recipient's
 * score at least 40; no new commitments (money, times beyond the offered slots, attachments, links other than the
 * scheduling link) and no hard-rule violation; the validator passed; fewer than five auto-sends today; and not
 * between 21:00 and 7:00 in the recipient's time zone. `reasons` lists every condition that failed.
 */
export function autonomyAllows(
  d: OutgoingAction,
  ctx: AutonomyContext,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const level = ctx.goalAutonomy ?? ctx.userAutonomy;
  if (level < 2) reasons.push(`autonomy level ${level}`);
  if (d.channel !== 'gmail') reasons.push('not Gmail');
  const bothWrote =
    ctx.history.some((m) => m.direction === 'in') && ctx.history.some((m) => m.direction === 'out');
  if (!ctx.inThread || !bothWrote) reasons.push('not a reply in a two-way thread');
  if (!AUTO_SEND_CLASSES.has(ctx.replyClass)) reasons.push(`reply class ${ctx.replyClass}`);
  if (ctx.recipientScore < AUTO_SEND_MIN_SCORE)
    reasons.push(`score ${ctx.recipientScore} below ${AUTO_SEND_MIN_SCORE}`);
  const holds = checkSend(d, { ...ctx, approvedHash: undefined });
  for (const v of holds) reasons.push(v.rule);
  if (!ctx.validatorOk) reasons.push('validator failed');
  if (ctx.autoSentToday >= AUTO_SEND_DAILY_CAP) reasons.push(`${ctx.autoSentToday} auto-sends today`);
  const hour = localHour(ctx.now, ctx.recipientTimeZone ?? ctx.timeZone);
  if (hour >= 21 || hour < 7) reasons.push(`${hour}:00 in their time zone`);
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
