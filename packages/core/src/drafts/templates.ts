import { wordCount } from '../text/email';
import type { Channel, DraftClaim, MessageKind, PersonFact, Sector, Seniority, StyleCard } from '../types';
import { classYear, isRecruiter, sectorOf, seniorityOf, yearLabel } from './sector';

/**
 * Drafting engine. Follows docs/plan/15-outreach-playbook.md: connection first, one line only true of the
 * recipient, one bounded ask with a number, an out, sector register, tight limits, variety by seed, and a hard
 * rule that a cold outreach without a checkable connection is not drafted but asks the student for one.
 */

export type ConnectionKind =
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
    oneLiner?: string; // "a junior at Cornell studying CS" style, optional override
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
    previousOrg?: string;
    previousTitle?: string;
  };
  facts: PersonFact[];
  kind: MessageKind;
  channel: Channel;
  connection?: Connection;
  bumpNumber?: number; // 1 or 2
  proposedWindows?: { startIso: string; endIso?: string; raw?: string }[];
  /** a time the person proposed that can no longer be accepted (it has passed, or the student is busy then) */
  missedProposal?: { raw: string; startIso?: string; reason: 'passed' | 'busy' };
  thread?: {
    lastInboundBody?: string;
    lastInboundAt?: string;
    firstOutboundAt?: string;
    asksOfUser?: string[];
    proposedTimes?: { startIso: string; raw: string }[];
    lastSignal?: string;
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
    stage?: string;
    referrerName?: string;
    /** set when the referrer introduced the student to this person by email */
    introducedAt?: string;
    warmUpNote?: string;
    warmUpDone?: number;
  };
  update?: string; // the student's own update, for nurture
  newAffiliation?: { title?: string; org?: string };
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
  recentOpenings?: string[]; // first sentences of drafts sent to the same org in the last 30 days (avoid)
  seed?: string; // deterministic variety; default personId
  now?: Date;
}

