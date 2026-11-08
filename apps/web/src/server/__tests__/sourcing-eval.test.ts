/**
 * The warmth tiers, the email finder and the fallback routing, judged case by case: each case is a person a student
 * might be shown and the answer a careful person would give. Failures here are traced back to the rule, not
 * patched per case.
 */
import { describe, expect, it } from 'vitest';
import {
  domainsOf,
  fillEmails,
  type KnownAddress,
  learnPattern,
} from '../../../../../supabase/functions/_shared/sourcing/email';
import {
  indexKnown,
  type KnownRow,
  matchKnown,
} from '../../../../../supabase/functions/_shared/sourcing/known';
import type { Candidate } from '../../../../../supabase/functions/_shared/sourcing/search';
import {
  type StudentContext,
  siteDomain,
  type WarmContact,
  type WarmthTier,
  warmthOf,
} from '../../../../../supabase/functions/_shared/sourcing/warmth';
import { selectPages, webAsk, webQueries } from '../../../../../supabase/functions/_shared/sourcing/web';
import { routeNetwork } from '../../chat/agent/routerNetwork';

const cand = (c: Partial<Candidate>): Candidate => ({
  key: `${c.name ?? 'Maya Chen'}-${c.org ?? ''}-${c.headline ?? ''}`,
  entity: 'person',
  name: 'Maya Chen',
  sources: ['web'],
  externalIds: {},
  ...c,
});

const student: StudentContext = {
  school: 'University of California, Berkeley',
  orgs: [
    'Palo',
    'Prosimo',
    'Lemonhat Inc.',
    'Sonatus',
    'Blackskies Investments',
    'University of California, Berkeley',
  ],
  homeCity: 'San Jose, CA',
  interests: ['product management', 'program management', 'sql', 'python', 'operations'],
  gradYear: 2028,
};

const sam: WarmContact = {
  personId: 'sam',
  name: 'Sam Lee',
  score: 72,
  org: 'Stripe',
  email: 'sam@stripe.com',
};
const ana: WarmContact = { personId: 'ana', name: 'Ana Ruiz', score: 48, email: 'ana.ruiz@acme.ai' };
const goo: WarmContact = { personId: 'goo', name: 'Priya Rao', score: 61, org: 'Google' };
const meh: WarmContact = { personId: 'meh', name: 'Tom Ng', score: 30, org: 'Figma' };
const ta: WarmContact = { personId: 'ta', name: 'Lena Fox', score: 66, org: 'UC Berkeley' };
const gm: WarmContact = { personId: 'gm', name: 'Raj Patel', score: 80, email: 'raj.patel@gmail.com' };
const app: WarmContact = { personId: 'app', name: 'Ben Ito', score: 55, org: 'Apple' };

interface TierCase {
  id: string;
  c: Partial<Candidate>;
  known?: { personId: string; score?: number } | null;
  warm?: WarmContact[];
  domains?: string[];
  tier: WarmthTier;
  why?: RegExp;
  noWhy?: boolean;
}

