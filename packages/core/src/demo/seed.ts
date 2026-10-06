import { linkedInSlug, normalizeCompany, normalizeEmail } from '../text/normalize';
import type {
  Affiliation,
  CalendarEvent,
  CoffeeChat,
  EmailMessage,
  EmailThread,
  MeetingNote,
  Organization,
  Person,
  PersonSource,
  ProposedTime,
  RecruitingGoals,
  RelationshipType,
  ReplySignal,
  Resume,
  ResumeFacet,
  TargetCompany,
  User,
  UserSettings,
} from '../types';

/*
 * The demo is one junior's recruiting season. The parts the user reads (the showcase threads, notes and
 * calendar) are written by hand following docs/plan/15; the rest of the network (other LinkedIn connections,
 * last year's coffee chats) comes from a seeded PRNG and only gives the graph its texture. Every date is
 * relative to `now` and lands on a business day, and every body matches the person, the calendar and the thread.
 */

// Deterministic PRNG so the demo is stable across reloads and tests.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- dates ----------

export const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;

/** `n` business days after `from` (before it when negative), at hour:minute local time. n = 0 keeps the date. */
export function businessDay(from: Date, n: number, hour: number, minute = 0): Date {
  const d = new Date(from);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setDate(d.getDate() + step);
    if (!isWeekend(d)) left--;
  }
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** About `days` calendar days before `now` (after it when negative), moved back to a weekday, at hour:minute. */
function businessDayNear(now: Date, days: number, hour: number, minute = 0): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  while (isWeekend(d)) d.setDate(d.getDate() - 1);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
const weekday = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long' });
const monthName = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
const longDate = (d: Date) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
/** "2pm", "11:30am" */
function clock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
/** How a message sent at `sent` refers to a meeting at `meeting`: "today", "yesterday" or "on Friday". */
function dayRef(meeting: Date, sent: Date): string {
  const a = new Date(meeting);
  a.setHours(0, 0, 0, 0);
  const b = new Date(sent);
  b.setHours(0, 0, 0, 0);
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `on ${weekday(meeting)}`;
}
const ymd = (y: number, m: number, d = 1) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const isoDaysAgo = (now: Date, days: number, hour = 10) => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

// ---------- organisations and roles ----------

export type DemoFunction =
  | 'swe'
  | 'pm'
  | 'data'
  | 'design'
  | 'ib'
  | 'bank_eng'
  | 'consulting'
  | 'trading'
  | 'other';
type Fn = DemoFunction;
export interface DemoRole {
  fn: Fn;
  title: string;
  /** minimum years since graduation */
  min: number;
  /** maximum years since graduation (people get promoted out of entry titles) */
  max?: number;
}
export interface DemoOrg {
  name: string;
  domain: string;
  industry: string;
  size: string;
  slug: string;
  /** how the firm builds addresses; a collision inside the firm falls through to the next pattern */
  emailPattern: 'first' | 'first.last' | 'flast';
  cities: string[];
  /** relative weight when drawing a connection's employer */
  weight: number;
  /** functions this firm hires for, with relative weights */
  functions: Partial<Record<Fn, number>>;
}

const TECH_FUNCTIONS: Partial<Record<Fn, number>> = { swe: 5, pm: 2, data: 1.2, design: 1, other: 0.8 };
export const DEMO_ORGS: DemoOrg[] = [
  {
    name: 'Stripe',
    domain: 'stripe.com',
    industry: 'Fintech',
    size: '5001-10000',
    slug: 'stripe',
    emailPattern: 'first',
    cities: ['San Francisco, CA', 'New York, NY', 'Seattle, WA'],
    weight: 3,
    functions: TECH_FUNCTIONS,
  },
  {
    name: 'Figma',
    domain: 'figma.com',
    industry: 'Software',
    size: '1001-5000',
    slug: 'figma',
    emailPattern: 'first',
    cities: ['San Francisco, CA', 'New York, NY'],
    weight: 3,
    functions: { ...TECH_FUNCTIONS, design: 2.5 },
  },
  {
    name: 'Notion',
    domain: 'makenotion.com',
    industry: 'Software',
    size: '501-1000',
    slug: 'notion',
    emailPattern: 'first',
    cities: ['San Francisco, CA', 'New York, NY'],
    weight: 2,
    functions: TECH_FUNCTIONS,
  },
  {
    name: 'Anthropic',
    domain: 'anthropic.com',
    industry: 'AI',
    size: '1001-5000',
    slug: 'anthropic',
    emailPattern: 'first',
    cities: ['San Francisco, CA', 'Seattle, WA', 'New York, NY'],
    weight: 2,
    functions: { swe: 5, pm: 1.5, data: 2, design: 0.5, other: 0.8 },
  },
  {
    name: 'Goldman Sachs',
    domain: 'gs.com',
    industry: 'Investment banking',
    size: '10001+',
    slug: 'goldman-sachs',
    emailPattern: 'first.last',
    cities: ['New York, NY'],
    weight: 1.5,
    functions: { ib: 2, bank_eng: 2, other: 0.4 },
  },
  {
    name: 'McKinsey & Company',
    domain: 'mckinsey.com',
    industry: 'Consulting',
    size: '10001+',
    slug: 'mckinsey',
    emailPattern: 'first.last',
    cities: ['New York, NY', 'Chicago, IL', 'Boston, MA'],
    weight: 1,
    functions: { consulting: 4, other: 0.4 },
  },
  {
    name: 'Ramp',
    domain: 'ramp.com',
    industry: 'Fintech',
    size: '1001-5000',
    slug: 'ramp',
    emailPattern: 'first',
    cities: ['New York, NY'],
    weight: 2,
    functions: TECH_FUNCTIONS,
  },
  {
    name: 'Linear',
    domain: 'linear.app',
    industry: 'Software',
    size: '51-200',
    slug: 'linear',
    emailPattern: 'first',
    cities: ['San Francisco, CA', 'Remote'],
    weight: 1,
    functions: { swe: 4, pm: 1, design: 1 },
  },
  {
    name: 'Datadog',
    domain: 'datadoghq.com',
    industry: 'Software',
    size: '5001-10000',
    slug: 'datadog',
    emailPattern: 'first.last',
    cities: ['New York, NY', 'Boston, MA'],
    weight: 2,
    functions: TECH_FUNCTIONS,
  },
  {
    name: 'Bain & Company',
    domain: 'bain.com',
    industry: 'Consulting',
    size: '10001+',
    slug: 'bain',
    emailPattern: 'first.last',
    cities: ['Boston, MA', 'Chicago, IL', 'New York, NY'],
    weight: 1,
    functions: { consulting: 4, other: 0.4 },
  },
  {
    name: 'Vercel',
    domain: 'vercel.com',
    industry: 'Software',
    size: '201-500',
    slug: 'vercel',
    emailPattern: 'first',
    cities: ['San Francisco, CA', 'Remote'],
    weight: 1,
    functions: TECH_FUNCTIONS,
  },
  {
    name: 'Jane Street',
    domain: 'janestreet.com',
    industry: 'Trading',
    size: '1001-5000',
    slug: 'jane-street',
    emailPattern: 'flast',
    cities: ['New York, NY'],
    weight: 1,
    functions: { swe: 3, trading: 3, other: 0.4 },
  },
];

/** Titles by function, gated by years since graduation. Firm-specific ladders replace the generic one. */
const TECH_ROLES: DemoRole[] = [
  { fn: 'swe', title: 'Software Engineer', min: 0, max: 6 },
  { fn: 'swe', title: 'Senior Software Engineer', min: 5 },
  { fn: 'swe', title: 'Staff Engineer', min: 8 },
  { fn: 'swe', title: 'Engineering Manager', min: 6 },
  { fn: 'pm', title: 'Associate Product Manager', min: 0, max: 2 },
  { fn: 'pm', title: 'Product Manager', min: 2, max: 8 },
  { fn: 'pm', title: 'Senior Product Manager', min: 5 },
  { fn: 'pm', title: 'Group Product Manager', min: 9 },
  { fn: 'data', title: 'Data Scientist', min: 0, max: 7 },
  { fn: 'data', title: 'Analytics Engineer', min: 0, max: 6 },
  { fn: 'data', title: 'Machine Learning Engineer', min: 1 },
  { fn: 'data', title: 'Senior Data Scientist', min: 5 },
  { fn: 'design', title: 'Product Designer', min: 0, max: 6 },
  { fn: 'design', title: 'Senior Product Designer', min: 5 },
  { fn: 'design', title: 'Design Lead', min: 7 },
  { fn: 'other', title: 'University Recruiter', min: 0, max: 5 },
  { fn: 'other', title: 'Recruiting Lead', min: 5 },
  { fn: 'other', title: 'Operations Manager', min: 3 },
  { fn: 'other', title: 'Chief of Staff', min: 5 },
  { fn: 'other', title: 'Marketing Manager', min: 3 },
];
const FIRM_ROLES: Record<string, DemoRole[]> = {
  'goldman-sachs': [
    { fn: 'ib', title: 'Investment Banking Analyst', min: 0, max: 2 },
    { fn: 'ib', title: 'Investment Banking Associate', min: 3, max: 6 },
    { fn: 'ib', title: 'Vice President, M&A', min: 7 },
    { fn: 'bank_eng', title: 'Analyst, Engineering', min: 0, max: 2 },
    { fn: 'bank_eng', title: 'Associate, Engineering', min: 3, max: 6 },
    { fn: 'bank_eng', title: 'Vice President, Engineering', min: 7 },
    { fn: 'other', title: 'Campus Recruiter', min: 0, max: 6 },
  ],
  mckinsey: [
    { fn: 'consulting', title: 'Business Analyst', min: 0, max: 2 },
    { fn: 'consulting', title: 'Associate', min: 2, max: 5 },
    { fn: 'consulting', title: 'Engagement Manager', min: 4, max: 9 },
    { fn: 'consulting', title: 'Associate Partner', min: 8 },
    { fn: 'other', title: 'Recruiting Coordinator', min: 0, max: 5 },
  ],
  bain: [
    { fn: 'consulting', title: 'Associate Consultant', min: 0, max: 2 },
    { fn: 'consulting', title: 'Consultant', min: 2, max: 5 },
    { fn: 'consulting', title: 'Case Team Leader', min: 4, max: 8 },
    { fn: 'consulting', title: 'Manager', min: 7 },
    { fn: 'other', title: 'Recruiting Coordinator', min: 0, max: 5 },
  ],
  'jane-street': [
    { fn: 'swe', title: 'Software Engineer', min: 0 },
    { fn: 'trading', title: 'Quantitative Trader', min: 0 },
    { fn: 'trading', title: 'Quantitative Researcher', min: 0 },
    { fn: 'other', title: 'Campus Recruiter', min: 0, max: 6 },
  ],
};
/** The title ladder a demo firm uses. */
export const demoRolesFor = (slug: string): DemoRole[] => FIRM_ROLES[slug] ?? TECH_ROLES;
const eligible = (r: DemoRole, years: number) => years >= r.min && (r.max === undefined || years <= r.max);

