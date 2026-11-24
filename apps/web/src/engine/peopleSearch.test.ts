/**
 * People search's form (the Find people table): the filters and criteria the two dialogs edit map onto the engine's
 * spec and back without losing anything, a sentence is read by rules when no model can be reached, the match of a row
 * is the confirmed share of what was asked, and one run joins the student's own people with people found outside.
 */
import type { SourcedCandidate } from '@orbit/core';
import type { QuerySpec, Row } from '@orbit/core/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ runNetworkSearch: vi.fn(), worldOfSet: vi.fn() }));
const src = vi.hoisted(() => ({ searchPeople: vi.fn() }));
const llm = vi.hoisted(() => ({ reachable: false, judge: vi.fn() }));
const api = vi.hoisted(() => ({ server: true }));
vi.mock('./networkSearch', () => net);
vi.mock('./sourcing', async (orig) => ({ ...(await orig<typeof import('./sourcing')>()), ...src }));
vi.mock('../integrations/anthropic', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic')>()),
  claudeReachable: () => llm.reachable,
  llmSearchJudge: llm.judge,
}));
vi.mock('../integrations/orbitApi', async (orig) => ({
  ...(await orig<typeof import('../integrations/orbitApi')>()),
  isServerUser: () => api.server,
}));
vi.mock('./goals', async (orig) => ({
  ...(await orig<typeof import('./goals')>()),
  activeGoals: async () => [],
}));

import { normalizeCompany } from '@orbit/core';
import { db } from '../db/schema';
import {
  barsOfScore,
  compareRows,
  countFilters,
  EMPTY_FILTERS,
  extraWords,
  type FilterForm,
  formIsEmpty,
  formOf,
  INTERPRET_SYSTEM,
  interpretAsk,
  matchOfChecks,
  matchOfSourced,
  newCriterion,
  outsideFilters,
  pathOfSourced,
  purposeOf,
  type ResultRow,
  restatesJob,
  resultsCsv,
  ruleForm,
  runPeopleSearch,
  type SearchForm,
  specOf,
  tidyForm,
  tidyReading,
} from './peopleSearch';

const form = (filters: Partial<FilterForm> = {}, criteria: [string, 'must' | 'nice'][] = []): SearchForm => ({
  ask: 'seed investors in London',
  filters: { ...EMPTY_FILTERS, ...filters },
  criteria: criteria.map(([t, n]) => newCriterion(t, n)),
});

beforeEach(() => {
  llm.reachable = false;
  api.server = true;
});
afterEach(() => vi.clearAllMocks());

describe('the form as a spec', () => {
  it('titles, groups and seniority are one current job; a current company is the same job', () => {
    const spec = specOf(
      form({
        titles: ['partner', 'principal'],
        families: ['investing'],
        seniority: ['vp'],
        currentCompanies: ['Accel'],
      }),
    );
    expect(spec.positions).toEqual([
      {
        role: { titles: ['partner', 'principal'], families: ['investing'], seniority: ['vp'] },
        company: { names: ['Accel'] },
        when: 'current',
      },
    ]);
  });

  it('nice to have is written on the block, must have is the default and is not', () => {
    const spec = specOf(
      form({
        titles: ['investor'],
        roleNeed: 'nice',
        places: ['London'],
        placesNeed: 'nice',
        companies: ['Google'],
        companiesNeed: 'nice',
        keywords: ['seed'],
        keywordsNeed: 'nice',
      }),
    );
    expect(spec.positions).toEqual([
      { role: { titles: ['investor'] }, when: 'current', need: 'nice' },
      { company: { names: ['Google'] }, when: 'ever', need: 'nice' },
    ]);
    expect(spec.places).toEqual([{ names: ['London'], need: 'nice' }]);
    expect(spec.keywords).toEqual({ terms: ['seed'], need: 'nice' });
    const must = specOf(form({ titles: ['investor'], places: ['London'], keywords: ['seed'] }));
    expect(JSON.stringify(must)).not.toContain('need');
  });

  it('a current company alone is a job at that company; schools, places, keywords and criteria follow', () => {
    const spec = specOf(
      form({ currentCompanies: ['Stripe'], schools: ['Berkeley'], places: ['SF'], keywords: ['payments'] }, [
        ['Works on risk', 'must'],
        ['Has hired interns', 'nice'],
      ]),
    );
    expect(spec.positions).toEqual([{ company: { names: ['Stripe'] }, when: 'current' }]);
    expect(spec.schools).toEqual([{ names: ['Berkeley'] }]);
    expect(spec.places).toEqual([{ names: ['SF'] }]);
    expect(spec.criteria).toEqual([
      { text: 'Works on risk', need: 'must' },
      { text: 'Has hired interns', need: 'nice' },
    ]);
  });

  it('an empty form asks nothing; who to search alone asks nothing either', () => {
    expect(formIsEmpty(form())).toBe(true);
    expect(formIsEmpty(form({ reach: 'mine' }))).toBe(true);
    expect(formIsEmpty(form({ keywords: ['seed'] }))).toBe(false);
    expect(formIsEmpty(form({}, [['Works at a fund', 'must']]))).toBe(false);
    expect(specOf(form())).toEqual({ ask: 'seed investors in London' });
  });

  it('round trip: what the dialogs can show comes back the same', () => {
    const f = form(
      {
        titles: ['partner'],
        families: ['investing'],
        seniority: ['director_head'],
        roleNeed: 'nice',
        places: ['London', 'Paris'],
        currentCompanies: ['Accel'],
        companies: ['Google', 'Meta'],
        companiesNeed: 'nice',
        schools: ['LSE'],
        keywords: ['seed', 'climate'],
        keywordsNeed: 'nice',
      },
      [
        ['Works at a venture capital firm', 'must'],
        ['Invests at seed', 'nice'],
      ],
    );
    const back = formOf(specOf(f));
    expect(back.filters).toEqual(f.filters);
    expect(back.criteria.map((c) => [c.text, c.need])).toEqual(f.criteria.map((c) => [c.text, c.need]));
    expect(back.extra).toBeUndefined();
  });

  it('what the form has no field for is kept as read, said in words, and survives the trip', () => {
    const spec: QuerySpec = {
      ask: 'YC W26 founders I have not talked to, not at Google',
      positions: [
        { role: { founder: true }, company: { yc: { batches: ['W26'] } }, when: 'ever' },
        { company: { names: ['Google'] }, negate: true },
      ],
      relationship: { everTalked: false },
    };
    const f = formOf(spec);
    expect(f.filters).toEqual(EMPTY_FILTERS);
    expect(extraWords(f)).toEqual(['founders at YC W26', 'not Google', 'never talked']);
    expect(formIsEmpty(f)).toBe(false);
    const again = specOf(f);
    expect(again.positions).toEqual(spec.positions);
    expect(again.relationship).toEqual(spec.relationship);
  });

  it('a second job block with a role is kept as read, never merged into the first', () => {
    const spec: QuerySpec = {
      ask: 'x',
      positions: [
        { role: { families: ['product'] }, company: { names: ['Stripe'] } },
        { role: { families: ['engineering'] }, when: 'past' },
      ],
    };
    const f = formOf(spec);
    expect(f.filters.families).toEqual(['product']);
    expect(f.filters.currentCompanies).toEqual(['Stripe']);
    expect(f.extra?.positions).toEqual([{ role: { families: ['engineering'] }, when: 'past' }]);
    expect(specOf(f).positions).toHaveLength(2);
  });
});

