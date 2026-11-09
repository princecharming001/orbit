import { describe, expect, it } from 'vitest';
import {
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
  postgrestUsage,
  type UsageRow,
} from '../../../../../supabase/functions/orbit-connectors/connectors';

/** Plan 34 E1: the browser routes that pay a provider write one usage row per paid call, and never fail on it. */

const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const DANA = { name: 'Dana', linkedin_url: 'https://www.linkedin.com/in/dana-lee' };

const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  });

const answer = (url: string) => {
  if (url.endsWith('/v2/auth/tokens'))
    return Response.json({ data: { token: 'tok-1', expires_in: 3600, expires_at: 1_900_000_000 } });
  if (url.endsWith('/v2/people/paths'))
    return Response.json({ data: { person: { full_name: 'Dana Lee' }, summary: {}, paths: [], count: 0 } });
  if (url.endsWith('/v2/companies/paths'))
    return Response.json({ data: { company: { name: 'Stripe' }, summary: {}, target_people: [] } });
  if (url.endsWith('/search'))
    return Response.json({ results: [{ url: 'https://dana.dev', title: 'Dana' }] });
  return new Response('{}', { status: 404 });
};

function harness(over: Partial<ConnectorDeps> = {}) {
  const rows: UsageRow[] = [];
  const deps: ConnectorDeps = {
    unipileKey: undefined,
    unipileBase: undefined,
    villageKey: 'v-key',
    villageBase: 'https://api.village.do',
    villageUser: { externalUserId: 'orbit-local', email: 'founder@orbit.test' },
    origins: defaultOrigins,
    enrichment: { exaKey: 'exa-key' },
    fetch: (async (url: string) => answer(url)) as unknown as typeof fetch,
    usage: async (r) => {
      rows.push(r);
    },
    ...over,
  };
  return { handler: makeHandler(deps), rows };
}

describe('connector usage rows', () => {
  it('records an Exa search from /web and a Village lookup from /paths, by visitor hash', async () => {
    const { handler, rows } = harness();
    expect((await handler(post('/web', { name: 'Dana Lee' }))).status).toBe(200);
    expect((await handler(post('/paths', DANA))).status).toBe(200);
    expect((await handler(post('/paths', { company: 'stripe.com' }))).status).toBe(200);
    expect(rows.map((r) => [r.provider, r.operation, r.units])).toEqual([
      ['exa', 'web', 1],
      ['village', 'paths:person', 5],
      ['village', 'paths:company', 5],
    ]);
    expect(rows[0]!.costUsd).toBeCloseTo(0.007, 6);
    expect(rows[1]!.costUsd).toBeCloseTo(0.1, 6);
    // the account is the visitor hash, never the raw address
    expect(rows[0]!.accountId).toMatch(/^[0-9a-f]{32}$/);
    expect(rows.every((r) => !r.accountId.includes('203.0.113.7'))).toBe(true);
  });

  it('records nothing for a lookup that reaches no provider, and a failing store never fails the route', async () => {
    const { handler, rows } = harness();
    await handler(post('/paths', { name: 'Dana', company: 'Stripe' }));
    expect(rows).toHaveLength(0);
    const broken = harness({
      usage: async () => {
        throw new Error('store down');
      },
    });
    const r = await broken.handler(post('/web', { name: 'Dana Lee' }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('writes rows through orbit_usage_add with the service key', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const sink = postgrestUsage('https://ref.supabase.co', 'service', (async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    await sink({ provider: 'exa', operation: 'web', units: 1, costUsd: 0.007, accountId: 'abc' });
    expect(calls[0]!.url).toBe('https://ref.supabase.co/rest/v1/rpc/orbit_usage_add');
    expect(calls[0]!.body).toEqual({
      p_provider: 'exa',
      p_operation: 'web',
      p_units: 1,
      p_cost_usd: 0.007,
      p_account_id: 'abc',
    });
  });
});
