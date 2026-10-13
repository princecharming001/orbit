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
    if (url.includes('/v1/paths'))
      return new Response(
        JSON.stringify({
          paths: [{ introducer: { name: 'Sam' }, warmth: 0.8, path: ['You', 'Sam', 'T'] }],
        }),
        { status: 200 },
      );
    return new Response('{}', { status: 404 });
  };
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: 'v-key',
    villageBase: 'https://api.village.do',
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
    const paths = (await (await handler(post('/paths', { name: 'Dana' }))).json()) as {
      paths: { introducer: { name: string }; warmth: number }[];
    };
    expect(paths.paths[0]).toMatchObject({ introducer: { name: 'Sam' }, warmth: 0.8 });
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
    const inner = memoryTake();
    const { handler, upstream } = harness({
      limits: { perMinute: 2, perDay: 100 },
      now: () => new Date('2026-10-13T10:00:30Z'),
      take: async (bs) => {
        seen.push(bs);
        return inner(bs);
      },
    });
    expect((await handler(post('/paths', { name: 'X' }))).status).toBe(200);
    expect((await handler(post('/paths', { name: 'X' }))).status).toBe(200);
    const third = await handler(post('/paths', { name: 'X' }));
    expect(third.status).toBe(429);
    expect(third.headers.get('x-orbit-limit')).toBe('minute');
    expect(third.headers.get('retry-after')).toBe('30');
    expect(upstream).toHaveLength(2);
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
