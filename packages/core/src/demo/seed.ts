import { linkedInSlug, normalizeCompany, normalizeEmail, parseName } from '../text/normalize';
import type {
  Affiliation,
  CalendarEvent,
  CoffeeChat,
  EmailMessage,
  EmailThread,
  MeetingNote,
  Organization,
  Person,
  RecruitingGoals,
  Resume,
  ResumeFacet,
  TargetCompany,
  User,
  UserSettings,
} from '../types';

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
export const DEMO_ORGS: { name: string; domain: string; industry: string; size: string; slug: string }[] = [
  { name: 'Stripe', domain: 'stripe.com', industry: 'Fintech', size: '5001-10000', slug: 'stripe' },
  { name: 'Figma', domain: 'figma.com', industry: 'Software', size: '1001-5000', slug: 'figma' },
  { name: 'Notion', domain: 'makenotion.com', industry: 'Software', size: '501-1000', slug: 'notion' },
  { name: 'Anthropic', domain: 'anthropic.com', industry: 'AI', size: '1001-5000', slug: 'anthropic' },
  {
    name: 'Goldman Sachs',
    domain: 'gs.com',
    industry: 'Investment banking',
    size: '10001+',
    slug: 'goldman-sachs',
  },
  {
    name: 'McKinsey & Company',
    domain: 'mckinsey.com',
    industry: 'Consulting',
    size: '10001+',
    slug: 'mckinsey',
  },
  { name: 'Ramp', domain: 'ramp.com', industry: 'Fintech', size: '1001-5000', slug: 'ramp' },
  { name: 'Linear', domain: 'linear.app', industry: 'Software', size: '51-200', slug: 'linear' },
  { name: 'Datadog', domain: 'datadoghq.com', industry: 'Software', size: '5001-10000', slug: 'datadog' },
  { name: 'Bain & Company', domain: 'bain.com', industry: 'Consulting', size: '10001+', slug: 'bain' },
  { name: 'Vercel', domain: 'vercel.com', industry: 'Software', size: '201-500', slug: 'vercel' },
  {
    name: 'Jane Street',
    domain: 'janestreet.com',
    industry: 'Trading',
    size: '1001-5000',
    slug: 'jane-street',
  },
];
const TITLES: Record<string, string[]> = {
  swe: [
    'Software Engineer',
    'Senior Software Engineer',
    'Engineering Manager',
    'Staff Engineer',
    'Software Engineer II',
  ],
  pm: ['Product Manager', 'Senior Product Manager', 'Associate Product Manager', 'Group Product Manager'],
  ib: ['Investment Banking Analyst', 'Investment Banking Associate', 'Vice President, M&A'],
  consulting: ['Associate Consultant', 'Consultant', 'Engagement Manager', 'Business Analyst'],
  data: ['Data Scientist', 'Analytics Engineer', 'Machine Learning Engineer'],
  design: ['Product Designer', 'Senior Product Designer', 'Design Lead'],
  other: [
    'Recruiter',
    'University Recruiting Lead',
    'Chief of Staff',
    'Operations Manager',
    'Marketing Manager',
  ],
};
const SCHOOLS = [
  'Cornell University',
  'University of Michigan',
  'UC Berkeley',
  'Georgia Tech',
  'NYU',
  'Carnegie Mellon University',
];

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
  messages: EmailMessage[];
  events: CalendarEvent[];
  chats: CoffeeChat[];
  notes: MeetingNote[];
}

