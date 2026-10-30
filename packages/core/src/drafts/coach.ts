/**
 * The outreach coach: what an expert cold outreacher would say about a student's messages, and the style changes
 * that follow from it. Everything here is pure: the sample message for each kind of outreach (written by the real
 * draft engine), the review of sent messages (length for the channel, a reason to write to this person, throwaway
 * openers, the ask, the subject line, "I" versus "you", links in a first note, follow-up timing), and the change a
 * piece of feedback or a finding makes to the style card, with the line the tuning log shows for it.
 */
import type { Channel, MessageKind, PersonFact, StyleCard } from '../types';
import {
  BANNED_SUBJECT_PATTERNS,
  type DraftContext,
  generateDraft,
  LINKEDIN_NOTE_MAX,
  LINKEDIN_NOTE_TARGET,
  wordsIn,
} from './templates';

// ---------- kinds of outreach ----------

export type CoachType = 'cold_email' | 'linkedin_note' | 'linkedin_message' | 'reply' | 'follow_up';

export interface CoachTypeInfo {
  id: CoachType;
  label: string;
  /** a line under the tab, only where the channel has a rule worth saying (LinkedIn's character cut) */
  blurb?: string;
  /** past this the message is too long for the channel (words between greeting and sign-off) */
  maxWords?: number;
  /** past this the message is too long for the channel (characters, LinkedIn) */
  maxChars?: number;
  /** what a fix aims for */
  idealWords: number;
}

/** A LinkedIn message to a connection: read on a phone, so a few lines at most. */
export const LINKEDIN_DM_MAX = 300;

export const COACH_TYPES: readonly CoachTypeInfo[] = [
  {
    id: 'cold_email',
    label: 'Cold email',
    maxWords: 120,
    idealWords: 80,
  },
  {
    id: 'linkedin_note',
    label: 'LinkedIn note',
    blurb: `Free accounts are cut at ${LINKEDIN_NOTE_TARGET} characters.`,
    maxChars: LINKEDIN_NOTE_TARGET,
    idealWords: 35,
  },
  {
    id: 'linkedin_message',
    label: 'LinkedIn message',
    maxChars: LINKEDIN_DM_MAX,
    idealWords: 50,
  },
  {
    id: 'reply',
    label: 'Reply',
    maxWords: 120,
    idealWords: 60,
  },
  {
    id: 'follow_up',
    label: 'Follow-up',
    maxWords: 70,
    idealWords: 40,
  },
];

export function coachTypeInfo(type: CoachType): CoachTypeInfo {
  return COACH_TYPES.find((t) => t.id === type)!;
}

const FIRST_TOUCH_KINDS: ReadonlySet<MessageKind> = new Set([
  'outreach',
  'first_touch',
  'warm_first_touch',
  'referral_ask',
  'intro_request',
]);

/**
 * Which kind of outreach a sent message was: a first message by email is a cold email; on LinkedIn it is the note
 * on a connection request (sent through the connect flow, or short enough to be one) or a message; replies and
 * scheduling answers are replies; bumps are follow-ups. Thank-yous, check-ins and the rest are not reviewed here.
 */
export function coachTypeOf(o: {
  kind: MessageKind;
  channel: Channel;
  body: string;
  handoffVia?: string;
}): CoachType | undefined {
  if (o.kind === 'bump') return 'follow_up';
  if (o.kind === 'reply' || o.kind === 'schedule') return 'reply';
  if (!FIRST_TOUCH_KINDS.has(o.kind)) return undefined;
  if (o.channel !== 'linkedin') return 'cold_email';
  if (o.handoffVia === 'linkedin_connect') return 'linkedin_note';
  if (o.handoffVia === 'linkedin_compose') return 'linkedin_message';
  return o.body.trim().length <= LINKEDIN_NOTE_MAX ? 'linkedin_note' : 'linkedin_message';
}

// ---------- the sample message ----------

