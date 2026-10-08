import { extractTimes } from '../email/when';
import { wordCount } from '../text/email';
import { normalizeCompany } from '../text/normalize';
import type { Channel, DraftClaim, DraftNeed, MessageKind, PersonFact, Sector, StyleCard } from '../types';
import {
  article,
  cap1,
  clause,
  cyclePhrase,
  expandContractions,
  type FactClause,
  firstPart,
  functionFor,
  functionLabel,
  hookProposition,
  hookTense,
  isInternCycle,
  lower1,
  lowerPhrase,
  matchedFunction,
  offerPhrase,
  orgGroup,
  pointPhrase,
  possessive,
  reported,
  roleNoun,
  schoolShort,
  shortOrg,
  softLower,
  strip,
  theirWords,
  titleFunction,
} from './phrasing';
import { type Question, questionsFor } from './register';
import {
  classYear,
  cycleTiming,
  firmKindOf,
  isRecruiter,
  isSeniorTitle,
  sectorOf,
  seniorityOf,
  yearLabel,
} from './sector';
import { answeredAfterOutreach, askedForUpdate, inboundNeedsAnswer, subjectTopic } from './thread';
import {
  calendarDaysBetween,
  fmtWindow,
  fmtWindows,
  overlapsBusy,
  sinceLabel,
  tzAbbr,
  whenLabel,
} from './time';

// functionLabel and matchedFunction also exist in labels.ts and recommend/score.ts (UI labels and recommendation
// reasons); the drafting versions are exported under their own names so the package index stays unambiguous
export {
  article,
  cap1,
  clause,
  cyclePhrase,
  expandContractions,
  type FactClause,
  FUNCTION_LABEL,
  firstPart,
  functionFor,
  functionLabel as draftFunctionLabel,
  hookProposition,
  hookTense,
  isInternCycle,
  lower1,
  lowerPhrase,
  matchedFunction as draftMatchedFunction,
  offerPhrase,
  pointPhrase,
  roleNoun,
  schoolShort,
  softLower,
  strip,
  titleFunction,
} from './phrasing';
export * from './time';

/**
 * Drafting engine. Follows docs/plan/15-outreach-playbook.md: connection first, one line only true of the
 * recipient, one bounded ask with a number, an out, sector register, tight limits, variety by seed, and a hard
 * rule that a message never states something that is not in the data: when the engine is missing the one thing
 * it needs (a connection, an update, the news, the target, an answer), it asks the student for it (`needsInput`).
 */

export type ConnectionKind =
  | 'met'
  | 'prior_thread'
  | 'referral'
  | 'event'
  | 'alumni'
  | 'warmup'
  | 'transition'
  | 'shared_employer'
  | 'post'
  | 'hook'
  | 'user_supplied';

export interface Connection {
  kind: ConnectionKind;
  /** the fact as a short clause, e.g. "you went from equity research to Stripe's payments team" */
  text: string;
  factId?: string;
  referrerName?: string;
  /** the referrer introduced the two of them by email, so the person already knows who the student is */
  introduced?: boolean;
  eventName?: string;
  sharedOrg?: string;
  previous?: string; // previous org or title for transitions
  /** prior_thread: when the last email in the earlier exchange was, and whether it was theirs */
  lastAt?: string;
  lastInbound?: boolean;
}

export interface BusyBlock {
  startIso: string;
  endIso?: string;
  status?: string;
  /** the recipient is on this event (a meeting with them, not a conflict with them) */
  withPerson?: boolean;
}

export interface DraftContext {
  user: {
    firstName: string;
    lastName?: string;
    fullName: string;
    school: string;
    gradYear?: number;
    degree?: string;
    majors: string[];
    cycleLabel: string;
    targetFunctions: string[];
    oneLiner?: string; // explicit override of the "a junior at Cornell studying CS" clause
    credibility?: string; // one concrete artifact: "built a campus marketplace used by 800 students"
    schedulingLink?: string;
    timezone: string;
    pastOrgs?: string[]; // from the resume: employers/orgs the student has been at
  };
  styleCard: StyleCard;
  person: {
    firstName: string;
    lastName?: string;
    fullName: string;
    title?: string;
    org?: string;
    orgIndustry?: string;
    group?: string; // team/group/office if known
    isAlumni?: boolean;
    relationshipType: string;
    strength: number;
    linkedinConnected?: boolean;
    /** when they accepted the connection (a "thanks for connecting" only makes sense for a recent one) */
    linkedinConnectedAt?: string;
    previousOrg?: string;
    previousTitle?: string;
  };
  facts: PersonFact[];
  kind: MessageKind;
  channel: Channel;
  connection?: Connection;
  bumpNumber?: number; // 1 or 2
  /** free windows to offer (already checked against the calendar) */
  proposedWindows?: { startIso: string; endIso?: string; raw?: string }[];
  /** a time the person proposed that can no longer be accepted (it has passed, or the student is busy then) */
  missedProposal?: { raw: string; startIso?: string; reason: 'passed' | 'busy' };
  /** the student's calendar, to check a time the other person proposed */
  busy?: BusyBlock[];
  thread?: {
    lastInboundBody?: string;
    lastInboundAt?: string;
    firstOutboundAt?: string;
    asksOfUser?: string[];
    proposedTimes?: { startIso: string; raw: string }[];
    lastSignal?: string;
    /** the reply goes into an existing email thread (no new subject) */
    inThread?: boolean;
    subject?: string;
  };
  target?: {
    name: string;
    firstName?: string;
    title?: string;
    org?: string;
    why?: string;
    /** the recipient offered this intro earlier; the message follows up on the offer instead of asking cold */
    offered?: boolean;
  };
  chat?: {
    completedAt?: string;
    /** when the conversation actually happened (the calendar event), preferred over completedAt */
    meetingAt?: string;
    stage?: string;
    referrerName?: string;
    /** set when the referrer introduced the student to this person by email */
    introducedAt?: string;
    warmUpNote?: string;
    warmUpDone?: number;
    /** the student left a comment on one of their posts during the warm-up but did not say what it was about */
    commentedOnPost?: boolean;
    /** a meeting with them already on the calendar, still ahead */
    upcomingAt?: string;
    /** their out-of-office reply said they are away until this date (YYYY-MM-DD) */
    awayUntil?: string;
  };
  /**
   * An earlier email exchange with this person, for outreach to someone the student already knows: when the last
   * message was, whether it was theirs, and whether they have ever replied. The outreach then picks that thread
   * back up instead of introducing the student as a stranger.
   */
  history?: {
    lastAt: string;
    lastInbound: boolean;
    repliedEver: boolean;
    /** the app's id for the thread the outreach replies in, when it picks that thread back up */
    threadId?: string;
  };
  /** open promises the student made to this person ("I will send my resume by Friday"), kept in the thank-you */
  promises?: string[];
  /** the one thing the student took away from the conversation, when no note facts exist (thank-you) */
  takeaway?: string;
  /** a second try after a time-limited decline: what they said and when (nurture) */
  reengage?: { said: string; past: string; at: string };
  update?: string; // the student's own update, for nurture
  news?: string; // what the student is congratulating them on, when no affiliation change is on record
  answer?: string; // the student's answer to a question in the thread
  /**
   * A referral ask to someone the student has not talked with is written as the conversation ask instead; the
   * application is one clause in it ("I've applied for Google's software engineering internship.").
   */
  applicationLine?: string;
  /** the name of the mutual tie a connection line mentions without one ("my roommate"), from the student */
  mutualName?: string;
  /**
   * A job change on record. `previousOrg` is the employer of the role it replaced (a title change at the same company
   * is a new role, not a move); `observed` means `since` is when Orbit noticed it (a LinkedIn re-import), not when it
   * started, so the note does not assume it is recent.
   */
  newAffiliation?: { title?: string; org?: string; since?: string; previousOrg?: string; observed?: boolean };
  targetCompany?: {
    name: string;
    roleLabel?: string;
    reqId?: string;
    link?: string;
    applied?: boolean;
    office?: string;
  };
  reportBack?: {
    targetName: string;
    outcome: 'spoke' | 'no_reply' | 'declined';
    when?: string;
    line?: string;
  };
  /** first names of people at the same org the student has already spoken with */
  sameOrgContacts?: string[];
  recentOpenings?: string[]; // first sentences of drafts sent to the same org in the last 30 days (avoid)
  seed?: string; // deterministic variety; default personId
  now?: Date;
  /**
   * Writing again after the thread went quiet on a sign-off ("Good luck this fall", "Keep me posted"): a check-in
   * that names the earlier conversation and gives a reason to write now, never "Thank you for the reply".
   */
  reopen?: boolean;
}

export interface DraftOutput {
  subject?: string;
  body: string;
  bodyShort?: string; // LinkedIn connection note (<= 300 chars)
  claims: DraftClaim[];
  needsInput: DraftNeed[];
  opening: string;
  sector: Sector;
  register: 'formal' | 'warm';
  /**
   * The kind actually written, when the thread said another one fits: a bump to someone who answered becomes the
   * scheduling reply, a "reply" to a months-old sign-off becomes a check-in.
   */
  kind: MessageKind;
  /**
   * Outreach to someone the student was introduced to goes as a reply-all on the introduction, with the introducer
   * moved to bcc (the body thanks them for it): the referrer's name, for the sender to put in bcc.
   */
  introReply?: { bcc: string };
}

/** Playbook body limits (words, excluding greeting and sign-off). */
export const MAX_WORDS: Record<MessageKind, number> = {
  outreach: 100,
  bump: 50,
  schedule: 60,
  thank_you: 90,
  nurture: 80,
  congratulate: 50,
  referral_ask: 100,
  intro_request: 110,
  reply: 110,
  report_back: 60,
};
export const MIN_WORDS: Record<MessageKind, number> = {
  outreach: 45,
  bump: 15,
  schedule: 20,
  thank_you: 40,
  nurture: 25,
  congratulate: 15,
  referral_ask: 45,
  intro_request: 55,
  reply: 10,
  report_back: 20,
};
/** LinkedIn's hard cap on a connection note (Premium). */
export const LINKEDIN_NOTE_MAX = 300;
/** Free accounts are cut at 200 characters, so the note aims for that and only goes longer when it must. */
export const LINKEDIN_NOTE_TARGET = 200;

export const BANNED_PHRASES = [
  'i hope this email finds you well',
  'i hope this message finds you well',
  'hope you are doing well',
  "hope you're doing well",
  'i am writing to introduce myself',
  'i came across your profile and was impressed',
  'impressed by your background',
  'i would be honored',
  'esteemed',
  'passionate about',
  'cut my teeth',
  'lifelong passion',
  'lean deal teams',
  'unique culture',
  'prestigious',
  'top-tier',
  'pick your brain',
  'reach out',
  'reaching out',
  'touch base',
  'circle back',
  'leverage',
  'synergy',
  'at your earliest convenience',
  'i look forward to hearing from you',
  'quick learner',
  'add value',
  'as an ai',
  'ignore previous',
  'grab coffee sometime',
  'any advice you have',
  'i would love to learn more about your journey',
  'thought leader',
  "in today's fast-paced",
];
export const BANNED_SUBJECT_PATTERNS = [
  /informational interview request/i,
  /networking request/i,
  /aspiring .* seeking/i,
  /coffee chat request/i,
  /^hello$/i,
  /^following up$/i,
  /^quick question$/i,
  /resume attached/i,
  /\bjob\b/i,
  /\bopportunit/i,
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}
function pick<T>(arr: T[], seed: string, salt: string, avoid: (x: T) => boolean = () => false): T {
  const h = hash(seed + salt);
  for (let i = 0; i < arr.length; i++) {
    const x = arr[(h + i) % arr.length]!;
    if (!avoid(x)) return x;
  }
  return arr[h % arr.length]!;
}

/** Label for the student's target function as the recipient would read it ("software engineering"). */
export function targetLabel(ctx: Pick<DraftContext, 'user'> & { person?: { title?: string } }): string {
  return functionLabel(functionFor(ctx.person?.title, ctx.user.targetFunctions)) ?? 'early-career';
}

function firstNameOf(p: DraftContext['person']): string {
  return p.firstName || p.fullName.split(' ')[0] || 'there';
}

/** A student who chose the formal preset, or whose sent mail shows no contractions. */
function isFormalStyle(card: StyleCard): boolean {
  return card.formality >= 0.7 || card.contractions === false;
}

/**
 * Whether the person already knows the student: they have talked, they are a friend, or they have written to the
 * student before. Someone who wrote "Hi Alex, happy to chat" is not answered with "Dear".
 */
function knowsStudent(ctx: DraftContext): boolean {
  return (
    !!(ctx.chat?.meetingAt ?? ctx.chat?.completedAt) ||
    isFriend(ctx.person) ||
    !!ctx.history?.repliedEver ||
    !!ctx.thread?.lastInboundBody ||
    !!ctx.chat?.introducedAt
  );
}

/**
 * "Dear {first}" only for a letter to someone senior who does not know the student yet (a VP or partner in finance
 * or consulting, anyone senior when the student chose the formal style) and for a recruiter's first note. The style
 * preset never overrides the relationship: a friend, a peer or someone who has written back gets "Hi".
 */
function greeting(ctx: DraftContext, sector: Sector, recruiterFirst: boolean): string {
  const first = firstNameOf(ctx.person);
  const learned = ctx.styleCard.builtFromCount > 0 && ctx.styleCard.greetingPatterns[0];
  if (learned && !/^dear/i.test(learned)) return learned.replace('{first}', first);
  // a LinkedIn message is a chat, not a letter
  if (knowsStudent(ctx) || ctx.channel === 'linkedin') return `Hi ${first},`;
  // never "Dear Elena Rossi," (a mail merge); without a known gender "Mr./Ms." is not an option either
  if (recruiterFirst) return `Dear ${first},`;
  const senior = isSeniorTitle(ctx.person.title);
  if (senior && (sector === 'finance' || sector === 'consulting' || isFormalStyle(ctx.styleCard)))
    return `Dear ${first},`;
  return `Hi ${first},`;
}
function signoff(ctx: DraftContext, sector: Sector, G: string, recruiter: boolean): string {
  const learned = ctx.styleCard.builtFromCount > 0 && ctx.styleCard.signoffs[0];
  if (learned) return learned;
  if (ctx.channel === 'linkedin') return `Thanks,\n${ctx.user.firstName}`; // a chat message, not a letter
  if (isFriend(ctx.person)) return `Thanks,\n${ctx.user.firstName}`;
  const dear = /^Dear\b/.test(G);
  // the full name with school and class year is for someone who does not know the student yet; a thank-you or a
  // check-in to someone they have talked to signs with the first name, like any other note between them
  const firstContact =
    !knowsStudent(ctx) && (ctx.kind === 'outreach' || ctx.kind === 'bump' || ctx.kind === 'referral_ask');
  if (firstContact && (dear || recruiter || sector === 'finance' || sector === 'consulting')) {
    const cy = classYear(ctx.user.gradYear);
    const school = schoolShort(ctx.user.school);
    return `${dear ? 'Best regards' : 'Best'},\n${ctx.user.fullName}${school ? `\n${school}${cy ? ` ${cy}` : ''}` : ''}`;
  }
  if (dear) return `Best regards,\n${ctx.user.firstName}`;
  if (sector === 'finance' || sector === 'consulting' || isFormalStyle(ctx.styleCard))
    return `Best,\n${ctx.user.firstName}`;
  return `Thanks,\n${ctx.user.firstName}`;
}

/**
 * Someone who knows the student personally (a friend, a classmate, a close contact): no reintroduction, no apology
 * for the gap, no "as a quick reminder".
 */
