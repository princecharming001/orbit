/**
 * Why someone is suggested: the reasons a Discover card gives ("Why them"), each from a signal the account holds,
 * strongest first. A card leads with one sentence that says why this person is worth writing to (whySummary), then
 * the reasons as full sentences with the specifics: what they do and where, what they share with the student, what
 * has passed between them and when, who could introduce them, and what changed lately.
 *
 * Nothing here is guessed: a line is written only from a signal the caller found in the data (a target company
 * matched by name, people you both know by name, the date they replied, the subject of the thread), and a detail the
 * account does not hold is left out of the sentence rather than filled in. Message bodies are never quoted: the most a
 * line says of a conversation is its date, who wrote last, how many messages passed and its subject line.
 */
import { article } from '../drafts/phrasing';

export type WhyKind =
  /** their role or company is what the student is aiming for */
  | 'goal'
  | 'industry'
  | 'school'
  /** people you both know, by name, or a count when LinkedIn gives only that */
  | 'mutuals'
  /** someone the student knows works at their company */
  | 'colleague'
  | 'past_employer'
  | 'city'
  | 'role_change'
  /** someone who could introduce the student */
  | 'warm_path'
  /** what has already passed between them: a reply, a meeting, a message, a connection */
  | 'history'
  /** like people the student wrote to */
  | 'like'
  /** the search that found them, when nothing else is known */
  | 'search'
  /** the honest line when the account holds little about them */
  | 'thin';

/** Someone a reason names, so a card can link the name to their page. */
export interface WhyPerson {
  id: string;
  /** the name exactly as the reason's text writes it */
  name: string;
}

export interface WhyReason {
  kind: WhyKind;
  /** the reason as a full sentence, with the specifics the account holds */
  text: string;
  /** 0..100, what the line is worth against the others on the card */
  strength: number;
  /**
   * A specific reason to meet them, enough on its own to put them on Discover: `goal` ties them to what the student is
   * aiming for (a target company, an alum in the field, an employer on both resumes), `tie` is a real way in (someone
   * named who can introduce them, people the student knows, a reply). A line without it (a role true of thousands, a
   * count of mutual connections, a LinkedIn connection, the city) only adds to one that has it.
   */
  anchor?: 'goal' | 'tie';
  /**
   * The same reason as a predicate after their first name ("works at Stripe, one of your top target companies"), for
   * the card's one-sentence summary. Absent on a line that is no reason to write on its own (the city, a count of
   * mutual connections, a LinkedIn connection, the search that found them).
   */
  clause?: string;
  /** people the text names, to link to their pages */
  people?: WhyPerson[];
  /** a reason to write now rather than some day: a new role, a message from them lately */
  timely?: boolean;
}

