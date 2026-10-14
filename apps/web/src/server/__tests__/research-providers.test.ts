import { describe, expect, it } from 'vitest';
import villageCompany from '../../../../../supabase/functions/_shared/__fixtures__/village-company-paths.json';
import villagePeople from '../../../../../supabase/functions/_shared/__fixtures__/village-person-paths.json';
import { createApollo } from '../../../../../supabase/functions/_shared/providers/apollo';
import { createExa } from '../../../../../supabase/functions/_shared/providers/exa';
import {
  backoffMs,
  cacheKey,
  requestJson,
  retryAfterMs,
} from '../../../../../supabase/functions/_shared/providers/request';
import { createSemanticScholar } from '../../../../../supabase/functions/_shared/providers/semanticScholar';
import {
  cleanLinkedInUrl,
  createUnipileResearch,
  hasSalesNavigator,
  linkedInPerson,
  networkDistance,
} from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import {
  companyIntros,
  createVillage,
  personIntros,
} from '../../../../../supabase/functions/_shared/providers/village';
import { z } from '../../../../../supabase/functions/_shared/providers/zod';
import { fakeFetch, instant, json, manualClock } from './fakes';

const token = {
  data: { token: 'tok', expires_in: 31536000, expires_at: 1_900_000_000, token_type: 'Bearer' },
};