function isFriend(p: DraftContext['person']): boolean {
  if (/^(friend|family|classmate|roommate|teammate)$/i.test(p.relationshipType)) return true;
  // a close tie Orbit inferred counts only when nothing says they are an alum, a recruiter or a cold contact
  return p.strength >= 0.8 && /^(unknown|other|)$/i.test(p.relationshipType ?? '');
}

/** What the student is recruiting for, named the way the recipient would say it. */
function lookingForPhrase(ctx: DraftContext): string {
  const sector = sectorOf({ title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry });
  const firm = firmKindOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    sector,
  );
  const target = ctx.user.targetFunctions[0];
  // their own function when it is the student's target, otherwise the student's target when that firm hires for it
  const matched = functionLabel(
    matchedFunction(ctx.person.title, ctx.user.targetFunctions) ??
      (target && firm !== 'other' && functionFits(target, ctx.person.title, firm) ? target : undefined),
  );
  const intern = isInternCycle(ctx.user.cycleLabel);
  return matched
    ? `${matched} ${intern ? 'internships' : 'roles'}`
    : intern
      ? 'internships'
      : 'full-time roles';
}

/** The student in one clause, from structured fields only: "a junior at Cornell studying computer science". */
function situation(ctx: DraftContext, now: Date): string {
  if (ctx.user.oneLiner) return ctx.user.oneLiner;
  const year = yearLabel(ctx.user.gradYear, ctx.user.degree, now);
  const school = schoolShort(ctx.user.school);
  const major = ctx.user.majors[0] ? ` studying ${lowerPhrase(ctx.user.majors[0])}` : '';
  return `${article(year)} ${year}${school ? ` at ${school}` : ''}${major}`;
}

/** The firm's kind for this person (see register.ts). */
function firmOf(ctx: DraftContext, sector: Sector) {
  return firmKindOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    sector,
  );
}

/** Verbs a role note opens with ("works on ...", "covers ..."), as the "-ing" form a question can carry. */
const WORK_GERUND: Record<string, string> = {
  work: 'working',
  cover: 'covering',
  trade: 'trading',
  focus: 'focusing',
  invest: 'investing',
  advise: 'advising',
  build: 'building',
  support: 'supporting',
};

/**
 * What they work on, as the question for a peer ("what covering enterprise software companies in the TMT group is
 * like day to day"), so the one fact only true of them is what the student asks about instead of a stacked "I also
 * saw that you ..." line. Undefined when no role note fits.
 */
function workQuestion(ctx: DraftContext, firm: string): Question | undefined {
  const facts = ctx.facts.filter(
    (f) => !f.deletedAt && f.type === 'role_detail' && (f.confidence ?? 1) >= 0.6,
  );
  for (const f of facts) {
    const c = clause(f.text, ctx.person);
    const g = c?.you ? WORK_GERUND[(c.verb ?? '').toLowerCase()] : undefined;
    const rest = c?.rest ? firstPart(c.rest) : '';
    if (!g || !rest || rest.split(' ').length > 9 || isConfidential(rest, firm)) continue;
    const what = theirWords(`${g} ${rest}`);
    return {
      q: `what ${what} is like day to day`,
      short: `what ${what} is like`,
      factId: f.id,
      factText: f.text,
    };
  }
  return undefined;
}

/**
 * One question a post or talk the student named raises, never its title read back as the ask ("I read your post on
 * how your team runs design reviews ... tell me more about how your team runs design reviews"). Shaped by what the
 * piece is about and the kind of firm.
 */
function postFollowUp(topic: string, firm: string): string {
  const t = topic.toLowerCase();
  const junior =
    firm === 'bank' || firm === 'pe'
      ? 'a summer analyst'
      : firm === 'consulting'
        ? 'a first-year consultant'
        : firm === 'trading'
          ? 'a new trader'
          : firm === 'vc'
            ? 'an investment intern'
            : 'an intern';
  if (/\bhir(e|es|ed|ing)\b|\bfirst (ten|\d+) \w+/.test(t))
    return firm === 'startup' || /\bfirst\b/.test(t)
      ? 'how that approach has held up as the team has grown'
      : 'what you look for now when you hire';
  if (/\breviews?\b|\bprocess\b|\bruns?\b/.test(t)) return `how much of that ${junior} actually sees`;
  if (
    /\b(learn|structure|prepare|train|ramp|first month|onboard|new (consultants|traders|engineers|analysts|hires))/.test(
      t,
    )
  )
    return 'what separates the people who pick it up fastest';
  if (/\b(evaluat|invest|thesis|memo|diligence|underwrit)/.test(t))
    return 'how a student could start building that kind of judgment';
  if (/\b(scal|migrat|pipeline|infrastructure|architecture|reliab|indexing|latency)/.test(t))
    return `what part of that work ${junior} could realistically own`;
  return 'how someone just starting out could put it into practice';
}

/** What the student would like to hear from them, chosen by firm kind and seniority (see register.ts). */
function questionFor(ctx: DraftContext, sector: Sector, seed: string, now: Date): Question {
  const c = ctx.connection;
  const firm = firmOf(ctx, sector);
  const org = shortOrg(ctx.person.org);
  // a post or talk the student named: the question it raises
  const topic = c ? connectionTopic(c.text) : undefined;
  if (topic) return { q: postFollowUp(topic, firm), short: 'it', about: topic, reacted: true };
  if (c?.kind === 'transition' && c.previous) {
    // a designer or an ops lead asked by an engineering student: how the two sides work together is the reason
    const theirs = titleFunction(ctx.person.title);
    const mine = ctx.user.targetFunctions.find((f) => ['swe', 'pm', 'data'].includes(f));
    if (theirs && mine && ['design', 'ops', 'marketing', 'research'].includes(theirs) && theirs !== mine) {
      const q = `how ${functionLabel(theirs)} and ${functionLabel(mine)} work together${org ? ` at ${org}` : ''}`;
      return { q, short: q };
    }
    return pick(
      [
        { q: 'how you made that move', short: 'how you made that move' },
        { q: 'what made you decide to switch', short: 'what made you switch' },
      ],
      seed,
      'q-trans',
    );
  }
  const late = cycleTiming(firm, ctx.user.cycleLabel, now) === 'late';
  const bank = questionsFor(
    {
      title: ctx.person.title,
      org: ctx.person.org,
      group: ctx.person.group,
      industry: ctx.person.orgIndustry,
    },
    sector,
    { late },
  );
  const work = isSeniorTitle(ctx.person.title) ? undefined : workQuestion(ctx, firm);
  // what they work on, when it is on record, is the question only they can answer
  return work ?? pick(bank, seed, 'q');
}

/**
 * What the student's own connection line says they read or heard ("I read your post about how your team runs deal
 * reviews" is about "how your team runs deal reviews"), so the question can follow up on it instead of leaving it
 * hanging.
 */
function connectionTopic(text: string): string | undefined {
  const m = strip(text).match(
    /\b(?:post|article|talk|panel|podcast|piece|interview|episode|essay|newsletter|thread|video|presentation)\b[^,.;]*?\b(?:about|on)\s+(.{6,90})$/i,
  );
  if (!m) return undefined;
  const t = m[1]!.replace(/^the\s+(?=\w+ (?:podcast|panel)\b)/i, '').trim();
  // "your talk on the Cornell Data Science podcast" names where, not what
  if (/\b(podcast|panel|conference|show|channel|summit|event)\b/i.test(t) && !/\b(how|why|what)\b/i.test(t))
    return undefined;
  return t;
}

/**
 * The ask: one question with a number in it, then at most one soft line. The frame varies by seed so a firm that
 * hears from several students at one school does not get the same sentence twice. A senior person in tech gets one
 * question they can answer from their phone; a friend gets a friend's ask.
 */
function askBlock(
  minutes: number,
  qq: Question,
  seed: string,
  formal: boolean,
  signoffThanks: boolean,
  opts: { oneQuestion?: boolean; friend?: boolean } = {},
): string {
  if (opts.oneQuestion && qq.direct)
    return `One question, if you have a minute: ${lower1(qq.direct)} A line or two by email would be plenty, or ${minutes} minutes on a call if that's easier.`;
  const talk = qq.reacted ? 'talk about it' : `tell me ${qq.q}`;
  if (formal)
    return `Would you have ${minutes} minutes in the coming weeks to ${talk}? I would be glad to work around your schedule.`;
  if (opts.friend)
    return pick(
      [
        `Would you have ${minutes} minutes sometime soon to ${talk}? No rush at all.`,
        `Any chance you'd have ${minutes} minutes in the next couple of weeks to ${talk}? No rush.`,
      ],
      seed,
      'ask-friend',
    );
  const frame = pick(
    qq.reacted
      ? [
          `Would you have ${minutes} minutes sometime in the next couple of weeks to talk about it?`,
          `If you have ${minutes} minutes in the next couple of weeks, could I ask you about it?`,
        ]
      : [
          `Would you have ${minutes} minutes sometime in the next couple of weeks to tell me ${qq.q}?`,
          `I'd love to hear ${qq.q}. Would you have ${minutes} minutes in the next couple of weeks?`,
          // only a short question fits inside this frame
          ...(qq.q.split(' ').length <= 8
            ? [`Could I ask you ${qq.q} on a ${minutes}-minute call sometime in the next two weeks?`]
            : []),
        ],
    seed,
    'ask',
  );
  const soft = pick(
    [
      'Happy to work around your calendar.',
      'Completely understand if the next few weeks are busy.',
      ...(signoffThanks ? [] : ['Thanks either way.']),
    ],
    seed,
    'soft',
  );
  return `${frame} ${soft}`;
}

/** "what your first months at Jane Street were like" after an opener that already named Jane Street: "... there". */
function thereFor(qq: Question, org: string): Question {
  const re = new RegExp(`\\s(?:at|on|in) ${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\b|[^\\w]|$)`);
  return {
    ...qq,
    q: qq.q.replace(re, ' there'),
    short: qq.short.replace(re, ' there'),
    direct: qq.direct?.replace(re, ' there'),
  };
}

/** A warm-up note is a claim from their post ("junior engineers should own a metric") or a topic ("migrating off a monolith"). */
function postPhrase(note: string): string {
  const t = lower1(strip(note)).replace(/^(that|the point that|about)\s+/i, '');
  if (/\b(should|is|are|was|were|can|will|must|need|needs|makes|matters|beats|helps)\b/.test(t))
    return `making the point that ${t}`;
  return `about ${t}`;
}

/** First-person form of a line the student typed ("Read your post on X" -> "I read your post on X"). */
function studentSentence(text: string): string {
  const t = strip(text);
  if (/^(read|saw|met|found|heard|noticed|attended|watched|listened|came across|followed)\b/i.test(t))
    return `I ${lower1(t)}`;
  return cap1(t);
}