export interface DraftOutput {
  subject?: string;
  body: string;
  bodyShort?: string; // LinkedIn connection note (<= 300 chars)
  claims: DraftClaim[];
  needsInput: ('connection' | 'update' | 'post')[];
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
export const LINKEDIN_NOTE_MAX = 300;
export const LINKEDIN_NOTE_TARGET = 270;

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
const lower1 = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
/** Lowercase a field-of-study phrase, keeping acronyms ("Computer Science" -> "computer science", "CS and Math" -> "CS and math"). */
const lowerPhrase = (s: string) =>
  s
    .split(' ')
    .map((w) => (/^[A-Z&]{2,6}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
const strip = (s: string) => s.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
const dropPronoun = (s: string) =>
  strip(s)
    .replace(/^(they|he|she)\s+(are|is|were|was)\s+/i, '')
    .replace(/^(they|he|she)\s+/i, '');

const FUNCTION_LABEL: Record<string, string> = {
  swe: 'software engineering',
  pm: 'product management',
  ib: 'investment banking',
  consulting: 'consulting',
  data: 'data science',
  design: 'product design',
  finance: 'finance',
  marketing: 'marketing',
  research: 'research',
  vc: 'venture capital',
  ops: 'operations',
};
export function targetLabel(ctx: Pick<DraftContext, 'user'>): string {
  const f = ctx.user.targetFunctions[0];
  return f ? (FUNCTION_LABEL[f] ?? f) : 'early-career';
}

export function fmtWindow(w: { startIso: string; endIso?: string }, tz: string): string {
  const d = new Date(w.startIso);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  const t = fmtTime(d, tz);
  if (w.endIso) return `${day} ${t} to ${fmtTime(new Date(w.endIso), tz)}`;
  return `${day} at ${t}`;
}
function fmtTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const ap = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return m === '00' ? `${h}${ap}` : `${h}:${m}${ap}`;
}
export function tzAbbr(tz: string, now: Date): string {
  try {
    const v =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value ?? tz;
    return v.replace(/^GMT([+-]\d+)$/, 'UTC$1');
  } catch {
    return tz;
  }
}
function whenLabel(iso: string | undefined, now: Date, tz: string): string {
  if (!iso) return 'the other day';
  const d = new Date(iso);
  const days = Math.round((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) {
    const h = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d),
    );
    return h < 12 ? 'this morning' : h < 17 ? 'this afternoon' : 'this evening';
  }
  if (days === 1) return 'yesterday';
  if (days < 7) return `on ${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })}`;
  if (days < 21) return 'last week';
  return `in ${d.toLocaleDateString('en-US', { month: 'long', timeZone: tz })}`;
}
function monthLabel(iso: string | undefined, now: Date): string {
  if (!iso) return 'a while back';
  const d = new Date(iso);
  const days = Math.round((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 21) return 'a few weeks ago';
  return `in ${d.toLocaleDateString('en-US', { month: 'long' })}`;
}

function firstNameOf(p: DraftContext['person']): string {
  return p.firstName || p.fullName.split(' ')[0] || 'there';
}

function greeting(ctx: DraftContext, sector: Sector, seniority: Seniority): string {
  const first = firstNameOf(ctx.person);
  const learned = ctx.styleCard.builtFromCount > 0 && ctx.styleCard.greetingPatterns[0];
  if (learned && !/^dear/i.test(learned)) return learned.replace('{first}', first);
  const formal =
    (sector === 'finance' || sector === 'consulting') && seniority === 'exec' && ctx.person.strength < 0.3;
  if (formal) return `Dear ${ctx.person.fullName},`;
  return `Hi ${first},`;
}
function signoff(ctx: DraftContext, sector: Sector): string {
  const learned = ctx.styleCard.builtFromCount > 0 && ctx.styleCard.signoffs[0];
  if (learned) return learned;
  if (sector === 'finance' || sector === 'consulting') {
    const cy = classYear(ctx.user.gradYear);
    return `Best,\n${ctx.user.fullName}${ctx.user.school ? `\n${ctx.user.school}${cy ? ` ${cy}` : ''}` : ''}`;
  }
  return `Thanks,\n${ctx.user.firstName}`;
}

/** The student in one clause: "a junior at Cornell studying computer science". */
function situation(ctx: DraftContext, now: Date): string {
  if (ctx.user.oneLiner) return ctx.user.oneLiner;
  const year = yearLabel(ctx.user.gradYear, ctx.user.degree, now);
  const major = ctx.user.majors[0] ? ` studying ${lowerPhrase(ctx.user.majors[0])}` : '';
  return `a ${year} at ${ctx.user.school}${major}`;
}

function questionFor(ctx: DraftContext, sector: Sector, seed: string): string {
  const org = ctx.person.org;
  const title = ctx.person.title;
  const group = ctx.person.group;
  const c = ctx.connection;
  if (c?.kind === 'transition' && c.previous)
    return pick(
      [
        `how you made the move from ${c.previous} to ${org ?? 'where you are now'}`,
        `what the switch from ${c.previous} to ${org ?? 'your current role'} actually involved`,
      ],
      seed,
      'q-trans',
    );
  if (sector === 'finance')
    return pick(
      [
        `how you chose ${group ?? (org ? `${org}` : 'your group')} and what the first year actually looks like`,
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
        `how you got from ${ctx.user.school === ctx.person.fullName ? 'school' : 'where you started'} to ${title ?? 'your role'}${org ? ` at ${org}` : ''} and what you'd do differently`,
        `what a strong intern or new grad actually does in the first few months${org ? ` at ${org}` : ''}`,
        `how you think about ${title ? lower1(title) : 'the role'} work${org ? ` at ${org}` : ''} versus elsewhere`,
      ],
      seed,
      'q-tech',
    );
  return pick(
    [
      `how you got into ${targetLabel(ctx)} and what you'd do differently starting now`,
      `what the path to ${title ?? 'your role'}${org ? ` at ${org}` : ''} looked like`,
    ],
    seed,
    'q-gen',
  );
}

function ask(ctx: DraftContext, minutes: number, seed: string): string {
  const link = ctx.user.schedulingLink;
  const base = pick(
    [
      `Would you have ${minutes} minutes sometime in the next couple of weeks to talk through that?`,
      `Would you be open to a ${minutes}-minute call in the next two weeks?`,
      `Could I take ${minutes} minutes of your time in the next couple of weeks?`,
    ],
    seed,
    'ask',
  );
  const tail = link
    ? pick(
        [
          `Whatever time suits you works for me; my calendar is here if that's easier: ${link}`,
          `Happy to work around your calendar, or grab a slot here: ${link}`,
        ],
        seed,
        'tail',
      )
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
function outLine(seed: string): string {
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

/** Opening sentence(s) for outreach from the connection. Returns undefined when nothing checkable exists. */
function opener(
  ctx: DraftContext,
  sector: Sector,
  seed: string,
  now: Date,
): { text: string; claims: DraftClaim[]; saidSituation: boolean } | undefined {
  const c = ctx.connection;
  const first = firstNameOf(ctx.person);
  const org = ctx.person.org;
  const me = situation(ctx, now);
  const school = ctx.user.school;
  const claims: DraftClaim[] = [];
  if (!c) return undefined;
  const avoid = (s: string) =>
    (ctx.recentOpenings ?? []).some((o) => o.trim().toLowerCase() === s.trim().toLowerCase());
  switch (c.kind) {
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
      return {
        text: pick(
          [
            `Thank you for ${c.eventName ? `speaking at ${c.eventName}` : 'the talk'}${c.text ? `. ${c.text}` : ''}.`,
            `We met at ${c.eventName ?? 'the event'}${c.text ? `, and ${lower1(c.text)}` : ''}. I'm ${me}.`,
          ],
          seed,
          'op-event',
          avoid,
        ),
        claims,
        saidSituation: !!c.eventName === false,
      };
    }
    case 'alumni': {
      claims.push({ text: `${first} went to ${school}`, kind: 'shared' });
      const where = org
        ? `${org}${ctx.person.group ? `'s ${ctx.person.group}` : ''}`
        : (ctx.person.title ?? 'your work');
      return {
        text: pick(
          [
            `I'm ${me}, and I found you on the ${school} alumni page while looking at ${where}.`,
            `Fellow ${school} person here. I'm ${me}, and I came across your profile while reading about ${where}.`,
            `I'm ${me}, and I noticed you went from ${school} to ${where}.`,
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
      return {
        text: pick(
          [
            `I've been reading your posts; the one about ${lower1(c.text)} is what made me write. I'm ${me}.`,
            `Your post about ${lower1(c.text)} is what prompted this. I'm ${me}.`,
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
      return {
        text: pick(
          [
            `I'm ${me}, and I came across your profile while researching ${org ?? 'your team'}. You moved from ${c.previous} to ${ctx.person.title ? lower1(ctx.person.title) : 'your current role'}${org ? ` at ${org}` : ''}, which is the switch I'm trying to understand before recruiting starts.`,
            `You went from ${c.previous} to ${org ?? 'your current role'}, which is close to the route I'm weighing. I'm ${me}.`,
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
            `I'm ${me}, and I spent last summer at ${c.sharedOrg}, where you were before ${org ?? 'your current role'}.`,
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
            `I'm ${me}, and I came across your profile while researching ${org ?? 'your field'}. I read that ${lower1(c.text)}, which is exactly what I'm trying to learn more about.`,
            `${c.text.replace(/^you /i, 'You ')}, which is what made me write. I'm ${me}.`,
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
      const t = strip(c.text);
      const sentence = /^[A-Z]/.test(t) ? t : `${t[0]?.toUpperCase()}${t.slice(1)}`;
      return { text: `${sentence}. I'm ${me}.`, claims, saidSituation: true };
    }
  }
}

/** Find the strongest checkable link between student and recipient from stored data. */
export function deriveConnection(ctx: DraftContext): Connection | undefined {
  if (ctx.connection) return ctx.connection;
  const facts = ctx.facts.filter((x) => !x.deletedAt);
  const supplied = facts.find((x) => x.type === 'connection');
  if (supplied) return { kind: 'user_supplied', text: supplied.text, factId: supplied.id };
  if (ctx.chat?.referrerName)
    return {
      kind: 'referral',
      text: ctx.person.org ? `${ctx.person.org}` : 'your work',
      referrerName: ctx.chat.referrerName,
      introduced: !!ctx.chat.introducedAt || undefined,
    };
  const event = facts.find((x) =>
    /\b(panel|spoke at|talk at|event|info session|conference|workshop|presented)\b/i.test(x.text),
  );
  if (event) {
    const name = event.text.match(
      /\b(?:at|the)\s+(the\s+)?([A-Z][\w&' ]{3,40}?(?:panel|event|session|conference|workshop|talk))/,
    )?.[2];
    return { kind: 'event', text: dropPronoun(event.text), factId: event.id, eventName: name };
  }
  if (ctx.person.isAlumni)
    return { kind: 'alumni', text: `${ctx.person.fullName} went to ${ctx.user.school}` };
  if (ctx.chat?.warmUpNote && (ctx.chat.warmUpDone ?? 0) >= 1)
    return { kind: 'warmup', text: ctx.chat.warmUpNote };
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
          ? `${lower1(ctx.person.previousTitle)} at ${ctx.person.previousOrg}`
          : ctx.person.previousOrg,
    };
  const hook = facts.find((x) => x.type === 'hook' || x.type === 'role_detail' || x.type === 'background');
  if (hook) return { kind: 'hook', text: dropPronoun(hook.text), factId: hook.id };
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

export function generateDraft(ctx: DraftContext): DraftOutput {
  const now = ctx.now ?? new Date();
  const seed = ctx.seed ?? ctx.person.fullName;
  const sector = sectorOf(
    { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    ctx.user.targetFunctions,
  );
  const seniority = seniorityOf(ctx.person.title);
  const recruiter = isRecruiter(ctx.person.title);
  const first = firstNameOf(ctx.person);
  const org = ctx.person.org;
  const G = greeting(ctx, sector, seniority);
  const S = signoff(ctx, sector);
  const register: DraftOutput['register'] =
    (sector === 'finance' || sector === 'consulting') && seniority === 'exec' ? 'formal' : 'warm';
  const claims: DraftClaim[] = [];
  const needsInput: DraftOutput['needsInput'] = [];
  const facts = ctx.facts.filter((f) => !f.deletedAt);
  const f = (types: PersonFact['type'][]) => facts.find((x) => types.includes(x.type));
  ctx = { ...ctx, connection: deriveConnection(ctx) };
  const minutes = ctx.person.isAlumni ? 20 : 15;
  let subject: string | undefined;
  let body = '';
  let bodyShort: string | undefined;
  const me = situation(ctx, now);
  const cy = classYear(ctx.user.gradYear);
  const yl = yearLabel(ctx.user.gradYear, ctx.user.degree, now);

  switch (ctx.kind) {
    case 'outreach': {
      if (recruiter) {
        // Recruiters get logistics, never a coffee-chat ask.
        const role =
          ctx.targetCompany?.roleLabel ??
          `${targetLabel(ctx)} ${/intern/i.test(ctx.user.cycleLabel) ? 'internship' : 'roles'}`;
        subject =
          `${ctx.user.school} ${cy || yl}, question about ${org ?? ''} ${/intern/i.test(ctx.user.cycleLabel) ? 'internship' : 'new grad'} recruiting`
            .replace(/\s+/g, ' ')
            .trim();
        body = `${G}\n\nI'm ${me}, planning to apply for ${role}${org ? ` at ${org}` : ''} this cycle. One quick question: are applications for ${ctx.user.cycleLabel.toLowerCase()} reviewed on a rolling basis, and is there a campus event or deadline I should plan around? I've spoken with ${facts.length ? 'a couple of people on the team' : 'a few people in the field'} and want to follow the right process.\n\nThank you for your time.\n\n${S}`;
        claims.push({ text: 'logistics question', kind: 'logistics' });
        break;
      }
      const op = opener(ctx, sector, seed, now);
      if (!op) {
        needsInput.push('connection');
        claims.push({ text: 'connection missing', kind: 'logistics' });
      }
      const q = questionFor(ctx, sector, seed);
      const sit = op?.saidSituation ? '' : `I'm ${me}, recruiting for ${targetLabel(ctx)} roles this cycle.`;
      const bridge = pick(
        [
          `I'd love to hear ${q}.`,
          `What I'm trying to understand is ${q}.`,
          `The thing I'd most like to ask about is ${q}.`,
        ],
        seed,
        'bridge',
      );
      const openText =
        op?.text ?? `[Your link to ${first}: how you found them, what you share, or what of theirs you read]`;
      claims.push(...(op?.claims ?? []));
      const isLinkedIn = ctx.channel === 'linkedin';
      body = `${G}\n\n${join(openText, sit, bridge)}\n\n${ask(ctx, minutes, seed)} ${outLine(seed)}\n\n${S}`;
      // Subject
      const c = ctx.connection;
      const subjectCandidates: string[] = [];
      if (c?.kind === 'referral' && c.referrerName)
        subjectCandidates.push(
          c.introduced
            ? `Following up on ${c.referrerName}'s introduction`
            : `${c.referrerName} suggested I write to you`,
        );
      if (c?.kind === 'event' && c.eventName) subjectCandidates.push(`From ${c.eventName}, one follow-up`);
      if (c?.kind === 'transition' && c.previous)
        subjectCandidates.push(`Your move from ${c.previous} to ${org ?? 'your role'}`);
      if (ctx.person.isAlumni)
        subjectCandidates.push(
          `${ctx.user.school} ${yl}, quick question on ${org ?? 'your path'}`,
          `Fellow ${ctx.user.school} alum, your path to ${org ?? ctx.person.title ?? 'your role'}`,
        );
      subjectCandidates.push(
        `Quick question about your path to ${org ?? ctx.person.title ?? 'your role'}`,
        `${ctx.user.school} ${yl}, question about ${org ?? 'your work'}`,
      );
      // Prefer the connection-specific subject (referral/event/transition) when it fits; otherwise the shortest generic one.
      const specific = subjectCandidates
        .slice(0, c && ['referral', 'event', 'transition'].includes(c.kind) ? 1 : 0)
        .find((s) => s.length <= 70);
      subject =
        specific ??
        subjectCandidates.sort((a, b) => a.length - b.length).find((s) => s.length <= 60) ??
        subjectCandidates[0]!;
      if (sector === 'finance' && cy && org)
        subject = `${ctx.user.school} ${cy}, quick question on ${org}${ctx.person.group ? ` ${ctx.person.group}` : ''}`;
      // LinkedIn connection note (not yet connected) or message (connected)
      if (isLinkedIn) {
        const short = op ? shortConnection(ctx, c!, sector, seed) : `[your link to ${first}]`;
        const candidates = [
          `Hi ${first}, ${ctx.user.school} ${yl} here. ${short} Would you be open to ${minutes} minutes on ${q}? Happy to work around your schedule. ${ctx.user.firstName}`,
          `Hi ${first}, I'm ${me}. ${short} Could I take ${minutes} minutes to hear ${q}? Thanks either way, ${ctx.user.firstName}`,
          `Hi ${first}, ${ctx.user.school} ${yl} here. ${short} Would ${minutes} minutes on ${shortQuestion(q)} be possible? Thanks, ${ctx.user.firstName}`,
        ];
        bodyShort = candidates.find((x) => x.length <= LINKEDIN_NOTE_TARGET) ?? candidates[2]!;
        if (bodyShort.length > LINKEDIN_NOTE_MAX)
          bodyShort =
            `Hi ${first}, ${ctx.user.school} ${yl} here. ${short} ${minutes} minutes on your path? Thanks, ${ctx.user.firstName}`.slice(
              0,
              LINKEDIN_NOTE_MAX,
            );
        if (ctx.person.linkedinConnected) {
          body = `Hi ${first}, thanks for connecting. ${join(op?.text ?? openText, sit, bridge)} Would you have ${minutes} minutes in the next couple of weeks? Email is fine too if that's easier than a call.\n\nThanks,\n${ctx.user.firstName}`;
        }
        subject = undefined;
      }
      break;
    }
    case 'bump': {
      const n = ctx.bumpNumber ?? 1;
      if (n >= 2) {
        body = `${G}\n\n${pick([`Last note from me, I promise. If the next few weeks are too busy, no problem at all. If a ${minutes}-minute call ever does fit, I'll make the time work.`, `One last nudge and then I'll leave you be. If a ${minutes}-minute call fits at some point this cycle, I'd still be glad to take it, and no hard feelings if not.`], seed, 'bump2')}\n\n${S}`;
        claims.push({ text: 'second bump', kind: 'logistics' });
      } else {
        const topic =
          ctx.connection?.kind === 'transition' && ctx.connection.previous
            ? `, specifically because you moved from ${ctx.connection.previous} to ${org ?? 'your current role'}`
            : '';
        body = `${G}\n\n${pick(
          [
            `Floating this back up in case it got buried. I'd still love ${minutes} minutes whenever it's convenient${topic}, and if someone else on your team would be a better person to ask, I'd be grateful for a pointer.`,
            `Just surfacing my note from ${ctx.thread?.firstOutboundAt ? whenLabel(ctx.thread.firstOutboundAt, now, ctx.user.timezone).replace(/^on /, '') : 'last week'} in case it got buried. Totally understand if the timing isn't right; even ${minutes} minutes whenever it's convenient would help${topic}.`,
            `Following up on my note in case it got lost. I'd still value ${minutes} minutes in the next couple of weeks${topic}, and completely understand if now isn't a good time.`,
          ],
          seed,
          'bump1',
        )}\n\n${S}`;
        claims.push({ text: 'first bump in thread', kind: 'logistics' });
      }
      subject = undefined; // in thread
      break;
    }
    case 'schedule': {
      const tz = tzAbbr(ctx.user.timezone, now);
      const windows = (ctx.proposedWindows ?? []).slice(0, 2).map((w) => fmtWindow(w, ctx.user.timezone));
      const last = ctx.thread?.lastSignal;
      if (last === 'reschedule') {
        body = `${G}\n\nNo problem at all. Would ${windows.length === 2 ? `${windows[0]} or ${windows[1]} (${tz})` : windows[0] ? `${windows[0]} (${tz})` : 'another time next week'} work instead? If not, I'll take whatever is easiest for you.\n\n${S}`;
      } else if (ctx.missedProposal) {
        // they offered a time the student can no longer take: say so plainly before offering new ones
        const m = ctx.missedProposal;
        const when = m.startIso ? fmtWindow({ startIso: m.startIso }, ctx.user.timezone) : m.raw;
        const opener =
          m.reason === 'busy'
            ? `Thank you for suggesting ${when}. Unfortunately I have a conflict then.`
            : `I'm sorry I didn't get back to you in time for ${when}.`;
        const offer =
          windows.length === 2
            ? `Would either of these work instead? ${windows[0]} or ${windows[1]} (${tz}).`
            : windows.length === 1
              ? `Would ${windows[0]} (${tz}) work instead?`
              : 'Would another time next week work?';
        const alt = ctx.user.schedulingLink
          ? `If not, here's my calendar: ${ctx.user.schedulingLink}, or just send me a time and I'll make it fit.`
          : "If not, send me a time and I'll make it fit.";
        body = `${G}\n\n${opener} ${offer} ${alt}\n\n${S}`;
        claims.push({ text: `missed proposed time: ${when}`, kind: 'logistics' });
      } else {
        const offer =
          windows.length === 2
            ? `Would either of these work? ${windows[0]} or ${windows[1]} (${tz}).`
            : windows.length === 1
              ? `Would ${windows[0]} (${tz}) work?`
              : 'Would any time next week work?';
        const alt = ctx.user.schedulingLink
          ? `If neither does, here's my calendar: ${ctx.user.schedulingLink}, or just send me a time and I'll make it fit.`
          : "If neither does, send me a time and I'll make it fit.";
        body = `${G}\n\n${pick(["That's great, thank you.", 'Thank you, that would be great.'], seed, 'sched')} ${offer} ${alt.replace(/^If neither does/, windows.length === 2 ? 'If neither does' : 'If not')}\n\n${S}`;
      }
      claims.push({ text: 'proposed windows', kind: 'logistics' });
      subject = undefined;
      break;
    }
    case 'reply': {
      const asks = ctx.thread?.asksOfUser ?? [];
      const times = ctx.thread?.proposedTimes ?? [];
      const tz = tzAbbr(ctx.user.timezone, now);
      const parts: string[] = [];
      if (times.length) {
        const t = times[0]!;
        parts.push(
          `${fmtWindow({ startIso: t.startIso }, ctx.user.timezone)} ${tz} works perfectly. I'll send a calendar invite with a video link now; if you'd rather do phone, say so and I'll call whatever number is easiest.`,
        );
        claims.push({ text: `accepting ${t.raw}`, kind: 'logistics' });
      } else if (ctx.thread?.lastSignal === 'reschedule') {
        parts.push(
          "Totally understand. Would the week after work better? Send me a time and I'll make it fit, and even 15 minutes is plenty.",
        );
      } else {
        parts.push(
          pick(['Thanks for getting back to me.', "Thank you, that's really helpful."], seed, 'reply-open'),
        );
      }
      for (const a of asks.slice(0, 3)) {
        const t = strip(a);
        if (/resume|cv/i.test(t)) parts.push('On the resume: attached.');
        else if (/which (teams|groups|roles|areas)|what (teams|groups|roles|areas)/i.test(t))
          parts.push(
            `On teams, I'm most drawn to ${targetLabel(ctx)}${org ? ` at ${org}` : ''}, but I'm open and would rather hear where you think I'd fit.`,
          );
        else
          parts.push(
            `On your question about ${lower1(t.replace(/[.?]$/, ''))}: happy to, I'll send that over today.`,
          );
        claims.push({ text: `answers: ${t}`, kind: 'logistics' });
      }
      body = `${G}\n\n${parts.join(' ')}\n\n${times.length ? 'Looking forward to it.' : 'Thanks again.'}\n\n${S}`;
      subject = undefined;
      break;
    }
    case 'thank_you': {
      const when = whenLabel(ctx.chat?.completedAt, now, ctx.user.timezone);
      const advice = f(['advice']);
      const offer = f(['offer']);
      const hook = f(['hook', 'role_detail', 'background']);
      const specific = advice ?? hook;
      let line1: string;
      if (specific) {
        const t = dropPronoun(specific.text);
        line1 = advice
          ? pick(
              [
                `Your point that ${lower1(t)} is something I hadn't heard before, and I'm going to put it to use this week.`,
                `The thing that stuck with me was ${lower1(t)}. I've already started acting on it.`,
              ],
              seed,
              'ty1',
            )
          : `I kept thinking about what you said about ${lower1(t)}.`;
        claims.push({ text: specific.text, factId: specific.id, kind: 'about_person' });
      } else {
        line1 = pick(
          [
            'I learned more about how to approach this cycle in that half hour than in a month of reading.',
            "Hearing how you actually made your decisions was the most useful conversation I've had this cycle.",
          ],
          seed,
          'ty1b',
        );
      }
      let line2 = '';
      if (offer) {
        line2 = ` I'll follow up on ${lower1(dropPronoun(offer.text).replace(/^(offered|said|mentioned)\s+(to\s+)?/i, 'your offer to '))} when the timing is right, if that still works for you.`;
        claims.push({ text: offer.text, factId: offer.id, kind: 'about_person' });
      }
      body = `${G}\n\nThank you for making time ${when}. ${line1}${line2}\n\n${pick([`I'll let you know how ${ctx.user.cycleLabel.toLowerCase()} recruiting goes. Would it be alright to send a question your way if one comes up?`, `I'll keep you posted on how the search goes, and if there's ever anything I can do for you, please say so.`], seed, 'ty-close')}\n\n${S}`;
      subject = ctx.thread ? undefined : `Thank you for ${when.replace(/^on /, '')}`;
      break;
    }
    case 'nurture': {
      const hook = f(['hook', 'offer']);
      const advice = f(['advice']);
      const when = monthLabel(ctx.chat?.completedAt, now);
      const update = ctx.update?.trim();
      if (!update && !hook && !advice) needsInput.push('update');
      const parts: string[] = [];
      if (update)
        parts.push(
          `Quick update since we talked ${when}: ${strip(update)}.${advice ? ` Your line about ${lower1(dropPronoun(advice.text))} has been the most useful part of it.` : ''}`,
        );
      else if (advice)
        parts.push(
          `Quick note since we talked ${when}. I took your advice about ${lower1(dropPronoun(advice.text))} and it's been the most useful thing anyone told me this cycle.`,
        );
      if (hook) {
        parts.push(
          `${update || advice ? 'Also, you' : 'You'} mentioned ${lower1(dropPronoun(hook.text))}${/\?$/.test(hook.text) ? '' : '.'} How did that go?`,
        );
        claims.push({ text: hook.text, factId: hook.id, kind: 'about_person' });
      } else if (org) parts.push(`Hope things are going well at ${org}.`);
      if (advice) claims.push({ text: advice.text, factId: advice.id, kind: 'about_person' });
      body = `${G}\n\n${parts.join(' ')}\n\nNo reply needed, just wanted to stay in touch.\n\n${S}`;
      subject = ctx.thread ? undefined : `Quick update since ${when.replace(/^in /, '')}`;
      break;
    }
    case 'congratulate': {
      const what =
        ctx.newAffiliation?.title && ctx.newAffiliation.org
          ? `the move to ${ctx.newAffiliation.title} at ${ctx.newAffiliation.org}`
          : ctx.newAffiliation?.org
            ? `the move to ${ctx.newAffiliation.org}`
            : ctx.newAffiliation?.title
              ? `the new role as ${ctx.newAffiliation.title}`
              : 'the news';
      const tie = f(['advice', 'hook', 'preference']);
      claims.push({ text: `new role: ${what}`, kind: 'about_person' });
      if (tie) claims.push({ text: tie.text, factId: tie.id, kind: 'about_person' });
      body = `${G}\n\nJust saw ${what}. Congratulations${tie ? `, that fits what you said about ${lower1(dropPronoun(tie.text))}` : ', well deserved'}. Hope the first weeks are going well.\n\n${S}`;
      subject = ctx.thread ? undefined : 'Congratulations';
      break;
    }
    case 'referral_ask': {
      const tc = ctx.targetCompany;
      const offer = f(['offer']);
      const advice = f(['advice']);
      const company = tc?.name ?? org ?? 'your company';
      const role =
        tc?.roleLabel ?? `${targetLabel(ctx)} ${/intern/i.test(ctx.user.cycleLabel) ? 'internship' : 'role'}`;
      const req = tc?.reqId
        ? ` (req ${tc.reqId}${tc.link ? ', link below' : ''})`
        : tc?.link
          ? ' (link below)'
          : '';
      const when = ctx.chat?.completedAt
        ? whenLabel(ctx.chat.completedAt, now, ctx.user.timezone)
        : undefined;
      const open = offer
        ? `When we spoke${when ? ` ${when}` : ''} you kindly offered to ${lower1(dropPronoun(offer.text).replace(/^(offered|said|mentioned|happy)\s+(to\s+)?/i, ''))}, so I wanted to follow up.`
        : when
          ? `Thanks again for the conversation ${when}.`
          : "I wanted to ask a small favor, with zero pressure if it isn't a fit.";
      if (offer) claims.push({ text: offer.text, factId: offer.id, kind: 'about_person' });
      // One memory anchor is enough: the offer line if they offered, otherwise their advice.
      const why =
        advice && !offer
          ? ` What you said about ${lower1(dropPronoun(advice.text))} is a big part of why I'm applying here first.`
          : '';
      if (advice && !offer) claims.push({ text: advice.text, factId: advice.id, kind: 'about_person' });
      const timing =
        sector === 'tech' && !tc?.applied
          ? 'before I submit through the portal'
          : tc?.applied
            ? 'this morning'
            : 'this week';
      const fit =
        ctx.user.credibility && !offer
          ? ` Most relevant thing I've done: ${lower1(strip(ctx.user.credibility))}.`
          : '';
      const askLine =
        sector === 'tech'
          ? `Would you be willing to refer me${timing === 'before I submit through the portal' ? ' before I submit through the portal' : ''}?`
          : `If you'd be comfortable flagging my name to the recruiting team, I'd be grateful.`;
      body = `${G}\n\n${open}${why} I'm applying for the ${role} at ${company}${req}${timing === 'this morning' ? ', submitted this morning' : ''}.${fit} ${askLine} Resume and link are ready to send so it's a two-minute task. Completely fine if not; I know a referral has your name on it.\n\n${S}`;
      subject = tc?.applied
        ? `Quick update + applied to ${company} ${role}`
        : `${company} ${role}, a small ask`;
      if (tc?.link) body = body.replace(`\n\n${S}`, `\n\n${tc.link}\n\n${S}`);
      break;
    }
    case 'intro_request': {
      const t = ctx.target;
      const tName = t?.name ?? 'them';
      const tFirst = t?.firstName ?? tName.split(' ')[0];
      const why =
        t?.why ??
        (t?.org
          ? `how ${t.org} thinks about ${targetLabel(ctx)} hiring`
          : `their work in ${targetLabel(ctx)}`);
      const cred = ctx.user.credibility
        ? ` ${ctx.user.firstName} ${lower1(strip(ctx.user.credibility))}, and`
        : ` ${ctx.user.firstName}`;
      const link =
        ctx.connection?.kind === 'shared_employer' && ctx.connection.sharedOrg
          ? ` I noticed you two worked together at ${ctx.connection.sharedOrg}.`
          : ctx.connection?.text
            ? ` ${ctx.connection.text}.`
            : '';
      const blurb = `"${ctx.user.fullName} is ${me}, recruiting for ${targetLabel(ctx)} ${/intern/i.test(ctx.user.cycleLabel) ? 'internships' : 'roles'}.${cred} would love 15 minutes to hear how ${tFirst} ${t?.title ? `approaches ${lower1(t.title)} work` : `thinks about ${why}`}${t?.org ? ` at ${t.org}` : ''}."`;
      body = `${G}\n\nSmall ask. I'm trying to learn ${why}, and I'd love to talk with ${tName}${t?.title ? ` (${t.title}${t.org ? ` at ${t.org}` : ''})` : t?.org ? ` at ${t.org}` : ''}.${link} If you'd be comfortable making a short intro, here's something you could forward:\n\n${blurb}\n\nAnd if it's not a good fit to ask, no worries at all.\n\n${S}`;
      claims.push({ text: `target: ${tName}`, kind: 'logistics' });
      subject = `Small ask: intro to ${tName}?`;
      if (t?.offered) {
        // following up on an intro they offered: name the offer, make forwarding a two-second task
        const offerBlurb = `"${ctx.user.fullName} is ${me}, recruiting for ${targetLabel(ctx)} ${/intern/i.test(ctx.user.cycleLabel) ? 'internships' : 'roles'}.${cred} would love 15 minutes to hear about your work${t.org ? ` at ${t.org}` : ''}."`;
        body = `${G}\n\nWhen we spoke, you kindly offered to introduce me to ${tName}. If that's still easy, here's a short note you could forward so it takes no time:\n\n${offerBlurb}\n\nAnd if the timing isn't right anymore, no worries at all. Thanks again for offering.\n\n${S}`;
        subject = ctx.thread ? undefined : `Intro to ${tName}`;
      }
      break;
    }
    case 'report_back': {
      const rb = ctx.reportBack;
      const tName = rb?.targetName ?? 'them';
      const line = rb?.line ? ` ${strip(rb.line)}.` : '';
      const outcome =
        rb?.outcome === 'spoke'
          ? `We spoke ${rb?.when ?? 'last week'}${line}`
          : rb?.outcome === 'declined'
            ? `${tName.split(' ')[0]} couldn't make time this cycle, which is completely fair, and I appreciate you trying.`
            : `I haven't heard back yet, but I wanted you to know I followed up on it.`;
      body = `${G}\n\nQuick note to say thank you for the intro to ${tName}. ${outcome} Really appreciate you making it happen, and I'll keep you posted on how recruiting goes.\n\n${S}`;
      claims.push({ text: `report back on ${tName}`, kind: 'logistics' });
      subject = ctx.thread ? undefined : `Thank you for the intro to ${tName.split(' ')[0]}`;
      break;
    }
  }
  if (subject && BANNED_SUBJECT_PATTERNS.some((re) => re.test(subject!)))
    subject = `Quick question about ${org ?? 'your path'}`;
  const out: DraftOutput = {
    subject,
    body: body.replace(/[ \t]+\n/g, '\n').trim(),
    bodyShort,
    claims,
    needsInput,
    opening: firstSentence(body),
    sector,
    register,
  };
  return out;
}

function shortQuestion(q: string): string {
  return q.replace(/ and what (you'd|you would) do differently.*$/, '').replace(/^how /, 'how ');
}

/** One short clause for the LinkedIn note, from the connection. */
function shortConnection(ctx: DraftContext, c: Connection, sector: Sector, seed: string): string {
  const org = ctx.person.org;
  switch (c.kind) {
    case 'referral':
      return c.introduced
        ? `Following up on ${c.referrerName ?? 'our mutual contact'}'s introduction.`
        : `${c.referrerName ?? 'A mutual contact'} suggested I write to you.`;
    case 'event':
      return `We met at ${c.eventName ?? 'the event'}.`;
    case 'alumni':
      return `Found you on the ${ctx.user.school} alumni page${org ? ` at ${org}` : ''}.`;
    case 'transition':
      return `Saw you went from ${c.previous} to ${org ?? 'your current role'}, which is the path I'm trying to understand.`;
    case 'shared_employer':
      return `We overlap on ${c.sharedOrg}; I interned there.`;
    case 'post':
    case 'warmup':
      return `Read your post on ${lower1(c.text)}.`;
    case 'hook':
      return `${strip(c.text).replace(/^you /i, 'Saw you ')}.`;
    case 'user_supplied':
      return `${strip(c.text)}.`;
  }
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
      !/^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks)[,!.]?$/i.test(
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