/** The signals one person's reasons are built from. A field left out is a signal the account does not have. */
export interface WhySignals {
  /** their first name, for the summary sentence and for lines that name them */
  firstName?: string;
  title?: string;
  company?: string;
  headline?: string;
  /** when they started their current role, when the date on record is the real start (not when an import saw it) */
  since?: string;
  goal?: {
    /** their company is on the target list */
    company?: { name: string; priority?: 1 | 2 | 3 };
    /** they hold a role the student targets, and the target function it meets when one does ("product management") */
    role?: { title: string; function?: string };
    /** their company or work is in an industry on the student's list, as the student wrote it */
    industry?: string;
  };
  /** they went to the student's school, with what else is known about their time there */
  school?: {
    name: string;
    gradYear?: number;
    myGradYear?: number;
    /** their field when it is the student's major too */
    program?: string;
    /** their degree as their profile writes it ("BS", "MBA") */
    degree?: string;
  };
  /**
   * People you both know: first names, or the people themselves (with how they know this person, when a tie on record
   * says), or how many when LinkedIn gives a count and no names
   */
  mutuals?: {
    names?: string[];
    count?: number;
    people?: { id: string; name: string; firstName: string; how?: string }[];
  };
  colleague?: { name: string; company: string; id?: string };
  /** an employer on both résumés: how the student was there, and whether they are still there */
  pastEmployers?: {
    name: string;
    mine: 'interned' | 'worked' | 'now';
    theirs: 'now' | 'before';
    /** their title there */
    theirTitle?: string;
    /** their years there ("2021 to 2023", "since 2022") */
    theirYears?: string;
    /** when the student was there ("2025", "2024 to 2025") */
    myYears?: string;
  }[];
  city?: { name: string; why: 'target' | 'home' | 'current' };
  /** they started their current role lately */
  roleChange?: {
    monthsAgo: number;
    company?: string;
    title?: string;
    moved?: boolean;
    /** the date of the change, when the account has it */
    at?: string;
    /** the job before, when it ended where this one began */
    fromCompany?: string;
    fromTitle?: string;
    /** a step up at the same employer */
    promoted?: boolean;
    /** the move from one field to another that the student is trying to make too ("consulting" to "product") */
    sameSwitch?: { from: string; to: string };
  };
  warmPath?: {
    name: string;
    id?: string;
    /** their full name, when the card can name them in full */
    fullName?: string;
    /** what ties them to this person, after their name ("worked with Maya at Ramp (2021 to 2023)") */
    how?: string;
  };
  history?: {
    /** they answered a message of the student's */
    repliedAt?: string;
    /** they wrote first */
    theyWroteAt?: string;
    /** the student wrote to them */
    wroteAt?: string;
    metAt?: string;
    connectedOn?: string;
    /** a little closeness on record without a dated event */
    knownALittle?: boolean;
    /** the conversation, counted: messages each way, the channel, its first and last dates, who wrote last */
    talk?: {
      fromThem: number;
      fromYou: number;
      channel?: 'email' | 'LinkedIn' | 'text' | 'mixed';
      firstAt?: string;
      lastAt?: string;
      lastFrom?: 'them' | 'you';
      /** the subject line of the latest thread with them */
      subject?: string;
    };
    /** meetings on record with them */
    meetings?: number;
    /** what else is on record when you know each other a little ("copied on 3 emails together") */
    touches?: string[];
    /** the latest of those */
    lastTouchAt?: string;
  };
  now: Date;
}

/** How many reasons a card holds at most, the honest line aside. */
export const WHY_MAX = 4;

/** Ties in strength go in this order. */
const KIND_ORDER: WhyKind[] = [
  'goal',
  'warm_path',
  'mutuals',
  'colleague',
  'history',
  'past_employer',
  'school',
  'like',
  'role_change',
  'city',
  'industry',
  'search',
  'thin',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const valid = (iso: string | undefined): Date | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const monthsBetween = (d: Date, now: Date) =>
  (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();

/** "March", or "March 2025" when it was more than eleven months ago. */
export function monthOf(iso: string, now: Date): string | undefined {
  const d = valid(iso);
  if (!d) return undefined;
  const name = MONTHS[d.getMonth()]!;
  return monthsBetween(d, now) > 11 ? `${name} ${d.getFullYear()}` : name;
}

/** "May 12", or "May 12, 2025" when it was more than eleven months ago. */
export function dayOf(iso: string | undefined, now: Date): string | undefined {
  const d = valid(iso);
  if (!d) return undefined;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return monthsBetween(d, now) > 11 ? `${day}, ${d.getFullYear()}` : day;
}

/** How long ago, in the unit a person would use: "3 days ago", "5 weeks ago", "4 months ago", "2 years ago". */
export function agoOf(iso: string | undefined, now: Date): string | undefined {
  const d = valid(iso);
  if (!d) return undefined;
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 0) return undefined;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365.25);
  return years <= 1 ? 'over a year ago' : `${years} years ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "three times", "12 times" */
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${NUMBER_WORDS[n] ?? n} times`);