/** "my roommate" with nobody named: the recipient cannot place it without the name. */
const UNNAMED_MUTUAL =
  /\bmy (roommate|friend|classmate|sister|brother|cousin|teammate|coworker|co-worker|professor|advisor|mentor|manager|suitemate|labmate)\b(?!,?\s+(?:[A-Z][a-z]+|\[))/;

/**
 * A connection line that names a mutual tie without the person ("You spoke with my roommate at a dinner"): the name
 * goes in after the tie when the student gave it, or a bracket asks for it.
 */
function nameMutual(text: string, name: string | undefined): { text: string; missing: boolean } {
  const m = text.match(UNNAMED_MUTUAL);
  if (!m) return { text, missing: false };
  const at = m.index! + m[0].length;
  const who = name?.trim() ? strip(name) : `[your ${m[1]}'s name]`;
  return {
    text: `${text.slice(0, at)}, ${who},${text.slice(at)}`.replace(/,,/g, ','),
    missing: !name?.trim(),
  };
}

/**
 * Picking an earlier exchange back up: "Thanks again for your note in September about X, and sorry it took me a
 * while to follow up." when they wrote last, "We traded emails in May, and I wanted to pick that conversation back
 * up." when the student did. A friend gets a friend's line, never a "note" they cannot place.
 */
function reconnectLine(ctx: DraftContext, c: Connection, now: Date): string {
  const tz = ctx.user.timezone;
  const since = c.lastAt ? sinceLabel(c.lastAt, now, tz) : undefined;
  const days = c.lastAt ? calendarDaysBetween(new Date(c.lastAt), now, tz) : 0;
  if (isFriend(ctx.person))
    return days >= 45
      ? "It's been a few months since we last caught up, so I hope things are good."
      : 'Hope things are good.';
  const medium = ctx.channel === 'linkedin' ? 'email' : 'note';
  const topic = subjectTopic(ctx.thread?.subject);
  const about = topic ? ` about ${topic}` : '';
  if (c.lastInbound)
    return `Thanks again for your ${medium}${since ? ` ${since}` : ''}${about}${days >= 14 ? ', and sorry it took me a while to follow up' : ''}.`;
  return `We traded emails${since ? ` ${since}` : ''}${about}, and I wanted to pick that conversation back up.`;
}

/** "at Jane Street", "on Meta's Ads Infrastructure team", "in Goldman's TMT group", "in Bain's Boston office". */
function placeOf(ctx: DraftContext, sector: Sector): string | undefined {
  const org = shortOrg(ctx.person.org);
  if (!org) return undefined;
  const g = ctx.person.group?.trim();
  if (!g) return `at ${org}`;
  const where = orgGroup(org, g, sector);
  return /\b(team|desk|platform|program|lab|labs|org|studio)$/i.test(where) ? `on ${where}` : `in ${where}`;
}

/** Opening sentence(s) for outreach from the connection. Returns undefined when nothing checkable exists. */
function opener(
  ctx: DraftContext,
  seed: string,
  now: Date,
  qq: Question,
):
  | { text: string; claims: DraftClaim[]; saidSituation: boolean; introReply?: string; missing?: DraftNeed }
  | undefined {
  const c = ctx.connection;
  const first = firstNameOf(ctx.person);
  const org = shortOrg(ctx.person.org);
  const me = situation(ctx, now);
  const school = schoolShort(ctx.user.school);
  const sector = sectorOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    ctx.user.targetFunctions,
  );
  const claims: DraftClaim[] = [];
  if (!c) return undefined;
  const avoid = (s: string) =>
    (ctx.recentOpenings ?? []).some((o) => o.trim().toLowerCase() === firstSentence(s).toLowerCase());
  switch (c.kind) {
    case 'met': {
      // they have already talked: no introduction, no "I saw that you went from ..."
      claims.push({ text: `${first} and the student have talked before`, kind: 'shared' });
      const when = c.lastAt ? sinceLabel(c.lastAt, now, ctx.user.timezone) : undefined;
      return {
        text: `Thanks again for talking with me${when ? ` ${when}` : ''}. I had one follow-up question.`,
        claims,
        saidSituation: true,
      };
    }
    case 'prior_thread': {
      claims.push({ text: `${first} and the student have emailed before`, kind: 'shared' });
      // a friend needs no reintroduction; anyone else gets what the student is doing now, not "as a quick reminder"
      return {
        text: isFriend(ctx.person)
          ? `${reconnectLine(ctx, c, now)} I'm recruiting for ${lookingForPhrase(ctx)} this cycle${org ? `, and you're the person I wanted to ask about ${org}` : ''}.`
          : `${reconnectLine(ctx, c, now)} I'm recruiting for ${lookingForPhrase(ctx)} this cycle.`,
        claims,
        saidSituation: true,
      };
    }
    case 'referral': {
      const r = c.referrerName ?? 'A mutual contact';
      const rFirst = r.split(' ')[0]!;
      if (c.introduced) {
        // they were on the intro email: the student answers on that thread, thanks the introducer and moves them to
        // bcc, the way it is done; no need to explain who you are twice
        claims.push({ text: `${r} introduced the student to ${first} by email`, kind: 'shared' });
        if (ctx.channel === 'linkedin')
          return {
            text: `${r} introduced us by email, and it's great to meet you here. I'm ${me}.`,
            claims,
            saidSituation: true,
          };
        return {
          text: pick(
            [`Great to meet you. I'm ${me}.`, `It's great to meet you. I'm ${me}.`],
            seed,
            'op-intro',
            avoid,
          ),
          claims,
          saidSituation: true,
          introReply: rFirst,
        };
      }
      claims.push({ text: `${r} suggested writing to ${first}`, factId: c.factId, kind: 'shared' });
      // only the referrer's name is on record, never what they said about the person
      return {
        text: pick(
          [`${r} suggested I write to you. I'm ${me}.`, `${r} suggested I get in touch with you. I'm ${me}.`],
          seed,
          'op-ref',
          avoid,
        ),
        claims,
        saidSituation: true,
      };
    }
    case 'event': {
      claims.push({ text: c.text, factId: c.factId, kind: 'shared' });
      const evt = c.eventName ? `the ${c.eventName.replace(/^the\s+/i, '')}` : undefined;
      const said = /^you /.test(c.text)
        ? pick(
            [
              `I was in the audience when ${c.text}, and I've wanted to follow up since. I'm ${me}.`,
              `${cap1(c.text)}, and I've been thinking about it since. I'm ${me}.`,
            ],
            seed,
            'op-event',
            avoid,
          )
        : `We met at ${evt ?? 'the event'}, and I wanted to follow up. I'm ${me}.`;
      return { text: said, claims, saidSituation: true };
    }
    case 'alumni': {
      claims.push({ text: `${first} went to ${ctx.user.school}`, kind: 'shared' });
      const where =
        placeOf(ctx, sector) ??
        (roleNoun(ctx.person.title)
          ? `working as ${article(roleNoun(ctx.person.title)!)} ${roleNoun(ctx.person.title)}`
          : undefined);
      return {
        text: pick(
          // only what the data says: they went to the student's school and are at `where` now (never how the
          // student found them, which Orbit does not know); the school is named once
          [
            ctx.user.oneLiner || !ctx.user.majors[0]
              ? `I'm ${me}, and I saw that you're an alum${where ? ` ${where}` : ''}.`
              : `${school} ${yearLabel(ctx.user.gradYear, ctx.user.degree, now)} here, studying ${lowerPhrase(ctx.user.majors[0])}, and I saw that you're an alum${where ? ` ${where}` : ''}.`,
            `I'm ${me}, and I saw that you're an alum${where ? `, now ${where}` : ''}.`,
          ],
          seed,
          'op-alum',
          avoid,
        ),
        claims,
        saidSituation: true,
      };
    }
    case 'warmup':
    case 'post': {
      claims.push({ text: c.text, factId: c.factId, kind: 'about_person' });
      const p = postPhrase(c.text);
      const alum = ctx.person.isAlumni ? `, and I saw you went to ${school} too` : '';
      if (alum) claims.push({ text: `${first} went to ${ctx.user.school}`, kind: 'shared' });
      return {
        text: pick(
          [
            `Your post ${p} is what made me write${alum}. I'm ${me}.`,
            `I've been following your posts, and the one ${p} stuck with me${alum}. I'm ${me}.`,
          ],
          seed,
          'op-post',
          avoid,
        ),
        claims,
        saidSituation: true,
      };
    }
    case 'transition': {
      claims.push({
        text: `${first} moved from ${c.previous} to ${ctx.person.org}`,
        factId: c.factId,
        kind: 'about_person',
      });
      return {
        text: pick(
          [
            `I'm ${me}, and I saw that you moved from ${c.previous} to ${org ?? 'your current role'}.`,
            `I saw that you went from ${c.previous} to ${org ?? 'your current role'}, which is the kind of move I'm trying to understand. I'm ${me}.`,
          ],
          seed,
          'op-trans',
          avoid,
        ),
        claims,
        saidSituation: true,
      };
    }
    case 'shared_employer': {
      claims.push({ text: `both spent time at ${c.sharedOrg}`, factId: c.factId, kind: 'shared' });
      return {
        text: pick(
          [
            `I'm ${me}, and I interned at ${c.sharedOrg}, where you were before ${org ?? 'your current role'}.`,
            `We overlap on ${c.sharedOrg}: I interned there, and I saw you were there before ${org ?? 'where you are now'}. I'm ${me}.`,
          ],
          seed,
          'op-shared',
          avoid,
        ),
        claims,
        saidSituation: true,
      };
    }
    case 'hook': {
      claims.push({ text: c.text, factId: c.factId, kind: 'about_person' });
      return {
        text: pick(
          [
            `I saw that ${c.text}, and that's what made me write. I'm ${me}.`,
            `I'm ${me}, and I saw that ${c.text}.`,
          ],
          seed,
          'op-hook',
          avoid,
        ),
        claims,
        saidSituation: true,
      };
    }
    case 'user_supplied': {
      claims.push({ text: c.text, factId: c.factId, kind: 'shared' });
      const named = nameMutual(c.text, ctx.mutualName);
      const said = studentSentence(named.text);
      // the student's own line, then the one question it raises (never the line read back as the ask)
      const text = qq.reacted
        ? `${said}, and I've been wondering ${qq.q}. I'm ${me}.`
        : `${said}. I'm ${me}.`;
      return { text, claims, saidSituation: true, missing: named.missing ? 'mutual' : undefined };
    }
  }
}

/**
 * Whether the student's one credibility line ("built a reconciliation service in Go") means something to this
 * reader: an engineer, a founder or a CTO, a PM when it is about users. Never a designer, an ops lead, a banker or
 * a consultant, where it reads as stapled on.
 */
function credibilityFits(ctx: DraftContext, sector: Sector, firm: string): boolean {
  if (sector !== 'tech' && firm !== 'startup') return false;
  const fn = titleFunction(ctx.person.title);
  if (fn === 'swe' || fn === 'data') return true;
  if (/\b(cto|founder|co-founder|founding|engineering)\b/i.test(ctx.person.title ?? '')) return true;
  return fn === 'pm' && /\b(users?|students?|customers?|people)\b/i.test(ctx.user.credibility ?? '');
}

const HOOK_TYPES: PersonFact['type'][] = ['hook', 'role_detail', 'background'];

/**
 * A live deal, fundraise or client matter: never written back to a banker, investor or consultant ("how is the
 * take-private going" is a question nobody can answer in writing), however it got into the notes.
 */
export function isConfidential(text: string, firm: string): boolean {
  if (!['bank', 'pe', 'vc', 'trading', 'consulting'].includes(firm)) return false;
  return /\b(deal|take-private|take private|acquisition|acquir\w*|merger|m&a process|ipo|transaction|closing|raise|raising|fundrais\w*|new fund|funding round|series [a-e]|lbo|buyout|pitch\w*|mandate|clients?)\b/i.test(
    text,
  );
}

/** The most recent usable fact of the first type in `types` (priority order) that has one. */
function pickFact(
  facts: PersonFact[],
  types: PersonFact['type'][],
  person: DraftContext['person'],
  usable: (c: FactClause) => boolean = () => true,
): { fact: PersonFact; c: FactClause } | undefined {
  for (const type of types) {
    const cands = facts
      .filter((f) => f.type === type && !f.deletedAt && (f.confidence ?? 1) >= 0.6)
      .sort((a, b) => (b.occurredAt ?? b.createdAt ?? '').localeCompare(a.occurredAt ?? a.createdAt ?? ''));
    for (const fact of cands) {
      const c = clause(fact.text, person);
      if (c && usable(c)) return { fact, c };
    }
  }
  return undefined;
}

/** Find the strongest checkable link between student and recipient from stored data. */
export function deriveConnection(ctx: DraftContext): Connection | undefined {
  if (ctx.connection) return ctx.connection;
  const facts = ctx.facts.filter((x) => !x.deletedAt);
  const supplied = facts.find((x) => x.type === 'connection');
  if (supplied) return { kind: 'user_supplied', text: strip(supplied.text), factId: supplied.id };
  // they have talked already: a first-touch introduction ("I saw that you went from ...") would read as a mass mail
  const metAt = ctx.chat?.meetingAt ?? ctx.chat?.completedAt;
  if (metAt && new Date(metAt).getTime() <= (ctx.now ?? new Date()).getTime())
    return { kind: 'met', text: 'we have talked before', lastAt: metAt };
  // they have written back before: that exchange is the connection, not a cold introduction
  if (ctx.history?.repliedEver)
    return {
      kind: 'prior_thread',
      text: 'we have emailed before',
      lastAt: ctx.history.lastAt,
      lastInbound: ctx.history.lastInbound,
    };
  if (ctx.chat?.referrerName)
    return {
      kind: 'referral',
      text: ctx.person.org ? `${ctx.person.org}` : 'your work',
      referrerName: ctx.chat.referrerName,
      introduced: !!ctx.chat.introducedAt || undefined,
    };
  const event = facts.find((x) =>
    /\b(panel|spoke at|talk at|info session|conference|workshop|presented at|fireside)\b/i.test(x.text),
  );
  if (event) {
    const name = event.text.match(
      /\b(?:at|the)\s+(the\s+)?([A-Z][\w&' ]{3,40}?(?:panel|event|session|conference|workshop|talk|fireside))/,
    )?.[2];
    const c = clause(event.text, ctx.person);
    return {
      kind: 'event',
      text: c?.you ? c.text : name ? `we met at the ${name}` : strip(event.text),
      factId: event.id,
      eventName: name,
    };
  }
  // a post the student actually engaged with is more specific than a shared school (the opener still names the school)
  if (ctx.chat?.warmUpNote && (ctx.chat.warmUpDone ?? 0) >= 1)
    return { kind: 'warmup', text: strip(ctx.chat.warmUpNote) };
  if (ctx.person.isAlumni)
    return { kind: 'alumni', text: `${ctx.person.fullName} went to ${ctx.user.school}` };
  const shared = (ctx.user.pastOrgs ?? []).find(
    (o) => o && ctx.person.previousOrg && o.toLowerCase() === ctx.person.previousOrg.toLowerCase(),
  );
  if (shared) return { kind: 'shared_employer', text: `both spent time at ${shared}`, sharedOrg: shared };
  if (ctx.person.previousOrg && ctx.person.org && ctx.person.previousOrg !== ctx.person.org)
    return {
      kind: 'transition',
      text: `moved from ${ctx.person.previousOrg} to ${ctx.person.org}`,
      // the same title at both is a move between companies ("from Notion to Stripe"), not "from product designer at
      // Notion to product designer at Stripe"
      previous:
        ctx.person.previousTitle &&
        ctx.person.previousOrg &&
        roleNoun(ctx.person.previousTitle) !== roleNoun(ctx.person.title)
          ? `${lowerPhrase(roleNoun(ctx.person.previousTitle) ?? ctx.person.previousTitle)} at ${shortOrg(ctx.person.previousOrg)}`
          : shortOrg(ctx.person.previousOrg),
    };
  const kind = firmKindOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    sectorOf({ title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry }),
  );
  const hook = pickFact(
    facts,
    HOOK_TYPES,
    ctx.person,
    (c) => c.text.split(' ').length <= 22 && !isConfidential(c.text, kind),
  );
  if (hook) return { kind: 'hook', text: firstPart(hook.c.text), factId: hook.fact.id };
  return undefined;
}

function join(...parts: (string | undefined | false)[]): string {
  return parts
    .filter(Boolean)
    .map((p) => (p as string).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/ ,/g, ',');
}
const SIGNOFF_LINE =
  /^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks|kind regards|best regards)[,!.]?$/i;
