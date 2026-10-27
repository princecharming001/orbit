import { describe, expect, it } from 'vitest';
import {
  accountToken,
  COMPANIES_PER_CALL,
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
  memoryCompanyCache,
  memoryTake,
} from '../../../../../supabase/functions/orbit-connectors/connectors';

/**
 * The connector proxy's /companies route: many companies at once, answered from the shared list for free, a few new
 * ones looked up on LinkedIn from the account's company allowance, and logos kept so they never expire.
 */
const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const SIGNING = 'test-signing-key-not-a-real-one';
const TOKEN = await accountToken('a1', SIGNING);
const licdn = (n: string) =>
  `https://media.licdn.com/dms/image/v2/${n}/company-logo_200_200?e=1900000000&t=x`;

/** LinkedIn's company search: one Stripe, two Novas, no Zzz. */
function harness(over: Partial<ConnectorDeps> = {}) {
  const searches: string[] = [];
  const pages: string[] = [];
  const cache = memoryCompanyCache();
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: undefined,
    villageBase: undefined,
    origins: defaultOrigins,
    signingKey: SIGNING,
    companies: cache,
    now: () => new Date('2026-10-27T12:00:00Z'),
    take: memoryTake(() => Date.parse('2026-10-27T12:00:00Z')),
    fetch: (async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://media.licdn.com/'))
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
      if (url.includes('/api/v1/linkedin/search')) {
        const kw = String(JSON.parse(String(init.body)).keywords);
        searches.push(kw);
        const items =
          kw === 'Stripe'
            ? [
                { id: 2135371, name: 'Stripe', public_identifier: 'stripe' },
                { id: 1, name: 'Stripe Partners' },
              ]
            : kw === 'Nova'
              ? [
                  { id: 2, name: 'Nova' },
                  { id: 3, name: 'NOVA' },
                ]
              : [];
        return new Response(JSON.stringify({ items }));
      }
      if (url.includes('/api/v1/linkedin/company/')) {
        pages.push(url);
        // Stripe's page is at its own name (and its id); no one else has a page at theirs
        if (!/\/company\/(stripe|2135371)\?/.test(url)) return new Response('{}', { status: 404 });
        return new Response(
          JSON.stringify({
            id: '2135371',
            name: 'Stripe',
            public_identifier: 'stripe',
            logo: licdn('stripe'),
          }),
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
    ...over,
  };
  return { handler: makeHandler(deps), searches, pages, cache };
}

const post = (body: unknown) =>
  new Request(`${BASE}/companies`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  });

describe('/companies', () => {
  it('finds a company once, keeps its logo where it never expires, and answers it free from then on', async () => {
    const { handler, searches, pages, cache } = harness();
    const first = await (await handler(post({ accountId: 'a1', token: TOKEN, names: ['Stripe'] }))).json();
    expect(first.companies.Stripe).toMatchObject({
      status: 'found',
      companyId: '2135371',
      publicIdentifier: 'stripe',
      logoUrl: 'https://logos.test/2135371.png',
    });
    // found at its own page address: no search at all
    expect(searches).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(cache.rows.get('stripe')?.logoUrl).toBe('https://logos.test/2135371.png');
    // another student, another day: no LinkedIn read at all
    const again = await (await handler(post({ accountId: 'a1', token: TOKEN, names: ['stripe'] }))).json();
    expect(again.companies.stripe.status).toBe('found');
    expect(searches).toEqual([]);
    expect(pages).toHaveLength(1);
  });

  it('keeps a name LinkedIn has several of, or none of, so nobody searches it again for a month', async () => {
    const { handler, searches } = harness();
    const r = await (await handler(post({ accountId: 'a1', token: TOKEN, names: ['Nova', 'Zzz'] }))).json();
    expect(r.companies.Nova.status).toBe('ambiguous');
    expect(r.companies.Zzz.status).toBe('not_found');
    await handler(post({ accountId: 'a1', token: TOKEN, names: ['Nova', 'Zzz'] }));
    expect(searches).toEqual(['Nova', 'Zzz']);
  });

  it('looks up only a few new companies a call and says how many wait', async () => {
    const { handler, searches } = harness();
    const names = Array.from({ length: 20 }, (_, i) => `Company ${i}`);
    const r = await (await handler(post({ accountId: 'a1', token: TOKEN, names }))).json();
    expect(searches).toHaveLength(COMPANIES_PER_CALL);
    expect(r.pending).toBe(20 - COMPANIES_PER_CALL);
  });

  it('stops at the account’s company allowance, and refuses a browser that does not hold the account', async () => {
    const { handler, searches } = harness({ ledger: { company: 3 } });
    const r = await (
      await handler(post({ accountId: 'a1', token: TOKEN, names: ['A', 'B', 'C', 'D', 'E'] }))
    ).json();
    expect(searches).toHaveLength(3);
    expect(r.stopped).toBe('limit');
    const res = await handler(post({ accountId: 'a1', token: 'nope', names: ['Stripe'] }));
    expect(res.status).toBe(403);
  });
});
