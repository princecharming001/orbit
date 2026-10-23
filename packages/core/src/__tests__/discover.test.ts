import { describe, expect, it } from 'vitest';
import {
  buildDiscoverProfile,
  cardReason,
  type DiscoverCandidate,
  type DiscoverProfile,
  discoverQueries,
  dismissPenalty,
  nextDiscoverQuery,
  scoreDiscoverCandidate,
} from '../recommend/discover';
import { recommendPeople } from '../recommend/score';
import {
  searchTitleFor,
  titleChangedMeaningfully,
  titleLevel,
  titleSimilarity,
  titleStatus,
} from '../recommend/title';
import type { Person, RecruitingGoals, ResumeFacet, TargetCompany } from '../types';

const goals: RecruitingGoals = {
  userId: 'u',
  cycleLabel: 'Summer 2027',
  targetRoles: ['Software Engineering Intern', 'Product Management Intern'],
  targetFunctions: ['swe', 'pm'],
  targetIndustries: ['Fintech'],
  targetLocations: ['New York', 'San Francisco', 'Remote'],
  ambition: 2,
};
const tc = (nameRaw: string, priority: 1 | 2 | 3): TargetCompany => ({
  id: nameRaw,
  userId: 'u',
  nameRaw,
  priority,
  status: 'researching',
});
const targets = [tc('Stripe', 1), tc('Figma', 1), tc('Ramp', 2), tc('Linear', 3)];

const profile = (extra: Partial<Parameters<typeof buildDiscoverProfile>[0]> = {}): DiscoverProfile =>
  buildDiscoverProfile({
    user: { school: 'Cornell University', currentCity: 'Ithaca, NY' },
    goals,
    targetCompanies: targets,
    resumeFacets: [],
    ...extra,
  });

describe('job titles', () => {
  it('reads the same role written many ways as one, and different roles apart', () => {
    expect(titleSimilarity('IB Analyst', 'Analyst, Investment Banking')).toBe(1);
    expect(titleSimilarity('Sr. SWE', 'Senior Software Engineer')).toBe(1);
    expect(titleSimilarity('Software Engineer', 'Software Engineering Intern')).toBe(1);
    expect(titleSimilarity('Associate Product Manager', 'Product Manager')).toBeGreaterThan(0.85);
    expect(titleSimilarity('Product Manager', 'Product Designer')).toBeLessThan(0.5);
    expect(titleSimilarity('Product Manager', 'Software Engineer')).toBe(0);
    expect(titleSimilarity('Associate Consultant', 'Investment Banking Analyst')).toBe(0);
  });

  it('places a title on the ladder, with one to five years out the best for a coffee chat', () => {
    expect(titleLevel('Associate Product Manager')).toBe('entry');
    expect(titleLevel('Product Manager')).toBe('mid');
    expect(titleLevel('Senior Product Manager')).toBe('senior');
    expect(titleLevel('Engineering Manager')).toBe('lead');
    expect(titleLevel('Vice President, M&A')).toBe('vp');
    expect(titleLevel('Managing Director')).toBe('exec');
    expect(titleLevel('Summer Analyst')).toBe('student');
  });

  it('knows a headline that only hopes for a role from one that holds it', () => {
    expect(titleStatus('Aspiring Investment Banker')).toBe('aspiring');
    expect(titleStatus('Incoming Analyst at Evercore')).toBe('incoming');
    expect(titleStatus("Cornell '27")).toBe('student');
    expect(titleStatus('Analyst at Goldman Sachs')).toBe('working');
  });

  it('calls a title change news only when it is one', () => {
    // not news: a ladder step, an abbreviation, a team added, the same role reworded
    expect(titleChangedMeaningfully('software engineer', 'Software Engineer II')).toBe(false);
    expect(titleChangedMeaningfully('Sr. Analytics Engineer II', 'senior analytics engineer')).toBe(false);
    expect(titleChangedMeaningfully('Software Engineer', 'Software Engineer, Payments')).toBe(false);
    expect(titleChangedMeaningfully('Associate', 'Associate, Investment Banking')).toBe(false);
    expect(titleChangedMeaningfully('Software Engineer', 'Software Developer')).toBe(false);
    // news: a new level, a new function, another role
    expect(titleChangedMeaningfully('Software Engineer', 'Senior Software Engineer')).toBe(true);
    expect(titleChangedMeaningfully('Design Lead', 'Staff Design Lead')).toBe(true);
    expect(titleChangedMeaningfully('Analyst', 'Associate')).toBe(true);
    expect(titleChangedMeaningfully('Business Analyst', 'Product Manager')).toBe(true);
    expect(titleChangedMeaningfully('Software Engineer Intern', 'Software Engineer')).toBe(true);
  });

  it('turns a target role into the title of the people in it', () => {
    expect(searchTitleFor('Software Engineering Intern')).toBe('Software Engineer');
    expect(searchTitleFor('Product Management Intern')).toBe('Product Manager');
  });
});