describe('provider request core', () => {
  it('retries 429 and 5xx at most three times, honouring Retry-After, then reports the error', async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch(() => json({}, 503, { 'retry-after': '2' }));
    const r = await requestJson(
      { fetch, sleep: async (ms) => void waits.push(ms), random: () => 0 },
      { provider: 'x', url: 'https://x.test/a', schema: z.object({}) },
    );
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 503 });
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([2000, 2000, 2000]);
  });

  it('backs off 1 s, 2 s, 4 s with jitter when there is no Retry-After, and recovers', async () => {
    const waits: number[] = [];
    let n = 0;
    const { fetch } = fakeFetch(() => (++n < 3 ? json({}, 429) : json({ a: 1 })));
    const r = await requestJson(
      { fetch, sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
      { provider: 'x', url: 'https://x.test/a', schema: z.object({ a: z.number() }) },
    );
    expect(r).toEqual({ ok: true, value: { a: 1 } });
    expect(waits).toEqual([1125, 2250]);
    expect(backoffMs(2, () => 0)).toBe(4000);
    expect(retryAfterMs('Wed, 14 Oct 2026 12:00:05 GMT', Date.parse('2026-10-14T12:00:00Z'))).toBe(5000);
    expect(retryAfterMs('600', 0)).toBe(30_000);
  });

  it('does not retry a 4xx, and times out a hung call with the abort signal', async () => {
    const four = fakeFetch(() => json({}, 400));
    const r = await requestJson(
      { fetch: four.fetch, sleep: instant },
      { provider: 'x', url: 'https://x.test', schema: z.object({}) },
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(four.calls).toHaveLength(1);

    const hung = (async (_u: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const t = await requestJson(
      { fetch: hung, sleep: instant, timeoutMs: 5, maxRetries: 1 },
      { provider: 'x', url: 'https://x.test', schema: z.object({}) },
    );
    expect(t).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('rejects a body that does not match the schema as invalid', async () => {
    const { fetch } = fakeFetch(() => json({ results: 'nope' }));
    const exa = createExa({ fetch, apiKey: 'k', sleep: instant });
    expect(await exa.search({ query: 'q' })).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('hashes equal requests equally whatever their key order', async () => {
    const a = await cacheKey('exa', { q: 'x', n: 5, c: { h: 1, m: 2 } });
    const b = await cacheKey('exa', { c: { m: 2, h: 1 }, n: 5, q: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheKey('apollo', { q: 'x', n: 5, c: { h: 1, m: 2 } })).not.toBe(a);
  });
});

describe('unconfigured providers', () => {
  it('answer a typed unconfigured result without any call', async () => {
    const { fetch, calls } = fakeFetch();
    const results = await Promise.all([
      createExa({ fetch }).search({ query: 'q' }),
      createApollo({ fetch }).searchPeople({}),
      createSemanticScholar({ fetch }).searchPapers('q'),
      createUnipileResearch({ fetch, apiKey: 'k' }).profile('a', 'm'),
      createVillage({ fetch }).personPaths({ externalUserId: 'u', email: 'e@x.test' }, { linkedin_url: 'x' }),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : `${r.kind}:${r.provider}`))).toEqual([
      'unconfigured:exa',
      'unconfigured:apollo',
      'unconfigured:semantic_scholar',
      'unconfigured:unipile',
      'unconfigured:village',
    ]);
    expect(calls).toEqual([]);
    // Semantic Scholar answers keyless on the shared pool when allowed
    expect(createSemanticScholar({ fetch, anonymous: true }).configured).toBe(true);
  });
});

describe('Exa, Apollo and Semantic Scholar requests', () => {
  it('Exa posts the search body with the x-api-key header', async () => {
    const { fetch, calls } = fakeFetch(() => json({ results: [{ url: 'https://a.test', title: 'A' }] }));
    const exa = createExa({ fetch, apiKey: 'exa-k' });
    const r = await exa.search({ query: '"Jane" Acme', category: 'people', numResults: 5 });
    expect(r.ok && r.value.results[0]!.url).toBe('https://a.test');
    expect(calls[0]).toMatchObject({
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: expect.objectContaining({ 'x-api-key': 'exa-k' }),
      body: { query: '"Jane" Acme', category: 'people', numResults: 5 },
    });
  });

  it('Apollo sends filters in the query string with [] arrays', async () => {
    const { fetch, calls } = fakeFetch(() => json({ people: [{ id: 'a1', first_name: 'Maya' }] }));
    await createApollo({ fetch, apiKey: 'ap' }).searchPeople({
      person_titles: ['Partner', 'General Partner'],
      q_keywords: 'climate seed',
      per_page: 25,
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(
      'https://api.apollo.io/api/v1/mixed_people/api_search?person_titles%5B%5D=Partner&person_titles%5B%5D=General%20Partner&q_keywords=climate%20seed&per_page=25',
    );
    expect(calls[0]!.headers['x-api-key']).toBe('ap');
  });

  it('Semantic Scholar asks paper search and author details with fields', async () => {
    const { fetch, calls } = fakeFetch(
      (c) =>
        c.url.includes('/paper/search')
          ? json({ total: 1, data: [{ paperId: 'p', authors: [] }] })
          : undefined,
      () => json({ authorId: 'a1', name: 'R. Chen', affiliations: ['MIT'], hIndex: 12 }),
    );
    const s2 = createSemanticScholar({ fetch, apiKey: 's2' });
    await s2.searchPapers('graph neural networks');
    const a = await s2.author('a1');
    expect(calls[0]!.url).toBe(
      'https://api.semanticscholar.org/graph/v1/paper/search?query=graph%20neural%20networks&fields=title%2Cyear%2Cauthors%2Cvenue&limit=50',
    );
    expect(calls[1]!.url).toContain(
      '/graph/v1/author/a1?fields=name%2Caffiliations%2Chomepage%2CpaperCount%2ChIndex',
    );
    expect(a.ok && a.value.affiliations).toEqual(['MIT']);
  });
});

describe('Unipile research', () => {
  const base = 'https://api9.unipile.com:13999';

  it('reads a profile with linkedin_sections and notify=false, and recent posts', async () => {
    const { fetch, calls } = fakeFetch(
      (c) =>
        c.url.includes('/posts')
          ? json({ object: 'PostList', items: [{ id: 'p1', text: 'Hi' }] })
          : undefined,
      () => json({ provider_id: 'ACoA1', first_name: 'Jane', headline: 'VP' }),
    );
    const u = createUnipileResearch({ fetch, apiKey: 'uk', baseUrl: base });
    const p = await u.profile('acc', 'ACoA1');
    const posts = await u.posts('acc', 'ACoA1');
    expect(p.ok && p.value.first_name).toBe('Jane');
    expect(posts.ok && posts.value.map((x) => x.id)).toEqual(['p1']);
    expect(calls[0]!.url).toBe(
      `${base}/api/v1/users/ACoA1?account_id=acc&linkedin_sections=*_preview%2Cexperience%2Ceducation%2Cabout&notify=false`,
    );
    expect(calls[0]!.headers['X-API-KEY']).toBe('uk');
    expect(calls[1]!.url).toBe(`${base}/api/v1/users/ACoA1/posts?account_id=acc&limit=10`);
  });

  it('searches mutuals with classic people, distance [1] and connections_of [member]', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        object: 'LinkedinSearch',
        items: [{ type: 'PEOPLE', id: 'ACoM', name: 'Mia Chen' }],
        cursor: null,
      }),
    );
    const r = await createUnipileResearch({ fetch, apiKey: 'uk', baseUrl: base }).mutuals('acc', 'ACoT');
    expect(r.ok && r.value.map((x) => x.name)).toEqual(['Mia Chen']);
    expect(calls[0]).toMatchObject({
      url: `${base}/api/v1/linkedin/search?account_id=acc&limit=10`,
      method: 'POST',
      body: { api: 'classic', category: 'people', network_distance: [1], connections_of: ['ACoT'] },
    });
  });

  it('normalizes search items, distances, URLs and the Sales Navigator flag', () => {
    expect(
      linkedInPerson({
        id: 'ACo1',
        name: 'Piyush N',
        profile_url: 'https://www.linkedin.com/in/PiyushN?miniProfileUrn=x',
        network_distance: 'DISTANCE_2',
      }),
    ).toMatchObject({
      memberId: 'ACo1',
      linkedinUrl: 'https://www.linkedin.com/in/piyushn',
      networkDistance: 2,
    });
    expect(networkDistance('SECOND_DEGREE')).toBe(2);
    expect(cleanLinkedInUrl('https://linkedin.com/company/acme')).toBeUndefined();
    expect(hasSalesNavigator({ premium: { sales_navigator: { contract_id: 'x' } } })).toBe(true);
    expect(hasSalesNavigator({ premium: false })).toBe(false);
  });
});

describe('Village v2', () => {
  const user = { externalUserId: 'u1', email: 'u1@orbit.test' };

  it('mints a token with the secret key once per 50 minutes and uses it as a bearer', async () => {
    const c = manualClock();
    const { fetch, calls } = fakeFetch(
      (x) => (x.url.endsWith('/v2/auth/tokens') ? json(token) : undefined),
      () => json(villagePeople),
    );
    const v = createVillage({ fetch, secretKey: 'sk_1', clock: c.clock });
    await v.personPaths(user, { linkedin_url: 'https://www.linkedin.com/in/dana' });
    await v.personPaths(user, { linkedin_url: 'https://www.linkedin.com/in/dana' });
    expect(calls.map((x) => x.url)).toEqual([
      'https://api.village.do/v2/auth/tokens',
      'https://api.village.do/v2/people/paths',
      'https://api.village.do/v2/people/paths',
    ]);
    expect(calls[0]).toMatchObject({
      headers: expect.objectContaining({ 'secret-key': 'sk_1' }),
      body: { external_user_id: 'u1', email: 'u1@orbit.test' },
    });
    expect(calls[1]!.headers.authorization).toBe('Bearer tok');
    c.advance(51 * 60_000);
    await v.personPaths(user, { linkedin_url: 'https://www.linkedin.com/in/dana' });
    expect(calls.filter((x) => x.url.endsWith('/auth/tokens'))).toHaveLength(2);
  });

  it('re-mints once on a 401, and reads a 404 as no paths', async () => {
    let paths = 0;
    const { fetch, calls } = fakeFetch(
      (x) => (x.url.endsWith('/v2/auth/tokens') ? json(token) : undefined),
      () => (++paths === 1 ? json({}, 401) : json({}, 404)),
    );
    const r = await createVillage({ fetch, secretKey: 'sk' }).personPaths(user, { linkedin_url: 'x' });
    expect(r).toEqual({ ok: true, value: { summary: null, paths: [] } });
    expect(calls.filter((x) => x.url.endsWith('/auth/tokens'))).toHaveLength(2);
  });

  it('normalizes person and company paths to introducers with 0..1 warmth, skipping direct ties', async () => {
    const { fetch } = fakeFetch(
      (x) => (x.url.endsWith('/v2/auth/tokens') ? json(token) : undefined),
      (x) => (x.url.endsWith('/v2/people/paths') ? json(villagePeople) : json(villageCompany)),
    );
    const v = createVillage({ fetch, secretKey: 'sk' });
    const p = await v.personPaths(user, { linkedin_url: 'x' });
    const intros = p.ok ? personIntros(p.value) : [];
    expect(intros.map((i) => [i.introducer.name, i.warmth])).toEqual([
      ['Sam Ortiz', 0.82],
      ['Mia Chen', 0.55],
    ]);
    expect(intros[0]!.target.name).toBe('Dana Lee');
    expect(intros[0]!.reasons[0]).toBe('Worked together: Acme Robotics, 2021–2024');
    const co = await v.companyPaths(user, { domain: 'stripe.com' });
    const cIntros = co.ok ? companyIntros(co.value) : [];
    expect(cIntros.map((i) => [i.introducer.name, i.target.name, i.warmth])).toEqual([
      ['Sam Ortiz', 'Ana Ruiz', 0.64],
    ]);
  });
});
