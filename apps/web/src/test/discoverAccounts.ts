/**
 * Made-up students and the people Discover could put in front of them, for the Discover simulation: a seeded
 * generator, so every run builds the same accounts. Each account is written straight into the (fake) database under
 * its own user: goals, target companies, a resume, the network (people, edges, touches, chats, dismissed cards) and
 * the pages of new people LinkedIn searches found (the feed state in `kv`). Every candidate carries the archetype it
 * was made as, so the simulation can say who must never be suggested and who a career coach would expect to see.
 */
import type {
  Affiliation,
  CoffeeChat,
  Edge,
  Person,
  Recommendation,
  ResumeFacet,
  Touchpoint,
  User,
  UserSettings,
} from '@orbit/core';
import { db } from '../db/schema';
import { entryFrom, type FeedState, type FoundEntry } from '../engine/discoverFeed';
import { rng } from './morningAccounts';

export type Goal = 'pm' | 'swe' | 'ib' | 'consulting' | 'design' | 'research' | 'undecided';

interface GoalSpec {
  functions: string[];
  roles: string[];
  titles: string[];
  companies: string[];
  industries: string[];
  vp: string;
  intern: string;
}

export const GOALS: Record<Goal, GoalSpec> = {
  pm: {
    functions: ['pm'],
    roles: ['Product Manager Intern'],
    titles: [
      'Product Manager',
      'Associate Product Manager',
      'Senior Product Manager',
      'Sr Product Manager',
      'APM',
      'Product Manager II',
    ],
    companies: ['Google', 'Stripe', 'Notion', 'Airbnb', 'Ramp', 'Meta', 'Plaid'],
    industries: ['fintech'],
    vp: 'VP of Product',
    intern: 'Product Manager Intern',
  },
  swe: {
    functions: ['swe'],
    roles: ['Software Engineering Intern'],
    titles: [
      'Software Engineer',
      'Senior Software Engineer',
      'Software Engineer II',
      'Backend Engineer',
      'New Grad Software Engineer',
    ],
    companies: ['Stripe', 'Databricks', 'Jane Street', 'Figma', 'Datadog', 'Google'],
    industries: ['developer tools'],
    vp: 'Vice President, Engineering',
    intern: 'Software Engineering Intern',
  },
  ib: {
    functions: ['ib'],
    roles: ['Investment Banking Summer Analyst'],
    titles: [
      'Investment Banking Analyst',
      'Analyst, Investment Banking',
      'M&A Associate',
      'Investment Banking Associate',
    ],
    companies: ['Goldman Sachs', 'Morgan Stanley', 'Evercore', 'Lazard', 'Centerview Partners', 'JPMorgan'],
    industries: [],
    vp: 'Vice President, Investment Banking',
    intern: 'Investment Banking Summer Analyst',
  },
  consulting: {
    functions: ['consulting'],
    roles: ['Consulting Intern'],
    titles: ['Consultant', 'Associate Consultant', 'Senior Consultant', 'Strategy Consultant'],
    companies: ['McKinsey', 'Bain', 'BCG', 'Oliver Wyman', 'Deloitte'],
    industries: [],
    vp: 'Partner',
    intern: 'Summer Associate',
  },
  design: {
    functions: ['design'],
    roles: ['Product Design Intern'],
    titles: ['Product Designer', 'Senior Product Designer', 'UX Designer', 'Interaction Designer'],
    companies: ['Figma', 'Airbnb', 'Notion', 'Spotify', 'Duolingo'],
    industries: [],
    vp: 'VP of Design',
    intern: 'Product Design Intern',
  },
  research: {
    functions: ['research'],
    roles: ['Research Intern'],
    titles: ['Research Scientist', 'Research Engineer', 'Applied Research Scientist'],
    companies: ['OpenAI', 'DeepMind', 'Microsoft Research', 'Allen Institute'],
    industries: [],
    vp: 'Director of Research',
    intern: 'Research Intern',
  },
  undecided: {
    functions: [],
    roles: [],
    titles: ['Analyst', 'Associate', 'Software Engineer', 'Product Manager'],
    companies: ['Stripe', 'Google', 'McKinsey'],
    industries: [],
    vp: 'Vice President',
    intern: 'Summer Intern',
  },
};

