import { wordCount } from '../text/email';
import { normalizeCompany } from '../text/normalize';
import type {
  Channel,
  DraftClaim,
  DraftNeed,
  MessageKind,
  PersonFact,
  Sector,
  Seniority,
  StyleCard,
} from '../types';
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
  pointPhrase,
  roleNoun,
  schoolShort,
  softLower,
  strip,
  titleFunction,
} from './phrasing';
import { classYear, isRecruiter, sectorOf, seniorityOf, yearLabel } from './sector';
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

function greeting(ctx: DraftContext, sector: Sector, seniority: Seniority, recruiter: boolean): string {
  const first = firstNameOf(ctx.person);
  const learned = ctx.styleCard.builtFromCount > 0 && ctx.styleCard.greetingPatterns[0];
  if (learned && !/^dear/i.test(learned)) return learned.replace('{first}', first);
  const execCold =
    (sector === 'finance' || sector === 'consulting') && seniority === 'exec' && ctx.person.strength < 0.3;
  if (execCold) return `Dear ${ctx.person.fullName},`;
  if (recruiter || isFormalStyle(ctx.styleCard)) return `Dear ${first},`;
  return `Hi ${first},`;
}
function signoff(ctx: DraftContext, sector: Sector, recruiter: boolean): string {
  const learned = ctx.styleCard.builtFromCount > 0 && ctx.styleCard.signoffs[0];
  if (learned) return learned;
  if (ctx.channel === 'linkedin') return `Thanks,\n${ctx.user.firstName}`; // a chat message, not a letter
  const formal = isFormalStyle(ctx.styleCard);
  if (sector === 'finance' || sector === 'consulting' || recruiter) {
    const cy = classYear(ctx.user.gradYear);
    const school = schoolShort(ctx.user.school);
    return `${formal || recruiter ? 'Best regards' : 'Best'},\n${ctx.user.fullName}${school ? `\n${school}${cy ? ` ${cy}` : ''}` : ''}`;
  }
  if (formal) return `Kind regards,\n${ctx.user.firstName}`;
  return `Thanks,\n${ctx.user.firstName}`;
}

/** "a junior studying computer science" (for sentences that already named the school). */
function situationNoSchool(ctx: DraftContext, now: Date): string {
  const year = yearLabel(ctx.user.gradYear, ctx.user.degree, now);
  const major = ctx.user.majors[0] ? ` studying ${lowerPhrase(ctx.user.majors[0])}` : '';
  return `${article(year)} ${year}${major}`;
}

/** The student in one clause, from structured fields only: "a junior at Cornell studying computer science". */
function situation(ctx: DraftContext, now: Date): string {
  if (ctx.user.oneLiner) return ctx.user.oneLiner;
  const year = yearLabel(ctx.user.gradYear, ctx.user.degree, now);
  const school = schoolShort(ctx.user.school);
  const major = ctx.user.majors[0] ? ` studying ${lowerPhrase(ctx.user.majors[0])}` : '';
  return `${article(year)} ${year}${school ? ` at ${school}` : ''}${major}`;
}

function questionFor(ctx: DraftContext, sector: Sector, seed: string): string {
  const org = ctx.person.org;
  const role = roleNoun(ctx.person.title);
  const group = ctx.person.group;
  // the recipient's own field ("product design"), never the student's target when the two differ
  const theirFn = functionLabel(titleFunction(ctx.person.title));
  const c = ctx.connection;
  if (c?.kind === 'transition' && c.previous)
    return pick(
      [
        'how you made that move',
        'what the switch actually involved',
        "what you'd do differently if you made it again",
      ],
      seed,
      'q-trans',
    );
  if (sector === 'finance')
    return pick(
      [
        `how you chose ${group ?? org ?? 'your group'} and what the first year actually looks like`,
        `how recruiting went for you and what you'd do differently`,
        `how you picked ${group ?? 'your group'} over the others`,
      ],
      seed,
      'q-fin',
    );
  if (sector === 'consulting')
    return pick(
      [
        `how you decided on ${group ?? org ?? 'the firm'} and how juniors get staffed`,
        `whether an industry stint first is the better route into ${org ?? 'consulting'}`,
        `how you picked the office and what the first year looked like`,
      ],
      seed,
      'q-cons',
    );
  if (sector === 'tech')
    return pick(
      [
        role
          ? `how you ended up as ${article(role)} ${role}${org ? ` at ${org}` : ''}, and what you'd do differently`
          : `how you ended up${org ? ` at ${org}` : ' where you are'}, and what you'd do differently`,
        `what the first few months look like for a new hire on your team${org ? ` at ${org}` : ''}`,
        `what you'd focus on if you were recruiting for ${theirFn ?? 'your role'} again`,
      ],
      seed,
      'q-tech',
    );
  return pick(
    [
      `how you got into ${theirFn ?? 'your field'} and what you'd do differently starting now`,
      `what the path to ${role ? `${article(role)} ${role} role` : 'your role'}${org ? ` at ${org}` : ''} looked like`,
    ],
    seed,
    'q-gen',
  );
}