const TIERS: TierCase[] = [
  // 1. in your world
  {
    id: 'T01 talked with, warm',
    c: {},
    known: { personId: 'p', score: 55 },
    tier: 1,
    why: /talked with Maya/,
  },
  { id: 'T02 talked with, at the line', c: {}, known: { personId: 'p', score: 20 }, tier: 1 },
  { id: 'T03 seen, barely', c: { headline: 'Geologist' }, known: { personId: 'p', score: 19 }, tier: 5 },
  { id: 'T04 saved, never talked', c: { headline: 'Geologist' }, known: { personId: 'p' }, tier: 5 },
  {
    id: 'T05 known beats a bridge',
    c: { org: 'Stripe' },
    known: { personId: 'p', score: 30 },
    warm: [sam],
    tier: 1,
  },
  {
    id: 'T06 title not first name',
    c: { name: 'Dr. Maya Chen' },
    known: { personId: 'p', score: 40 },
    tier: 1,
    why: /talked with Maya before/,
  },
  // 2. one hop
  { id: 'T07 bridge same org', c: { org: 'Stripe' }, warm: [sam], tier: 2, why: /Sam .*Stripe.*intro/ },
  { id: 'T08 bridge org suffix', c: { org: 'Stripe, Inc.' }, warm: [sam], tier: 2 },
  {
    id: 'T09 bridge by work domain',
    c: { org: 'Acme Robotics' },
    domains: ['acme.ai'],
    warm: [ana],
    tier: 2,
    why: /Ana/,
  },
  { id: 'T10 bridge parent with qualifier', c: { org: 'Google Cloud' }, warm: [goo], tier: 2 },
  {
    id: 'T11 look-alike name',
    c: { org: 'Metabase', headline: 'Geologist' },
    warm: [{ ...goo, org: 'Meta' }],
    tier: 5,
  },
  {
    id: 'T12 different company sharing a word',
    c: { org: 'Apple Hospitality REIT', headline: 'Accountant' },
    warm: [app],
    tier: 5,
  },
  { id: 'T13 contact not warm enough', c: { org: 'Figma', headline: 'Designer' }, warm: [meh], tier: 5 },
  {
    id: 'T14 public mailbox is no bridge',
    c: { org: 'Somewhere', headline: 'Designer' },
    domains: ['gmail.com'],
    warm: [gm],
    tier: 5,
  },
  {
    id: 'T15 university is too big to bridge',
    c: { org: 'University of California, Berkeley', title: 'Professor of Bioengineering' },
    warm: [ta],
    tier: 3,
    why: /Berkeley/,
  },
  {
    id: 'T16 best bridge named',
    c: { org: 'Stripe' },
    warm: [{ ...sam, score: 41, name: 'Kim Wu', personId: 'kim' }, sam],
    tier: 2,
    why: /Sam/,
  },
  {
    id: 'T17 bridge beats shared school',
    c: { org: 'Stripe', headline: 'UC Berkeley alum' },
    warm: [sam],
    tier: 2,
  },
  {
    id: 'T18 short org never bridges by accident',
    c: { org: 'X', headline: 'Engineer' },
    warm: [{ ...sam, org: 'X Corp' }],
    tier: 5,
  },
  // 3. shared background
  { id: 'T19 alum in headline', c: { headline: 'PM at Figma · UC Berkeley alum' }, tier: 3, why: /Berkeley/ },
  { id: 'T20 Haas MBA', c: { headline: 'Berkeley Haas MBA, now at Bain' }, tier: 3 },
  {
    id: 'T21 lives in Berkeley, not an alum',
    c: { headline: 'Engineer at Lyft', location: 'Berkeley, CA' },
    tier: 5,
  },
  {
    id: 'T22 company named Berkeley',
    c: { org: 'Berkeley Lights', headline: 'Scientist at Berkeley Lights' },
    tier: 5,
  },
  { id: 'T23 Cal class year', c: { headline: "Cal '19, product at Notion" }, tier: 3 },
  {
    id: 'T24 same past company',
    c: { org: 'Prosimo', title: 'Director of Product' },
    tier: 3,
    why: /Also worked at Prosimo/,
  },
  {
    id: 'T25 ex-company in headline',
    c: { headline: 'Founder. Previously ex-Prosimo, ex-Cisco' },
    tier: 3,
    why: /Prosimo/,
  },
  {
    id: 'T26 Palo is not Palo Alto Networks',
    c: { org: 'Palo Alto Networks', headline: 'Security engineer' },
    tier: 5,
  },
  { id: 'T27 Palo Alto the city', c: { headline: 'Investor based in Palo Alto' }, tier: 5 },
  { id: 'T28 same company exact', c: { org: 'Sonatus', title: 'Engineer' }, tier: 3 },
  {
    id: 'T29 hometown',
    c: { location: 'San Jose, California', headline: 'Engineer' },
    tier: 3,
    why: /San Jose/,
  },
  {
    id: 'T30 hometown in a different country',
    c: { location: 'San Jose, Costa Rica', headline: 'Engineer' },
    tier: 3,
  },
  {
    id: 'T31 student at the same school',
    c: { headline: 'PhD student, UC Berkeley EECS' },
    tier: 3,
    why: /Also at/,
  },
  // 4. open door
  {
    id: 'T32 says email me',
    c: { evidence: ['Undergraduates interested in the lab: email me with your CV.'] },
    tier: 4,
    why: /invites students/,
  },
  { id: 'T33 office hours', c: { evidence: ['Holds weekly office hours for founders'] }, tier: 4 },
  { id: 'T34 happy to chat', c: { headline: 'VC · always happy to chat with students' }, tier: 4 },
  { id: 'T35 not accepting', c: { evidence: ['I am not accepting new students this year.'] }, tier: 5 },
  { id: 'T36 no longer taking', c: { evidence: ['No longer looking for research assistants.'] }, tier: 5 },
  {
    id: 'T37 recent grad',
    c: { headline: 'Analyst at Goldman, class of 2025' },
    tier: 4,
    why: /Graduated recently/,
  },
  { id: 'T38 old grad', c: { headline: 'Analyst, BS 2015' }, tier: 5 },
  { id: 'T39 mentoring', c: { headline: 'Mentor at Techstars, angel investor' }, tier: 4 },
  { id: 'T40 a year in a number', c: { headline: 'Raised $25M series A' }, tier: 5, noWhy: true },
  // 5. cold, with or without a hook
  {
    id: 'T41 résumé hook',
    c: { headline: 'Leads product management for payments' },
    tier: 5,
    why: /product management/,
  },
  { id: 'T42 no hook', c: { headline: 'Geologist' }, tier: 5, noWhy: true },
  {
    id: 'T43 one-word interest needs a real word',
    c: { headline: 'Data engineer, SQL and Python' },
    tier: 5,
    why: /(sql|python)/,
  },
  {
    id: 'T44 interest words in another order is no hook',
    c: { headline: 'Management of product recalls' },
    tier: 5,
    noWhy: true,
  },
];

