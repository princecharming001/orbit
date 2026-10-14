import { splitSignature, stripQuotedReply } from '../text/email';
import type { MessageExtraction, ProposedTime, ReplySignal } from '../types';
import { heuristicSignal } from './triage';

/**
 * Reply classes (plan 16 §8.1): what a reply means for the next step. Eight classes come straight from the v1 signal
 * reader (email/triage.ts `heuristicSignal`); three it has no label for are found with keyword rules on top of it:
 * `unsubscribe` (stop writing to me: wins over everything), `not_now` (a timing push-back that invites coming back)
 * and `objection` (a concern about the offer: price, fit, the tool they already use, stage, terms).
 */
export type ReplyClass =
  | 'interested'
  | 'scheduling'
  | 'question'
  | 'objection'
  | 'referral'
  | 'not_now'
  | 'out_of_office'
  | 'decline'
  | 'unsubscribe'
  | 'thanks'
  | 'other';

export const REPLY_CLASSES: readonly ReplyClass[] = [
  'interested',
  'scheduling',
  'question',
  'objection',
  'referral',
  'not_now',
  'out_of_office',
  'decline',
  'unsubscribe',
  'thanks',
  'other',
];

/** Below this the server asks Haiku (§8.1); the heuristics' answer is kept as the fallback. */
export const REPLY_CLASS_LLM_THRESHOLD = 0.75;

/** The class each v1 signal maps to (§8.1 table), before the three new classes are looked for. */
export function classOfSignal(signal: ReplySignal): ReplyClass {
  switch (signal) {
    case 'reply_positive':
      return 'interested';
    case 'scheduling_proposal':
    case 'scheduling_confirmation':
    case 'reschedule':
      return 'scheduling';
    case 'question':
      return 'question';
    case 'referral_offer':
    case 'intro_offer':
      return 'referral';
    case 'out_of_office':
      return 'out_of_office';
    case 'reply_decline':
      return 'decline';
    case 'thank_you':
      return 'thanks';
    case 'reply_neutral':
    case 'other':
      return 'other';
  }
}

export interface ReplyClassContext {
  now: Date;
  /** the student's zone, for the times they propose */
  timeZone?: string;
  direction?: 'inbound' | 'outbound';
  /** the chat is still waiting on an answer to the student's ask */
  awaitingAnswer?: boolean;
}

export interface ReplyClassification {
  class: ReplyClass;
  confidence: number;
  /** the v1 signal underneath */
  signal: ReplySignal;
  extraction: MessageExtraction;
  proposedTimes: ProposedTime[];
  /** out-of-office return date, YYYY-MM-DD */
  returnDate: string | null;
  /** not now: the first day to follow up when they said when, YYYY-MM-DD */
  followUpAfter: string | null;
  /** a question they asked, when the class is `question` or an objection asked as one */
  question: string | null;
  /** sentences offering an introduction or a referral */
  offers: string[];
}

