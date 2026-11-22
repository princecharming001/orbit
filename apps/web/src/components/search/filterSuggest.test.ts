/**
 * What the search filters suggest: the values the student's own people carry come first with how many, the built-in
 * lists fill in behind them, an empty query gives the common choices, and the best match leads.
 */
import type { Person } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';

// a logo is a lookup of its own; the suggestions only need the names
vi.mock('../CompanyLogo', () => ({ CompanyLogo: () => null }));

import { forgetFilterSuggestions, suggestFilter } from './filterSuggest';

const USER = 'u_filters';
let n = 0;
function person(over: Partial<Person>): Person {
  n++;
  const at = '2026-11-20T12:00:00.000Z';
  return {
    id: `p_${n}`,
    userId: USER,
    displayName: `Person ${n}`,
    firstName: 'Person',
    lastName: `${n}`,
    nameNormalized: `person ${n}`,
    emails: [],
    relationshipType: 'unknown',
    strength: 0.3,
    interactionCount: 0,
    sources: ['manual'],
    createdAt: at,
    updatedAt: at,
    ...over,
  } as Person;
}

const values = async (field: Parameters<typeof suggestFilter>[1], q: string) =>
  (await suggestFilter(USER, field, q)).map((s) => s.value);

beforeEach(async () => {
  await wipeDatabase();
  forgetFilterSuggestions();
  await db.people.bulkPut([
    person({ currentTitle: 'Venture Partner', currentOrganizationRaw: 'Accel', location: 'Austin, Texas' }),
    person({ currentTitle: 'Venture Partner', currentOrganizationRaw: 'Accel', location: 'Austin, Texas' }),
    person({ currentTitle: 'Product Manager', currentOrganizationRaw: 'Stripe', location: 'London' }),
    person({ currentTitle: 'Chief of Staff', currentOrganizationRaw: 'Stripe', school: 'Rice University' }),
    person({ currentTitle: 'Chief of Staff', currentOrganizationRaw: 'Accel', school: 'Rice University' }),
    // hidden people and other students' people are never suggested from
    person({ currentTitle: 'Hidden Title', location: 'Hidden Town', hiddenAt: '2026-11-01T00:00:00.000Z' }),
    person({ currentTitle: 'Someone Else Title', userId: 'u_other' }),
  ]);
});

describe('filter suggestions', () => {
  it('titles: the student’s own titles lead with how many people hold them, then the built-in ones', async () => {
    const got = await suggestFilter(USER, 'titles', '');
    expect(got.slice(0, 3)).toEqual([
      { value: 'Chief of Staff', sub: '2 people you know' },
      { value: 'Venture Partner', sub: '2 people you know' },
      { value: 'Product Manager', sub: '1 person you know' },
    ]);
    expect(got).toHaveLength(8);
    expect(got.map((s) => s.value)).toContain('Software Engineer');
    expect(got.map((s) => s.value)).not.toContain('Hidden Title');
    expect(got.map((s) => s.value)).not.toContain('Someone Else Title');
  });

  it('titles: typing narrows to matches, the start of the value before the start of a later word', async () => {
    // the student's own title before the built-in one
    expect(await values('titles', 'vent')).toEqual(['Venture Partner', 'Venture Capital Analyst']);
    const part = await values('titles', 'p');
    // "Product Manager" starts with it; "Venture Partner" only has a word that does
    expect(part.indexOf('Product Manager')).toBeLessThan(part.indexOf('Venture Partner'));
    expect(await values('titles', 'zzzz')).toEqual([]);
  });

  it('a value is offered once, whatever its capitals', async () => {
    await db.people.put(person({ currentTitle: 'product manager' }));
    forgetFilterSuggestions();
    const got = (await values('titles', 'product m')).filter((v) => v.toLowerCase() === 'product manager');
    expect(got).toHaveLength(1);
  });

  it('places: the student’s own places, then the common cities; "Open to anywhere" is not a place to search', async () => {
    const got = await suggestFilter(USER, 'places', '');
    expect(got[0]).toEqual({ value: 'Austin, Texas', sub: '2 people you know' });
    expect(got.map((s) => s.value)).toContain('San Francisco Bay Area');
    expect(await values('places', 'open')).toEqual([]);
    expect(await values('places', 'lon')).toEqual(['London']);
    expect(await values('places', 'hidden')).toEqual([]);
  });

  it('companies: before typing, where the student knows the most people; typing searches the network and the common ones', async () => {
    expect(await suggestFilter(USER, 'companies', '')).toEqual([
      { value: 'Accel', sub: '3 people you know there' },
      { value: 'Stripe', sub: '2 people you know there' },
    ]);
    const typed = await suggestFilter(USER, 'companies', 'str');
    expect(typed[0]!.value).toBe('Stripe');
    expect(typed[0]!.sub).toBe('2 people you know there');
    expect((await values('companies', 'goog'))[0]).toBe('Google');
  });

  it('schools: the schools the student’s people went to, then the full list once two letters are typed', async () => {
    expect(await suggestFilter(USER, 'schools', '')).toEqual([
      { value: 'Rice University', sub: '2 people you know' },
    ]);
    const typed = await values('schools', 'uc berkeley');
    expect(typed).toContain('University of California, Berkeley');
    const rice = await values('schools', 'rice');
    expect(rice[0]).toBe('Rice University');
    expect(rice.filter((v) => v === 'Rice University')).toHaveLength(1);
  });

  it('keywords: the kinds of work, by what is typed', async () => {
    expect((await values('keywords', '')).length).toBe(8);
    expect((await values('keywords', 'fin')).every((v) => /fin/i.test(v))).toBe(true);
    expect((await values('keywords', 'fin')).length).toBeGreaterThan(0);
  });
});