const SCHOOLS = [
  'UC Berkeley',
  'Cornell University',
  'University of Michigan',
  'Georgia Institute of Technology',
  'New York University',
];
const UNRELATED_TITLES = [
  'Accountant',
  'Account Executive',
  'HR Generalist',
  'Customer Success Manager',
  'Registered Nurse',
  'Sales Development Representative',
];
const UNRELATED_COS = ['Acme Insurance', 'Globex Logistics', 'Initech', 'Umbrella Health', 'Hooli Realty'];
const RECRUITERS = ['Technical Recruiter', 'University Recruiter', 'Talent Acquisition Partner'];
const STUDENTS = [
  'Computer Science Student at {school}',
  'Aspiring Product Manager | {school}',
  'Economics major at {school}',
  'Seeking SWE internships',
];
const HEADLINE_ONLY = [
  'Experienced and versatile Product Manager',
  'Passionate about building products people love',
  'Results-driven leader | Strategy | Growth',
  'Helping startups scale',
  'Seasoned Software Engineer',
  'Dynamic and creative Product Designer',
];
const SPAM = [
  '💰 Crypto millionaire | DM me for passive income',
  'FOREX TRADER 📈 LINK IN BIO',
  'I help coaches make $10k/month 🚀',
];
const FIRST = [
  'Maya',
  'Omar',
  'Lena',
  'Caleb',
  'Priya',
  'Jordan',
  'Ravi',
  'Hannah',
  'Felix',
  'Noah',
  'Ana',
  'Chaya',
  'Isabella',
  'Tomás',
  'Zara',
  'Kenji',
  'Amara',
  'Diego',
];
const LAST = [
  'Chen',
  'Haddad',
  'Novak',
  'Weber',
  'Shah',
  'Lee',
  'Jain',
  'Brooks',
  'Adeyemi',
  'Kim',
  "O'Neil",
  'Mendelsohn',
  'Jordan',
  'Park',
  'Okafor',
  'Lindqvist',
];

/** What a candidate was made as. `bad` ones must never be suggested; `good` ones a coach would expect to see. */
export type Archetype =
  // new people from LinkedIn searches
  | 'f_target_role' // the target role at a target company, second degree with mutuals
  | 'f_target_role_3rd' // the same, third degree
  | 'f_alum_field' // an alum of the student's school in the target role, not at a target company
  | 'f_alum_target' // an alum at a target company (any role)
  | 'f_colleague' // in the target role where a friend the student knows well works
  | 'f_shared_org' // at an organisation on the student's resume
  | 'f_caps_name' // a strong pick whose name LinkedIn has in capitals
  | 'f_initial_last' // a strong pick with only an initial for a last name
  | 'f_intern_target' // an intern in the target role at a target company
  | 'f_recruiter_target' // a recruiter at a target company
  | 'f_vp_target' // a VP at a target company
  | 'f_weak_fit' // an unrelated role at an unrelated company
  | 'f_mutuals_only' // unrelated, but dozens of mutual connections
  | 'f_role_only' // the target role at a company nobody targets: true of thousands
  | 'f_headline_only' // a headline that describes, no company
  | 'f_no_title' // no headline at all
  | 'f_initials_only' // "J. S."
  | 'f_no_name' // "LinkedIn Member"
  | 'f_spam' // an all-caps or money headline
  | 'f_student' // a student, or a hopeful headline
  | 'f_known' // already in Orbit (name and company)
  | 'f_dismissed' // turned down on Discover
  | 'f_acted' // already saved or written to from Discover
  | 'f_dup' // the same person found twice under two member ids
  | 'f_other' // neither a must nor a never (an alum in another field at a company nobody targets)
  // people in the network
  | 'n_target_role' // the target role at a target company, a LinkedIn connection
  | 'n_alum_field' // an alum in the target role
  | 'n_friend_field' // someone the student knows a little, in the target function
  | 'n_replied_field' // replied to the student before (no chat), in the target function
  | 'n_intro_target' // the target role at a target company, introduced through a friend
  | 'n_friend' // a friend the student knows well (an introducer), anywhere
  | 'n_connected_only' // the target function at no target company, a LinkedIn connection and nothing else
  | 'n_friend_unrelated' // a friend in an unrelated role
  | 'n_contacted' // the target role at a target company, already in a chat
  | 'n_wrote_no_reply' // written to by email, no answer yet (no chat)
  | 'n_hidden'
  | 'n_dnc'
  | 'n_dismissed'
  | 'n_no_title'
  | 'n_initials'
  | 'n_caps_name' // a strong pick written in capitals
  | 'n_dup' // two records of one person at a target company
  | 'n_filler' // the rest of a big network: unrelated people
  | 'n_other'; // neither a must nor a never