function ask(minutes: number, seed: string, formal: boolean): string {
  const base = pick(
    [
      `Would you have ${minutes} minutes sometime in the next couple of weeks to talk through that?`,
      `Would you be open to a ${minutes}-minute call in the next two weeks?`,
      `Could I take ${minutes} minutes of your time in the next couple of weeks?`,
    ],
    seed,
    'ask',
  );
  const tail = formal
    ? 'I am glad to work around your schedule.'
    : pick(
        [
          'Happy to work around your calendar.',
          'Whatever time suits you works for me.',
          'Any time that works for you works for me.',
        ],
        seed,
        'tail',
      );
  return `${base} ${tail}`;
}
function outLine(seed: string, formal: boolean): string {
  if (formal) return 'I completely understand if the next few weeks are busy.';
  return pick(
    [
      'Completely understand if the next few weeks are busy.',
      "No worries at all if the timing isn't right.",
      'Totally understand if this is a busy stretch.',
    ],
    seed,
    'out',
  );
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

/**
 * Picking an earlier exchange back up: "Thanks again for your note in September, and sorry it took me a while to
 * follow up." when they wrote last, "We traded emails in May, and I wanted to pick that conversation back up." when
 * the student did. The apology only appears when it really has been a while.
 */
function reconnectLine(ctx: DraftContext, c: Connection, now: Date): string {
  const tz = ctx.user.timezone;
  const since = c.lastAt ? sinceLabel(c.lastAt, now, tz) : undefined;
  const days = c.lastAt ? calendarDaysBetween(new Date(c.lastAt), now, tz) : 0;
  const medium = ctx.channel === 'linkedin' ? 'email' : 'note';
  if (c.lastInbound)
    return `Thanks again for your ${medium}${since ? ` ${since}` : ''}${days >= 14 ? ', and sorry it took me a while to follow up' : ''}.`;
  return `We traded emails${since ? ` ${since}` : ''}, and I wanted to pick that conversation back up.`;
}

/** Opening sentence(s) for outreach from the connection. Returns undefined when nothing checkable exists. */
function opener(
  ctx: DraftContext,
  seed: string,
  now: Date,
): { text: string; claims: DraftClaim[]; saidSituation: boolean } | undefined {
  const c = ctx.connection;
  const first = firstNameOf(ctx.person);
  const org = ctx.person.org;
  const me = situation(ctx, now);
  const school = schoolShort(ctx.user.school);
  const claims: DraftClaim[] = [];
  if (!c) return undefined;
  const avoid = (s: string) =>
    (ctx.recentOpenings ?? []).some((o) => o.trim().toLowerCase() === firstSentence(s).toLowerCase());
  switch (c.kind) {
    case 'prior_thread': {
      claims.push({ text: `${first} and the student have emailed before`, kind: 'shared' });
      return {
        text: `${reconnectLine(ctx, c, now)} As a quick reminder, I'm ${me}.`,
        claims,
        saidSituation: true,
      };
    }
    case 'referral': {
      const r = c.referrerName ?? 'A mutual contact';
      if (c.introduced) {
        // they were on the intro email: thank the introducer and pick it up, no need to explain who you are twice
        claims.push({ text: `${r} introduced the student to ${first} by email`, kind: 'shared' });
        return {
          text: pick(
            [
              `${r} was kind enough to introduce us, and it's great to meet you. I'm ${me}.`,
              `I wanted to follow up on ${r}'s introduction. It's great to meet you. I'm ${me}.`,
            ],
            seed,
            'op-intro',
            avoid,
          ),
          claims,
          saidSituation: true,
        };
      }
      claims.push({ text: `${r} suggested writing to ${first}`, factId: c.factId, kind: 'shared' });
      return {
        text: pick(
          [
            `${r} suggested I write to you about ${c.text}, and said to say hello. I'm ${me}.`,
            `${r} mentioned you'd be the right person to ask about ${c.text}. I'm ${me}.`,
          ],
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
      const where = org
        ? `${org}${ctx.person.group ? `'s ${ctx.person.group}` : ''}`
        : (roleNoun(ctx.person.title) ?? 'your work');
      return {
        text: pick(
          [
            // only what the data says: they went to the student's school and are at `where` now (never how the
            // student found them, which Orbit does not know); the school is named once
            `I'm ${me}, and I saw that you went from ${school} to ${where}.`,
            `You went to ${school} before ${where}, which is why I'm writing to you in particular. I'm ${situationNoSchool(ctx, now)} there now.`,
            ctx.user.oneLiner
              ? `I'm ${me}, and I noticed you went from ${school} to ${where}.`
              : `I'm ${situationNoSchool(ctx, now)} at ${school}, and I noticed you went from there to ${where}.`,
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
        text: `${first} moved from ${c.previous} to ${org}`,
        factId: c.factId,
        kind: 'about_person',
      });
      const role = roleNoun(ctx.person.title);
      return {
        text: pick(
          [
            `I'm ${me}, and I noticed you moved from ${c.previous} to ${role ? `${role}${org ? ` at ${org}` : ''}` : (org ?? 'your current role')}.`,
            `I saw you went from ${c.previous} to ${org ?? 'your current role'}, and I'd like to understand how that happened. I'm ${me}.`,
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
            `I'm ${me}, and I saw that ${c.text}, which is exactly what I'm trying to learn more about.`,
            `I saw that ${c.text}, and that's what made me write. I'm ${me}.`,
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
      return { text: `${studentSentence(c.text)}. I'm ${me}.`, claims, saidSituation: true };
    }
  }
}

const HOOK_TYPES: PersonFact['type'][] = ['hook', 'role_detail', 'background'];

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
      previous:
        ctx.person.previousTitle && ctx.person.previousOrg
          ? `${lowerPhrase(roleNoun(ctx.person.previousTitle) ?? ctx.person.previousTitle)} at ${ctx.person.previousOrg}`
          : ctx.person.previousOrg,
    };
  const hook = pickFact(facts, HOOK_TYPES, ctx.person, (c) => c.text.split(' ').length <= 22);
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
function firstSentence(body: string): string {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines.find((l) => !/^(hi|hey|hello|dear)\b/i.test(l)) ?? '';
  return (first.match(/^[^.!?]*[.!?]/)?.[0] ?? first).trim();
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

export function generateDraft(ctx: DraftContext): DraftOutput {
  const now = ctx.now ?? new Date();
  const seed = ctx.seed ?? ctx.person.fullName;
  const sector = sectorOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    ctx.user.targetFunctions,
  );
  const seniority = seniorityOf(ctx.person.title);
  const recruiter = isRecruiter(ctx.person.title);
  const formal = isFormalStyle(ctx.styleCard);
  const first = firstNameOf(ctx.person);
  const org = ctx.person.org;
  const tz = ctx.user.timezone;
  const G = greeting(ctx, sector, seniority, recruiter && ctx.kind === 'outreach');
  const S = signoff(ctx, sector, recruiter && ctx.kind === 'outreach');
  const register: DraftOutput['register'] =
    sector === 'finance' || sector === 'consulting' || recruiter || formal ? 'formal' : 'warm';
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
  const kind: MessageKind =
    ctx.kind === 'schedule' && ((asks.length && ctx.thread?.lastSignal !== 'reschedule') || booking)
      ? 'reply'
      : ctx.kind;

  switch (kind) {
    case 'outreach': {
      if (recruiter) {
        // Recruiters get logistics, never a coffee-chat ask.
        const intern = isInternCycle(ctx.user.cycleLabel);
        const role = ctx.targetCompany?.roleLabel
          ? `the ${ctx.targetCompany.roleLabel} role`
          : `${fnLabel} ${intern ? 'internships' : 'roles'}`;
        subject =
          `${school} ${cy || yl}, question about ${org ?? ''} ${intern ? 'internship' : 'new grad'} recruiting`
            .replace(/\s+/g, ' ')
            .trim();
        const spoke = (ctx.sameOrgContacts ?? []).slice(0, 2);
        const spokeLine = spoke.length
          ? ` I've had helpful conversations with ${spoke.join(' and ')} on the team and want to make sure I follow the right process.`
          : '';
        // a recruiter the student has already emailed with is not a stranger
        const known = ctx.connection?.kind === 'prior_thread' ? ctx.connection : undefined;
        const intro = known
          ? `${reconnectLine(ctx, known, now)} As a quick reminder, I'm ${me}, and I'm`
          : `I'm ${me}, and I'm`;
        if (known) claims.push({ text: `${first} and the student have emailed before`, kind: 'shared' });
        body = `${G}\n\n${intro} planning to apply for ${role}${org ? ` at ${org}` : ''} this cycle. One quick question: are applications reviewed on a rolling basis, and is there a campus event or deadline I should plan around?${spokeLine}\n\nThank you for your time.\n\n${S}`;
        claims.push({ text: `${first} recruits${org ? ` for ${org}` : ''}`, kind: 'about_person' });
        claims.push({ text: 'logistics question', kind: 'logistics' });
        if (ctx.channel === 'linkedin') {
          // a connection note, not a letter: who, the role, one answerable question
          const notes = [
            ...(known
              ? [
                  `Hi ${first}, ${lower1(shortConnection(ctx, known))} I'm applying for ${role}${org ? ` at ${org}` : ''} this cycle. Is there a deadline or campus event I should plan around? Thanks, ${ctx.user.firstName}`,
                ]
              : []),
            `Hi ${first}, ${school} ${yl} here, planning to apply for ${role}${org ? ` at ${org}` : ''} this cycle. Is there a campus event or deadline I should plan around? Thank you, ${ctx.user.firstName}`,
            `Hi ${first}, ${school} ${yl} here, applying for ${role}${org ? ` at ${org}` : ''}. Is there a deadline or campus event I should plan around? Thanks, ${ctx.user.firstName}`,
          ];
          bodyShort =
            notes.find((x) => x.length <= LINKEDIN_NOTE_TARGET) ??
            notes.find((x) => x.length <= LINKEDIN_NOTE_MAX) ??
            fitNote(notes[1]!, LINKEDIN_NOTE_MAX);
          subject = undefined;
        } else if (threaded) subject = reSubject;
        break;
      }
      const op = opener(ctx, seed, now);
      if (!op) {
        needsInput.push('connection');
        claims.push({ text: 'connection missing', kind: 'logistics' });
      }
      const q = questionFor(ctx, sector, seed);
      // name the student's target only when it is the recipient's field too ("software engineering" to an engineer,
      // never to a banker)
      const matched = functionLabel(matchedFunction(P.title, ctx.user.targetFunctions));
      const intern = isInternCycle(ctx.user.cycleLabel);
      const lookingFor = matched
        ? `${matched} ${intern ? 'internships' : 'roles'}`
        : intern
          ? 'internships'
          : 'full-time roles';
      const sit = op?.saidSituation ? '' : `I'm ${me}, recruiting for ${lookingFor} this cycle.`;
      const bridge = pick(
        [
          `I'd love to hear ${q}.`,
          `What I'm trying to understand is ${q}.`,
          `The thing I'd most like to ask about is ${q}.`,
        ],
        seed,
        'bridge',
      );
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
      const isLinkedIn = ctx.channel === 'linkedin';
      body = `${G}\n\n${join(openText, alsoCommented, sit, bridge)}\n\n${ask(minutes, seed, formal)} ${outLine(seed, formal)}\n\n${S}`;
      // Subject: the connection, then the topic, short enough for a phone.
      const c = ctx.connection;
      const subjectCandidates: string[] = [];
      if (c?.kind === 'referral' && c.referrerName)
        subjectCandidates.push(
          c.introduced
            ? `Following up on ${c.referrerName}'s introduction`
            : `${c.referrerName} suggested I write to you`,
        );
      if (c?.kind === 'event' && c.eventName)
        subjectCandidates.push(`From the ${c.eventName.replace(/^the\s+/i, '')}, one follow-up`);
      if (c?.kind === 'transition' && c.previous)
        subjectCandidates.push(`Your move from ${c.previous} to ${org ?? 'your role'}`);
      if (ctx.person.isAlumni)
        subjectCandidates.push(
          `${school} ${yl}, quick question on ${org ?? 'your path'}`,
          `Fellow ${school} alum, your path to ${org ?? roleNoun(ctx.person.title) ?? 'your role'}`,
        );
      subjectCandidates.push(
        `Quick question about your path to ${org ?? roleNoun(ctx.person.title) ?? 'your role'}`,
        `${school} ${yl}, question about ${org ?? 'your work'}`,
      );
      const specific = subjectCandidates
        .slice(0, c && ['referral', 'event', 'transition'].includes(c.kind) ? 1 : ctx.person.isAlumni ? 1 : 0)
        .find((s) => s.length <= 60);
      subject =
        specific ??
        [...subjectCandidates].sort((a, b) => a.length - b.length).find((s) => s.length <= 60) ??
        subjectCandidates[0]!;
      if (sector === 'finance' && cy && org)
        subject = `${school} ${cy}, quick question on ${org}${ctx.person.group ? ` ${ctx.person.group}` : ''}`;
      // picking an earlier exchange back up replies in that thread
      if (threaded) subject = reSubject;
      // LinkedIn connection note (not yet connected) or message (connected)
      if (isLinkedIn) {
        const short = op ? shortConnection(ctx, c!) : `[your link to ${first}]`;
        const sq = shortQuestion(q);
        const candidates = [
          `Hi ${first}, ${school} ${yl} here. ${short} Would you be open to ${minutes} minutes on ${q}? Happy to work around your schedule. ${ctx.user.firstName}`,
          `Hi ${first}, I'm ${me}. ${short} Could I take ${minutes} minutes to hear ${q}? Thanks either way, ${ctx.user.firstName}`,
          `Hi ${first}, ${school} ${yl} here. ${short} Would ${minutes} minutes on ${sq} be possible? Thanks, ${ctx.user.firstName}`,
          `Hi ${first}, ${school} ${yl} here. ${short} Would you have ${minutes} minutes for a few questions? Thanks, ${ctx.user.firstName}`,
        ];
        bodyShort =
          candidates.find((x) => x.length <= LINKEDIN_NOTE_TARGET) ??
          [...candidates].sort((a, b) => a.length - b.length).find((x) => x.length <= LINKEDIN_NOTE_MAX) ??
          fitNote(candidates[3]!, LINKEDIN_NOTE_MAX);
        if (ctx.person.linkedinConnected) {
          const at = ctx.person.linkedinConnectedAt
            ? new Date(ctx.person.linkedinConnectedAt).getTime()
            : NaN;
          const recent = !Number.isNaN(at) && now.getTime() - at < 21 * 86_400_000;
          body = `${recent ? `Hi ${first}, thanks for connecting.` : G} ${join(openText, sit, bridge)} Would you have ${minutes} minutes in the next couple of weeks? Email is fine too if that's easier than a call.\n\n${S}`;
        }
        subject = undefined;
      }
      break;
    }
    case 'bump': {
      const n = ctx.bumpNumber ?? 1;
      // "my note from Thursday", "my note from last week", "my note from September 24"; undated when unknown
      const noteDate = ctx.thread?.firstOutboundAt
        ? whenLabel(ctx.thread.firstOutboundAt, now, tz)?.replace(/^on /, '')
        : undefined;
      const myNote = noteDate ? `my note from ${noteDate}` : 'my earlier note';
      if (n >= 2) {
        body = `${G}\n\n${
          formal
            ? `One last note from me. If the next few weeks are too busy, I completely understand, and if a ${minutes}-minute call ever fits, I would be glad to make the time work.`
            : pick(
                [
                  `Last note from me, I promise. If the next few weeks are too busy, no problem at all. If a ${minutes}-minute call ever does fit, I'll make the time work.`,
                  `One last nudge and then I'll leave you be. If a ${minutes}-minute call fits at some point this cycle, I'd still be glad to take it, and no hard feelings if not.`,
                ],
                seed,
                'bump2',
              )
        }\n\n${S}`;
        claims.push({ text: 'second bump', kind: 'logistics' });
      } else {
        const topic =
          ctx.connection?.kind === 'transition' && ctx.connection.previous
            ? ` to hear about your move to ${org ?? 'your current role'}`
            : '';
        body = `${G}\n\n${
          formal
            ? `I wanted to follow up on ${myNote} in case it was missed. If ${minutes} minutes in the coming weeks would be possible${topic}, I would be grateful, and if someone else on your team would be better placed, a pointer would be very helpful.`
            : pick(
                [
                  `Floating this back up in case it got buried. I'd still love ${minutes} minutes whenever it's convenient${topic}, and if someone else on your team would be a better person to ask, I'd be grateful for a pointer.`,
                  `Just surfacing ${myNote} in case it got buried. Totally understand if the timing isn't right; even ${minutes} minutes whenever it's convenient would help${topic}.`,
                  `Following up on my note in case it got lost. I'd still value ${minutes} minutes in the next couple of weeks${topic}, and completely understand if now isn't a good time.`,
                ],
                seed,
                'bump1',
              )
        }\n\n${S}`;
        claims.push({ text: 'first bump in thread', kind: 'logistics' });
      }
      subject = threaded ? undefined : (reSubject ?? `${school} ${yl}, following up on my note`);
      break;
    }
    case 'schedule': {
      const last = ctx.thread?.lastSignal;
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
        body = `${G}\n\n${lead} ${offer} ${alt}\n\n${S}`;
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
      const proposed = ctx.thread?.proposedTimes ?? [];
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
      const free = future.find(
        (t) =>
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
          parts.push(
            pick(
              [
                "Happy to share my resume; I'll send it over today.",
                "Of course, I'll send my resume over today.",
              ],
              seed,
              'reply-resume',
            ),
          );
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
        if (ctx.answer?.trim()) parts.push(`${cap1(strip(ctx.answer))}.`);
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
      body = `${G}\n\n${parts.join(' ')}${confirmed ? '\n\nLooking forward to it.' : ''}\n\n${S}`;
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
      let line2 = '';
      const op = offerPhrase(offer?.c);
      if (op) {
        line2 = ` Thanks also for ${op}; I'll follow up ${/\b(posting|role|opening|application|req)\b/i.test(op) ? "once it's live" : 'when the timing is right'}.`;
        cite(offer);
      }
      // a promise made in the conversation ("I will send my resume by Friday") is kept in the same note
      const promise = (ctx.promises ?? []).map(promiseLine).find(Boolean);
      if (promise) claims.push({ text: `promise: ${promise}`, kind: 'logistics' });
      const line3 = promise ? ` ${promise}` : '';
      const cycle = cyclePhrase(ctx.user.cycleLabel);
      body = `${G}\n\n${line1}${line2}${line3}\n\n${pick([`I'll let you know how ${cycle} goes. Would it be alright to send a question your way if one comes up?`, `I'll keep you posted on how ${cycle} goes, and if there's ever anything I can do for you, please say so.`], seed, 'ty-close')}\n\n${S}`;
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
      const hook = fact(['hook'], (c) => !!hookProposition(c));
      const advice = fact(['advice'], (c) => !!pointPhrase(c));
      const since = sinceLabel(meetingAt, now, tz);
      const update = ctx.update?.trim();
      if (!update && !hook) needsInput.push('update');
      const parts: string[] = [];
      if (update) {
        const point = pointPhrase(advice?.c);
        parts.push(
          `Quick update${since ? ` since we talked ${since}` : ''}: ${softLower(strip(update))}.${point ? ` ${cap1(point)} has been a big part of that.` : ''}`,
        );
        if (point) cite(advice);
      }
      if (hook) {
        const prop = hookProposition(hook.c)!;
        const tense = hookTense(prop, now);
        const q =
          tense === 'future'
            ? 'How is that shaping up?'
            : tense === 'ongoing'
              ? 'How is it going?'
              : 'How did it go?';
        parts.push(`${update ? 'Also, you' : 'You'} mentioned ${prop}. ${q}`);
        cite(hook);
      } else if (update && org) parts.push(`Hope things are going well at ${org}.`);
      if (!parts.length) parts.push(`[One real update since you last spoke with ${first}]`);
      body = `${G}\n\n${parts.join(' ')}\n\nNo reply needed, just wanted to stay in touch.\n\n${S}`;
      subject = threaded
        ? undefined
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
      if (na?.org && newRole && sameOrg) {
        const name = [na.org.trim(), na.previousOrg!.trim()].sort((a, b) => a.length - b.length)[0];
        what = `your new role as ${article(newRole)} ${newRole} at ${name}`;
      } else if (na?.org && newRole) what = `your move to ${na.org} as ${article(newRole)} ${newRole}`;
      else if (na?.org && !sameOrg) what = `your move to ${na.org}`;
      else if (newRole) what = `your new role as ${article(newRole)} ${newRole}`;
      else if (news) what = softLower(strip(news).replace(/^(congratulations|congrats) on\s+/i, ''));
      if (!what) {
        needsInput.push('news');
        body = `${G}\n\n[What you are congratulating ${first} on]\n\n${S}`;
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
      body = `${G}\n\nJust saw the news about ${what}. Congratulations${tie ? '.' : ', well deserved.'}${tieLine}${recent ? ' Hope the first few weeks are going well.' : ''}\n\n${S}`;
      subject = threaded
        ? undefined
        : na?.org && !sameOrg && what.startsWith('your move')
          ? `Congratulations on ${na.org}`
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
      const offer = fact(['offer'], (c) => c.you);
      const advice = offer ? undefined : fact(['advice'], (c) => !!pointPhrase(c));
      const intern = isInternCycle(ctx.user.cycleLabel);
      const label = tc?.roleLabel?.trim();
      const role = label
        ? /\b(role|internship|position|program|programme|req)$/i.test(label)
          ? label
          : `${label} role`
        : `${fnLabel} ${intern ? 'internship' : 'role'}`;
      const req = tc?.reqId
        ? ` (req ${tc.reqId}${tc.link ? ', link below' : ''})`
        : tc?.link
          ? ' (link below)'
          : '';
      const spoke = ctx.chat?.completedAt || ctx.chat?.meetingAt;
      const when = spoke ? whenLabel(meetingAt, now, tz) : undefined;
      const otherCompany = !!org && company.toLowerCase() !== org.toLowerCase();
      if (!spoke && !offer) {
        // Thin relationship: the first rung of the ladder is a process question, not a referral request.
        claims.push({ text: `asks about referral process at ${company}`, kind: 'logistics' });
        body = `${G}\n\nI'm ${me}, and I'm applying for the ${role} at ${company}${req}. Quick question about process: are referrals common at ${company}, and is it better to talk to someone on the team before I submit? Completely understand if that's not something you can weigh in on.\n\n${S}`;
        subject = `${company} ${role}, a quick process question`;
        if (tc?.link) body = body.replace(`\n\n${S}`, `\n\n${tc.link}\n\n${S}`);
        break;
      }
      let open: string;
      if (offer) {
        const t = offer.c.text.replace(/^you offered\b/, 'you kindly offered');
        open = `When we spoke${when ? ` ${when}` : ''}, ${t}, so I wanted to follow up.`;
        cite(offer);
      } else if (spoke) open = `Thanks again for the conversation${when ? ` ${when}` : ''}.`;
      else open = "I wanted to ask a small favor, with zero pressure if it isn't a fit.";
      const point = pointPhrase(advice?.c);
      const why =
        point && !otherCompany ? ` ${cap1(point)} is a big part of why I'm applying here first.` : '';
      if (why) cite(advice);
      const timing = sector === 'tech' && !tc?.applied ? 'before' : tc?.applied ? 'applied' : 'now';
      const fit =
        ctx.user.credibility && !offer
          ? ` Most relevant thing I've done: ${softLower(strip(ctx.user.credibility))}.`
          : '';
      let askLine: string;
      if (otherCompany)
        askLine = `I know you're at ${org}, but if you know anyone at ${company} who'd be comfortable flagging my application, an intro would mean a lot.`;
      else if (sector === 'tech')
        askLine = `Would you be willing to refer me${timing === 'before' ? ' before I submit through the portal' : ''}?`;
      else askLine = `If you'd be comfortable flagging my name to the recruiting team, I'd be grateful.`;
      body = `${G}\n\n${open}${why} I'm applying for the ${role} at ${company}${req}${timing === 'applied' ? ', submitted this week' : ''}.${fit} ${askLine} My resume is ready to send, so it should only take a couple of minutes. Completely fine if not; I know a referral has your name on it.\n\n${S}`;
      subject = tc?.applied
        ? `Quick update + applied to ${company} ${role}`
        : `${company} ${role}, a small ask`;
      if (tc?.link) body = body.replace(`\n\n${S}`, `\n\n${tc.link}\n\n${S}`);
      break;
    }
    case 'intro_request': {
      const t = ctx.target;
      if (!t?.name) {
        needsInput.push('target');
        body = `${G}\n\n[Who you would like ${first} to introduce you to, and why them]\n\n${S}`;
        subject = threaded ? undefined : 'A small ask';
        break;
      }
      const tFirst = t.firstName ?? t.name.split(' ')[0]!;
      const tRole = roleNoun(t.title);
      const desc = tRole ? ` (${t.title}${t.org ? ` at ${t.org}` : ''})` : t.org ? ` at ${t.org}` : '';
      const topic = t.why
        ? strip(t.why).replace(/\btheir\b/g, `${tFirst}'s`)
        : t.org
          ? `how ${t.org} thinks about ${fnLabel} hiring`
          : `how ${tFirst} got into ${fnLabel}`;
      const cred = ctx.user.credibility
        ? ` ${ctx.user.firstName} ${softLower(strip(ctx.user.credibility))}, and`
        : ` ${ctx.user.firstName}`;
      const link =
        ctx.connection?.kind === 'shared_employer' && ctx.connection.sharedOrg
          ? ` I noticed you two worked together at ${ctx.connection.sharedOrg}.`
          : '';
      const intern = isInternCycle(ctx.user.cycleLabel);
      const blurb = `"${ctx.user.fullName} is ${me}, recruiting for ${fnLabel} ${intern ? 'internships' : 'roles'}.${cred} would love 15 minutes to hear about ${tRole ? `${tFirst}'s path to ${tRole}${t.org ? ` at ${t.org}` : ''}` : `${tFirst}'s work${t.org ? ` at ${t.org}` : ''}`}."`;
      body = `${G}\n\nSmall ask. I'm hoping to talk with ${t.name}${desc} about ${topic}.${link} If you'd be comfortable making a short intro, here's something you could forward:\n\n${blurb}\n\nAnd if it's not a good fit to ask, no worries at all.\n\n${S}`;
      claims.push({ text: `target: ${t.name}`, kind: 'logistics' });
      subject = threaded ? undefined : `Small ask: intro to ${t.name}?`;
      if (t.offered) {
        // following up on an intro they offered: name the offer, make forwarding a two-second task
        const offerBlurb = `"${ctx.user.fullName} is ${me}, recruiting for ${fnLabel} ${intern ? 'internships' : 'roles'}.${cred} would love 15 minutes to hear about your work${t.org ? ` at ${t.org}` : ''}."`;
        body = `${G}\n\nWhen we spoke, you kindly offered to introduce me to ${t.name}. If that's still easy, here's a short note you could forward so it takes no time:\n\n${offerBlurb}\n\nAnd if the timing isn't right anymore, no worries at all. Thanks again for offering.\n\n${S}`;
        subject = threaded || ctx.thread ? undefined : `Intro to ${t.name}`;
      }
      break;
    }
    case 'report_back': {
      const rb = ctx.reportBack;
      const tName = rb?.targetName ?? 'them';
      const line = rb?.line ? ` ${cap1(strip(rb.line))}.` : '';
      const outcome =
        rb?.outcome === 'spoke'
          ? `We spoke ${rb?.when ?? 'last week'}.${line}`
          : rb?.outcome === 'declined'
            ? `${tName.split(' ')[0]} couldn't make time this cycle, which is completely fair, and I appreciate you trying.`
            : `I haven't heard back yet, but I wanted you to know I followed up on it.`;
      body = `${G}\n\nQuick note to say thank you for the intro to ${tName}. ${outcome} Really appreciate you making it happen, and I'll keep you posted on how recruiting goes.\n\n${S}`;
      claims.push({ text: `report back on ${tName}`, kind: 'logistics' });
      subject = threaded ? undefined : `Thank you for the intro to ${tName.split(' ')[0]}`;
      break;
    }
  }
  if (subject && BANNED_SUBJECT_PATTERNS.some((re) => re.test(subject!)))
    subject = `${school ? `${school} ${yl}, ` : ''}question about ${org ?? 'your path'}`;
  if (ctx.channel === 'linkedin' && ctx.kind !== 'outreach') subject = undefined;
  let finalBody = body.replace(/[ \t]+\n/g, '\n').trim();
  if (ctx.styleCard.contractions === false) finalBody = expandContractions(finalBody);
  return {
    subject,
    body: finalBody,
    bodyShort,
    claims,
    needsInput,
    opening: firstSentence(finalBody),
    sector,
    register,
  };
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

function shortQuestion(q: string): string {
  return q.replace(/,? and what (you'd|you would) do differently.*$/, '');
}

/** One short clause for the LinkedIn note, from the connection. */
function shortConnection(ctx: DraftContext, c: Connection): string {
  const org = ctx.person.org;
  switch (c.kind) {
    case 'prior_thread':
      return reconnectLine(ctx, c, ctx.now ?? new Date()).replace(/, and (sorry|I wanted).*\.$/, '.');
    case 'referral':
      return c.introduced
        ? `Following up on ${c.referrerName ?? 'our mutual contact'}'s introduction.`
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
      return `${studentSentence(c.text)}.`;
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
  const proposed = (ctx.thread?.proposedTimes ?? []).map(
    (w) => `${w.raw} ${fmtWindow(w, tz)} ${tzAbbr(tz, new Date(w.startIso))}`,
  );
  return [
    JSON.stringify({
      ...ctx,
      styleCard: { greetingPatterns: ctx.styleCard.greetingPatterns, signoffs: ctx.styleCard.signoffs },
    }),
    schoolShort(ctx.user.school),
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
  const content = lines.filter(
    (l, i) =>
      !(i === 0 && /^(hi|hey|hello|dear)\b/i.test(l)) &&
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