export interface CoachSampleInput {
  user: DraftContext['user'];
  styleCard: StyleCard;
  now: Date;
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();

/** The fixed recipient every sample is written to. */
export const COACH_SAMPLE_RECIPIENT = {
  name: 'Sarah Chen',
  title: 'Product Manager',
  org: 'Notion',
} as const;

/**
 * A realistic context for the sample of each kind: Sarah Chen, a product manager at Notion, who wrote a post the
 * student read. A LinkedIn message goes to her after she accepted; the reply answers her "happy to chat, what
 * times work?"; the follow-up comes a week after an unanswered first note.
 */
export function coachSampleContext(type: CoachType, input: CoachSampleInput): DraftContext {
  const { now } = input;
  const fact: PersonFact = {
    id: 'coach-sample-fact',
    userId: 'coach',
    personId: 'coach-sample',
    type: 'hook',
    text: 'She wrote a post about how Notion rebuilt onboarding for new teams.',
    sourceTable: 'sample',
    sourceId: 'coach',
    confidence: 1,
    occurredAt: iso(new Date(now.getTime() - 12 * DAY)),
    createdAt: iso(now),
  };
  const person: DraftContext['person'] = {
    firstName: 'Sarah',
    lastName: 'Chen',
    fullName: COACH_SAMPLE_RECIPIENT.name,
    title: COACH_SAMPLE_RECIPIENT.title,
    org: COACH_SAMPLE_RECIPIENT.org,
    relationshipType: 'cold',
    strength: 0.1,
  };
  const ctx: DraftContext = {
    user: input.user,
    styleCard: input.styleCard,
    person,
    facts: [fact],
    kind: 'outreach',
    channel: 'gmail',
    seed: 'coach-sample',
    now,
  };
  const sentAt = iso(new Date(now.getTime() - 7 * DAY));
  switch (type) {
    case 'cold_email':
      return ctx;
    case 'linkedin_note':
      return { ...ctx, channel: 'linkedin' };
    case 'linkedin_message':
      return {
        ...ctx,
        channel: 'linkedin',
        person: {
          ...person,
          linkedinConnected: true,
          linkedinConnectedAt: iso(new Date(now.getTime() - 2 * DAY)),
        },
      };
    case 'reply': {
      // two free windows, a few business days out, at 2pm and 11am in the student's day
      const d1 = new Date(now.getTime() + 5 * DAY);
      const d2 = new Date(now.getTime() + 7 * DAY);
      d1.setUTCHours(18, 0, 0, 0);
      d2.setUTCHours(15, 0, 0, 0);
      return {
        ...ctx,
        kind: 'reply',
        thread: {
          lastInboundBody: `Hi ${input.user.firstName}, happy to chat! What times work for you next week?`,
          lastInboundAt: iso(new Date(now.getTime() - DAY)),
          firstOutboundAt: sentAt,
          asksOfUser: ['What times work for you next week?'],
          lastSignal: 'reply_positive',
          inThread: true,
        },
        chat: { stage: 'replied' },
        proposedWindows: [
          { startIso: iso(d1), endIso: iso(new Date(d1.getTime() + 30 * 60_000)) },
          { startIso: iso(d2), endIso: iso(new Date(d2.getTime() + 30 * 60_000)) },
        ],
      };
    }
    case 'follow_up':
      return {
        ...ctx,
        kind: 'bump',
        bumpNumber: 1,
        thread: { firstOutboundAt: sentAt, inThread: true },
        chat: { stage: 'outreach_sent' },
      };
  }
}

export interface CoachSample {
  type: CoachType;
  subject?: string;
  body: string;
  /** words between greeting and sign-off */
  words: number;
  chars: number;
}

/** The sample message for a kind of outreach, in the student's current style, from the real draft engine. */
export function coachSample(type: CoachType, input: CoachSampleInput): CoachSample {
  const d = generateDraft(coachSampleContext(type, input));
  const body = type === 'linkedin_note' ? (d.bodyShort ?? d.body) : d.body;
  return {
    type,
    subject: type === 'cold_email' ? d.subject : undefined,
    body,
    words: wordsIn(body),
    chars: body.trim().length,
  };
}

// ---------- reading a message ----------

const GREETING_LINE = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^,.!?\n]{0,40}[,.!]?\s*/i;
const SIGNOFF_LINE =
  /^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks|kind regards|best regards|warm regards|respectfully|thanks again|thank you so much)[,!.]?$/i;

/** The message without its greeting and sign-off block: what the reader actually reads. */
export function messageContent(body: string): string {
  const lines = body.replace(/\r/g, '').split('\n');
  const end = lines.findIndex((l) => SIGNOFF_LINE.test(l.trim()));
  const kept = (end > 0 ? lines.slice(0, end) : lines).map((l) => l.trim());
  while (kept.length && !kept[0]) kept.shift();
  if (kept.length) {
    const g = kept[0]!.match(GREETING_LINE);
    if (g) kept[0] = kept[0]!.slice(g[0].length).trim();
  }
  // a one-line note ends on the student's name ("... 15 minutes? Thanks, Alex")
  return kept
    .filter(Boolean)
    .join('\n')
    .replace(/\s*(thanks|best|cheers),?\s+[A-Z][a-z]+\.?\s*$/i, '')
    .trim();
}

