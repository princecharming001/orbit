import { describe, expect, it } from 'vitest';
import {
  type Bucket,
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
  memoryTake,
  postgrestTake,
} from '../../../../../supabase/functions/orbit-connectors/connectors';

const ORIGIN = 'https://princecharming001.github.io';
const DANA = { name: 'Dana', linkedin_url: 'https://www.linkedin.com/in/dana-lee' };
const profile = (first: string, last: string, slug: string) => ({
  first_name: first,
  last_name: last,
  linkedin_url: `https://www.linkedin.com/in/${slug}`,
  headline: `${first} at Acme`,
});
const villagePath = (first: string, last: string, slug: string, score: number, degree = 2) => ({
  degree,
  summary: { score, score_label: score > 70 ? 'Strong' : 'Medium' },
  starters: [],
  introducer: {
    profile: profile(first, last, slug),
    score,
    score_label: 'Strong',
    score_meta: [{ title: 'Worked together', description: 'Acme, 2021–2024' }],
  },
  score_meta: [],
});
const villagePeople = {
  data: {
    person: {
      first_name: 'Dana',
      last_name: 'Lee',
      full_name: 'Dana Lee',
      linkedin_url: 'x',
      village_url: 'v',
    },
    summary: { score: 80 },
    paths: [villagePath('Mia', 'Chen', 'mia', 55), villagePath('Sam', 'Ortiz', 'sam', 82)],
    count: 2,
  },
  metadata: { request_id: 'r2' },
};
const villageCompany = {
  data: {
    company: { name: 'Stripe', domain: 'stripe.com' },
    summary: { score: 70 },
    target_people: [
      {
        target: { first_name: 'Ana', last_name: 'Ruiz', full_name: 'Ana Ruiz', id: 't1', identity_id: 'i1' },
        paths: [villagePath('Sam', 'Ortiz', 'sam', 64)],
        summary: { score: 64 },
        count: 1,
        degree: 2,
      },
    ],
  },
  metadata: { request_id: 'r3' },
  pagination: {},
};
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

