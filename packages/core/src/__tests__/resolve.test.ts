import { describe, expect, it } from 'vitest';
import { computeFeatures, findDuplicatePairs, resolveIdentity } from '../entity/resolve';
import type { Person } from '../types';

const base = (over: Partial<Person>): Person => ({
  id: 'p1',
  userId: 'u',
  displayName: 'Priya Patel',
  firstName: 'Priya',
  lastName: 'Patel',
  nameNormalized: 'priya patel',
  emails: [],
  relationshipType: 'unknown',
  strength: 0,
  interactionCount: 0,
  sources: ['manual'],
  isHuman: true,
  tags: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('resolveIdentity', () => {
  const people = [
    base({
      id: 'p1',
      primaryEmail: 'priya@figma.com',
      emails: ['priya@figma.com'],
      currentOrganizationRaw: 'Figma',
      currentTitle: 'Product Manager',
      linkedinSlug: 'priya-patel',
    }),
    base({
      id: 'p2',
      displayName: 'Daniel Kim',
      firstName: 'Daniel',
      lastName: 'Kim',
      nameNormalized: 'daniel kim',
      currentOrganizationRaw: 'Stripe',
      currentTitle: 'Software Engineer',
    }),
  ];
  it('matches deterministically on email and linkedin', () => {
    expect(resolveIdentity({ email: 'Priya@Figma.com', source: 'gmail' }, { people })).toMatchObject({
      kind: 'match',
      personId: 'p1',
      via: 'email',
    });
    expect(
      resolveIdentity({ linkedinUrl: 'linkedin.com/in/Priya-Patel', source: 'linkedin_csv' }, { people }),
    ).toMatchObject({ kind: 'match', personId: 'p1', via: 'linkedin' });
  });
  it('matches probabilistically on name + org + email local part', () => {
    const r = resolveIdentity(
      { displayName: 'Dan Kim', email: 'dkim@stripe.com', companyRaw: 'Stripe Inc', source: 'gmail' },
      { people },
    );
    expect(r.kind === 'probable' || r.kind === 'match').toBe(true);
    if (r.kind === 'probable') expect(r.personId).toBe('p2');
  });
  it('creates new people for strangers', () => {
    expect(
      resolveIdentity({ displayName: 'Sofia Rossi', email: 'sofia@notion.so', source: 'gmail' }, { people })
        .kind,
    ).toBe('new');
  });
  it('does not auto-merge same last name different person', () => {
    const r = resolveIdentity(
      { displayName: 'Arjun Patel', email: 'arjun@gs.com', companyRaw: 'Goldman Sachs', source: 'gmail' },
      { people },
    );
    expect(r.kind).toBe('new');
  });
  it('finds duplicate pairs', () => {
    const dups = findDuplicatePairs([
      ...people,
      base({
        id: 'p3',
        displayName: 'Priya Patel',
        primaryEmail: 'ppatel@figma.com',
        emails: ['ppatel@figma.com'],
        currentOrganizationRaw: 'Figma, Inc.',
      }),
    ]);
    expect(dups[0]?.a.id === 'p1' || dups[0]?.b.id === 'p1').toBe(true);
    expect(dups[0]!.score).toBeGreaterThan(0.6);
  });
});

const person = (id: string, displayName: string, over: Partial<Person> = {}): Person => {
  const [firstName = '', ...rest] = displayName.split(' ');
  return base({
    id,
    displayName,
    firstName,
    lastName: rest.join(' '),
    nameNormalized: displayName.toLowerCase(),
    ...over,
  });
};

describe('org-name variants (NRC-05)', () => {
  it('treats McKinsey and McKinsey & Company as the same employer', () => {
    const people = [person('w', 'William Chen', { currentOrganizationRaw: 'McKinsey & Company' })];
    const viaName = resolveIdentity(
      { displayName: 'Bill Chen', companyRaw: 'McKinsey', source: 'gmail' },
      { people },
    );
    expect(viaName.kind).toBe('suggest');
    if (viaName.kind === 'suggest') expect(viaName.features.org_match).toBe(1);
    const withMail = resolveIdentity(
      { displayName: 'Bill Chen', email: 'wchen@mckinsey.com', companyRaw: 'McKinsey', source: 'gmail' },
      { people },
    );
    expect(withMail).toMatchObject({ kind: 'probable', personId: 'w' });
  });
  it('matches an accented CSV name against the plain gmail spelling at Bain', () => {
    const people = [person('j', 'José Núñez-García', { currentOrganizationRaw: 'Bain & Company, Inc.' })];
    expect(
      resolveIdentity({ displayName: 'Jose Nunez-Garcia', companyRaw: 'Bain', source: 'gmail' }, { people }),
    ).toMatchObject({ kind: 'match', personId: 'j', via: 'name_org' });
  });
  it('scores a prefix-contained org as a partial match, not a contradiction', () => {
    const p = person('g', 'Ana Lima', { currentOrganizationRaw: 'Google DeepMind' });
    const f = computeFeatures({ displayName: 'Ana Lima', companyRaw: 'Google', source: 'gmail' }, p, {
      people: [p],
    });
    expect(f.org_match).toBe(0.8);
  });
});

describe('gmail first, LinkedIn CSV second (NRC-06)', () => {
  it('merges a CSV row without email into the emailed person by name + employer domain', () => {
    const people = [
      person('dk', 'Daniel Kim', {
        primaryEmail: 'dkim@stripe.com',
        emails: ['dkim@stripe.com'],
        sources: ['gmail'],
      }),
    ];
    const r = resolveIdentity(
      { firstName: 'Daniel', lastName: 'Kim', companyRaw: 'Stripe', source: 'linkedin_csv' },
      { people },
    );
    expect(r).toMatchObject({ kind: 'probable', personId: 'dk' });
  });
});

describe('nicknames (NRC-11)', () => {
  const pairs: [string, string][] = [
    ['John', 'Jonathan'],
    ['Liam', 'William'],
    ['Jamie', 'James'],
    ['Sasha', 'Alexander'],
    ['Gail', 'Abigail'],
    ['Eliza', 'Elizabeth'],
    ['Nat', 'Natalie'],
    ['Alex', 'Alexandra'],
  ];
  it('never silently merges distinct given names at the same company', () => {
    for (const [a, b] of pairs) {
      const r = resolveIdentity(
        { displayName: `${a} Smith`, companyRaw: 'Stripe', source: 'gmail' },
        { people: [person('x', `${b} Smith`, { currentOrganizationRaw: 'Stripe' })] },
      );
      expect({ a, kind: r.kind }).toEqual({ a, kind: 'suggest' });
    }
  });
  it('recognises common nicknames that were missing', () => {
    const r = resolveIdentity(
      { displayName: 'Ken Park', email: 'kpark@stripe.com', companyRaw: 'Stripe', source: 'gmail' },
      { people: [person('k', 'Kenneth Park', { currentOrganizationRaw: 'Stripe' })] },
    );
    expect(r).toMatchObject({ kind: 'probable', personId: 'k' });
  });
});

describe('bare addresses (NRC-10)', () => {
  it('links a typed address to the named person at that employer', () => {
    const people = [person('e', 'Elena Rodriguez', { currentOrganizationRaw: 'Bain & Company' })];
    expect(resolveIdentity({ email: 'erodriguez@bain.com', source: 'gmail' }, { people })).toMatchObject({
      kind: 'probable',
      personId: 'e',
    });
    expect(resolveIdentity({ email: 'mchen@bain.com', source: 'gmail' }, { people }).kind).toBe('new');
  });
  it('links a named CSV row to a person known only by address', () => {
    const people = [
      person('b', 'erodriguez', {
        firstName: 'erodriguez',
        lastName: '',
        primaryEmail: 'erodriguez@bain.com',
        emails: ['erodriguez@bain.com'],
        namePlaceholder: true,
      }),
    ];
    expect(
      resolveIdentity(
        { firstName: 'Elena', lastName: 'Rodriguez', companyRaw: 'Bain & Company', source: 'linkedin_csv' },
        { people },
      ),
    ).toMatchObject({ kind: 'probable', personId: 'b' });
  });
});

describe('job changes and free mailboxes (NRC-15)', () => {
  const people = [
    person('pp', 'Priya Patel', {
      primaryEmail: 'priya@figma.com',
      emails: ['priya@figma.com'],
      currentOrganizationRaw: 'Figma',
    }),
  ];
  it('suggests a merge for the same full name at a new employer', () => {
    const r = resolveIdentity(
      { firstName: 'Priya', lastName: 'Patel', companyRaw: 'Stripe', source: 'linkedin_csv' },
      { people },
    );
    expect(r).toMatchObject({ kind: 'suggest', personId: 'pp' });
  });
  it('does not auto-merge on a name inside a gmail address alone', () => {
    const r = resolveIdentity(
      { displayName: 'Priya Patel', email: 'priya.patel88@gmail.com', source: 'gmail' },
      { people },
    );
    expect(r.kind).toBe('suggest');
  });
  it('still keeps a different first name at another company apart', () => {
    const r = resolveIdentity(
      { displayName: 'Arjun Patel', companyRaw: 'Stripe', source: 'gmail' },
      { people },
    );
    expect(r.kind).toBe('new');
  });
});

describe('findDuplicatePairs (NRC-20)', () => {
  const list = [
    person('figma', 'Priya Patel', {
      primaryEmail: 'priya@figma.com',
      emails: ['priya@figma.com'],
      currentOrganizationRaw: 'Figma',
    }),
    person('stripe', 'Priya Patel', { currentOrganizationRaw: 'Stripe' }),
    person('arjun', 'Arjun Patel', { currentOrganizationRaw: 'Figma' }),
    person('gmail', 'Priya Patel', {
      primaryEmail: 'priya.patel@gmail.com',
      emails: ['priya.patel@gmail.com'],
    }),
    person('dan', 'Daniel Kim', { currentOrganizationRaw: 'Stripe' }),
    person('dan2', 'Dan Kim', {
      primaryEmail: 'dkim@stripe.com',
      emails: ['dkim@stripe.com'],
      currentOrganizationRaw: 'Stripe, Inc.',
    }),
  ];
  const pairs = findDuplicatePairs(list);
  const key = (p: { a: Person; b: Person }) => [p.a.id, p.b.id].sort().join('|');
  it('never pairs colleagues who only share a surname and an employer', () => {
    expect(pairs.map(key)).not.toContain('arjun|figma');
    expect(pairs.some((p) => p.a.id === 'arjun' || p.b.id === 'arjun')).toBe(false);
  });
  it('ranks the real duplicates first', () => {
    expect(pairs.map(key)).toEqual(expect.arrayContaining(['figma|gmail', 'dan|dan2']));
    expect(pairs[0]!.score).toBeGreaterThan(0.6);
    expect(['figma|gmail', 'dan|dan2', 'gmail|stripe', 'figma|stripe']).toContain(key(pairs[0]!));
  });
  it('treats a capitalised name that fits the address as a real name', () => {
    const f = pairs.find((p) => key(p) === 'figma|gmail')!;
    expect(f.features.name_sim).toBe(1);
  });
  it('pairs people that share an address with full confidence', () => {
    const r = findDuplicatePairs([
      person('x', 'Sam Lee', { primaryEmail: 'sam@acme.com', emails: ['sam@acme.com'] }),
      person('y', 'Samuel Lee', { emails: ['sam@acme.com'] }),
    ]);
    expect(r[0]).toMatchObject({ score: 1 });
  });
  it('links a bare address to the named person at that employer', () => {
    const r = findDuplicatePairs([
      person('named', 'Elena Rodriguez', { currentOrganizationRaw: 'Deloitte' }),
      person('bare', 'erodriguez', {
        primaryEmail: 'erodriguez@deloitte.com',
        emails: ['erodriguez@deloitte.com'],
        namePlaceholder: true,
      }),
    ]);
    expect(r.map(key)).toContain('bare|named');
  });
});

describe('the incremental resolver applies the same guards as findDuplicatePairs', () => {
  it('two colleagues with one surname at one employer get no merge card', () => {
    const priya = base({
      id: 'p1',
      primaryEmail: 'priya@figma.com',
      emails: ['priya@figma.com'],
      currentOrganizationRaw: 'Figma',
    });
    const d = resolveIdentity(
      { displayName: 'Arjun Patel', email: 'arjun@figma.com', companyRaw: 'Figma', source: 'gmail' },
      { people: [priya] },
    );
    expect(d.kind).toBe('new');
  });
  it('the same name at a look-alike firm is only suggested (Bain Capital is not Bain & Company)', () => {
    const jose = base({
      id: 'j',
      displayName: 'José Núñez',
      firstName: 'José',
      lastName: 'Núñez',
      nameNormalized: 'jose nunez',
      currentOrganizationRaw: 'Bain & Company',
    });
    const d = resolveIdentity(
      { displayName: 'Jose Nunez', companyRaw: 'Bain Capital', source: 'linkedin_csv' },
      { people: [jose] },
    );
    expect(d.kind).toBe('suggest');
    const titled = resolveIdentity(
      { displayName: 'Jose Nunez', companyRaw: 'Bain Capital', title: 'Associate', source: 'linkedin_csv' },
      { people: [{ ...jose, currentTitle: 'Associate' }] },
    );
    expect(titled.kind).toBe('suggest');
  });
});