describe('warmth tiers: 44 cases', () => {
  for (const t of TIERS)
    it(t.id, () => {
      const w = warmthOf(cand(t.c), {
        student,
        known: t.known ?? null,
        warm: t.warm ?? [],
        domains: t.domains,
        year: 2026,
      });
      expect({ id: t.id, tier: w.tier }).toEqual({ id: t.id, tier: t.tier });
      if (t.why) expect(w.why ?? '').toMatch(t.why);
      if (t.noWhy) expect(w.why).toBeUndefined();
    });
});

const known: KnownAddress[] = [
  { name: 'Sam Lee', email: 'slee@acme.com' },
  { name: 'Ana Ruiz', email: 'aruiz@acme.com' },
  { name: 'Bo Diaz', email: 'bo.diaz@other.com' },
  { name: 'Cy Ono', email: 'cy.ono@other.com' },
  { name: 'Di Tran', email: 'di@other.com' },
  { name: 'Ed Moss', email: 'ed@tiny.io' },
  { name: 'Fay Hu', email: 'fay.hu@tie.com' },
  { name: 'Gus Ray', email: 'gus@tie.com' },
  { name: 'Hal Bo', email: 'hbo@berkeley.edu' },
  { name: 'Ida Ma', email: 'ida@duo.io' },
  { name: 'Jon Lu', email: 'jon@duo.io' },
  { name: 'Role Founders', email: 'founders@role.io' },
  { name: 'Kai Ro', email: 'kro@district.net' },
  { name: 'Lee Su', email: 'lsu@district.net' },
  { name: 'Mo Ty', email: 'mty@district.net' },
  { name: 'Ned Ox', email: 'nedox123@district.net' },
  { name: 'Oli Pe', email: 'olipe456@district.net' },
];

interface EmailCase {
  id: string;
  c: Partial<Candidate>;
  orgDomains?: [string, string][];
  mxOk?: string[];
  email?: string;
  confidence?: 'page' | 'pattern' | 'guess';
}