/** The sentences of a message, in order (line breaks end a sentence too). */
export function sentencesOf(text: string): string[] {
  return text
    .split('\n')
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=["'“(]?[A-Z0-9])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// ---------- style changes ----------

/** One change to the style card, from feedback or from a finding. */
export type StyleChange =
  | { kind: 'length'; words: number }
  | { kind: 'formality'; value: number; contractions?: boolean }
  | { kind: 'contractions'; on: boolean }
  | { kind: 'exclamations'; on: boolean }
  | { kind: 'emoji'; on: boolean }
  | { kind: 'greeting'; pattern: string }
  | { kind: 'signoff'; word: string }
  | { kind: 'avoid'; phrase: string }
  | { kind: 'note'; text: string };

export const toneWord = (f: number) =>
  f >= 0.75 ? 'formal' : f >= 0.5 ? 'polite' : f >= 0.3 ? 'friendly' : 'casual';

const SAMPLE_FIRST = 'Sarah';
const greetingLabel = (p: string | undefined) => (p ?? 'Hi {first},').replace('{first}', SAMPLE_FIRST);
const signWordOf = (s: string | undefined) => (s ?? '').split('\n')[0]!.replace(/,$/, '').trim();
const signNameOf = (s: string | undefined, firstName: string) =>
  (s ?? '').split('\n').slice(1).join('\n').trim() || firstName;
const clampWords = (n: number) => Math.max(25, Math.min(200, Math.round(n)));

export interface AppliedChange {
  patch: Partial<StyleCard>;
  /** the tuning log's line: "about 40 words, was 60" */
  summary: string;
}

/**
 * What a change does to the card, and how to say it. Undefined when the card already says so (nothing to log).
 * Lists (never say, notes) only ever gain the one item, so undoing it later removes just that item.
 */
export function applyStyleChange(
  card: StyleCard,
  change: StyleChange,
  firstName: string,
): AppliedChange | undefined {
  switch (change.kind) {
    case 'length': {
      const w = clampWords(change.words);
      if (w === card.avgMessageWords) return undefined;
      return { patch: { avgMessageWords: w }, summary: `about ${w} words, was ${card.avgMessageWords}` };
    }
    case 'formality': {
      const v = Math.max(0, Math.min(1, Math.round(change.value * 100) / 100));
      const patch: Partial<StyleCard> = {};
      if (Math.abs(v - card.formality) >= 0.01) patch.formality = v;
      if (change.contractions !== undefined && change.contractions !== card.contractions)
        patch.contractions = change.contractions;
      if (!Object.keys(patch).length) return undefined;
      const parts: string[] = [];
      if (patch.formality !== undefined) parts.push(`tone ${toneWord(v)}, was ${toneWord(card.formality)}`);
      if (patch.contractions !== undefined) parts.push(`contractions ${patch.contractions ? 'on' : 'off'}`);
      return { patch, summary: parts.join('; ') };
    }
    case 'contractions':
      if (card.contractions === change.on) return undefined;
      return {
        patch: { contractions: change.on },
        summary: change.on ? `contractions on ("I'm", "you're")` : `no contractions ("I am", "you are")`,
      };
    case 'exclamations': {
      const on = card.exclamationsPerMessage >= 0.5;
      if (on === change.on && (change.on || card.exclamationsPerMessage === 0)) return undefined;
      return {
        patch: { exclamationsPerMessage: change.on ? 0.6 : 0 },
        summary: change.on ? 'exclamation marks allowed' : 'no exclamation marks',
      };
    }
    case 'emoji':
      if (card.emoji === change.on) return undefined;
      return { patch: { emoji: change.on }, summary: change.on ? 'emoji allowed' : 'no emoji' };
    case 'greeting': {
      const p = change.pattern.trim();
      if (!p || card.greetingPatterns[0] === p) return undefined;
      return {
        patch: { greetingPatterns: [p, ...card.greetingPatterns.filter((g) => g !== p)] },
        summary: `greeting "${greetingLabel(p)}", was "${greetingLabel(card.greetingPatterns[0])}"`,
      };
    }
    case 'signoff': {
      const w = change.word.trim().replace(/,$/, '');
      const was = signWordOf(card.signoffs[0]);
      if (!w || w.toLowerCase() === was.toLowerCase()) return undefined;
      const name = signNameOf(card.signoffs[0], firstName);
      return {
        patch: { signoffs: [`${w},\n${name}`, ...card.signoffs.slice(1)] },
        summary: `sign-off "${w}", was "${was || 'Best'}"`,
      };
    }
    case 'avoid': {
      const phrase = change.phrase
        .trim()
        .replace(/^["'“]|["'”]$/g, '')
        .trim();
      if (phrase.length < 2 || card.avoid.some((a) => a.toLowerCase() === phrase.toLowerCase()))
        return undefined;
      return { patch: { avoid: [...card.avoid, phrase] }, summary: `never say "${phrase}"` };
    }
    case 'note': {
      const text = change.text.trim();
      const lines = (card.notes ?? '').split('\n').map((l) => l.trim());
      if (!text || lines.some((l) => l.toLowerCase() === text.toLowerCase())) return undefined;
      const notes = [card.notes?.trim(), text].filter(Boolean).join('\n');
      return { patch: { notes }, summary: `note for drafts: "${text}"` };
    }
  }
}

/**
 * Undo one change on the card as it is now: a "never say" phrase or a note line is taken back out (anything added
 * since stays); a setting goes back to what it was before the change.
 */
export function revertStyleChange(
  card: StyleCard,
  change: StyleChange,
  before: Partial<StyleCard>,
): Partial<StyleCard> {
  if (change.kind === 'avoid') {
    const p = change.phrase
      .trim()
      .replace(/^["'“]|["'”]$/g, '')
      .trim()
      .toLowerCase();
    return { avoid: card.avoid.filter((a) => a.toLowerCase() !== p) };
  }
  if (change.kind === 'note') {
    const t = change.text.trim().toLowerCase();
    return {
      notes: (card.notes ?? '')
        .split('\n')
        .filter((l) => l.trim().toLowerCase() !== t)
        .join('\n')
        .trim(),
    };
  }
  return before;
}

// ---------- the review ----------

/** A sent message, as the coach reads it. */
export interface CoachMessage {
  id: string;
  type: CoachType;
  subject?: string;
  body: string;
  /** they wrote back after it (or the chat moved to replied or later) */
  replied?: boolean;
  /** a follow-up went to them after it */
  followedUp?: boolean;
  /** days since it was sent */
  ageDays?: number;
  /** a follow-up: days since the message it follows up on */
  gapDays?: number;
}

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface CoachFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  /** one line on how it hurts the reply rate */
  why: string;
  /** the exact line from their message */
  quote?: string;
  /** how many of the reviewed messages have it */
  count: number;
  /** the style change that fixes it, when one does */
  fix?: { label: string; change: StyleChange };
}

export interface CoachReview {
  type: CoachType;
  /** sent messages reviewed, or the sample when there are none */
  basis: 'sent' | 'sample';
  sent: number;
  replied: number;
  /** replied / sent, undefined with nothing sent */
  replyRate?: number;
  findings: CoachFinding[];
  /** what they already do right */
  strengths: string[];
}

interface Hit {
  id: string;
  severity: FindingSeverity;
  title: string;
  why: string;
  quote?: string;
  fix?: { label: string; change: StyleChange };
}

const FIRST_TOUCH: ReadonlySet<CoachType> = new Set(['cold_email', 'linkedin_note', 'linkedin_message']);

/** Throwaway openers: phrase to quote and to add to "never say", and the pattern that finds it. */
const THROWAWAY: { re: RegExp; phrase: string }[] = [
  {
    re: /\bhope (this|my|the) (e-?mail|message|note) finds you( well)?\b/i,
    phrase: 'I hope this email finds you well',
  },
  {
    re: /\bhope (you('re| are)|you have been|you've been|all is|everything is|your week is) (doing |going )?(well|great|good)\b/i,
    phrase: 'Hope you are doing well',
  },
  {
    re: /\bhope you('re| are) having an? (great|good|wonderful|nice) (day|week)\b/i,
    phrase: 'Hope you are having a great week',
  },
  { re: /^my name is\b/i, phrase: 'My name is' },
  { re: /\bi('m| am) writing (to|because|in)\b/i, phrase: 'I am writing to' },
  { re: /\b(i('m| am) |i wanted to |just )?reaching out\b/i, phrase: 'reaching out' },
  { re: /\bi came across your (linkedin )?profile\b/i, phrase: 'I came across your profile' },
  { re: /\bsorry to (bother|bug|interrupt|reach)\b/i, phrase: 'Sorry to bother you' },
  { re: /\bi know you('re| are) (very |really |extremely |super )?busy\b/i, phrase: "I know you're busy" },
  { re: /\bto whom it may concern\b|\bdear sir or madam\b/i, phrase: 'To whom it may concern' },
];

/** Asks that make the reader do the work of deciding what you want. */
const VAGUE_ASK: { re: RegExp; phrase: string }[] = [
  { re: /\bpick your brain\b/i, phrase: 'pick your brain' },
  {
    re: /\bany (job |internship )?(opportunities|openings|open (roles|positions)|positions|roles)\b/i,
    phrase: 'any opportunities',
  },
  { re: /\b(chat|connect|talk|grab coffee) (some ?time|at some point)\b/i, phrase: 'chat sometime' },
  {
    re: /\blearn more about (you|your (journey|background|experience|story))\b/i,
    phrase: 'learn more about your journey',
  },
  { re: /\bany advice (you (have|could|might)|would be)\b/i, phrase: 'any advice you have' },
  { re: /\bget my foot in the door\b/i, phrase: 'get my foot in the door' },
  {
    re: /\blet me know if (there('s| is) anything|you('d| would) be open|you have any)\b/i,
    phrase: 'let me know if you would be open',
  },
];

/** Asks too big for someone who does not know you yet. */
const BIG_ASK =
  /\b(30|45|60)[- ]?(min|mins|minutes)\b|\ban hour\b|\brefer me\b|\b(a )?referral (for|to)\b|\b(review|look over|look at|go over) my (resume|résumé|cv)\b|\bhire me\b|\b(get|land) (me )?(a|an) (job|internship|interview)\b/i;

const ASK_SIGNAL =
  /\?|\b(would|could|can) you\b|\bare you (open|free|available)\b|\bdo you have\b|\bif you have\b|\b\d+ (min|mins|minutes)\b|\bwould love to\b|\bmind if\b/i;

const PERSONAL_SIGNALS: RegExp[] = [
  /\byour\b[^.?!\n]{0,60}\b(post|article|talk|podcast|panel|interview|piece|essay|paper|research|launch|project|newsletter|thread|tweet|video|book|comment|move|switch|transition|path|work on|team's|talk at|keynote|presentation)\b/i,
  /\b(saw|read|heard|noticed|watched|listened to|loved|enjoyed)\b(?![^.?!\n]{0,30}\bprofile\b)/i,
  /\b(fellow|alum|alumni|alumna|alumnus|also (went|studied|from|at)|same (school|club|team|major)|mutual|introduced|suggested (i|that i)|recommended (i|that i|you)|pointed me|referred me|told me)\b/i,
  /\bcongrat/i,
  /\b(we met|met you|spoke at|your talk|at the [A-Z])/i,
];

const LINK_OR_ATTACHMENT =
  /https?:\/\/\S+|\bwww\.\S+|\b(attached|attaching|attachment|enclosed)\b|\bmy (resume|résumé|cv|portfolio)\b|\bcalendly\b/i;

const GUILT_BUMP: { re: RegExp; phrase: string }[] = [
  {
    re: /\bhaven'?t heard back\b|\bhave not heard back\b|\bdidn'?t hear back\b/i,
    phrase: "haven't heard back",
  },
  { re: /\bdid you (get|see|have a chance to (read|see|look at)) my\b/i, phrase: 'did you see my' },
  { re: /\bnot sure if you saw\b|\bmake sure you saw\b/i, phrase: 'not sure if you saw' },
  { re: /\bper my last\b/i, phrase: 'per my last email' },
];

const GENERIC_SUBJECT =
  /^(hi|hello|hey|hi there|introduction|intro|networking|question|quick question|coffee( chat)?|informational interview|request|reaching out|following up|connecting|student (inquiry|question)|hello from [a-z ]+|inquiry)[!.?]*$/i;

const I_WORD = /\b(i|i'm|i've|i'd|i'll|me|my|mine|myself)\b/gi;
const YOU_WORD = /\b(you|your|you're|you've|you'd|yours|yourself)\b/gi;

const quoteOf = (s: string) => (s.length > 160 ? `${s.slice(0, 157).trimEnd()}…` : s);

/** What the coach sees in one message. */
export function reviewMessage(m: CoachMessage): Hit[] {
  const info = coachTypeInfo(m.type);
  const content = messageContent(m.body);
  const sents = sentencesOf(content);
  const first = sents[0] ?? '';
  const n = wordsIn(m.body);
  const chars = m.type === 'linkedin_note' ? m.body.trim().length : content.length;
  const hits: Hit[] = [];
  const firstTouch = FIRST_TOUCH.has(m.type);
  const sentenceWith = (re: RegExp) => sents.find((s) => re.test(s));

  // 1. too long for the channel
  if (info.maxWords && n > info.maxWords) {
    const lengthFix: StyleChange =
      m.type === 'cold_email'
        ? { kind: 'length', words: info.idealWords }
        : { kind: 'note', text: `Keep ${info.label.toLowerCase()}s under ${info.idealWords} words.` };
    hits.push({
      id: 'too_long',
      severity: n > info.maxWords * 1.5 ? 'high' : 'medium',
      title: `Too long for a ${info.label.toLowerCase()} (${n} words)`,
      why:
        m.type === 'follow_up'
          ? 'A follow-up is a nudge, not a second pitch. Two or three sentences get read; a wall gets archived.'
          : `Busy people skim. Past about ${info.maxWords} words the ask gets lost and the reply waits for "later".`,
      quote: quoteOf(sents.at(-1) ?? first),
      fix: {
        label: m.type === 'cold_email' ? `Aim for about ${info.idealWords} words` : 'Keep them short',
        change: lengthFix,
      },
    });
  }
  if (info.maxChars && chars > info.maxChars) {
    const note = m.type === 'linkedin_note';
    hits.push({
      id: 'too_long',
      severity: note && chars > LINKEDIN_NOTE_MAX ? 'high' : 'medium',
      title: `Too long for a ${info.label.toLowerCase()} (${chars} characters)`,
      why: note
        ? `LinkedIn cuts free accounts at ${LINKEDIN_NOTE_TARGET} characters, so the ask at the end never arrives.`
        : `LinkedIn messages are read on a phone. Under ${LINKEDIN_DM_MAX} characters fits on one screen and gets answered there.`,
      quote: quoteOf(sents.at(-1) ?? first),
      fix: {
        label: 'Keep them short',
        change: {
          kind: 'note',
          text: note
            ? `Keep LinkedIn connection notes under ${LINKEDIN_NOTE_TARGET} characters.`
            : `Keep LinkedIn messages under ${LINKEDIN_DM_MAX} characters.`,
        },
      },
    });
  }

  // 2. a throwaway opener (any sentence; the first one is where it costs most)
  for (const t of THROWAWAY) {
    const s = sentenceWith(t.re);
    if (!s) continue;
    hits.push({
      id: 'throwaway_opener',
      severity: s === first ? 'high' : 'medium',
      title: s === first ? 'Opens with a throwaway line' : 'A throwaway line',
      why: 'The first line is the preview. Filler there tells the reader this is a template and costs the open.',
      quote: quoteOf(s),
      fix: { label: `Never say "${t.phrase}"`, change: { kind: 'avoid', phrase: t.phrase } },
    });
    break;
  }

  // 3. no reason to write to this person
  if (firstTouch && content && !PERSONAL_SIGNALS.some((re) => re.test(content)))
    hits.push({
      id: 'no_specific_reason',
      severity: 'high',
      title: 'No reason for writing to this person',
      why: 'Nothing in it is only true of them, so it reads like a mass message. One specific line is the biggest lever on replies.',
      // the opening that should have said why them, past any filler
      quote: quoteOf(sents.find((s) => !THROWAWAY.some((t) => t.re.test(s))) ?? first),
      fix: {
        label: 'Always open with why them',
        change: {
          kind: 'note',
          text: 'Open with one line that is only true of this person (their post, their move, a shared school).',
        },
      },
    });

  // 4. the ask: vague, too big, missing, or several
  if (m.type !== 'reply') {
    const vague = VAGUE_ASK.find((v) => v.re.test(content));
    if (vague)
      hits.push({
        id: 'vague_ask',
        severity: 'high',
        title: 'The ask is vague',
        why: 'An open-ended ask makes them work out what you want. A small, specific one ("15 minutes next week?") is easy to say yes to.',
        quote: quoteOf(sentenceWith(vague.re) ?? first),
        fix: { label: `Never say "${vague.phrase}"`, change: { kind: 'avoid', phrase: vague.phrase } },
      });
    const big = firstTouch || m.type === 'follow_up' ? sentenceWith(BIG_ASK) : undefined;
    if (big)
      hits.push({
        id: 'big_ask',
        severity: 'high',
        title: 'The ask is too big for a first message',
        why: 'A stranger will give 15 minutes; a referral, a resume review or an hour is a favour you earn after the first chat.',
        quote: quoteOf(big),
        fix: {
          label: 'Keep first asks small',
          change: {
            kind: 'note',
            text: 'First messages ask for 15 minutes, never a referral or a resume review.',
          },
        },
      });
    if (!ASK_SIGNAL.test(content))
      hits.push({
        id: 'no_ask',
        severity: 'high',
        title: 'No clear ask',
        why: 'Without a question at the end there is nothing to reply to, so the kindest readers still do nothing.',
        quote: quoteOf(sents.at(-1) ?? first),
        fix: {
          label: 'End on one question',
          change: {
            kind: 'note',
            text: 'End with one clear, small question, like 15 minutes in the next two weeks.',
          },
        },
      });
    const questions = sents.filter((s) => s.endsWith('?'));
    if (questions.length >= 3 || (firstTouch && questions.length >= 2 && n < 60))
      hits.push({
        id: 'many_asks',
        severity: 'medium',
        title: `${questions.length} questions in one message`,
        why: 'Several asks split the reader’s attention; they answer none, or only the easiest. One ask per message.',
        quote: quoteOf(questions[1] ?? questions[0]!),
        fix: { label: 'One ask per message', change: { kind: 'note', text: 'One ask per message.' } },
      });
  }

  // 5. the subject line (cold email)
  if (m.type === 'cold_email') {
    const subj = (m.subject ?? '').trim();
    if (!subj)
      hits.push({
        id: 'subject',
        severity: 'medium',
        title: 'No subject line',
        why: 'An empty subject looks like spam and gives no reason to open it.',
      });
    else if (words(subj) > 10 || subj.length > 60)
      hits.push({
        id: 'subject',
        severity: 'medium',
        title: 'Subject line too long',
        why: 'Phones show about 40 characters. Name the link or the topic in a few words.',
        quote: quoteOf(subj),
        fix: {
          label: 'Short subjects',
          change: { kind: 'note', text: 'Subject lines under 60 characters that name the link or topic.' },
        },
      });
    else if (GENERIC_SUBJECT.test(subj) || BANNED_SUBJECT_PATTERNS.some((re) => re.test(subj)))
      hits.push({
        id: 'subject',
        severity: 'medium',
        title: 'Generic subject line',
        why: '"Networking request" or "Quick question" says nothing about them. A shared school or their post earns the open.',
        quote: quoteOf(subj),
        fix: {
          label: 'Specific subjects',
          change: {
            kind: 'note',
            text: 'Subject lines name the link or the topic (their post, a shared school).',
          },
        },
      });
  }

  // 6. all about me
  const iCount = (content.match(I_WORD) ?? []).length;
  const youCount = (content.match(YOU_WORD) ?? []).length;
  const iStarts = sents.filter((s) => /^(i|i'm|i've|i'd|my)\b/i.test(s)).length;
  if (
    (iCount >= 6 && iCount >= 3 * Math.max(1, youCount)) ||
    (sents.length >= 4 && iStarts / sents.length >= 0.6)
  ) {
    const worst = [...sents].sort(
      (a, b) => (b.match(I_WORD) ?? []).length - (a.match(I_WORD) ?? []).length,
    )[0];
    hits.push({
      id: 'about_me',
      severity: 'medium',
      title: `About you, not them (${iCount} "I/me/my", ${youCount} "you")`,
      why: 'People answer messages about themselves. Turn "I am interested in" into a question about their work.',
      quote: worst ? quoteOf(worst) : undefined,
      fix: {
        label: 'More "you", less "I"',
        change: {
          kind: 'note',
          text: 'Write about them more than about me: fewer sentences starting with "I".',
        },
      },
    });
  }

  // 7. links or attachments in a first note
  if (firstTouch) {
    const s = sentenceWith(LINK_OR_ATTACHMENT);
    if (s)
      hits.push({
        id: 'link_in_first',
        severity: 'medium',
        title: 'A link or attachment in a first message',
        why: 'Links and attachments trip spam filters and read as homework. Offer your resume if they ask.',
        quote: quoteOf(s),
        fix: {
          label: 'No links in first messages',
          change: { kind: 'note', text: 'No links or resume in a first message; offer it if they ask.' },
        },
      });
  }

  // 8. exclamation marks
  const bangs = (content.match(/!/g) ?? []).length;
  if (bangs > 2)
    hits.push({
      id: 'exclamations',
      severity: 'low',
      title: `${bangs} exclamation marks`,
      why: 'More than one reads as eager rather than confident, especially to someone senior.',
      quote: quoteOf(sentenceWith(/!/) ?? first),
      fix: { label: 'No exclamation marks', change: { kind: 'exclamations', on: false } },
    });

  // 9. follow-ups: guilt, and timing
  if (m.type === 'follow_up') {
    const g = GUILT_BUMP.find((x) => x.re.test(content));
    if (g)
      hits.push({
        id: 'guilt_bump',
        severity: 'medium',
        title: 'The follow-up sounds like a reminder of a debt',
        why: 'They owe you nothing. "In case it got buried" keeps it easy; "haven\'t heard back" makes replying awkward.',
        quote: quoteOf(sentenceWith(g.re) ?? first),
        fix: { label: `Never say "${g.phrase}"`, change: { kind: 'avoid', phrase: g.phrase } },
      });
    if (m.gapDays !== undefined && m.gapDays < 4)
      hits.push({
        id: 'too_soon',
        severity: 'high',
        title: `Followed up after ${Math.max(0, Math.round(m.gapDays))} day${Math.round(m.gapDays) === 1 ? '' : 's'}`,
        why: 'A bump within a few days reads as pushy. Give it about a week (five business days).',
      });
  }

  // 10. a reply that does not move things forward
  if (m.type === 'reply') {
    const next =
      /\?|\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\btomorrow\b|\bnext week\b|\bcalendly\b|cal\.com|https?:\/\/|\bworks? (for|great)\b|\bsee you\b|\blooking forward\b|\bwill (send|do|follow)\b/i;
    if (content && !next.test(content))
      hits.push({
        id: 'no_next_step',
        severity: 'low',
        title: 'The reply has no next step',
        why: 'When someone says yes, answer with two concrete times or a link so it is booked in one more message.',
        quote: quoteOf(sents.at(-1) ?? first),
        fix: {
          label: 'Always offer times',
          change: { kind: 'note', text: 'When they say yes, reply with two specific times.' },
        },
      });
  }
  return hits;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * The coach's review of one kind of outreach: how many went out and got an answer, and what to change, with the
 * exact line it comes from. With nothing sent of that kind, the sample is reviewed instead (basis "sample").
 */
export function reviewOutreach(
  type: CoachType,
  sent: CoachMessage[],
  sample?: Pick<CoachSample, 'subject' | 'body'>,
): CoachReview {
  const mine = sent.filter((m) => m.type === type);
  const basis: CoachReview['basis'] = mine.length ? 'sent' : 'sample';
  const reviewed: CoachMessage[] = mine.length
    ? mine
    : sample
      ? [{ id: 'sample', type, subject: sample.subject, body: sample.body }]
      : [];
  const byId = new Map<string, { hit: Hit; count: number; severity: FindingSeverity }>();
  for (const m of reviewed)
    for (const h of reviewMessage(m)) {
      const key = h.id;
      const had = byId.get(key);
      if (!had) byId.set(key, { hit: h, count: 1, severity: h.severity });
      else {
        had.count++;
        if (SEVERITY_ORDER[h.severity] < SEVERITY_ORDER[had.severity]) {
          had.severity = h.severity;
          had.hit = h;
        }
      }
    }
  const findings: CoachFinding[] = [...byId.values()].map(({ hit, count, severity }) => ({
    ...hit,
    severity,
    count,
  }));
  // first messages nobody followed up on
  if (basis === 'sent' && FIRST_TOUCH.has(type)) {
    const unanswered = mine.filter((m) => !m.replied && (m.ageDays ?? 0) >= 7);
    const dropped = unanswered.filter((m) => !m.followedUp);
    if (dropped.length && dropped.length >= Math.ceil(unanswered.length / 2))
      findings.push({
        id: 'no_follow_up',
        severity: 'high',
        title: `No follow-up on ${dropped.length} of ${unanswered.length} unanswered`,
        why: 'Busy people miss first messages. One polite bump about a week later often gets the reply the first one did not.',
        count: dropped.length,
      });
  }
  // a rule broken in only a few of many messages matters less
  const total = reviewed.length;
  for (const f of findings)
    if (total >= 4 && f.count / total < 0.25 && f.severity === 'high' && f.id !== 'no_follow_up')
      f.severity = 'medium';
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);

  const has = (id: string) => findings.some((f) => f.id === id);
  const strengths: string[] = [];
  if (reviewed.length) {
    if (!has('too_long')) strengths.push('Short enough for the channel');
    if (FIRST_TOUCH.has(type) && !has('no_specific_reason'))
      strengths.push('Gives a reason to write to them');
    if (type !== 'reply' && !has('vague_ask') && !has('no_ask') && !has('big_ask'))
      strengths.push('One small, clear ask');
    if (!has('throwaway_opener')) strengths.push('No filler opener');
  }
  const replied = mine.filter((m) => m.replied).length;
  return {
    type,
    basis,
    sent: mine.length,
    replied,
    replyRate: mine.length ? replied / mine.length : undefined,
    findings,
    strengths,
  };
}
