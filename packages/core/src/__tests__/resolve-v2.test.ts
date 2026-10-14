import { describe, expect, it } from 'vitest';
import { isFirstNameVariant, NICKNAME_VARIANTS, nameVariants } from '../entity/nicknames';
import { NICKNAME_DATA } from '../entity/nicknames.data';
import {
  AUTO_MERGE_THRESHOLD,
  doNotMergeKey,
  findDuplicatePairs,
  type IncomingIdentity,
  isRoleAddress,
  NAME_ORG_ONLY_CAP,
  normalizeEmailForMatch,
  type ResolveContext,
  resolveIdentity,
  scorePair,
} from '../entity/resolve';
import { linkedInSlug, normalizeEmail, parseName } from '../text/normalize';
import type { Person } from '../types';

const person = (id: string, displayName: string, over: Partial<Person> = {}): Person => {
  const n = parseName(displayName);
  return {
    id,
    userId: 'u',
    displayName,
    firstName: n.first,
    lastName: n.last,
    nameNormalized: n.normalized,
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
  };
};

describe('nicknames table (carltonnorthern/nicknames)', () => {
  it('is vendored and loaded in both directions', () => {
    expect(NICKNAME_DATA.length).toBeGreaterThan(1000);
    expect(NICKNAME_VARIANTS.get('elizabeth')?.has('liz')).toBe(true);
    expect(NICKNAME_VARIANTS.get('liz')?.has('elizabeth')).toBe(true);
    expect(nameVariants('William').has('bill')).toBe(true);
    expect(nameVariants('Zzyzx').size).toBe(0);
  });

  it('relates a name and its nickname, but not two nicknames of one name or a name to itself', () => {
    expect(isFirstNameVariant('Liz', 'Elizabeth')).toBe(true);
    expect(isFirstNameVariant('Bill', 'william')).toBe(true);
    expect(isFirstNameVariant('Kit', 'Christopher')).toBe(true);
    expect(isFirstNameVariant('Liz', 'Beth')).toBe(false);
    expect(isFirstNameVariant('Liz', 'Liz')).toBe(false);
    expect(isFirstNameVariant('Priya', 'Pooja')).toBe(false);
  });
});

describe('email normalization and role addresses (§2.1, §2.5)', () => {
  it('drops gmail dots and +tags only on gmail', () => {
    expect(normalizeEmailForMatch('Liz.Chen+jobs@gmail.com')).toBe('lizchen@gmail.com');
    expect(normalizeEmailForMatch('"Liz" <liz.chen@googlemail.com>')).toBe('lizchen@gmail.com');
    expect(normalizeEmailForMatch('Liz.Chen+jobs@stripe.com')).toBe('liz.chen+jobs@stripe.com');
  });

  it('never makes a role inbox into a person', () => {
    for (const e of [
      'info@x.com',
      'careers@stripe.com',
      'no-reply@x.com',
      'no_reply@x.com',
      'team+news@y.com',
    ])
      expect(isRoleAddress(e), e).toBe(true);
    expect(isRoleAddress('liz@stripe.com')).toBe(false);
    expect(
      resolveIdentity(
        { email: 'careers@stripe.com', displayName: 'Stripe Careers', source: 'gmail' },
        { people: [] },
      ),
    ).toEqual({
      kind: 'role',
    });
  });
});

