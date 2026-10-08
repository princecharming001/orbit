// Person summary and chat prep, written the way a student who has done many coffee chats would write their own notes.
// Pure functions: no database access, so the page can render them immediately and tests can pin the copy.
import type {
  CalendarEvent,
  CoffeeChat,
  Person,
  PersonFact,
  RecruitingGoals,
  ResumeFacet,
  Touchpoint,
  User,
} from '@orbit/core';
import {
  expandShorthand,
  financeFirmKind,
  functionPhrase,
  isRecruiter,
  linkedinActivityUrl,
  linkedinProfileUrl,
  matchedFunction,
  sectorOf,
  seniorityOf,
  yearLabel,
} from '@orbit/core';

const DAY = 86_400_000;

/** "a Consultant", "an Associate Product Manager", "Head of Design" (titles that take no article). */
export function withArticle(title: string): string {
  const t = title.trim();
  if (/^(head|chief|vp\b|vice president|co-?founder|founder|managing director|general partner)/i.test(t))
    return t;
  // Acronyms are read letter by letter: "an MBA student", "an SDE", "a PhD student".
  const acronym = /^[A-Z]{2,}\b/.test(t);
  const vowelSound = acronym ? /^[AEFHILMNORSX]/.test(t) : /^[aeiou]/i.test(t) && !/^(uni|eu|one)/i.test(t);
  return `${vowelSound ? 'an' : 'a'} ${t}`;
}

/** Split "Consultant, Private Equity Practice" into the title and the team. */
function splitTitle(title: string): { main: string; team?: string } {
  const [main, ...rest] = title.split(/\s*,\s*/);
  return { main: main ?? title, team: rest.length ? rest.join(', ') : undefined };
}