describe('tidying and counting', () => {
  it('trims, drops doubles whatever the case, drops empty criteria, and keeps six criteria at most', () => {
    const t = tidyForm({
      ask: '  seed   investors ',
      filters: {
        ...EMPTY_FILTERS,
        titles: [' Partner ', 'partner', '', 'Principal'],
        keywords: ['seed', 'Seed'],
      },
      criteria: [...Array.from({ length: 8 }, (_, i) => newCriterion(`c ${i}`)), newCriterion('   ')],
    });
    expect(t.ask).toBe('seed investors');
    expect(t.filters.titles).toEqual(['Partner', 'Principal']);
    expect(t.filters.keywords).toEqual(['seed']);
    expect(t.criteria).toHaveLength(6);
  });

  it('counts groups that are set, titles and title groups as one', () => {
    expect(countFilters(EMPTY_FILTERS)).toBe(0);
    expect(countFilters({ ...EMPTY_FILTERS, titles: ['a'], families: ['investing'] })).toBe(1);
    expect(
      countFilters({
        ...EMPTY_FILTERS,
        titles: ['a'],
        seniority: ['vp'],
        places: ['x'],
        currentCompanies: ['y'],
        companies: ['z'],
        schools: ['s'],
        keywords: ['k'],
        reach: 'mine',
      }),
    ).toBe(8);
  });
});

describe('reading a sentence without a model', () => {
  it('investors are the investing group; a place and a company are read', () => {
    const f = ruleForm('investors at Sequoia in London');
    expect(f.filters.families).toEqual(['investing']);
    expect(f.filters.currentCompanies).toEqual(['Sequoia']);
    expect(f.filters.places).toEqual(['London']);
    expect(f.filters.reach).toBe('everyone');
    expect(f.criteria).toEqual([]);
  });

  it('"in my network" searches only the people the student has', () => {
    expect(ruleForm('engineers I know at Stripe').filters.reach).toBe('mine');
    expect(ruleForm('engineers at Stripe').filters.reach).toBe('everyone');
  });

  it('a sentence the rules cannot read becomes its own words, never an empty search', () => {
    const f = ruleForm('graph neural networks');
    expect(f.filters.keywords).toEqual(['graph neural networks']);
    expect(formIsEmpty(f)).toBe(false);
  });

  it('without a model the rules read it, and say so', async () => {
    const r = await interpretAsk('product managers at Stripe');
    expect(r.by).toBe('rules');
    expect(r.form.filters.families).toEqual(['product']);
    expect(llm.judge).not.toHaveBeenCalled();
  });
});