export const BAD = new Set<Archetype>([
  'f_weak_fit',
  'f_mutuals_only',
  'f_role_only',
  'f_headline_only',
  'f_no_title',
  'f_initials_only',
  'f_no_name',
  'f_spam',
  'f_student',
  'f_known',
  'f_dismissed',
  'f_acted',
  'n_connected_only',
  'n_friend_unrelated',
  'n_contacted',
  'n_wrote_no_reply',
  'n_hidden',
  'n_dnc',
  'n_dismissed',
  'n_no_title',
  'n_initials',
  'n_filler',
]);

/** Strong new people: a coach would expect every one of them in the feed. */
export const GOOD_FOUND = new Set<Archetype>([
  'f_target_role',
  'f_alum_field',
  'f_alum_target',
  'f_shared_org',
  'f_caps_name',
]);

export interface DiscoverSpec {
  name: string;
  seed: number;
  goal: Goal;
  school: string;
  targets: number;
  linkedin: boolean;
  network: number;
  found: number;
  warmUp: boolean;
  resume: boolean;
}

export interface DiscoverBuilt {
  spec: DiscoverSpec;
  user: User;
  now: Date;
  goal: GoalSpec;
  targets: string[];
  /** by member id (new people) and by person id (the network) */
  archetype: Map<string, Archetype>;
  /** the person a duplicate is a copy of (member id or person id), for the dedupe check */
  dupOf: Map<string, string>;
  people: Person[];
  chats: CoffeeChat[];
  found: FoundEntry[];
  /** a friend the student knows well at each company, by company */
  friendAt: Map<string, Person>;
}

export const SIM_NOW = new Date('2026-10-06T15:00:00.000Z');
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number) => iso(new Date(SIM_NOW.getTime() - n * 86_400_000));

/** Hundreds of students of every shape. */
export function discoverSpecs(): DiscoverSpec[] {
  const out: DiscoverSpec[] = [];
  const goals = Object.keys(GOALS) as Goal[];
  const r = rng(4242);
  let seed = 1;
  // every goal with every network size, LinkedIn on and off
  for (const goal of goals)
    for (const network of [0, 6, 40, 150])
      for (const linkedin of [true, false])
        out.push({
          name: `${goal}-net${network}-${linkedin ? 'li' : 'noli'}`,
          seed: seed++,
          goal,
          school: r.pick(SCHOOLS),
          targets: goal === 'undecided' ? 0 : r.pick([0, 2, 4, 6]),
          linkedin,
          network,
          found: linkedin ? r.pick([12, 30, 60]) : 0,
          warmUp: r.chance(0.8),
          resume: r.chance(0.6),
        });
  // a few very large networks
  for (const goal of ['pm', 'swe', 'ib'] as Goal[])
    out.push({
      name: `${goal}-net2000`,
      seed: seed++,
      goal,
      school: r.pick(SCHOOLS),
      targets: 5,
      linkedin: true,
      network: 2000,
      found: 80,
      warmUp: true,
      resume: true,
    });
  // and the rest at random
  while (out.length < 320)
    out.push({
      name: `random-${out.length}`,
      seed: seed++,
      goal: r.pick(goals),
      school: r.pick(SCHOOLS),
      targets: r.pick([0, 0, 1, 3, 5, 8]),
      linkedin: r.chance(0.7),
      network: r.pick([0, 3, 12, 60, 200, 400]),
      found: r.pick([0, 8, 25, 50]),
      warmUp: r.chance(0.8),
      resume: r.chance(0.5),
    });
  for (const s of out) if (!s.linkedin) s.found = 0;
  return out;
}

let uid = 0;

