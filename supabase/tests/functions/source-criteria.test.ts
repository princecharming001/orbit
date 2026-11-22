/**
 * The checks a people search may ask (POST /source/search `criteria`): read from the request as a short list of
 * sentences, each a must-have unless it says nice, and carried into the goal the search runs with.
 */
import { describe, expect, it } from 'vitest';
import { sourcingGoal } from '../../functions/_shared/sourcing/run.ts';
import { criteriaOf } from '../../functions/orbit-api/routes/source.ts';

const status = (f: () => unknown) => {
  try {
    f();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

describe('criteria on a search request', () => {
  it('none given is none asked', () => {
    expect(criteriaOf(undefined)).toBeUndefined();
    expect(criteriaOf(null)).toBeUndefined();
    expect(criteriaOf([])).toBeUndefined();
  });

  it('each is tidied, and is a must-have unless it says nice', () => {
    expect(
      criteriaOf([
        { text: '  Works at a   venture capital firm ' },
        { text: 'Invests at seed', need: 'nice' },
        { text: 'Based in London', need: 'must' },
        { text: '   ' },
      ]),
    ).toEqual([
      { text: 'Works at a venture capital firm', need: 'must' },
      { text: 'Invests at seed', need: 'nice' },
      { text: 'Based in London', need: 'must' },
    ]);
  });

  it('refuses what is not a short list of short sentences', () => {
    expect(status(() => criteriaOf('Works at a fund'))).toBe(400);
    expect(status(() => criteriaOf(Array.from({ length: 7 }, () => ({ text: 'x' }))))).toBe(400);
    expect(status(() => criteriaOf([{ text: 'x'.repeat(201) }]))).toBe(400);
    expect(status(() => criteriaOf([{ text: 5 }]))).toBe(400);
    expect(status(() => criteriaOf([{ text: 'x', need: 'maybe' }]))).toBe(400);
    expect(status(() => criteriaOf(['Works at a fund']))).toBe(400);
  });

  it('the goal carries them as checks, with people only, and neither when the request has none', () => {
    const g = sourcingGoal({
      purpose: 'fundraising',
      query: 'seed investors',
      criteria: [{ text: 'Works at a venture capital firm' }, { text: 'Invests at seed', need: 'nice' }],
      peopleOnly: true,
    });
    expect(g.checks).toEqual([
      { text: 'Works at a venture capital firm', need: 'must' },
      { text: 'Invests at seed', need: 'nice' },
    ]);
    expect(g.peopleOnly).toBe(true);
    const plain = sourcingGoal({ purpose: 'fundraising', query: 'seed investors' });
    expect(plain.checks).toBeUndefined();
    expect(plain.peopleOnly).toBeUndefined();
  });

  it('titles, places, seniority and keywords from the filters reach the goal', () => {
    const g = sourcingGoal({
      purpose: 'advice',
      query: 'investors in London',
      filters: {
        titles: ['partner', 'principal'],
        locations: ['London', 'Berlin'],
        seniority: ['director'],
        keywords: ['seed'],
        organizations: ['Accel'],
        schools: ['LSE'],
      },
    });
    expect(g.roles).toEqual(['partner', 'principal']);
    expect(g.location).toBe('London');
    expect(g.seniorities).toEqual(['director']);
    expect(g.keywords).toEqual(['seed']);
    expect(g.orgs).toEqual(['Accel']);
    expect(g.school).toBe('LSE');
  });
});