describe('reading a sentence with the model', () => {
  const answer = {
    titles: ['Investor', 'partner', 'principal'],
    seniority: [],
    currentCompanies: [],
    everCompanies: [],
    schools: [],
    places: ['London'],
    keywords: ['seed', 'venture capital'],
    keywordsNeed: 'nice',
    criteria: [
      { text: 'Works at a venture capital firm', need: 'must' },
      { text: 'Invests at seed stage', need: 'nice' },
    ],
    mineOnly: false,
  };

  it('titles, keywords and criteria come from the model; the group the rules know is kept beside them', async () => {
    llm.reachable = true;
    llm.judge.mockResolvedValue(answer);
    const r = await interpretAsk('seed investors in London');
    expect(r.by).toBe('model');
    expect(r.form.filters.titles).toEqual(['investor', 'partner', 'principal']);
    expect(r.form.filters.families).toEqual(['investing']);
    expect(r.form.filters.places).toEqual(['London']);
    // "venture capital" beside the job "investor" says the job again: not a topic to rank by
    expect(r.form.filters.keywords).toEqual(['seed']);
    expect(r.form.filters.keywordsNeed).toBe('nice');
    // "Works at a venture capital firm" only says the job again, which the titles already hold: it is left out
    expect(r.form.criteria.map((c) => [c.text, c.need])).toEqual([['Invests at seed stage', 'nice']]);
    // the sentence goes to the model wrapped as data
    const build = llm.judge.mock.calls[0]![1] as (w: (s: string, t: string) => string) => string;
    expect(build((s, t) => `<${s}>${t}</${s}>`)).toBe('<sentence>seed investors in London</sentence>');
  });

  const reading = (over: Record<string, unknown>) => ({
    titles: [],
    seniority: [],
    currentCompanies: [],
    everCompanies: [],
    schools: [],
    places: [],
    keywords: [],
    keywordsNeed: 'nice',
    criteria: [],
    mineOnly: false,
    ...over,
  });

  it('a filter leaves people out, so the reading keeps only the filters the sentence asked for', async () => {
    llm.reachable = true;
    // a job they left is not the job they hold: no title is made of it
    llm.judge.mockResolvedValueOnce(
      reading({
        titles: ['consultant'],
        everCompanies: ['McKinsey'],
        keywords: ['startups', 'McKinsey'],
        criteria: [{ text: 'Works at a startup now', need: 'must' }],
      }),
    );
    const mck = (await interpretAsk('ex-McKinsey people now at startups')).form.filters;
    expect(mck.titles).toEqual([]);
    expect(mck.companies).toEqual(['McKinsey']);
    // a keyword is a topic, never a company another field already holds
    expect(mck.keywords).toEqual(['startups']);

    // a company is where they work now or where they worked, not both
    llm.judge.mockResolvedValueOnce(
      reading({
        titles: ['software engineer'],
        currentCompanies: ['Stripe'],
        everCompanies: ['stripe', 'Plaid'],
        keywords: ['Stripe', 'software engineer', 'payments'],
      }),
    );
    const stripe = (await interpretAsk('software engineers at Stripe')).form.filters;
    expect(stripe.currentCompanies).toEqual(['Stripe']);
    expect(stripe.companies).toEqual(['Plaid']);
    expect(stripe.keywords).toEqual(['payments']);

    // a level is kept only when the sentence says one: "partner" and "head of" are titles
    llm.judge.mockResolvedValueOnce(
      reading({
        titles: ['partner'],
        seniority: ['senior', 'director_head', 'vp', 'c_level'],
        currentCompanies: ['Sequoia'],
      }),
    );
    expect((await interpretAsk('partners at Sequoia')).form.filters.seniority).toEqual([]);
    llm.judge.mockResolvedValueOnce(reading({ titles: ['head of growth'], seniority: ['c_level'] }));
    const growth = (await interpretAsk('heads of growth at consumer startups')).form.filters;
    expect(growth.titles).toEqual(['head of growth']);
    expect(growth.seniority).toEqual([]);
    llm.judge.mockResolvedValueOnce(
      reading({ titles: ['vp of engineering'], seniority: ['vp'], places: ['NYC'] }),
    );
    expect((await interpretAsk('VPs of engineering in NYC')).form.filters.seniority).toEqual(['vp']);
    // a level said about a job they left is not a level of the job they hold
    llm.judge.mockResolvedValueOnce(
      reading({ titles: ['founder'], seniority: ['senior'], everCompanies: ['Google'] }),
    );
    const ex = (await interpretAsk('senior engineers who used to be at Google and are now founders')).form
      .filters;
    expect(ex.seniority).toEqual([]);
    expect(ex.titles).toEqual(['founder']);

    // a title the sentence does not name is not made up; one it names by another form of the word is kept
    llm.judge.mockResolvedValueOnce(
      reading({ titles: ['investor'], schools: ['Berkeley'], keywords: ['venture capital'] }),
    );
    expect((await interpretAsk('Berkeley alumni working in venture capital')).form.filters.titles).toEqual(
      [],
    );
    llm.judge.mockResolvedValueOnce(
      reading({ titles: ['phd student', 'chief of staff'], schools: ['Stanford'] }),
    );
    expect((await interpretAsk('Stanford PhDs who are chiefs of staff')).form.filters.titles).toEqual([
      'phd student',
      'chief of staff',
    ]);

    // the sentence itself is never a keyword
    llm.judge.mockResolvedValueOnce(reading({ keywords: ['people who know batteries', 'batteries'] }));
    expect((await interpretAsk('people who know batteries')).form.filters.keywords).toEqual(['batteries']);
  });

  it('a kind within the kind of work stays that kind: angels are not every investor', () => {
    const base = { seniority: [], currentCompanies: [], everCompanies: [], schools: [], places: [] };
    const angels = tidyReading(
      {
        ...base,
        titles: ['angel investor', 'investor'],
        keywords: ['angel investing', 'early-stage startups'],
      },
      'angel investors',
      true,
    );
    expect(angels.titles).toEqual(['angel investor']);
    // the title in another form is not a topic
    expect(angels.keywords).toEqual(['early-stage startups']);
    const scouts = tidyReading(
      { ...base, titles: ['venture scout', 'scout', 'investor'], keywords: [] },
      'VC scouts',
      true,
    );
    expect(scouts.titles).toEqual(['venture scout', 'scout']);
    // nothing narrower said: every wording of the job is kept
    const all = tidyReading(
      { ...base, titles: ['investor', 'partner', 'angel investor'], keywords: [] },
      'investors',
      true,
    );
    expect(all.titles).toEqual(['investor', 'partner', 'angel investor']);
  });

  it('the reading is told what a filter costs, and that a job they left is not a title', () => {
    expect(INTERPRET_SYSTEM).toContain('Filters are hard');
    expect(INTERPRET_SYSTEM).toContain('Never the same company in both');
    expect(INTERPRET_SYSTEM).not.toMatch(/[—!]/);
    expect(tidyReading(reading({ titles: ['Investor'] }) as never, 'investors', true).titles).toEqual([
      'investor',
    ]);
  });

  it('a model that fails, answers nothing, or returns an empty reading falls back to the rules', async () => {
    llm.reachable = true;
    llm.judge.mockRejectedValueOnce(new Error('down'));
    expect((await interpretAsk('investors in London')).by).toBe('rules');
    llm.judge.mockResolvedValueOnce(undefined);
    expect((await interpretAsk('investors in London')).by).toBe('rules');
    llm.judge.mockResolvedValueOnce({ ...answer, titles: [], places: [], keywords: [], criteria: [] });
    const r = await interpretAsk('investors in London');
    expect(r.by).toBe('rules');
    expect(r.form.filters.families).toEqual(['investing']);
  });
});