const listNames = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** "You both know Nitin and Ana", "You both know Nitin, Ana and 2 others". */
export function mutualsLine(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  if (!rest) return `You both know ${listNames(shown)}`;
  return `You both know ${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/** "a Product Manager", "an Analyst" */
const withArticle = (title: string) => `${article(title)} ${title}`;

/** An industry as the student wrote it, in a sentence: "fintech", but "AI" stays in capitals. */
const industryWord = (s: string) => {
  const t = s.trim();
  return /^[A-Z0-9&]{2,}$/.test(t) || /[A-Z].*[A-Z]/.test(t) ? t : t.toLowerCase();
};

/** A subject line as a card shows it: no "Re:" or "Fwd:", one line, at most about sixty characters, in quotes. */
export function subjectLine(subject: string | undefined): string | undefined {
  let s = (subject ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) s = s.replace(/^(re|fw|fwd|aw)\s*:\s*/i, '').trim();
  if (s.length < 3) return undefined;
  if (s.length > 64) s = `${s.slice(0, 61).replace(/\s+\S*$/, '')}…`;
  return `“${s}”`;
}

const yearsApart = (mine: number, theirs: number): string => {
  const d = mine - theirs;
  if (d === 0) return 'the same class year as you';
  const n = Math.abs(d);
  return `${n} year${n === 1 ? '' : 's'} ${d > 0 ? 'ahead of' : 'behind'} you`;
};

const monthsAgoPhrase = (n: number): string => (n <= 0 ? 'this month' : n === 1 ? '1 month' : `${n} months`);

/** Specific reasons first (a card always leads with why to meet them), then by strength. */
function order(reasons: WhyReason[]): WhyReason[] {
  return [...reasons].sort(
    (a, b) =>
      (b.anchor ? 1 : 0) - (a.anchor ? 1 : 0) ||
      b.strength - a.strength ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/**
 * Options for a reasons block. `filler: false` (Discover) leaves out the lines that only fill space: the honest
 * "little known" line (Discover shows nobody it would fit) and the search that found them.
 */
export interface WhyOptions {
  filler?: boolean;
}

/** The honest line for a card with little behind it: what is actually on record. */
function thinLine(
  real: number,
  c: Pick<WhySignals, 'title' | 'company' | 'headline'>,
): WhyReason | undefined {
  if (real >= 2) return undefined;
  let text: string;
  if (real === 1) text = "That's all Orbit knows about them so far.";
  else if (c.headline) text = 'Only their LinkedIn headline so far.';
  else if (c.title || c.company) text = 'Only their title and company so far.';
  else text = 'Not much known about them yet.';
  return { kind: 'thin', text, strength: 0 };
}

/** "one of your top target companies" for a first priority, else "on your target list". */
const targetWords = (priority?: 1 | 2 | 3) =>
  priority === 1
    ? { is: 'one of your top target companies', short: 'one of your top target companies' }
    : { is: 'on your target list', short: 'a company on your target list' };

/** "the software engineering roles you are aiming for", or the plain words when the function is not known. */
const roleWant = (fn?: string) =>
  fn ? `the ${fn} work you are aiming for` : 'the kind of role you are aiming for';

/**
 * The reasons for one person, strongest first, at most WHY_MAX; with fewer than two real ones, a last line says how
 * little is on record. Every line is written from a signal in `s`; a signal absent is a line absent, and a detail
 * absent is left out of its line.
 */
export function whyThem(s: WhySignals, opts: WhyOptions = {}): WhyReason[] {
  const out: WhyReason[] = [];
  const say = (
    kind: WhyKind,
    text: string,
    strength: number,
    anchor?: 'goal' | 'tie',
    extra: Pick<WhyReason, 'clause' | 'people' | 'timely'> = {},
  ) => {
    const r: WhyReason = anchor ? { kind, text, strength, anchor } : { kind, text, strength };
    if (extra.clause) r.clause = extra.clause;
    if (extra.people?.length) r.people = extra.people;
    if (extra.timely) r.timely = true;
    out.push(r);
  };
  const first = s.firstName?.trim() || undefined;
  const sinceWhen = (() => {
    const d = valid(s.since);
    return d ? ` since ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
  })();

  // ---- goals: the role and company the student is aiming for ----
  const g = s.goal;
  // an alum in the role the student wants: one line says both (the school's own line then adds the class year)
  const alumInField = !!(g?.role && !g.company && s.school);
  const where = s.company ? ` at ${s.company}` : '';
  if (g?.company && g.role) {
    const t = targetWords(g.company.priority);
    say(
      'goal',
      `${g.role.title} at ${g.company.name}${sinceWhen}. ${g.company.name} is ${t.is}, and this is ${roleWant(g.role.function)}.`,
      100,
      'goal',
      { clause: `is ${withArticle(g.role.title)} at ${g.company.name}, ${t.short}` },
    );
  } else if (g?.company) {
    const t = targetWords(g.company.priority);
    const as = s.title ? ` as ${withArticle(s.title)}` : '';
    say(
      'goal',
      `Works at ${g.company.name}${as}${sinceWhen}. ${g.company.name} is ${t.is}.`,
      g.company.priority === 1 ? 90 : 85,
      'goal',
      { clause: `works at ${g.company.name}, ${t.short}` },
    );
  } else if (alumInField && g?.role) {
    const field = g.role.function
      ? `, ${roleWant(g.role.function)}`
      : ', the kind of role you are aiming for';
    say(
      'goal',
      `Went to ${s.school!.name}, like you, and is now ${withArticle(g.role.title)}${where}${field}.`,
      92,
      'goal',
      { clause: `is a fellow ${s.school!.name} alum, now ${withArticle(g.role.title)}${where}` },
    );
  } else if (g?.role && g.industry) {
    const ind = industryWord(g.industry);
    say(
      'goal',
      `Works as ${withArticle(g.role.title)}${where}, in ${ind}, one of the industries on your list.`,
      84,
      'goal',
      { clause: `is ${withArticle(g.role.title)}${where}, in ${ind}` },
    );
  } else if (g?.role) {
    say(
      'goal',
      `Works as ${withArticle(g.role.title)}${where}${sinceWhen}, ${roleWant(g.role.function)}.`,
      62,
      undefined,
      {
        clause: `is ${withArticle(g.role.title)}${where}, the kind of role you want`,
      },
    );
  }
  if (g?.industry && !g.company && !g.role) {
    const ind = industryWord(g.industry);
    say('industry', `Works in ${ind}${where}, one of the industries on your list.`, 40, undefined, {
      clause: `works in ${ind}, an industry on your list`,
    });
  }

  // ---- a way in: someone who can introduce them, people you both know ----
  if (s.warmPath) {
    const w = s.warmPath;
    const name = w.fullName || w.name;
    const how = w.how?.trim();
    say(
      'warm_path',
      how
        ? `${name}, who ${how}, could introduce you.`
        : `${name} is your warmest way in and could introduce you.`,
      88,
      'tie',
      {
        clause: `is one introduction away through ${w.name}`,
        people: w.id ? [{ id: w.id, name }] : undefined,
      },
    );
  }
  // "Chaya could introduce you" already says the student knows Chaya
  const mates = (s.mutuals?.people ?? []).filter((p) => p.firstName && p.name);
  const names = mates.length ? mates.map((p) => p.firstName) : (s.mutuals?.names ?? []).filter(Boolean);
  const drop =
    !!s.warmPath &&
    names.length === 1 &&
    (names[0] === s.warmPath.name || (!!s.warmPath.id && mates[0]?.id === s.warmPath.id));
  if (drop) names.length = 0;
  if (names.length) {
    const full = mates.length ? mates.map((p) => p.name) : names;
    const n = full.length;
    const shown = full.slice(0, 3);
    // how one of them knows this person, when a tie on record says: not the introducer's, which their own line says
    const teller = mates
      .slice(0, 3)
      .find(
        (m) => m.how && !(s.warmPath?.how && (m.id === s.warmPath.id || m.firstName === s.warmPath.name)),
      );
    const howFirst = teller ? ` ${teller.firstName} ${teller.how}.` : '';
    const text =
      n === 1
        ? `Knows ${shown[0]}, whom you know well.${howFirst}`
        : n <= 3
          ? `Knows ${listNames(shown)}, ${n === 2 ? 'both' : 'all three'} people you know well.${howFirst}`
          : `Knows ${n} people you know well, including ${listNames(shown)}.${howFirst}`;
    say('mutuals', text, Math.min(96, 86 + 2 * n), 'tie', {
      clause:
        n === 1
          ? `knows ${names[0]}, whom you know well`
          : n <= 3
            ? `knows ${listNames(names)}, ${n === 2 ? 'two' : 'three'} people you know well`
            : `knows ${n} people you know well, including ${listNames(names.slice(0, 2))}`,
      people: mates.slice(0, 3).map((p) => ({ id: p.id, name: p.name })),
    });
  } else if (s.mutuals?.count)
    say(
      'mutuals',
      `LinkedIn shows ${plural(s.mutuals.count, 'mutual connection')} between you.`,
      35 + Math.min(15, s.mutuals.count),
    );
  if (s.colleague) {
    const c = s.colleague;
    say(
      'colleague',
      `${c.name}, whom you know well, also works at ${c.company} and could introduce you.`,
      86,
      'tie',
      {
        clause: `can be introduced by ${c.name.split(/\s+/)[0]}, a colleague of theirs whom you know well`,
        people: c.id ? [{ id: c.id, name: c.name }] : undefined,
      },
    );
  }

  // ---- what has already passed between you ----
  const h = s.history;
  if (h) {
    const t = h.talk;
    const via = t?.channel && t.channel !== 'mixed' ? ` ${t.channel === 'text' ? 'text' : t.channel}` : '';
    const about = subjectLine(t?.subject);
    const aboutPart = about ? ` about ${about}` : '';
    const recent = (iso?: string) => {
      const d = valid(iso);
      return !!d && s.now.getTime() - d.getTime() < 60 * 86_400_000;
    };
    if (h.metAt && monthOf(h.metAt, s.now)) {
      const more = h.meetings && h.meetings > 1 ? `, the last of ${h.meetings} meetings with them` : '';
      const ago = agoOf(h.metAt, s.now);
      say('history', `You met on ${dayOf(h.metAt, s.now)}${more}${ago ? `, ${ago}` : ''}.`, 80, 'tie', {
        clause: `met you in ${monthOf(h.metAt, s.now)}`,
      });
    } else if (h.repliedAt && monthOf(h.repliedAt, s.now)) {
      const total = (t?.fromThem ?? 0) + (t?.fromYou ?? 0);
      const unanswered = t?.lastFrom === 'them';
      const text =
        total >= 3 && t?.firstAt && monthOf(t.firstAt, s.now)
          ? `You have written to each other ${times(total)}${via ? ` over${via}` : ''} since ${monthOf(t.firstAt, s.now)}${aboutPart}; the last was ${unanswered ? `their reply on ${dayOf(t.lastAt ?? h.repliedAt, s.now)}` : `your message on ${dayOf(t.lastAt, s.now)}`}.`
          : `Replied on ${dayOf(h.repliedAt, s.now)} to your${via || ' message'}${via ? ' message' : ''}${aboutPart}${unanswered ? '; you have not written back since' : ''}.`;
      say('history', text, 78, 'tie', {
        clause: `replied to you in ${monthOf(h.repliedAt, s.now)}`,
        timely: recent(h.repliedAt) && unanswered,
      });
    } else if (h.theyWroteAt && monthOf(h.theyWroteAt, s.now)) {
      const unanswered = !t || t.lastFrom === 'them';
      const more = t && t.fromThem > 1 ? `, the last of ${plural(t.fromThem, 'message')} from them` : '';
      say(
        'history',
        `Wrote to you${via ? ` on${via}` : ''} on ${dayOf(h.theyWroteAt, s.now)}${aboutPart}${more}${unanswered ? '; you have not replied yet' : ''}.`,
        74,
        'tie',
        { clause: `wrote to you in ${monthOf(h.theyWroteAt, s.now)}`, timely: recent(h.theyWroteAt) },
      );
    } else if (h.wroteAt && monthOf(h.wroteAt, s.now)) {
      const ago = agoOf(h.wroteAt, s.now);
      const n = t?.fromYou ?? 0;
      say(
        'history',
        `You wrote to them${via ? ` on${via}` : ''} on ${dayOf(h.wroteAt, s.now)}${aboutPart}${n > 1 ? ` (${plural(n, 'message')} in all)` : ''} and have not heard back${ago ? `; that was ${ago}` : ''}.`,
        55,
      );
    } else if (h.knownALittle) {
      const what = (h.touches ?? []).filter(Boolean).slice(0, 3);
      const last = monthOf(h.lastTouchAt ?? '', s.now);
      say(
        'history',
        what.length
          ? `You already know each other a little: ${listNames(what)}${last ? `, most recently in ${last}` : ''}.`
          : 'You already know each other a little, from what Orbit has on record.',
        45,
        'tie',
        { clause: 'already knows you a little' },
      );
    } else if (h.connectedOn && valid(h.connectedOn)) {
      const d = valid(h.connectedOn)!;
      say(
        'history',
        `Connected with you on LinkedIn since ${MONTHS[d.getMonth()]} ${d.getFullYear()}, though you have not written to each other.`,
        30,
      );
    }
  }

  // ---- shared ground: an employer, the school, the city ----
  for (const e of s.pastEmployers ?? []) {
    const mineVerb = e.mine === 'interned' ? 'interned' : e.mine === 'now' ? 'work now' : 'worked';
    const myWhen = e.myYears && e.mine !== 'now' ? ` in ${e.myYears}` : '';
    if (e.mine === 'now' && e.theirs === 'now')
      say(
        'past_employer',
        `You both work at ${e.name}${e.theirTitle ? `; ${first ?? 'they'} ${first ? 'is' : 'are'} ${withArticle(e.theirTitle)} there` : ''}.`,
        82,
        'goal',
        { clause: `works at ${e.name} with you` },
      );
    else if (e.theirs === 'now')
      say(
        'past_employer',
        `Works at ${e.name}${e.theirTitle ? ` as ${withArticle(e.theirTitle)}` : ''}, where you ${mineVerb}${myWhen}.`,
        76,
        'goal',
        { clause: `works at ${e.name}, where you ${mineVerb}` },
      );
    else {
      const theirs = [e.theirTitle, e.theirYears].filter(Boolean).join(', ');
      say(
        'past_employer',
        `Also worked at ${e.name}${theirs ? ` (${theirs})` : ''}, where you ${mineVerb}${myWhen}.`,
        72,
        'goal',
        { clause: `also worked at ${e.name}, where you ${mineVerb}` },
      );
    }
  }
  if (s.school) {
    const { name, gradYear, myGradYear, program, degree } = s.school;
    const study = [degree, program].filter(Boolean).join(' ');
    const paren = [study, gradYear ? `class of ${gradYear}` : ''].filter(Boolean).join(', ');
    const tail = program
      ? alumInField
        ? ', the same major as you'
        : ', the same school and major as you'
      : gradYear && myGradYear
        ? `, ${yearsApart(myGradYear, gradYear)}`
        : '';
    const text = alumInField
      ? `Graduated from ${name}${paren ? ` (${paren})` : ''}${tail}.`
      : `Also went to ${name}${paren ? ` (${paren})` : ''}${tail}.`;
    const clause = alumInField
      ? undefined
      : program
        ? `also studied ${program} at ${name}`
        : `also went to ${name}`;
    if (gradYear && myGradYear) say('school', text, 76, undefined, { clause });
    else if (program) say('school', text, 75, undefined, { clause });
    else if (gradYear) say('school', text, 72, undefined, { clause });
    else if (!alumInField) say('school', text, 70, undefined, { clause });
  }
  if (s.city)
    say(
      'city',
      s.city.why === 'target'
        ? `Based in ${s.city.name}, one of the places you want to work.`
        : s.city.why === 'current'
          ? `Based in ${s.city.name}, where you live now.`
          : `Based in ${s.city.name}, where you are from.`,
      s.city.why === 'target' ? 45 : 35,
    );

  // ---- why now ----
  if (s.roleChange && s.roleChange.monthsAgo < 12) {
    const r = s.roleChange;
    const at = r.at && monthOf(r.at, s.now);
    const when = at ? `in ${at}` : r.monthsAgo <= 0 ? 'this month' : `${monthsAgoPhrase(r.monthsAgo)} ago`;
    let text: string;
    let clause: string;
    if (r.promoted && r.title) {
      text = `Was promoted to ${r.title}${r.company ? ` at ${r.company}` : ''} ${when}${r.fromTitle ? `, from ${r.fromTitle}` : ''}: a good moment to congratulate them and reconnect.`;
      clause = `was promoted to ${r.title} ${when}`;
    } else if (r.moved && r.company) {
      const from = r.fromCompany ? `from ${r.fromCompany} ` : '';
      text = r.sameSwitch
        ? `Moved from ${r.sameSwitch.from}${r.fromCompany ? ` at ${r.fromCompany}` : ''} to ${r.sameSwitch.to} at ${r.company} ${when}, the same switch you are trying to make.`
        : `Moved ${from}to ${r.company} ${when}${r.title ? ` as ${withArticle(r.title)}` : ''}: a good moment to congratulate them.`;
      clause = r.sameSwitch
        ? `made the move from ${r.sameSwitch.from} to ${r.sameSwitch.to} you are trying to make`
        : `moved to ${r.company} ${when}`;
    } else {
      text = `Started ${r.title ? `as ${withArticle(r.title)}` : 'their current role'}${r.company ? ` at ${r.company}` : ''} ${when}.`;
      clause = `started a new role ${when}`;
    }
    say('role_change', text, 50, undefined, { clause, timely: true });
  }

  const kept = order(out).slice(0, WHY_MAX);
  const thin = opts.filler === false ? undefined : thinLine(kept.length, s);
  return thin ? [...kept, thin] : kept;
}

