import { describe, expect, it } from 'vitest';
import {
  accountKind,
  bioMentions,
  bioYear,
  handleFromLink,
  handleSpellsName,
  handlesIn,
  matchSocialAccount,
  matchTargetAccount,
  type SocialAccount,
  type SocialCandidate,
  type SocialMatch,
  socialBlock,
} from '../entity/social';

/**
 * The labelled set for plan 43 §3.4 and §8.2: accounts that are and are not the people they look like, built like the
 * identity corpus. The bar: no wrong automatic match, ever; most true matches found (attached or asked); a stranger
 * never asked about; hard proof always attaches.
 */

interface Base {
  id: string;
  first: string;
  last: string;
  org: string;
  size: number;
  title: string;
  school: string;
  year: number;
  city: string;
  slug: string;
  email: string;
  phone: string;
  site: string;
}

const PEOPLE: Base[] = [
  ['maya', 'Maya', 'Okafor', 'Ramp', 600, 'Product Designer', 'Stanford University', 2024, 'New York, NY'],
  [
    'jason',
    'Jason',
    'Chen',
    'Stripe',
    8000,
    'Software Engineer',
    'University of Michigan',
    2023,
    'San Francisco, CA',
  ],
  [
    'priya',
    'Priya',
    'Raman',
    'Notion',
    700,
    'Product Manager',
    'Cornell University',
    2022,
    'San Francisco, CA',
  ],
  ['diego', 'Diego', 'Alvarado', 'Figma', 1500, 'Designer', 'UCLA', 2025, 'Los Angeles, CA'],
  ['sara', 'Sara', 'Lindqvist', 'Linear', 120, 'Engineer', 'MIT', 2021, 'Boston, MA'],
  ['omar', 'Omar', 'Haddad', 'Goldman Sachs', 45000, 'Analyst', 'NYU', 2024, 'New York, NY'],
  [
    'emily',
    'Emily',
    'Nguyen',
    'Duolingo',
    900,
    'Data Scientist',
    'Carnegie Mellon University',
    2023,
    'Pittsburgh, PA',
  ],
  ['kwame', 'Kwame', 'Mensah', 'Plaid', 950, 'Engineer', 'Georgia Tech', 2022, 'Atlanta, GA'],
  [
    'lena',
    'Lena',
    'Fischer',
    'Vercel',
    600,
    'Developer Advocate',
    'University of Washington',
    2024,
    'Seattle, WA',
  ],
  [
    'arjun',
    'Arjun',
    'Mehta',
    'Google',
    180000,
    'Software Engineer',
    'Stanford University',
    2023,
    'Mountain View, CA',
  ],
  ['sofia', 'Sofia', 'Rossi', 'Glossier', 300, 'Marketing Lead', 'Parsons', 2021, 'New York, NY'],
  [
    'michael',
    'Michael',
    'Brennan',
    'Anduril',
    900,
    'Mechanical Engineer',
    'Purdue University',
    2022,
    'Costa Mesa, CA',
  ],
  ['hana', 'Hana', 'Takahashi', 'Retool', 400, 'Engineer', 'UC Berkeley', 2024, 'San Francisco, CA'],
  ['noah', 'Noah', 'Feldman', 'Brex', 1100, 'Recruiter', 'University of Pennsylvania', 2020, 'New York, NY'],
  ['amara', 'Amara', 'Eze', 'Scale AI', 800, 'Operations', 'Duke University', 2023, 'San Francisco, CA'],
  [
    'tomas',
    'Tomás',
    'Herrera',
    'Rippling',
    3000,
    'Account Executive',
    'University of Texas',
    2022,
    'Austin, TX',
  ],
  ['grace', 'Grace', 'Park', 'Jane Street', 2500, 'Trader', 'Princeton University', 2024, 'New York, NY'],
  ['ben', 'Benjamin', 'Okoye', 'Mercury', 700, 'Engineer', 'Columbia University', 2023, 'New York, NY'],
  ['chloe', 'Chloe', 'Dubois', 'Airtable', 900, 'Designer', 'RISD', 2022, 'San Francisco, CA'],
  ['ravi', 'Ravi', 'Subramanian', 'Databricks', 7000, 'Engineer', 'UIUC', 2021, 'San Francisco, CA'],
  [
    'isabel',
    'Isabel',
    'Moreno',
    'Patagonia',
    3000,
    'Sustainability Analyst',
    'UC Santa Barbara',
    2024,
    'Ventura, CA',
  ],
  ['yusuf', 'Yusuf', 'Demir', 'Cloudflare', 4000, 'Security Engineer', 'Rice University', 2023, 'Austin, TX'],
  ['nina', 'Nina', 'Kowalski', 'Hex', 150, 'Data Engineer', 'University of Chicago', 2022, 'Chicago, IL'],
  [
    'wei',
    'Wei',
    'Zhang',
    'TikTok',
    50000,
    'Product Manager',
    'University of Southern California',
    2023,
    'Los Angeles, CA',
  ],
  ['olivia', 'Olivia', 'Grant', 'Warby Parker', 3000, 'Strategy Associate', 'Wharton', 2021, 'New York, NY'],
].map(([id, first, last, org, size, title, school, year, city]) => {
  const f = (first as string).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  const l = (last as string).toLowerCase();
  return {
    id: id as string,
    first: first as string,
    last: last as string,
    org: org as string,
    size: size as number,
    title: title as string,
    school: school as string,
    year: year as number,
    city: city as string,
    slug: `${f}-${l}-${(id as string).length}a`,
    email: `${f}.${l}@gmail.com`,
    phone: `+1415555${String(1000 + (id as string).length * 37).slice(0, 4)}`,
    site: `${f}${l}.com`,
  };
});

