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

import {
  countFilters,
  EMPTY_FILTERS,
  extraWords,
  type FilterForm,
  formIsEmpty,
  formOf,
  interpretAsk,
  matchOfChecks,
  matchOfSourced,
  newCriterion,
  outsideFilters,
  purposeOf,
  resultsCsv,
  ruleForm,
  runPeopleSearch,
  type SearchForm,
  specOf,
  tidyForm,
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
    expect(r.form.filters.keywords).toEqual(['seed', 'venture capital']);
    expect(r.form.filters.keywordsNeed).toBe('nice');
    expect(r.form.criteria.map((c) => [c.text, c.need])).toEqual([
      ['Works at a venture capital firm', 'must'],
      ['Invests at seed stage', 'nice'],
    ]);
    // the sentence goes to the model wrapped as data
    const build = llm.judge.mock.calls[0]![1] as (w: (s: string, t: string) => string) => string;
    expect(build((s, t) => `<${s}>${t}</${s}>`)).toBe('<sentence>seed investors in London</sentence>');
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

describe('the match', () => {
  const k = (need: 'must' | 'nice', answer: 'yes' | 'likely' | 'unknown' | 'no') => ({ need, answer });
  it("one of the student's own: a must-have counts double, nothing asked is a full match", () => {
    expect(matchOfChecks([])).toBe(100);
    expect(matchOfChecks([k('must', 'yes'), k('must', 'yes')])).toBe(100);
    expect(matchOfChecks([k('must', 'yes'), k('nice', 'no')])).toBe(67);
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
      titles: ['partner', 'investor', 'principal', 'venture capital'],
      organizations: ['Accel', 'Google'],
      locations: ['London'],
      schools: ['LSE'],
      keywords: ['seed'],
      seniority: ['vp', 'c_suite'],
    });
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
        filters: expect.objectContaining({ titles: ['investor', 'partner', 'principal', 'venture capital'] }),
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