describe('Discover searches', () => {
  it('are built from goals, target companies by priority, the school, the resume and who the student wrote to', () => {
    const qs = discoverQueries(
      profile({
        resumeFacets: [
          {
            kind: 'experience',
            organizationName: 'Cornell Fintech Club',
            title: 'VP Engineering',
          } as ResumeFacet,
        ],
        outreach: [
          { name: 'Maya', title: 'Software Engineer', company: 'Plaid', replied: true },
          { name: 'Sam', title: 'Product Manager', company: 'Notion', replied: false },
        ],
      }),
    );
    expect(qs[0]).toMatchObject({
      kind: 'alumni_at_target',
      company: 'Stripe',
      school: 'Cornell University',
    });
    expect(
      qs.some((q) => q.kind === 'role_at_target' && q.company === 'Figma' && q.title === 'Software Engineer'),
    ).toBe(true);
    expect(qs.some((q) => q.kind === 'like_replied' && q.title === 'Software Engineer')).toBe(true);
    expect(qs.some((q) => q.kind === 'replied_company' && q.company === 'Plaid')).toBe(true);
    expect(qs.some((q) => q.kind === 'past_org' && q.company === 'Cornell Fintech Club')).toBe(true);
    // Remote is not a place to search
    expect(qs.some((q) => /remote/i.test(q.location ?? ''))).toBe(false);
    // a priority 1 company's searches come before a priority 3 company's
    const stripe = qs.findIndex((q) => q.company === 'Stripe');
    const linear = qs.findIndex((q) => q.company === 'Linear');
    expect(stripe).toBeLessThan(linear);
    expect(new Set(qs.map((q) => q.key)).size).toBe(qs.length);
  });

  it('leave out a company turned down and stop a role turned down twice', () => {
    const once = discoverQueries(
      profile({
        dismissed: [
          { reason: 'wrong_company', company: 'Stripe, Inc.' },
          { reason: 'wrong_role', title: 'Product Manager' },
        ],
      }),
    );
    expect(once.some((q) => q.company === 'Stripe')).toBe(false);
    const pmOnce = once.find((q) => q.kind === 'role_at_target' && q.title === 'Product Manager');
    const base = discoverQueries(profile()).find((q) => q.key === pmOnce?.key);
    expect(pmOnce!.weight).toBeCloseTo(base!.weight / 2);
    const twice = discoverQueries(
      profile({
        dismissed: [
          { reason: 'wrong_role', title: 'Product Manager' },
          { reason: 'wrong_role', title: 'Senior Product Manager' },
        ],
      }),
    );
    expect(twice.some((q) => q.title === 'Product Manager')).toBe(false);
  });

  it('take turns: the first pages of several searches before the third page of one', () => {
    const qs = discoverQueries(profile());
    const progress: Record<string, { pages: number; done?: boolean }> = {};
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      const q = nextDiscoverQuery(qs, progress)!;
      order.push(q.key);
      progress[q.key] = { pages: (progress[q.key]?.pages ?? 0) + 1 };
    }
    expect(new Set(order).size).toBeGreaterThan(4);
    for (const q of qs) progress[q.key] = { pages: 1, done: true };
    expect(nextDiscoverQuery(qs, progress)).toBeUndefined();
  });
});