const FIRST = [
  'Priya',
  'Daniel',
  'Mei',
  'Sofia',
  'Jordan',
  'Aisha',
  'Lucas',
  'Hannah',
  'Omar',
  'Grace',
  'Ethan',
  'Nina',
  'Marcus',
  'Leila',
  'Tomas',
  'Chloe',
  'Ravi',
  'Maya',
  'Kenji',
  'Zara',
  'Noah',
  'Isabel',
  'Arjun',
  'Elena',
  'Felix',
  'Amara',
  'Diego',
  'Yuki',
  'Caleb',
  'Ines',
  'Theo',
  'Sana',
  'Victor',
  'Lena',
  'Jonah',
  'Rhea',
  'Mateo',
  'Alina',
  'Sebastian',
  'Keiko',
];
const LAST = [
  'Patel',
  'Kim',
  'Chen',
  'Rossi',
  'Lee',
  'Khan',
  'Silva',
  'Park',
  'Hassan',
  'Nguyen',
  'Brooks',
  'Garcia',
  'Okafor',
  'Haddad',
  'Novak',
  'Dubois',
  'Iyer',
  'Sato',
  'Tanaka',
  'Ahmed',
  'Cohen',
  'Moreno',
  'Mehta',
  'Petrov',
  'Weber',
  'Adeyemi',
  'Lopez',
  'Mori',
  'Bennett',
  'Costa',
  'Lindqvist',
  'Rahman',
  'Castro',
  'Fischer',
  'Reyes',
  'Nair',
  'Alvarez',
  'Volkov',
  'Schmidt',
  'Yamamoto',
];
const OTHER_SCHOOLS = [
  'University of Michigan',
  'UC Berkeley',
  'Georgia Tech',
  'NYU',
  'Carnegie Mellon University',
  'University of Texas at Austin',
];

export interface DemoCalendarChange {
  /** when the invite was sent or moved */
  at: string;
  externalEventId: string;
  startAt: string;
  endAt: string;
}

export interface DemoDataset {
  user: User;
  settings: UserSettings;
  goals: RecruitingGoals;
  targetCompanies: TargetCompany[];
  resume: Resume;
  resumeFacets: ResumeFacet[];
  organizations: Organization[];
  people: Person[];
  affiliations: Affiliation[];
  threads: EmailThread[];
  /** every message, annotated with the signal the pipeline is expected to derive */
  messages: EmailMessage[];
  /** final state of every calendar event */
  events: CalendarEvent[];
  /** every version of every event, as the invites were sent or moved */
  calendarChanges: DemoCalendarChange[];
  /** where each relationship should stand once mail, calendar and notes are replayed through the pipeline */
  chats: CoffeeChat[];
  notes: MeetingNote[];
}

