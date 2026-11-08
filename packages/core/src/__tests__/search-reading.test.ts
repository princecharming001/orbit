import { describe, expect, it } from 'vitest';
import { buildFactsIndex, matchFacts, stageOf } from '../search/companies';
import { buildPersonDoc, type DocPerson, type DocProfile } from '../search/doc';
import { buildPlaceIndex } from '../search/places';
import { PLACES_DATA } from '../search/places.data';
import type { SearchContext } from '../search/predicates';
import {
  quoteIn,
  readByPattern,
  settleCompanyReading,
  settlePersonReading,
  stageFromWords,
  withPatterns,
} from '../search/reading';
import { runSpec } from '../search/run';
import { buildSchoolIndex } from '../search/schools';
import type { QuerySpec } from '../search/spec';

describe('reading rules', () => {
  it('finds quotes despite case, curly quotes, dashes and spacing, and refuses ones not there', () => {
    const text = 'We’re a seed‑stage team — building  AI agents.';
    expect(quoteIn(text, "we're a seed-stage team")).toBe("we're a seed-stage team");
    expect(quoteIn(text, 'Series A startup')).toBeUndefined();
    expect(quoteIn(text, 'a')).toBeUndefined();
  });

  it('reads stages from words', () => {
    expect(stageFromWords('Series C')).toBe('series_b_plus');
    expect(stageFromWords('series-a')).toBe('series_a');
    expect(stageFromWords('pre seed')).toBe('pre_seed');
    expect(stageFromWords('publicly traded on NASDAQ')).toBe('public');
    expect(stageFromWords('growing fast')).toBeUndefined();
  });

  it('keeps a person fact only with a quote that is there and that says it', () => {
    const text =
      'About: Co-founder of Lumen. We raised a $3M seed round. Team of 9. I angel invest in robotics.';
    const r = settlePersonReading(
      {
        stage: { value: 'seed', company: 'Lumen', quote: 'We raised a $3M seed round' },
        team_size: { value: 9, quote: 'Team of 9' },
        focus: [
          { value: 'robotics', quote: 'angel invest in robotics' },
          { value: 'climate', quote: 'climate tech founder' },
        ],
        signals: [
          { value: 'angel_investing', quote: 'I angel invest in robotics' },
          { value: 'raising', quote: 'we are raising now' },
          { value: 'world_domination', quote: 'Co-founder of Lumen' },
        ],
      },
      text,
    );
    expect(r).toEqual({
      stage: { value: 'seed', quote: 'We raised a $3M seed round', company: 'Lumen' },
      teamSize: { value: 9, quote: 'Team of 9' },
      focus: [{ value: 'robotics', quote: 'angel invest in robotics' }],
      signals: [{ value: 'angel_investing', quote: 'I angel invest in robotics' }],
    });
    // a quote that names no stage does not make one
    expect(
      settlePersonReading({ stage: { value: 'growth', quote: 'Co-founder of Lumen' } }, text).stage,
    ).toBeUndefined();
  });

  it('reads companies the same way', () => {
    const text = 'Company: Ramp\nAbout: Backed by Sequoia. We raised a $150M Series D.';
    expect(
      settleCompanyReading(
        {
          stage: { value: 'series_b_plus', quote: 'raised a $150M Series D' },
          kind: 'startup',
          what: 'Cards',
        },
        text,
      ),
    ).toEqual({
      stage: 'series_b_plus',
      stageEvidence: 'raised a $150M Series D',
      kind: 'startup',
      what: 'Cards',
    });
    // investors alone are not a stage
    expect(
      settleCompanyReading({ stage: { value: 'series_a', quote: 'Backed by Sequoia' } }, text).stage,
    ).toBeUndefined();
  });

  it('reads plain patterns without a model, under what a model found', () => {
    const p = readByPattern(
      'Founding engineer at a Series A startup. A team of 12. We are hiring! In stealth mode.',
    );
    expect(p.stage?.value).toBe('series_a');
    expect(p.teamSize?.value).toBe(12);
    expect(p.signals?.map((s) => s.value).sort()).toEqual(['hiring', 'stealth']);
    const merged = withPatterns({ stage: { value: 'seed', quote: 'x' } }, p);
    expect(merged.stage?.value).toBe('seed');
    expect(merged.teamSize?.value).toBe(12);
  });
});

describe('company pages in the facts', () => {
  const index = buildFactsIndex([
    { key: 'weave', name: 'Weave', ycBatch: 'W25', teamSize: 12, website: 'https://weave.dev', source: 'yc' },
    {
      key: 'weave',
      name: 'Weave',
      linkedinId: '900',
      website: 'https://www.weave.dev/',
      teamSize: 31,
      foundedYear: 2024,
      stage: 'seed',
      stageEvidence: 'our $4M seed',
      source: 'linkedin',
    },
    // another company that shares a name with a YC one: kept apart, found by its id
    { key: 'clear', name: 'Clear', ycBatch: 'S21', website: 'https://clear.ai', source: 'yc' },
    {
      key: 'clear',
      name: 'Clear',
      linkedinId: '77',
      website: 'https://clearme.com',
      teamSize: 4000,
      source: 'linkedin',
    },
    { key: 'lumen', name: 'Lumen', linkedinId: '555', teamSize: 9, source: 'linkedin' },
  ]);

  it('lays a page over its directory row when the websites agree', () => {
    const w = index.byKey.get('weave')!;
    expect(w).toMatchObject({ ycBatch: 'W25', teamSize: 31, foundedYear: 2024, linkedinId: '900' });
    expect(stageOf(w)).toEqual({ stage: 'seed', estimated: false, evidence: 'our $4M seed' });
  });

  it('keeps a namesake apart and finds it by LinkedIn id', () => {
    expect(index.byKey.get('clear')!.ycBatch).toBe('S21');
    expect(index.byKey.get('clear')!.teamSize).toBeUndefined();
    expect(matchFacts('Clear', index, { linkedinId: '77' })).toMatchObject({
      confidence: 'strong',
      basis: 'linkedin',
      fact: { teamSize: 4000 },
    });
    expect(matchFacts('Lumen', index)?.fact.teamSize).toBe(9);
  });
});