describe('nickname feature and the name-and-employer cap', () => {
  it('scores a nickname with the firstNameVariant feature', () => {
    const p = person('w', 'Christopher Lane', { currentOrganizationRaw: 'Figma' });
    const { features, score } = scorePair(
      { displayName: 'Kit Lane', companyRaw: 'Figma', source: 'gmail' },
      p,
      {
        people: [p],
      },
    );
    expect(features.firstNameVariant).toBe(1);
    expect(score).toBeGreaterThanOrEqual(0.6);
    expect(score).toBeLessThan(AUTO_MERGE_THRESHOLD);
    const same = scorePair({ displayName: 'Christopher Lane', source: 'gmail' }, p, { people: [p] });
    expect(same.features.firstNameVariant).toBe(0);
  });

  it('caps two namesakes at one company at 0.85 without an address or school', () => {
    const p = person('a', 'John Smith', {
      currentOrganizationRaw: 'Stripe',
      primaryEmail: 'john.smith@stripe.com',
      emails: ['john.smith@stripe.com'],
    });
    const inc: IncomingIdentity = {
      displayName: 'John Smith',
      companyRaw: 'Stripe',
      email: 'jsmith1987@yahoo.com',
      source: 'gmail',
    };
    const { score, features } = scorePair(inc, p, { people: [p] });
    expect(features.org_match).toBe(1);
    expect(score).toBeLessThanOrEqual(NAME_ORG_ONLY_CAP);
    expect(resolveIdentity(inc, { people: [p] })).toMatchObject({ kind: 'suggest', personId: 'a' });
  });
});

/** A tiny store that applies resolution decisions the way ingestion does (§2.1). */
function store() {
  const people: Person[] = [];
  const identities = new Map<string, { kind: string; raw: string; source: string }[]>();
  const suggestions: [string, string][] = [];
  let n = 0;
  const addIdentity = (pid: string, inc: IncomingIdentity) => {
    const arr = identities.get(pid) ?? [];
    if (inc.email) arr.push({ kind: 'email', raw: inc.email, source: inc.source });
    if (inc.linkedinUrl) arr.push({ kind: 'linkedin_slug', raw: inc.linkedinUrl, source: inc.source });
    identities.set(pid, arr);
  };
  const create = (inc: IncomingIdentity): Person => {
    const email = inc.email ? normalizeEmail(inc.email) : undefined;
    const p = person(`p${++n}`, inc.displayName ?? `${inc.firstName} ${inc.lastName}`, {
      primaryEmail: email,
      emails: email ? [email] : [],
      currentOrganizationRaw: inc.companyRaw,
      linkedinUrl: inc.linkedinUrl,
      linkedinSlug: linkedInSlug(inc.linkedinUrl),
      sources: [inc.source],
    });
    people.push(p);
    addIdentity(p.id, inc);
    return p;
  };
  const merge = (into: string, from: string) => {
    const a = people.find((p) => p.id === into)!;
    const b = people.find((p) => p.id === from)!;
    a.linkedinUrl ??= b.linkedinUrl;
    a.linkedinSlug ??= b.linkedinSlug;
    a.currentOrganizationRaw ??= b.currentOrganizationRaw;
    identities.set(into, [...(identities.get(into) ?? []), ...(identities.get(from) ?? [])]);
    identities.delete(from);
    people.splice(people.indexOf(b), 1);
  };
  const see = (inc: IncomingIdentity, ctx: Omit<ResolveContext, 'people'> = {}) => {
    const d = resolveIdentity(inc, { people, ...ctx });
    if (d.kind === 'match' || d.kind === 'probable') {
      const p = people.find((x) => x.id === d.personId)!;
      const email = inc.email ? normalizeEmail(inc.email) : undefined;
      if (email && !p.emails.includes(email)) p.emails.push(email);
      addIdentity(p.id, inc);
      if (d.kind === 'match') for (const other of d.mergeWith ?? []) merge(p.id, other);
    } else if (d.kind === 'suggest') {
      const p = create(inc);
      suggestions.push([d.personId, p.id]);
    } else if (d.kind === 'new') create(inc);
    return d;
  };
  return { people, identities, suggestions, see };
}