const EMAILS: EmailCase[] = [
  {
    id: 'E01 page email kept',
    c: { name: 'Page Person', email: 'pp@x.com' },
    email: 'pp@x.com',
    confidence: 'page',
  },
  {
    id: 'E02 flast learned',
    c: { name: 'Maya Chen', org: 'Acme' },
    orgDomains: [['acme', 'acme.com']],
    email: 'mchen@acme.com',
    confidence: 'pattern',
  },
  {
    id: 'E03 majority pattern',
    c: { name: 'Maya Chen', org: 'Other' },
    orgDomains: [['other', 'other.com']],
    email: 'maya.chen@other.com',
    confidence: 'pattern',
  },
  {
    id: 'E04 one example is used, as a guess',
    c: { name: 'Maya Chen', org: 'Tiny' },
    orgDomains: [['tiny', 'tiny.io']],
    email: 'maya@tiny.io',
    confidence: 'guess',
  },
  {
    id: 'E04b first-name pattern, two agree',
    c: { name: 'Maya Chen', org: 'Duo' },
    orgDomains: [['duo', 'duo.io']],
    email: 'maya@duo.io',
    confidence: 'pattern',
  },
  {
    id: 'E04c a shared inbox teaches nothing',
    c: { name: 'Maya Chen', org: 'Role' },
    orgDomains: [['role', 'role.io']],
  },
  {
    id: 'E04d a domain with ID addresses is mixed',
    c: { name: 'Maya Chen', org: 'District' },
    orgDomains: [['district', 'district.net']],
  },
  {
    id: 'E05 a tie is no pattern, guess when mail works',
    c: { name: 'Maya Chen', org: 'Tie' },
    orgDomains: [['tie', 'tie.com']],
    mxOk: ['tie.com'],
    email: 'maya.chen@tie.com',
    confidence: 'guess',
  },
  {
    id: 'E06 accents dropped',
    c: { name: 'José Núñez', org: 'Acme' },
    orgDomains: [['acme', 'acme.com']],
    email: 'jnunez@acme.com',
    confidence: 'pattern',
  },
  {
    id: 'E07 hyphenated last name',
    c: { name: 'Ana Ruiz-Lopez', org: 'Other' },
    orgDomains: [['other', 'other.com']],
    email: 'ana.ruizlopez@other.com',
    confidence: 'pattern',
  },
  {
    id: 'E08 titles and middle names',
    c: { name: 'Dr. Maya J. Chen, PhD', org: 'Acme' },
    orgDomains: [['acme', 'acme.com']],
    email: 'mchen@acme.com',
    confidence: 'pattern',
  },
  {
    id: 'E09 hidden last name',
    c: { name: 'Maya C.', lastNameObfuscated: true, org: 'Acme' },
    orgDomains: [['acme', 'acme.com']],
  },
  { id: 'E10 one name only', c: { name: 'Cher', org: 'Acme' }, orgDomains: [['acme', 'acme.com']] },
  { id: 'E11 no mail server, no guess', c: { name: 'Al Kim', url: 'https://nomail.io/about' } },
  {
    id: 'E12 guess from the company site',
    c: { name: 'Jo Park', url: 'https://beta.io/team' },
    mxOk: ['beta.io'],
    email: 'jo.park@beta.io',
    confidence: 'guess',
  },
  {
    id: 'E13 subdomain site',
    c: { name: 'Jo Park', url: 'https://team.beta.io/jo' },
    mxOk: ['beta.io'],
    email: 'jo.park@beta.io',
    confidence: 'guess',
  },
  {
    id: 'E14 university gets no guess',
    c: { name: 'Lu Wang', url: 'https://eecs.berkeley.edu/faculty/lu' },
    mxOk: ['berkeley.edu'],
  },
  {
    id: 'E15 one university example is not a pattern',
    c: { name: 'Lu Wang', url: 'https://bioeng.berkeley.edu/lu' },
    mxOk: ['berkeley.edu'],
  },
  {
    id: 'E16 LinkedIn is not a company site',
    c: { name: 'Jo Park', url: 'https://www.linkedin.com/in/jopark' },
    mxOk: ['linkedin.com'],
  },
  {
    id: 'E17 a blog is not a company site',
    c: { name: 'Jo Park', url: 'https://jopark.substack.com/p/x' },
    mxOk: ['substack.com', 'jopark.substack.com'],
  },
  {
    id: 'E18 a company is never emailed',
    c: { name: 'Acme Corp', entity: 'organization', url: 'https://acme.com' },
    mxOk: ['acme.com'],
  },
  {
    id: 'E19 UK company domain',
    c: { name: 'Jo Park', url: 'https://www.beta.co.uk/team' },
    mxOk: ['beta.co.uk'],
    email: 'jo.park@beta.co.uk',
    confidence: 'guess',
  },
  {
    id: 'E20 page gmail stays as written',
    c: { name: 'Jo Park', email: 'jo.park.1@gmail.com' },
    email: 'jo.park.1@gmail.com',
    confidence: 'page',
  },
];