export async function buildDiscover(spec: DiscoverSpec): Promise<DiscoverBuilt> {
  const r = rng(spec.seed * 7919);
  const g = GOALS[spec.goal];
  const userId = `dsim-u${++uid}`;
  const now = SIM_NOW;
  const user: User = {
    id: userId,
    email: `student${uid}@school.edu`,
    fullName: 'Sam Rivera',
    firstName: 'Sam',
    lastName: 'Rivera',
    school: spec.school,
    majors: ['Economics'],
    graduationYear: 2027,
    timezone: 'America/New_York',
    onboardingStep: 11,
    onboardingCompletedAt: daysAgo(30),
    createdAt: daysAgo(60),
  };
  await db.users.put(user);
  const settings: UserSettings = {
    userId,
    briefTimeLocal: '07:00',
    briefChannels: ['in_app'],
    quietDays: [],
    weeklyOutreachTarget: 3,
    dailySendCapGmail: 20,
    dailySendCapLinkedin: 10,
    perPersonCooldownHours: 48,
    maxBumps: 2,
    tonePreset: 'warm',
    warmUpEnabled: spec.warmUp,
    warmUpDays: 4,
  };
  await db.settings.put(settings);
  await db.goals.put({
    userId,
    cycleLabel: 'Summer 2027',
    targetRoles: g.roles,
    targetFunctions: g.functions,
    targetIndustries: g.industries,
    targetLocations: r.chance(0.5) ? ['San Francisco', 'New York'] : [],
    ambition: 2,
  });
  const targets = g.companies.slice(0, Math.min(spec.targets, g.companies.length));
  for (const [i, name] of targets.entries())
    await db.targetCompanies.put({
      id: `${userId}-tc${i}`,
      userId,
      nameRaw: name,
      priority: (Math.min(3, 1 + Math.floor(i / 2)) as 1 | 2 | 3) ?? 1,
      status: 'researching',
    });
  const sharedOrg = 'Acme Robotics';
  if (spec.resume) {
    const resumeId = `${userId}-resume`;
    await db.resumes.put({
      id: resumeId,
      userId,
      filename: 'resume.pdf',
      text: '',
      isCurrent: true,
      createdAt: daysAgo(40),
      parsedAt: daysAgo(40),
    });
    const facet: ResumeFacet = {
      id: `${userId}-f1`,
      resumeId,
      kind: 'experience',
      title: 'Summer Intern',
      organizationName: sharedOrg,
      startDate: '2025-06',
      endDate: '2025-08',
      text: 'Interned on the product team',
      keywords: ['product', 'robotics'],
      confirmed: true,
    };
    await db.resumeFacets.put(facet);
  }
  if (spec.linkedin)
    await db.integrations.put({
      id: `${userId}-li`,
      userId,
      provider: 'linkedin_live',
      externalAccountId: `acc-${userId}`,
      accessToken: 'tok',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: daysAgo(10),
    } as never);

  const archetype = new Map<string, Archetype>();
  const dupOf = new Map<string, string>();
  const people: Person[] = [];
  const chats: CoffeeChat[] = [];
  const edges: Edge[] = [];
  const touches: Touchpoint[] = [];
  const affiliations: Affiliation[] = [];
  const recs: Recommendation[] = [];
  const usedNames = new Set<string>();
  const freshName = (): [string, string] => {
    for (let i = 0; i < 50; i++) {
      const f = r.pick(FIRST);
      const l = r.pick(LAST);
      if (!usedNames.has(`${f} ${l}`)) {
        usedNames.add(`${f} ${l}`);
        return [f, l];
      }
    }
    // a big network runs out of pairs: double-barrelled last names (letters only, so names stay names)
    for (;;) {
      const f = r.pick(FIRST);
      const l = `${r.pick(LAST)}-${r.pick(LAST)}`;
      if (usedNames.has(`${f} ${l}`)) continue;
      usedNames.add(`${f} ${l}`);
      return [f, l];
    }
  };
  const fieldTitle = () => r.pick(g.titles);
  const target = () => (targets.length ? r.pick(targets) : r.pick(g.companies));
  const nonTarget = () => {
    const pool = ['Acme Labs', 'Brightwave', 'Northwind', 'Contoso', 'Vandelay', 'Pied Piper', 'Hooli'];
    return r.pick(pool);
  };

  // ---- the network ----
  let pi = 0;
  const person = (a: Archetype, p: Partial<Person> & { first?: string; last?: string }): Person => {
    const [f0, l0] = p.first !== undefined ? [p.first, p.last ?? ''] : freshName();
    const id = `${userId}-p${pi++}`;
    const displayName = p.displayName ?? `${f0} ${l0}`.trim();
    const row: Person = {
      id,
      userId,
      displayName,
      firstName: f0,
      lastName: l0,
      nameNormalized: displayName.toLowerCase(),
      emails: [],
      linkedinUrl: `https://www.linkedin.com/in/${id}`,
      linkedinSlug: id,
      relationshipType: 'unknown' as Person['relationshipType'],
      strength: 0,
      interactionCount: 0,
      sources: ['linkedin_csv'],
      isHuman: true,
      tags: [],
      createdAt: daysAgo(200),
      updatedAt: daysAgo(10),
      ...p,
    };
    delete (row as { first?: string }).first;
    delete (row as { last?: string }).last;
    people.push(row);
    archetype.set(id, a);
    return row;
  };
  const friendAt = new Map<string, Person>();
  const friend = (company: string, title: string) => {
    const p = person('n_friend', {
      currentTitle: title,
      currentOrganizationRaw: company,
      strength: 0.6 + r.next() * 0.25,
      tieScore: 70,
      tieBand: 'strong',
      interactionCount: 12,
      lastInteractionAt: daysAgo(20),
      primaryEmail: `friend${pi}@mail.com`,
      emails: [`friend${pi}@mail.com`],
      sources: ['gmail'],
    });
    friendAt.set(company, p);
    return p;
  };
  const n = spec.network;
  if (n > 0) {
    // a few friends the student knows well, some at target companies: the way in to their colleagues
    const friends = Math.min(n, n >= 40 ? 4 : 1);
    for (let i = 0; i < friends; i++)
      friend(i % 2 === 0 ? target() : nonTarget(), r.chance(0.5) ? fieldTitle() : r.pick(UNRELATED_TITLES));
    const mix: Archetype[] = [
      'n_target_role',
      'n_alum_field',
      'n_friend_field',
      'n_replied_field',
      'n_intro_target',
      'n_connected_only',
      'n_friend_unrelated',
      'n_contacted',
      'n_wrote_no_reply',
      'n_hidden',
      'n_dnc',
      'n_dismissed',
      'n_no_title',
      'n_initials',
      'n_caps_name',
      'n_dup',
    ];
    const special = Math.min(n - friends, n >= 150 ? 60 : n >= 40 ? 24 : n);
    for (let i = 0; i < special; i++) {
      const a = n < 16 ? r.pick(mix) : mix[i % mix.length]!;
      const connected = { linkedinConnectedOn: daysAgo(300 + r.int(0, 900)) };
      switch (a) {
        case 'n_target_role':
        case 'n_contacted':
        case 'n_dismissed':
        case 'n_hidden':
        case 'n_dnc': {
          const p = person(a, { currentTitle: fieldTitle(), currentOrganizationRaw: target(), ...connected });
          if (a === 'n_hidden') p.hiddenAt = daysAgo(3);
          if (a === 'n_dnc') p.doNotContact = true;
          if (a === 'n_contacted')
            chats.push({
              id: `${p.id}-chat`,
              userId,
              personId: p.id,
              stage: r.pick([
                'identified',
                'warming',
                'outreach_sent',
                'replied',
                'no_response',
                'archived',
                'declined',
                'scheduled',
              ] as const),
              stageEnteredAt: daysAgo(5),
              source: 'manual',
              goalTags: [],
              bumpCount: 0,
              createdAt: daysAgo(20),
              updatedAt: daysAgo(5),
            } as never);
          if (a === 'n_dismissed')
            recs.push({
              id: `rec-${p.id}-old`,
              userId,
              personId: p.id,
              score: 0.5,
              fitScore: 0.5,
              reachScore: 0.3,
              responsePrior: 0.5,
              reasons: [],
              status: 'dismissed',
              dismissedReason: 'not_now',
              batchDate: daysAgo(3).slice(0, 10),
            });
          break;
        }
        case 'n_alum_field': {
          const p = person(a, {
            currentTitle: fieldTitle(),
            currentOrganizationRaw: nonTarget(),
            isAlumni: true,
            school: spec.school,
            ...connected,
          });
          affiliations.push({
            id: `${p.id}-edu`,
            userId,
            personId: p.id,
            kind: 'education',
            nameRaw: spec.school,
            endDate: '2022-05',
            isCurrent: false,
            source: 'linkedin_csv',
          });
          break;
        }
        case 'n_friend_field':
          person(a, {
            currentTitle: fieldTitle(),
            currentOrganizationRaw: nonTarget(),
            strength: 0.35 + r.next() * 0.15,
            tieScore: 40,
            tieBand: 'light',
            interactionCount: 4,
            lastInteractionAt: daysAgo(60),
            primaryEmail: `p${pi}@mail.com`,
            emails: [`p${pi}@mail.com`],
            sources: ['gmail'],
          });
          break;
        case 'n_replied_field': {
          const p = person(a, {
            currentTitle: fieldTitle(),
            currentOrganizationRaw: r.chance(0.5) ? target() : nonTarget(),
            strength: 0.3,
            tieScore: 32,
            tieBand: 'light',
            interactionCount: 2,
            lastInteractionAt: daysAgo(150),
            primaryEmail: `p${pi}@mail.com`,
            emails: [`p${pi}@mail.com`],
            sources: ['gmail'],
          });
          touches.push(
            {
              id: `${p.id}-t1`,
              userId,
              personId: p.id,
              kind: 'email_out',
              occurredAt: daysAgo(160),
              refTable: 'messages',
              refId: `${p.id}-m1`,
              weight: 0.3,
            },
            {
              id: `${p.id}-t2`,
              userId,
              personId: p.id,
              kind: 'email_in',
              occurredAt: daysAgo(150),
              refTable: 'messages',
              refId: `${p.id}-m2`,
              weight: 0.3,
            },
          );
          break;
        }
        case 'n_intro_target': {
          const via = [...friendAt.values()][0];
          const p = person(a, { currentTitle: fieldTitle(), currentOrganizationRaw: target(), ...connected });
          if (via)
            edges.push({
              id: `${p.id}-e`,
              userId,
              personAId: via.id,
              personBId: p.id,
              type: 'co_tenure',
              weight: 0.6,
              evidence: { overlapMonths: 18, text: 'Worked together' },
            });
          break;
        }
        case 'n_connected_only':
          person(a, { currentTitle: fieldTitle(), currentOrganizationRaw: nonTarget(), ...connected });
          break;
        case 'n_friend_unrelated':
          person(a, {
            currentTitle: r.pick(UNRELATED_TITLES),
            currentOrganizationRaw: r.pick(UNRELATED_COS),
            strength: 0.5,
            tieScore: 55,
            tieBand: 'warm',
            interactionCount: 8,
            primaryEmail: `p${pi}@mail.com`,
            emails: [`p${pi}@mail.com`],
            sources: ['gmail'],
          });
          break;
        case 'n_wrote_no_reply': {
          const p = person(a, {
            currentTitle: fieldTitle(),
            currentOrganizationRaw: target(),
            primaryEmail: `p${pi}@mail.com`,
            emails: [`p${pi}@mail.com`],
            sources: ['gmail'],
            strength: 0.05,
          });
          touches.push({
            id: `${p.id}-t1`,
            userId,
            personId: p.id,
            kind: 'email_out',
            occurredAt: daysAgo(12),
            refTable: 'messages',
            refId: `${p.id}-m1`,
            weight: 0.3,
          });
          break;
        }
        case 'n_no_title':
          person(a, { ...connected });
          break;
        case 'n_initials':
          person(a, {
            first: 'J.',
            last: 'S.',
            displayName: 'J. S.',
            currentTitle: fieldTitle(),
            currentOrganizationRaw: target(),
            ...connected,
          });
          break;
        case 'n_caps_name': {
          const [f, l] = freshName();
          person(a, {
            first: f.toUpperCase(),
            last: l.toUpperCase(),
            displayName: `${f} ${l}`.toUpperCase(),
            currentTitle: fieldTitle(),
            currentOrganizationRaw: target(),
            ...connected,
          });
          break;
        }
        case 'n_dup': {
          const [f, l] = freshName();
          const company = target();
          const title = fieldTitle();
          const a1 = person(a, {
            first: f,
            last: l,
            currentTitle: title,
            currentOrganizationRaw: company,
            ...connected,
          });
          const a2 = person(a, {
            first: f,
            last: l,
            currentTitle: title,
            currentOrganizationRaw: company,
            linkedinConnectedOn: undefined,
            sources: ['gmail'],
          });
          dupOf.set(a2.id, a1.id);
          break;
        }
      }
    }
    // the rest of a big network: people from all walks of life, a few in the field
    while (people.length < n)
      person('n_filler', {
        currentTitle: r.pick(UNRELATED_TITLES),
        currentOrganizationRaw: r.pick(UNRELATED_COS),
        linkedinConnectedOn: daysAgo(400),
      });
  }

  // ---- new people from LinkedIn searches ----
  const found: FoundEntry[] = [];
  const feed: FeedState = {
    v: 1,
    day: iso(now).slice(0, 10),
    searches: 3,
    queries: {},
    people: [],
    dismissed: [],
    acted: [],
  };
  let mi = 0;
  const add = (
    a: Archetype,
    o: {
      name?: string;
      headline?: string;
      distance?: 2 | 3;
      mutuals?: number;
      school?: boolean;
      q?: { company?: string; title?: string };
    },
  ) => {
    const [f, l] = freshName();
    const memberId = `${userId}-m${mi++}`;
    const distance = o.distance ?? (r.chance(0.65) ? 2 : 3);
    const q = {
      key: `q${mi % 5}`,
      why: o.q?.company ? `${o.q.title ?? 'People'} at ${o.q.company}` : `${spec.school} alumni`,
      school: o.school ? spec.school : undefined,
      company: o.q?.company,
      title: o.q?.title,
    };
    const e = entryFrom(
      {
        memberId,
        name: o.name ?? `${f} ${l}`,
        headline: o.headline,
        location: r.pick(['San Francisco Bay Area', 'New York, New York', 'Remote', 'Chicago, Illinois']),
        profileUrl: `https://www.linkedin.com/in/${memberId}`,
        distance,
        mutualCount: distance === 2 ? (o.mutuals ?? r.int(1, 12)) : undefined,
        pictureUrl: r.chance(0.7) ? `https://example.com/${memberId}.jpg` : undefined,
      },
      q,
      spec.school,
      iso(now),
    );
    feed.people.push(e);
    found.push(e);
    archetype.set(memberId, a);
    return e;
  };
  const kinds: Archetype[] = [
    'f_target_role',
    'f_target_role_3rd',
    'f_alum_field',
    'f_alum_target',
    'f_colleague',
    'f_shared_org',
    'f_caps_name',
    'f_initial_last',
    'f_intern_target',
    'f_recruiter_target',
    'f_vp_target',
    'f_weak_fit',
    'f_mutuals_only',
    'f_role_only',
    'f_headline_only',
    'f_no_title',
    'f_initials_only',
    'f_no_name',
    'f_spam',
    'f_student',
    'f_known',
    'f_dismissed',
    'f_acted',
    'f_dup',
  ];
  const friendCos = [...friendAt.keys()];
  const hasT = targets.length > 0;
  // without a target list a "target" company is just a company: the person is then a role true of thousands
  const t = (a: Archetype): Archetype => (hasT ? a : 'f_role_only');
  for (let i = 0; i < spec.found; i++) {
    const a = spec.found < kinds.length ? r.pick(kinds) : kinds[i % kinds.length]!;
    const title = fieldTitle();
    const tc = target();
    const at = (t: string, c: string) => `${t} at ${c}`;
    switch (a) {
      case 'f_target_role':
        add(t(a), { headline: at(title, tc), distance: 2, q: { company: tc, title } });
        break;
      case 'f_target_role_3rd':
        add(t(a), { headline: at(title, tc), distance: 3, q: { company: tc, title } });
        break;
      case 'f_alum_field':
        // a student with no goals has no field to be an alum in
        add(spec.goal === 'undecided' ? 'f_other' : a, { headline: at(title, nonTarget()), school: true });
        break;
      case 'f_alum_target':
        add(hasT ? a : 'f_other', {
          headline: at(
            r.chance(0.5) ? title : r.pick(['Account Executive', 'Finance Manager', 'Marketing Manager']),
            tc,
          ),
          school: true,
          q: { company: tc },
        });
        break;
      case 'f_colleague': {
        const co = friendCos.length ? r.pick(friendCos) : tc;
        add(friendCos.length ? a : t('f_target_role'), {
          headline: at(title, co),
          distance: 2,
          q: { company: co, title },
        });
        break;
      }
      case 'f_shared_org':
        if (!spec.resume) add('f_weak_fit', { headline: at('Robotics Engineer', sharedOrg) });
        else if (r.chance(0.5)) add(a, { headline: at(title, sharedOrg) });
        // a shared employer in an unrelated role: a tie, but not to the student's goals
        else add('f_other', { headline: at('Robotics Engineer', sharedOrg) });
        break;
      case 'f_caps_name': {
        const [f, l] = freshName();
        add(t(a), {
          name: `${f} ${l}`.toUpperCase(),
          headline: at(title, tc),
          distance: 2,
          q: { company: tc, title },
        });
        break;
      }
      case 'f_initial_last': {
        const [f, l] = freshName();
        add(t(a), {
          name: `${f.toUpperCase()} ${l[0]}.`,
          headline: at(title, tc),
          q: { company: tc, title },
        });
        break;
      }
      case 'f_intern_target':
        add(t(a), { headline: at(g.intern, tc), q: { company: tc } });
        break;
      case 'f_recruiter_target':
        add(hasT ? a : 'f_weak_fit', { headline: at(r.pick(RECRUITERS), tc), q: { company: tc } });
        break;
      case 'f_vp_target':
        add(t(a), { headline: at(g.vp, tc), q: { company: tc } });
        break;
      case 'f_weak_fit':
        add(a, { headline: at(r.pick(UNRELATED_TITLES), r.pick(UNRELATED_COS)) });
        break;
      case 'f_mutuals_only':
        add(a, {
          headline: at(r.pick(UNRELATED_TITLES), r.pick(UNRELATED_COS)),
          distance: 2,
          mutuals: r.int(25, 60),
        });
        break;
      case 'f_role_only':
        add(a, { headline: at(title, nonTarget()), distance: 2, mutuals: r.int(1, 8), q: { title } });
        break;
      case 'f_headline_only':
        add(a, { headline: r.pick(HEADLINE_ONLY), distance: 2, mutuals: r.int(1, 50), q: { title } });
        break;
      case 'f_no_title':
        add(a, { headline: undefined });
        break;
      case 'f_initials_only':
        add(a, {
          name: r.pick(['J. S.', 'A B', 'K.L.']),
          headline: at(title, tc),
          q: { company: tc, title },
        });
        break;
      case 'f_no_name':
        add(a, {
          name: r.pick(['LinkedIn Member', 'jdoe_1987', '.']),
          headline: at(title, tc),
          q: { company: tc },
        });
        break;
      case 'f_spam':
        add(a, {
          name: r.pick(['WEALTH COACH', 'Crypto King']),
          headline: r.pick(SPAM),
          distance: 2,
          mutuals: 40,
        });
        break;
      case 'f_student':
        add(a, { headline: r.pick(STUDENTS).replace('{school}', spec.school), school: r.chance(0.5) });
        break;
      case 'f_known': {
        const known = people.find((p) => p.currentOrganizationRaw && p.currentTitle && !p.hiddenAt);
        if (known)
          add(a, {
            name: known.displayName,
            headline: at(known.currentTitle!, known.currentOrganizationRaw!),
            q: { company: known.currentOrganizationRaw },
          });
        break;
      }
      case 'f_dismissed': {
        const e = add(a, { headline: at(title, tc), distance: 2, q: { company: tc, title } });
        feed.dismissed.push({
          memberId: e.memberId,
          reason: 'not_now',
          title: e.title,
          company: e.company,
          at: iso(now),
        });
        break;
      }
      case 'f_acted': {
        const e = add(a, { headline: at(title, tc), distance: 2, q: { company: tc, title } });
        feed.acted.push({ memberId: e.memberId, personId: 'gone', action: 'save', at: iso(now) });
        break;
      }
      case 'f_dup': {
        const e = add(t('f_target_role'), {
          headline: at(title, tc),
          distance: 2,
          q: { company: tc, title },
        });
        const d = add('f_dup', {
          name: e.name,
          headline: e.headline,
          distance: 2,
          q: { company: tc, title },
        });
        dupOf.set(d.memberId, e.memberId);
        break;
      }
    }
  }
  if (spec.found) await db.kv.put({ key: `discoverFeed:${userId}`, value: feed });

  // what a label means depends on the student: a friend at the company is a way in; a student with no goals has no
  // field and no target list, so nobody is a must, and a "target" company is just a company
  for (const e of found) {
    const a = archetype.get(e.memberId)!;
    if (a === 'f_role_only' && friendAt.has(e.company ?? '')) archetype.set(e.memberId, 'f_other');
    if (spec.goal === 'undecided' && (GOOD_FOUND.has(a) || a === 'f_colleague'))
      archetype.set(e.memberId, 'f_other');
  }
  for (const p of people) {
    const a = archetype.get(p.id)!;
    if (!hasT && (a === 'n_target_role' || a === 'n_caps_name' || a === 'n_dup'))
      archetype.set(p.id, 'n_connected_only');
    if (
      spec.goal === 'undecided' &&
      ['n_alum_field', 'n_friend_field', 'n_replied_field', 'n_intro_target'].includes(a)
    )
      archetype.set(p.id, 'n_other');
    if (!hasT && a === 'n_intro_target') archetype.set(p.id, 'n_other');
  }

  if (people.length) await db.people.bulkPut(people);
  if (chats.length) await db.chats.bulkPut(chats);
  if (edges.length) await db.edges.bulkPut(edges);
  if (touches.length) await db.touchpoints.bulkPut(touches);
  if (affiliations.length) await db.affiliations.bulkPut(affiliations);
  if (recs.length) await db.recommendations.bulkPut(recs);
  return { spec, user, now, goal: g, targets, archetype, dupOf, people, chats, found, friendAt };
}