const candidate = (b: Base, extra: Partial<SocialCandidate> = {}): SocialCandidate => ({
  person: {
    id: b.id,
    displayName: `${b.first} ${b.last}`,
    firstName: b.first,
    lastName: b.last,
    emails: [b.email],
    primaryEmail: b.email,
    phones: [b.phone],
    linkedinUrl: `https://www.linkedin.com/in/${b.slug}`,
    linkedinSlug: b.slug,
    currentTitle: b.title,
    currentOrganizationRaw: b.org,
    school: b.school,
    location: b.city,
  },
  schoolYear: b.year,
  employerSize: b.size,
  links: [`https://${b.site}`],
  pictureHash: `pic-${b.id}`,
  knownToStudent: true,
  ...extra,
});

const account = (b: Base, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  platform: 'instagram',
  id: `ig-${b.id}-${Math.abs(hash(JSON.stringify(extra)))}`,
  username: `${b.first.toLowerCase()}.${b.last.toLowerCase()}`.normalize('NFKD').replace(/\p{M}/gu, ''),
  name: `${b.first} ${b.last}`,
  followers: 600,
  following: 450,
  ...extra,
});

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

interface Case {
  why: string;
  truth: 'same' | 'different';
  account: SocialAccount;
  /** the people the account is weighed against; the first is the one it looks like */
  candidates: SocialCandidate[];
  /** for `same`: what must happen (attach by proof is required where the case has proof) */
  expect?: 'attach' | 'found';
}

const cases: Case[] = [];
const same = (why: string, a: SocialAccount, c: SocialCandidate[], e: Case['expect'] = 'found') =>
  cases.push({ why, truth: 'same', account: a, candidates: c, expect: e });
const different = (why: string, a: SocialAccount, c: SocialCandidate[]) =>
  cases.push({ why, truth: 'different', account: a, candidates: c });