/** Kinds that can join the lead in the summary: each says something about this person in particular. */
const SUMMARY_KINDS = new Set<WhyKind>([
  'goal',
  'warm_path',
  'mutuals',
  'colleague',
  'history',
  'past_employer',
  'school',
  'role_change',
  'like',
]);

/** The summary sentence at most this long; a second reason that would push past it is left to its own line. */
const SUMMARY_MAX = 230;

/**
 * Kinds whose summary clause says all their line does (what they do and where, an employer or school you share), so
 * their line is not repeated under the summary. The others (a way in, your history, a new role) keep their line: it
 * holds what the clause leaves out (the introducer's full name and how they know them, the dates, the subject).
 */
const SAID_IN_FULL = new Set<WhyKind>(['goal', 'past_employer', 'school', 'industry']);

/** A card's "Why them": the sentence it leads with, and the reasons under it. */
export interface WhyCard {
  summary?: string;
  bullets: WhyReason[];
}

/**
 * The one sentence a card leads with, why this person, now ("Worth writing to because Maya works at Stripe, one of
 * your top target companies, and replied to you in September."), and the reasons to show under it. The sentence is
 * built from the lead reason and, when it fits, the next one that says something about them in particular (a way
 * in, your history, what you share, a new role), what they do first. There is no sentence when the lead is no reason
 * on its own (the honest line, the search that found them); then every reason is a line.
 */