function harness(over: Partial<ConnectorDeps> = {}, upstreamOver?: Upstream) {
  const upstream: { url: string; method: string; body: unknown }[] = [];
  const answer: Upstream = (url) => {
    if (url.includes('/hosted/accounts/link'))
      return new Response(JSON.stringify({ object: 'HostedAuthURL', url: 'https://unipile/login' }), {
        status: 201,
      });
    if (url.includes('/users/relations'))
      return new Response(
        JSON.stringify({
          items: [{ first_name: 'Priya', last_name: 'Shah', company: 'Figma', member_id: 'm1' }],
          cursor: null,
        }),
        { status: 200 },
      );
    if (url.includes('/linkedin/search'))
      return new Response(JSON.stringify({ items: [{ name: 'Mia Chen', member_id: 'm2' }] }), {
        status: 200,
      });
    if (url.includes('/api/v1/accounts?'))
      return new Response(
        JSON.stringify({
          items: [
            { id: 'acc_other', name: 'someone else', sources: [{ status: 'OK' }] },
            { id: 'acc_1', name: 'ref1', sources: [{ status: 'OK' }] },
          ],
        }),
        { status: 200 },
      );
    if (url.includes('/api/v1/accounts/')) return new Response(JSON.stringify({ object: 'AccountDeleted' }));
    if (url.endsWith('/v2/auth/tokens'))
      return new Response(
        JSON.stringify({
          data: { token: 'tok-1', expires_in: 31536000, expires_at: 1_900_000_000, token_type: 'Bearer' },
          metadata: { request_id: 'r1' },
        }),
        { status: 200 },
      );
    if (url.endsWith('/v2/people/paths')) return new Response(JSON.stringify(villagePeople), { status: 200 });
    if (url.endsWith('/v2/companies/paths'))
      return new Response(JSON.stringify(villageCompany), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: 'v-key',
    villageBase: 'https://api.village.do',
    villageUser: { externalUserId: 'orbit-local', email: 'founder@orbit.test' },
    origins: defaultOrigins,
    newRef: () => 'ref1',
    fetch: (async (url: string, init: RequestInit = {}) => {
      upstream.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return (upstreamOver ?? answer)(url, init);
    }) as unknown as typeof fetch,
    ...over,
  };
  return { handler: makeHandler(deps), upstream };
}

const post = (path: string, body: unknown, origin = ORIGIN, ip = '203.0.113.7') =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

const accounts =
  (items: unknown[], status = 200): Upstream =>
  (url) =>
    url.includes('/api/v1/accounts?')
      ? new Response(JSON.stringify({ items }), { status })
      : new Response('{}', { status: 404 });

describe('orbit-connectors proxy', () => {
  it('allows Orbit and refuses other origins', async () => {
    const { handler } = harness();
    expect((await handler(post('/paths', { name: 'X' }, 'https://evil.example'))).status).toBe(403);
    const pre = await handler(
      new Request(`${BASE}/paths`, { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('starts a Unipile connect with our reference as the account name', async () => {
    const { handler, upstream } = harness();
    const r = await handler(post('/connect/start', {}));
    expect(await r.json()).toEqual({ url: 'https://unipile/login', ref: 'ref1' });
    expect(upstream[0]!.url).toContain('/hosted/accounts/link');
    expect(upstream[0]!.body).toMatchObject({ type: 'create', providers: ['LINKEDIN'], name: 'ref1' });
  });

  it('maps the connect status: connected, pending, failed sign-ins as error', async () => {
    const ok = harness();
    expect(await (await ok.handler(post('/connect/status', { ref: 'ref1' }))).json()).toEqual({
      status: 'connected',
      accountId: 'acc_1',
    });
    const waiting = harness(
      {},
      accounts([{ id: 'acc_1', name: 'ref1', sources: [{ status: 'CONNECTING' }] }]),
    );
    expect(await (await waiting.handler(post('/connect/status', { ref: 'ref1' }))).json()).toEqual({
      status: 'pending',
    });
    const notYet = harness({}, accounts([]));
    expect(await (await notYet.handler(post('/connect/status', { ref: 'ref1' }))).json()).toEqual({
      status: 'pending',
    });
    const badCreds = harness(
      {},
      accounts([{ id: 'acc_1', name: 'ref1', sources: [{ status: 'CREDENTIALS' }] }]),
    );
    expect(await (await badCreds.handler(post('/connect/status', { ref: 'ref1' }))).json()).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/did not accept the sign-in/),
    });
    const stopped = harness({}, accounts([{ id: 'acc_1', name: 'ref1', sources: [{ status: 'STOPPED' }] }]));
    expect(await (await stopped.handler(post('/connect/status', { ref: 'ref1' }))).json()).toMatchObject({
      status: 'error',
    });
  });

  it('reads a 404 from Unipile as still waiting and any other failure as a 502', async () => {
    const missing = harness({}, accounts([], 404));
    const r1 = await missing.handler(post('/connect/status', { ref: 'ref1' }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ status: 'pending' });
    const broken = harness({}, accounts([], 500));
    expect((await broken.handler(post('/connect/status', { ref: 'ref1' }))).status).toBe(502);
    const down = harness({}, () => new Response('{}', { status: 500 }));
    const r2 = await down.handler(post('/relations', { accountId: 'a1' }));
    expect(r2.status).toBe(502);
    expect(await r2.json()).toEqual({ error: 'unipile 500' });
  });

  it('maps relations and mutuals, and forwards Village paths', async () => {
    const { handler } = harness();
    const rel = (await (await handler(post('/relations', { accountId: 'a1' }))).json()) as {
      items: { first_name: string }[];
    };
    expect(rel.items[0]!.first_name).toBe('Priya');
    const mut = (await (
      await handler(post('/mutuals', { accountId: 'a1', targetMemberId: 't' }))
    ).json()) as {
      mutuals: { name: string }[];
    };
    expect(mut.mutuals[0]!.name).toBe('Mia Chen');
    const paths = (await (await handler(post('/paths', DANA))).json()) as {
      paths: { introducer: { name: string }; warmth: number }[];
    };
    expect(paths.paths[0]).toMatchObject({ introducer: { name: 'Sam Ortiz' }, warmth: 0.82 });
  });

  it('asks Village v2: a token from the secret key, then people paths by LinkedIn URL, mapped to the client shape', async () => {
    const { handler, upstream } = harness();
    const r = await handler(post('/paths', DANA));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      paths: [
        {
          introducer: {
            name: 'Sam Ortiz',
            headline: 'Sam at Acme',
            linkedin_url: 'https://www.linkedin.com/in/sam',
          },
          warmth: 0.82,
          hops: ['You', 'Sam Ortiz', 'Dana Lee'],
          note: 'Worked together: Acme, 2021–2024',
        },
        {
          introducer: {
            name: 'Mia Chen',
            headline: 'Mia at Acme',
            linkedin_url: 'https://www.linkedin.com/in/mia',
          },
          warmth: 0.55,
          hops: ['You', 'Mia Chen', 'Dana Lee'],
          note: 'Worked together: Acme, 2021–2024',
        },
      ],
    });
    expect(upstream.map((u) => u.url)).toEqual([
      'https://api.village.do/v2/auth/tokens',
      'https://api.village.do/v2/people/paths',
    ]);
    expect(upstream[0]!.body).toEqual({ external_user_id: 'orbit-local', email: 'founder@orbit.test' });
    expect(upstream[1]!.body).toEqual({ linkedin_url: 'https://www.linkedin.com/in/dana-lee' });
    // the token is reused by the next request
    await handler(post('/paths', DANA));
    expect(upstream.map((u) => u.url).filter((u) => u.endsWith('/auth/tokens'))).toHaveLength(1);
  });

  it('sends the secret key header and the bearer token to Village', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const { handler } = harness({
      fetch: (async (url: string, init: RequestInit = {}) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        if (url.endsWith('/v2/auth/tokens'))
          return new Response(
            JSON.stringify({ data: { token: 'tok-9', expires_in: 1, expires_at: 2_000_000_000 } }),
          );
        return new Response(JSON.stringify(villagePeople));
      }) as unknown as typeof fetch,
    });
    await handler(post('/paths', DANA));
    expect(seen[0]!.headers['secret-key']).toBe('v-key');
    expect(seen[1]!.headers.authorization).toBe('Bearer tok-9');
  });

  it('asks company paths for a domain, and nothing at all for a bare name', async () => {
    const { handler, upstream } = harness();
    const co = (await (await handler(post('/paths', { company: 'stripe.com' }))).json()) as {
      paths: { introducer: { name: string }; hops: string[]; warmth: number }[];
    };
    expect(co.paths).toEqual([
      expect.objectContaining({ introducer: expect.objectContaining({ name: 'Sam Ortiz' }), warmth: 0.64 }),
    ]);
    expect(co.paths[0]!.hops).toEqual(['You', 'Sam Ortiz', 'Ana Ruiz']);
    expect(upstream.at(-1)).toMatchObject({
      url: 'https://api.village.do/v2/companies/paths',
      body: { domain: 'stripe.com', limit: 25 },
    });
    const before = upstream.length;
    expect(await (await handler(post('/paths', { name: 'Dana', company: 'Stripe' }))).json()).toEqual({
      paths: [],
    });
    expect(upstream.length).toBe(before);
  });

  it('answers 502 when Village fails, and treats a 404 as no paths', async () => {
    const fails = harness({}, (url) =>
      url.endsWith('/auth/tokens')
        ? new Response(JSON.stringify({ data: { token: 't' } }))
        : new Response('{}', { status: 400 }),
    );
    expect((await fails.handler(post('/paths', DANA))).status).toBe(502);
    const none = harness({}, (url) =>
      url.endsWith('/auth/tokens')
        ? new Response(JSON.stringify({ data: { token: 't' } }))
        : new Response('{}', { status: 404 }),
    );
    const r = await none.handler(post('/paths', DANA));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ paths: [] });
  });

  it('unlinks an account with a DELETE, and an account already gone counts as unlinked', async () => {
    const { handler, upstream } = harness();
    const r = await handler(post('/disconnect', { accountId: 'acc_1' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(upstream[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api1.unipile.com:443/api/v1/accounts/acc_1',
    });
    const gone = harness({}, () => new Response('{}', { status: 404 }));
    expect((await gone.handler(post('/disconnect', { accountId: 'acc_1' }))).status).toBe(200);
    const fails = harness({}, () => new Response('{}', { status: 500 }));
    expect((await fails.handler(post('/disconnect', { accountId: 'acc_1' }))).status).toBe(502);
  });

  it('reports each provider as unconfigured when its key is missing, so the app uses the fallback', async () => {
    const noUni = harness({ unipileKey: undefined });
    for (const path of ['/relations', '/connect/start', '/connect/status', '/mutuals', '/disconnect']) {
      const r = await noUni.handler(post(path, { accountId: 'a1' }));
      expect(r.status, path).toBe(503);
      expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
    }
    expect(noUni.upstream).toEqual([]);
    const noVillage = harness({ villageKey: undefined });
    const r2 = await noVillage.handler(post('/paths', { name: 'X' }));
    expect(r2.status).toBe(503);
    expect(r2.headers.get('x-orbit-connector')).toBe('unconfigured');
    // a key without the Village user to mint tokens for is not enough either
    const noUser = harness({ villageUser: undefined });
    expect((await noUser.handler(post('/paths', DANA))).status).toBe(503);
    expect(noUser.upstream).toEqual([]);
    // the other provider still works
    expect((await noVillage.handler(post('/relations', { accountId: 'a1' }))).status).toBe(200);
  });

  it('refuses unknown routes and other methods', async () => {
    const { handler } = harness();
    expect((await handler(post('/accounts', {}))).status).toBe(404);
    const get = new Request(`${BASE}/paths`, { method: 'GET', headers: { origin: ORIGIN } });
    expect((await handler(get)).status).toBe(405);
  });

  it('limits each visitor per minute, by a hashed IP, and only for calls that reach a provider', async () => {
    const seen: Bucket[][] = [];
    const at = new Date('2026-10-13T10:00:30Z');
    // the counter reads the same pinned clock, so the test does not depend on the time of day it runs at
    const inner = memoryTake(() => at.getTime());
    const { handler, upstream } = harness({
      limits: { perMinute: 2, perDay: 100 },
      now: () => at,
      take: async (bs) => {
        seen.push(bs);
        return inner(bs);
      },
    });
    expect((await handler(post('/paths', DANA))).status).toBe(200);
    expect((await handler(post('/paths', DANA))).status).toBe(200);
    const third = await handler(post('/paths', DANA));
    expect(third.status).toBe(429);
    expect(third.headers.get('x-orbit-limit')).toBe('minute');
    expect(third.headers.get('retry-after')).toBe('30');
    // one token, then one paths call per allowed request; the refused one reaches nothing
    expect(upstream).toHaveLength(3);
    // another visitor has their own allowance
    expect((await handler(post('/paths', { name: 'X' }, ORIGIN, '198.51.100.4'))).status).toBe(200);
    // the stored keys never hold the raw address
    expect(JSON.stringify(seen)).not.toContain('203.0.113.7');
    expect(seen[0]!.map((b) => b.key)).toEqual([
      expect.stringMatching(/^connectors:min:2026-10-13T10:00:[0-9a-f]{32}$/),
      expect.stringMatching(/^connectors:day:2026-10-13:[0-9a-f]{32}$/),
    ]);
    // an unconfigured provider answers without touching the counters
    const before = seen.length;
    const off = harness({
      villageKey: undefined,
      take: async (bs) => {
        seen.push(bs);
        return { allowed: true };
      },
    });
    await off.handler(post('/paths', { name: 'X' }));
    expect(seen.length).toBe(before);
  });

  it('says the daily limit apart from the minute one, and fails closed when the counter store is down', async () => {
    const day = harness({ take: async (bs) => ({ allowed: false, over: bs[1]!.key }) });
    const r = await day.handler(post('/paths', { name: 'X' }));
    expect(r.status).toBe(429);
    expect(r.headers.get('x-orbit-limit')).toBe('day');
    const down = harness({
      take: async () => {
        throw new Error('db down');
      },
    });
    expect((await down.handler(post('/paths', { name: 'X' }))).status).toBe(503);
  });

  it('counts through orbit-claude’s store with the service key', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const take = postgrestTake('https://db.test', 'svc', (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify([{ allowed: true, over_bucket: null }]));
    }) as unknown as typeof fetch);
    expect(await take([{ key: 'connectors:min:x', limit: 2, expires: '2026-10-13T10:01:00Z' }])).toEqual({
      allowed: true,
      over: undefined,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://db.test/rest/v1/rpc/orbit_proxy_take',
      body: { p_buckets: ['connectors:min:x'], p_limits: [2] },
    });
  });
});