function firstSentence(body: string): string {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // the opening is what the student actually wrote to them: never a bracketed prompt or the sign-off
  // a one-paragraph note ("Hi Noah, I read your post ...") opens after its greeting
  const first =
    lines
      .map((l) => l.replace(/^(hi|hey|hello|dear)\b[^,.!?\n]{0,40},\s*/i, ''))
      .find(
        (l) =>
          !/^(hi|hey|hello|dear)\b/i.test(l) &&
          !/^\[/.test(l) &&
          !/\(moving you to bcc\)/i.test(l) &&
          !SIGNOFF_LINE.test(l) &&
          /\s/.test(l),
      ) ?? '';
  const sentence = (first.match(/^[^.!?]*[.!?]/)?.[0] ?? first).trim();
  return /\[|\]/.test(first) ? '' : sentence;
}

/** Cut a note to `max` characters at a sentence boundary (or, at worst, a word boundary). Never mid-word. */
export function fitNote(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  if (sentenceEnd > max * 0.4) return cut.slice(0, sentenceEnd + 1);
  const space = cut.lastIndexOf(' ');
  return cut.slice(0, space > 0 ? space : max).replace(/[\s,;:]+$/, '');
}

/** Words that read as a question for the student to answer (never answered for them). */
const QUESTION_START =
  /^(what|which|why|how|when|where|who|are|is|do|does|did|would|could|can|have|has|will|should)\b/i;
const RESUME_ASK = /\b(resume|cv|transcript|portfolio)\b/i;
const TIMES_ASK =
  /\b(times?|availability|available|when works|what works|works for you|schedule a|find a time|free (to|for)|good day)\b/i;

/** A booking page the other person sent ("grab a slot here: calendly.com/..."), so the student books instead of proposing. */
export function bookingLinkIn(text: string | undefined): boolean {
  if (!text) return false;
  return (
    /\b(?:https?:\/\/)?(?:www\.)?(calendly\.com|cal\.com|savvycal\.com|zcal\.co|tidycal\.com|meetings\.hubspot\.com|calendar\.app\.google|outlook\.office\.com\/bookwithme)\/\S+/i.test(
      text,
    ) ||
    /\b(my booking (link|page)|book (a|some) time (here|on my calendar|through)|grab a (slot|time) (here|on my calendar))\b/i.test(
      text,
    )
  );
}

/** Whether a function is one a firm of this kind hires students for ("software engineering" at a bank or a trading firm, never "software engineering" at McKinsey). */
function functionFits(fn: string | undefined, title: string | undefined, firm: string): boolean {
  if (!fn) return false;
  if (matchedFunction(title, [fn])) return true;
  const tech = ['swe', 'pm', 'design', 'data'];
  switch (firm) {
    case 'bank':
      return ['ib', 'finance'].includes(fn);
    case 'pe':
      return ['ib', 'finance', 'pe'].includes(fn);
    case 'trading':
      return ['quant', 'swe', 'data', 'finance'].includes(fn);
    case 'vc':
      return fn === 'vc' || fn === 'finance';
    case 'consulting':
      return fn === 'consulting';
    case 'big_tech':
    case 'startup':
    case 'tech':
      return [...tech, 'marketing', 'ops', 'research'].includes(fn);
    default:
      return true;
  }
}

/** A time they proposed, checked against their own words (see the reply branch of generateDraft). */
interface CheckedTime {
  startIso: string;
  raw: string;
  /** the stored time disagreed with the words; `startIso` is the words read again */
  reread?: boolean;
  /** the stored time disagrees with the words and the words cannot be dated: only the words can be confirmed */
  unreadable?: boolean;
}

/**
 * Read the words of a proposed time again ("Thursday at 3pm", as of `ref`, when they wrote it) and keep what they say.
 * Without the moment they wrote it the words cannot be dated, so only the weekday is checked.
 */
export function rereadTime(
  t: { startIso: string; raw: string },
  ref: Date | undefined,
  tz: string,
): CheckedTime {
  const again = ref ? extractTimes(t.raw, ref, { timeZone: tz })[0] : undefined;
  if (again) {
    if (Math.abs(new Date(again.startIso).getTime() - new Date(t.startIso).getTime()) <= 30 * 60_000)
      return { startIso: t.startIso, raw: t.raw };
    return { startIso: again.startIso, raw: t.raw, reread: true };
  }
  const said = t.raw.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1];
  let stored = '';
  try {
    stored = new Date(t.startIso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  } catch {
    stored = new Date(t.startIso).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  }
  if (said && said.toLowerCase() !== stored.toLowerCase())
    return { startIso: t.startIso, raw: t.raw, unreadable: true };
  return { startIso: t.startIso, raw: t.raw };
}

/**
 * The kind of message the thread calls for, when it is not the one asked for: a bump to someone who has answered is
 * the scheduling reply (or a check-in when their answer asked for nothing), and a "reply" to a message that waits on
 * nothing (a sign-off from months ago) is a check-in that gives its own reason to write.
 */
function writtenKind(ctx: DraftContext, now: Date): { kind: MessageKind; reopen?: boolean } {
  const t = ctx.thread;
  if (ctx.kind === 'bump' && answeredAfterOutreach(t))
    return inboundNeedsAnswer(t, now) ? { kind: 'schedule' } : { kind: 'nurture', reopen: true };
  // a "first" message to someone already written to, with no answer yet, is the bump on that thread
  if (ctx.kind === 'outreach' && t?.firstOutboundAt && !t.lastInboundAt && !ctx.history?.repliedEver)
    return { kind: 'bump' };
  const upcoming = !!ctx.chat?.upcomingAt && new Date(ctx.chat.upcomingAt).getTime() > now.getTime();
  if (
    ctx.kind === 'reply' &&
    t?.lastInboundAt &&
    !inboundNeedsAnswer(t, now) &&
    !upcoming &&
    !bookingLinkIn(t.lastInboundBody) &&
    t.lastSignal !== 'out_of_office'
  )
    return { kind: 'nurture', reopen: true };
  return { kind: ctx.kind };
}

export function generateDraft(ctx: DraftContext): DraftOutput {
  const now = ctx.now ?? new Date();
  const routed = writtenKind(ctx, now);
  if (routed.kind !== ctx.kind)
    return generateDraft({ ...ctx, kind: routed.kind, reopen: routed.reopen || ctx.reopen });
  const seed = ctx.seed ?? ctx.person.fullName;
  const sector = sectorOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    ctx.user.targetFunctions,
  );
  const seniority = seniorityOf(ctx.person.title);
  const recruiter = isRecruiter(ctx.person.title);
  const first = firstNameOf(ctx.person);
  const org = ctx.person.org;
  const tz = ctx.user.timezone;
  const G = greeting(ctx, sector, recruiter && ctx.kind === 'outreach');
  const S = signoff(ctx, sector, G, recruiter && ctx.kind === 'outreach');
  // a "Dear" letter is formal throughout (no contractions); a formal style preset to a friend or a peer is not
  const formal = /^Dear\b/.test(G) || (ctx.styleCard.builtFromCount > 0 && isFormalStyle(ctx.styleCard));
  const register: DraftOutput['register'] =
    formal || ((sector === 'finance' || sector === 'consulting' || recruiter) && !isFriend(ctx.person))
      ? 'formal'
      : 'warm';
  const claims: DraftClaim[] = [];
  const needsInput: DraftNeed[] = [];
  const facts = ctx.facts.filter((f) => !f.deletedAt);
  const P = ctx.person;
  const fact = (types: PersonFact['type'][], usable?: (c: FactClause) => boolean) =>
    pickFact(facts, types, P, usable);
  const cite = (f: { fact: PersonFact } | undefined) => {
    if (f) claims.push({ text: f.fact.text, factId: f.fact.id, kind: 'about_person' });
  };
  // A connection (student <-> recipient) only matters for messages that open a relationship.
  if (['outreach', 'bump'].includes(ctx.kind)) ctx = { ...ctx, connection: deriveConnection(ctx) };
  const minutes = ctx.person.isAlumni ? 20 : 15;
  const threaded = !!ctx.thread?.inThread;
  const reSubject = ctx.thread?.subject
    ? `Re: ${ctx.thread.subject.replace(/^(re|fwd?):\s*/i, '')}`
    : undefined;
  const school = schoolShort(ctx.user.school);
  let subject: string | undefined;
  let introReply: DraftOutput['introReply'];
  let body = '';
  let bodyShort: string | undefined;
  const me = situation(ctx, now);
  const cy = classYear(ctx.user.gradYear);
  const yl = yearLabel(ctx.user.gradYear, ctx.user.degree, now);
  const fnLabel = targetLabel(ctx);
  const futureWindows = (ctx.proposedWindows ?? [])
    .filter((w) => new Date(w.startIso).getTime() > now.getTime())
    .slice(0, 2);
  const windowsText = futureWindows.length ? fmtWindows(futureWindows, tz) : undefined;
  const meetingAt = ctx.chat?.meetingAt ?? ctx.chat?.completedAt;
  const asks = (ctx.thread?.asksOfUser ?? []).map(strip).filter(Boolean).slice(0, 3);
  const booking = bookingLinkIn(ctx.thread?.lastInboundBody);
  // A reply that asks something (send your resume, which teams) or hands over a booking link is answered first;
  // proposing two times while ignoring the ask is the classic tell of a template.
  // A time they proposed is answered too: confirmed when it is free, never ignored for two new slots.
  // (a time Orbit already knows was missed is owned up to in the scheduling note itself)
  const theyProposed =
    !!ctx.thread?.proposedTimes?.length && ctx.thread.lastSignal !== 'reschedule' && !ctx.missedProposal;
  const kind: MessageKind =
    ctx.kind === 'schedule' &&
    ((asks.length && ctx.thread?.lastSignal !== 'reschedule') || booking || theyProposed)
      ? 'reply'
      : ctx.kind;

  switch (kind) {
    case 'outreach': {
      const firm = firmOf(ctx, sector);
      const late = cycleTiming(firm, ctx.user.cycleLabel, now) === 'late';
      const o = shortOrg(org);
      if (recruiter) {
        // Recruiters get logistics, never a coffee-chat ask, and the one question has to be one the careers page
        // does not answer for this kind of firm: a startup or a fund has no campus event.
        const intern = isInternCycle(ctx.user.cycleLabel);
        const tc =
          ctx.targetCompany && (!org || normalizeCompany(ctx.targetCompany.name) === normalizeCompany(org))
            ? ctx.targetCompany
            : undefined;
        const applied = !!tc?.applied;
        const role = tc?.roleLabel
          ? `the ${tc.roleLabel} role`
          : `${fnLabel} ${intern ? 'internships' : 'roles'}`;
        const at = o ? ` at ${o}` : '';
        const year = ctx.user.cycleLabel.match(/\b(20\d\d)\b/)?.[1];
        const hiring = fact(
          ['hook', 'role_detail'],
          (x) =>
            /\b(interns?|hiring|hire)\b/i.test(x.text) &&
            x.text.split(' ').length <= 16 &&
            !isConfidential(x.text, firm),
        );
        const campus = ['bank', 'consulting', 'big_tech', 'trading', 'pe'].includes(firm);
        const status = applied
          ? `I've applied for ${role}${at}.`
          : late
            ? `I'm interested in ${o ? `${possessive(o)} ` : 'your '}summer analyst program.`
            : `I'm planning to apply for ${role}${at} this cycle.`;
        const question = applied
          ? 'Is there a typical timeline for when first-round interviews go out, or anything I should do on my end in the meantime?'
          : late
            ? `I know the main ${year ? `Summer ${year} ` : ''}cycle ran earlier this year. Are there seats still open, or off-cycle or diversity programs, that I should know about?`
            : hiring
              ? `I saw that ${firstPart(hiring.c.text)}. Is there a timeline for that, or a best way to be considered?`
              : campus
                ? `Is there an application deadline or a ${school || 'campus'} info session I should plan around?`
                : 'Is there a timeline for intern hiring this year, or anything that helps to have ready?';
        cite(hiring);
        subject = applied
          ? `${school} ${cy || yl}, my ${o ?? ''} application`.replace(/\s+/g, ' ').trim()
          : `${school} ${cy || yl}, question about ${o ?? ''} ${intern ? 'internship' : 'new grad'} recruiting`
              .replace(/\s+/g, ' ')
              .trim();
        const spoke = (ctx.sameOrgContacts ?? []).slice(0, 2);
        // one conversation each is all Orbit knows: "spoken with Lena", never "helpful conversations"
        const spokeLine = spoke.length ? ` I've also spoken with ${spoke.join(' and ')} on the team.` : '';
        // a recruiter the student has already emailed with is not a stranger
        const known = ctx.connection?.kind === 'prior_thread' ? ctx.connection : undefined;
        const intro = known
          ? `${reconnectLine(ctx, known, now)} ${applied ? `A quick update: ${status}` : `I'm ${me}. ${status}`}`
          : `I'm ${me}. ${status}`;
        if (known) claims.push({ text: `${first} and the student have emailed before`, kind: 'shared' });
        body = `${G}\n\n${intro} ${question}${spokeLine}${/^thank/i.test(S.trim()) ? '' : '\n\nThank you for your time.'}\n\n${S}`;
        claims.push({ text: `${first} recruits${org ? ` for ${org}` : ''}`, kind: 'about_person' });
        claims.push({ text: 'logistics question', kind: 'logistics' });
        if (ctx.channel === 'linkedin') {
          // a connection note, not a letter: who, the role, one answerable question
          const shortStatus = applied
            ? `I've applied for ${role}${at}.`
            : late
              ? `I'm interested in ${o ? `${possessive(o)} ` : 'your '}summer analyst program.`
              : `I'm planning to apply for ${role}${at}.`;
          const shortQ = applied
            ? 'Is there a typical timeline for first-round interviews?'
            : late
              ? 'Are there seats still open, or off-cycle programs I should know about?'
              : campus
                ? `Is there a deadline or a ${school || 'campus'} info session I should plan around?`
                : 'Is there a timeline for intern hiring this year?';
          const notes = [
            ...(known
              ? [
                  `Hi ${first}, ${lower1(shortConnection(ctx, known))} ${shortStatus} ${shortQ} Thanks, ${ctx.user.firstName}`,
                ]
              : []),
            `Hi ${first}, ${school} ${yl} here. ${shortStatus} ${shortQ} Thank you, ${ctx.user.firstName}`,
            `Hi ${first}, ${school} ${yl} here. ${shortStatus} ${shortQ} ${ctx.user.firstName}`,
          ];
          bodyShort =
            notes.find((x) => x.length <= LINKEDIN_NOTE_TARGET) ??
            notes.find((x) => x.length <= LINKEDIN_NOTE_MAX) ??
            fitNote(notes[known ? 1 : 0]!, LINKEDIN_NOTE_MAX);
          subject = undefined;
        } else if (threaded) subject = reSubject;
        break;
      }
      let qq = questionFor(ctx, sector, seed, now);
      if (qq.factId) claims.push({ text: qq.factText!, factId: qq.factId, kind: 'about_person' });
      const op = opener(ctx, seed, now, qq);
      if (!op) {
        needsInput.push('connection');
        claims.push({ text: 'connection missing', kind: 'logistics' });
      }
      if (op?.missing) needsInput.push(op.missing);
      const friend = isFriend(P);
      const c = ctx.connection;
      const sit = op?.saidSituation
        ? ''
        : `I'm ${me}, recruiting for ${lookingForPhrase(ctx)}${late ? '' : ' this cycle'}.`;
      const commented =
        !!ctx.chat?.commentedOnPost && !['warmup', 'post'].includes(ctx.connection?.kind ?? '');
      const openText =
        op?.text ??
        (commented
          ? `[What their post was about, e.g. "Read your post on ..." (you commented on it during the warm-up)]`
          : `[Your link to ${first}: how you found them, what you share, or what of theirs you read]`);
      claims.push(...(op?.claims ?? []));
      // a warm-up comment the student did not describe is still worth a clause next to another link
      const alsoCommented = op && commented ? 'I also left a comment on your recent post.' : '';
      // a hiring note ("hiring their first two interns in January") is the fact that matters most to a student; other
      // notes about their work go into the question, never a stacked "I also saw that you ..." line
      const hiring =
        op && c?.kind !== 'hook' && !friend && !qq.reacted
          ? fact(
              ['hook'],
              (x) =>
                /\b(interns?|hiring|hire)\b/i.test(x.text) &&
                x.text.split(' ').length <= 16 &&
                !isConfidential(x.text, firm),
            )
          : undefined;
      const aboutLine = hiring ? `I also saw that ${firstPart(hiring.c.text)}.` : '';
      cite(hiring);
      // proof beats adjectives in tech, but only where it means something to the reader (an engineer, a founder),
      // and never to someone who already knows the student
      const cred =
        op && ctx.user.credibility && !friend && c?.kind !== 'met' && credibilityFits(ctx, sector, firm)
          ? `I ${softLower(strip(ctx.user.credibility))}, and I'm recruiting for ${lookingForPhrase(ctx)} this cycle.`
          : '';
      const isLinkedIn = ctx.channel === 'linkedin';
      const thanksSignoff = /^thanks/i.test(S.trim());
      const oneQuestion =
        !friend &&
        c?.kind !== 'met' &&
        !c?.introduced &&
        ['big_tech', 'tech', 'startup', 'trading'].includes(firm) &&
        (seniority === 'exec' || /\b(vice president|vp)\b/i.test(P.title ?? ''));
      // the firm is named once: a question that repeats it after the opener says "there"
      if (o && op?.text.includes(o)) qq = thereFor(qq, o);
      const ask = askBlock(minutes, qq, seed, formal, thanksSignoff, { oneQuestion, friend });
      body = `${G}\n\n${join(openText, alsoCommented, ctx.applicationLine, aboutLine, sit, cred)}\n\n${ask}\n\n${S}`;
      if (op?.introReply && !isLinkedIn) {
        // a reply-all on the introduction: thank the introducer, move them to bcc, then speak to the person
        introReply = { bcc: op.introReply };
        body = `Thanks for the introduction, ${op.introReply} (moving you to bcc).\n\n${body}`;
        claims.push({ text: `thanks ${op.introReply} for the introduction`, kind: 'shared' });
      }
      // Subject: the connection, then the topic, short enough for a phone.
      const subjectCandidates: string[] = [];
      if (c?.kind === 'referral' && c.referrerName && !c.introduced)
        subjectCandidates.push(`${c.referrerName} suggested I write to you`);
      if (c?.kind === 'event' && c.eventName)
        subjectCandidates.push(`From the ${c.eventName.replace(/^the\s+/i, '')}, one follow-up`);
      if (c?.kind === 'transition' && c.previous)
        subjectCandidates.push(`Your move from ${c.previous} to ${o ?? 'your role'}`);
      if (c?.kind === 'met') subjectCandidates.push('One follow-up question');
      if (friend) subjectCandidates.push(`Quick question about ${o ?? 'recruiting'}`);
      if (qq.reacted && c?.kind === 'user_supplied' && /\bpost\b/i.test(c.text))
        subjectCandidates.push(`${school} ${yl}, your post on ${qq.about}`);
      if (ctx.person.isAlumni)
        subjectCandidates.push(
          `${school} ${yl}, quick question on ${o ?? 'your path'}`,
          `Fellow ${school} student, your path to ${o ?? roleNoun(ctx.person.title) ?? 'your role'}`,
        );
      subjectCandidates.push(
        `Quick question about your path to ${o ?? roleNoun(ctx.person.title) ?? 'your role'}`,
        `${school} ${yl}, question about ${o ?? 'your work'}`,
      );
      const named =
        !!c && (['referral', 'event', 'transition', 'met'].includes(c.kind) || friend || !!qq.reacted);
      const specific = subjectCandidates
        .slice(0, named ? 1 : ctx.person.isAlumni ? 1 : 0)
        .find((s) => s.length <= 60);
      subject =
        specific ??
        [...subjectCandidates].sort((a, b) => a.length - b.length).find((s) => s.length <= 60) ??
        subjectCandidates[0]!;
      // finance subjects carry school, class year and their group, unless a named link (a referrer, an event, a
      // conversation) says more
      if (sector === 'finance' && cy && o && !named && !friend)
        subject = `${school} ${cy}, quick question on ${o}${ctx.person.group ? ` ${ctx.person.group}` : ''}`;
      // picking an earlier exchange back up (or an introduction) replies in that thread
      if (threaded || introReply) subject = reSubject;
      // LinkedIn connection note (not yet connected) or message (connected)
      if (isLinkedIn) {
        const short = op ? shortConnection(ctx, c!) : `[your link to ${first}]`;
        if (o && short.includes(o)) qq = thereFor(qq, o);
        // someone who already knows the student is not told their school and year again
        const known = !!c && (c.kind === 'met' || (c.kind === 'prior_thread' && friend) || !!c.introduced);
        const intro = known
          ? ''
          : pick([`I'm ${article(yl)} ${yl} at ${school}.`, `${school} ${yl} here.`], seed, 'note-intro');
        const lead = `Hi ${first}, ${
          intro
            ? `${intro} ${short}`
            : softLower(short)
                .replace(/^Thanks\b/, 'thanks')
                .replace(/^Following\b/, 'following')
                .replace(/^It's\b/, "it's")
                .replace(/^Hope\b/, 'hope')
        }`;
        const name = ctx.user.firstName;
        const pathTo = o ? `your path to ${o}` : 'your path';
        const candidates = [
          `${lead} Would you have ${minutes} minutes to talk about ${qq.short}? Happy to work around your schedule. ${name}`,
          `${lead} Would you have ${minutes} minutes to talk about ${qq.short}? Thanks, ${name}`,
          `${lead} Would you have ${minutes} minutes to talk about ${qq.reacted ? 'it' : pathTo}? Thanks, ${name}`,
          `Hi ${first}, ${lower1(short)} Would you have ${minutes} minutes to talk about ${qq.reacted ? 'it' : pathTo}? Thanks, ${name}`,
        ];
        bodyShort =
          candidates.find((x) => x.length <= LINKEDIN_NOTE_TARGET) ??
          candidates.find((x) => x.length <= LINKEDIN_NOTE_MAX) ??
          fitNote(candidates[3]!, LINKEDIN_NOTE_MAX);
        if (ctx.person.linkedinConnected) {
          const at = ctx.person.linkedinConnectedAt
            ? new Date(ctx.person.linkedinConnectedAt).getTime()
            : NaN;
          const recent = !Number.isNaN(at) && now.getTime() - at < 21 * 86_400_000;
          const emailOk = pick(
            [
              'A few lines over email would be just as helpful.',
              "Happy to keep it to email if that's easier.",
            ],
            seed,
            'li-email',
          );
          body = `${recent ? `Hi ${first}, thanks for connecting. ` : `${G}\n\n`}${join(openText, aboutLine, sit, cred)} ${
            oneQuestion && qq.direct
              ? `One question, if you have a minute: ${lower1(qq.direct)} Even a line back would help, or ${minutes} minutes if a call is easier.`
              : `Would you have ${minutes} minutes in the next couple of weeks to ${qq.reacted ? 'talk about it' : `tell me ${qq.q}`}?`
          } ${emailOk}\n\n${S}`;
        }
        subject = undefined;
      }
      break;
    }
    case 'bump': {
      const n = ctx.bumpNumber ?? 1;
      const o = shortOrg(org);
      const c = ctx.connection;
      // "my note from Thursday", "my note from last week", "my note from September 24"; undated when unknown
      const noteDate = ctx.thread?.firstOutboundAt
        ? whenLabel(ctx.thread.firstOutboundAt, now, tz)?.replace(/^on /, '')
        : undefined;
      const myNote = noteDate ? `my note from ${noteDate}` : 'my earlier note';
      // the ask restated in one clause: what the thread was about, or the move or the post the note named
      const piece = c ? connectionTopic(c.text) : undefined;
      const topic =
        subjectTopic(ctx.thread?.subject) ??
        (c?.kind === 'transition' && c.previous
          ? `your move to ${o ?? 'your current role'}`
          : piece && c && /\b(post|article|talk|podcast|episode)\b/i.test(c.text)
            ? `your ${c.text.match(/\b(post|article|talk|podcast|episode)\b/i)![1]!.toLowerCase()} on ${piece}`
            : undefined);
      const about = topic ? ` about ${topic}` : '';
      const hear = topic ? ` to hear about ${topic}` : '';
      const friend = isFriend(P);
      // a pointer to someone else fits a senior person who may not be the right one, never a friend or a peer
      const senior = isSeniorTitle(P.title) && !friend;
      const ref = c?.kind === 'referral' ? c.referrerName?.split(' ')[0] : undefined;
      // the referrer is the strongest reason to answer, so a bump on a referred thread names them
      const refLine = ref
        ? c?.introduced
          ? `Following up on ${ref}'s introduction in case my note got buried.`
          : `${ref} suggested I write to you, so I wanted to float this back up in case it got buried.`
        : undefined;
      const away = ctx.thread?.lastSignal === 'out_of_office' || !!ctx.chat?.awayUntil;
      const tc =
        ctx.targetCompany && (!org || normalizeCompany(ctx.targetCompany.name) === normalizeCompany(org))
          ? ctx.targetCompany
          : undefined;
      if (n >= 2) {
        body = `${G}\n\n${
          formal
            ? `One last note from me. If the next few weeks are too busy, I completely understand, and if a ${minutes}-minute call ever fits, I would be glad to make the time work.`
            : pick(
                [
                  `Last note from me, I promise. If the next few weeks are too busy, no problem at all. If a ${minutes}-minute call ever does fit, I'll make the time work.`,
                  `One last nudge and then I'll leave you be. If a ${minutes}-minute call fits at some point this cycle, I'd still be glad to take it.`,
                ],
                seed,
                'bump2',
              )
        }\n\n${S}`;
        claims.push({ text: 'second bump', kind: 'logistics' });
      } else if (away) {
        // their out-of-office said when they would be back: the bump waits for that and says so
        const applied = tc?.applied
          ? ` I've since applied for the ${tc.roleLabel ? `${tc.roleLabel} role` : 'internship'}${o ? ` at ${o}` : ''}, so ${minutes} minutes on what the team looks for would be especially helpful.`
          : ` I'd still love ${minutes} minutes whenever it's convenient.`;
        body = `${G}\n\nWelcome back, and I hope the time away was good. Resurfacing ${myNote}${about} in case it got buried while you were out.${applied}\n\n${S}`;
        claims.push({ text: 'first bump after their out-of-office', kind: 'logistics' });
      } else {
        const pointer = senior
          ? ", and if someone else on your team would be a better person to ask, I'd be grateful for a pointer"
          : '';
        body = `${G}\n\n${
          formal
            ? `${refLine ?? `I wanted to follow up on ${myNote}${about}.`} I would be grateful for ${minutes} minutes in the coming weeks${senior ? ', or for a pointer to someone better placed' : ''}.`
            : friend
              ? `Bumping this in case it got buried. I'd still love ${minutes} minutes${hear} whenever you have a moment, no rush at all.`
              : refLine
                ? `${refLine} I'd still love ${minutes} minutes${hear} whenever it's convenient${pointer}.`
                : pick(
                    [
                      `Floating this back up in case it got buried. I'd still love ${minutes} minutes${hear} whenever it's convenient${pointer}.`,
                      `Just surfacing ${myNote}${about} in case it got buried. Even ${minutes} minutes whenever it's convenient would help${pointer || ", and I completely understand if the timing isn't right"}.`,
                      `Following up on ${myNote}${about} in case it got lost. I'd still value ${minutes} minutes in the next couple of weeks${pointer || ", and completely understand if now isn't a good time"}.`,
                    ],
                    seed,
                    'bump1',
                  )
        }\n\n${S}`;
        if (ref)
          claims.push({
            text: c?.introduced
              ? `${ref} introduced the student to ${first}`
              : `${ref} suggested writing to ${first}`,
            kind: 'shared',
          });
        claims.push({ text: 'first bump in thread', kind: 'logistics' });
      }
      subject = threaded ? undefined : (reSubject ?? `${school} ${yl}, following up on my note`);
      break;
    }
    case 'schedule': {
      const last = ctx.thread?.lastSignal;
      // the reason they agreed to talk, so the times are not all the note says
      const topic = subjectTopic(ctx.thread?.subject);
      const looking = topic ? `\n\nLooking forward to hearing about ${topic}.` : '';
      const lead = pick(["That's great, thank you.", 'Thank you, that would be great.'], seed, 'sched');
      if (last === 'reschedule') {
        body = `${G}\n\nNo problem at all. ${
          windowsText
            ? `Would ${windowsText} work instead? If not, I'll take whatever is easiest for you.`
            : "Send me a couple of times that suit you and I'll make one work."
        }\n\n${S}`;
      } else if (ctx.missedProposal) {
        // they offered a time the student can no longer take: say so plainly before offering new ones
        const m = ctx.missedProposal;
        const when = m.startIso ? fmtWindow({ startIso: m.startIso }, tz) : m.raw;
        const sorry =
          m.reason === 'busy'
            ? `Thank you for suggesting ${when}. Unfortunately I have a conflict then.`
            : `I'm sorry I didn't get back to you in time for ${when}.`;
        const offer = windowsText
          ? futureWindows.length === 2
            ? `Would either of these work instead? ${windowsText}.`
            : `Would ${windowsText} work instead?`
          : 'What times work for you over the next week or so?';
        const alt = ctx.user.schedulingLink
          ? `${windowsText ? 'If not, here' : 'Here'}'s my calendar: ${ctx.user.schedulingLink}, or just send me a time and I'll make it fit.`
          : windowsText
            ? "If not, send me a time and I'll make it fit."
            : "Send me a couple and I'll make one fit.";
        body = `${G}\n\n${sorry} ${offer} ${alt}\n\n${S}`;
        claims.push({ text: `missed proposed time: ${when}`, kind: 'logistics' });
      } else if (windowsText) {
        const offer =
          futureWindows.length === 2
            ? `Would either of these work? ${windowsText}.`
            : `Would ${windowsText} work?`;
        const alt = `If ${futureWindows.length === 2 ? 'neither does' : 'not'}, send me a time and I'll make it fit.`;
        body = `${G}\n\n${lead} ${offer} ${alt}${looking}\n\n${S}`;
      } else if (ctx.user.schedulingLink) {
        body = `${G}\n\n${lead} Here's my calendar if it's easiest to grab a time: ${ctx.user.schedulingLink}\n\nIf nothing there works, just reply with a time that suits you.\n\n${S}`;
      } else {
        body = `${G}\n\n${lead} What times work for you over the next week or so? Send me a couple and I'll make one fit.\n\n${S}`;
      }
      claims.push({ text: 'proposed windows', kind: 'logistics' });
      subject = threaded ? undefined : (reSubject ?? 'Times for a quick call');
      break;
    }
    case 'reply': {
      // their words win over the parsed time: "Thursday at 3pm" is confirmed as Thursday at 3pm, even when the stored
      // time says Friday at 11am (a parser slip, an edited message); the words are read again to find the date
      const ref = ctx.thread?.lastInboundAt ? new Date(ctx.thread.lastInboundAt) : undefined;
      const proposed = (ctx.thread?.proposedTimes ?? []).map((t) => rereadTime(t, ref, tz));
      const future = proposed.filter((t) => new Date(t.startIso).getTime() > now.getTime());
      // a positive reply (or a schedule card) moves to times; a plain question does not
      const wantsTimes =
        ctx.kind === 'schedule' || /positive|scheduling/.test(ctx.thread?.lastSignal ?? '') || !asks.length;
      const parts: string[] = [];
      let confirmed = false;
      let offeredTimes = false;
      // a meeting with them already on the calendar is the answer, not a reason to propose new times
      const withThem = (ctx.busy ?? []).filter((b) => b.withPerson && b.status !== 'cancelled');
      const isBooked = (iso: string) =>
        withThem.some(
          (b) => Math.abs(new Date(b.startIso).getTime() - new Date(iso).getTime()) < 30 * 60_000,
        );
      const booked =
        ctx.chat?.upcomingAt && new Date(ctx.chat.upcomingAt).getTime() > now.getTime()
          ? ctx.chat.upcomingAt
          : undefined;
      const unreadable = proposed.find((t) => t.unreadable);
      const free = future.find(
        (t) =>
          !t.unreadable &&
          !overlapsBusy(
            t.startIso,
            30,
            (ctx.busy ?? []).filter((b) => !b.withPerson),
          ),
      );
      if (booked && !future.some((t) => !isBooked(t.startIso))) {
        parts.push(
          // only that the meeting is on the calendar is known, not who sent the invite
          `I have us down for ${fmtWindow({ startIso: booked }, tz)} ${tzAbbr(tz, new Date(booked))}.`,
        );
        claims.push({ text: `meeting on the calendar ${booked}`, kind: 'logistics' });
        confirmed = true;
      } else if (free) {
        parts.push(
          `${fmtWindow(free, tz)} ${tzAbbr(tz, new Date(free.startIso))} works. I'll send a calendar invite with a video link; if you'd rather do a phone call, just say so.`,
        );
        claims.push({ text: `accepting ${free.raw}`, kind: 'logistics' });
        if (free.reread)
          claims.push({
            text: `"${free.raw}" read from their words, not the stored time`,
            kind: 'logistics',
          });
        confirmed = true;
      } else if (unreadable) {
        // the stored time contradicts their words and the words cannot be dated: confirm exactly what they wrote
        parts.push(
          `${cap1(strip(unreadable.raw))} works. I'll send a calendar invite with a video link; if you'd rather do a phone call, just say so.`,
        );
        claims.push({ text: `accepting "${unreadable.raw}" as written`, kind: 'logistics' });
        confirmed = true;
      } else if (booking) {
        // their booking link beats the student's own windows
        parts.push(
          pick(
            [
              "Thank you, I'll book a time through your link today.",
              "Thanks so much. I'll grab a slot through your link today.",
            ],
            seed,
            'reply-book',
          ),
        );
        claims.push({ text: 'booking through their link', kind: 'logistics' });
        confirmed = true;
      } else if (proposed.length) {
        const t = future[0] ?? proposed[0]!;
        const lead = future.length
          ? `${fmtWindow(t, tz)} is tight for me, sorry.`
          : `Sorry for the slow reply; ${fmtWindow(t, tz)} has already passed.`;
        parts.push(
          windowsText
            ? `${lead} Could you do ${windowsText} instead?`
            : `${lead} Could you send me another time that works?`,
        );
        claims.push({ text: `counter-proposing instead of ${t.raw}`, kind: 'logistics' });
        offeredTimes = true;
      } else if (ctx.thread?.lastSignal === 'reschedule') {
        parts.push(
          windowsText
            ? `No problem at all. Would ${windowsText} work instead? Even 15 minutes is plenty.`
            : "No problem at all. Send me a time that's easier and I'll make it fit; even 15 minutes is plenty.",
        );
        offeredTimes = true;
      } else if (wantsTimes && asks.length) {
        parts.push(pick(["That's great, thank you.", 'Thank you, that would be great.'], seed, 'sched'));
      } else {
        parts.push(pick(['Thanks for getting back to me.', 'Thank you for the reply.'], seed, 'reply-open'));
      }
      const questions: string[] = [];
      for (const a of asks) {
        if (RESUME_ASK.test(a)) {
          // the resume goes with this reply, not "over today": the student attaches it (a reminder, not a line)
          const what = a.match(RESUME_ASK)![1]!.toLowerCase();
          const doc = what === 'cv' ? 'CV' : what;
          parts.push(pick([`I've attached my ${doc}.`, `My ${doc} is attached.`], seed, 'reply-resume'));
          if (!needsInput.includes('resume')) needsInput.push('resume');
          claims.push({ text: `answers: ${a}`, kind: 'logistics' });
        } else if (TIMES_ASK.test(a) && (!QUESTION_START.test(a) || /\b(work|free|available)\b/i.test(a))) {
          if (!confirmed && !offeredTimes) {
            parts.push(
              windowsText
                ? `Would either of these work for a quick call? ${windowsText}. If neither does, send me a time and I'll make it fit.`
                : ctx.user.schedulingLink
                  ? `Here's my calendar if it's easiest to grab a time: ${ctx.user.schedulingLink}`
                  : 'What times work for you over the next week or so?',
            );
            offeredTimes = true;
          }
        } else questions.push(a.replace(/[.?]+$/, ''));
      }
      if (questions.length) {
        if (ctx.answer?.trim()) parts.push(answerLine(questions[0]!, ctx.answer));
        else {
          parts.push(`[Your answer to: ${questions.join('? ')}?]`);
          needsInput.push('answer');
        }
      }
      if (!confirmed && !offeredTimes && wantsTimes) {
        parts.push(
          windowsText
            ? `Would either of these work for a quick call? ${windowsText}. If neither does, send me a time and I'll make it fit.`
            : ctx.user.schedulingLink
              ? `Here's my calendar if it's easiest to grab a time: ${ctx.user.schedulingLink}`
              : "What times work for you over the next week or so? Send me a couple and I'll make one fit.",
        );
      }
      const topic = subjectTopic(ctx.thread?.subject);
      body = `${G}\n\n${parts.join(' ')}${confirmed ? `\n\nLooking forward to ${topic ? `hearing about ${topic}` : 'it'}.` : ''}\n\n${S}`;
      subject = threaded ? undefined : (reSubject ?? 'Re: your note');
      break;
    }
    case 'thank_you': {
      const when = whenLabel(meetingAt, now, tz);
      const advice = fact(['advice', 'preference'], (c) => !!pointPhrase(c));
      const offer = fact(['offer'], (c) => !!offerPhrase(c));
      const hook = advice ? undefined : fact(HOOK_TYPES, (c) => !!hookProposition(c));
      const thanks = `Thank you for making time ${when ?? 'to talk'}`;
      // Only what they said is stated. What the student felt or did about it is not in the data, so the note never
      // claims it ("I'm putting it to use this week"); the student can add it in the editor.
      let line1: string;
      const point = pointPhrase(advice?.c);
      if (point) {
        line1 = pointLine(thanks, point, seed);
        cite(advice);
      } else if (hook) {
        line1 = `${thanks}. It was good to hear more about your work, especially that ${firstPart(hookProposition(hook.c)!)}.`;
        cite(hook);
      } else if (ctx.takeaway?.trim()) {
        line1 = takeawayLine(thanks, ctx.takeaway, P, seed);
        claims.push({ text: `takeaway: ${strip(ctx.takeaway)}`, kind: 'about_person' });
      } else {
        // a thank-you with nothing they said in it is the generic note the playbook forbids: ask the student
        needsInput.push('takeaway');
        line1 = `${thanks}. [One thing ${first} said that stuck with you]`;
      }
      // an offer becomes the next step, never just a thank-you for it
      let line2 = '';
      let link: string | undefined;
      const next = offer ? offerNext(offer.c, ctx, 'thanks') : undefined;
      if (next) {
        line2 = ` ${next.text}`;
        if (next.resume && !needsInput.includes('resume')) needsInput.push('resume');
        link = next.link;
        cite(offer);
      }
      // a promise made in the conversation ("I will send my resume by Friday") is kept in the same note, and a resume
      // promised is attached to it rather than promised again
      const promise = (ctx.promises ?? []).map(promiseLine).find(Boolean);
      let line3 = '';
      if (promise) {
        claims.push({ text: `promise: ${promise}`, kind: 'logistics' });
        const attached = attachPromise(promise);
        if (attached) {
          if (!next?.resume) {
            line3 = ` ${attached}`;
            if (!needsInput.includes('resume')) needsInput.push('resume');
          } else {
            const rest = attached.match(/, and (I'll .*)$/)?.[1];
            line3 = rest ? ` As promised, ${rest}` : '';
          }
        } else line3 = ` ${promise}`;
      }
      const closers = [
        "I'll let you know how recruiting goes. Would it be alright to send a question your way if one comes up?",
        ...(/^thank/i.test(S.trim())
          ? [
              "I'll keep you posted on how recruiting goes. I really appreciate the time, and I hope it's alright to send a question your way if one comes up.",
            ]
          : [
              "I'll keep you posted on how recruiting goes. Thanks again for being so generous with your time.",
            ]),
      ];
      body = `${G}\n\n${line1}${line2}${line3}\n\n${pick(closers, seed, 'ty-close')}${link ? `\n\n${link}` : ''}\n\n${S}`;
      subject = threaded
        ? undefined
        : when
          ? `Thank you for ${when.replace(/^on /, '')}`
          : `Thank you, ${first}`;
      break;
    }
    case 'nurture': {
      if (ctx.reengage) {
        // they said "not this quarter": one short second try that quotes nothing but what they said
        const re = ctx.reengage;
        const when = sinceLabel(re.at, now, tz);
        claims.push({ text: `${first} said not ${re.said}`, kind: 'shared' });
        body = `${G}\n\nWhen we emailed${when ? ` ${when}` : ''}, you mentioned ${re.past}, so I wanted to try once more. ${
          formal
            ? `Would you have ${minutes} minutes in the next few weeks? I completely understand if it is still a busy stretch.`
            : `Would you have ${minutes} minutes sometime in the next few weeks? Completely understand if it's still a busy stretch, and thanks either way.`
        }\n\n${S}`;
        subject = threaded ? undefined : (reSubject ?? `${school} ${yl}, trying once more`);
        break;
      }
      const firm = firmKindOf({ title: P.title, org, industry: P.orgIndustry }, sector);
      const o = shortOrg(org);
      // writing again after their last message went quiet (a sign-off, a thanks, weeks ago) names the conversation and
      // gives a reason to write now, not only "Quick update"
      const t = ctx.thread;
      const reopen =
        !!ctx.reopen ||
        (!!t?.lastInboundAt &&
          !inboundNeedsAnswer(t, now) &&
          now.getTime() - new Date(t.lastInboundAt).getTime() > 21 * 86_400_000);
      // a live deal or a fundraise is never asked about in writing
      const hook = fact(['hook'], (c) => !!hookProposition(c) && !isConfidential(c.text, firm));
      const offer = fact(['offer'], (c) => !!offerNext(c, ctx, 'nurture'));
      const since = sinceLabel(meetingAt ?? (reopen ? ctx.thread?.lastInboundAt : undefined), now, tz);
      const talked = !!meetingAt;
      const topic = subjectTopic(ctx.thread?.subject);
      const tc =
        ctx.targetCompany && org && normalizeCompany(ctx.targetCompany.name) === normalizeCompany(org)
          ? ctx.targetCompany
          : undefined;
      const intern = isInternCycle(ctx.user.cycleLabel);
      // the student's own update first; writing again after a sign-off can say what is on record instead (they
      // have applied, or plan to apply, to the person's company; they are recruiting this cycle)
      const typed = ctx.update?.trim() ? softLower(strip(ctx.update)) : undefined;
      const roleText = tc?.roleLabel
        ? roleWords(tc.roleLabel)
        : `${fnLabel} ${intern ? 'internship' : 'role'}`;
      // an application to their company is on record and is news to them; "recruiting this cycle" is enough only
      // when picking a quiet thread back up
      const derived = tc
        ? tc.applied
          ? `I've applied for ${o ? `${possessive(o)} ` : 'the '}${roleText}`
          : `I'm planning to apply for ${o ? `${possessive(o)} ` : 'the '}${roleText} this cycle`
        : reopen
          ? `I'm recruiting for ${lookingForPhrase(ctx)} this cycle`
          : undefined;
      const update = typed ?? derived;
      // their news is the reason to write: a new role comes first
      const na = ctx.newAffiliation;
      const naTitle = na?.title?.replace(/\s*[,(].*$/, '').trim();
      const knew = !!meetingAt && !!na?.since && new Date(meetingAt).getTime() > new Date(na.since).getTime();
      if (!update && !hook && !offer && !(na?.org && naTitle && !knew)) needsInput.push('update');
      const parts: string[] = [];
      let congrats = false;
      // they talked after the change: the student knew, so it is not news ("Hope the new role ..." instead)
      const knewIt =
        !!meetingAt && !!na?.since && new Date(meetingAt).getTime() > new Date(na.since).getTime();
      if (na?.org && naTitle && !knewIt) {
        parts.push(
          `I saw you're now ${article(naTitle)} ${naTitle} at ${shortOrg(na.org)}. Congratulations, that's great to see.`,
        );
        claims.push({ text: `new role: ${na.title} at ${na.org}`, kind: 'about_person' });
        congrats = true;
      }
      // the update stands on its own: the note never claims it happened because of their advice, which Orbit
      // does not know
      if (reopen && askedForUpdate(ctx.thread?.lastInboundBody) && update)
        parts.push(`You asked me to keep you posted, so here's an update: ${update}.`);
      else if (reopen) {
        parts.push(
          `Thanks again for ${talked ? 'talking with me' : 'your help'}${since ? ` ${since}` : ''}${topic ? ` about ${topic}` : ''}.${
            update ? ` ${cap1(update)}.` : ' [One real update since then.]'
          }`,
        );
        if (topic) claims.push({ text: `the thread was about ${topic}`, kind: 'shared' });
      } else if (update) parts.push(`Quick update${since ? ` since we talked ${since}` : ''}: ${update}.`);
      else if (!hook && !offer && !congrats)
        parts.push(
          `Quick update${since ? ` since we talked ${since}` : ''}: [one real update${since ? '' : talked ? ` since you last spoke with ${first}` : ` to share with ${first}`}].`,
        );
      // an open offer is taken up, not left in the notes
      const next = offer ? offerNext(offer.c, ctx, 'nurture') : undefined;
      if (next) {
        parts.push(next.text);
        if (next.resume && !needsInput.includes('resume')) needsInput.push('resume');
        cite(offer);
      }
      // one line about them, as a wish: "No reply needed" never follows a question. A note from after the
      // conversation is something the student saw, not something they said.
      if (hook) {
        const prop = hookProposition(hook.c)!;
        const tense = hookTense(prop, now);
        const wish =
          tense === 'future'
            ? "Hope that's shaping up well."
            : tense === 'ongoing'
              ? "Hope it's going well."
              : 'Hope it went well.';
        // only a note that says they said it ("Alina mentioned ...") is put in their mouth
        const saidThen = /\b(said|mentioned|told)\b/i.test(hook.fact.text);
        parts.push(
          `${saidThen ? 'You mentioned' : parts.length ? 'I also saw that' : 'I saw that'} ${prop}. ${wish}`,
        );
        cite(hook);
      }
      // a reason to write again after months (their company is on the student's list) earns one small ask
      const ask =
        reopen && tc && !next && !isFriend(P)
          ? `Would you have ${minutes} minutes in the next couple of weeks to tell me what ${o ?? 'the team'} looks for in ${intern ? 'interns' : 'new grads'}? Happy to do it over email if that's easier.`
          : undefined;
      const newRole = na?.title ? roleNoun(na.title) : undefined;
      if (!hook && !congrats && !next && !ask && na?.org && newRole && knewIt && !na.observed)
        parts.push(`Hope the new role as ${article(newRole)} ${newRole} is going well.`);
      else if (!hook && !congrats && !next && !ask && o) parts.push(`Hope things are going well at ${o}.`);
      const close =
        ask ??
        (next && /\?$/.test(next.text)
          ? undefined
          : congrats
            ? 'No need to reply, I just wanted to say congratulations.'
            : 'No reply needed, just wanted to stay in touch.');
      body = `${G}\n\n${parts.join(' ')}${close ? `\n\n${close}` : ''}\n\n${S}`;
      subject = threaded
        ? undefined
        : congrats
          ? `Congratulations on the new role`
          : since?.startsWith('in ')
            ? `Quick update since ${since.slice(3)}`
            : `Quick update from ${school || ctx.user.firstName}`;
      break;
    }
    case 'congratulate': {
      const na = ctx.newAffiliation;
      const news = ctx.news?.trim();
      let what: string | undefined;
      // "Anthropic" to "Anthropic PBC" is the same employer (a promotion), not a move
      const sameOrg =
        !!na?.org && !!na.previousOrg && normalizeCompany(na.org) === normalizeCompany(na.previousOrg);
      const newRole = na?.title ? roleNoun(na.title) : undefined;
      // the employer they left, when it is on record, makes the line about them rather than about any new hire
      const from =
        !sameOrg &&
        (na?.previousOrg ?? P.previousOrg)?.trim() &&
        normalizeCompany((na?.previousOrg ?? P.previousOrg)!) !== normalizeCompany(na?.org ?? '')
          ? ` from ${(na?.previousOrg ?? P.previousOrg)!.trim()}`
          : '';
      if (na?.org && newRole && sameOrg) {
        const name = [na.org.trim(), na.previousOrg!.trim()].sort((a, b) => a.length - b.length)[0];
        what = `your new role as ${article(newRole)} ${newRole} at ${name}`;
      } else if (na?.org && newRole)
        what = `your move${from} to ${shortOrg(na.org)} as ${article(newRole)} ${newRole}`;
      else if (na?.org && !sameOrg) what = `your move${from} to ${shortOrg(na.org)}`;
      else if (newRole) what = `your new role as ${article(newRole)} ${newRole}`;
      else if (news) what = softLower(strip(news).replace(/^(congratulations|congrats) on\s+/i, ''));
      if (!what) {
        needsInput.push('news');
        body = `${G}\n\nCongratulations on [what you are congratulating ${first} on, e.g. a promotion or a launch].${org ? ` Hope things are going well at ${shortOrg(org)}.` : ''}\n\n${S}`;
        subject = threaded ? undefined : 'Congratulations';
        break;
      }
      claims.push({ text: `news: ${what}`, kind: 'about_person' });
      const tie = fact(
        ['preference', 'advice'],
        (c) => c.you && /^(wanted|wants|hoped|hopes|planned|plans|said)$/.test(c.verb ?? ''),
      );
      const recent =
        !!na?.since && !na.observed && now.getTime() - new Date(na.since).getTime() < 60 * 86_400_000;
      const tieLine = tie
        ? ` I remember ${tie.c.text.replace(/^you /, 'you saying you ')}, so this sounds like a great fit.`
        : '';
      if (tie) cite(tie);
      // "well deserved" is for someone the student knows; from a stranger it is presumptuous
      const knows = !!meetingAt || isFriend(P) || P.strength >= 0.35 || !!ctx.history?.repliedEver;
      // "just saw the news" only when it is news: not when they have talked since it happened, and not for a change
      // Orbit only noticed on an import
      const talkedSince =
        !!meetingAt && !!na?.since && new Date(meetingAt).getTime() > new Date(na.since).getTime();
      // news the student typed is news they just saw
      const fresh = (recent && !talkedSince) || (!na?.org && !newRole && !!news);
      const lead = fresh ? `Just saw the news about ${what}. Congratulations` : `Congratulations on ${what}`;
      body = `${G}\n\n${lead}${tie || !knows ? '.' : ', well deserved.'}${tieLine}${recent && !talkedSince ? ' Hope the first few weeks are going well.' : ''}\n\n${S}`;
      subject = threaded
        ? undefined
        : na?.org && !sameOrg && what.startsWith('your move')
          ? `Congratulations on the move to ${shortOrg(na.org)}`
          : 'Congratulations';
      break;
    }
    case 'referral_ask': {
      const tc = ctx.targetCompany;
      const company = tc?.name ?? org;
      if (!company) {
        needsInput.push('role');
        body = `${G}\n\n[The role and company you are applying to]\n\n${S}`;
        subject = threaded ? undefined : 'A small ask';
        break;
      }
      const co = shortOrg(company)!;
      const firm = firmKindOf({ title: P.title, org: company, industry: P.orgIndustry }, sector);
      // only an offer to refer (or to pass the resume along) is a reason to ask for one; a practice case or a memo
      // template they offered is not recast as a referral offer
      const offer = fact(
        ['offer'],
        (c) =>
          c.you &&
          /\b(refer|referral|pass (along )?my (resume|name|application)|flag|put in a (good )?word|put my name in|forward my (resume|application)|submit my name|recommend me)\b/i.test(
            c.text,
          ),
      );
      // an intro they offered is the ask, not a referral they never offered
      const introOffer = offer
        ? undefined
        : fact(['offer'], (c) => c.you && /\b(introduce me|connect me|put me in touch)\b/i.test(c.text));
      const label = tc?.roleLabel?.trim();
      // no role on record: the student says which (Orbit never assumes one), and the prompt asks whether the role is
      // one this person's side of the firm hires for at all
      if (!label) needsInput.push('role');
      const fits = functionFits(functionFor(P.title, ctx.user.targetFunctions), P.title, firm);
      const role = label
        ? /\b(role|internship|position|program|programme|req)$/i.test(label)
          ? label
          : `${label} role`
        : fits
          ? '[role you are applying for]'
          : `[role at ${co}, if it is one ${first}'s part of the firm hires for; if not, a check-in fits better than a referral ask]`;
      const req = tc?.reqId
        ? ` (req ${tc.reqId}${tc.link ? ', link below' : ''})`
        : tc?.link
          ? ' (link below)'
          : '';
      const spoke = ctx.chat?.completedAt || ctx.chat?.meetingAt;
      const when = spoke ? whenLabel(meetingAt, now, tz) : undefined;
      const otherCompany = !!org && normalizeCompany(company) !== normalizeCompany(org);
      const applied = !!tc?.applied;
      const applyLine = applied
        ? `I've applied for the ${role} at ${co}${req}.`
        : `I'm applying for the ${role} at ${co}${req}.`;
      const friend = isFriend(P);
      if (!spoke && !offer && !introOffer) {
        if (!friend) {
          // No conversation yet: a referral ask (even one dressed as a process question) is the wrong first message.
          // It is the conversation ask, with the application as one clause of context.
          const out = generateDraft({
            ...ctx,
            kind: 'outreach',
            applicationLine: applied
              ? `I've applied for ${possessive(co)} ${label ? roleWords(label) : 'internship'}${tc?.reqId ? ` (req ${tc.reqId})` : ''}.`
              : undefined,
          });
          return { ...out, kind: 'outreach' };
        }
        // a friend gets a direct, gracious ask, never a coy process question
        claims.push({ text: `${first} knows the student personally`, kind: 'shared' });
        body = `${G}\n\n${applyLine} Would you be comfortable referring me, or flagging my application to the recruiting team? I've attached my resume. Totally fine if not, I know it puts your name on it.${tc?.link ? `\n\n${tc.link}` : ''}\n\n${S}`;
        if (!needsInput.includes('resume')) needsInput.push('resume');
        subject = `${co} ${label ? role : 'application'}, a small ask`;
        break;
      }
      let open: string;
      if (offer) {
        const t = reported(theirWords(offer.c.text).replace(/^you offered\b/, 'you kindly offered'));
        open = `When we spoke${when ? ` ${when}` : ''}, ${t}, so I wanted to follow up.`;
        cite(offer);
      } else if (introOffer) {
        const t = reported(theirWords(introOffer.c.text).replace(/^you offered\b/, 'you kindly offered'));
        open = `When we spoke${when ? ` ${when}` : ''}, ${t}. I'd love to take you up on that.`;
        cite(introOffer);
      } else open = `Thanks again for the conversation${when ? ` ${when}` : ''}.`;
      // a different function at a tech company (a designer, for an engineering role) passes the name along; they
      // do not refer into a team they are not on
      const theirFn = titleFunction(P.title);
      const roleFn = titleFunction(label);
      const crossFn = sector === 'tech' && !!theirFn && !!roleFn && theirFn !== roleFn && theirFn !== 'swe';
      let askLine: string;
      if (introOffer) askLine = 'I can send a two-line blurb and my resume so the intro takes you no time.';
      else if (otherCompany)
        askLine = `I know you're at ${shortOrg(org)}, but if you know anyone at ${co} who'd be comfortable flagging my application, an intro would mean a lot.`;
      else if (offer)
        askLine =
          sector === 'tech' && !crossFn
            ? applied
              ? "I've attached my resume so adding the referral takes two minutes."
              : "I've attached my resume so the referral takes two minutes before I submit through the portal."
            : "I've attached my resume so it's easy to pass along.";
      else if (crossFn)
        askLine = `If you'd be comfortable passing my name to the recruiter or the hiring manager for the role, I'd be grateful. I've attached my resume.`;
      else if (sector === 'tech')
        askLine = applied
          ? "Would you be willing to add a referral for my application? I've attached my resume."
          : "Would you be willing to refer me before I submit through the portal? I've attached my resume.";
      else
        askLine = `If you'd be comfortable flagging my name to the recruiting team, I'd be grateful. I've attached my resume.`;
      if (!introOffer && !needsInput.includes('resume')) needsInput.push('resume');
      // they asked for the posting ("send me the posting"): it goes in, or the student is asked for it, with the
      // team when they made picking one the condition
      const said = `${offer?.fact.text ?? ''} ${ctx.thread?.lastInboundBody ?? ''}`;
      const wantsPosting =
        !tc?.link &&
        /\b(send|share|forward|pass)\b[^.?!]{0,40}\b(posting|job (link|id|description)|req(uisition)?|link to the (role|job))\b/i.test(
          said,
        );
      const wantsTeam = /\b(picked|chosen|choose|pick|decided on)\b[^.?!]{0,15}\bteam\b/i.test(said);
      if (wantsPosting) needsInput.push('posting');
      // an offer is not hedged ("completely fine if not" to someone who offered reads as not having listened)
      const out = offer || introOffer ? '' : ' Completely fine if not.';
      body = `${G}\n\n${open} ${applyLine} ${askLine}${out}${wantsPosting ? `\n\n[${wantsTeam ? 'the team you picked, and the ' : ''}link to the posting]` : ''}\n\n${S}`;
      subject = !label
        ? `${co}, a small ask`
        : applied
          ? `Quick update + applied to ${co} ${role}`
          : `${co} ${role}, a small ask`;
      if (tc?.link) body = body.replace(`\n\n${S}`, `\n\n${tc.link}\n\n${S}`);
      break;
    }
    case 'intro_request': {
      const t = ctx.target;
      if (!t?.name) {
        needsInput.push('target');
        body = `${G}\n\nSmall ask. I'm hoping to talk with [who you would like ${first} to introduce you to, and what you'd like to learn from them]. If you'd be comfortable making a short intro, I can send a two-line note you could forward.\n\nAnd if it's not a good fit to ask, no worries at all.\n\n${S}`;
        subject = threaded ? undefined : 'A small ask';
        break;
      }
      const tFirst = t.firstName ?? t.name.split(' ')[0]!;
      const tRole = roleNoun(t.title);
      const tOrg = shortOrg(t.org);
      const desc = tRole
        ? `, ${article(t.title!)} ${t.title}${tOrg ? ` at ${tOrg}` : ''}`
        : tOrg
          ? ` at ${tOrg}`
          : '';
      // the credibility line goes in the blurb only when it means something to the target (an engineer, a founder)
      const targetSector = sectorOf({ title: t.title, org: t.org }, ctx.user.targetFunctions);
      const credFits =
        !!ctx.user.credibility &&
        targetSector === 'tech' &&
        /\b(engineer|engineering|developer|cto|founder|product)\b/i.test(t.title ?? '');
      const cred = credFits
        ? ` ${ctx.user.firstName} ${softLower(strip(ctx.user.credibility!))}, and`
        : ` ${ctx.user.firstName}`;
      const link =
        ctx.connection?.kind === 'shared_employer' && ctx.connection.sharedOrg
          ? ` I noticed you two worked together at ${ctx.connection.sharedOrg}.`
          : '';
      const intern = isInternCycle(ctx.user.cycleLabel);
      // the topic is said once, in the blurb, with the target's name ("Lucas's move from coverage into the sponsors
      // group", "how Lucas chose the healthcare practice"); the note to the connector only asks
      const blurbTopic = t.why
        ? strip(t.why)
            .replace(/\btheir\b/, `${tFirst}'s`)
            .replace(/\bthey\b/, tFirst)
            .replace(/\bthem\b/, tFirst)
        : tRole
          ? `${tFirst}'s path to ${tRole}${tOrg ? ` at ${tOrg}` : ''}`
          : `${tFirst}'s work${tOrg ? ` at ${tOrg}` : ''}`;
      const blurb = `"${ctx.user.fullName} is ${me}, recruiting for ${fnLabel} ${intern ? 'internships' : 'roles'}.${cred} would love 15 minutes to hear about ${blurbTopic}."`;
      body = `${G}\n\nSmall ask. Would you be comfortable introducing me to ${t.name}${desc}?${link} If so, here's a short note you could forward:\n\n${blurb}\n\nAnd if it's not a good fit to ask, no worries at all.\n\n${S}`;
      claims.push({ text: `target: ${t.name}`, kind: 'logistics' });
      subject = threaded ? undefined : `Small ask: intro to ${t.name}?`;
      if (t.offered) {
        // following up on an intro they offered: name the offer, make forwarding a two-second task
        const offerBlurb = `"${ctx.user.fullName} is ${me}, recruiting for ${fnLabel} ${intern ? 'internships' : 'roles'}.${cred} would love 15 minutes to hear about ${t.why ? blurbTopic : `${tFirst}'s work${tOrg ? ` at ${tOrg}` : ''}`}."`;
        body = `${G}\n\nWhen we spoke, you kindly offered to introduce me to ${t.name}. If that's still easy, here's a short note you could forward so it takes no time:\n\n${offerBlurb}\n\nAnd if the timing isn't right anymore, no worries at all. Thanks again for offering.\n\n${S}`;
        subject = threaded || ctx.thread ? undefined : `Intro to ${t.name}`;
      }
      break;
    }
    case 'report_back': {
      const rb = ctx.reportBack;
      const tName = rb?.targetName ?? 'them';
      const tFirst = tName.split(' ')[0]!;
      const line = rb?.line ? ` ${cap1(strip(rb.line))}.` : '';
      // the introducer is never told "I haven't heard back": that asks them to chase a colleague. The student wrote
      // to the person; the outcome is reported once there is one.
      const outcome =
        rb?.outcome === 'spoke'
          ? `We spoke ${rb?.when ?? 'last week'}.${line}`
          : rb?.outcome === 'declined'
            ? "The timing didn't work out this cycle, which is completely fair."
            : `I've followed up${rb?.when ? ` ${rb.when}` : ''} and will let you know how it goes.`;
      // "making it happen" only when it did happen
      const thanks =
        rb?.outcome === 'spoke'
          ? 'Really appreciate you making it happen'
          : 'I really appreciate you making the intro';
      body = `${G}\n\nThanks again for connecting me with ${tFirst}. ${outcome} ${thanks}, and I'll keep you posted on how recruiting goes.\n\n${S}`;
      claims.push({ text: `report back on ${tName}`, kind: 'logistics' });
      subject = threaded ? undefined : `Thank you for the intro to ${tFirst}`;
      break;
    }
  }
  if (subject && BANNED_SUBJECT_PATTERNS.some((re) => re.test(subject!)))
    subject = `${school ? `${school} ${yl}, ` : ''}question about ${org ?? 'your path'}`;
  if (ctx.channel === 'linkedin' && ctx.kind !== 'outreach') subject = undefined;
  let finalBody = body.replace(/[ \t]+\n/g, '\n').trim();
  // a "Dear" letter is written without contractions throughout, never "Dear Grace, I'm ..."; so is everything from a
  // student whose own sent mail has none (a learned card), but not a preset to a friend
  if ((ctx.styleCard.builtFromCount > 0 && ctx.styleCard.contractions === false) || /^Dear\b/.test(finalBody))
    finalBody = expandContractions(finalBody);
  return {
    subject,
    body: finalBody,
    bodyShort,
    claims,
    needsInput,
    opening: firstSentence(finalBody),
    sector,
    register,
    kind,
    introReply,
  };
}

/**
 * The student's answer to their question with a lead-in, so a bare fragment ("Mostly healthcare and operations work,
 * since ...") does not read like a form field: "As for teams, mostly healthcare and operations work, since ...".
 */
function answerLine(question: string, answer: string): string {
  const a = strip(answer);
  const noun = question.match(
    /\b(?:which|what)\s+(?:kinds? of\s+|types? of\s+)?([a-z]+(?:\s+[a-z]+)?)\b/i,
  )?.[1];
  const full = /^(I|I'm|I've|I'd|My|We)\b/.test(a);
  if (!noun || /^(are|is|do|does|would|could|you|time|times)\b/i.test(noun) || /^(as for|on|for)\b/i.test(a))
    return `${cap1(a)}.`;
  const what = noun.split(' ')[0]!.toLowerCase();
  // "As for teams, ..." for a plural noun; anything else reads better without a lead-in
  if (!/[^s]s$/.test(what)) return `${cap1(a)}.`;
  return `As for ${what}, ${full ? a : lower1(a)}.`;
}

/** A role label as words in a sentence: "Software Engineering Intern" is "software engineering internship". */
function roleWords(label: string): string {
  const l = lowerPhrase(label.trim()).replace(/\bintern$/, 'internship');
  return /\b(internship|role|program|programme|position)$/.test(l) ? l : `${l} role`;
}

/**
 * What the student does with an offer the person made: the next step, never only "thanks also for offering ...". A
 * practice case is taken up with a time, an intro with a blurb, a template or a pointer with a plain "I'd love
 * that", a resume to pass along is attached, and a referral promised "when the posting goes up" gets the posting
 * once it is on record (`resume`: the note says the resume is attached, so the student attaches it).
 */
function offerNext(
  c: FactClause,
  ctx: DraftContext,
  mode: 'thanks' | 'nurture',
): { text: string; resume?: boolean; link?: string } | undefined {
  if (!c.you || !c.rest) return undefined;
  const v = (c.verb ?? '').toLowerCase();
  if (!/^(offered|volunteered|agreed|promised)$/.test(v) && !(v === 'said' && /^you'd be /.test(c.rest)))
    return undefined;
  const r = theirWords(reported(c.rest.replace(/^(to|you'd be happy to|you'd be glad to)\s+/i, '')));
  const lead =
    mode === 'thanks' ? `Thanks also for offering to ${r}.` : `When we spoke, you offered to ${r}.`;
  const org = ctx.person.org;
  const tc =
    ctx.targetCompany && (!org || normalizeCompany(ctx.targetCompany.name) === normalizeCompany(org))
      ? ctx.targetCompany
      : undefined;
  if (
    /\b(refer me|referral|(pass|forward|send|share|submit|put)\s+(along\s+)?my (resume|name|application))\b/i.test(
      r,
    )
  ) {
    const later = /\b(when|once|after|as soon as)\b.*\b(posting|role|req|opening|application|team)\b/i.test(
      r,
    );
    if (later && !tc?.applied && !tc?.link)
      // nothing to act on yet: the posting is not up, or the student has not picked the team
      return { text: `${lead} I'll send the posting as soon as it's live.` };
    const posting = tc?.link ? ', along with the posting (link below)' : '';
    return {
      text: `${lead} I've attached my resume${posting} so it's easy to pass along${mode === 'nurture' ? ' if the offer still stands' : ''}.`,
      resume: true,
      link: tc?.link,
    };
  }
  if (/^introduce me\b|^connect me\b|^put me in touch\b/i.test(r))
    return {
      text: `${lead} I'd love to take you up on that, and I can send a two-line blurb to make it easy.`,
    };
  if (/\b(practice|mock) (case|interview)s?\b|\bcase prep\b|\b(review|look over|go over) my\b/i.test(r))
    return { text: `${lead} I'd love to take you up on that. Would sometime in the next few weeks work?` };
  if (/^(share|send|show)\b/i.test(r)) return { text: `${lead} I'd love to see it whenever it's easy.` };
  if (/^(tell|let) me\b/i.test(r)) return { text: `${lead} I'd love to hear whenever you have a minute.` };
  return { text: `${lead} I'd love to take you up on that.` };
}

/**
 * A promise to send the resume, kept as an attachment: "As promised, my resume is attached." (and anything else in
 * the promise stays a promise: "..., and I'll send the marketplace project link by Friday."). Undefined when the
 * promise is not about the resume.
 */
function attachPromise(promise: string): string | undefined {
  const m = promise.match(/^As promised, I'll (.+)\.$/);
  if (!m) return undefined;
  const clauses = m[1]!.split(/,?\s+and\s+(?=(?:send|share|email|forward|introduce|connect|follow|get)\b)/i);
  const at = clauses.findIndex((c) => /^(send|share|email|forward)\b.*\bmy (resume|cv)\b/i.test(c));
  if (at < 0) return undefined;
  // "send my resume and the project link by Friday": the resume is attached, the rest is still a promise
  const objs = clauses[at]!.replace(/^(send|share|email|forward)\s+/i, '');
  const deadline = objs.match(/\s+(?:by|on|before|today|tomorrow|this|next)\b.*$/)?.[0] ?? '';
  const items = objs
    .slice(0, objs.length - deadline.length)
    .replace(/\bmy (resume|cv)\b(\s+and\s+)?/i, '')
    .replace(/\s+and\s*$/i, '')
    .trim();
  const rest = [...(items ? [`send ${items}${deadline}`] : []), ...clauses.filter((_, i) => i !== at)];
  return `As promised, my resume is attached${rest.length ? `, and I'll ${rest.join(' and ')}` : ''}.`;
}

/** "I will send my resume by Friday" -> "As promised, I'll send my resume by Friday." Undefined for anything else. */
export function promiseLine(text: string): string | undefined {
  const t = strip(text);
  const m = t.match(/^I(?: will|'ll| am going to| plan to| need to| promised to)\s+(.+)$/i);
  const rest = m
    ? m[1]!
    : /^(send|share|email|forward|introduce|connect|follow up)\b/i.test(t)
      ? lower1(t)
      : undefined;
  if (!rest || rest.split(' ').length > 22 || /\?/.test(rest)) return undefined;
  return `As promised, I'll ${rest.replace(/\b(them|him|her)\b/g, 'you')}.`;
}

/** "Thank you for making time yesterday, and especially for your advice to ..." (nothing the student did is claimed). */
function pointLine(thanks: string, phrase: string, seed: string): string {
  return pick(
    [`${thanks}, and especially for ${phrase}.`, `${thanks}. I really appreciated ${phrase}.`],
    seed,
    'ty1',
  );
}

/** Words that name someone other than the recipient: a pronoun after one of them may be theirs. */
const OTHER_PERSON =
  /^(mom|mother|dad|father|parents?|sister|brother|siblings?|cousin|aunt|uncle|wife|husband|partner|boyfriend|girlfriend|friends?|roommates?|classmates?|professors?|prof|teachers?|managers?|boss|recruiters?|coworkers?|co-workers?|colleagues?|mentors?|advisors?|advisers?|founders?|ceo|cto|director|analysts?|associates?|engineers?|interns?|interviewers?|someone|somebody|anyone|anybody|everyone|person|people|alums?|alumni|alumnus|alumna)$/i;
const NOT_A_NAME =
  /^(I|I'm|I've|I'll|I'd|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
/** After an object "her" ("email her about ..."), not a possessive one ("her team"). */
const AFTER_OBJECT =
  /^(about|to|for|with|if|whether|that|and|or|but|when|before|after|at|on|in|by|from|again|directly|a|an|the|my|some|any|this|these|those|how|what|why|where|who|so|back|up|out|once|soon|later|next|today|tomorrow|know)$/i;

/**
 * "her team" in the student's own words is "your team" in a note addressed to her, but only while nobody else is in
 * the sentence: in "email Jenna and ask about her team" the team is Jenna's, so the student's words are kept. A
 * sentence with "she" or "he" in it keeps its pronouns too, since turning half of them would mix the two people.
 */
function toSecondPerson(s: string, person: DraftContext['person']): string {
  if (/\b(she|he)(?:'[a-z]+)?\b/i.test(s)) return s;
  const own = new Set(
    [
      person.firstName,
      person.lastName,
      ...(person.fullName ?? '').split(/\s+/),
      ...(person.org ?? '').split(/\s+/),
    ]
      .filter(Boolean)
      .map((w) => w!.toLowerCase()),
  );
  const tokens = s.split(/(\s+)/);
  let other = false;
  return tokens
    .map((tok, i) => {
      if (other || /^\s*$/.test(tok)) return tok;
      const m = tok.match(/^([^A-Za-z']*)([A-Za-z][A-Za-z'-]*)(.*)$/);
      if (!m) return tok;
      const [, pre, word, post] = m as unknown as [string, string, string, string];
      const lower = word.toLowerCase();
      const bare = lower.replace(/'s$/, '');
      if (lower === 'his') return `${pre}your${post}`;
      if (lower === 'him') return `${pre}you${post}`;
      if (lower === 'hers') return `${pre}yours${post}`;
      if (lower === 'himself' || lower === 'herself') return `${pre}yourself${post}`;
      if (lower === 'her') {
        const next = tokens[i + 2]?.match(/[A-Za-z][A-Za-z'-]*/)?.[0];
        const object = !next || /[.,;:!?)]/.test(post) || AFTER_OBJECT.test(next);
        return `${pre}${object ? 'you' : 'your'}${post}`;
      }
      if (OTHER_PERSON.test(bare)) other = true;
      else if (i > 0 && /^[A-Z]/.test(word) && !NOT_A_NAME.test(word) && !own.has(bare)) other = true;
      return tok;
    })
    .join('');
}

/**
 * The thank-you's opening from the student's own takeaway, typed in the editor. Their words are addressed to the
 * person ("your advice to ...", "your advice that I should ..."); a sentence about the student that is not advice
 * ("I loved the story about Stripe") stays the student's own sentence rather than being forced into a phrase.
 */
function takeawayLine(thanks: string, raw: string, person: DraftContext['person'], seed: string): string {
  const typed = strip(raw);
  const t = typed.replace(/^that\s+/i, '');
  // "I learned that recruiting starts in August": what they said is the part after "that"
  const heard = t.match(
    /^I\s+(?:learned|realized|realised|heard|took away|now know|found out|understood)\s+that\s+(.+)$/i,
  );
  if (heard && !/^(I|I'm|I've|I'll|I'd|me|my|we|our)\b/.test(heard[1]!))
    return pointLine(thanks, takeawayPhrase(heard[1]!, person, true), seed);
  const advice = t.match(
    /^I\s+((should|shouldn't|should not|need to|needn't|must|have to|ought to|don't need to|do not need to|could|can|might)\b(?!').*)$/i,
  );
  if (advice) {
    const noun = /^(could|can|might)$/i.test(advice[2]!) ? 'point' : 'advice';
    return pointLine(thanks, `your ${noun} that I ${toSecondPerson(advice[1]!, person)}`, seed);
  }
  if (/^(my|our)\s/i.test(t))
    return pointLine(thanks, `your point that ${toSecondPerson(lower1(t), person)}`, seed);
  // the student's own sentence follows the same thanks the other forms open with, so the note is not shorter
  if (/^(I|I'm|I've|I'll|I'd|me|we|we're)\b/i.test(t))
    return `${pointLine(thanks, 'everything you shared', seed)} ${cap1(toSecondPerson(t, person))}.`;
  return pointLine(thanks, takeawayPhrase(t, person, /^that\s/i.test(typed)), seed);
}

/** A takeaway about the person as a phrase addressed to them ("your advice to ..."); `isClause` after a typed "that". */
function takeawayPhrase(t: string, person: DraftContext['person'], isClause = false): string {
  const c = clause(t, person);
  let phrase: string | undefined;
  if (c?.you) {
    phrase = pointPhrase(c);
    if (!phrase && hookProposition(c)) phrase = `telling me that ${firstPart(hookProposition(c)!)}`;
  }
  if (!phrase && c && /^your (point|advice|idea|line|comment|suggestion|story|take)\b/.test(c.text))
    phrase = c.text;
  if (!phrase && /^to\s/i.test(t)) phrase = `your advice ${lower1(t)}`;
  if (!phrase && isClause) phrase = `your point that ${softLower(t)}`;
  if (!phrase) phrase = `what you said about ${softLower(t.replace(/^about\s+/i, ''))}`;
  return phrase;
}

/** One short clause for the LinkedIn note, from the connection. */
function shortConnection(ctx: DraftContext, c: Connection): string {
  const org = shortOrg(ctx.person.org);
  switch (c.kind) {
    case 'met': {
      const when = c.lastAt ? sinceLabel(c.lastAt, ctx.now ?? new Date(), ctx.user.timezone) : undefined;
      return `Thanks again for talking with me${when ? ` ${when}` : ''}.`;
    }
    case 'prior_thread':
      return reconnectLine(ctx, c, ctx.now ?? new Date()).replace(/, and (sorry|I wanted).*\.$/, '.');
    case 'referral':
      return c.introduced
        ? `${c.referrerName ?? 'Our mutual contact'} introduced us by email.`
        : `${c.referrerName ?? 'A mutual contact'} suggested I write to you.`;
    case 'event':
      return c.eventName ? `I was at the ${c.eventName.replace(/^the\s+/i, '')}.` : `${cap1(c.text)}.`;
    case 'alumni':
      // the note already opens with "{school} {year} here", so the school is not named again
      return `Saw you're an alum too${org ? `, now at ${org}` : ''}.`;
    case 'transition':
      return `Saw you went from ${c.previous} to ${org ?? 'your current role'}, which is the path I'm trying to understand.`;
    case 'shared_employer':
      return `We overlap on ${c.sharedOrg}; I interned there.`;
    case 'post':
    case 'warmup':
      return `Read your post ${postPhrase(c.text)}.`;
    case 'hook':
      return `Saw that ${c.text}.`;
    case 'user_supplied':
      return `${studentSentence(nameMutual(c.text, ctx.mutualName).text)}.`;
  }
}

/**
 * Everything a draft is allowed to mention, as plain text, for the validator's fabrication check: the context pack
 * plus the derived labels the templates use (short school name, function label, cycle phrase, formatted windows).
 */
export function contextText(ctx: DraftContext): string {
  const now = ctx.now ?? new Date();
  const tz = ctx.user.timezone;
  const windows = (ctx.proposedWindows ?? []).map(
    (w) => `${fmtWindow(w, tz)} ${tzAbbr(tz, new Date(w.startIso))}`,
  );
  const ref = ctx.thread?.lastInboundAt ? new Date(ctx.thread.lastInboundAt) : undefined;
  const proposed = (ctx.thread?.proposedTimes ?? [])
    .flatMap((w) => [w, rereadTime(w, ref, tz)])
    .map((w) => `${w.raw} ${fmtWindow(w, tz)} ${tzAbbr(tz, new Date(w.startIso))}`);
  return [
    JSON.stringify({
      ...ctx,
      styleCard: { greetingPatterns: ctx.styleCard.greetingPatterns, signoffs: ctx.styleCard.signoffs },
    }),
    schoolShort(ctx.user.school),
    // firms as their people write them ("BCG", "a16z", "Lightspeed")
    ...[
      ctx.person.org,
      ctx.person.previousOrg,
      ctx.targetCompany?.name,
      ctx.newAffiliation?.org,
      ctx.target?.org,
    ]
      .map((o) => shortOrg(o) ?? '')
      .filter(Boolean),
    targetLabel(ctx),
    cyclePhrase(ctx.user.cycleLabel),
    yearLabel(ctx.user.gradYear, ctx.user.degree, now),
    classYear(ctx.user.gradYear),
    ...windows,
    ...proposed,
    ctx.chat?.upcomingAt
      ? `${fmtWindow({ startIso: ctx.chat.upcomingAt }, tz)} ${tzAbbr(tz, new Date(ctx.chat.upcomingAt))}`
      : '',
    whenLabel(ctx.chat?.meetingAt ?? ctx.chat?.completedAt, now, tz) ?? '',
    whenLabel(ctx.thread?.firstOutboundAt, now, tz) ?? '',
    ctx.history ? `emailed before ${sinceLabel(ctx.history.lastAt, now, tz) ?? ''}` : '',
    ctx.chat?.commentedOnPost ? 'commented on their recent post' : '',
    now.getFullYear().toString(),
  ].join('\n');
}

/** Warm-up comment on a post: a question or an added point, never praise. Needs the claim the student wants to respond to. */
export function draftWarmUpComment(
  postClaim: string | undefined,
  opts: { seed?: string; ownExperience?: string } = {},
): { text: string; needsInput: 'post'[] } {
  const seed = opts.seed ?? 'c';
  if (!postClaim?.trim()) return { text: '', needsInput: ['post'] };
  const claim = strip(postClaim).replace(/^(that|the point that)\s+/i, '');
  const text = opts.ownExperience
    ? pick(
        [
          `${strip(opts.ownExperience)}. Curious whether that matches what you saw with ${lower1(claim)}.`,
          `We ran into the same thing: ${lower1(strip(opts.ownExperience))}. Did ${lower1(claim)} hold up for you once things got bigger?`,
        ],
        seed,
        'wc1',
      )
    : pick(
        [
          `The point about ${lower1(claim)} is new to me. What made you land on that, and does it hold for someone just starting out?`,
          `${claim.charAt(0).toUpperCase()}${claim.slice(1)}: is that something you'd push a new hire to do from week one, or does it only make sense later?`,
          `Curious about ${lower1(claim)}. Was there a specific moment that convinced you, or did it build up over time?`,
        ],
        seed,
        'wc2',
      );
  return { text, needsInput: [] };
}

export function wordsIn(body: string): number {
  // body words excluding greeting line and sign-off block
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // a greeting is not a word of the message, but a one-paragraph note ("Hi Noah, I read your post...") keeps the rest
  if (lines.length) {
    const g = lines[0]!.match(/^(hi|hey|hello|dear)\b[^,.!?\n]{0,40}[,.!]?\s*/i);
    if (g) lines[0] = lines[0]!.slice(g[0].length).trim();
  }
  const content = lines.filter(
    (l) =>
      !!l &&
      !/^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks|kind regards|best regards)[,!.]?$/i.test(
        l,
      ),
  );
  // drop trailing name/school lines (<= 4 words, no period)
  while (
    content.length > 1 &&
    /^[^.!?]{1,40}$/.test(content[content.length - 1]!) &&
    wordCount(content[content.length - 1]!) <= 5
  )
    content.pop();
  return wordCount(content.join('\n'));
}