describe('§2.6 acceptance', () => {
  it('1: Gmail, then LinkedIn, then a calendar invite resolve to one person with three identities', () => {
    const s = store();
    s.see({ email: 'Liz.Chen+jobs@gmail.com', displayName: 'Liz Chen', source: 'gmail' });
    // the LinkedIn relation alone is only a nickname and a surname: the student is asked (0.6–0.92)
    const li = s.see({
      displayName: 'Elizabeth Chen',
      companyRaw: 'Stripe',
      linkedinUrl: 'https://www.linkedin.com/in/elizabeth-chen-12',
      source: 'linkedin_csv',
    });
    expect(li.kind).toBe('suggest');
    // the invite shows Liz's mailbox under the LinkedIn name: the same person
    const cal = s.see({ email: 'lizchen@gmail.com', displayName: 'Elizabeth Chen', source: 'calendar' });
    expect(cal).toMatchObject({ kind: 'match', via: 'email' });
    expect(s.people).toHaveLength(1);
    const ids = s.identities.get(s.people[0]!.id)!;
    expect(ids.map((i) => `${i.kind}:${i.raw}`).sort()).toEqual([
      'email:Liz.Chen+jobs@gmail.com',
      'email:lizchen@gmail.com',
      'linkedin_slug:https://www.linkedin.com/in/elizabeth-chen-12',
    ]);
    expect(
      new Set(ids.filter((i) => i.kind === 'email').map((i) => normalizeEmailForMatch(i.raw))).size,
    ).toBe(1);
    expect(s.people[0]!.currentOrganizationRaw).toBe('Stripe');
  });

  it('2: do_not_merge pairs are never merged, even when the score is above 0.92', () => {
    const dk = person('dk', 'Daniel Kim', { primaryEmail: 'dkim@stripe.com', emails: ['dkim@stripe.com'] });
    const csv: IncomingIdentity = {
      firstName: 'Daniel',
      lastName: 'Kim',
      companyRaw: 'Stripe',
      source: 'linkedin_csv',
      personId: 'dk2',
    };
    const open = resolveIdentity(csv, { people: [dk] });
    expect(open).toMatchObject({ kind: 'probable', personId: 'dk' });
    expect((open as { score: number }).score).toBeGreaterThanOrEqual(AUTO_MERGE_THRESHOLD);
    const ctx = { people: [dk], doNotMerge: new Set([doNotMergeKey('dk', 'dk2')]) };
    expect(resolveIdentity(csv, ctx).kind).toBe('new');
    // even a shared address does not merge a rejected pair
    expect(resolveIdentity({ ...csv, email: 'dkim@stripe.com' }, ctx).kind).toBe('new');
    // and the duplicate pass never suggests it again
    const dk2 = person('dk2', 'Daniel Kim', { currentOrganizationRaw: 'Stripe' });
    expect(findDuplicatePairs([dk, dk2]).length).toBe(1);
    expect(findDuplicatePairs([dk, dk2], { doNotMerge: ctx.doNotMerge })).toEqual([]);
  });

  it('an address under a LinkedIn name merges nobody who has an address of their own, or was rejected', () => {
    const liz = person('liz', 'Liz Chen', {
      primaryEmail: 'lizchen@gmail.com',
      emails: ['lizchen@gmail.com'],
    });
    const other = person('eli', 'Elizabeth Chen', {
      primaryEmail: 'echen@stripe.com',
      emails: ['echen@stripe.com'],
      linkedinSlug: 'echen',
    });
    const inc = { email: 'lizchen@gmail.com', displayName: 'Elizabeth Chen', source: 'calendar' } as const;
    expect(resolveIdentity(inc, { people: [liz, other] })).toEqual({
      kind: 'match',
      personId: 'liz',
      via: 'email',
    });
    const liOnly = person('eli', 'Elizabeth Chen', { linkedinSlug: 'echen' });
    expect(resolveIdentity(inc, { people: [liz, liOnly] })).toMatchObject({ mergeWith: ['eli'] });
    expect(
      resolveIdentity(inc, { people: [liz, liOnly], doNotMerge: new Set([doNotMergeKey('liz', 'eli')]) }),
    ).toEqual({ kind: 'match', personId: 'liz', via: 'email' });
  });
});