describe('Discover scores', () => {
  const pool: DiscoverCandidate[] = [
    {
      name: 'A',
      title: 'Software Engineer',
      company: 'Stripe',
      distance: 2,
      mutualCount: 12,
      schoolEvidence: true,
      location: 'New York, NY',
    },
    {
      name: 'B',
      title: 'Senior Software Engineer',
      company: 'Figma',
      distance: 2,
      mutualCount: 3,
      location: 'San Francisco Bay Area',
    },
    { name: 'C', title: 'Product Manager', company: 'Ramp', distance: 3, schoolEvidence: true },
    { name: 'D', title: 'Associate Product Manager', company: 'Notion', distance: 2 },
    { name: 'E', title: 'Engineering Manager', company: 'Datadog', distance: 2, mutualCount: 1 },
    { name: 'F', title: 'Director of Engineering', company: 'Stripe', distance: 3 },
    { name: 'G', title: 'Data Scientist', company: 'Airbnb', distance: 3, location: 'Seattle' },
    { name: 'H', title: 'Product Designer', company: 'Linear', distance: 2, mutualCount: 25 },
    { name: 'I', title: 'Machine Learning Engineer', company: 'Anthropic', distance: 2, mutualCount: 6 },
    { name: 'J', title: 'Founder', company: 'Ledgerly', distance: 3 },
    {
      name: 'K',
      title: 'Staff Engineer',
      company: 'Plaid',
      distance: 2,
      mutualCount: 8,
      location: 'New York',
    },
    { name: 'L', title: 'Software Engineer Intern', company: 'Brex', distance: 3 },
    { name: 'M', title: 'Investment Banking Analyst', company: 'Goldman Sachs', distance: 2, mutualCount: 2 },
    { name: 'N', title: 'Strategy and Operations Associate', company: 'Ramp', distance: 2, mutualCount: 4 },
    {
      name: 'O',
      title: 'Product Manager',
      company: 'Google',
      distance: 2,
      mutualCount: 19,
      location: 'New York',
    },
  ];

  it('spread out: cards rarely share a Match or a Reach', () => {
    const p = profile();
    const scored = pool.map((c) => scoreDiscoverCandidate(c, p));
    const fits = scored.map((s) => Math.round(s.fit * 100));
    const reaches = scored.map((s) => Math.round(s.reach * 100));
    const most = (xs: number[]) => Math.max(...[...new Set(xs)].map((v) => xs.filter((x) => x === v).length));
    expect(most(fits)).toBeLessThanOrEqual(2);
    expect(most(reaches)).toBeLessThanOrEqual(3);
    expect(new Set(fits).size).toBeGreaterThanOrEqual(12);
    expect(Math.max(...fits) - Math.min(...fits)).toBeGreaterThan(35);
  });

  it('rank an alum in a target role at a target company with mutuals above a founder far out', () => {
    const p = profile();
    const by = (n: string) => scoreDiscoverCandidate(pool.find((c) => c.name === n)!, p);
    expect(by('A').score).toBeGreaterThan(by('B').score);
    expect(by('B').score).toBeGreaterThan(by('J').score);
    expect(by('D').fit).toBeGreaterThan(by('F').fit); // an APM beats a director for a student's coffee chat
    expect(by('A').reasons[0]!.code).toBe('alumni_target');
    expect(by('B').reasons[0]!.text).toBe('3 mutual connections on LinkedIn');
  });

  it('reach: mutual connections above a shared school above third degree', () => {
    const p = profile();
    const reach = (c: Partial<DiscoverCandidate>) =>
      scoreDiscoverCandidate({ name: 'x', title: 'Software Engineer', company: 'Acme', ...c }, p).reach;
    const second = reach({ distance: 2, mutualCount: 3 });
    const alumThird = reach({ distance: 3, schoolEvidence: true });
    const third = reach({ distance: 3 });
    expect(second).toBeGreaterThan(alumThird);
    expect(alumThird).toBeGreaterThan(third);
    expect(reach({ distance: 2, mutualCount: 20 })).toBeGreaterThan(second);
  });

  it('learn from what the student turned down', () => {
    const before = profile();
    const after = profile({
      dismissed: [
        { reason: 'wrong_company', company: 'Stripe' },
        { reason: 'wrong_role', title: 'Engineering Manager' },
      ],
    });
    const a = pool.find((c) => c.name === 'A')!;
    const e = pool.find((c) => c.name === 'E')!;
    expect(scoreDiscoverCandidate(a, after).fit).toBeLessThan(scoreDiscoverCandidate(a, before).fit * 0.5);
    expect(scoreDiscoverCandidate(e, after).fit).toBeLessThan(scoreDiscoverCandidate(e, before).fit);
    expect(dismissPenalty({ title: 'Software Engineer', company: 'Figma' }, after.dismissed)).toBe(1);
  });

  it('rank people like the ones who replied higher, and say so', () => {
    const p = profile({
      outreach: [
        { name: 'Maya', title: 'Strategy and Operations Associate', company: 'Plaid', replied: true },
      ],
    });
    const n = pool.find((c) => c.name === 'N')!;
    const withHistory = scoreDiscoverCandidate(n, p);
    expect(withHistory.fit).toBeGreaterThan(scoreDiscoverCandidate(n, profile()).fit);
    expect(withHistory.reasons.map((r) => r.text)).toContain('Same kind of role as Maya, who replied to you');
  });

  it('never says someone works in a role their headline only hopes for, and names a school only with evidence', () => {
    const p = profile();
    const hopeful = scoreDiscoverCandidate(
      {
        name: 'Z',
        title: 'Aspiring Software Engineer',
        headline: "Aspiring Software Engineer | Cornell '27",
        distance: 2,
      },
      p,
    );
    expect(hopeful.reasons.some((r) => r.code === 'function_match')).toBe(false);
    expect(hopeful.parts.role).toBeLessThan(0.35);
    const noEvidence = scoreDiscoverCandidate(
      { name: 'Y', title: 'Software Engineer', company: 'Acme', distance: 3 },
      p,
    );
    expect(noEvidence.reasons.some((r) => /Cornell/.test(r.text))).toBe(false);
    const working = scoreDiscoverCandidate(
      { name: 'X', title: 'Software Engineer', company: 'Acme', distance: 3 },
      p,
    );
    expect(working.reasons.map((r) => r.text)).toContain('Works in software engineering (Software Engineer)');
  });

  it('a card leads with its strongest reason', () => {
    expect(
      cardReason([
        { code: 'function_match', text: 'Works in x' },
        { code: 'path', text: 'Lena knows them and could introduce you' },
        { code: 'alumni', text: 'Cornell alum' },
      ])!.code,
    ).toBe('path');
  });
});

