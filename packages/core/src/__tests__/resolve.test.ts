import { describe, expect, it } from 'vitest';
import { findDuplicatePairs, resolveIdentity } from '../entity/resolve';
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