export function buildDemoDataset(
  opts: {
    userId?: string;
    now?: Date;
    seed?: number;
    userName?: string;
    userEmail?: string;
    school?: string;
  } = {},
): DemoDataset {
  const now = opts.now ?? new Date();
  const rnd = mulberry32(opts.seed ?? 42);
  const pickWeighted = <T extends string>(weights: Partial<Record<T, number>>): T => {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = rnd() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[entries.length - 1]![0];
  };
  const userId = opts.userId ?? 'demo-user';
  const school = opts.school ?? 'Cornell University';
  const schoolShort = school.replace(/^University of /, '').replace(/ University$/, '');
  const userName = opts.userName ?? 'Alex Rivera';
  const userEmail = opts.userEmail ?? 'alex.rivera@cornell.edu';
  const [meFirst = userName, ...restName] = userName.split(' ');
  // academic calendar: the year starts in August, and the student is a junior this year
  const fallYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const gradYear = fallYear + 2;
  const classTag = `${schoolShort} '${String(gradYear).slice(2)}`;
  const standingAt = (d: Date) => {
    const fy = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    const left = gradYear - fy;
    return left >= 4 ? 'first-year' : left === 3 ? 'sophomore' : left === 2 ? 'junior' : 'senior';
  };
  /** Where the summer internship at Brex stands on date d, so a message never claims it early. */
  const brexAt = (d: Date): 'before' | 'during' | 'after' =>
    d < new Date(fallYear, 5, 1) ? 'before' : d <= new Date(fallYear, 7, 15) ? 'during' : 'after';
  const summerWord = (d: Date) => (d.getFullYear() > fallYear ? 'last summer' : 'this summer');
  const createdAt = businessDay(now, -1, 20).toISOString();
  const Y = now.getFullYear();

  const user: User = {
    id: userId,
    email: userEmail,
    fullName: userName,
    firstName: meFirst,
    lastName: restName.join(' '),
    school,
    schoolDomain: 'cornell.edu',
    graduationYear: gradYear,
    degree: 'BS',
    majors: ['Computer Science'],
    homeCity: 'Austin, TX',
    currentCity: 'Ithaca, NY',
    timezone: 'America/New_York',
    linkedinUrl: 'https://www.linkedin.com/in/alexrivera',
    onboardingStep: 11,
    onboardingCompletedAt: createdAt,
    createdAt,
  };
  const settings: UserSettings = {
    userId,
    briefTimeLocal: '07:00',
    briefChannels: ['in_app', 'email'],
    quietDays: [],
    weeklyOutreachTarget: 4,
    dailySendCapGmail: 15,
    dailySendCapLinkedin: 10,
    perPersonCooldownHours: 72,
    maxBumps: 2,
    tonePreset: 'warm',
    warmUpEnabled: true,
    warmUpDays: 4,
  };
  const goals: RecruitingGoals = {
    userId,
    cycleLabel: `Summer ${fallYear + 1} internship`,
    targetRoles: ['Software Engineering Intern', 'Product Management Intern'],
    targetFunctions: ['swe', 'pm'],
    targetIndustries: ['Fintech', 'Software', 'AI'],
    targetLocations: ['New York', 'San Francisco', 'Remote'],
    ambition: 2,
  };
  const organizations: Organization[] = DEMO_ORGS.map((o) => ({
    id: `org_${o.slug}`,
    name: o.name,
    nameNormalized: normalizeCompany(o.name),
    domains: [o.domain],
    linkedinSlug: o.slug,
    industry: o.industry,
    sizeBucket: o.size,
  }));
  const orgSpec = (slug: string) => DEMO_ORGS.find((o) => o.slug === slug)!;
  const targetCompanies: TargetCompany[] = [
    {
      // not applied yet on purpose: in tech the referral goes in before the portal application (15 §2.11)
      id: 'tc1',
      userId,
      organizationId: 'org_stripe',
      nameRaw: 'Stripe',
      priority: 1,
      status: 'researching',
      deadline: isoDaysAgo(now, -12).slice(0, 10),
    },
    { id: 'tc2', userId, organizationId: 'org_figma', nameRaw: 'Figma', priority: 1, status: 'researching' },
    {
      id: 'tc3',
      userId,
      organizationId: 'org_anthropic',
      nameRaw: 'Anthropic',
      priority: 1,
      status: 'researching',
    },
    {
      id: 'tc4',
      userId,
      organizationId: 'org_ramp',
      nameRaw: 'Ramp',
      priority: 2,
      status: 'applied',
      deadline: isoDaysAgo(now, -5).slice(0, 10),
    },
    {
      id: 'tc5',
      userId,
      organizationId: 'org_notion',
      nameRaw: 'Notion',
      priority: 2,
      status: 'researching',
    },
    {
      id: 'tc6',
      userId,
      organizationId: 'org_linear',
      nameRaw: 'Linear',
      priority: 3,
      status: 'researching',
    },
  ];
  const resume: Resume = {
    id: 'resume1',
    userId,
    filename: `${userName.replace(/\s+/g, '_')}_Resume.pdf`,
    text: '',
    parsedAt: createdAt,
    parseSource: 'heuristic',
    isCurrent: true,
    createdAt,
  };
  const resumeFacets: ResumeFacet[] = [
    {
      id: 'rf1',
      resumeId: 'resume1',
      kind: 'summary',
      text: `${meFirst} is a junior studying Computer Science at ${school}, interested in payments infrastructure and developer tools.`,
      keywords: ['payments', 'infrastructure', 'developer', 'tools'],
      confirmed: true,
    },
    {
      id: 'rf2',
      resumeId: 'resume1',
      kind: 'experience',
      title: 'Software Engineering Intern',
      organizationName: 'Brex',
      startDate: ymd(fallYear, 6, 1),
      endDate: ymd(fallYear, 8, 15),
      text: 'Built a reconciliation service for card transactions in Go; reduced settlement mismatches by 30%.',
      keywords: ['reconciliation', 'transactions', 'go', 'settlement', 'payments'],
      confirmed: true,
    },
    {
      id: 'rf3',
      resumeId: 'resume1',
      kind: 'project',
      title: 'Campus marketplace',
      organizationName: 'Personal project',
      text: 'React and Postgres marketplace used by 800 students; Stripe Checkout integration.',
      keywords: ['react', 'postgres', 'stripe', 'checkout', 'marketplace'],
      confirmed: true,
    },
    {
      id: 'rf4',
      resumeId: 'resume1',
      kind: 'education',
      title: 'BS Computer Science',
      organizationName: school,
      startDate: ymd(gradYear - 4, 8, 1),
      endDate: ymd(gradYear, 5, 31),
      text: `BS Computer Science, ${school}. GPA 3.8. Courses: distributed systems, databases, ML.`,
      keywords: ['distributed', 'systems', 'databases', 'machine', 'learning'],
      confirmed: true,
    },
    {
      id: 'rf5',
      resumeId: 'resume1',
      kind: 'skill_group',
      text: 'TypeScript, Go, Python, SQL, React, Postgres, AWS',
      keywords: ['typescript', 'go', 'python', 'sql', 'react', 'postgres', 'aws'],
      confirmed: true,
    },
  ];

  // ---------- people ----------
  const people: Person[] = [];
  const affiliations: Affiliation[] = [];
  const usedNames = new Set<string>([userName.toLowerCase()]);
  const usedEmails = new Set<string>([userEmail]);
  const emailFor = (first: string, last: string, org: DemoOrg): string => {
    const f = first.toLowerCase().replace(/[^a-z]/g, '');
    const l = last.toLowerCase().replace(/[^a-z]/g, '');
    const order =
      org.emailPattern === 'first'
        ? [f, `${f}.${l}`, `${f[0]}${l}`]
        : org.emailPattern === 'flast'
          ? [`${f[0]}${l}`, `${f}.${l}`, f]
          : [`${f}.${l}`, `${f[0]}${l}`, `${f}${l}`];
    for (const local of order) {
      const e = normalizeEmail(`${local}@${org.domain}`);
      if (!usedEmails.has(e)) {
        usedEmails.add(e);
        return e;
      }
    }
    // only when every pattern is taken inside the firm
    let n = 2;
    while (usedEmails.has(`${order[0]}${n}@${org.domain}`)) n++;
    const e = `${order[0]}${n}@${org.domain}`;
    usedEmails.add(e);
    return e;
  };
  interface PersonSpec {
    id: string;
    first: string;
    last: string;
    org: string;
    title: string;
    school: string;
    degree?: string;
    grad: number;
    /** current job start, YYYY-MM-DD */
    since: string;
    prev?: { org: string; title: string; from: string; to: string };
    email: boolean;
    connectedOn?: Date;
    sources: PersonSource[];
    relationshipType?: RelationshipType;
    city?: string;
  }
  const addPerson = (s: PersonSpec): Person => {
    const org = orgSpec(s.org);
    const full = `${s.first} ${s.last}`;
    usedNames.add(full.toLowerCase());
    const isAlumni = s.school === school;
    const email = s.email ? emailFor(s.first, s.last, org) : undefined;
    const slug = `${s.first}-${s.last}-${s.id.slice(1).padStart(2, '0')}`.toLowerCase();
    const url = `https://www.linkedin.com/in/${slug}`;
    const p: Person = {
      id: s.id,
      userId,
      displayName: full,
      firstName: s.first,
      lastName: s.last,
      nameNormalized: full.toLowerCase(),
      primaryEmail: email,
      emails: email ? [email] : [],
      linkedinUrl: url,
      linkedinSlug: linkedInSlug(url),
      headline: `${s.title} at ${org.name}`,
      currentTitle: s.title,
      currentOrganizationId: `org_${org.slug}`,
      currentOrganizationRaw: org.name,
      location: s.city ?? org.cities[0],
      school: s.school,
      isAlumni,
      relationshipType:
        s.relationshipType ?? (/recruit/i.test(s.title) ? 'recruiter' : isAlumni ? 'alumni' : 'unknown'),
      strength: 0,
      interactionCount: 0,
      sources: s.sources,
      linkedinConnectedOn: s.connectedOn ? s.connectedOn.toISOString().slice(0, 10) : undefined,
      isHuman: true,
      tags: [],
      createdAt,
      updatedAt: createdAt,
    };
    people.push(p);
    affiliations.push({
      id: `a_${s.id}_cur`,
      userId,
      personId: s.id,
      kind: 'employment',
      organizationId: `org_${org.slug}`,
      nameRaw: org.name,
      title: s.title,
      startDate: s.since,
      isCurrent: true,
      source: s.sources.includes('linkedin_csv') ? 'linkedin_csv' : 'enrichment',
    });
    if (s.prev) {
      const po = orgSpec(s.prev.org);
      affiliations.push({
        id: `a_${s.id}_prev`,
        userId,
        personId: s.id,
        kind: 'employment',
        organizationId: `org_${po.slug}`,
        nameRaw: po.name,
        title: s.prev.title,
        startDate: s.prev.from,
        endDate: s.prev.to,
        isCurrent: false,
        source: 'enrichment',
      });
    }
    affiliations.push({
      id: `a_${s.id}_edu`,
      userId,
      personId: s.id,
      kind: 'education',
      nameRaw: s.school,
      degree: s.degree ?? 'BS',
      startDate: ymd(s.grad - 4, 8, 25),
      endDate: ymd(s.grad, 5, 20),
      isCurrent: false,
      source: 'enrichment',
    });
    return p;
  };

  // The people the showcase threads are about. Titles, schools and dates are chosen so the emails below are true.
  const M = businessDayNear(now, 51, 16); // the mentor chat, about seven weeks ago
  const R = businessDay(now, -15, 12, 30); // the chat that ended in a referral offer, three weeks ago
  const S = businessDayNear(now, 150, 15); // last spring's chat, nurtured since
  const daniel = addPerson({
    id: 'p1',
    first: 'Daniel',
    last: 'Okafor',
    org: 'stripe',
    title: 'Software Engineer',
    school: 'Georgia Tech',
    grad: Y - 3,
    since: ymd(Y - 3, 7, 11),
    email: true,
    sources: ['gmail'],
    city: 'Seattle, WA',
  });
  const hannah = addPerson({
    id: 'p2',
    first: 'Hannah',
    last: 'Brooks',
    org: 'figma',
    title: 'Product Manager',
    school,
    degree: 'BA',
    grad: Y - 7,
    since: ymd(Y - 4, 3),
    prev: { org: 'notion', title: 'Product Designer', from: ymd(Y - 7, 7), to: ymd(Y - 4, 2) },
    email: true,
    sources: ['gmail'],
    city: 'New York, NY',
  });
  const omar = addPerson({
    id: 'p3',
    first: 'Omar',
    last: 'Haddad',
    org: 'notion',
    title: 'Associate Product Manager',
    school: 'University of Michigan',
    grad: fallYear - 1,
    since: ymd(fallYear - 1, 8, 4),
    email: true,
    sources: ['gmail'],
  });
  const ethan = addPerson({
    id: 'p4',
    first: 'Ethan',
    last: 'Park',
    org: 'anthropic',
    title: 'Software Engineer',
    school,
    grad: Y - 4,
    since: ymd(Y - 2, 9),
    prev: { org: 'datadog', title: 'Software Engineer', from: ymd(Y - 4, 7), to: ymd(Y - 2, 8) },
    email: true,
    sources: ['gmail'],
  });
  const lena = addPerson({
    id: 'p5',
    first: 'Lena',
    last: 'Novak',
    org: 'ramp',
    title: 'Engineering Manager',
    school: 'Carnegie Mellon University',
    grad: Y - 9,
    since: ymd(Y - 4, 2),
    prev: { org: 'stripe', title: 'Software Engineer', from: ymd(Y - 9, 8), to: ymd(Y - 4, 1) },
    email: true,
    sources: ['gmail'],
  });
  const sofia = addPerson({
    id: 'p6',
    first: 'Sofia',
    last: 'Bennett',
    org: 'datadog',
    title: 'Senior Product Manager',
    school,
    degree: 'BA',
    grad: Y - 10,
    since: ymd(Y - 8, 9),
    prev: { org: 'mckinsey', title: 'Business Analyst', from: ymd(Y - 10, 8), to: ymd(Y - 8, 7) },
    email: true,
    connectedOn: businessDay(M, 1, 12),
    sources: ['gmail', 'linkedin_csv'],
    relationshipType: 'mentor',
  });
  const victor = addPerson({
    id: 'p7',
    first: 'Victor',
    last: 'Castro',
    org: 'goldman-sachs',
    title: 'Associate, Engineering',
    school,
    grad: Y - 5,
    since: ymd(Y - 5, 7, 14),
    email: true,
    sources: ['gmail'],
  });
  const caleb = addPerson({
    id: 'p8',
    first: 'Caleb',
    last: 'Weber',
    org: 'notion',
    title: 'Software Engineer',
    school: 'UC Berkeley',
    grad: Y - 3,
    since: ymd(Y - 3, 8),
    email: true,
    sources: ['gmail'],
  });
  const maya = addPerson({
    id: 'p9',
    first: 'Maya',
    last: 'Chen',
    org: 'stripe',
    title: 'Software Engineer',
    school,
    grad: Y - 5,
    since: ymd(Y - 5, 8),
    email: true,
    connectedOn: businessDay(R, 1, 18),
    sources: ['gmail', 'linkedin_csv'],
    city: 'San Francisco, CA',
  });
  const jonah = addPerson({
    id: 'p10',
    first: 'Jonah',
    last: 'Reyes',
    org: 'ramp',
    title: 'Software Engineer',
    school: 'NYU',
    grad: Y - 2,
    since: ymd(Y - 2, 7, 15),
    email: true,
    sources: ['gmail'],
  });
  const chloe = addPerson({
    id: 'p11',
    first: 'Chloe',
    last: 'Dubois',
    org: 'ramp',
    title: 'University Recruiter',
    school: 'University of Michigan',
    degree: 'BA',
    grad: Y - 4,
    since: ymd(Y - 2, 1, 10),
    email: true,
    sources: ['gmail'],
  });
  const rhea = addPerson({
    id: 'p12',
    first: 'Rhea',
    last: 'Iyer',
    org: 'linear',
    title: 'Software Engineer',
    school: 'Carnegie Mellon University',
    grad: Y - 6,
    since: ymd(Y - 3, 4),
    prev: { org: 'vercel', title: 'Software Engineer', from: ymd(Y - 6, 7), to: ymd(Y - 3, 3) },
    email: true,
    connectedOn: businessDay(S, 1, 19),
    sources: ['gmail', 'linkedin_csv'],
    city: 'San Francisco, CA',
  });
  const theo = addPerson({
    id: 'p13',
    first: 'Theo',
    last: 'Lindqvist',
    org: 'datadog',
    title: 'Group Product Manager',
    school: 'UC Berkeley',
    grad: Y - 11,
    since: ymd(Y - 6, 1),
    prev: { org: 'figma', title: 'Product Manager', from: ymd(Y - 11, 7), to: ymd(Y - 7, 12) },
    email: true,
    sources: ['gmail'],
  });
  const noah = addPerson({
    id: 'p14',
    first: 'Noah',
    last: 'Kim',
    org: 'figma',
    title: 'Software Engineer',
    school: 'UC Berkeley',
    grad: Y - 3,
    since: ymd(Y - 3, 8),
    email: false,
    sources: ['recommendation'],
    city: 'San Francisco, CA',
  });
  const SHOWCASE = people.length;
  // no stranger shares a first or last name with someone the student is actually talking to
  const firstPool = FIRST.filter((n) => !people.some((p) => p.firstName === n) && n !== meFirst);
  const lastPool = LAST.filter((n) => !people.some((p) => p.lastName === n));

  // The rest of the LinkedIn connections: plausible title x firm x timeline, unique names, firm-style addresses.
  const N = 90;
  const fnOf = new Map<string, Fn>();
  const totalWeight = DEMO_ORGS.reduce((s, o) => s + o.weight, 0);
  for (let i = SHOWCASE; i < N; i++) {
    let first = '';
    let last = '';
    for (let tries = 0; tries < 50; tries++) {
      first = firstPool[Math.floor(rnd() * firstPool.length)]!;
      last = lastPool[Math.floor(rnd() * lastPool.length)]!;
      if (!usedNames.has(`${first} ${last}`.toLowerCase())) break;
    }
    let r = rnd() * totalWeight;
    let org = DEMO_ORGS[0]!;
    for (const o of DEMO_ORGS) {
      r -= o.weight;
      if (r <= 0) {
        org = o;
        break;
      }
    }
    const years = 1 + Math.floor(rnd() * 11); // years since graduation
    const grad = Y - years;
    const roles = demoRolesFor(org.slug).filter((x) => eligible(x, years));
    const fnWeights: Partial<Record<Fn, number>> = {};
    for (const [fn, w] of Object.entries(org.functions) as [Fn, number][])
      if (roles.some((x) => x.fn === fn)) fnWeights[fn] = w;
    const fn = pickWeighted(fnWeights);
    const options = roles.filter((x) => x.fn === fn);
    const role = options[Math.floor(rnd() * options.length)]!;
    const isAlumni = rnd() < 0.35;
    const personSchool = isAlumni ? school : OTHER_SCHOOLS[Math.floor(rnd() * OTHER_SCHOOLS.length)]!;
    // a previous job only for people a few years out, at another firm that hires the same function at entry level
    let prev: PersonSpec['prev'];
    let since = ymd(grad, 6 + Math.floor(rnd() * 3), 1);
    if (years >= 3 && rnd() < 0.55) {
      const prevOrgs = DEMO_ORGS.filter(
        (o) => o.slug !== org.slug && demoRolesFor(o.slug).some((x) => x.fn === fn && x.min === 0),
      );
      const po = prevOrgs.length ? prevOrgs[Math.floor(rnd() * prevOrgs.length)]! : undefined;
      if (po) {
        const moveYear = grad + 1 + Math.floor(rnd() * (years - 1)); // at least a year in, last year at the latest
        const moveMonth = 2 + Math.floor(rnd() * 8);
        since = ymd(moveYear, moveMonth, 1);
        prev = {
          org: po.slug,
          title: demoRolesFor(po.slug).find((x) => x.fn === fn && x.min === 0)!.title,
          from: ymd(grad, 7, 1),
          to: ymd(moveYear, moveMonth - 1, 28),
        };
      }
    }
    const hasEmail = rnd() < 0.7;
    const connectedDaysAgo = 20 + Math.floor(rnd() * 880);
    const city = org.cities[Math.floor(rnd() * org.cities.length)]!;
    const degreeBA = ['pm', 'design', 'consulting', 'ib', 'other'].includes(fn) && rnd() < 0.5;
    const p = addPerson({
      id: `p${i + 1}`,
      first,
      last,
      org: org.slug,
      title: role.title,
      school: personSchool,
      degree: degreeBA ? 'BA' : 'BS',
      grad,
      since,
      prev,
      email: hasEmail,
      connectedOn: new Date(isoDaysAgo(now, connectedDaysAgo)),
      sources: ['linkedin_csv'],
      city,
    });
    fnOf.set(p.id, fn);
  }

  // ---------- mail, calendar, notes ----------
  const threads: EmailThread[] = [];
  const messages: EmailMessage[] = [];
  const events: CalendarEvent[] = [];
  const calendarChanges: DemoCalendarChange[] = [];
  const chats: CoffeeChat[] = [];
  const notes: MeetingNote[] = [];
  let mid = 0;
  type Turn = {
    dir: 'in' | 'out';
    at: Date;
    body: string;
    /** sender of an inbound message in a group thread (default: the thread's first person) */
    from?: Person;
    to?: Person[];
    cc?: Person[];
    subject?: string;
    headers?: Record<string, string>;
    automated?: boolean;
    /** the signal the pipeline is expected to derive for this message */
    signal?: ReplySignal;
    times?: ProposedTime[];
    offers?: string[];
  };
  const addrOf = (p: Person) => p.primaryEmail ?? `${p.firstName.toLowerCase()}@example.com`;
  const addThread = (who: Person[], subject: string, turns: Turn[]): EmailThread => {
    const tid = who.length === 1 ? `t_${who[0]!.id}_${threads.length}` : `t_group_${threads.length}`;
    const th: EmailThread = {
      id: tid,
      userId,
      externalThreadId: `ext-${tid}`,
      subject,
      messageCount: turns.length,
      participantEmails: [userEmail, ...who.map(addrOf)],
      participantPersonIds: who.map((p) => p.id),
      category: 'networking',
      categoryConfidence: 0.9,
      isNetworking: true,
      classifiedAt: createdAt,
      classifiedBy: 'heuristic',
    };
    let last = 0;
    for (const t of turns) {
      if (t.at.getTime() <= last) throw new Error(`demo seed: ${tid} turns are out of order`);
      if (t.at.getTime() > now.getTime()) throw new Error(`demo seed: ${tid} has a message in the future`);
      last = t.at.getTime();
      const sender = t.from ?? who[0]!;
      const sentAt = t.at.toISOString();
      messages.push({
        id: `m${mid}`,
        userId,
        threadId: tid,
        externalMessageId: `ext-m${mid}`,
        direction: t.dir === 'out' ? 'outbound' : 'inbound',
        fromEmail: t.dir === 'out' ? userEmail : addrOf(sender),
        fromName: t.dir === 'out' ? userName : sender.displayName,
        toEmails: t.dir === 'out' ? (t.to ?? [who[0]!]).map(addrOf) : [userEmail],
        ccEmails: (t.cc ?? []).map(addrOf),
        fromPersonId: t.dir === 'in' ? sender.id : undefined,
        sentAt,
        subject: t.subject ?? (t === turns[0] ? subject : `Re: ${subject}`),
        bodyText: t.body,
        headers: t.headers ?? {},
        isAutomated: !!t.automated,
        signal: t.signal,
        signalConfidence: t.signal ? 0.85 : undefined,
        extraction: t.signal
          ? {
              proposedTimes: t.times ?? [],
              asksOfUser: [],
              offers: t.offers ?? [],
              factsAboutSender: [],
              sentiment: t.signal === 'reply_decline' ? 'cool' : 'warm',
            }
          : undefined,
        processedAt: createdAt,
      });
      mid++;
      th.firstMessageAt = th.firstMessageAt ?? sentAt;
      th.lastMessageAt = sentAt;
    }
    threads.push(th);
    return th;
  };
  const addEvent = (
    p: Person,
    e: {
      id: string;
      title: string;
      start: Date;
      minutes?: number;
      invitedAt: Date;
      /** later moves of the same invite */
      moves?: { at: Date; start: Date }[];
      conferenceUrl?: string;
    },
  ): CalendarEvent => {
    const len = (e.minutes ?? 30) * 60_000;
    const ext = `gcal-${e.id}`;
    const history = [{ at: e.invitedAt, start: e.start }, ...(e.moves ?? [])];
    for (const h of history)
      calendarChanges.push({
        at: h.at.toISOString(),
        externalEventId: ext,
        startAt: h.start.toISOString(),
        endAt: new Date(h.start.getTime() + len).toISOString(),
      });
    const start = history[history.length - 1]!.start;
    const ev: CalendarEvent = {
      id: e.id,
      userId,
      externalEventId: ext,
      title: e.title,
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + len).toISOString(),
      status: 'confirmed',
      attendees: [
        { email: userEmail, self: true, responseStatus: 'accepted' },
        { email: addrOf(p), displayName: p.displayName, responseStatus: 'accepted' },
      ],
      attendeePersonIds: [p.id],
      conferenceUrl: e.conferenceUrl,
      isCoffeeChat: true,
      coffeeChatConfidence: 0.95,
    };
    events.push(ev);
    return ev;
  };
  const addChat = (p: Person, stage: CoffeeChat['stage'], extra: Partial<CoffeeChat>): CoffeeChat => {
    const c: CoffeeChat = {
      id: `c_${p.id}`,
      userId,
      personId: p.id,
      organizationId: p.currentOrganizationId,
      stage,
      stageEnteredAt: createdAt,
      source: 'detected',
      goalTags: [],
      outreachChannel: 'gmail',
      bumpCount: 0,
      priority: 2,
      createdAt: extra.firstOutreachAt ?? createdAt,
      updatedAt: createdAt,
      ...extra,
    };
    chats.push(c);
    return c;
  };
  const proposal = (d: Date, raw: string): ProposedTime[] => [{ startIso: d.toISOString(), raw }];
  const sig = `\n\nThanks,\n${meFirst}`;
  const FOURTEEN_DAYS = 14 * 86_400_000;

  // 1. Cold outreach a week and a half ago, no reply yet -> one bump (15 §2.6).
  {
    const sent = businessDay(now, -7, 9, 42);
    const th = addThread(
      [daniel],
      `${schoolShort} CS ${standingAt(sent)}, question about your retries post`,
      [
        {
          dir: 'out',
          at: sent,
          body: `Hi Daniel,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and came across your post on making payment retries idempotent while reading about Stripe's API design. I spent ${summerWord(sent)} at Brex building a reconciliation service, and half of our mismatches came from exactly that problem.\n\nWould you have 15 minutes sometime in the next couple of weeks to talk about how your team decides what to fix at the API layer? Completely understand if the next few weeks are busy.${sig}`,
          signal: 'other',
        },
      ],
    );
    addChat(daniel, 'outreach_sent', {
      threadId: th.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: sent.toISOString(),
      stageEnteredAt: sent.toISOString(),
    });
  }
  // 2. An alumna replied yesterday and asked for times -> propose two windows (15 §2.7).
  {
    const sent = businessDay(now, -3, 10, 12);
    const reply = businessDay(now, -1, 16, 40);
    const th = addThread([hannah], `${schoolShort} ${standingAt(sent)}, your move from design to PM`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Hannah,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and found you through the ${schoolShort} alumni page on LinkedIn. You moved from designing at Notion to product at Figma, and I'm trying to work out whether starting closer to the craft makes someone a better PM.\n\nWould you have 20 minutes in the next couple of weeks to tell me how you made that switch? Whatever time suits you.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nHappy to chat, always glad to help someone from ${schoolShort}. Send me a couple of times that work for you next week and I'll make one of them work.\n\nHannah`,
        signal: 'reply_positive',
      },
    ]);
    addChat(hannah, 'replied', {
      threadId: th.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: sent.toISOString(),
      lastInboundAt: reply.toISOString(),
      stageEnteredAt: reply.toISOString(),
    });
  }
  // 3. They proposed a slot that is still ahead -> confirm it (15 §2.7).
  {
    const sent = businessDay(now, -4, 9, 55);
    const reply = businessDay(now, -1, 11, 5);
    const slot = businessDay(now, 2, 14); // within a week of the reply, so the weekday name is unambiguous
    const raw = `${weekday(slot)} at 2pm`;
    const th = addThread([omar], `${schoolShort} ${standingAt(sent)}, question about Notion's APM program`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Omar,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and came across your profile while reading about Notion's APM program. You joined it right after graduating from Michigan, which is the path I'm weighing against a software internship next summer.\n\nWould you have 15 minutes sometime in the next couple of weeks to talk about what made you pick APM? Happy to work around your calendar.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nHappy to talk about the APM program. Would ${raw} ET work for a video call?\n\nOmar`,
        signal: 'scheduling_proposal',
        times: proposal(slot, raw),
      },
    ]);
    addChat(omar, 'scheduling', {
      threadId: th.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: sent.toISOString(),
      lastInboundAt: reply.toISOString(),
      stageEnteredAt: reply.toISOString(),
    });
  }
  // 4. Booked, then moved by them -> the chat is the next business day (prep card).
  {
    const sent = businessDay(now, -7, 9, 40);
    const invited = businessDay(now, -5, 13, 20);
    const original = businessDay(now, -1, 11, 30);
    const moved = businessDay(now, -2, 9, 15);
    const slot = businessDay(now, 1, 11, 30);
    const th = addThread([ethan], `${schoolShort} ${standingAt(sent)}, your move from Datadog to Anthropic`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Ethan,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and found you on the ${schoolShort} alumni page while looking at engineers who moved from infrastructure into AI labs. You went from Datadog to Anthropic two years after graduating, and I'm trying to understand what that switch looks like from the inside.\n\nWould you have 20 minutes in the next couple of weeks to talk about it? Whatever time suits you.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: invited,
        body: `Hi ${meFirst},\n\nHappy to. I sent an invite for ${weekday(original)} at 11:30am, hope that works.\n\nEthan`,
        signal: 'scheduling_confirmation',
      },
      {
        dir: 'out',
        at: addMinutes(invited, 42),
        body: `Thanks Ethan, ${weekday(original)} at 11:30 works. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'in',
        at: moved,
        body: `Hi ${meFirst},\n\nA conflict just landed on ${weekday(original)}, sorry about that. I moved our calendar invite to ${weekday(slot)} at 11:30am, same link. Let me know if that doesn't work.\n\nEthan`,
        signal: 'scheduling_confirmation',
      },
      {
        dir: 'out',
        at: addMinutes(moved, 75),
        body: `No problem at all, ${weekday(slot)} at 11:30 works. Thanks for letting me know.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
    ]);
    const ev = addEvent(ethan, {
      id: 'ev_next',
      title: `${meFirst} <> Ethan`,
      start: original,
      invitedAt: addMinutes(invited, 2),
      moves: [{ at: addMinutes(moved, 1), start: slot }],
      conferenceUrl: 'https://meet.google.com/kqv-ftzr-wpa',
    });
    const c = addChat(ethan, 'scheduled', {
      threadId: th.id,
      scheduledEventId: ev.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: addMinutes(moved, 75).toISOString(),
      lastInboundAt: moved.toISOString(),
      stageEnteredAt: addMinutes(moved, 1).toISOString(),
    });
    ev.chatId = c.id;
  }
  // 5. A chat that just happened, with a Granola note -> a thank-you that uses the note (15 §2.8).
  {
    // today at 10:00 once it is over, otherwise the previous business day at 16:00 (always under three days ago)
    const C = !isWeekend(now) && now.getHours() >= 11 ? businessDay(now, 0, 10) : businessDay(now, -1, 16);
    const sent = businessDay(C, -6, 9, 35);
    const reply = businessDay(C, -4, 12, 10);
    const th = addThread([lena], `${schoolShort} ${standingAt(sent)}, your bill matching post`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Lena,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and came across your post on the Ramp engineering blog about matching bills to payments. I spent ${summerWord(sent)} at Brex building a reconciliation service for card transactions, so I recognized every edge case in it.\n\nWould you have 15 minutes sometime in the next couple of weeks to talk about how your team decides what to automate? Completely understand if the next few weeks are busy.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nSure, happy to. Does ${weekday(C)} at ${clock(C)} work? I'll send a Zoom link.\n\nLena`,
        signal: 'scheduling_proposal',
        times: proposal(C, `${weekday(C)} at ${clock(C)}`),
      },
      {
        dir: 'out',
        at: addMinutes(reply, 50),
        body: `${weekday(C)} at ${clock(C)} works, thank you. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
    ]);
    const ev = addEvent(lena, {
      id: 'ev_recent',
      title: `Coffee chat: Lena / ${meFirst}`,
      start: C,
      invitedAt: addMinutes(reply, 55),
      conferenceUrl: 'https://ramp.zoom.us/j/84120937715',
    });
    const c = addChat(lena, 'completed', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: ev.endAt,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: addMinutes(reply, 50).toISOString(),
      lastInboundAt: reply.toISOString(),
      stageEnteredAt: ev.endAt,
    });
    ev.chatId = c.id;
    notes.push({
      id: 'note1',
      userId,
      source: 'granola_email',
      externalId: 'granola-1',
      title: `Coffee chat with ${lena.displayName}`,
      occurredAt: C.toISOString(),
      rawText: [
        `Coffee chat: ${lena.displayName} / ${userName}`,
        '',
        'Summary',
        'Lena leads the bill pay engineering team at Ramp, after four years on payments at Stripe.',
        'The key is one concrete project story that shows how you handled ambiguity.',
        'The team is rebuilding approval workflows this quarter and expects to take interns next summer.',
        'She offered to pass my name to the recruiter who owns the software engineering intern req.',
        'I will send my resume and the marketplace project link by Friday.',
        'She grew up in Pittsburgh and ran the Philadelphia Marathon last fall.',
        '',
        'Transcript',
        'Lena: So what did reconciliation look like at Brex?',
        `${meFirst}: Mostly settlement files that didn't match the ledger. I wrote the service that flags the mismatches.`,
        "Lena: That's the story I'd lead with. Tell it as a problem nobody had defined yet.",
      ].join('\n'),
      attendees: [{ name: lena.displayName, email: lena.primaryEmail }],
      personIds: [lena.id],
      chatId: c.id,
      calendarEventId: ev.id,
      matchStatus: 'auto',
      matchConfidence: 0.98,
      createdAt: addMinutes(new Date(ev.endAt), 18).toISOString(),
    });
  }
  // 6. A mentor met seven weeks ago, thanked the next morning, who introduced the student to Theo -> nurturing.
  {
    const sent = businessDay(M, -8, 10, 5);
    const reply = businessDay(M, -4, 11, 30);
    const thanks = businessDay(M, 0, 19, 20); // the same evening
    const lastIn = businessDay(M, 1, 12, 5);
    const th = addThread([sofia], `${schoolShort} ${standingAt(sent)}, your path from McKinsey to Datadog`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Sofia,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and found you through the ${schoolShort} Product Club's alumni list. You went from McKinsey to product at Datadog, and I'm trying to figure out whether PM is a job you can start in or one you grow into.\n\nWould you have 20 minutes sometime in the next couple of weeks to talk about how you decided? Whatever time suits you.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nOf course. Would ${weekday(M)} at 4pm work? I'll call you.\n\nSofia`,
        signal: 'scheduling_proposal',
        times: proposal(M, `${weekday(M)} at 4pm`),
      },
      {
        dir: 'out',
        at: addMinutes(reply, 45),
        body: `Perfect, ${weekday(M)} at 4pm it is. Thank you, Sofia.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'out',
        at: thanks,
        body: `Hi Sofia,\n\nThank you for taking the time ${dayRef(M, thanks)}. Your point that the best PMs own one metric end to end stuck with me, and I've ordered Working Backwards on your recommendation.\n\nI'll let you know how recruiting goes. Would it be alright to send a question your way if one comes up?\n\n${meFirst}`,
        signal: 'thank_you',
      },
      {
        dir: 'in',
        at: lastIn,
        body: `Glad it was useful, ${meFirst}. Keep me posted on how recruiting goes.\n\nSofia`,
        signal: 'reply_neutral',
      },
    ]);
    const ev = addEvent(sofia, {
      id: 'ev_mentor',
      title: `Sofia / ${meFirst}`,
      start: M,
      invitedAt: addMinutes(reply, 50),
    });
    const c = addChat(sofia, 'nurturing', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: ev.endAt,
      followedUpAt: thanks.toISOString(),
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: thanks.toISOString(),
      lastInboundAt: lastIn.toISOString(),
      stageEnteredAt: new Date(thanks.getTime() + FOURTEEN_DAYS).toISOString(),
    });
    ev.chatId = c.id;
    // the launch she mentioned has happened by now, so a check-in can ask how it went
    const launch = new Date(now.getTime() - 21 * 86_400_000);
    notes.push({
      id: 'note2',
      userId,
      source: 'manual',
      title: `Call with ${sofia.displayName}`,
      occurredAt: ev.startAt,
      rawText: `Sofia spent two years at McKinsey before moving to product at Datadog. The best PMs own one metric end to end and can explain why it moved. She recommended reading Working Backwards before PM interviews. The team is launching the new onboarding flow in ${monthName(launch)}. She offered to introduce me to Theo, who runs product for her group.`,
      attendees: [{ name: sofia.displayName }],
      personIds: [sofia.id],
      chatId: c.id,
      calendarEventId: ev.id,
      matchStatus: 'confirmed',
      matchConfidence: 1,
      createdAt: addMinutes(new Date(ev.endAt), 25).toISOString(),
    });
    // 6b. The intro she offered (a group thread), then Theo's own thread.
    const intro = businessDay(M, 3, 9, 30);
    addThread([sofia, theo], `Intro: ${meFirst} <> Theo`, [
      {
        dir: 'in',
        from: sofia,
        cc: [theo],
        at: intro,
        body: `Hi ${meFirst} and Theo,\n\n${meFirst}, meet Theo. He runs product for our platform group and has hired more PM interns than anyone I know. Theo, ${meFirst} is the ${schoolShort} ${standingAt(intro)} I mentioned who's deciding between product and engineering internships. I'll let you two take it from here.\n\nSofia`,
        signal: 'intro_offer',
      },
      {
        dir: 'out',
        to: [theo],
        at: addMinutes(intro, 90),
        body: `Thanks, Sofia (moving you to bcc).\n\nTheo, great to meet you. Would you have 15 minutes in the next couple of weeks to talk about what you look for in PM interns? Whatever time suits you.\n\n${meFirst}`,
        signal: 'other',
      },
    ]);
    const T = businessDay(M, 6, 10);
    const tReply = businessDay(M, 4, 10, 15);
    const tThanks = businessDay(M, 6, 14, 10);
    const tth = addThread([theo], "Following up on Sofia's intro", [
      {
        dir: 'in',
        at: tReply,
        body: `Hi ${meFirst},\n\nStarting a new thread so we stop filling Sofia's inbox. Happy to chat about it. Does ${weekday(T)} at 10am work?\n\nTheo`,
        signal: 'scheduling_proposal',
        times: proposal(T, `${weekday(T)} at 10am`),
      },
      {
        dir: 'out',
        at: addMinutes(tReply, 65),
        body: `${weekday(T)} at 10am works, thank you. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'out',
        at: tThanks,
        body: `Hi Theo,\n\nThanks for the call this morning. Your advice to write one real PRD for my marketplace project before interviews is the next thing I'm doing.\n\nThanks again for making the time,\n${meFirst}`,
        signal: 'thank_you',
      },
    ]);
    const tev = addEvent(theo, {
      id: 'ev_theo',
      title: `Theo / ${meFirst}`,
      start: T,
      invitedAt: addMinutes(tReply, 70),
    });
    const tc = addChat(theo, 'nurturing', {
      threadId: tth.id,
      scheduledEventId: tev.id,
      completedAt: tev.endAt,
      followedUpAt: tThanks.toISOString(),
      firstOutreachAt: addMinutes(tReply, 65).toISOString(),
      lastOutboundAt: tThanks.toISOString(),
      lastInboundAt: tReply.toISOString(),
      stageEnteredAt: new Date(tThanks.getTime() + FOURTEEN_DAYS).toISOString(),
    });
    tev.chatId = tc.id;
  }
  // 7. A clear no from three weeks ago, which the student confirmed at the time -> declined.
  {
    const sent = businessDay(now, -20, 10, 20);
    const reply = businessDay(now, -18, 15, 45);
    const th = addThread([victor], `${classTag}, question on Goldman's transaction banking engineering`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Victor,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and found you on the ${schoolShort} alumni page while looking at engineers in Goldman's transaction banking group. You joined right after graduating and have stayed on the same platform since, and I'd like to understand what kept you there.\n\nWould you have 15 minutes in the next couple of weeks to talk about it? Completely understand if the timing is bad.\n\nThanks,\n${userName}\n${classTag}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nThanks for writing. I'm not able to take calls this quarter, we're in the middle of a platform migration. Good luck with recruiting.\n\nVictor`,
        signal: 'reply_decline',
      },
    ]);
    addChat(victor, 'declined', {
      threadId: th.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: sent.toISOString(),
      lastInboundAt: reply.toISOString(),
      // the student confirmed the proposed stage that evening
      stageEnteredAt: addMinutes(reply, 150).toISOString(),
    });
  }
  // 8. A polite no that arrived yesterday -> proposed, waiting for the student to confirm it.
  {
    const sent = businessDay(now, -6, 10, 40);
    const reply = businessDay(now, -1, 17, 10);
    const th = addThread(
      [caleb],
      `${schoolShort} CS ${standingAt(sent)}, question about offline edits at Notion`,
      [
        {
          dir: 'out',
          at: sent,
          body: `Hi Caleb,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and came across your profile while reading about how Notion handles offline edits. I built offline sync for a campus marketplace app last spring and ran into the same conflict problems.\n\nWould you have 15 minutes in the next couple of weeks to talk about how your team approached it? Completely understand if the next few weeks are busy.${sig}`,
          signal: 'other',
        },
        {
          dir: 'in',
          at: reply,
          body: `Hi ${meFirst},\n\nThanks for the note. Unfortunately I can't make time for calls right now, we're heads down until the end of the quarter. Good luck with the search.\n\nCaleb`,
          signal: 'reply_decline',
        },
      ],
    );
    addChat(caleb, 'outreach_sent', {
      threadId: th.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: sent.toISOString(),
      lastInboundAt: reply.toISOString(),
      stageEnteredAt: sent.toISOString(),
    });
  }
  // 9. A chat three weeks ago, thanked, and they offered a referral; Stripe's posting closes soon -> referral ask.
  {
    const sent = businessDay(R, -6, 9, 50);
    const reply = businessDay(R, -4, 14);
    const thanks = businessDay(R, 0, 17, 5);
    const offerAt = businessDay(R, 1, 13, 30);
    const th = addThread([maya], `${schoolShort} ${standingAt(sent)}, your work on Stripe Billing`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Maya,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and found you through the ${schoolShort} alumni page while looking at engineers on Stripe Billing. My campus marketplace runs on Stripe Checkout, so I've spent more time in your docs than I'd like to admit, and I'm curious what the team behind them is like.\n\nWould you have 20 minutes sometime in the next couple of weeks? Whatever time suits you.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nFun to hear from a ${schoolShort} student. Sure, how about ${weekday(R)} at 12:30pm? I'll send a Google Meet link.\n\nMaya`,
        signal: 'scheduling_proposal',
        times: proposal(R, `${weekday(R)} at 12:30pm`),
      },
      {
        dir: 'out',
        at: addMinutes(reply, 70),
        body: `${weekday(R)} at 12:30 works, thank you. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'out',
        at: thanks,
        body: `Hi Maya,\n\nThank you for taking the time ${dayRef(R, thanks)}. Hearing that referrals are normal on your team took a lot of the awkwardness out of it, and I'm narrowing it down to Billing and Connect this week.\n\nWould it be alright to send a question your way if one comes up?\n\n${meFirst}`,
        signal: 'thank_you',
      },
      {
        dir: 'in',
        at: offerAt,
        body: `Of course. Once you've picked a team, send me the posting and I'll put your name in with the recruiter.\n\nMaya`,
        signal: 'reply_positive',
      },
    ]);
    const ev = addEvent(maya, {
      id: 'ev_referral',
      title: `${meFirst} / Maya`,
      start: R,
      invitedAt: addMinutes(reply, 75),
      conferenceUrl: 'https://meet.google.com/hzd-qmpe-xro',
    });
    const c = addChat(maya, 'nurturing', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: ev.endAt,
      followedUpAt: thanks.toISOString(),
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: thanks.toISOString(),
      lastInboundAt: offerAt.toISOString(),
      stageEnteredAt: new Date(thanks.getTime() + FOURTEEN_DAYS).toISOString(),
    });
    ev.chatId = c.id;
    notes.push({
      id: 'note3',
      userId,
      source: 'manual',
      title: `Chat with ${maya.displayName}`,
      occurredAt: ev.startAt,
      rawText:
        'Maya works on the invoicing team in Stripe Billing. She recommended applying before the posting closes, since referrals are the norm on her team and count most before the portal. The key is a project that actually moves money, and the marketplace counts. She offered to refer me once I have picked a team.',
      attendees: [{ name: maya.displayName }],
      personIds: [maya.id],
      chatId: c.id,
      calendarEventId: ev.id,
      matchStatus: 'confirmed',
      matchConfidence: 1,
      createdAt: addMinutes(new Date(ev.endAt), 30).toISOString(),
    });
  }
  // 10. Outreach answered by an out-of-office auto-reply -> still waiting; an auto-reply is not a reply.
  {
    const sent = businessDay(now, -2, 10, 5);
    const back = businessDay(now, 3, 9);
    const subject = `${schoolShort} ${standingAt(sent)}, your first year on Ramp's card team`;
    const th = addThread([jonah], subject, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Jonah,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and came across your profile while reading about Ramp's card issuing team. You joined Ramp as a new grad, and I'm about to take the online assessment for the intern role, so I'd love to hear what the first year was actually like.\n\nWould you have 15 minutes sometime in the next couple of weeks? Completely understand if not.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: addMinutes(sent, 1),
        subject: `Automatic reply: ${subject}`,
        headers: { 'auto-submitted': 'auto-replied' },
        automated: true,
        body: `Thanks for your note. I'm out of the office until ${longDate(back)} with limited access to email, and I'll reply when I'm back.\n\nJonah`,
        signal: 'out_of_office',
      },
    ]);
    addChat(jonah, 'outreach_sent', {
      threadId: th.id,
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: sent.toISOString(),
      stageEnteredAt: sent.toISOString(),
    });
  }
  // 11. A recruiter's process email (recruiting, not networking: no coffee chat), answered.
  {
    const got = businessDay(now, -3, 15, 10);
    const due = businessDay(got, 5, 23, 59);
    addThread([chloe], 'Ramp Software Engineering Intern: next steps', [
      {
        dir: 'in',
        at: got,
        body: `Hi ${meFirst},\n\nThank you for applying to the Software Engineering Intern role for summer ${fallYear + 1}. The next step is an online assessment on CodeSignal. You'll get a separate email with your link, and it needs to be finished by ${longDate(due)}.\n\nIf you need an accommodation or have a question about the process, reply here and I'll help.\n\nBest,\nChloe Dubois\nUniversity Recruiter, Ramp`,
      },
      {
        dir: 'out',
        at: addMinutes(got, 80),
        body: `Hi Chloe,\n\nThanks for the update. I'll keep an eye out for the link and finish it this week.\n\nBest,\n${userName}`,
      },
    ]);
  }
  // 12. Last spring's chat, thanked, and a no-reply-needed check-in a month later -> nurturing.
  {
    const sent = businessDay(S, -6, 10, 30);
    const reply = businessDay(S, -4, 9, 45);
    const thanks = businessDay(S, 0, 18, 30);
    const thanksReply = businessDay(S, 1, 11);
    const checkIn = businessDayNear(S, -35, 10, 15);
    const checkInReply = businessDay(checkIn, 1, 16, 20);
    const th = addThread([rhea], `${schoolShort} CS ${standingAt(sent)}, Postgres or Elasticsearch?`, [
      {
        dir: 'out',
        at: sent,
        body: `Hi Rhea,\n\nI'm a CS ${standingAt(sent)} at ${schoolShort} and came across your profile while reading about Linear's sync engine. I'm building search for a campus marketplace and keep going back and forth between adding Elasticsearch and staying on Postgres, which seems like something your team has opinions about.\n\nWould you have 15 minutes sometime in the next couple of weeks? Completely understand if the timing is bad.${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nHappy to. Does ${weekday(S)} at 3pm work?\n\nRhea`,
        signal: 'scheduling_proposal',
        times: proposal(S, `${weekday(S)} at 3pm`),
      },
      {
        dir: 'out',
        at: addMinutes(reply, 45),
        body: `${weekday(S)} at 3pm works, thank you. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'out',
        at: thanks,
        body: `Hi Rhea,\n\nThank you for taking the time ${dayRef(S, thanks)}. Your advice to stay on Postgres full-text search until it actually hurts saved me a week of setting up Elasticsearch.\n\nI'll let you know how it goes.\n\n${meFirst}`,
        signal: 'thank_you',
      },
      {
        dir: 'in',
        at: thanksReply,
        body: `Glad it helped. Postgres will carry you further than most people think.\n\nRhea`,
        signal: 'reply_neutral',
      },
      {
        dir: 'out',
        at: checkIn,
        body: `Hi Rhea,\n\nQuick update since we talked in ${monthName(S)}: I stayed on Postgres full-text search like you suggested, and it's been fine at 800 users.${brexAt(checkIn) === 'during' ? " I'm also spending the summer at Brex on payments infrastructure." : ''} Hope the sync engine work is going well.\n\nNo reply needed, just wanted to say thanks.\n\n${meFirst}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: checkInReply,
        body: `Love hearing that. Good luck with recruiting this fall.\n\nRhea`,
        signal: 'reply_neutral',
      },
    ]);
    const ev = addEvent(rhea, {
      id: 'ev_spring',
      title: `${meFirst} / Rhea`,
      start: S,
      invitedAt: addMinutes(reply, 50),
      conferenceUrl: 'https://meet.google.com/rvo-bnkd-tye',
    });
    const c = addChat(rhea, 'nurturing', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: ev.endAt,
      followedUpAt: thanks.toISOString(),
      firstOutreachAt: sent.toISOString(),
      lastOutboundAt: checkIn.toISOString(),
      lastInboundAt: checkInReply.toISOString(),
      stageEnteredAt: new Date(thanks.getTime() + FOURTEEN_DAYS).toISOString(),
    });
    ev.chatId = c.id;
  }
  // 13. Warming up a cold LinkedIn target at a priority-1 company before the first message (doc 13).
  {
    const started = businessDay(now, -2, 9);
    const nextDue = isWeekend(now) ? businessDay(now, 1, 10) : businessDay(now, 0, 10);
    addChat(noah, 'warming', {
      outreachChannel: 'linkedin',
      source: 'recommendation',
      createdAt: started.toISOString(),
      stageEnteredAt: started.toISOString(),
      warmUp: {
        startedAt: started.toISOString(),
        readyAt: businessDay(nextDue, 2, 9).toISOString(),
        actions: [
          {
            id: 'w1',
            kind: 'view_profile',
            label: 'View their profile and follow them',
            url: `https://www.linkedin.com/in/${noah.linkedinSlug}/`,
            dueAt: started.toISOString(),
            doneAt: addMinutes(started, 20).toISOString(),
          },
          {
            id: 'w2',
            kind: 'react_post',
            label: 'React to one recent post that you genuinely find useful',
            url: `https://www.linkedin.com/in/${noah.linkedinSlug}/recent-activity/all/`,
            dueAt: nextDue.toISOString(),
          },
          {
            id: 'w3',
            kind: 'comment_post',
            label: 'Leave one specific, non-flattering comment (a question or an added point)',
            url: `https://www.linkedin.com/in/${noah.linkedinSlug}/recent-activity/all/`,
            dueAt: businessDay(nextDue, 1, 10).toISOString(),
          },
        ],
      },
    });
  }

  // ---------- earlier conversations: texture for the graph, every loop closed ----------
  // Distinct first and last names among everyone the student has written to, so no two threads read alike.
  const takenFirst = new Set(people.slice(0, SHOWCASE).map((p) => p.firstName));
  const takenLast = new Set(people.slice(0, SHOWCASE).map((p) => p.lastName));
  const others: Person[] = [];
  for (const p of people.slice(SHOWCASE)) {
    if (!p.primaryEmail || fnOf.get(p.id) === 'other') continue;
    if (takenFirst.has(p.firstName) || takenLast.has(p.lastName)) continue;
    takenFirst.add(p.firstName);
    takenLast.add(p.lastName);
    others.push(p);
  }
  const AREA: Record<Fn, (org: string) => string> = {
    swe: (o) => `${o}'s engineering team`,
    pm: (o) => `how product works at ${o}`,
    data: (o) => `${o}'s data team`,
    design: (o) => `${o}'s design team`,
    ib: (o) => `${o}'s technology investment banking group`,
    bank_eng: (o) => `${o}'s engineering division`,
    consulting: (o) => `${o}'s technology practice`,
    trading: (o) => `how ${o} builds its trading systems`,
    other: (o) => `${o}'s operations team`,
  };
  // what the student wanted to learn, and the one thing they thanked the person for afterwards (two of each per
  // function, so two people in the same role never get the same email)
  const QUESTION: Record<Fn, string[]> = {
    swe: [
      "I'm trying to figure out what separates a good first year on an engineering team from a great one.",
      "I'm choosing between a backend and a product engineering internship and can't tell how different the work really is.",
    ],
    pm: [
      "I'm trying to understand what a PM actually does in a normal week before I apply for product roles.",
      "I'm trying to work out whether engineers who move into product start with an advantage or a blind spot.",
    ],
    data: [
      "I'm deciding between more statistics and more systems courses next year, and I'd value the view of someone who does this every day.",
      "I'm trying to understand how much of the job is modeling and how much is getting the data right first.",
    ],
    design: [
      'I build the front end for a campus marketplace and want to understand how designers and engineers split the work on a real team.',
      "I'm trying to understand how a design team decides what gets polished and what ships as is.",
    ],
    ib: [
      "I'm a CS student trying to understand what tech banking looks like before I rule it in or out.",
      "I'm trying to understand what an analyst with an engineering background brings to a deal team.",
    ],
    bank_eng: [
      "I'm trying to understand how engineering at a bank differs from engineering at a tech company.",
      "I'm trying to understand what shipping looks like when every change touches money and regulators.",
    ],
    consulting: [
      "I'm a CS student trying to work out whether a couple of years in consulting is a good first step before product.",
      "I'm trying to understand what a technology case actually involves for a first-year.",
    ],
    trading: [
      "I'm trying to understand how much of the work is engineering and how much is market intuition.",
      "I'm trying to understand what a new engineer works on in the first few months on a trading desk.",
    ],
    other: [
      "I'm trying to understand what the business side of a tech company looks like day to day.",
      "I'm trying to understand how operations roles work with engineering.",
    ],
  };
  const CALLBACK: Record<Fn, string[]> = {
    swe: [
      'Hearing how your team decides what to build first made the job a lot more concrete for me.',
      "Your point that the first project matters less than how fast you learn the codebase changed how I'm choosing between internships.",
    ],
    pm: [
      "The way you walked through a normal week was more useful than anything I'd read about the role.",
      "Your point that an engineer's instinct is to build before asking why is something I'm going to watch for in myself.",
    ],
    data: [
      'Your take on learning SQL properly before anything fancier is going straight into my plan for next semester.',
      'Hearing that most of the work is cleaning the data before anyone models it was exactly what I needed to know.',
    ],
    design: [
      "Seeing how you split work with engineers changed how I'm going to run my next project.",
      'Your rule of shipping the rough version to five users first is going into my marketplace this month.',
    ],
    ib: [
      'Your description of a typical week answered the question I came in with.',
      'Hearing where an engineering background helps on a deal team gave me a much clearer picture.',
    ],
    bank_eng: [
      'Hearing how releases work at a bank explained a lot about the trade-offs you described.',
      'Your description of how changes get reviewed made the job much more concrete for me.',
    ],
    consulting: [
      'Hearing what the first year actually looks like made the trade-off much clearer.',
      'Your walk-through of a technology case made the work much more concrete for me.',
    ],
    trading: [
      'Hearing how much of the job is engineering surprised me in a good way.',
      'Your description of the first few months on the desk answered the question I came in with.',
    ],
    other: [
      'Hearing how the business side works day to day filled in a gap for me.',
      'Your description of how operations and engineering work together was exactly what I needed.',
    ],
  };
  // a summer check-in that ties back to the conversation without claiming it caused anything
  const SUMMER_TIE: Record<Fn, string> = {
    swe: 'Watching how my team decides what to build first, I keep coming back to what you told me.',
    pm: 'Working next to our PM has made your description of a normal week make even more sense.',
    data: "I took your advice and spent the spring on SQL, and it's the skill I use most here.",
    design: "Working with our designer, I've been splitting the work the way you described.",
    ib: 'What you told me about the first year has been a useful lens on my own work.',
    bank_eng: 'Shipping anything that touches money has made your point about reviews very real.',
    consulting: 'What you told me about the first year has been a useful lens on my own work.',
    trading: 'What you told me about the first few months has been a useful lens on my own.',
    other: 'What you told me about the business side has been a useful lens on my own work.',
  };
  /** A weekday about `days` ago, kept out of the winter break when nobody takes coffee chats. */
  const pastDay = (days: number, hour: number, minute: number) => {
    const d = businessDayNear(now, days, hour, minute);
    const m = d.getMonth();
    // an arc runs about three weeks, so one that would reach the holidays starts in early November instead
    if (m === 11 || (m === 10 && d.getDate() >= 10) || (m === 0 && d.getDate() <= 4)) {
      const year = m === 0 ? d.getFullYear() - 1 : d.getFullYear();
      return businessDayNear(new Date(year, 10, 3 + (d.getDate() % 5), hour, minute), 0, hour, minute);
    }
    return d;
  };
  const pastChat = (
    p: Person,
    th: EmailThread,
    ev: CalendarEvent,
    first: Date,
    thanks: Date,
    last: { out: Date; in?: Date },
  ) => {
    const c = addChat(p, 'nurturing', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: ev.endAt,
      followedUpAt: thanks.toISOString(),
      firstOutreachAt: first.toISOString(),
      lastOutboundAt: last.out.toISOString(),
      lastInboundAt: last.in?.toISOString(),
      stageEnteredAt: new Date(thanks.getTime() + FOURTEEN_DAYS).toISOString(),
    });
    ev.chatId = c.id;
  };
  const regulars = others.slice(0, 6);
  const thankedAt = new Map<string, Date>();
  const used = new Map<Fn, number>();
  regulars.forEach((p, k) => {
    const fn = fnOf.get(p.id) ?? 'swe';
    const v = used.get(fn) ?? 0;
    used.set(fn, v + 1);
    const org = p.currentOrganizationRaw ?? '';
    const sent = pastDay(75 + Math.floor(rnd() * 230), 9 + (k % 3), 10 + k * 7);
    const reply = businessDay(sent, 2, 13, 5 + k * 3);
    const slot = businessDay(sent, 5, k % 2 ? 15 : 11);
    const thanks = businessDay(slot, 0, 17, 30 + k); // the same evening
    const standing = standingAt(sent);
    const alum = p.isAlumni;
    const turns: Turn[] = [
      {
        dir: 'out',
        at: sent,
        body: `Hi ${p.firstName},\n\nI'm a CS ${standing} at ${schoolShort} and ${alum ? `found you through the ${schoolShort} alumni page while looking at ${AREA[fn](org)}` : `came across your profile while reading about ${AREA[fn](org)}`}. ${QUESTION[fn][v % 2]}\n\nWould you have ${alum ? 20 : 15} minutes sometime in the next couple of weeks? ${alum ? 'Whatever time suits you.' : 'Completely understand if the timing is bad.'}${sig}`,
        signal: 'other',
      },
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\n${k % 2 ? 'Happy to help.' : 'Sure, happy to.'} Does ${weekday(slot)} at ${clock(slot)} work for you?\n\n${p.firstName}`,
        signal: 'scheduling_proposal',
        times: proposal(slot, `${weekday(slot)} at ${clock(slot)}`),
      },
      {
        dir: 'out',
        at: addMinutes(reply, 55),
        body: `${weekday(slot)} at ${clock(slot)} works, thank you. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'out',
        at: thanks,
        body: `Hi ${p.firstName},\n\nThank you for taking the time ${dayRef(slot, thanks)}. ${CALLBACK[fn][v % 2]}\n\nI'll let you know how recruiting goes, and thanks again.\n\n${meFirst}`,
        signal: 'thank_you',
      },
    ];
    let lastIn: Date | undefined = reply;
    let lastOut = thanks;
    if (k % 2 === 0) {
      lastIn = businessDay(thanks, 1, 10, 40);
      turns.push({
        dir: 'in',
        at: lastIn,
        body: `Glad it was helpful, ${meFirst}. Good luck this cycle.\n\n${p.firstName}`,
        signal: 'reply_neutral',
      });
    }
    // talked before the internship started, checked in during it
    const checkIn = businessDay(thanks, 22, 10, 30);
    if (brexAt(slot) === 'before' && brexAt(checkIn) === 'during' && checkIn < now) {
      lastOut = checkIn;
      turns.push({
        dir: 'out',
        at: checkIn,
        body: `Hi ${p.firstName},\n\nQuick update since we talked in ${monthName(slot)}: I'm spending the summer at Brex on the payments infrastructure team. ${SUMMER_TIE[fn]} Hope things are going well at ${org}.\n\nNo reply needed, just wanted to say thanks.\n\n${meFirst}`,
        signal: 'other',
      });
    }
    const th = addThread([p], `${schoolShort} ${standing}, question about ${org}`, turns);
    const ev = addEvent(p, {
      id: `ev_past_${p.id}`,
      title: `${meFirst} / ${p.firstName}`,
      start: slot,
      invitedAt: addMinutes(reply, 60),
    });
    pastChat(p, th, ev, sent, thanks, { out: lastOut, in: lastIn });
    thankedAt.set(p.id, thanks);
  });
  // Two of those people later introduced the student to a colleague, who moved the conversation to its own thread.
  others.slice(6, 8).forEach((b, k) => {
    const a = regulars[k];
    const aThanks = a && thankedAt.get(a.id);
    if (!a || !aThanks) return;
    const fn = fnOf.get(b.id) ?? 'swe';
    const v = used.get(fn) ?? 0;
    used.set(fn, v + 1);
    const intro = businessDay(aThanks, 4 + k * 3, 9, 20 + k * 11);
    const standing = standingAt(intro);
    addThread([a, b], `Intro: ${meFirst} <> ${b.firstName}`, [
      {
        dir: 'in',
        from: a,
        cc: [b],
        at: intro,
        body: `Hi ${meFirst} and ${b.firstName},\n\n${meFirst}, meet ${b.firstName}, who is a ${b.currentTitle} at ${b.currentOrganizationRaw} and much better placed to answer your questions than I am. ${b.firstName}, ${meFirst} is a ${schoolShort} ${standing} I talked with recently who's curious about ${AREA[fn](b.currentOrganizationRaw ?? '')}. I'll let you two take it from here.\n\n${a.firstName}`,
        signal: 'intro_offer',
      },
      {
        dir: 'out',
        to: [b],
        at: addMinutes(intro, 100),
        body: `Thanks, ${a.firstName} (moving you to bcc).\n\n${b.firstName}, great to meet you. Would you have 15 minutes in the next couple of weeks? Whatever time suits you.\n\n${meFirst}`,
        signal: 'other',
      },
    ]);
    const reply = businessDay(intro, 1, 11, 5);
    const slot = businessDay(intro, 4, 16);
    const thanks = businessDay(slot, 0, 18, 40);
    const th = addThread([b], `Following up on ${a.firstName}'s intro`, [
      {
        dir: 'in',
        at: reply,
        body: `Hi ${meFirst},\n\nStarting a new thread so we stop filling ${a.firstName}'s inbox. Happy to chat about it. Does ${weekday(slot)} at 4pm work?\n\n${b.firstName}`,
        signal: 'scheduling_proposal',
        times: proposal(slot, `${weekday(slot)} at 4pm`),
      },
      {
        dir: 'out',
        at: addMinutes(reply, 40),
        body: `${weekday(slot)} at 4pm works, thank you. Talk then.\n\n${meFirst}`,
        signal: 'scheduling_proposal',
      },
      {
        dir: 'out',
        at: thanks,
        body: `Hi ${b.firstName},\n\nThank you for taking the time ${dayRef(slot, thanks)}. ${CALLBACK[fn][v % 2]} I'll let ${a.firstName} know how helpful it was.\n\n${meFirst}`,
        signal: 'thank_you',
      },
    ]);
    const ev = addEvent(b, {
      id: `ev_intro_${b.id}`,
      title: `${b.firstName} / ${meFirst}`,
      start: slot,
      invitedAt: addMinutes(reply, 45),
    });
    pastChat(b, th, ev, addMinutes(reply, 40), thanks, { out: thanks, in: reply });
  });
  return {
    user,
    settings,
    goals,
    targetCompanies,
    resume,
    resumeFacets,
    organizations,
    people,
    affiliations,
    threads,
    messages,
    events,
    calendarChanges,
    chats,
    notes,
  };
}