describe('searching with what profiles say', () => {
  const schools = buildSchoolIndex([]);
  const places = buildPlaceIndex(PLACES_DATA);
  const facts = buildFactsIndex([
    {
      key: 'lumen',
      name: 'Lumen',
      linkedinId: '555',
      teamSize: 9,
      source: 'linkedin',
      sizeFromLinkedIn: true,
    },
    {
      key: 'bigco',
      name: 'BigCo',
      linkedinId: '9',
      teamSize: 2400,
      source: 'linkedin',
      sizeFromLinkedIn: true,
    },
    {
      key: 'arbor',
      name: 'Arbor',
      linkedinId: '31',
      teamSize: 40,
      source: 'linkedin',
      sizeFromLinkedIn: true,
      about: 'Arbor builds software for climate and carbon accounting.',
    },
  ]);
  const ctx: SearchContext = {
    facts,
    places,
    schools,
    rel: () => undefined,
    channels: {
      email: { connected: true },
      meeting: { connected: true },
      text: { connected: false },
      linkedin: { connected: true },
    },
    mySchools: [],
    now: Date.parse('2026-11-08'),
  };
  let n = 0;
  const doc = (over: Partial<DocPerson>, profile?: DocProfile) =>
    buildPersonDoc(
      { id: `q${++n}`, displayName: `Q ${n}`, tags: [], ...over },
      [],
      { isSchool: (t) => schools.lookup(t), places },
      [],
      undefined,
      profile,
    );

  const said = doc(
    { displayName: 'Said', headline: 'Building something new' },
    {
      about: 'We just closed our seed round. A team of 9.',
      experience: [
        { title: 'Co-founder', company: 'Lumen', companyId: '555', current: true, start: '2025-01' },
      ],
      reading: {
        stage: { value: 'seed', quote: 'We just closed our seed round', company: 'Lumen' },
        teamSize: { value: 9, quote: 'A team of 9' },
      },
    },
  );
  const headlineOnly = doc({ displayName: 'HeadlineOnly', headline: 'Founder @ Lumen' });
  const big = doc(
    { displayName: 'Big', headline: 'PM' },
    { experience: [{ title: 'Product Manager', company: 'BigCo', companyId: '9', current: true }] },
  );
  const exGoogle = doc(
    { displayName: 'ExGoogle', headline: 'Founder @ Lumen' },
    {
      experience: [
        { title: 'Founder', company: 'Lumen', companyId: '555', current: true, start: '2025-01' },
        { title: 'Software Engineer', company: 'Google', current: false, start: '2020-06', end: '2024-12' },
      ],
    },
  );
  const angel = doc(
    { displayName: 'Angel', headline: 'Engineer @ BigCo' },
    {
      experience: [],
      reading: { signals: [{ value: 'angel_investing', quote: 'I angel invest in robotics founders' }] },
    },
  );
  const climate = doc(
    { displayName: 'Climate', headline: 'Engineer' },
    { experience: [{ title: 'Software Engineer', company: 'Arbor', companyId: '31', current: true }] },
  );
  const docs = [said, headlineOnly, big, exGoogle, angel, climate];
  const band = (spec: QuerySpec, d: { id: string }) =>
    runSpec(spec, docs, ctx).rows.find((r) => r.id === d.id)?.band;

  it('a stage the person states is a strong match, with their words as the evidence', () => {
    const spec: QuerySpec = {
      ask: 'seed stage founders',
      positions: [{ role: { founder: true }, company: { stages: ['seed'] } }],
    };
    const rows = runSpec(spec, docs, ctx).rows;
    const r = rows.find((x) => x.id === said.id)!;
    expect(r.band).toBe('strong');
    expect(r.checks[0]!.evidence).toContain('We just closed our seed round');
    // a headline alone: only an estimate from headcount
    expect(rows.find((x) => x.id === headlineOnly.id)?.band).toBe('likely');
  });

  it('team size comes from the person or the company page; a big company is a no', () => {
    const spec: QuerySpec = { ask: 'people at startups under 50', positions: [{ company: { sizeMax: 50 } }] };
    expect(band(spec, said)).toBe('strong');
    // a no is not listed at all
    expect(band(spec, big)).toBeUndefined();
    const row = runSpec(spec, docs, ctx).rows.find((r) => r.id === climate.id)!;
    expect(row.checks[0]!.evidence).toContain('LinkedIn lists 40 employees');
  });

  it('past jobs from the profile make ex-company asks exact', () => {
    const spec: QuerySpec = {
      ask: 'ex-Google founders',
      positions: [{ role: { founder: true } }, { company: { names: ['Google'] }, when: 'past' }],
    };
    expect(band(spec, exGoogle)).toBe('strong');
  });

  it('an angel investor in their own words is an investor', () => {
    const spec: QuerySpec = { ask: 'investors', positions: [{ role: { families: ['investing'] } }] };
    expect(band(spec, angel)).toBe('strong');
  });

  it('a company About answers its industry', () => {
    const spec: QuerySpec = {
      ask: 'people at climate companies',
      positions: [{ company: { industries: ['climate'] } }],
    };
    expect(band(spec, climate)).toBe('strong');
    expect(band(spec, big)).not.toBe('strong');
  });
});