// --- unsubscribe: an explicit request to stop. Plain phrasings only; "don't hesitate to email me again" is not one.
const UNSUB: RegExp[] = [
  /\bunsubscribe\b/,
  /\bopt(?:[- ]me)?[- ]out\b/,
  /^\s*(?:please\s+)?(?:stop|remove me)[.!]*\s*$/,
  /\b(?:remove|take|delete)\b[^.?!]{0,30}\b(?:me|my (?:name|e-?mail|address)|this (?:e-?mail|address))\b[^.?!]{0,40}\b(?:list|lists|sequence|database|system|e-?mails|mailing|campaigns?|contacts?)\b/,
  /\b(?:stop|quit|cease)\b[^.?!]{0,12}\b(?:e-?mailing|e-?mails|contacting|messaging|reaching out|sending|writing|spamming|all contact)\b/,
  /\b(?:do not|don'?t|never)\b[^.?!]{0,16}\b(?:e-?mail|contact|message|write|reach out|add)\b[^.?!]{0,32}\b(?:again|anymore|any more)\b/,
  /\bno more (?:e-?mails|messages)\b/,
  /\b(?:lose|delete) my (?:e-?mail|address)\b/,
  /\bdo not contact\b/,
  /\bend these (?:e-?mails|messages)\b/,
  /\bdon'?t want to (?:receive|get) any more\b/,
  /\b(?:please )?don'?t follow up[.!]*\s*$/,
];

// --- not now: a timing push-back that invites coming back later
const LATER =
  /\b(later|after|until|once|when|then|again|down the road|next (?:week|month|quarter|year|spring|summer|fall|autumn|winter|semester|cycle)|in (?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|the (?:new year|spring|summer|fall|autumn|winter)|(?:a|a few|a couple(?: of)?|two|three|six|\d+) (?:weeks?|months?))|(?:january|february|march|april|may|june|july|august|september|october|november|december)|q[1-4]|new year|early 20\d\d|mid next year|the week after|closer to then|a month or so)\b/;
const COME_BACK =
  /\b(maybe|(?:could|can) we (?:talk|chat|connect|meet)|revisit|reconnect(?:ing)?|circle back|check (?:back|in)|reach (?:back )?out(?: again)?|ping me|follow up|try me|pick (?:this|it) up|table this|push this|talk again|connect after|hold off|remind me|send me something|keep (?:me posted|in touch)|stay in touch|touch base|let'?s (?:chat|talk)|happy to look|take a look|i'?d be (?:interested|happy to look)|might be open|we can talk|open to it)\b/;
const PUSHBACK =
  /\b(not (?:right )?now|not the right time|timing|bad time|too (?:early|soon)|down the road|later (?:this|in the) year|not this (?:cycle|quarter|year)|not a priority this|at capacity|heads[- ]down|swamped|slammed|buried|busy|hectic|plate is full|frozen|freeze|pausing|deployed|not (?:hiring|looking|raising|deploying)|won'?t make a decision|on (?:our|the) roadmap|deadline|parental leave|traveling|finals|new role|mid-?(?:reorg|migration|hiring)|evaluating vendors in|budget cycle|further along|blur|push this|table this|hold off|reconnect once|out on)\b/;

// --- objection: a concern about the offer itself
const OBJECTION: RegExp[] = [
  /\balready (?:use|using|have|work with|pay for)\b/,
  /\bwe use \w+ already\b/,
  /\b(?:built|build) (?:something|this|it)(?: similar)? in-house\b|\bin-house\b/,
  /\b(?:switching cost|locked into|committed to|non-starter|deal-?breaker|sticking point)\b/,
  /\b(?:pricing|price per|the price|too expensive|contract minimum|per seat|roi|cost is|software spend|no budget|budget for)\b/,
  /\b(?:thesis|mandate|outside (?:our|what our)|(?:is|isn't|not) (?:a|really a) fit|not a fit|venture-scale|cap table|solo founders?|arr\b|valuation|traction is)/,
  /\b(?:skeptical|not convinced|my concern|i'?d worry|crowded|incumbents|different from|overkill|adoption was|security team|soc ?2|on-?prem|sign off from legal|procurement|policy against|frozen all|big lift|reporting wasn't|we looked at you)\b/,
  /\b(?:not looking to leave|happy (?:at|where i am)|relocating|remote roles|in office|more junior|base is too low|compensation would)\b/,
  /\b(?:enough overlap|real overlap|our (?:lab|research|group) (?:is|doesn'?t|does not|works))\b/,
  /\b(?:through an agency|recruiting firm|don't work with outside|would use it|live in spreadsheets|hospitals will buy|sales cycles)\b/,
  /\b(?:too early for us to take a view|proof that customers)\b/,
];

const anyOf = (res: RegExp[], s: string) => res.some((r) => r.test(s));

function sentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNotNow(body: string, base: { signal: ReplySignal; extraction: MessageExtraction }): boolean {
  if (base.extraction.decline === 'soft' && base.extraction.followUpAfter) return true;
  if (base.extraction.proposedTimes.length || base.signal === 'scheduling_confirmation') return false;
  const sents = sentences(body);
  const comeBack = sents.some((s) => COME_BACK.test(s) && LATER.test(s));
  const pushback = PUSHBACK.test(body);
  if (base.signal === 'reply_decline') return comeBack || (pushback && LATER.test(body));
  // an out-of-office reply that asks to pick the thread up later is a person answering, not an auto-reply
  if (base.signal === 'out_of_office') return comeBack && !/\bauto/.test(body);
  // elsewhere the reader saw a yes, a question or nothing: only an explicit "not now, later" overrides it
  return comeBack && pushback;
}

/**
 * Classify one reply. `text` may be the raw body: quoted history and the signature are dropped first, as ingest does.
 * Confidence is the reader's own for mapped classes and fixed per rule for the new ones (0.95 unsubscribe, 0.9 or
 * 0.8 not now, 0.8 objection); the server sends anything under 0.75 to Haiku.
 */
export function classifyReply(text: string, ctx: ReplyClassContext): ReplyClassification {
  const stripped = stripQuotedReply(text);
  const body = (splitSignature(stripped).body || stripped).replace(/[‘’ʼ]/g, "'");
  const base = heuristicSignal(body, ctx.direction ?? 'inbound', ctx.now, {
    timeZone: ctx.timeZone,
    awaitingAnswer: ctx.awaitingAnswer,
  });
  const lower = body.toLowerCase();
  const x = base.extraction;
  const question = sentences(body).find((s) => s.endsWith('?')) ?? null;
  const out = (cls: ReplyClass, confidence: number): ReplyClassification => ({
    class: cls,
    confidence,
    signal: base.signal,
    extraction: x,
    proposedTimes: x.proposedTimes,
    returnDate: x.returnDate ?? null,
    followUpAfter: x.followUpAfter ?? null,
    question: cls === 'question' || cls === 'objection' ? question : null,
    offers: x.offers,
  });
  if (ctx.direction !== 'outbound') {
    const unsubscribeLines = sentences(lower).filter((s) => !/\bhesitate\b/.test(s));
    if (unsubscribeLines.some((s) => anyOf(UNSUB, s))) return out('unsubscribe', 0.95);
    if (base.signal !== 'referral_offer' && base.signal !== 'intro_offer') {
      if (isNotNow(lower, base)) return out('not_now', x.followUpAfter ? 0.9 : 0.8);
    }
    if (!['out_of_office', 'referral_offer', 'intro_offer'].includes(base.signal)) {
      const scheduling = ['scheduling_proposal', 'scheduling_confirmation', 'reschedule'].includes(
        base.signal,
      );
      if (!scheduling && !x.proposedTimes.length && anyOf(OBJECTION, lower)) return out('objection', 0.8);
    }
  }
  return out(classOfSignal(base.signal), base.confidence);
}