describe('a criterion that only says the job again is left out', () => {
  it('the same job in other words is dropped; anything it adds is kept', () => {
    for (const [text, titles, families] of [
      ['Invests in startups or funds', ['investor'], ['investing']],
      ['Invests in startups', ['investor'], ['investing']],
      ['Works as an investor at a venture capital firm', ['investor', 'partner'], ['investing']],
      ['Invests in startups as a venture capitalist', ['venture capitalist', 'vc'], ['investing']],
      ['Works as a product manager', ['product manager'], ['product']],
      ['Is a founder', ['founder'], ['founder']],
      ['Founded a company', ['founder'], ['founder']],
      ['Works as a recruiter', ['recruiter'], ['people_recruiting']],
    ] as const)
      expect([text, restatesJob(text, [...titles], [...families])]).toEqual([text, true]);
    for (const [text, titles, families] of [
      ['Invests at seed stage', ['investor'], ['investing']],
      ['Invests in AI startups', ['investor'], ['investing']],
      ['Invests personal capital in early-stage startups', ['angel investor'], ['investing']],
      ['Founded a company that went through Y Combinator', ['founder'], ['founder']],
      ['Works on climate', ['investor'], ['investing']],
      ['Was early at Airbnb', ['angel investor'], ['investing']],
      ['Works at a venture capital firm', [], []],
    ] as const)
      expect([text, restatesJob(text, [...titles], [...families])]).toEqual([text, false]);
  });
});

describe('the match', () => {
  const k = (need: 'must' | 'nice', answer: 'yes' | 'likely' | 'unknown' | 'no') => ({ need, answer });
  it("one of the student's own: a must-have counts double, nothing asked is a full match", () => {
    expect(matchOfChecks([])).toBe(100);
    expect(matchOfChecks([k('must', 'yes'), k('must', 'yes')])).toBe(100);
    // a nice-to-have they do not meet tips the match, it does not sink it
    expect(matchOfChecks([k('must', 'yes'), k('nice', 'no')])).toBe(86);
    expect(matchOfChecks([k('must', 'yes'), k('nice', 'yes')])).toBe(100);
    // a confirmed must-have outweighs a nice-to-have met by someone whose must-have is only likely
    expect(matchOfChecks([k('must', 'yes'), k('must', 'yes'), k('nice', 'no')])).toBeGreaterThan(
      matchOfChecks([k('must', 'yes'), k('must', 'likely'), k('nice', 'yes')]),
    );
    expect(matchOfChecks([k('must', 'no'), k('nice', 'yes')])).toBe(20);
    expect(matchOfChecks([k('must', 'likely')])).toBe(80);
    expect(matchOfChecks([k('must', 'unknown')])).toBe(40);
  });

  it('someone found outside: the confirmed share, tempered by the fit; the fit alone when nothing was asked', () => {
    expect(matchOfSourced({ fit: 0.8 })).toBe(80);
    const c = (answer: 'yes' | 'no' | 'unknown') => [{ text: 't', need: 'must' as const, answer }];
    expect(matchOfSourced({ fit: 1, checks: c('yes') })).toBe(100);
    expect(matchOfSourced({ fit: 0.6, checks: c('yes') })).toBe(90);
    expect(matchOfSourced({ fit: 0.6, checks: c('unknown') })).toBe(45);
    expect(matchOfSourced({ fit: 7, checks: c('yes') })).toBe(100);
  });
});

describe('what goes to the outside search', () => {
  it('title groups go as their words, both kinds of company as organizations, seniority in its words', () => {
    const f = form({
      titles: ['partner'],
      families: ['investing'],
      seniority: ['vp', 'c_level', 'mid'],
      currentCompanies: ['Accel'],
      companies: ['Google'],
      places: ['London'],
      schools: ['LSE'],
      keywords: ['seed'],
    });
    expect(outsideFilters(f)).toEqual({
      // a title the search names is the one asked: the group's other words are not added to it
      titles: ['partner'],
      organizations: ['Accel', 'Google'],
      // where they work now and where they ever worked are different questions
      currentOrganizations: ['Accel'],
      everOrganizations: ['Google'],
      locations: ['London'],
      schools: ['LSE'],
      keywords: ['seed'],
      seniority: ['vp', 'c_suite'],
      needs: { role: 'must', locations: 'must', everOrganizations: 'must', keywords: 'must' },
    });
    // only a kind of work, no title: its usual titles stand in
    expect(outsideFilters(form({ families: ['investing'] })).titles).toEqual([
      'investor',
      'partner',
      'principal',
    ]);
    // what the student marked as nice to have only ranks on the server too
    const nice = outsideFilters({
      ...f,
      filters: {
        ...f.filters,
        roleNeed: 'nice',
        placesNeed: 'nice',
        companiesNeed: 'nice',
        keywordsNeed: 'nice',
      },
    });
    expect(nice.needs).toEqual({
      role: 'nice',
      locations: 'nice',
      everOrganizations: 'nice',
      keywords: 'nice',
    });
  });

  it('the way in to someone found outside: a person to ask first, then LinkedIn, then what is shared', () => {
    const c = (over: Partial<SourcedCandidate>) =>
      ({
        id: 'x',
        name: 'Nia Out',
        fit: 0.9,
        reach: 0,
        responsiveness: 0.5,
        rank: 0.5,
        reasons: [],
        source: 'exa',
        ...over,
      }) as SourcedCandidate;
    expect(pathOfSourced(c({ knownPersonId: 'p1', tier: 1 }))).toEqual({
      kind: 'direct',
      label: 'You know them',
      level: 3,
    });
    // a close contact at their company: the bars say how close the student is to that contact
    expect(
      pathOfSourced(
        c({
          bridge: { personId: 'p9', name: 'Sam Warm', score: 84 },
          why: 'Sam is close to you and also at Rho',
        }),
      ),
    ).toEqual({
      kind: 'intro',
      label: 'Sam Warm',
      personId: 'p9',
      level: 4,
      note: 'Sam is close to you and also at Rho',
    });
    expect(pathOfSourced(c({ bridge: { personId: 'p9', name: 'Sam Warm', score: 45 } }))).toMatchObject({
      level: 2,
    });
    // a connection never talked to is still a person to ask: one bar
    expect(
      pathOfSourced(
        c({
          bridge: { personId: 'p8', name: 'Wren Abara', score: 9 },
          bridgeWeak: true,
          why: 'Wren, a connection of yours, works at Nexus',
          degree: 2,
        }),
      ),
    ).toEqual({
      kind: 'intro',
      label: 'Wren Abara',
      personId: 'p8',
      level: 1,
      note: 'Wren, a connection of yours, works at Nexus',
    });
    expect(pathOfSourced(c({ degree: 2 }))).toMatchObject({ kind: 'second', label: '2nd degree', level: 1 });
    expect(pathOfSourced(c({ tier: 3, why: 'Also from UC Berkeley' }))).toEqual({
      kind: 'shared',
      label: 'Also from UC Berkeley',
      level: 1,
      note: 'Also from UC Berkeley',
    });
    // an open door or a cold match is no way in
    expect(pathOfSourced(c({ tier: 4, why: 'Their page invites students to reach out' }))).toBeUndefined();
    expect(pathOfSourced(c({ degree: 3 }))).toBeUndefined();
    expect(barsOfScore(undefined)).toBe(1);
    expect([19, 40, 60, 80].map(barsOfScore)).toEqual([1, 2, 3, 4]);
  });

  it('the list: the match in steps of ten, then the student’s own, then the warmer way in, then the finer match', () => {
    const r = (name: string, match: number, level?: number, own = false) =>
      ({
        key: name,
        name,
        match,
        checks: [],
        ...(own ? { personId: name } : {}),
        ...(level === undefined ? {} : { path: { kind: 'intro', label: 'x', level } }),
      }) as ResultRow;
    const sorted = [
      r('cold 97', 97),
      r('warm 95', 95, 3),
      r('weak 96', 96, 1),
      r('own 93', 93, 1, true),
      r('warm 72', 72, 4),
      r('cold 84', 84),
    ]
      .sort(compareRows)
      .map((x) => x.name);
    // 93 to 97 match the same: the student's own, then the warmest way in, lead
    expect(sorted).toEqual(['own 93', 'warm 95', 'weak 96', 'cold 97', 'cold 84', 'warm 72']);
  });

  it('investors mean fundraising, co-founders mean a co-founder search, anything else is advice with no goal', async () => {
    expect(await purposeOf('u1', form({ families: ['investing'] }))).toEqual({ purpose: 'fundraising' });
    expect(await purposeOf('u1', { ...form(), ask: 'a technical cofounder' })).toEqual({
      purpose: 'cofounder',
    });
    expect(await purposeOf('u1', { ...form(), ask: 'designers' })).toEqual({ purpose: 'advice' });
  });
});