export function whyCard(reasons: WhyReason[], firstName?: string): WhyCard {
  const lead = reasons[0];
  if (!lead?.clause) return { bullets: reasons };
  const who = firstName?.trim() || 'this person';
  let second = reasons
    .slice(1)
    .find(
      (r) =>
        r.clause &&
        r.kind !== lead.kind &&
        SUMMARY_KINDS.has(r.kind) &&
        (r.anchor || r.timely || r.kind === 'school' || r.kind === 'like'),
    );
  const sentence = (parts: WhyReason[]) => {
    // what they do reads first: "works at Stripe, ..., and is one introduction away through Lena"
    const [a, b] = parts.length === 2 && parts[1]!.kind === 'goal' ? [parts[1]!, parts[0]!] : parts;
    const now = parts.some((p) => p.timely) ? ' now' : '';
    return `Worth writing to${now} because ${who} ${a!.clause}${b ? `, and ${b.clause}` : ''}.`;
  };
  let summary = sentence(second ? [lead, second] : [lead]);
  if (summary.length > SUMMARY_MAX) {
    second = undefined;
    summary = sentence([lead]);
  }
  const used = new Set([lead, ...(second ? [second] : [])]);
  return { summary, bullets: reasons.filter((r) => !(used.has(r) && SAID_IN_FULL.has(r.kind))) };
}