describe('finding emails: 20 cases', () => {
  for (const e of EMAILS)
    it(e.id, async () => {
      const c = cand(e.c);
      await fillEmails([c], {
        known,
        orgDomains: new Map(e.orgDomains ?? []),
        mx: async (d) => (e.mxOk ?? []).includes(d),
      });
      expect({ id: e.id, email: c.email, confidence: c.email ? c.emailConfidence : undefined }).toEqual({
        id: e.id,
        email: e.email,
        confidence: e.confidence,
      });
    });

  it('E21 three agreeing university addresses are a pattern', () => {
    const uni = [
      { name: 'A One', email: 'a.one@school.edu' },
      { name: 'B Two', email: 'b.two@school.edu' },
      { name: 'C Three', email: 'c.three@school.edu' },
    ];
    expect(learnPattern(uni, 'school.edu')).toBe('first.last');
  });

  it('E22 a company site and the ask both give a domain, the ask first', () => {
    expect(
      domainsOf(cand({ org: 'Acme', url: 'https://acme-careers.com' }), new Map([['acme', 'acme.com']])),
    ).toEqual(['acme.com', 'acme-careers.com']);
  });

  it('E23 site domains', () => {
    expect(siteDomain('https://www.stripe.com/about')).toBe('stripe.com');
    expect(siteDomain('https://cs.stanford.edu/people/x')).toBe('stanford.edu');
    expect(siteDomain('https://github.com/x')).toBeUndefined();
  });
});

const helpers = {
  goals: [],
  person: () => ({ person: undefined, candidates: [] }),
  ambiguous: () => ({ kind: 'text' }),
  nobody: () => ({ kind: 'text' }),
  viaTool: (tool: string) => ({ kind: 'tool', tool }),
} as unknown as Parameters<typeof routeNetwork>[2];

const toolOf = (text: string) => {
  const r = routeNetwork(text, text.toLowerCase(), helpers) as { kind?: string; tool?: string } | undefined;
  return r?.kind === 'tool' ? r.tool : undefined;
};

const ROUTES: [string, string | undefined][] = [
  ['find people outside linkedin to email about fintech', 'find_people'],
  ['who should I cold email at Stripe', 'find_people'],
  ['people I can email for PM internships', 'find_people'],
  ['anyone I should email at Google?', 'find_people'],
  ['people to email outside of my LinkedIn', 'find_people'],
  ['find investors in climate', 'find_people'],
  ['who can I cold-email about biotech research', 'find_people'],
  ['email Sarah about the meeting', undefined],
  ['draft an email to Alex', undefined],
  ['should I email him back?', undefined],
  ['what did Jai say in his last email', undefined],
];

describe('routing to the outside-LinkedIn search: 11 cases', () => {
  for (const [text, tool] of ROUTES)
    it(text, () => {
      expect({ text, tool: toolOf(text) === 'find_people' ? 'find_people' : undefined }).toEqual({
        text,
        tool,
      });
    });
});

describe('where the web search looks: 12 cases', () => {
  const g = (x: object) => ({ id: null, kind: 'advice' as const, title: '', criteria: [], ...x });
  it('W1 a named company', () =>
    expect(webAsk(g({ orgs: ['Stripe'], roles: ['product manager'] }))?.place).toBe('Stripe'));
  it('W2 a named school', () =>
    expect(webAsk(g({ school: 'UC Berkeley', topic: 'biomedical research' }))?.place).toBe('UC Berkeley'));
  it('W3 "at" in the ask', () => expect(webAsk(g({ topic: 'designers at Figma' }))?.place).toBe('Figma'));
  it('W4 nowhere named', () => expect(webAsk(g({ topic: 'fintech founders' }))).toBeUndefined());
  it("W5 no place: the student's school stands in", () =>
    expect(webAsk(g({ topic: 'mentors in fintech' }), { fallbackPlace: 'Stanford' })).toMatchObject({
      place: 'Stanford',
      subject: 'mentors in fintech',
      assumedPlace: true,
    }));
  it('W6 a named place wins over the fallback', () =>
    expect(webAsk(g({ topic: 'designers at Figma' }), { fallbackPlace: 'Stanford' })).toMatchObject({
      place: 'Figma',
    }));
  it('W7 broad: the subject alone drives every search', () => {
    const a = webAsk(g({ topic: 'fintech founders' }), { broad: true })!;
    expect(a).toMatchObject({ place: '', subject: 'fintech', role: 'founders', broad: true });
    expect(webQueries(a).every((q) => /fintech/.test(q.query) && /founders/.test(q.query))).toBe(true);
  });
  it('W8 broad with nothing to search for', () =>
    expect(webAsk(g({ topic: '' }), { broad: true })).toBeUndefined());
  it('W9 a school asks for faculty, labs and departments', () => {
    const qs = webQueries(webAsk(g({ school: 'UC Berkeley', topic: 'biomedical research' }))!)
      .map((q) => q.query)
      .join(' | ');
    expect(qs).toMatch(/lab research group/);
    expect(qs).toMatch(/department of/);
  });
  it('W10 a company asks for team pages, not departments', () => {
    const qs = webQueries(webAsk(g({ orgs: ['Stripe'], topic: 'payments' }))!).map((q) => q.query);
    expect(qs[0]).toBe('Stripe payments team');
    expect(qs.join(' | ')).not.toMatch(/department of|lab research group/);
  });
  it("W11 the student's school is searched as a school even when its name does not say so", () => {
    const a = webAsk(g({ topic: 'mentors in fintech' }), { fallbackPlace: 'Stanford' })!;
    expect(
      webQueries(a)
        .map((q) => q.query)
        .join(' | '),
    ).toMatch(/lab research group/);
  });
  it('W12 a broad ask for founders does not favor .edu pages', () => {
    const a = webAsk(g({ topic: 'fintech founders' }), { broad: true })!;
    const picked = selectPages(
      [
        { url: 'https://cs.someu.edu/news', title: 'News', query: 'q' },
        { url: 'https://fintechlist.com/founders', title: 'Fintech founders directory', query: 'q' },
      ],
      a,
    );
    expect(picked[0]).toBe('https://fintechlist.com/founders');
  });
});