const isoDaysAgo = (now: Date, days: number, hour = 10) => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

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
  const userId = opts.userId ?? 'demo-user';
  const school = opts.school ?? 'Cornell University';
  const userName = opts.userName ?? 'Alex Rivera';
  const userEmail = opts.userEmail ?? 'alex.rivera@cornell.edu';
  const un = parseName(userName);
  const createdAt = isoDaysAgo(now, 1);
  const user: User = {
    id: userId,
    email: userEmail,
    fullName: userName,
    firstName: un.first,
    lastName: un.last,
    school,
    schoolDomain: 'cornell.edu',
    graduationYear: now.getFullYear() + 1,
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
    cycleLabel: `Summer ${now.getFullYear() + 1} internship`,
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
  const targetCompanies: TargetCompany[] = [
    {
      id: 'tc1',
      userId,
      organizationId: 'org_stripe',
      nameRaw: 'Stripe',
      priority: 1,
      status: 'applied',
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
    filename: 'Alex_Rivera_Resume.pdf',
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
      text: `${un.first} is a junior studying Computer Science at ${school}, interested in payments infrastructure and developer tools.`,
      keywords: ['payments', 'infrastructure', 'developer', 'tools'],
      confirmed: true,
    },
    {
      id: 'rf2',
      resumeId: 'resume1',
      kind: 'experience',
      title: 'Software Engineering Intern',
      organizationName: 'Brex',
      startDate: `${now.getFullYear()}-06-01`,
      endDate: `${now.getFullYear()}-08-15`,
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
      startDate: `${now.getFullYear() - 2}-08-01`,
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
  const people: Person[] = [];
  const affiliations: Affiliation[] = [];
  const fnKeys = ['swe', 'swe', 'pm', 'swe', 'data', 'design', 'consulting', 'ib', 'other'];
  const N = 90;
  for (let i = 0; i < N; i++) {
    const first = FIRST[Math.floor(rnd() * FIRST.length)]!;
    const last = LAST[Math.floor(rnd() * LAST.length)]!;
    const org = organizations[Math.floor(rnd() * organizations.length)]!;
    const fn = fnKeys[Math.floor(rnd() * fnKeys.length)]!;
    const title = TITLES[fn]![Math.floor(rnd() * TITLES[fn]!.length)]!;
    const isAlumni = rnd() < 0.35;
    const personSchool = isAlumni ? school : SCHOOLS[Math.floor(rnd() * SCHOOLS.length)]!;
    const id = `p${i + 1}`;
    const slug = `${first}-${last}-${i}`.toLowerCase();
    const email = i < 8 || rnd() < 0.7 ? normalizeEmail(`${first}.${last}${i}@${org.domains[0]}`) : undefined;
    const connectedDaysAgo = Math.floor(rnd() * 900);
    const gradYear = now.getFullYear() - (2 + Math.floor(rnd() * 10));
    const p: Person = {
      id,
      userId,
      displayName: `${first} ${last}`,
      firstName: first,
      lastName: last,
      nameNormalized: `${first} ${last}`.toLowerCase(),
      primaryEmail: email,
      emails: email ? [email] : [],
      linkedinUrl: `https://www.linkedin.com/in/${slug}`,
      linkedinSlug: linkedInSlug(`https://www.linkedin.com/in/${slug}`),
      headline: `${title} at ${org.name}`,
      currentTitle: title,
      currentOrganizationId: org.id,
      currentOrganizationRaw: org.name,
      location: ['New York, NY', 'San Francisco, CA', 'Seattle, WA', 'Chicago, IL', 'Remote'][
        Math.floor(rnd() * 5)
      ],
      school: personSchool,
      isAlumni,
      relationshipType:
        fn === 'other' && title.includes('Recruit') ? 'recruiter' : isAlumni ? 'alumni' : 'unknown',
      strength: 0,
      interactionCount: 0,
      sources: ['linkedin_csv'],
      linkedinConnectedOn: isoDaysAgo(now, connectedDaysAgo).slice(0, 10),
      isHuman: true,
      tags: [],
      createdAt,
      updatedAt: createdAt,
    };
    people.push(p);
    const startYearsAgo = 1 + Math.floor(rnd() * 5);
    affiliations.push({
      id: `a${i}-cur`,
      userId,
      personId: id,
      kind: 'employment',
      organizationId: org.id,
      nameRaw: org.name,
      title,
      startDate: `${now.getFullYear() - startYearsAgo}-0${1 + Math.floor(rnd() * 9)}-01`,
      isCurrent: true,
      source: 'linkedin_csv',
    });
    if (rnd() < 0.7) {
      const prev = organizations[Math.floor(rnd() * organizations.length)]!;
      if (prev.id !== org.id)
        affiliations.push({
          id: `a${i}-prev`,
          userId,
          personId: id,
          kind: 'employment',
          organizationId: prev.id,
          nameRaw: prev.name,
          title: TITLES[fn]![0],
          startDate: `${now.getFullYear() - startYearsAgo - 3}-06-01`,
          endDate: `${now.getFullYear() - startYearsAgo}-01-01`,
          isCurrent: false,
          source: 'enrichment',
        });
    }
    affiliations.push({
      id: `a${i}-edu`,
      userId,
      personId: id,
      kind: 'education',
      nameRaw: personSchool,
      degree: 'BS',
      startDate: `${gradYear - 4}-08-01`,
      endDate: `${gradYear}-05-15`,
      isCurrent: false,
      source: 'enrichment',
    });
  }
  // Relationships with history: threads, messages, events, chats, notes.
  const threads: EmailThread[] = [];
  const messages: EmailMessage[] = [];
  const events: CalendarEvent[] = [];
  const chats: CoffeeChat[] = [];
  const notes: MeetingNote[] = [];
  let mid = 0;
  type Turn = {
    dir: 'inbound' | 'outbound';
    daysAgo: number;
    body: string;
    signal?: EmailMessage['signal'];
    conf?: number;
    times?: { startIso: string; raw: string }[];
  };
  const addThread = (p: Person, subject: string, turns: Turn[]): EmailThread => {
    const tid = `t_${p.id}_${threads.length}`;
    const th: EmailThread = {
      id: tid,
      userId,
      externalThreadId: `ext-${tid}`,
      subject,
      messageCount: turns.length,
      participantEmails: [userEmail, p.primaryEmail ?? `${p.firstName.toLowerCase()}@example.com`],
      participantPersonIds: [p.id],
      category: 'networking',
      categoryConfidence: 0.9,
      isNetworking: true,
      classifiedAt: createdAt,
      classifiedBy: 'heuristic',
    };
    for (const t of turns) {
      const sentAt = isoDaysAgo(now, t.daysAgo, 9 + Math.floor(rnd() * 8));
      messages.push({
        id: `m${mid++}`,
        userId,
        threadId: tid,
        externalMessageId: `ext-m${mid}`,
        direction: t.dir,
        fromEmail:
          t.dir === 'outbound' ? userEmail : (p.primaryEmail ?? `${p.firstName.toLowerCase()}@example.com`),
        fromName: t.dir === 'outbound' ? userName : p.displayName,
        toEmails: t.dir === 'outbound' ? [p.primaryEmail ?? ''] : [userEmail],
        ccEmails: [],
        fromPersonId: t.dir === 'inbound' ? p.id : undefined,
        sentAt,
        subject,
        bodyText: t.body,
        headers: {},
        isAutomated: false,
        signal: t.signal,
        signalConfidence: t.conf ?? (t.signal ? 0.85 : undefined),
        extraction: t.signal
          ? {
              proposedTimes: t.times ?? [],
              asksOfUser: [],
              offers: t.signal === 'referral_offer' ? ['Happy to refer you when the posting goes up.'] : [],
              factsAboutSender: [],
              sentiment: t.signal === 'reply_decline' ? 'cool' : 'warm',
            }
          : undefined,
        processedAt: createdAt,
      });
      th.firstMessageAt = th.firstMessageAt && th.firstMessageAt < sentAt ? th.firstMessageAt : sentAt;
      th.lastMessageAt = th.lastMessageAt && th.lastMessageAt > sentAt ? th.lastMessageAt : sentAt;
    }
    threads.push(th);
    return th;
  };
  const addChat = (p: Person, stage: CoffeeChat['stage'], extra: Partial<CoffeeChat> = {}): CoffeeChat => {
    const c: CoffeeChat = {
      id: `c_${p.id}`,
      userId,
      personId: p.id,
      organizationId: p.currentOrganizationId,
      stage,
      stageEnteredAt: isoDaysAgo(now, 3),
      source: 'detected',
      goalTags: [],
      outreachChannel: 'gmail',
      bumpCount: 0,
      priority: 2,
      createdAt: isoDaysAgo(now, 30),
      updatedAt: isoDaysAgo(now, 1),
      ...extra,
    };
    chats.push(c);
    return c;
  };
  const pick = (i: number) => people[i]!;
  const nextThu = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
    d.setHours(14, 0, 0, 0);
    return d;
  })();
  // 1: outreach sent 8 days ago, no reply -> bump
  {
    const p = pick(0);
    const th = addThread(p, `Quick question about ${p.currentOrganizationRaw}`, [
      {
        dir: 'outbound',
        daysAgo: 8,
        body: `Hi ${p.firstName},\n\nI'm a junior at ${school} studying CS and I came across your profile while looking for alumni in payments. Would you be open to a 20-minute call?\n\nBest,\n${un.first}`,
        signal: 'other',
      },
    ]);
    addChat(p, 'outreach_sent', {
      threadId: th.id,
      firstOutreachAt: isoDaysAgo(now, 8),
      lastOutboundAt: isoDaysAgo(now, 8),
      stageEnteredAt: isoDaysAgo(now, 8),
    });
  }
  // 2: replied positively yesterday -> schedule propose
  {
    const p = pick(1);
    const th = addThread(p, 'Coffee chat?', [
      {
        dir: 'outbound',
        daysAgo: 4,
        body: `Hi ${p.firstName}, fellow ${school} alum here. I'd love to hear about your path to ${p.currentTitle}.`,
        signal: 'other',
      },
      {
        dir: 'inbound',
        daysAgo: 1,
        body: `Hi ${un.first}, happy to chat! Always glad to help a fellow ${school} student. Let me know what works for you.\n\n${p.firstName}`,
        signal: 'reply_positive',
      },
    ]);
    addChat(p, 'replied', {
      threadId: th.id,
      firstOutreachAt: isoDaysAgo(now, 4),
      lastOutboundAt: isoDaysAgo(now, 4),
      lastInboundAt: isoDaysAgo(now, 1),
      stageEnteredAt: isoDaysAgo(now, 1),
    });
  }
  // 3: scheduling with proposed time -> schedule confirm
  {
    const p = pick(2);
    const raw = 'Thursday at 2pm';
    const th = addThread(p, 'Intro + quick chat', [
      {
        dir: 'outbound',
        daysAgo: 5,
        body: `Hi ${p.firstName}, quick note from a ${school} junior recruiting for PM internships...`,
        signal: 'other',
      },
      {
        dir: 'inbound',
        daysAgo: 3,
        body: `Sure! Would ${raw} work? I'm on Eastern time.`,
        signal: 'scheduling_proposal',
        times: [{ startIso: nextThu.toISOString(), raw }],
      },
    ]);
    addChat(p, 'scheduling', {
      threadId: th.id,
      firstOutreachAt: isoDaysAgo(now, 5),
      lastOutboundAt: isoDaysAgo(now, 5),
      lastInboundAt: isoDaysAgo(now, 3),
      stageEnteredAt: isoDaysAgo(now, 3),
    });
  }
  // 4: scheduled tomorrow -> prep brief
  {
    const p = pick(3);
    const start = new Date(now);
    start.setDate(start.getDate() + 1);
    start.setHours(11, 30, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    const th = addThread(p, 'Chat next week', [
      {
        dir: 'outbound',
        daysAgo: 9,
        body: `Hi ${p.firstName}, would love 20 minutes to hear about engineering at ${p.currentOrganizationRaw}.`,
        signal: 'other',
      },
      {
        dir: 'inbound',
        daysAgo: 7,
        body: 'Happy to. Sent you an invite for tomorrow 11:30. Looking forward to it!',
        signal: 'scheduling_confirmation',
      },
    ]);
    const ev: CalendarEvent = {
      id: 'ev_tomorrow',
      userId,
      externalEventId: 'gcal-1',
      title: `${un.first} <> ${p.firstName}`,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      status: 'confirmed',
      attendees: [
        { email: userEmail, self: true, responseStatus: 'accepted' },
        { email: p.primaryEmail ?? 'x@example.com', displayName: p.displayName, responseStatus: 'accepted' },
      ],
      attendeePersonIds: [p.id],
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      isCoffeeChat: true,
      coffeeChatConfidence: 0.95,
    };
    events.push(ev);
    const c = addChat(p, 'scheduled', {
      threadId: th.id,
      scheduledEventId: ev.id,
      firstOutreachAt: isoDaysAgo(now, 9),
      lastOutboundAt: isoDaysAgo(now, 9),
      lastInboundAt: isoDaysAgo(now, 7),
      stageEnteredAt: isoDaysAgo(now, 7),
    });
    ev.chatId = c.id;
  }
  // 5: completed yesterday with a Granola note -> thank you
  {
    const p = pick(4);
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    const th = addThread(p, 'Coffee chat', [
      {
        dir: 'outbound',
        daysAgo: 12,
        body: `Hi ${p.firstName}, I'd love to learn how you think about product at ${p.currentOrganizationRaw}.`,
        signal: 'other',
      },
      {
        dir: 'inbound',
        daysAgo: 10,
        body: "Sure thing, let's do next week. I'll send an invite.",
        signal: 'scheduling_confirmation',
      },
    ]);
    const ev: CalendarEvent = {
      id: 'ev_yesterday',
      userId,
      externalEventId: 'gcal-2',
      title: `Coffee chat: ${p.firstName} / ${un.first}`,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      status: 'confirmed',
      attendees: [
        { email: userEmail, self: true },
        { email: p.primaryEmail ?? 'y@example.com', displayName: p.displayName },
      ],
      attendeePersonIds: [p.id],
      isCoffeeChat: true,
      coffeeChatConfidence: 0.95,
    };
    events.push(ev);
    const c = addChat(p, 'completed', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: end.toISOString(),
      firstOutreachAt: isoDaysAgo(now, 12),
      lastOutboundAt: isoDaysAgo(now, 12),
      lastInboundAt: isoDaysAgo(now, 10),
      stageEnteredAt: end.toISOString(),
    });
    ev.chatId = c.id;
    notes.push({
      id: 'note1',
      userId,
      source: 'granola_email',
      externalId: 'granola-1',
      title: `Coffee chat with ${p.displayName}`,
      occurredAt: start.toISOString(),
      rawText: `Summary\n${p.firstName} leads a small team on payments onboarding at ${p.currentOrganizationRaw}. They recommended focusing on one concrete project story for interviews and said the key is showing how you handled ambiguity. They are hiring interns in January for the platform team. ${p.firstName} offered to refer me when the posting goes up. I will send my resume by Friday and share the marketplace project link. They ran a marathon in April and grew up in Chicago.\n\nTranscript\n...`,
      attendees: [{ name: p.displayName, email: p.primaryEmail }],
      personIds: [p.id],
      chatId: c.id,
      calendarEventId: ev.id,
      matchStatus: 'auto',
      matchConfidence: 0.98,
      createdAt: end.toISOString(),
    });
  }
  // 6: nurturing mentor with a hook (talked 50 days ago)
  {
    const p = pick(5);
    p.relationshipType = 'mentor';
    const th = addThread(p, 'Thank you!', [
      {
        dir: 'outbound',
        daysAgo: 80,
        body: `Hi ${p.firstName}, would love to hear your story.`,
        signal: 'other',
      },
      { dir: 'inbound', daysAgo: 78, body: "Of course, let's find a time.", signal: 'reply_positive' },
      {
        dir: 'outbound',
        daysAgo: 50,
        body: `Thank you for taking the time today, ${p.firstName}. Your point about owning a metric stuck with me.`,
        signal: 'thank_you',
      },
    ]);
    const start = new Date(isoDaysAgo(now, 51, 16));
    const ev: CalendarEvent = {
      id: 'ev_old',
      userId,
      externalEventId: 'gcal-3',
      title: `${p.firstName} / ${un.first}`,
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 1800_000).toISOString(),
      status: 'confirmed',
      attendees: [{ email: userEmail, self: true }, { email: p.primaryEmail ?? 'z@example.com' }],
      attendeePersonIds: [p.id],
      isCoffeeChat: true,
      coffeeChatConfidence: 0.95,
    };
    events.push(ev);
    const c = addChat(p, 'nurturing', {
      threadId: th.id,
      scheduledEventId: ev.id,
      completedAt: ev.endAt,
      followedUpAt: isoDaysAgo(now, 50),
      firstOutreachAt: isoDaysAgo(now, 80),
      lastOutboundAt: isoDaysAgo(now, 50),
      lastInboundAt: isoDaysAgo(now, 78),
      stageEnteredAt: isoDaysAgo(now, 36),
    });
    ev.chatId = c.id;
    notes.push({
      id: 'note2',
      userId,
      source: 'manual',
      title: `Chat with ${p.displayName}`,
      occurredAt: ev.startAt,
      rawText: `${p.firstName} said the team is launching a new product in November and would love to hear what I think after it ships. Recommended reading "Working Backwards". Happy to intro me to their PM lead.`,
      attendees: [{ name: p.displayName }],
      personIds: [p.id],
      chatId: c.id,
      calendarEventId: ev.id,
      matchStatus: 'confirmed',
      matchConfidence: 1,
      createdAt: ev.endAt,
    });
  }
  // 7: declined
  {
    const p = pick(6);
    const th = addThread(p, 'Quick chat?', [
      { dir: 'outbound', daysAgo: 20, body: `Hi ${p.firstName}...`, signal: 'other' },
      {
        dir: 'inbound',
        daysAgo: 18,
        body: 'Unfortunately I am not able to take calls this quarter. Best of luck with the search!',
        signal: 'reply_decline',
      },
    ]);
    addChat(p, 'declined', {
      threadId: th.id,
      firstOutreachAt: isoDaysAgo(now, 20),
      lastOutboundAt: isoDaysAgo(now, 20),
      lastInboundAt: isoDaysAgo(now, 18),
      stageEnteredAt: isoDaysAgo(now, 18),
    });
  }
  // 8: warming up a cold LinkedIn target at a priority-1 company
  {
    const p =
      people.find((x, i) => i > 7 && x.currentOrganizationId === 'org_figma' && !x.primaryEmail) ??
      people.find((x, i) => i > 7 && !x.primaryEmail) ??
      pick(7);
    p.primaryEmail = undefined;
    p.emails = [];
    const started = new Date(isoDaysAgo(now, 2));
    addChat(p, 'warming', {
      outreachChannel: 'linkedin',
      source: 'recommendation',
      stageEnteredAt: started.toISOString(),
      warmUp: {
        startedAt: started.toISOString(),
        readyAt: isoDaysAgo(now, -2, 9),
        actions: [
          {
            id: 'w1',
            kind: 'view_profile',
            label: 'View their profile and follow them',
            url: `https://www.linkedin.com/in/${p.linkedinSlug}/`,
            dueAt: started.toISOString(),
            doneAt: started.toISOString(),
          },
          {
            id: 'w2',
            kind: 'react_post',
            label: 'React to one recent post that you genuinely find useful',
            url: `https://www.linkedin.com/in/${p.linkedinSlug}/recent-activity/all/`,
            dueAt: isoDaysAgo(now, 0, 10),
          },
          {
            id: 'w3',
            kind: 'comment_post',
            label: 'Leave one specific, non-flattering comment (a question or an added point)',
            url: `https://www.linkedin.com/in/${p.linkedinSlug}/recent-activity/all/`,
            dueAt: isoDaysAgo(now, -1, 10),
          },
        ],
      },
    });
  }
  // some generic correspondence to give the graph texture
  for (let i = 8; i < 30; i++) {
    const p = pick(i);
    if (!p.primaryEmail) continue;
    const n = 1 + Math.floor(rnd() * 3);
    const turns: Turn[] = [];
    for (let k = 0; k < n; k++)
      turns.push({
        dir: k % 2 === 0 ? 'outbound' : 'inbound',
        daysAgo: 20 + Math.floor(rnd() * 300) - k,
        body:
          k % 2 === 0
            ? `Hi ${p.firstName}, hope you're well — quick question about ${p.currentOrganizationRaw}.`
            : `Hi ${un.first}, happy to help. Let me know what you'd like to cover.`,
        signal: k % 2 === 0 ? 'other' : 'reply_positive',
      });
    addThread(p, `Catching up`, turns);
  }
  // a couple of group threads so co-thread edges exist
  for (let g = 0; g < 4; g++) {
    const a = pick(30 + g * 2);
    const b = pick(31 + g * 2);
    if (!a.primaryEmail || !b.primaryEmail) continue;
    const tid = `t_group_${g}`;
    const sentAt = isoDaysAgo(now, 40 + g * 30);
    threads.push({
      id: tid,
      userId,
      externalThreadId: `ext-${tid}`,
      subject: 'Intro: you two should meet',
      messageCount: 1,
      participantEmails: [userEmail, a.primaryEmail ?? '', b.primaryEmail ?? ''],
      participantPersonIds: [a.id, b.id],
      category: 'networking',
      isNetworking: true,
      firstMessageAt: sentAt,
      lastMessageAt: sentAt,
      classifiedBy: 'heuristic',
    });
    messages.push({
      id: `m${mid++}`,
      userId,
      threadId: tid,
      externalMessageId: `ext-mg${g}`,
      direction: 'inbound',
      fromEmail: a.primaryEmail ?? 'a@example.com',
      fromName: a.displayName,
      toEmails: [userEmail],
      ccEmails: [b.primaryEmail ?? ''],
      fromPersonId: a.id,
      sentAt,
      subject: 'Intro: you two should meet',
      bodyText: `${un.first}, meet ${b.firstName}. ${b.firstName} runs a team you'd find interesting.`,
      headers: {},
      isAutomated: false,
      signal: 'intro_offer',
      signalConfidence: 0.9,
      processedAt: createdAt,
    });
  }
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
    chats,
    notes,
  };
}