/** The sentence a card leads with (whyCard), for a place that shows only that: a pick, the morning brief, the chat. */
export function whySummary(reasons: WhyReason[], firstName?: string): string | undefined {
  return whyCard(reasons, firstName).summary;
}

/** What each of Discover's reason codes (scoreDiscoverCandidate, recommendPeople) is, and what it is worth. */
const CODE: Record<string, { kind: WhyKind; strength: number; anchor?: 'goal' | 'tie' }> = {
  referred: { kind: 'warm_path', strength: 92, anchor: 'tie' },
  path: { kind: 'warm_path', strength: 60 },
  colleague: { kind: 'colleague', strength: 86, anchor: 'tie' },
  alumni_target: { kind: 'goal', strength: 95, anchor: 'goal' },
  alumni_field: { kind: 'goal', strength: 92, anchor: 'goal' },
  target_company: { kind: 'goal', strength: 85, anchor: 'goal' },
  role_industry: { kind: 'goal', strength: 84, anchor: 'goal' },
  function_match: { kind: 'goal', strength: 62 },
  want_to_meet: { kind: 'goal', strength: 80, anchor: 'goal' },
  shared_org_now: { kind: 'past_employer', strength: 82, anchor: 'goal' },
  shared_org: { kind: 'past_employer', strength: 75, anchor: 'goal' },
  mutuals: { kind: 'mutuals', strength: 35 },
  like_replied: { kind: 'like', strength: 66 },
  alumni: { kind: 'school', strength: 58 },
  warm: { kind: 'history', strength: 45, anchor: 'tie' },
  like_reached: { kind: 'like', strength: 50 },
  resume_overlap: { kind: 'like', strength: 40 },
  location: { kind: 'city', strength: 45 },
  industry: { kind: 'industry', strength: 40 },
  second_degree: { kind: 'mutuals', strength: 30 },
  search: { kind: 'search', strength: 20 },
};