describe('is this someone the student already knows: 9 cases', () => {
  const rows: KnownRow[] = [
    {
      id: 'p1',
      display_name: 'Maya Chen',
      org_raw: 'Stripe',
      headline: 'PM at Stripe',
      primary_email: 'maya@stripe.com',
      linkedin_slug: 'maya-chen-1',
      linkedin_member_id: 'ACo1',
      emails: ['maya@stripe.com'],
      linkedin_ids: [],
    },
    {
      id: 'p2',
      display_name: 'Maya Chen',
      org_raw: 'UC Berkeley',
      headline: 'Student',
      primary_email: null,
      linkedin_slug: null,
      linkedin_member_id: null,
      emails: [],
      linkedin_ids: [],
    },
    {
      id: 'p3',
      display_name: 'Leo Grant',
      org_raw: null,
      headline: 'Partner @ Greenfield Ventures',
      primary_email: null,
      linkedin_slug: null,
      linkedin_member_id: null,
      emails: ['leo@greenfield.vc'],
      linkedin_ids: ['leo-grant'],
    },
  ];
  const idx = indexKnown(rows);
  const find = (c: Partial<Candidate>, o: { slug?: string; email?: string; orgDomain?: string } = {}) =>
    matchKnown(idx, cand(c), o)?.id;
  it('K1 by LinkedIn slug', () =>
    expect(find({ linkedinUrl: 'https://www.linkedin.com/in/Maya-Chen-1' }, { slug: 'Maya-Chen-1' })).toBe(
      'p1',
    ));
  it('K2 by an identity slug, whatever the name', () =>
    expect(find({ name: 'L Grant' }, { slug: 'leo-grant' })).toBe('p3'));
  it('K3 by email', () =>
    expect(find({ name: 'M. Chen', email: 'MAYA@stripe.com' }, { email: 'maya@stripe.com' })).toBe('p1'));
  it('K4 by name and the same company, written messily', () =>
    expect(find({ org: 'Stripe | Berkeley Haas', title: 'Product Lead' })).toBe('p1'));
  it('K5 by name and the company in their headline', () =>
    expect(find({ name: 'Leo Grant', org: 'Greenfield Ventures' })).toBe('p3'));
  it('K6 by name and work email domain', () =>
    expect(find({ name: 'Leo Grant', email: 'l.grant@greenfield.vc' })).toBe('p3'));
  it('K7 a name alone is not a match', () =>
    expect(find({ name: 'Maya Chen', org: 'Figma' })).toBeUndefined());
  it('K8 a shared university is not a match', () =>
    expect(find({ name: 'Maya Chen', org: 'Bioengineering, UC Berkeley' })).toBeUndefined());
  it('K9 nobody by that name', () => expect(find({ name: 'Zed Quill', org: 'Stripe' })).toBeUndefined());
});