for (const b of PEOPLE) {
  const me = candidate(b);
  // ---- the same person ----
  same(
    'their LinkedIn lists the handle',
    account(b, { username: `${b.first[0]}${b.last}x`.toLowerCase() }),
    [candidate(b, { links: [`https://instagram.com/${b.first[0]}${b.last}x`.toLowerCase()] })],
    'attach',
  );
  same(
    'the account links back to their LinkedIn',
    account(b, { username: 'random_handle', links: [`linkedin.com/in/${b.slug}`] }),
    [me],
    'attach',
  );
  same(
    'the account shows their email',
    account(b, { email: b.email.toUpperCase(), business: true, name: `${b.first} ${b.last}` }),
    [me],
    'attach',
  );
  same(
    "the student's address book lists the handle",
    account(b, { username: `${b.first}_${b.last}`.toLowerCase() }),
    [candidate(b, { contactHandles: [`@${b.first}_${b.last}`.toLowerCase()] })],
    'attach',
  );
  same(
    'school and year in the bio, with their name',
    account(b, { bio: `${b.school} '${String(b.year).slice(2)} · ${b.city.split(',')[0]}` }),
    [me],
  );
  same('the same personal site', account(b, { links: [`https://www.${b.site}/`], bio: 'building things' }), [
    me,
  ]);
  same('the same picture', account(b, { pictureHash: `pic-${b.id}` }), [me]);
  same('name and handle only, someone they know', account(b, { bio: 'coffee, film, long runs' }), [me]);
  same(
    'name written with accents dropped',
    account(b, { name: `${b.first} ${b.last}`.normalize('NFKD').replace(/\p{M}/gu, '') }),
    [me],
  );
  if (b.size < 1000)
    same('employer and role at a small employer', account(b, { bio: `${b.title} @ ${b.org}` }), [me]);

  // ---- not the same person ----
  const namesake = (extra: Partial<SocialAccount>) =>
    account(b, { id: `ns-${b.id}-${hash(JSON.stringify(extra))}`, ...extra });
  different(
    'a namesake at the same school, another year',
    namesake({ bio: `${b.school} '${String(b.year + 3).slice(2)}`, pictureHash: 'other' }),
    [me],
  );
  different('a namesake at another school', namesake({ bio: 'Ohio State 2026', pictureHash: 'other' }), [me]);
  different(
    'a verified celebrity with the same name',
    namesake({ verified: true, followers: 2_000_000, bio: 'Actor. Director.' }),
    [candidate(b, { knownToStudent: false })],
  );
  different(
    'a brand page with the name',
    namesake({
      name: `${b.last} Studio`,
      business: true,
      category: 'Photographer',
      username: `${b.last.toLowerCase()}studio`,
    }),
    [me],
  );
  different(
    'a handle with digits and no name',
    namesake({ name: undefined, username: `${b.first.toLowerCase()}${b.last.toLowerCase()}2007` }),
    [me],
  );
  different(
    'a parody account',
    namesake({ name: `Not ${b.first} ${b.last}`, bio: 'parody', username: `not${b.last.toLowerCase()}` }),
    [me],
  );
  different(
    'the same default avatar',
    namesake({ defaultPicture: true, pictureHash: 'default-avatar', bio: 'hi' }),
    [candidate(b, { pictureHash: 'default-avatar', knownToStudent: false })],
  );
  different('a common name at a large employer, a stranger', namesake({ bio: `${b.title} at ${b.org}` }), [
    candidate(b, { knownToStudent: false, employerSize: 100_000 }),
  ]);
  different(
    'a second person who lists another account',
    namesake({ username: `${b.first}.${b.last}.art`.toLowerCase(), bio: 'illustration' }),
    [candidate(b, { otherHandles: [`${b.first}.${b.last}`.toLowerCase()], knownToStudent: false })],
  );
}

// two people with one name, both known to the student: never picked
different('two Jason Chens the student knows, the account fits both', account(PEOPLE[1]!, { bio: 'eng' }), [
  candidate(PEOPLE[1]!),
  candidate({ ...PEOPLE[1]!, id: 'jason2', org: 'Meta', slug: 'jason-chen-meta' }),
]);

const decide = (c: Case): SocialMatch => matchSocialAccount(c.account, c.candidates);

describe('matching an Instagram or X account to a person (plan 43 §3.4, §8.2)', () => {
  const results = cases.map((c) => ({ c, r: decide(c) }));
  const sameCases = results.filter((x) => x.c.truth === 'same');
  const diffCases = results.filter((x) => x.c.truth === 'different');

  it('has a labelled set big enough to mean something', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(sameCases.length).toBeGreaterThan(60);
    expect(diffCases.length).toBeGreaterThan(60);
  });

  it('never attaches an account to the wrong person', () => {
    const wrong = results.filter(
      (x) =>
        x.r.kind === 'attach' && (x.c.truth === 'different' || x.r.personId !== x.c.candidates[0]!.person.id),
    );
    expect(wrong.map((x) => x.c.why)).toEqual([]);
  });

  it('never asks the student about someone they do not know', () => {
    const asked = results.filter(
      (x) =>
        x.r.kind === 'ask' &&
        !x.c.candidates.find((c) => c.person.id === (x.r as { personId: string }).personId)?.knownToStudent,
    );
    expect(asked.map((x) => x.c.why)).toEqual([]);
  });

  it('attaches on hard proof every time', () => {
    const proof = sameCases.filter((x) => x.c.expect === 'attach');
    expect(proof.length).toBeGreaterThanOrEqual(PEOPLE.length * 4);
    expect(proof.filter((x) => x.r.kind !== 'attach').map((x) => x.c.why)).toEqual([]);
  });

  it('finds almost every true match, by attaching or by asking', () => {
    const found = sameCases.filter((x) => x.r.kind === 'attach' || x.r.kind === 'ask').length;
    expect(found / sameCases.length).toBeGreaterThanOrEqual(0.95);
  });

  it('attaches a scored match only with a signal about this one person', () => {
    for (const { r } of results) {
      if (r.kind !== 'attach' || r.via !== 'score') continue;
      expect(
        ['employer_role_small', 'school_year', 'same_link', 'same_picture'].some((k) => k in r.signals),
      ).toBe(true);
    }
  });

  it('asks rather than attaches on a name and a handle alone', () => {
    const plain = results.find((x) => x.c.why === 'name and handle only, someone they know')!;
    expect(plain.r.kind).toBe('ask');
  });

  it('never attaches a different person even when the student said no to the right one', () => {
    const b = PEOPLE[0]!;
    const r = matchSocialAccount(account(b, { pictureHash: `pic-${b.id}` }), [candidate(b)], {
      rejected: new Set([b.id]),
    });
    expect(r.kind).toBe('none');
  });
});