/** The want-to-meet reason when the scorer could not say which role matched. */
export const WANT_TO_MEET_ANY = 'Matches who you said you want to meet.';

/** A reason the scorer wrote: its code and sentence, the predicate for the summary, and the target-list words. */
export interface ScoredReason {
  code: string;
  text: string;
  clause?: string;
  /** on target_company: how the target list holds the company ("one of your top target companies") */
  detail?: string;
}

const sentence = (t: string) => {
  const s = t.trim();
  return /[.!?…”]$/.test(s) ? s : `${s}.`;
};

/**
 * The reasons for someone known only from a search (a new person on Discover), from the reasons the scorer wrote
 * for them: each already comes from the data, so they are ordered and trimmed here, a role and a company on the
 * target list joined into one line, and the honest line added when there is little.
 */
export function whyFromReasons(
  reasons: ScoredReason[],
  c: Pick<WhySignals, 'title' | 'company' | 'headline'> & {
    mutualCount?: number;
    /** the friend at their company the colleague line names, to link to their page */
    colleague?: { id: string; name: string };
  },
  opts: WhyOptions = {},
): WhyReason[] {
  const out: WhyReason[] = [];
  const has = (code: string) => reasons.some((r) => r.code === code);
  const hasTarget = has('target_company');
  const hasRole = has('function_match');
  // "Cornell alum at Stripe, on your target list" already says the school and the company; "Cornell alum, now a PM
  // at Acme" the school and the role; "PM at Plaid, in fintech" the role and the industry
  const alumniTarget = has('alumni_target');
  const said = new Set<string>();
  if (alumniTarget) said.add('target_company').add('alumni');
  if (has('alumni_field')) said.add('function_match').add('alumni');
  if (has('role_industry')) said.add('function_match').add('industry');
  // "PM at Plaid, who you said you want to meet" already says the role
  if (
    reasons.some(
      (r) =>
        r.code === 'want_to_meet' &&
        r.text !== WANT_TO_MEET_ANY &&
        r.text !== 'Who you said you want to meet',
    )
  )
    said.add('function_match');
  for (const r of reasons) {
    const c0 = CODE[r.code];
    if (!c0 || (r.code === 'search' && opts.filler === false)) continue;
    if (said.has(r.code)) continue;
    if (!alumniTarget && hasTarget && hasRole && c.title && c.company) {
      if (r.code === 'target_company') {
        const detail = r.detail ?? 'on your target list';
        out.push({
          kind: 'goal',
          text: `${c.title} at ${c.company}. ${c.company} is ${detail}, and this is the kind of role you are aiming for.`,
          strength: 100,
          anchor: 'goal',
          clause: `is ${withArticle(c.title)} at ${c.company}, ${detail === 'on your target list' ? 'a company on your target list' : detail}`,
        });
        continue;
      }
      if (r.code === 'function_match') continue;
    }
    let strength = c0.strength;
    if (r.code === 'mutuals') strength += Math.min(15, c.mutualCount ?? 0);
    const text = r.code === 'search' ? `Found by the search for ${r.text}.` : sentence(r.text);
    // "Reachable through someone you know" says nobody; once a route names the introducer it is a way in
    const anchor = r.code === 'path' ? (/could introduce/.test(r.text) ? 'tie' : undefined) : c0.anchor;
    if (out.some((x) => x.kind === c0.kind && x.text === text)) continue;
    const reason: WhyReason = anchor
      ? { kind: c0.kind, text, strength, anchor }
      : { kind: c0.kind, text, strength };
    if (r.clause) reason.clause = r.clause;
    if (r.code === 'colleague' && c.colleague && text.includes(c.colleague.name))
      reason.people = [{ id: c.colleague.id, name: c.colleague.name }];
    out.push(reason);
  }
  const kept = order(out).slice(0, WHY_MAX);
  const real = kept.filter((r) => r.kind !== 'search').length;
  const thin = opts.filler === false ? undefined : thinLine(real, c);
  return thin ? [...kept, thin] : kept;
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
for (const table of [CODE]) Object.setPrototypeOf(table, null);
