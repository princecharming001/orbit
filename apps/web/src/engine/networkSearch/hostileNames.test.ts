/**
 * A person's company, title, school or place can be any word at all, including the names every JavaScript object
 * already has ("Constructor" is a real company). One such person used to crash the whole search of a network: a
 * lookup table answered with a built-in function instead of "not here". Every field is tried with every such name.
 */
import type { Person } from '@orbit/core';
import { normalizeCompany } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { EMPTY_FILTERS, ruleForm, runPeopleSearch, type SearchForm } from '../peopleSearch';
import { runNetworkSearch } from './index';

const BUILT_IN = [
  'constructor',
  'Constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
  '__defineGetter__',
  '__lookupGetter__',
  'prototype',
  'length',
  'name',
];
const USER = { id: 'u_hostile', school: 'University of California, Berkeley' };
const FIELDS = ['currentOrganizationRaw', 'currentTitle', 'headline', 'location', 'school'] as const;

beforeAll(async () => {
  await wipeDatabase();
  const at = '2026-11-20T12:00:00.000Z';
  const rows: Person[] = [];
  let n = 0;
  for (const word of BUILT_IN)
    for (const field of FIELDS) {
      n++;
      rows.push({
        id: `p_${n}`,
        userId: USER.id,
        displayName: `${word} Person${n}`,
        firstName: word,
        lastName: `Person${n}`,
        nameNormalized: `${word.toLowerCase()} person${n}`,
        emails: [],
        relationshipType: 'unknown',
        strength: 0.2,
        interactionCount: 0,
        sources: ['linkedin'],
        isHuman: true,
        tags: [],
        createdAt: at,
        updatedAt: at,
        [field]: field === 'headline' ? `Engineer at ${word}` : word,
      } as unknown as Person);
    }
  // and one ordinary investor, who must still be found among them
  rows.push({
    id: 'p_real',
    userId: USER.id,
    displayName: 'Ivy Chen',
    firstName: 'Ivy',
    lastName: 'Chen',
    nameNormalized: 'ivy chen',
    emails: [],
    relationshipType: 'unknown',
    strength: 0.5,
    interactionCount: 2,
    sources: ['linkedin'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
    currentTitle: 'Investor',
    currentOrganizationRaw: 'Constructor Capital',
    headline: 'Investor at Constructor Capital',
  } as unknown as Person);
  await db.people.bulkPut(rows);
});

describe('a network with built-in names in it', () => {
  it('a company called Constructor is a company, not a function', () => {
    for (const word of BUILT_IN) expect(typeof normalizeCompany(word)).toBe('string');
    expect(normalizeCompany('Constructor')).toBe('constructor');
    expect(normalizeCompany('Constructor, Inc.')).toBe('constructor');
  });

  it('the search runs and still finds the investor', async () => {
    const r = await runPeopleSearch(USER, ruleForm('investors'));
    expect(r.notes).not.toContain('Orbit could not search your own network just now.');
    expect(r.rows.map((x) => x.name)).toContain('Ivy Chen');
  });

  it('each built-in name as a company, a title, a school, a place and a keyword: the search answers', async () => {
    for (const word of BUILT_IN) {
      const forms: SearchForm[] = [
        { ask: word, filters: { ...EMPTY_FILTERS, currentCompanies: [word] }, criteria: [] },
        { ask: word, filters: { ...EMPTY_FILTERS, companies: [word] }, criteria: [] },
        { ask: word, filters: { ...EMPTY_FILTERS, titles: [word] }, criteria: [] },
        { ask: word, filters: { ...EMPTY_FILTERS, schools: [word] }, criteria: [] },
        { ask: word, filters: { ...EMPTY_FILTERS, places: [word] }, criteria: [] },
        { ask: word, filters: { ...EMPTY_FILTERS, keywords: [word] }, criteria: [] },
        ruleForm(`people at ${word}`),
        ruleForm(`${word} engineers in ${word}`),
      ];
      for (const form of forms) {
        const r = await runPeopleSearch(USER, form);
        expect([word, r.notes.includes('Orbit could not search your own network just now.')]).toEqual([
          word,
          false,
        ]);
      }
    }
  });

  it('the engine itself never throws on them', async () => {
    for (const word of BUILT_IN) {
      const out = await runNetworkSearch(
        USER,
        { ask: word, positions: [{ company: { names: [word] }, when: 'ever' }], keywords: { terms: [word] } },
        { caller: 'ui' },
      );
      expect(out).toBeDefined();
    }
  });
});