describe('targets are matched by hard proof only (plan 43 §3.4)', () => {
  it('attaches a target on proof, and otherwise does nothing', () => {
    const b = PEOPLE[2]!;
    expect(
      matchTargetAccount(
        account(b, { links: [`linkedin.com/in/${b.slug}`] }),
        candidate(b, { knownToStudent: false }),
      ).kind,
    ).toBe('attach');
    expect(
      matchTargetAccount(
        account(b, { pictureHash: `pic-${b.id}`, bio: `${b.title} @ ${b.org}` }),
        candidate(b, { knownToStudent: false }),
      ),
    ).toEqual({
      kind: 'none',
      reason: 'stranger',
    });
  });
});

describe('reading accounts', () => {
  it('sorts accounts so only people can be bridges', () => {
    expect(accountKind({ platform: 'instagram', id: '1', username: 'maya.o', name: 'Maya Okafor' })).toBe(
      'person',
    );
    expect(
      accountKind({ platform: 'instagram', id: '1', username: 'x', name: 'Maya Okafor', verified: true }),
    ).toBe('public_figure');
    expect(
      accountKind({ platform: 'instagram', id: '1', username: 'x', name: 'Maya', followers: 90_000 }),
    ).toBe('public_figure');
    expect(
      accountKind({
        platform: 'instagram',
        id: '1',
        username: 'x',
        name: 'Blue Bottle Coffee Shop',
        business: true,
      }),
    ).toBe('brand');
    expect(accountKind({ platform: 'instagram', id: '1', username: 'dankmemes', name: 'Daily Memes' })).toBe(
      'brand',
    );
    expect(accountKind({ platform: 'instagram', id: '1', username: 'm' })).toBe('unknown');
  });

  it('reads handles from links and text', () => {
    expect(handleFromLink('https://www.instagram.com/maya.o/', 'instagram')).toBe('maya.o');
    expect(handleFromLink('instagram.com/p/abc123', 'instagram')).toBeUndefined();
    expect(handleFromLink('https://twitter.com/mayao', 'x')).toBe('mayao');
    expect(handleFromLink('https://x.com/mayao/status/1', 'x')).toBe('mayao');
    expect(handleFromLink('https://instagram.com/maya', 'x')).toBeUndefined();
    expect(handlesIn('IG: @Maya.O and instagram.com/maya_two', 'instagram').sort()).toEqual([
      'maya.o',
      'maya_two',
    ]);
    expect(handlesIn('twitter: @mayao', 'x')).toEqual(['mayao']);
  });

  it('counts a handle with a number for nothing, and a name-shaped one a little', () => {
    expect(handleSpellsName('jason.chen22', 'Jason', 'Chen')).toBe(0);
    expect(handleSpellsName('jason.chen', 'Jason', 'Chen')).toBe(1);
    expect(handleSpellsName('jchen', 'Jason', 'Chen')).toBe(0.7);
    expect(handleSpellsName('surfer_dude', 'Jason', 'Chen')).toBe(0);
  });

  it('finds employers and class years in bios', () => {
    expect(bioMentions('SWE @stripe | ex-intern', 'Stripe, Inc.')).toBe(true);
    expect(bioMentions('studying cs at stanford', 'Stanford University')).toBe(true);
    expect(bioMentions('I like stripes', 'Stripe')).toBe(false);
    expect(bioYear("Stanford '25")).toBe(2025);
    expect(bioYear('Penn class of 2026')).toBe(2026);
    expect(bioYear('no year here')).toBeUndefined();
  });

  it('blocks to people whose names could fit, and keeps an unnamed account findable by proof', () => {
    const people = PEOPLE.map((b) => candidate(b));
    const a = account(PEOPLE[0]!);
    expect(socialBlock(a, people).map((c) => c.person.id)).toEqual(['maya']);
    const unnamed = {
      ...account(PEOPLE[3]!),
      name: undefined,
      username: 'zz_top',
      links: [`linkedin.com/in/${PEOPLE[3]!.slug}`],
    };
    expect(socialBlock(unnamed, people).map((c) => c.person.id)).toEqual(['diego']);
  });
});
