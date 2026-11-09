/**
 * Plan 35 B4 on PGlite: the weekly logo sweep looks up on LinkedIn only the companies 3 or more people work at across
 * all students, keeps them in the shared orbit_private.linkedin_companies list with the logo in storage, takes reads
 * from each account's share of its company ledger, and does nothing the next week for companies already kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { companyNameKey } from '../../functions/_shared/providers/linkedinCompanies.ts';
import { runLogoSweep, SWEEP_SHARE, sweepCandidates } from '../../functions/_shared/search/logoSweep.ts';
import { isoWeek, searchHandlers } from '../../functions/orbit-worker/handlers/search.ts';
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

const NOW = new Date('2026-11-22T09:17:00Z');
const BASE = 'https://api1.unipile.test';
const logo = (n: string) => `https://media.licdn.com/dms/image/v2/${n}/company-logo_200_200?e=1900000000&t=x`;

async function people(userId: string, org: string, n: number) {
  for (let i = 0; i < n; i++)
    await t.db.sql`
      insert into orbit.people (user_id, display_name, name_norm, org_raw)
      values (${userId}::uuid, ${`P ${org} ${i}`}, ${`p ${org.toLowerCase()} ${i}`}, ${org})`;
}

/** Unipile: Stripe's page at its own name, a search for the rest; logos and storage answer. */
function fakeUnipile() {
  const asked: string[] = [];
  const stored: string[] = [];
  const doFetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.hostname === 'media.licdn.com')
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    if (u.pathname.startsWith('/storage/v1/object/company-logos/')) {
      stored.push(u.pathname);
      return new Response('{}', { status: 200 });
    }
    if (u.pathname.startsWith('/api/v1/linkedin/company/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      asked.push(`page:${id}`);
      if (id === 'stripe')
        return Response.json({
          id: '2135371',
          name: 'Stripe',
          public_identifier: 'stripe',
          logo: logo('stripe'),
        });
      return new Response('{}', { status: 404 });
    }
    if (u.pathname === '/api/v1/linkedin/search') {
      const kw = String(JSON.parse(String(init.body)).keywords);
      asked.push(`search:${kw}`);
      if (kw === 'Ramp')
        return Response.json({
          items: [{ id: '1406226', name: 'Ramp', public_identifier: 'ramp', logo: logo('ramp') }],
        });
      return Response.json({ items: [] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch: doFetch, asked, stored };
}

const deps = (f: ReturnType<typeof fakeUnipile>) => ({
  fetch: f.fetch,
  apiKey: 'u-key',
  baseUrl: BASE,
  storeLogo: async (id: string) => {
    await f.fetch(`https://store.test/storage/v1/object/company-logos/${id}.png`, { method: 'POST' });
    return `https://store.test/storage/v1/object/public/company-logos/${id}.png`;
  },
  sleep: async () => {},
  random: () => 0,
  clock: () => 0,
});

describe('logos.sweep', () => {
  it('looks up only companies 3 or more people work at across students, and keeps them for everyone', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-a' });
    const b = await makeUser(t.db);
    await people(a, 'Stripe', 2);
    await people(b, 'Stripe, Inc.', 1); // the same company by its legal name: 3 people in all
    await people(a, 'Ramp', 3);
    await people(b, 'Tiny Co', 2); // 2 people: left to the tiles that show it
    await people(a, 'UC Berkeley', 5); // a school: its own site icon stands in
    const c = await sweepCandidates(t.db);
    expect(c.map((x) => x.key).sort()).toEqual(['ramp', 'stripe']);

    const f = fakeUnipile();
    const r = await runLogoSweep(t.db, deps(f), NOW);
    expect(r).toMatchObject({ candidates: 2, looked: 2, found: 2, remaining: 0, accounts: 1 });
    expect(f.asked).not.toContain('search:Tiny Co');
    const rows = await t.db.sql<{ key: string; status: string; logo_url: string | null }>`
      select key, status, logo_url from orbit_private.linkedin_companies order by key`;
    expect(rows).toEqual([
      {
        key: 'ramp',
        status: 'found',
        logo_url: 'https://store.test/storage/v1/object/public/company-logos/1406226.png',
      },
      {
        key: 'stripe',
        status: 'found',
        logo_url: 'https://store.test/storage/v1/object/public/company-logos/2135371.png',
      },
    ]);
    // reads came from the account's company ledger
    const [used] = await t.db.sql<{ count: number }>`
      select count from public.orbit_proxy_counters where bucket = ${`connectors:li:company:2026-11-22:acc-a`}`;
    expect(used!.count).toBeGreaterThan(0);

    // next week: everything is kept, nothing is asked
    const again = fakeUnipile();
    const r2 = await runLogoSweep(t.db, deps(again), new Date(NOW.getTime() + 7 * 86_400_000));
    expect(r2).toMatchObject({ looked: 0, remaining: 0 });
    expect(again.asked).toEqual([]);
  });

  it('stops at the account share of the ledger and leaves the rest for later', async () => {
    const a = await connectedUser(t.db, { linkedinAccount: 'acc-b' });
    for (let i = 0; i < 40; i++) await people(a, `Firm ${i}`, 3);
    const f = fakeUnipile();
    const r = await runLogoSweep(t.db, deps(f), NOW);
    // each name takes up to two reads (its own page, then a search); the share is SWEEP_SHARE of 150
    expect(r.stopped).toBe('limit');
    const [used] = await t.db.sql<{ count: number }>`
      select count from public.orbit_proxy_counters where bucket = ${`connectors:li:company:2026-11-22:acc-b`}`;
    expect(used!.count).toBe(Math.round(150 * SWEEP_SHARE));
    expect(r.remaining).toBeGreaterThan(0);
    const [kept] = await t.db.sql<{
      n: number;
    }>`select count(*)::int as n from orbit_private.linkedin_companies`;
    expect(kept!.n + r.remaining).toBe(40);
    expect(companyNameKey('Firm 1, Inc.')).toBe('firm 1');
  });

  it('the handler skips without Unipile or storage, and with no LinkedIn account to read with', async () => {
    const f = fakeUnipile();
    const run = (d: Parameters<typeof searchHandlers>[0]) =>
      searchHandlers(d)['logos.sweep']!(
        {
          queue: 'orbit_enrich',
          msgId: 1,
          readCt: 1,
          kind: 'logos.sweep',
          userId: null,
          payload: { part: 0 },
        },
        {
          db: t.db,
          now: () => NOW,
          queue: {
            enqueue: async () => 1,
            read: async () => [],
            delete: async () => {},
            archive: async () => {},
            setVt: async () => {},
          },
        },
      );
    await expect(run({ fetch: f.fetch })).rejects.toThrow('unconfigured');
    const u = await makeUser(t.db);
    await people(u, 'Ramp', 3);
    await expect(
      run({
        fetch: f.fetch,
        unipile: { apiKey: 'k', baseUrl: BASE },
        storage: { url: 'https://store.test', serviceKey: 'service-role-placeholder' },
        sleep: async () => {},
      }),
    ).rejects.toThrow('no_accounts');
    expect(isoWeek(NOW)).toBe('2026-47');
  });
});
