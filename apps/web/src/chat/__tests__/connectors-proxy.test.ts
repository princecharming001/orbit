import { describe, expect, it } from 'vitest';
import {
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
} from '../../../../../supabase/functions/orbit-connectors/connectors';

const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';

function harness(over: Partial<ConnectorDeps> = {}) {
  const upstream: { url: string; body: unknown }[] = [];
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: 'v-key',
    villageBase: 'https://api.village.do',
    origins: defaultOrigins,
    fetch: (async (url: string, init: RequestInit) => {
      upstream.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes('/hosted/accounts/link'))
        return new Response(JSON.stringify({ url: 'https://unipile/login', object_id: 'ref1' }), {
          status: 200,
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
      if (url.includes('/v1/paths'))
        return new Response(
          JSON.stringify({
            paths: [{ introducer: { name: 'Sam' }, warmth: 0.8, path: ['You', 'Sam', 'T'] }],
          }),
          { status: 200 },
        );
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
    ...over,
  };
  return { handler: makeHandler(deps), upstream };
}

const post = (path: string, body: unknown, origin = ORIGIN) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

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

  it('starts a Unipile connect and maps the response', async () => {
    const { handler, upstream } = harness();
    const r = await handler(post('/connect/start', {}));
    expect(await r.json()).toEqual({ url: 'https://unipile/login', ref: 'ref1' });
    expect(upstream[0]!.url).toContain('/hosted/accounts/link');
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

  it('reports each provider as unconfigured when its key is missing, so the app uses the fallback', async () => {
    const noUni = harness({ unipileKey: undefined });
    const r1 = await noUni.handler(post('/relations', { accountId: 'a1' }));
    expect(r1.status).toBe(503);
    expect(r1.headers.get('x-orbit-connector')).toBe('unconfigured');
    const noVillage = harness({ villageKey: undefined });
    const r2 = await noVillage.handler(post('/paths', { name: 'X' }));
    expect(r2.status).toBe(503);
    // the other provider still works
    expect((await noVillage.handler(post('/relations', { accountId: 'a1' }))).status).toBe(200);
  });
});
