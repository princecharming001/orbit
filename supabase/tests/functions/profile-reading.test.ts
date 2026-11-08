import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Claude } from '../../functions/_shared/claude.ts';
import { censusPeople } from '../../functions/_shared/search/census.ts';
import { loadCompanyFacts } from '../../functions/_shared/search/companyFacts.ts';
import { dateOf, experienceOf, pageOf, runReadingStep } from '../../functions/_shared/search/reading.ts';
import { addPerson, api, fakeNet, instant, jsonRes, signedInUser, UNIPILE } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

/**
 * Profile reading on the server (plan 33): company pages and profiles read inside their ledger shares, About filled
 * where Orbit had none, and Claude's reading kept only where its quotes are really in the text.
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const NOW = new Date('2026-11-08T12:00:00Z');

const RAMP_PAGE = {
  object: 'CompanyProfile',
  id: '1406226',
  name: 'Ramp',
  description: 'Ramp is a finance platform. We raised a $150M Series D led by Founders Fund.',
  tagline: 'The AI finance platform',
  public_identifier: 'ramp',
  website: 'https://ramp.com',
  industry: ['Financial Services'],
  employee_count: 2900,
  employee_count_range: { from: 1001, to: 5000 },
  foundation_date: '01/01/2019',
  locations: [{ city: 'New York', area: 'NY', country: 'US', is_headquarter: true }],
  insights: { employeesCount: { totalCount: 2900, growthGraph: [{ monthRange: 12, growthPercentage: 48 }] } },
};

describe('shapes', () => {
  it('reads Unipile dates, jobs and company pages', () => {
    expect(dateOf('1/1/2025')).toBe('2025-01');
    expect(dateOf('11/3/2019')).toBe('2019-11');
    expect(dateOf({ year: 2021, month: 6 })).toBe('2021-06');
    expect(dateOf('2024-03-01')).toBe('2024-03');
    expect(dateOf(null)).toBeUndefined();
    expect(
      experienceOf([
        { position: 'Founder', company: 'Lumen', company_id: '555', start: '1/1/2025', end: null },
        { position: 'SWE', company: 'Google', company_id: 1441, start: '6/1/2021', end: '12/1/2024' },
        { status: 'Full-time' },
      ]),
    ).toEqual([
      { title: 'Founder', company: 'Lumen', companyId: '555', current: true, start: '2025-01' },
      {
        title: 'SWE',
        company: 'Google',
        companyId: '1441',
        current: false,
        start: '2021-06',
        end: '2024-12',
      },
    ]);
    expect(pageOf('1406226', RAMP_PAGE)).toMatchObject({
      name: 'Ramp',
      employeeCount: 2900,
      growth12m: 48,
      foundedYear: 2019,
      industries: ['Financial Services'],
      hq: 'New York, NY, US',
    });
  });

  it('keeps the census company ids', () => {
    expect(
      censusPeople([{ id: 'A', name: 'Ana', current_positions: [{ company: 'Ramp', company_id: 1406226 }] }]),
    ).toEqual([
      {
        memberId: 'A',
        name: 'Ana',
        companies: ['Ramp'],
        companyIds: { Ramp: '1406226' },
        headline: undefined,
        location: undefined,
      },
    ]);
  });
});

/** A Claude stand-in: answers people with one true quote and one made up, companies with a stage. */
function fakeClaude(calls: string[]): Claude {
  return {
    configured: true,
    structured: (async (req: { task: string; user: string; system: string }) => {
      calls.push(req.user);
      if (req.system.startsWith('You read the LinkedIn About sections of companies'))
        return {
          ok: true,
          data: {
            companies: [
              {
                company: 'C1',
                stage: 'series_b_plus',
                quote: 'raised a $150M Series D',
                kind: 'startup',
                what: 'Corporate cards and spend',
              },
            ],
          },
          model: 'claude-haiku-5-5',
          costUsd: 0,
          usage: {},
        };
      return {
        ok: true,
        data: {
          people: [
            {
              person: 'P1',
              facts: [
                { kind: 'stage', value: 'seed', company: 'Lumen', quote: 'we just closed our seed round' },
                { kind: 'team_size', value: '9', company: 'Lumen', quote: 'a team of 9' },
                {
                  kind: 'focus',
                  value: 'AI agents for insurance',
                  company: '',
                  quote: 'AI agents for insurance claims',
                },
                // not in the text: dropped
                { kind: 'signal', value: 'raising', company: '', quote: 'we are raising a Series A now' },
                { kind: 'signal', value: 'hiring', company: '', quote: "We're hiring engineers" },
              ],
            },
          ],
        },
        model: 'claude-haiku-5-5',
        costUsd: 0,
        usage: {},
      };
    }) as unknown as Claude['structured'],
  };
}

