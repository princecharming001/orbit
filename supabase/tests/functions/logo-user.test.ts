/**
 * Plan 37 follow-up on PGlite: logos.user looks up every company in one student's network (not only those 3 or more
 * people share), their people's current companies first, then the companies in the work histories Orbit read; a
 * company a read profile names by LinkedIn's id is read by that id, a messy name is searched for the company alone,
 * schools are left to their own icons, and the student's own account's share of its company ledger is the limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  keepProfileLogos,
  sameCompanyName,
  searchName,
} from '../../functions/_shared/providers/linkedinCompanies.ts';
import {
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

  it('leaves names people list under education to their own icons', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-s' });
    const maya = await person(a, 'UCSC');
    await person(a, 'Ramp');
    for (const org of ['UCSC', 'Rutgers'])
      await t.db.sql`
        insert into orbit.affiliations (user_id, person_id, org_raw, kind, source)
        values (${a}::uuid, ${maya}::uuid, ${org}, 'education', 'linkedin_profile')`;
    const c = await userLogoCandidates(t.db, a);
    expect(c.map((x) => x.name)).toEqual(['Ramp']);
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
    expect(c.map((x) => x.name)).toEqual(['Ramp', 'Deel (YC W19)', 'Tiny Co', 'Weave']);
    expect(c.find((x) => x.name === 'Weave')!.companyId).toBe('4242');

    const f = fakeUnipile();
    const r = await runUserLogos(t.db, a, deps(f), NOW);
    expect(r).toMatchObject({ candidates: 4, looked: 4, found: 4, remaining: 0, accounts: 1 });
    expect(f.asked).toEqual(['search:Ramp', 'search:Deel', 'search:Tiny Co', 'page:4242']);
    const rows = await t.db.sql<{ key: string; logo_url: string | null }>`
      select key, logo_url from orbit_private.linkedin_companies order by key`;
    expect(rows.map((x) => x.key)).toEqual(['deel yc w19', 'ramp', 'tiny', 'weave']);
    expect(rows.every((x) => x.logo_url?.startsWith('https://store.test/'))).toBe(true);

    // the next day: all kept, nothing asked; the student's companies all have a logo
    const again = fakeUnipile();
    const r2 = await runUserLogos(t.db, a, deps(again), new Date(NOW.getTime() + 86_400_000));
    expect(r2).toMatchObject({ looked: 0, remaining: 0, withLogo: 4 });
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

  it('a profile read keeps the logos on it for everyone, by LinkedIn id, with no lookup', async () => {
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
    expect(await keepProfileLogos(cache, orgs, f.fetch, NOW)).toBe(2);
    expect(orgs[0]!.logoUrl).toBe('https://store.test/storage/v1/object/public/company-logos/4242.png');
    const rows = await t.db.sql<{ key: string; company_id: string; logo_url: string }>`
      select key, company_id, logo_url from orbit_private.linkedin_companies`;
    expect(rows).toEqual([
      {
        key: 'weave',
        company_id: '4242',
        logo_url: 'https://store.test/storage/v1/object/public/company-logos/4242.png',
      },
    ]);
    expect(f.asked).toEqual([]);
  });
});