function dayKey(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** "today", "yesterday", "on Tuesday", "on Aug 13", "in Feb 2023" in the user's timezone. */
export function sayWhen(iso: string, now: Date, tz: string): string {
  const d = new Date(iso);
  if (dayKey(d, tz) === dayKey(now, tz)) return 'today';
  if (dayKey(d, tz) === dayKey(new Date(now.getTime() - DAY), tz)) return 'yesterday';
  const ago = now.getTime() - d.getTime();
  if (ago > 0 && ago < 6 * DAY)
    return `on ${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })}`;
  const sameYear =
    d.toLocaleDateString('en-US', { year: 'numeric', timeZone: tz }) ===
    now.toLocaleDateString('en-US', { year: 'numeric', timeZone: tz });
  if (sameYear || Math.abs(ago) < 300 * DAY)
    return `on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}`;
  return `in ${d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: tz })}`;
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const c = t[0]!.toUpperCase() + t.slice(1);
  return /[.?!]$/.test(c) ? c : `${c}.`;
};

function lastTouchSentence(tp: Touchpoint, first: string, when: string): string {
  switch (tp.kind) {
    case 'meeting':
      return `You last met ${when}.`;
    case 'email_out':
      return `You last wrote to ${first} ${when}.`;
    case 'email_in':
      return `${first} last wrote to you ${when}.`;
    case 'email_cc':
      return `You were last on an email thread together ${when}.`;
    case 'linkedin_in':
    case 'linkedin_out':
      return `You last messaged on LinkedIn ${when}.`;
    case 'linkedin_engaged':
      return `You last engaged with ${first}'s LinkedIn posts ${when}.`;
    case 'note':
    case 'manual_log':
      return `You last logged a conversation ${when}.`;
    case 'intro_observed':
      return `You were introduced ${when}.`;
    default:
      return `You were last in touch ${when}.`;
  }
}

/**
 * Facts from the student's own notes are written as they said them ("She offered to refer me"). The summary speaks
 * to the student, so it says "you".
 */
export function toYou(text: string): string {
  // note shorthand ("McK", "first round apps") is written out wherever Orbit shows a note back
  return expandShorthand(text)
    .replace(/\bI'm\b/g, "you're")
    .replace(/\bI've\b/g, "you've")
    .replace(/\bI'll\b/g, "you'll")
    .replace(/\bI'd\b/g, "you'd")
    .replace(/\bI am\b/g, 'you are')
    .replace(/\bI was\b/g, 'you were')
    .replace(/\bI\b/g, 'you')
    .replace(/\bmyself\b/gi, 'yourself')
    .replace(/\bmy\b/g, 'your')
    .replace(/\bMy\b/g, 'Your')
    .replace(/\bmine\b/g, 'yours')
    .replace(/\bme\b/g, 'you');
}

/** The template summary and talking points shown on a person's page when no model is configured. */
export function personSummary(args: {
  user: Pick<User, 'school' | 'timezone'>;
  person: Person;
  facts: Pick<PersonFact, 'type' | 'text'>[];
  touchpoints: Pick<Touchpoint, 'kind' | 'occurredAt'>[];
  now: Date;
}): { summary: string; talkingPoints: string[] } {
  const { user, person, facts, now } = args;
  const tz = user.timezone || 'UTC';
  const first = person.firstName || person.displayName;
  const parts: string[] = [];
  const title = person.currentTitle?.trim();
  const org = person.currentOrganizationRaw?.trim();
  if (title && org && /^(student|undergrad(uate)?|mba candidate|grad(uate)? student)$/i.test(title)) {
    // "Tom is a student at the University of Michigan", not "works at ... as a Student"
    parts.push(`${first} is a student at ${org}.`);
  } else if (title && org) {
    const { main, team } = splitTitle(title);
    parts.push(`${first} works at ${org} as ${withArticle(main)}${team ? ` (${team})` : ''}.`);
  } else if (title) parts.push(`${first} is ${withArticle(title)}.`);
  else if (org) parts.push(`${first} works at ${org}.`);
  else if (person.headline) parts.push(`${first}'s LinkedIn headline: ${person.headline}.`);
  if (person.isAlumni && user.school) parts.push(`Like you, ${first} went to ${user.school}.`);
  const tps = [...args.touchpoints]
    .filter((t) => new Date(t.occurredAt).getTime() <= now.getTime() + 60_000)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const real = tps.filter((t) => t.kind !== 'linkedin_connected');
  const connected = tps.find((t) => t.kind === 'linkedin_connected');
  if (real[0]) {
    // A meeting and its notes land at the same time; describe the conversation, not the note about it.
    const RANK: Partial<Record<Touchpoint['kind'], number>> = { meeting: 0, email_in: 1, email_out: 1 };
    const sameDay = real.filter(
      (t) => new Date(real[0]!.occurredAt).getTime() - new Date(t.occurredAt).getTime() < DAY,
    );
    const last = [...sameDay].sort((a, b) => (RANK[a.kind] ?? 5) - (RANK[b.kind] ?? 5))[0]!;
    parts.push(lastTouchSentence(last as Touchpoint, first, sayWhen(last.occurredAt, now, tz)));
    const recent = real.filter((t) => now.getTime() - new Date(t.occurredAt).getTime() < 90 * DAY).length;
    if (recent >= 2)
      parts.push(
        `You've been in touch ${recent === 2 ? 'twice' : `${recent} times`} in the last three months.`,
      );
  } else if (connected)
    parts.push(
      `You're connected on LinkedIn (since ${new Date(connected.occurredAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: tz })}) but haven't talked yet.`,
    );
  else parts.push(`You haven't been in touch yet.`);
  const adv = facts.find((f) => f.type === 'advice');
  const off = facts.find((f) => f.type === 'offer');
  const fromNotes = [adv, off]
    .filter((f): f is NonNullable<typeof f> => !!f)
    .map((f) => sentence(toYou(f.text)));
  if (fromNotes.length) parts.push(`From your notes: ${fromNotes.join(' ')}`);
  const hook = facts.find((f) => f.type === 'hook');
  const talkingPoints = [
    // a hook is anything worth asking about (a project, a plan, a race they are training for)
    hook ? `Worth bringing up: ${sentence(toYou(hook.text))}` : undefined,
    // facts are third-person sentences ("She offered to refer you ..."), so the label does not repeat the offer
    off ? `Follow up: ${sentence(toYou(off.text))}` : undefined,
    // a note line that already says "advice" ("Big advice: ...") is not labelled advice twice
    adv
      ? `Tell them what you did with their advice: ${sentence(toYou(adv.text.replace(/^(big |main |key |their |her |his )?(advice|tip)\s*[:-]\s*/i, '')))}`
      : undefined,
  ].filter((x): x is string => !!x);
  return { summary: parts.join(' '), talkingPoints };
}

/** Is the person in the field the student is recruiting for (or we cannot tell)? */
function sameField(fn: PersonFunction, target: string | undefined): boolean {
  if (!target || fn === 'general') return true;
  if (fn === target) return true;
  return (
    (fn === 'ib' && (target === 'finance' || target === 'ib')) || (fn === 'data' && target === 'research')
  );
}

/** The kind of company a target function lives in. Functions most companies have (marketing, operations) are absent. */
const TARGET_SECTOR: Record<string, string> = {
  swe: 'tech',
  pm: 'tech',
  design: 'tech',
  data: 'tech',
  ib: 'finance',
  finance: 'finance',
  vc: 'vc',
  consulting: 'consulting',
};
const FUNCTION_SECTOR: Record<PersonFunction, string | undefined> = {
  swe: 'tech',
  pm: 'tech',
  design: 'tech',
  data: 'tech',
  ib: 'finance',
  vc: 'vc',
  consulting: 'consulting',
  general: undefined,
};

/** Titles that are investment banking wherever the person sits ("Analyst, M&A", "Capital Markets Associate"). */
const BANKING_TITLE =
  /\b(investment bank\w*|banking|m&a|capital markets|leveraged finance|restructuring|coverage|ecm|dcm)\b/i;

/**
 * Could the person's company have the function the student is recruiting for? Only what the data shows counts: the
 * person's own function, or the company's sector. An Engagement Manager at Ramp says nothing about banking at Ramp,
 * and a Partner at Sequoia says nothing about banking at Sequoia.
 */
function companyHasTarget(
  fn: PersonFunction,
  title: string | undefined,
  org: string | undefined,
  target: string | undefined,
): boolean {
  if (!target) return false;
  // Research means different work at every company (academic, equity, quant, user research); only the person's own
  // field shows it is there.
  if (target === 'research') return fn === 'data' || /\bresearch/i.test(title ?? '');
  const kind = financeFirmKind(org);
  // Venture, buyout and trading firms are "finance" but have no banking team; a bank does. At a firm we do not know,
  // only a banking title says so.
  if (target === 'ib') return kind ? kind === 'bank' : fn === 'ib' && BANKING_TITLE.test(title ?? '');
  if (target === 'vc' && kind) return kind === 'vc';
  const want = TARGET_SECTOR[target];
  if (!want) return true;
  if (FUNCTION_SECTOR[fn] === want) return true;
  // a venture firm's people are investors whatever the firm's list says
  return fn !== 'vc' && !!org?.trim() && sectorOf({ org }) === want;
}

export type Audience = 'recruiter' | 'junior' | 'mid' | 'senior';
export type PersonFunction = 'swe' | 'pm' | 'design' | 'data' | 'ib' | 'consulting' | 'vc' | 'general';

export function personFunction(
  person: Pick<Person, 'currentTitle' | 'currentOrganizationRaw'>,
): PersonFunction {
  const t = person.currentTitle ?? '';
  if (/product manager|product lead|\bpm\b|product owner/i.test(t)) return 'pm';
  if (/design|\bux\b|\bui\b/i.test(t)) return 'design';
  if (/data scien|machine learning|\bml\b|analytics|research scientist/i.test(t)) return 'data';
  if (/engineer|developer|\bswe\b|\bsde\b|programmer/i.test(t)) return 'swe';
  const org = person.currentOrganizationRaw?.trim();
  const sector = sectorOf({ title: t, org });
  const orgSector = org ? sectorOf({ org }) : 'general';
  // People at a venture firm are investors, whatever their title says ("Partner" at Sequoia is not a banker).
  if (/venture|\bvc\b|investor/i.test(t) || financeFirmKind(org) === 'vc') return 'vc';
  // A banking or consulting title at a tech company ("Engagement Manager" at Ramp, "Vice President" at Google) is
  // not a banker or a consultant: their case and deal questions would be visibly wrong.
  if (orgSector === 'tech') return 'general';
  if (sector === 'finance') return 'ib';
  // Generic titles ("Engagement Manager", "Principal") only mean consulting at a consulting firm.
  if (sector === 'consulting' && (orgSector === 'consulting' || /consult/i.test(t))) return 'consulting';
  return 'general';
}

const BANK: Record<PersonFunction, { early: string[]; senior: string[] }> = {
  swe: {
    early: [
      'What does your team own, and what does the stack look like day to day?',
      'How are intern projects picked, and how much of that work ships?',
      'What did the strongest interns on your team do differently in their first month?',
      'What do you wish you had practised before your first code reviews there?',
    ],
    senior: [
      'What do you look for when you meet engineers who are still in school?',
      'How do intern projects get scoped on your teams?',
      'Which skills separate new grads who ramp quickly from the rest?',
    ],
  },
  pm: {
    early: [
      'How does your team decide what to build next, and who makes the final call?',
      'What does a PM intern actually own over a summer?',
      'What did you lean on most from your background when you started as a PM?',
      'What separates a good product sense answer from a great one in your interviews?',
    ],
    senior: [
      'What do you look for in early-career PMs that is hard to see on a resume?',
      'How do APMs or interns get scoped onto real problems on your teams?',
      'What would you tell a student choosing between a PM and an engineering internship?',
    ],
  },
  design: {
    early: [
      'How does design work with product and engineering on your team?',
      'What does a design intern own, and how is their work reviewed?',
      'What do you wish more student portfolios showed?',
      'What did you learn in your first year that school did not prepare you for?',
    ],
    senior: [
      'What makes a student portfolio stand out to you?',
      'How do you structure design internships so the work ships?',
      'Which skills do you wish new designers arrived with?',
    ],
  },
  data: {
    early: [
      'Where does your work show up in product or business decisions?',
      'How is your time split between analysis, modelling and building pipelines?',
      'What does a data intern usually work on over a summer?',
      'Which tools or skills did you have to pick up fastest when you started?',
    ],
    senior: [
      'What do you look for in students who want to do data work on your team?',
      'How do you scope intern projects so they get to real results?',
      'Which skills matter more than people expect in this field?',
    ],
  },
  ib: {
    early: [
      'How does staffing work for first-year analysts in your group?',
      'What kind of deal exposure do summer analysts actually get?',
      'How is the culture in your group different from what you expected before you joined?',
      'What do you wish you had known before your superday?',
    ],
    senior: [
      'What do you look for in summer analysts beyond the technicals?',
      'How has the group changed since you were an analyst?',
      'What would you tell a student deciding between groups or banks?',
    ],
  },
  consulting: {
    early: [
      'How do you get staffed on cases, and how much choice do you have?',
      'What does a typical week on a case look like for you?',
      'What did the strongest summer associates do differently?',
      'How did you prepare for case interviews, and what would you change?',
    ],
    senior: [
      'What do you look for in first-years beyond case performance?',
      'How has the firm changed in the way it develops new hires?',
      'What would you tell a student choosing which office or practice to aim for?',
    ],
  },
  vc: {
    early: [
      'How do you source deals, and what does a first meeting with a founder look like?',
      'What does your week split between sourcing, diligence and portfolio work?',
      'How did you get into venture, and what would you do differently?',
      'What do junior people at your firm own on a deal?',
    ],
    senior: [
      'What do you look for in people early in their careers who want to invest?',
      'Which operating or banking experience translates best to venture?',
      'How do you think about the path into venture today?',
    ],
  },
  general: {
    early: [
      'What does a typical week look like in your role?',
      'What do you wish you had known before you started?',
      'Which skills mattered most in your first year?',
      'What does someone new on your team usually own?',
    ],
    senior: [
      'What do you look for when you meet students early in their careers?',
      'How has your team changed since you joined?',
      'What would you tell your college self about choosing a first job?',
    ],
  },
};

const RECRUITER = (org: string, school: string) => [
  `What does the recruiting timeline look like at ${org} this cycle?`,
  'Which info sessions or campus events would be worth attending?',
  `Which teams or offices are hiring the most interns this cycle?`,
  `What do strong applicants${school ? ` from ${school}` : ''} do well in the process?`,
  'Is there anything you would recommend preparing before applying?',
];

export const CLOSING_QUESTION = "Is there anyone else you'd suggest I talk to?";

export interface PrepPlan {
  audience: Audience;
  fn: PersonFunction;
  goal: string;
  ask: string;
  intro?: string;
  introMissing?: string;
  logistics?: { when: string; link?: string };
  logisticsTips: string[];
  research: { label: string; url?: string }[];
  questions: string[];
  closing: string;
  followUps: string[];
}

export function buildPrep(args: {
  user: Pick<User, 'firstName' | 'school' | 'graduationYear' | 'degree' | 'majors' | 'timezone'>;
  goals?: Pick<RecruitingGoals, 'cycleLabel' | 'targetFunctions'>;
  person: Person;
  facts: Pick<PersonFact, 'type' | 'text'>[];
  chats: Pick<CoffeeChat, 'stage' | 'completedAt'>[];
  event?: Pick<CalendarEvent, 'startAt' | 'endAt' | 'conferenceUrl'>;
  resumeFacets: Pick<ResumeFacet, 'kind' | 'title' | 'organizationName' | 'startDate' | 'endDate' | 'text'>[];
  now: Date;
}): PrepPlan {
  const { user, goals, person, facts, now } = args;
  const tz = user.timezone || 'UTC';
  const first = person.firstName || person.displayName;
  const org = person.currentOrganizationRaw?.trim() || 'their company';
  // Only what the student told Orbit: no placeholder when the cycle or the target function is missing.
  const cycleRaw = goals?.cycleLabel?.trim() ?? '';
  const cycle = /^(this cycle)?$/i.test(cycleRaw) ? '' : cycleRaw;
  const search = cycle ? `${cycle} search` : 'search';
  // the student's goal that fits this person ("consulting" to a McKinsey analyst), not just the first one they listed
  const targets = goals?.targetFunctions ?? [];
  const target =
    matchedFunction(
      `${person.currentTitle ?? ''} ${person.headline ?? ''} ${person.currentOrganizationRaw ?? ''}`,
      targets,
    ) ?? targets[0];
  const myFn = target ? functionPhrase(target) : '';
  const recruiter = isRecruiter(person.currentTitle);
  const seniority = seniorityOf(person.currentTitle);
  const audience: Audience = recruiter
    ? 'recruiter'
    : seniority === 'exec' || seniority === 'senior'
      ? 'senior'
      : seniority === 'junior'
        ? 'junior'
        : 'mid';
  const fn = personFunction(person);
  const metBefore = args.chats.some((c) => !!c.completedAt);
  const hadAdvice = facts.some((f) => f.type === 'advice');

  // Questions: one about their path, one alum question, then the function bank for their seniority.
  const qs: string[] = [];
  if (recruiter) qs.push(...RECRUITER(org, user.school));
  else {
    if (person.currentTitle && person.currentOrganizationRaw)
      qs.push(
        `What drew you to ${person.currentOrganizationRaw}, and how did you end up in your current role?`,
      );
    if (person.isAlumni && user.school)
      qs.push(`Which classes, clubs or professors at ${user.school} helped you most on this path?`);
    const bank = BANK[fn];
    qs.push(...(audience === 'senior' ? [...bank.senior, ...bank.early] : bank.early));
  }
  const questions = [...new Set(qs)].slice(0, 5);

  const goal = recruiter
    ? `Leave with ${org}'s timeline for your ${search} and one concrete next step.`
    : metBefore
      ? hadAdvice
        ? `Tell ${first} what you did with their advice, and get their read on your next step.`
        : `Catch ${first} up on your ${search} since you last spoke, and get their read on your next step.`
      : !myFn || !companyHasTarget(fn, person.currentTitle, person.currentOrganizationRaw, target)
        ? `Understand what the work at ${org} is really like and whether a role there fits your ${search}.`
        : sameField(fn, target)
          ? `Understand what the work at ${org} is really like and whether ${myFn} there fits your ${search}.`
          : `Learn how ${org} works from someone in ${functionPhrase(fn)}, and who on the ${myFn} side you should meet next.`;
  const ask = recruiter
    ? 'Which deadline or event matters most for you, and who to follow up with.'
    : metBefore
      ? `If you're applying to ${org}, whether ${first} would be comfortable flagging your application when you submit.`
      : 'A pointer to one more person to talk to. Ask it at the end, and nothing more in a first chat.';

  // Your 30-second intro, only from what the student told Orbit.
  const year = yearLabel(user.graduationYear, user.degree, now);
  const major = user.majors[0];
  const exp = args.resumeFacets
    .filter((f) => f.kind === 'experience' && f.title && f.organizationName)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
  const project = args.resumeFacets.find((f) => f.kind === 'project' && f.title);
  let intro: string | undefined;
  let introMissing: string | undefined;
  if (user.firstName && user.school) {
    const bits = [
      `I'm ${user.firstName}, ${withArticle(year)} at ${user.school}${major ? ` studying ${major}` : ''}.`,
    ];
    if (exp) {
      const current = !exp.endDate || /present|now/i.test(exp.endDate);
      const org = exp.organizationName!;
      // a student club is not an employer: "Treasurer of the Michigan Investment Club", "an analyst in the ..."
      const club = /\b(club|association|society|council|chapter|committee|fraternity|sorority)\b/i.test(org);
      const the = /^the\b/i.test(org) ? '' : 'the ';
      const officer =
        /^(president|vice president|vp|treasurer|secretary|chair|co-?chair|captain|founder|co-?founder|director|head|lead)\b/i.test(
          exp.title!,
        );
      const role = club
        ? officer
          ? `${exp.title} of ${the}${org}`
          : `${withArticle(exp.title!)} in ${the}${org}`
        : `${withArticle(exp.title!)} at ${org}`;
      bits.push(`${current ? (club ? "I'm" : "Right now I'm") : 'Most recently I was'} ${role}.`);
    } else if (project) bits.push(`Lately I've been working on ${project.title}.`);
    const missing: string[] = [];
    if (!exp && !project)
      missing.push('Add your resume in Settings so Orbit can add one line about your experience.');
    if (myFn)
      bits.push(
        `I'm recruiting for ${myFn} roles${cycle ? ` (${cycle})` : ''}, and I'd love to hear how you got where you are.`,
      );
    else {
      bits.push("I'd love to hear how you got where you are.");
      missing.push(
        "Add the roles you're recruiting for in Settings, under Goals, so your intro says what you want.",
      );
    }
    if (missing.length) introMissing = missing.join(' ');
    intro = bits.join(' ');
  } else introMissing = 'Add your name and school in Settings so Orbit can draft your intro.';

  const logistics = args.event
    ? {
        when: `${new Date(args.event.startAt).toLocaleString('en-US', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: tz,
          timeZoneName: 'short',
        })}, ${Math.max(5, Math.round((new Date(args.event.endAt).getTime() - new Date(args.event.startAt).getTime()) / 60_000))} minutes`,
        link: args.event.conferenceUrl,
      }
    : undefined;
  const logisticsTips = [
    logistics?.link
      ? 'Join two minutes early and test your audio.'
      : 'Confirm who calls whom and on which number.',
    'Keep to the time you asked for, and offer to wrap up when it runs out.',
    'Send a thank-you within 24 hours that mentions one thing they said.',
  ];

  const research: { label: string; url?: string }[] = [];
  if (person.linkedinSlug || person.linkedinUrl)
    research.push({
      label: `Read ${first}'s LinkedIn profile and recent posts`,
      url: person.linkedinSlug
        ? linkedinActivityUrl(person.linkedinSlug)
        : (person.linkedinUrl ?? linkedinProfileUrl('')),
    });
  if (person.currentOrganizationRaw) {
    research.push({
      label: `Skim this month's news about ${org}`,
      url: `https://news.google.com/search?q=${encodeURIComponent(org)}`,
    });
    if (!recruiter)
      research.push({
        label: `Look up ${org}'s ${fn === 'general' ? '' : `${functionPhrase(fn)} `}team page or blog`,
        url: `https://www.google.com/search?q=${encodeURIComponent(`${org} ${fn === 'general' ? '' : functionPhrase(fn)} team`.trim())}`,
      });
    else
      research.push({
        label: `Check ${org}'s careers page for ${cycle ? `${cycle} ` : ''}deadlines`,
        url: `https://www.google.com/search?q=${encodeURIComponent(`${org} careers internship`)}`,
      });
  }
  if (person.isAlumni && user.school)
    research.push({ label: `Open with your shared ${user.school} connection` });

  const followUps = facts
    .filter((f) => f.type === 'hook' || f.type === 'offer')
    .slice(0, 3)
    .map((f) => sentence(f.text));

  return {
    audience,
    fn,
    goal,
    ask,
    intro,
    introMissing,
    logistics,
    logisticsTips,
    research,
    questions,
    closing: CLOSING_QUESTION,
    followUps,
  };
}
