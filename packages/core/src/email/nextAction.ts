import { splitSignature, stripQuotedReply } from '../text/email';
import type { ReplyClass } from './replyClass';

/**
 * The class table, complete (plan 16 §8.3, plan 29 §B2.3): what happens next for each kind of reply, in one place
 * both senders read. The server's funnel (`maybeAutoReply`, `funnel.reply`) and the browser's local check run the
 * same rows; the chat quotes them when it explains what Orbit did with a reply.
 *
 *   interested     draft the reply with three free slots; at autopilot it goes on its own when the reply holds no
 *                  question
 *   scheduling     a time that matches an offered slot books the call and sends the confirmation; otherwise the
 *                  slots reply, which goes on its own at autopilot
 *   question       nothing is drafted: a Needs you card with the question, and the student's one line fills it
 *   objection      a draft for approval, never on its own
 *   not_now        a draft for approval, never on its own
 *   referral       a draft for approval, never on its own
 *   decline        no reply: the chat closes, the person is not written to again, the student is told
 *   unsubscribe    no reply: the chat closes, do not contact, the student is told
 *   thanks         a short acknowledgement, on its own at autopilot only when the reply holds no question
 *   out_of_office  no reply: the bumps wait, and the follow-up goes after the return date
 *   other          a draft only when the student asks for one
 */

export type ReplyNextAction =
  | 'draft_slots'
  | 'book_or_slots'
  | 'needs_you'
  | 'draft'
  | 'close'
  | 'acknowledge'
  | 'hold'
  | 'on_request';

/** Whether the reply Orbit drafts may go on its own at autopilot, before the send rules are checked. */
export type AutoRule = 'never' | 'always' | 'no_question';

export interface ReplyNextStep {
  action: ReplyNextAction;
  /** a draft is written without being asked */
  drafts: boolean;
  /** may go on its own at autopilot (then `autonomyAllows` has the last word) */
  auto: AutoRule;
  /** the person is not written to again */
  doNotContact: boolean;
  /** the chat moves to declined */
  closes: boolean;
  /** the student is told through a card */
  tells: boolean;
  /** the bumps wait until the person is back or has answered */
  holdsBumps: boolean;
  /** what the reply says about the message it answers (plan 29 §B2.5) */
  outcome: 'replied' | 'declined';
  /** the next step in one sentence, for the chat and the cards */
  summary: string;
}

export const REPLY_NEXT_ACTION: Record<ReplyClass, ReplyNextStep> = {
  interested: {
    action: 'draft_slots',
    drafts: true,
    auto: 'no_question',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: false,
    outcome: 'replied',
    summary:
      'They are interested: Orbit drafts a reply with three free times. On autopilot it goes on its own when they asked nothing.',
  },
  scheduling: {
    action: 'book_or_slots',
    drafts: true,
    auto: 'always',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: false,
    outcome: 'replied',
    summary:
      'They picked a time: when it matches one Orbit offered and the calendar is still free, the call is booked and the confirmation sent; otherwise a reply with free times.',
  },
  question: {
    action: 'needs_you',
    drafts: false,
    auto: 'never',
    doNotContact: false,
    closes: false,
    tells: true,
    holdsBumps: true,
    outcome: 'replied',
    summary:
      'They asked something only you know: it waits under Needs you, and your one-line answer drafts the reply.',
  },
  objection: {
    action: 'draft',
    drafts: true,
    auto: 'never',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: true,
    outcome: 'replied',
    summary: 'They raised a concern: Orbit drafts a reply for your approval and never sends it on its own.',
  },
  not_now: {
    action: 'draft',
    drafts: true,
    auto: 'never',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: true,
    outcome: 'replied',
    summary:
      'Not now: Orbit drafts a short reply for your approval and comes back when they said to, never on its own.',
  },
  referral: {
    action: 'draft',
    drafts: true,
    auto: 'never',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: true,
    outcome: 'replied',
    summary: 'They pointed you to someone: Orbit drafts the thank-you and the next ask for your approval.',
  },
  decline: {
    action: 'close',
    drafts: false,
    auto: 'never',
    doNotContact: true,
    closes: true,
    tells: true,
    holdsBumps: true,
    outcome: 'declined',
    summary: 'They declined: the chat closes, Orbit does not write to them again, and you are told.',
  },
  unsubscribe: {
    action: 'close',
    drafts: false,
    auto: 'never',
    doNotContact: true,
    closes: true,
    tells: true,
    holdsBumps: true,
    outcome: 'declined',
    summary:
      'They asked to stop: the chat closes, they are marked do not contact, no reply goes, and you are told.',
  },
  thanks: {
    action: 'acknowledge',
    drafts: true,
    auto: 'no_question',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: false,
    outcome: 'replied',
    summary:
      'They said thanks: a short acknowledgement, which goes on its own at autopilot when they asked nothing.',
  },
  out_of_office: {
    action: 'hold',
    drafts: false,
    auto: 'always',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: true,
    outcome: 'replied',
    summary: 'Out of office: the bumps wait, and the follow-up goes after they are back.',
  },
  other: {
    action: 'on_request',
    drafts: false,
    auto: 'never',
    doNotContact: false,
    closes: false,
    tells: false,
    holdsBumps: false,
    outcome: 'replied',
    summary: 'Orbit could not tell what they meant: ask for a draft when you want one.',
  },
};