describe('a reading step', () => {
  it('reads company pages and profiles inside its shares, fills About, keeps only quoted facts', async () => {
    const { userId, token } = await signedInUser(t);
    const ana = await addPerson(t, userId, { name: 'Ana Park', memberId: 'ACoAna' });
    const ben = await addPerson(t, userId, { name: 'Ben Ode', memberId: 'ACoBen' });
    await t.db.sql`update orbit.people set headline = 'Founder @ Lumen' where id = ${ana}::uuid`;
    await t.db.sql`update orbit.people set summary = 'Written by the student' where id = ${ben}::uuid`;
    // the census saw Ben at Ramp, with Ramp's LinkedIn id
    await t.db.sql`
      insert into orbit.facet_assertions (user_id, person_id, kind, value, positive, source, ref)
      values (${userId}::uuid, ${ben}::uuid, 'company', 'Ramp', true, 'census', '1406226')`;
    const net = fakeNet((c) => {
      if (c.url.startsWith(`${UNIPILE}/api/v1/linkedin/company/1406226`)) return jsonRes(200, RAMP_PAGE);
      if (c.url.startsWith(`${UNIPILE}/api/v1/linkedin/company/555`))
        return jsonRes(200, { id: '555', name: 'Lumen', employee_count: 9, website: 'https://lumen.dev' });
      if (c.url.startsWith(`${UNIPILE}/api/v1/users/ACoAna`))
        return jsonRes(200, {
          summary:
            "Building Lumen: AI agents for insurance claims. We're hiring engineers, and we just closed our seed round with a team of 9.",
          work_experience: [{ position: 'Founder', company: 'Lumen', company_id: '555', start: '1/1/2025' }],
        });
      if (c.url.startsWith(`${UNIPILE}/api/v1/users/ACoBen`))
        return jsonRes(200, {
          summary: 'Finance at Ramp.',
          work_experience: [{ position: 'Finance', company: 'Ramp', company_id: '1406226' }],
        });
      return undefined;
    });
    const calls: string[] = [];
    const deps = {
      fetch: net.fetch,
      apiKey: 'k',
      baseUrl: UNIPILE,
      claude: fakeClaude(calls),
      sleep: instant,
      random: () => 0,
      clock: Date.now,
    };
    const step = await runReadingStep(t.db, deps, userId, 'acc-r', NOW);
    expect(step).toMatchObject({ companies: 1, profiles: 2 });
    // profiles ask for About and experience without telling the person
    const profileCall = net.calls.find((c) => c.url.includes('/users/ACoAna'))!;
    expect(profileCall.url).toContain('notify=false');
    expect(profileCall.url).toContain('linkedin_sections=about&linkedin_sections=experience');

    const people = await t.db.sql<{ id: string; summary: string | null }>`
      select id, summary from orbit.people where id = any(${[ana, ben]}::uuid[])`;
    const summary = Object.fromEntries(people.map((p) => [p.id, p.summary]));
    expect(summary[ana]).toContain('Building Lumen');
    // an About someone else wrote is never replaced
    expect(summary[ben]).toBe('Written by the student');

    const [read] = await t.db.sql<{ reading: Record<string, unknown>; experience: unknown[] }>`
      select reading, experience from orbit.profile_reads where person_id = ${ana}::uuid`;
    expect(read!.experience).toHaveLength(1);
    expect(read!.reading).toMatchObject({
      stage: { value: 'seed', quote: 'we just closed our seed round', company: 'Lumen' },
      teamSize: { value: 9, quote: 'a team of 9' },
      focus: [{ value: 'AI agents for insurance' }],
      signals: [{ value: 'hiring' }],
    });
    // the made-up quote did not survive
    expect(JSON.stringify(read!.reading)).not.toContain('raising');

    // Ramp's page: a shared fact with headcount, founding year, growth, and the stage its own About states
    const { facts } = await loadCompanyFacts(t.db);
    const ramp = facts.find((f) => f.linkedinId === '1406226');
    expect(ramp).toMatchObject({
      source: 'linkedin',
      name: 'Ramp',
      teamSize: 2900,
      foundedYear: 2019,
      growth12m: 48,
      stage: 'series_b_plus',
      stageEvidence: 'raised a $150M Series D',
      kind: 'startup',
    });

    // the next step reads Lumen's page (named by Ana's job) and nobody already read
    const again = await runReadingStep(t.db, deps, userId, 'acc-r', NOW);
    expect(again).toMatchObject({ companies: 1, profiles: 0 });

    // the browser's pull
    const call = api(t, fakeNet());
    const got = await call<{
      profiles: { personId: string; reading?: unknown }[];
      progress: { read: number };
    }>('/search/profiles', token);
    expect(got.body.profiles.map((p) => p.personId).sort()).toEqual([ana, ben].sort());
    expect(got.body.progress.read).toBe(2);
  });

  it('stops at its share of the profile ledger and reads by pattern without Claude', async () => {
    const { userId } = await signedInUser(t);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(await addPerson(t, userId, { name: `Pat ${i}`, memberId: `ACoPat${i}` }));
    const day = NOW.toISOString().slice(0, 10);
    // background reads may fill the profile ledger to 30 of 100: one left
    await t.db.sql`
      insert into public.orbit_proxy_counters (bucket, count, expires_at)
      values (${`connectors:li:profile:${day}:acc-p`}, 29, now() + interval '1 day')`;
    const net = fakeNet((c) =>
      c.url.includes('/api/v1/users/')
        ? jsonRes(200, {
            summary: 'Founding engineer at a Series A startup. Team of 14.',
            work_experience: [],
          })
        : undefined,
    );
    const step = await runReadingStep(
      t.db,
      { fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE, sleep: instant, random: () => 0, clock: Date.now },
      userId,
      'acc-p',
      NOW,
    );
    expect(step).toMatchObject({ profiles: 1, stopped: 'ledger' });
    const [r] = await t.db.sql<{ reading: Record<string, unknown> }>`
      select reading from orbit.profile_reads where user_id = ${userId}::uuid`;
    expect(r!.reading).toMatchObject({ stage: { value: 'series_a' }, teamSize: { value: 14 } });
  });

  it('the read route checks its input and needs LinkedIn', async () => {
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Ida Lane', memberId: 'ACoIda' });
    const call = api(t, fakeNet());
    expect((await call('/search/read', token, { personIds: [] })).status).toBe(400);
    expect((await call('/search/read', token, { personIds: Array(7).fill(p) })).status).toBe(400);
    const off = await call<{ ok: boolean; reason: string }>('/search/read', token, { personIds: [p] });
    expect(off.body).toMatchObject({ ok: false });
  });
});