const person = (id: string, extra: Partial<Person>): Person => ({
  id,
  userId: 'u',
  displayName: id,
  firstName: id,
  lastName: '',
  nameNormalized: id,
  emails: [],
  relationshipType: 'unknown' as Person['relationshipType'],
  strength: 0.05,
  interactionCount: 0,
  sources: [],
  isHuman: true,
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('network recommendations (recommendPeople)', () => {
  const base = {
    userId: 'u',
    user: { school: 'Cornell University', majors: ['Computer Science'] },
    chats: [],
    pathStrength: () => 0,
    recentlyRecommended: new Set<string>(),
    now: new Date('2026-10-06T13:00:00Z'),
  };

  it('reads the function from the title held, never from a hopeful headline', () => {
    const recs = recommendPeople({
      ...base,
      goals: { ...goals, targetFunctions: ['ib'], targetRoles: [], targetIndustries: [] },
      targetCompanies: [],
      resumeFacets: [],
      people: [
        person('hopeful', { headline: 'Aspiring Investment Banker | Finance at Michigan', isAlumni: true }),
        person('banker', { currentTitle: 'Investment Banking Analyst', currentOrganizationRaw: 'Evercore' }),
      ],
    });
    const why = (id: string) => recs.find((r) => r.personId === id)?.reasons.map((x) => x.text) ?? [];
    expect(why('hopeful').join(' ')).not.toMatch(/Works in/);
    expect(why('banker')).toContain('Works in investment banking (Investment Banking Analyst)');
  });

  it('says "you are both at X" only when the resume says the student is there now', () => {
    const facet = (id: string, org: string, extra: Partial<ResumeFacet>): ResumeFacet => ({
      id,
      resumeId: 'r',
      kind: 'experience',
      title: 'Member',
      organizationName: org,
      text: 'x',
      keywords: [],
      confirmed: true,
      ...extra,
    });
    const recs = recommendPeople({
      ...base,
      goals: { ...goals, targetFunctions: ['consulting'] },
      targetCompanies: [],
      resumeFacets: [facet('f1', 'Undated Club', {}), facet('f2', 'Current Club', { startDate: '2025-09' })],
      people: [
        person('u1', { currentTitle: 'Consultant', currentOrganizationRaw: 'Undated Club' }),
        person('c1', { currentTitle: 'Consultant', currentOrganizationRaw: 'Current Club' }),
      ],
    });
    const code = (id: string) => recs.find((r) => r.personId === id)!.reasons[0]!.code;
    expect(code('u1')).toBe('shared_org');
    expect(code('c1')).toBe('shared_org_now');
  });

  it('gives continuous Match and Reach, not the same 28 and 25 on every card', () => {
    const titles = [
      'Software Engineer',
      'Senior Software Engineer',
      'Product Manager',
      'Associate Product Manager',
      'Staff Engineer',
      'Engineering Manager',
      'Product Designer',
      'Machine Learning Engineer',
      'Director of Product',
      'Software Engineer Intern',
    ];
    const people = titles.map((t, i) =>
      person(`p${i}`, {
        currentTitle: t,
        currentOrganizationRaw: ['Stripe', 'Figma', 'Ramp', 'Acme', 'Linear'][i % 5],
        strength: 0.02 + i * 0.037,
        linkedinConnectedOn: i % 2 ? '2025-01-01' : undefined,
      }),
    );
    const recs = recommendPeople({
      ...base,
      goals,
      targetCompanies: targets,
      resumeFacets: [],
      people,
      pathStrength: (id) => (id === 'p3' ? 0.4 : 0),
    });
    expect(recs.length).toBeGreaterThanOrEqual(8);
    const fits = recs.map((r) => Math.round(r.fitScore * 100));
    const reaches = recs.map((r) => Math.round(r.reachScore * 100));
    expect(new Set(fits).size).toBeGreaterThanOrEqual(recs.length - 2);
    expect(new Set(reaches).size).toBeGreaterThanOrEqual(recs.length - 2);
  });

  it('ranks a person lower after the student turned down their company', () => {
    const people = [
      person('s', { currentTitle: 'Software Engineer', currentOrganizationRaw: 'Stripe' }),
      person('f', { currentTitle: 'Software Engineer', currentOrganizationRaw: 'Figma' }),
    ];
    const run = (dismissed = [] as { reason: string; company?: string }[]) =>
      recommendPeople({ ...base, goals, targetCompanies: targets, resumeFacets: [], people, dismissed });
    expect(run()[0]!.personId).toBe('s');
    const after = run([{ reason: 'wrong_company', company: 'Stripe' }]);
    expect(after[0]!.personId).toBe('f');
  });
});
