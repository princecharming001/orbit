/**
 * Plan 37 on PGlite: logos.user looks up every company in one student's network and every company they target,
 * targets first, then their people's current companies, then the companies in the work histories Orbit read. A
 * company a read profile names by LinkedIn's id is settled by that id for this student only; a name is taken only when
 * LinkedIn's search answers it plainly; a name it cannot settle is read from one of the student's own people who works
 * there. The student's own account's shares of its company and profile ledgers are the limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  keepProfileLogos,
  sameCompanyName,
  searchName,
} from '../../functions/_shared/providers/linkedinCompanies.ts';
import {
  positionFor,
  runUserLogos,
  sqlCompanyCache,
  USER_SHARE,
  userLogoCandidates,
} from '../../functions/_shared/search/logoSweep.ts';
import { profileOrgs } from '../../functions/_shared/search/reading.ts';
import { searchHandlers } from '../../functions/orbit-worker/handlers/search.ts';
import { connectedUser } from '../helpers/ingest.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await t.pg.exec(`delete from orbit_private.linkedin_companies; delete from public.orbit_proxy_counters;
    delete from orbit.users;`);
});

const NOW = new Date('2026-11-12T10:23:00Z');
const BASE = 'https://api1.unipile.test';
const logo = (n: string) => `https://media.licdn.com/dms/image/v2/${n}/company-logo_200_200?e=1900000000&t=x`;

async function person(userId: string, org: string) {
  const [p] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, name_norm, org_raw)
    values (${userId}::uuid, ${`P ${org}`}, ${`p ${org.toLowerCase()} ${Math.random()}`}, ${org})
    returning id`;
  return p!.id;
}

/** Unipile: a search answers every name with one company of that name; Weave's page by its id. */
function fakeUnipile() {
  const asked: string[] = [];
  const doFetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.hostname === 'media.licdn.com')
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    if (u.pathname.startsWith('/api/v1/linkedin/company/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      asked.push(`page:${id}`);
      if (id === '4242') return Response.json({ id: '4242', name: 'Weave', logo: logo('weave') });
      return new Response('{}', { status: 404 });
    }
    if (u.pathname === '/api/v1/linkedin/search') {
      const kw = String(JSON.parse(String(init.body)).keywords);
      asked.push(`search:${kw}`);
      const id = String(Math.abs([...kw].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)));
      return Response.json({ items: [{ id, name: kw, logo: logo(id) }] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch: doFetch, asked };
}

const deps = (f: ReturnType<typeof fakeUnipile>, clock = () => 0) => ({
  fetch: f.fetch,
  apiKey: 'u-key',
  baseUrl: BASE,
  storeLogo: async (id: string) => `https://store.test/storage/v1/object/public/company-logos/${id}.png`,
  sleep: async () => {},
  random: () => 0,
  clock,
});

describe('logos.user', () => {
  it('cleans what was typed after a company', () => {
    expect(searchName('Deel (YC W19)')).toBe('Deel');
    expect(searchName('Weave YC W25')).toBe('Weave');
    expect(searchName('Intuit - ex PayPal payments')).toBe('Intuit');
    expect(searchName('Acme | Growth')).toBe('Acme');
    expect(searchName('Context [YC S26]')).toBe('Context');
    expect(searchName('Capital One')).toBe('Capital One');
    expect(searchName('M&T Bank')).toBe('M&T Bank');
  });

  it('takes a name as the same only in every script, or as the short name in brackets', () => {
    expect(sameCompanyName('Stripe, Inc.', 'stripe')).toBe(true);
    expect(sameCompanyName('AWS بالعربي', 'AWS')).toBe(false);
    expect(sameCompanyName('Amazon Web Services (AWS)', 'AWS')).toBe(true);
    expect(sameCompanyName('Nestlé', 'Nestle')).toBe(true);
    expect(sameCompanyName('Stripe Partners', 'Stripe')).toBe(false);
  });

  it('a school is looked up on LinkedIn like any company (LinkedIn lists schools: San José State University)', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-s' });
    await person(a, 'UCSC');
    await person(a, 'Ramp');
    const c = await userLogoCandidates(t.db, a);
    expect(c.map((x) => x.name).sort()).toEqual(['Ramp', 'UCSC']);
  });

  it('the student’s target companies come first, even with nobody there yet', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-t' });
    await person(a, 'Ramp');
    await person(a, 'Ramp');
    await t.db.sql`
      insert into orbit.goals (user_id, kind, title, targets)
      values (${a}::uuid, 'recruiting', 'Land an internship', ${JSON.stringify({
        organizations: ['Triumph', 'Ramp'],
      })}::jsonb)`;
    const c = await userLogoCandidates(t.db, a);
    expect(
      c
        .slice(0, 2)
        .map((x) => [x.name, x.target ?? false])
        .sort(),
    ).toEqual([
      ['Ramp', true],
      ['Triumph', true],
    ]);
    expect(c.find((x) => x.name === 'Ramp')!.now).toBe(2);
  });

  it('looks up every company in the network, current ones first, by id when a read profile gives one', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-u' });
    const other = await makeUser(t.db);
    const maya = await person(a, 'Ramp');
    await person(a, 'Ramp');
    await person(a, 'Tiny Co'); // one person: looked up too
    await person(a, 'Deel (YC W19)');
    await person(a, 'Stanford University'); // a school: its own icon
    await person(other, 'Someone Else Inc'); // another student's: not this run's
    // Maya's work history: Weave before Ramp, named by LinkedIn's id
    await t.db.sql`
      insert into orbit.affiliations (user_id, person_id, org_raw, kind, is_current, source)
      values (${a}::uuid, ${maya}::uuid, 'Weave', 'employment', false, 'linkedin_profile')`;
    await t.db.sql`
      insert into orbit.profile_reads (user_id, person_id, experience)
      values (${a}::uuid, ${maya}::uuid, ${JSON.stringify([
        { company: 'Ramp', current: true },
        { company: 'Weave', companyId: '4242', current: false },
      ])}::jsonb)`;
    const c = await userLogoCandidates(t.db, a);
    expect(c.map((x) => x.name)).toEqual([
      'Ramp',
      'Deel (YC W19)',
      'Stanford University',
      'Tiny Co',
      'Weave',
    ]);
    expect(c.find((x) => x.name === 'Weave')!.companyId).toBe('4242');

    const f = fakeUnipile();
    const r = await runUserLogos(t.db, a, deps(f), NOW);
    expect(r).toMatchObject({ candidates: 5, looked: 5, found: 5, remaining: 0, accounts: 1 });
    expect(f.asked).toEqual([
      'search:Ramp',
      'search:Deel',
      'search:Stanford University',
      'search:Tiny Co',
      'page:4242',
    ]);
    const rows = await t.db.sql<{ key: string; logo_url: string | null }>`
      select key, logo_url from orbit_private.linkedin_companies order by key`;
    expect(rows.map((x) => x.key)).toEqual(['deel yc w19', 'ramp', 'stanford university', 'tiny']);
    expect(rows.every((x) => x.logo_url?.startsWith('https://store.test/'))).toBe(true);
    // Weave, named by a position, is this student's pick: never everyone's under the name
    const picks = await t.db.sql<{ account_id: string; key: string; company_id: string; logo_url: string }>`
      select account_id, key, company_id, logo_url from orbit_private.linkedin_company_picks`;
    expect(picks).toEqual([
      {
        account_id: 'acc-u',
        key: 'weave',
        company_id: '4242',
        logo_url: 'https://store.test/storage/v1/object/public/company-logos/4242.png',
      },
    ]);

    // the next day: all kept, nothing asked; the student's companies all have a logo
    const again = fakeUnipile();
    const r2 = await runUserLogos(t.db, a, deps(again), new Date(NOW.getTime() + 86_400_000));
    expect(r2).toMatchObject({ looked: 0, remaining: 0, withLogo: 5 });
    expect(again.asked).toEqual([]);
  });

  it('stops at its share of the student account’s company ledger', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-v' });
    for (let i = 0; i < 130; i++) await person(a, `Firm ${i}`);
    const r = await runUserLogos(t.db, a, deps(fakeUnipile()), NOW);
    expect(r.stopped).toBe('limit');
    const [used] = await t.db.sql<{ count: number }>`
      select count from public.orbit_proxy_counters where bucket = ${'connectors:li:company:2026-11-12:acc-v'}`;
    expect(used!.count).toBe(Math.round(150 * USER_SHARE));
    expect(r.remaining).toBe(130 - Math.round(150 * USER_SHARE));
  });

  it('the handler queues the next part while time ran out, and the cron queues every connected student', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-w' });
    for (let i = 0; i < 5; i++) await person(a, `Shop ${i}`);
    const queued: { kind: string; dedupeKey?: string }[] = [];
    let ms = 0;
    await searchHandlers({
      fetch: fakeUnipile().fetch,
      unipile: { apiKey: 'k', baseUrl: BASE },
      storage: { url: 'https://store.test', serviceKey: 'service-role-placeholder' },
      sleep: async () => {},
      random: () => 0,
      // each read takes 20 seconds: the part runs out of time after a few
      clock: () => (ms += 10_000),
    })['logos.user']!(
      { queue: 'orbit_enrich', msgId: 1, readCt: 1, kind: 'logos.user', userId: a, payload: { part: 0 } },
      {
        db: t.db,
        now: () => NOW,
        queue: {
          enqueue: async (m) => {
            queued.push(m);
            return 1;
          },
          read: async () => [],
          delete: async () => {},
          archive: async () => {},
          setVt: async () => {},
        },
      },
    );
    expect(queued).toEqual([
      expect.objectContaining({ kind: 'logos.user', dedupeKey: `logos.user:${a}:2026-11-12:1` }),
    ]);
    const [n] = await t.db.sql<{ n: number }>`select orbit.enqueue_logos_users() as n`;
    expect(n!.n).toBe(1);
  });

  it('a profile read keeps copies of the logos on it, as the reading account’s picks, never everyone’s', async () => {
    const orgs = profileOrgs({
      work_experience: [
        { company: 'Weave', company_id: 4242, company_picture_url: logo('weave') },
        { company: 'No Logo Co', company_id: '77' },
      ],
      education: [{ school: 'Cornell University', school_id: '1234', school_picture_url: logo('cornell') }],
    });
    expect(orgs).toHaveLength(2);
    const f = fakeUnipile();
    const cache = sqlCompanyCache(t.db, deps(f).storeLogo);
    expect(await keepProfileLogos(cache, orgs, f.fetch, NOW, { accountId: 'acc-p' })).toBe(2);
    expect(orgs[0]!.logoUrl).toBe('https://store.test/storage/v1/object/public/company-logos/4242.png');
    const rows = await t.db.sql`select key from orbit_private.linkedin_companies`;
    expect(rows).toEqual([]);
    const picks = await t.db.sql<{ key: string; company_id: string }>`
      select key, company_id from orbit_private.linkedin_company_picks where account_id = 'acc-p' order by key`;
    expect(picks).toEqual([
      { key: 'cornell university', company_id: '1234' },
      { key: 'weave', company_id: '4242' },
    ]);
    expect(f.asked).toEqual([]);
  });

  it('a found row for that very company without a logo gets the profile’s copy', async () => {
    const cache = sqlCompanyCache(t.db, deps(fakeUnipile()).storeLogo);
    await cache.put({ key: 'weave', status: 'found', companyId: '4242', checkedAt: NOW.toISOString() });
    await cache.put({ key: 'nova', status: 'found', companyId: '9509', checkedAt: NOW.toISOString() });
    const orgs = profileOrgs({
      work_experience: [
        { company: 'Weave', company_id: 4242, company_picture_url: logo('weave') },
        // another Nova than the one the shared list keeps: it is left alone
        { company: 'Nova', company_id: '43215181', company_picture_url: logo('nova-sf') },
      ],
    });
    await keepProfileLogos(cache, orgs, fakeUnipile().fetch, NOW);
    const rows = await t.db.sql<{ key: string; company_id: string; logo_url: string | null }>`
      select key, company_id, logo_url from orbit_private.linkedin_companies order by key`;
    expect(rows).toEqual([
      { key: 'nova', company_id: '9509', logo_url: null },
      {
        key: 'weave',
        company_id: '4242',
        logo_url: 'https://store.test/storage/v1/object/public/company-logos/4242.png',
      },
    ]);
  });

  it('settles a company from a profile Orbit already read, for free, for this student only', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-r' });
    const p = await person(a, 'Nova');
    await t.db.sql`
      insert into orbit.profile_reads (user_id, person_id, status, experience)
      values (${a}::uuid, ${p}::uuid, 'ok', ${JSON.stringify([
        { company: 'Nova (acquired)', companyId: '43215181', current: true },
        { company: 'Stripe', companyId: '2135371', current: false },
      ])}::jsonb)`;
    const cache = sqlCompanyCache(t.db, deps(fakeUnipile()).storeLogo);
    // the shared list took the Madrid Nova for the name under older rules
    await cache.put({
      key: 'nova',
      status: 'found',
      companyId: '9509',
      logoUrl: 'https://store.test/9509.png',
      checkedAt: '2026-11-01T00:00:00Z',
      rules: 1,
    });
    const f = fakeUnipile();
    const r = await runUserLogos(
      t.db,
      a,
      {
        ...deps(f),
        logosBase: 'https://store.test/storage/v1/object/public/company-logos',
        fetch: (async (url: string, init?: RequestInit) =>
          url.endsWith('/43215181.png')
            ? new Response('', { status: 200 })
            : f.fetch(url, init)) as typeof fetch,
      },
      NOW,
    );
    expect(r.fromReads).toBe(1);
    const [pick] = await t.db.sql<{ company_id: string; logo_url: string }>`
      select company_id, logo_url from orbit_private.linkedin_company_picks where account_id = 'acc-r' and key = 'nova'`;
    expect(pick).toEqual({
      company_id: '43215181',
      logo_url: 'https://store.test/storage/v1/object/public/company-logos/43215181.png',
    });
    // the shared list is not decided by one student's people: its row stays until LinkedIn's search says otherwise
    const [shared] = await t.db.sql<{ status: string; logo_url: string | null }>`
      select status, logo_url from orbit_private.linkedin_companies where key = 'nova'`;
    expect(shared).toEqual({ status: 'found', logo_url: 'https://store.test/9509.png' });
    // no search was spent on Nova
    expect(f.asked.filter((x) => x.includes('Nova'))).toEqual([]);
  });

  it('a name LinkedIn cannot settle is read from one of the student’s own people who works there', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-n' });
    const p = await person(a, 'Triumph');
    await t.db.sql`update orbit.people set linkedin_member_id = 'ACoTRI' where id = ${p}::uuid`;
    const asked: string[] = [];
    const doFetch = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      if (u.hostname === 'media.licdn.com')
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
      if (u.pathname === '/api/v1/linkedin/search') {
        asked.push(`search:${JSON.parse(String(init.body)).keywords}`);
        return Response.json({
          items: [
            { id: '74900938', name: 'Triumph', logo: logo('labs') },
            { id: '50454', name: 'TRIUMPH', logo: logo('group') },
          ],
        });
      }
      if (u.pathname === '/api/v1/users/ACoTRI') {
        asked.push('profile:ACoTRI');
        return Response.json({
          provider_id: 'ACoTRI',
          work_experience: [
            {
              company: 'Triumph',
              company_id: '74900938',
              company_picture_url: logo('labs'),
              position: 'Engineer',
              start: '2024-01-01',
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const r = await runUserLogos(t.db, a, { ...deps({ fetch: doFetch, asked }), fetch: doFetch }, NOW);
    expect(asked).toEqual(['search:Triumph', 'profile:ACoTRI']);
    expect(r).toMatchObject({ peopleRead: 1, withLogo: 1, remaining: 0 });
    const [pick] = await t.db.sql<{ company_id: string; logo_url: string }>`
      select company_id, logo_url from orbit_private.linkedin_company_picks where account_id = 'acc-n' and key = 'triumph'`;
    expect(pick).toEqual({
      company_id: '74900938',
      logo_url: 'https://store.test/storage/v1/object/public/company-logos/74900938.png',
    });
    // the shared list keeps saying the name alone is not enough
    const [shared] = await t.db.sql<{ status: string }>`
      select status from orbit_private.linkedin_companies where key = 'triumph'`;
    expect(shared!.status).toBe('ambiguous');
    // the profile was kept, so nothing reads it again
    const [read] = await t.db.sql<{
      status: string;
    }>`select status from orbit.profile_reads where person_id = ${p}::uuid`;
    expect(read!.status).toBe('ok');
  });

  it('checks rows found under older rules again: the same first result stays, another company loses its logo', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-c' });
    await person(a, 'Tesla');
    await person(a, 'Smith');
    await person(a, 'Dell');
    const cache = sqlCompanyCache(t.db, deps(fakeUnipile()).storeLogo);
    const old = '2026-11-01T00:00:00Z';
    await cache.put({
      key: 'tesla',
      status: 'found',
      companyId: '15564',
      logoUrl: 'https://store.test/15564.png',
      checkedAt: old,
    });
    await cache.put({
      key: 'smith',
      status: 'found',
      companyId: '1021736',
      logoUrl: 'https://store.test/1021736.png',
      checkedAt: old,
    });
    // Dell's page, renamed Dell Technologies since: LinkedIn still answers "Dell" with it first
    await cache.put({
      key: 'dell',
      status: 'found',
      companyId: '15088102',
      logoUrl: 'https://store.test/15088102.png',
      checkedAt: old,
    });
    await t.db.sql`update orbit_private.linkedin_companies set rules = 1`;
    const doFetch = (async (url: string, init: RequestInit = {}) => {
      const kw = String(JSON.parse(String(init.body ?? '{}')).keywords ?? '');
      if (kw === 'Tesla')
        return Response.json({
          items: [
            { id: '15564', name: 'Tesla', logo: logo('tesla') },
            { id: '600000', name: 'Tesla' },
          ],
        });
      if (kw === 'Dell')
        return Response.json({
          items: [
            { id: '15088102', name: 'Dell Technologies' },
            { id: '93225', name: 'Michael & Susan Dell Foundation' },
          ],
        });
      if (kw === 'Smith')
        return Response.json({
          items: [
            { id: '17700', name: 'Smith' },
            { id: '2715458', name: 'Smith' },
          ],
        });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    await runUserLogos(t.db, a, { ...deps(fakeUnipile()), fetch: doFetch }, NOW);
    const rows = await t.db.sql<{
      key: string;
      status: string;
      company_id: string | null;
      logo_url: string | null;
    }>`
      select key, status, company_id, logo_url from orbit_private.linkedin_companies order by key`;
    expect(rows).toEqual([
      { key: 'dell', status: 'found', company_id: '15088102', logo_url: 'https://store.test/15088102.png' },
      { key: 'smith', status: 'ambiguous', company_id: null, logo_url: null },
      { key: 'tesla', status: 'found', company_id: '15564', logo_url: 'https://store.test/15564.png' },
    ]);
  });

  it('a person’s current job settles their row only when LinkedIn names it the same: never a job they moved to', () => {
    const exp = [
      { company: 'OpenAI', companyId: '11130470', current: true },
      { company: 'Google', companyId: '1441', current: false },
    ];
    // the row still says Google (out of date): Google's logo is not OpenAI's, and the old job is not current
    expect(positionFor(exp, 'Google')).toBeUndefined();
    expect(positionFor(exp, 'OpenAI')).toMatchObject({ companyId: '11130470' });
    // the name as people type it, and as LinkedIn writes it
    expect(positionFor([{ company: 'Deel', companyId: '1', current: true }], 'Deel (YC W19)')).toMatchObject({
      companyId: '1',
    });
    expect(
      positionFor([{ company: 'Amazon Web Services (AWS)', companyId: '2', current: true }], 'AWS'),
    ).toMatchObject({ companyId: '2' });
    expect(
      positionFor([{ company: 'Nova (acquired)', companyId: '3', current: true }], 'Nova'),
    ).toMatchObject({
      companyId: '3',
    });
    // several current jobs: the one the row names
    expect(
      positionFor(
        [
          { company: 'Stanford University', companyId: '9', current: true },
          { company: 'Ramp', companyId: '1406226', current: true },
        ],
        'Ramp',
      ),
    ).toMatchObject({ companyId: '1406226' });
    expect(positionFor([{ company: 'Ramp', current: true }], 'Ramp')).toBeUndefined();
    expect(positionFor([], 'Ramp')).toBeUndefined();
  });

  it('a row today’s rules found is never taken from everyone by one student’s profile, only overruled for them', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-m' });
    const p = await person(a, 'Meta');
    await t.db.sql`
      insert into orbit.profile_reads (user_id, person_id, status, experience)
      values (${a}::uuid, ${p}::uuid, 'ok', ${JSON.stringify([
        { company: 'Meta', companyId: '77777777', current: true },
      ])}::jsonb)`;
    const cache = sqlCompanyCache(t.db, deps(fakeUnipile()).storeLogo);
    await cache.put({
      key: 'meta',
      status: 'found',
      companyId: '10667',
      logoUrl: 'https://store.test/10667.png',
      checkedAt: NOW.toISOString(),
      rules: 2,
    });
    await runUserLogos(t.db, a, deps(fakeUnipile()), NOW);
    const [shared] = await t.db.sql<{ status: string; logo_url: string }>`
      select status, logo_url from orbit_private.linkedin_companies where key = 'meta'`;
    expect(shared).toEqual({ status: 'found', logo_url: 'https://store.test/10667.png' });
    const [pick] = await t.db.sql<{ company_id: string }>`
      select company_id from orbit_private.linkedin_company_picks where account_id = 'acc-m' and key = 'meta'`;
    expect(pick!.company_id).toBe('77777777');
  });

  it('spends no profile read on a company LinkedIn already showed without a logo', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-z' });
    const p = await person(a, 'Quiet Co');
    await t.db.sql`update orbit.people set linkedin_member_id = 'ACoQ' where id = ${p}::uuid`;
    const cache = sqlCompanyCache(t.db, deps(fakeUnipile()).storeLogo);
    await cache.put({
      key: 'quiet',
      status: 'found',
      companyId: '5',
      checkedAt: NOW.toISOString(),
      rules: 2,
    });
    const f = fakeUnipile();
    const r = await runUserLogos(t.db, a, deps(f), NOW);
    expect(r.peopleRead).toBe(0);
    expect(f.asked).toEqual([]);
  });

  it('a company settled without a logo has its page read by id for one, then not again for a week', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-l' });
    const p = await person(a, 'Rho');
    await t.db.sql`
      insert into orbit.profile_reads (user_id, person_id, status, experience)
      values (${a}::uuid, ${p}::uuid, 'ok', ${JSON.stringify([{ company: 'Rho', companyId: '13051540', current: true }])}::jsonb)`;
    const asked: string[] = [];
    const doFetch = (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'media.licdn.com')
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
      if (u.pathname.startsWith('/api/v1/linkedin/company/')) {
        asked.push(u.pathname);
        return Response.json({ id: '13051540', name: 'Rho', logo: logo('rho') });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    await runUserLogos(t.db, a, { ...deps({ fetch: doFetch, asked }), fetch: doFetch }, NOW);
    expect(asked).toEqual(['/api/v1/linkedin/company/13051540']);
    const [pick] = await t.db.sql<{ logo_url: string }>`
      select logo_url from orbit_private.linkedin_company_picks where account_id = 'acc-l' and key = 'rho'`;
    expect(pick!.logo_url).toBe('https://store.test/storage/v1/object/public/company-logos/13051540.png');
    // a company whose page has no logo is not read again the next day
    await t.db
      .sql`update orbit_private.linkedin_company_picks set logo_url = null where account_id = 'acc-l'`;
    asked.length = 0;
    await runUserLogos(
      t.db,
      a,
      { ...deps({ fetch: doFetch, asked }), fetch: doFetch },
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(asked).toEqual([]);
  });
});
