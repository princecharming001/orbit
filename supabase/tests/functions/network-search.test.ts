import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { censusPeople, runCensusStep } from '../../functions/_shared/search/census.ts';
import { factRow, MIN_COMPANIES, syncCompanyFacts } from '../../functions/_shared/search/companyFacts.ts';
import { runFacetLookup } from '../../functions/_shared/search/lookup.ts';
import { addPerson, api, fakeNet, instant, jsonRes, signedInUser, UNIPILE } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

/**
 * Network search on the server (plan 32 §6): company facts from yc-oss, the census of LinkedIn connections against
 * the shared search ledger, and the orbit-api routes the browser reads them through.
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const NOW = new Date('2026-11-08T12:00:00Z');

function ycList(n: number) {
  const out: Record<string, unknown>[] = [
    {
      id: 1,
      name: 'Knowlify',
      former_names: ['Knowlify AI'],
      website: 'https://www.knowlify.ai',
      batch: 'Winter 2026',
      status: 'Active',
      stage: 'Early',
      team_size: 4,
      industries: ['Education'],
      tags: ['AI', 'EdTech'],
      one_liner: 'Explainer videos',
    },
    { id: 2, name: 'Here', batch: 'Spring 2025', status: 'Active', stage: 'Early', team_size: 3 },
  ];
  for (let i = 3; i <= n; i++)
    out.push({ id: i, name: `Company Zx${i}`, batch: 'Summer 2020', status: 'Inactive' });
  return out;
}

describe('company facts', () => {
  it('reads a yc-oss entry into a row', () => {
    const r = factRow(ycList(2)[0] as never)!;
    expect(r).toMatchObject({
      key: 'knowlify',
      ycBatch: 'W26',
      ycStatus: 'Active',
      teamSize: 4,
      ambiguousName: false,
    });
    expect(r.industries).toEqual(['Education', 'AI', 'EdTech']);
    expect(factRow(ycList(2)[1] as never)).toMatchObject({ ycBatch: 'X25', ambiguousName: true });
    expect(factRow({ id: 9, name: '  ' } as never)).toBeUndefined();
  });

  it('syncs, keeps unchanged rows unchanged, and refuses a short list', async () => {
    const list = ycList(MIN_COMPANIES + 5);
    const net = fakeNet((c) => (c.url.includes('yc-oss') ? jsonRes(200, list) : undefined));
    const r = await syncCompanyFacts(t.db, net.fetch, NOW);
    expect(r).toEqual({ fetched: list.length, written: list.length });
    const [k] = await t.db.sql<{ yc_batch: string; former_names: string[]; updated_at: string }>`
      select yc_batch, former_names, updated_at::text from orbit_private.company_facts where key = 'knowlify'`;
    expect(k).toMatchObject({ yc_batch: 'W26', former_names: ['Knowlify AI'] });
    await syncCompanyFacts(t.db, net.fetch, NOW);
    const [again] = await t.db.sql<{ updated_at: string }>`
      select updated_at::text from orbit_private.company_facts where key = 'knowlify'`;
    expect(again!.updated_at).toBe(k!.updated_at);

    const short = fakeNet(() => jsonRes(200, ycList(10)));
    expect(await syncCompanyFacts(t.db, short.fetch, NOW)).toMatchObject({ skipped: 'too_small' });
    const broken = fakeNet(() => jsonRes(500, {}));
    expect(await syncCompanyFacts(t.db, broken.fetch, NOW)).toMatchObject({ skipped: 'fetch_failed' });
    const [{ n }] = (await t.db.sql<{
      n: number;
    }>`select count(*)::int as n from orbit_private.company_facts`) as [{ n: number }];
    expect(n).toBe(list.length);
  });

  it('serves facts over the API, all or since a time', async () => {
    const { token } = await signedInUser(t);
    const call = api(t, fakeNet());
    const all = await call<{ facts: { key: string; ycBatch?: string }[]; at: string }>(
      '/companies/facts',
      token,
    );
    expect(all.status).toBe(200);
    expect(all.body.facts.find((f) => f.key === 'knowlify')?.ycBatch).toBe('W26');
    const later = await call<{ facts: unknown[] }>(
      `/companies/facts?since=${encodeURIComponent(all.body.at)}`,
      token,
    );
    expect(later.body.facts).toEqual([]);
  });
});

describe('census', () => {
  it('reads only 1st-degree people with a name', () => {
    expect(
      censusPeople([
        {
          id: 'A',
          name: 'Ana',
          location: 'San Francisco Bay Area',
          current_positions: [{ company: 'Stripe' }],
        },
        { id: 'B', name: 'Ben', network_distance: 'DISTANCE_2' },
        { id: 'C' },
      ]),
    ).toEqual([
      {
        memberId: 'A',
        name: 'Ana',
        location: 'San Francisco Bay Area',
        companies: ['Stripe'],
        headline: undefined,
      },
    ]);
  });

  it('files pages for known people, fills empty locations, stops at its ledger share and resumes', async () => {
    const { userId, token } = await signedInUser(t);
    const ana = await addPerson(t, userId, { name: 'Ana Park', memberId: 'ACoAna' });
    const ben = await addPerson(t, userId, { name: 'Ben Ode', memberId: 'ACoBen' });
    await t.db.sql`update orbit.people set location = 'Austin' where id = ${ben}::uuid`;
    let page = 0;
    const net = fakeNet((c) => {
      if (!c.url.startsWith(`${UNIPILE}/api/v1/linkedin/search`)) return undefined;
      page++;
      if (page === 1)
        return jsonRes(200, {
          items: [
            {
              id: 'ACoAna',
              name: 'Ana Park',
              location: 'San Francisco Bay Area',
              current_positions: [{ company: 'Stripe' }],
            },
            { id: 'ACoBen', name: 'Ben Ode', location: 'New York City Metropolitan Area' },
            { id: 'ACoStranger', name: 'Not Known', location: 'Paris' },
          ],
          cursor: 'c2',
        });
      return jsonRes(200, { items: [{ id: 'ACoZed', name: 'Zed' }], cursor: null });
    });
    const deps = {
      fetch: net.fetch,
      apiKey: 'k',
      baseUrl: UNIPILE,
      sleep: instant,
      random: () => 0,
      clock: Date.now,
    };
    // the ledger is nearly full for the day: one search left for the census
    const day = NOW.toISOString().slice(0, 10);
    await t.db.sql`
      insert into public.orbit_proxy_counters (bucket, count, expires_at)
      values (${`connectors:li:search:${day}:acc-1`}, 39, now() + interval '1 day')`;
    const first = await runCensusStep(t.db, deps, userId, 'acc-1', NOW);
    expect(first).toMatchObject({ pages: 1, seen: 3, matched: 2, done: false, stopped: 'ledger' });
    const facets = await t.db.sql<{ person_id: string; kind: string; value: string }>`
      select person_id, kind, value from orbit.facet_assertions where user_id = ${userId}::uuid order by kind, value`;
    expect(facets).toEqual([
      { person_id: ana, kind: 'company', value: 'Stripe' },
      { person_id: ben, kind: 'place', value: 'New York City Metropolitan Area' },
      { person_id: ana, kind: 'place', value: 'San Francisco Bay Area' },
    ]);
    const locs = await t.db.sql<{ id: string; location: string }>`
      select id, location from orbit.people where id = any(${[ana, ben]}::uuid[])`;
    expect(Object.fromEntries(locs.map((l) => [l.id, l.location]))).toEqual({
      [ana]: 'San Francisco Bay Area',
      [ben]: 'Austin',
    });

    // the next day: resumes from the cursor and finishes the pass
    const next = await runCensusStep(t.db, deps, userId, 'acc-1', new Date('2026-11-09T12:00:00Z'));
    expect(next).toMatchObject({ pages: 1, done: true });
    const [row] = await t.db.sql<{ cursor: string | null; seen: number; pass_done_at: string | null }>`
      select cursor, seen, pass_done_at::text from orbit.search_census where user_id = ${userId}::uuid`;
    expect(row).toMatchObject({ cursor: null, seen: 4 });
    expect(row!.pass_done_at).toBeTruthy();
    expect(net.calls[1]!.url).toContain('cursor=c2');
    // a finished pass is not walked again for 30 days
    expect(await runCensusStep(t.db, deps, userId, 'acc-1', new Date('2026-11-10T12:00:00Z'))).toMatchObject({
      stopped: 'fresh',
    });

    const call = api(t, fakeNet());
    const got = await call<{ facets: { personId: string }[]; census: { seen: number; running: boolean } }>(
      '/search/facets',
      token,
    );
    expect(got.body.facets).toHaveLength(3);
    expect(got.body.census).toMatchObject({ seen: 4, running: false });
  });

  it('takes facets and labels from the browser only for the student own people', async () => {
    const a = await signedInUser(t);
    const b = await signedInUser(t);
    const mine = await addPerson(t, a.userId, { name: 'Cleo Ruiz' });
    const theirs = await addPerson(t, b.userId, { name: 'Dev Shah' });
    const call = api(t, fakeNet());
    const w = await call<{ written: number }>('/search/facets', a.token, {
      facets: [
        { personId: mine, kind: 'school', value: 'Stanford University', positive: true },
        { personId: theirs, kind: 'school', value: 'Stanford University', positive: true },
      ],
    });
    expect(w.body.written).toBe(1);
    const bad = await call('/search/facets', a.token, {
      facets: [{ personId: mine, kind: 'title', value: 'x', positive: true }],
    });
    expect(bad.status).toBe(400);
    const l1 = await call<{ ok: boolean }>('/search/labels', a.token, {
      personId: mine,
      askHash: 'abc123',
      ask: 'stanford founders',
      verdict: 'no',
    });
    expect(l1.body.ok).toBe(true);
    const l2 = await call<{ ok: boolean }>('/search/labels', a.token, {
      personId: theirs,
      askHash: 'abc123',
      ask: 'stanford founders',
      verdict: 'yes',
    });
    expect(l2.body.ok).toBe(false);
    // plan 35 B6: a person judged against an ask goes on the background reading's list; another's never does
    const asked = await t.db.sql<{ user_id: string; person_id: string }>`
      select user_id, person_id from orbit.profile_requests where person_id in (${mine}::uuid, ${theirs}::uuid)`;
    expect(asked).toEqual([{ user_id: a.userId, person_id: mine }]);
  });

  it('looks up one facet while the student waits: positives, a complete scan, a fresh scan answered from store', async () => {
    const { userId, token } = await signedInUser(t);
    const ana = await addPerson(t, userId, { name: 'Ana Park', memberId: 'ACoAna2' });
    await addPerson(t, userId, { name: 'Ben Ode', memberId: 'ACoBen2' });
    const net = fakeNet((c) => {
      if (c.url.includes('/linkedin/search/parameters')) {
        if (c.url.includes('keywords=Nowhere+Co')) return jsonRes(200, { items: [] });
        return jsonRes(200, { items: [{ id: '2135371', title: 'Stripe' }] });
      }
      if (c.url.startsWith(`${UNIPILE}/api/v1/linkedin/search`))
        return jsonRes(200, {
          items: [
            { id: 'ACoAna2', name: 'Ana Park', current_positions: [{ company: 'Stripe' }] },
            { id: 'ACoOther', name: 'Not Known' },
          ],
          cursor: null,
        });
      return undefined;
    });
    const deps = { fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE };
    const r = await runFacetLookup(t.db, deps, userId, 'acc-9', 'company', 'Stripe', NOW);
    expect(r).toMatchObject({ ok: true, personIds: [ana], complete: true });
    const body = net.calls.find((c) => c.url.includes('/linkedin/search?'))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ network_distance: [1], company: ['2135371'] });
    // a week later it is still fresh: no LinkedIn call
    const before = net.calls.length;
    const again = await runFacetLookup(
      t.db,
      deps,
      userId,
      'acc-9',
      'company',
      'Stripe',
      new Date('2026-11-12T12:00:00Z'),
    );
    expect(again).toMatchObject({ ok: true, cached: true, personIds: [ana], complete: true });
    expect(net.calls.length).toBe(before);
    // a filter LinkedIn does not know is refused, never searched as words
    expect(await runFacetLookup(t.db, deps, userId, 'acc-9', 'company', 'Nowhere Co', NOW)).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
    // the browser reads the complete scan with the facets
    const got = await api(t, fakeNet())<{ scans: { kind: string; value: string }[] }>(
      '/search/facets',
      token,
    );
    expect(got.body.scans).toEqual([expect.objectContaining({ kind: 'company', value: 'Stripe' })]);
    // without a LinkedIn account the route says so
    const off = await api(t, fakeNet())<{ ok: boolean; reason: string }>('/search/lookup', token, {
      kind: 'school',
      value: 'Stanford University',
    });
    expect(off.body).toMatchObject({ ok: false });
  });
});