/** The classes that get a draft without being asked. */
export const DRAFTED_CLASSES: readonly ReplyClass[] = (Object.keys(REPLY_NEXT_ACTION) as ReplyClass[]).filter(
  (c) => REPLY_NEXT_ACTION[c].drafts,
);

/** The classes whose reply closes the chat and marks the person do not contact. */
export const CLOSING_CLASSES: readonly ReplyClass[] = (Object.keys(REPLY_NEXT_ACTION) as ReplyClass[]).filter(
  (c) => REPLY_NEXT_ACTION[c].closes,
);

// --- a question in the reply ---------------------------------------------------------------------------------------

/** Ways of asking that carry no question mark. */
const ASKING = [
  /\b(?:let me know|tell me|curious|wondering|wonder)\b[^.!?\n]{0,40}\b(?:if|whether|what|when|where|which|who|how|why)\b/i,
  /\b(?:i'?d|i would) (?:like|love|want) to (?:know|hear|understand)\b/i,
  /\b(?:could|can|would) you (?:let me know|tell me|share|send|say|confirm|clarify)\b/i,
  /\b(?:any (?:idea|chance|thoughts?|sense) (?:if|whether|what|when|where|how|why|on|of))\b/i,
  /\b(?:quick|one) (?:question|q)\b/i,
  /\b(?:what|when|where|which|who|how|why) (?:do|does|did|would|will|should|are|is|were|was|have|has|can|could)\b[^.!?\n]*$/im,
];

/**
 * True when the reply asks the student something: a question mark, or an asking phrase, outside the quoted history
 * and the signature. "Thanks for reaching out, hope you are well" holds none; "Have you applied yet?" and "Let me
 * know if the portal worked" both do.
 */
export function holdsQuestion(text: string): boolean {
  const stripped = stripQuotedReply(text ?? '');
  const body = (splitSignature(stripped).body || stripped).trim();
  if (!body) return false;
  // a question mark that is not inside a quoted phrase ("why not?" said about someone else is still a question for
  // the reader of this reply, so only straight quotes around a whole sentence are set aside)
  const unquoted = body.replace(/"[^"\n]*"/g, '').replace(/“[^”\n]*”/g, '');
  if (/\?/.test(unquoted)) return true;
  return ASKING.some((re) => re.test(unquoted));
}

/**
 * Whether a reply of this class may go on its own at autopilot, before the send rules: the table's rule, with
 * `no_question` read against the reply's text. `autonomyAllows` applies this through `replyHoldsQuestion`.
 */
export function autoReplyClassAllowed(cls: ReplyClass, replyHoldsQuestion: boolean): boolean {
  const rule = REPLY_NEXT_ACTION[cls].auto;
  if (rule === 'never') return false;
  if (rule === 'always') return true;
  return !replyHoldsQuestion;
}