describe('one run: the network and beyond, as one list', () => {
  const row = (id: string, name: string, band: Row['band'], checks: Row['checks']): Row =>
    ({ id, name, band, checks, evidenceRank: 0, niceScore: 0, lexical: 0, warmth: 0 }) as Row;
  const check = (
    key: string,
    answer: 'yes' | 'likely' | 'unknown' | 'no',
    need: 'must' | 'nice' = 'must',
  ) => ({
    key,
    label: key,
    need,
    answer,
    evidence: answer === 'yes' ? 'Partner at Accel' : undefined,
  });
  const sourced = (over: Partial<SourcedCandidate>): SourcedCandidate =>
    ({
      id: 'r1',
      name: 'Nia Out',
      title: 'Principal',
      org: 'Balderton',
      fit: 0.9,
      reach: 0,
      responsiveness: 0.5,
      rank: 0.5,
      reasons: ['fits'],
      source: 'unipile',
      emailStatus: 'not looked up',
      ...over,
    }) as SourcedCandidate;
  const people = new Map([
    [
      'p1',
      { id: 'p1', currentTitle: 'Partner', currentOrganizationRaw: 'Accel', linkedinUrl: 'https://li/p1' },
    ],
    ['p2', { id: 'p2', headline: 'Investing in climate' }],
  ]);
  const world = {
    people,
    ctx: {
      rel: (id: string) =>
        id === 'p1'
          ? { band: 'strong', touches: {}, tags: [] }
          : { band: 'faint', touches: {}, tags: [], mutualFriends: ['Henry Allen'] },
    },
  };
  const asked = form({ families: ['investing'] }, [['Works at a venture capital firm', 'must']]);

  function network(rows: Row[], over: Record<string, unknown> = {}) {
    net.worldOfSet.mockReturnValue(world);
    net.runNetworkSearch.mockResolvedValue({
      ok: true,
      set: { id: 'rs1', result: { rows }, notes: [], judgeUnavailable: false, ...over },
      rows: [],
      remaining: 0,
    });
  }

  it('someone found outside: the headline as a second line, a filter counted in the match and never a column', async () => {
    network([]);
    src.searchPeople.mockResolvedValue({
      ok: true,
      value: {
        batchId: 'b',
        relaxed: [],
        unconfigured: [],
        results: [
          sourced({
            id: 'r1',
            headline: 'Seed investor. First cheques into developer tools.',
            fit: 1,
            checks: [
              { text: 'Their current job is investor', need: 'must', answer: 'yes', filter: 'role' },
              { text: 'Is based in or around London', need: 'must', answer: 'unknown', filter: 'place' },
              { text: 'Works at a venture capital firm', need: 'must', answer: 'yes' },
            ],
            bridge: { personId: 'p9', name: 'Sam Warm', score: 70 },
            why: 'Sam is close to you and also at Balderton, so ask for an intro',
          }),
          // a headline that only repeats the title and company is not said twice
          sourced({ id: 'r2', name: 'Bo Same', headline: 'Principal at Balderton', fit: 0.5 }),
          // nothing but a headline: it stands where the title would
          sourced({
            id: 'r3',
            name: 'Cy Bare',
            title: undefined,
            org: undefined,
            headline: 'Building things',
            fit: 0.5,
          }),
        ],
      },
    });
    const r = await runPeopleSearch({ id: 'u1', school: '' }, asked);
    const by = (name: string) => r.rows.find((x) => x.name === name)!;
    expect(by('Nia Out')).toMatchObject({
      title: 'Principal',
      company: 'Balderton',
      headline: 'Seed investor. First cheques into developer tools.',
      path: {
        kind: 'intro',
        label: 'Sam Warm',
        level: 3,
        note: 'Sam is close to you and also at Balderton, so ask for an intro',
      },
    });
    // one column: the student's own criterion; the place nobody could confirm lowers the match
    expect(by('Nia Out').checks).toEqual([{ id: asked.criteria[0]!.id, answer: 'yes' }]);
    expect(by('Nia Out').match).toBe(85);
    expect(by('Bo Same').headline).toBeUndefined();
    expect(by('Cy Bare')).toMatchObject({ title: 'Building things' });
    expect(by('Cy Bare').headline).toBeUndefined();
  });

  it('a source today’s allowance ran out for is said, so a short list is not read as nobody else fitting', async () => {
    network([]);
    src.searchPeople.mockResolvedValue({
      ok: true,
      value: { batchId: 'b', relaxed: [], unconfigured: [], results: [], limits: ['web', 'linkedin'] },
    });
    const r = await runPeopleSearch({ id: 'u1', school: '' }, asked);
    expect(r.notes).toEqual([
      'You have used today’s searches outside your network, so this list is your own people and what was already found. It resets tomorrow.',
      'You have used today’s LinkedIn searches, so people one connection away are not listed. It resets tomorrow.',
    ]);
    for (const n of r.notes) expect(n).not.toMatch(/[—!]/);
  });

  it('a search for a job never lists someone with no sign of that job, whatever else about them fits', async () => {
    const people2 = new Map([
      ['a', { id: 'a', currentTitle: 'Investor', currentOrganizationRaw: 'Anfa' }],
      ['b', { id: 'b', currentTitle: 'Full Stack Developer', location: 'San Francisco' }],
      ['c', { id: 'c', currentTitle: 'HR Generalist' }],
      ['d', { id: 'd', currentTitle: 'Investor', currentOrganizationRaw: 'Pareto' }],
    ]);
    net.worldOfSet.mockReturnValue({ ...world, people: people2 });
    net.runNetworkSearch.mockResolvedValue({
      ok: true,
      set: {
        id: 'rs1',
        notes: [],
        judgeUnavailable: false,
        result: {
          rows: [
            // an investor, the city not on file: listed, the place unknown
            row('a', 'Ada In', 'unchecked', [check('position:0', 'yes'), check('place:0', 'unknown')]),
            // in the city, no sign of investing: never listed
            {
              ...row('b', 'Bo Dev', 'unchecked', [check('position:0', 'unknown'), check('place:0', 'yes')]),
              signal: 'hint',
            },
            // a word in their headline looked like a clue ("Business Partner"): still no sign of the job
            { ...row('c', 'Cy Hr', 'unchecked', [check('position:0', 'unknown')]), signal: 'hint' },
            row('d', 'Di In', 'strong', [check('position:0', 'yes'), check('place:0', 'yes')]),
          ],
        },
      },
      rows: [],
      remaining: 0,
    });
    const r = await runPeopleSearch(
      { id: 'u1', school: '' },
      { ...asked, criteria: [], filters: { ...asked.filters, reach: 'mine' } },
    );
    expect(r.rows.map((x) => x.name)).toEqual(['Di In', 'Ada In']);
  });

  it('a likely is never a full match: the confirmed lead, whoever the student knows better', async () => {
    const people2 = new Map([
      [
        'a',
        {
          id: 'a',
          currentTitle: 'Startup Banking',
          currentOrganizationRaw: 'Rho',
          headline: 'Startup Banking @ Rho | VC Scout',
        },
      ],
      ['b', { id: 'b', currentTitle: 'Investor', currentOrganizationRaw: 'Anfa' }],
    ]);
    net.worldOfSet.mockReturnValue({
      people: people2,
      ctx: { rel: (id: string) => ({ band: id === 'a' ? 'close' : 'light', touches: {}, tags: [] }) },
    });
    net.runNetworkSearch.mockResolvedValue({
      ok: true,
      set: {
        id: 'rs1',
        notes: [],
        judgeUnavailable: false,
        result: {
          rows: [
            row('a', 'Al Scout', 'likely', [
              { ...check('position:0', 'likely'), role: { title: 'VC Scout', lead: false } },
            ]),
            row('b', 'Bea In', 'strong', [
              { ...check('position:0', 'yes'), role: { title: 'Investor', org: 'Anfa', lead: true } },
            ]),
          ],
        },
      },
      rows: [],
      remaining: 0,
    });
    const r = await runPeopleSearch(
      { id: 'u1', school: '' },
      { ...asked, criteria: [], filters: { ...asked.filters, reach: 'mine' } },
    );
    expect(r.rows.map((x) => [x.name, x.match])).toEqual([
      ['Bea In', 100],
      ['Al Scout', 80],
    ]);
    // the row says why it is here: the job that matched is its title, the headline stays underneath
    expect(r.rows[1]).toMatchObject({ title: 'VC Scout', company: undefined, lead: false });
    expect(r.rows[1]!.headline).toBe('Startup Banking @ Rho | VC Scout');
    expect(r.rows[0]).toMatchObject({ title: 'Investor', company: 'Anfa', lead: true });
  });

  describe('the student’s own criteria, when a reader was there to read people', () => {
    beforeEach(() => {
      llm.reachable = true;
      src.searchPeople.mockResolvedValue({
        ok: true,
        value: { batchId: 'b', relaxed: [], unconfigured: [], results: [] },
      });
    });
    afterEach(() => {
      llm.reachable = false;
    });
    const mine = { ...asked, filters: { ...asked.filters, reach: 'mine' as const } };
    const unread = { ...check('criterion:0', 'likely'), evidence: 'not checked yet', unread: true };
    const readYes = {
      ...check('criterion:0', 'likely'),
      evidence: '"Co-founder at PostHog"',
      source: 'judge',
    };

    it('"unicorn founders": a founder nobody read, and one the reader found nothing for, are not listed', async () => {
      network([
        row('p1', 'Ana Read', 'likely', [check('position:0', 'yes'), readYes]),
        row('p2', 'Ben Unread', 'likely', [check('position:0', 'yes'), unread]),
        row('p3', 'Cy Nothing', 'unchecked', [check('position:0', 'yes'), check('criterion:0', 'unknown')]),
        row('p4', 'Di No', 'no', [check('position:0', 'yes'), check('criterion:0', 'no')]),
        row('p5', 'Eve Other Job', 'unchecked', [
          check('position:0', 'unknown'),
          check('criterion:0', 'unknown'),
        ]),
      ]);
      const r = await runPeopleSearch({ id: 'u1', school: '' }, mine);
      expect(r.rows.map((x) => x.name)).toEqual(['Ana Read']);
      // a likely is never a full match, and the column carries the words it rests on
      expect(r.rows[0]!.match).toBeLessThanOrEqual(85);
      expect(r.rows[0]!.checks).toEqual([
        { id: asked.criteria[0]!.id, answer: 'likely', evidence: '"Co-founder at PostHog"' },
      ]);
      // the two who pass the filter and are held back for the criterion are counted; the no and the other job are not
      expect(r.notes).toEqual([
        '1 more of your people pass the filters, but nothing Orbit has on them says "Works at a venture capital firm". Make it a nice to have to list them too.',
        'Orbit has not read 1 more of your people against "Works at a venture capital firm" yet. Search again to read more of them.',
      ]);
      expect(r.unchecked).toBe(false);
      expect(net.runNetworkSearch.mock.calls[0]![2]).toMatchObject({ screen: true });
    });

    it('nobody confirmed: an empty table that says how many passed the filters', async () => {
      network([
        row('p2', 'Ben Unread', 'likely', [check('position:0', 'yes'), unread]),
        row('p3', 'Cy Nothing', 'unchecked', [check('position:0', 'yes'), check('criterion:0', 'unknown')]),
      ]);
      const r = await runPeopleSearch({ id: 'u1', school: '' }, mine);
      expect(r.rows).toEqual([]);
      expect(r.notes[0]).toMatch(/^1 of your people pass the filters, but nothing Orbit has on them says/);
      expect(r.notes[1]).toMatch(/^Orbit has not read 1 more of your people against/);
    });

    it('a nice-to-have nobody read is a dash that says so, never a thumb, and keeps the person listed', async () => {
      const nice = form({ families: ['investing'], reach: 'mine' }, [
        ['Works at a venture capital firm', 'nice'],
      ]);
      network([
        row('p1', 'Ana Own', 'strong', [
          check('position:0', 'yes'),
          { ...check('criterion:0', 'likely', 'nice'), unread: true },
        ]),
      ]);
      const r = await runPeopleSearch({ id: 'u1', school: '' }, nice);
      expect(r.rows.map((x) => x.name)).toEqual(['Ana Own']);
      expect(r.rows[0]!.checks).toEqual([
        { id: nice.criteria[0]!.id, answer: 'unknown', evidence: 'Not checked yet' },
      ]);
      expect(r.notes).toEqual([]);
    });
  });

  it('with no reader, a criterion nobody read is a dash too, and the filters decide who is listed', async () => {
    network(
      [
        row('p1', 'Ana Own', 'likely', [
          check('position:0', 'yes'),
          { ...check('criterion:0', 'likely'), unread: true },
        ]),
      ],
      { judgeUnavailable: true },
    );
    const r = await runPeopleSearch(
      { id: 'u1', school: '' },
      { ...asked, filters: { ...asked.filters, reach: 'mine' } },
    );
    expect(r.rows.map((x) => x.name)).toEqual(['Ana Own']);
    expect(r.rows[0]!.checks[0]).toMatchObject({ answer: 'unknown', evidence: 'Not checked yet' });
    expect(r.unchecked).toBe(true);
  });

  it('a company in the table links to its page in Orbit when the student has that company', async () => {
    await db.organizations.bulkPut([
      {
        id: 'o-balderton',
        userId: 'u1',
        nameRaw: 'Balderton',
        nameNormalized: normalizeCompany('Balderton'),
      },
    ] as never);
    world.people.set('p1', { ...world.people.get('p1')!, currentOrganizationId: 'o-accel' } as never);
    network([row('p1', 'Ana Own', 'strong', [check('position:0', 'yes'), check('criterion:0', 'yes')])]);
    src.searchPeople.mockResolvedValue({
      ok: true,
      value: {
        batchId: 'b',
        relaxed: [],
        unconfigured: [],
        results: [sourced({ id: 'r1' }), sourced({ id: 'r2', name: 'Oz New', org: 'Nowhere Labs' })],
      },
    });
    const r = await runPeopleSearch({ id: 'u1', school: '' }, asked);
    const by = (n: string) => r.rows.find((x) => x.name === n)!;
    expect(by('Ana Own').companyId).toBe('o-accel');
    expect(by('Nia Out').companyId).toBe('o-balderton');
    expect(by('Oz New').companyId).toBeUndefined();
    world.people.set('p1', {
      id: 'p1',
      currentTitle: 'Partner',
      currentOrganizationRaw: 'Accel',
      linkedinUrl: 'https://li/p1',
    } as never);
    await db.organizations.clear();
  });

  it("joins both, the student's own first on a tie, and a known person found outside is listed once", async () => {
    network([
      row('p1', 'Ana Own', 'strong', [check('position:0', 'yes'), check('criterion:0', 'yes')]),
      row('p2', 'Ben Maybe', 'likely', [check('position:0', 'likely'), check('criterion:0', 'unknown')]),
      row('p3', 'Cy No', 'no', [check('position:0', 'no')]),
      row('p4', 'Di Unchecked', 'unchecked', [check('position:0', 'unknown')]),
    ]);
    src.searchPeople.mockResolvedValue({
      ok: true,
      value: {
        batchId: 'b',
        relaxed: [],
        unconfigured: ['apollo'],
        results: [
          sourced({
            id: 'r1',
            fit: 1,
            checks: [{ text: 'Works at a venture capital firm', need: 'must', answer: 'yes' }],
            bridge: { personId: 'p9', name: 'Sam Warm' },
          }),
          // the same person the network already listed: not listed twice
          sourced({ id: 'r2', name: 'Ana Own', knownPersonId: 'p1' }),
          sourced({ id: 'r3', name: 'Zed Second', fit: 0.4, degree: 2 }),
        ],
      },
    });
    const r = await runPeopleSearch({ id: 'u1', school: '' }, asked);
    expect(r.rows.map((x) => x.name)).toEqual(['Ana Own', 'Nia Out', 'Ben Maybe', 'Zed Second']);
    expect(r.counts).toEqual({ network: 2, outside: 2 });
    const [ana, nia, ben, zed] = r.rows;
    expect(ana).toMatchObject({
      personId: 'p1',
      match: 100,
      title: 'Partner',
      company: 'Accel',
      path: { kind: 'direct', level: 3 },
      evidence: 'Partner at Accel',
    });
    expect(ana!.checks).toEqual([{ id: asked.criteria[0]!.id, answer: 'yes', evidence: 'Partner at Accel' }]);
    expect(nia).toMatchObject({
      recommendationId: 'r1',
      match: 100,
      path: { kind: 'intro', label: 'Sam Warm', personId: 'p9', level: 2 },
    });
    expect(nia!.personId).toBeUndefined();
    // someone with no tie whom a friend on Orbit knows: the path is the friend; no title on file, so the headline
    expect(ben).toMatchObject({
      path: { kind: 'friend', label: 'Henry Allen' },
      title: 'Investing in climate',
    });
    expect(ben!.checks[0]!.answer).toBe('unknown');
    // no checks came back for them: the fit alone
    expect(zed).toMatchObject({ path: { kind: 'second', level: 1 }, match: 40 });
    expect(r.notes).toContain('Not searched yet: Apollo.');
    expect(r.unchecked).toBe(true);
  });

  it('the outside search gets the form: filters, criteria, people only, and what it is for', async () => {
    network([]);
    src.searchPeople.mockResolvedValue({
      ok: true,
      value: { batchId: 'b', results: [], relaxed: [], unconfigured: [] },
    });
    await runPeopleSearch({ id: 'u1', school: '' }, asked);
    expect(src.searchPeople).toHaveBeenCalledWith(
      { id: 'u1', school: '' },
      expect.objectContaining({
        purpose: 'fundraising',
        query: 'seed investors in London',
        peopleOnly: true,
        criteria: [{ text: 'Works at a venture capital firm', need: 'must' }],
        filters: expect.objectContaining({ titles: ['investor', 'partner', 'principal'] }),
      }),
    );
    // and the network search gets the same form as a spec, as the UI
    const [, spec, opts] = net.runNetworkSearch.mock.calls[0]!;
    expect(spec.positions).toEqual([{ role: { families: ['investing'] }, when: 'current' }]);
    expect(spec.criteria).toEqual([{ text: 'Works at a venture capital firm', need: 'must' }]);
    expect(opts).toMatchObject({ caller: 'ui' });
  });

  it('"only people I know", or no Orbit account, never asks the server', async () => {
    network([row('p1', 'Ana Own', 'strong', [check('position:0', 'yes')])]);
    const mine = await runPeopleSearch(
      { id: 'u1', school: '' },
      { ...asked, filters: { ...asked.filters, reach: 'mine' } },
    );
    expect(src.searchPeople).not.toHaveBeenCalled();
    expect(mine.counts).toEqual({ network: 1, outside: 0 });
    api.server = false;
    await runPeopleSearch({ id: 'u1', school: '' }, asked);
    expect(src.searchPeople).not.toHaveBeenCalled();
  });

  it('one part failing never hides the other, and says so', async () => {
    network([row('p1', 'Ana Own', 'strong', [check('position:0', 'yes')])]);
    src.searchPeople.mockResolvedValue({ ok: false, message: 'Orbit could not reach its server.' });
    const a = await runPeopleSearch({ id: 'u1', school: '' }, asked);
    expect(a.rows.map((x) => x.name)).toEqual(['Ana Own']);
    expect(a.outsideMessage).toBe('Orbit could not reach its server.');
    src.searchPeople.mockRejectedValue(new Error('offline'));
    expect((await runPeopleSearch({ id: 'u1', school: '' }, asked)).outsideMessage).toBe('offline');
    net.runNetworkSearch.mockRejectedValue(new Error('boom'));
    src.searchPeople.mockResolvedValue({
      ok: true,
      value: { batchId: 'b', results: [sourced({})], relaxed: ['location'], unconfigured: [] },
    });
    const b = await runPeopleSearch({ id: 'u1', school: '' }, asked);
    expect(b.rows.map((x) => x.name)).toEqual(['Nia Out']);
    expect(b.notes).toEqual([
      'Orbit could not search your own network just now.',
      'To find more people outside your network, Orbit left out: location.',
    ]);
  });

  it('an empty form runs nothing and says what to ask', async () => {
    const r = await runPeopleSearch({ id: 'u1', school: '' }, form());
    expect(r.rows).toEqual([]);
    expect(r.notes[0]).toMatch(/Say who to look for/);
    expect(net.runNetworkSearch).not.toHaveBeenCalled();
    expect(src.searchPeople).not.toHaveBeenCalled();
  });

  it('the spreadsheet has the columns shown, quotes commas, and never lets a cell run as a formula', () => {
    const csv = resultsCsv({
      form: asked,
      rows: [
        {
          key: 'a',
          name: 'Ana, Own',
          linkedinUrl: 'https://li/p1',
          title: '=HYPERLINK("x")',
          company: 'Accel',
          match: 100,
          path: { kind: 'intro', label: 'Sam Warm', level: 2 },
          checks: [{ id: 'c', answer: 'yes' }],
        },
      ],
    });
    expect(csv.split('\n')).toEqual([
      'Name,LinkedIn,Path,Title,Company,Match,Works at a venture capital firm',
      '"Ana, Own",https://li/p1,via Sam Warm,"\'=HYPERLINK(""x"")",Accel,100%,yes',
    ]);
  });
});