describe('org domains for an email: 2 cases', () => {
  const m = new Map([
    ['stripe', 'stripe.com'],
    ['berkeley haas', 'haas.berkeley.edu'],
  ]);
  it('D1 an org written with a pipe gets both domains, in order', () =>
    expect(domainsOf(cand({ org: 'Stripe | Berkeley Haas' }), m)).toEqual([
      'stripe.com',
      'haas.berkeley.edu',
    ]));
  it('D2 the company in the headline when the org is empty', () =>
    expect(domainsOf(cand({ headline: 'Engineer at Stripe' }), m)).toEqual(['stripe.com']));
});

// written blind, after the rules above were tuned, to check they generalize
const BLIND: TierCase[] = [
  {
    id: 'B01 Stripe alumni group is not Stripe',
    c: { org: 'Ex-Stripe Angels', headline: 'Angel investor' },
    warm: [sam],
    tier: 5,
  },
  { id: 'B02 bridge via headline at', c: { headline: 'Staff engineer at Stripe' }, warm: [sam], tier: 2 },
  { id: 'B03 org with emoji', c: { org: 'Stripe 💳', title: 'PM' }, warm: [sam], tier: 2 },
  {
    id: 'B04 warm contact with a messy org',
    c: { org: 'Adobe' },
    warm: [{ ...sam, org: 'SpaceX, Adobe' }],
    tier: 2,
  },
  {
    id: 'B05 former employee is no bridge',
    c: { org: 'Notion' },
    warm: [{ ...sam, org: 'ex-Notion' }],
    tier: 5,
  },
  {
    id: 'B06 stealth is no company',
    c: { org: 'Stealth', headline: 'Founder' },
    warm: [{ ...sam, org: 'Stealth' }],
    tier: 5,
  },
  {
    id: 'B07 YC batch is no company',
    c: { org: 'Acme (YC W24)', headline: 'Founder' },
    warm: [{ ...sam, org: 'Corgi (YC W24)' }],
    tier: 5,
  },
  {
    id: 'B08 same startup, batch noted',
    c: { org: 'Corgi (YC24)' },
    warm: [{ ...sam, org: 'Corgi' }],
    tier: 2,
  },
  { id: 'B09 a different UC is not the school', c: { headline: 'UCLA alum, PM at Snap' }, tier: 5 },
  {
    id: 'B10 Berkeley the lab, with lab context',
    c: { headline: 'Scientist at Lawrence Berkeley National Lab' },
    tier: 5,
  },
  {
    id: 'B11 professor at the school',
    c: { title: 'Professor', org: 'UC Berkeley', headline: 'Professor of EECS, UC Berkeley' },
    tier: 3,
    why: /Also at UC Berkeley/,
  },
  { id: 'B12 Go Bears', c: { headline: "Product at Ramp · Cal '21 · Go Bears" }, tier: 3 },
  { id: 'B13 past company as a word inside another', c: { headline: 'Works at Sonatusia Labs' }, tier: 5 },
  {
    id: 'B14 open door, closed by negation later',
    c: { evidence: ['Happy to chat, but I do not respond to cold emails.'] },
    tier: 5,
  },
  { id: 'B15 open to coffee chats', c: { headline: 'Open to coffee chats with students' }, tier: 4 },
  { id: 'B16 class year far future', c: { headline: 'Intern, class of 2029' }, tier: 5 },
  {
    id: 'B17 hook from résumé phrase',
    c: { headline: 'Program management at SpaceX' },
    tier: 5,
    why: /program management/,
  },
  {
    id: 'B18 broad interest alone is no hook',
    c: { headline: 'Operations at Costco' },
    tier: 5,
    noWhy: true,
  },
  {
    id: 'B19 known with low score but a bridge',
    c: { org: 'Stripe' },
    known: { personId: 'p', score: 5 },
    warm: [sam],
    tier: 2,
  },
  {
    id: 'B20 hometown word inside another city',
    c: { location: 'North San Jose Heights, Manila', headline: 'Engineer' },
    tier: 3,
  },
];

describe('blind batch: 20 cases', () => {
  for (const t of BLIND)
    it(t.id, () => {
      const w = warmthOf(cand(t.c), {
        student,
        known: t.known ?? null,
        warm: t.warm ?? [],
        domains: t.domains,
        year: 2026,
      });
      expect({ id: t.id, tier: w.tier }).toEqual({ id: t.id, tier: t.tier });
      if (t.why) expect(w.why ?? '').toMatch(t.why);
      if (t.noWhy) expect(w.why).toBeUndefined();
    });
});
