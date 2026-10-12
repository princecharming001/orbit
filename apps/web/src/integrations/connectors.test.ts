import { afterEach, describe, expect, it } from 'vitest';
import {
  linkedInConnections,
  mutualConnections,
  setUnipileUrlForTests,
  startLinkedInConnect,
  unipileConfigured,
} from './unipile';
import { setVillageUrlForTests, villageConfigured, villagePaths } from './village';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';

/** A fetch that answers by path, recording the calls. */
function stub(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = key ? routes[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

afterEach(() => {
  setUnipileUrlForTests(undefined);
  setVillageUrlForTests(undefined);
});

describe('Unipile (live LinkedIn) adapter', () => {
  it('is off until a proxy url is set', () => {
    setUnipileUrlForTests(null);
    expect(unipileConfigured()).toBe(false);
    setUnipileUrlForTests(BASE);
    expect(unipileConfigured()).toBe(true);
  });

  it('starts a hosted connection and reads its status', async () => {
    setUnipileUrlForTests(BASE);
    const { fn } = stub({
      '/connect/start': { body: { url: 'https://unipile/login/abc', ref: 'ref_1' } },
      '/connect/status': { body: { status: 'connected', accountId: 'acc_1' } },
    });
    const start = await startLinkedInConnect(fn);
    expect(start).toEqual({ url: 'https://unipile/login/abc', ref: 'ref_1' });
  });

  it('pages all connections and maps them to the import shape', async () => {
    setUnipileUrlForTests(BASE);
    let page = 0;
    const fn = (async (_url: string, init: RequestInit) => {
      void JSON.parse(init.body as string);
      page++;
      const first = page === 1;
      return new Response(
        JSON.stringify({
          items: first
            ? [
                {
                  first_name: 'Priya',
                  last_name: 'Shah',
                  position: 'Product Manager',
                  company: 'Figma',
                  public_profile_url: 'https://linkedin.com/in/priya',
                  connected_at: '2026-03-04T12:00:00Z',
                  member_id: 'm_priya',
                },
              ]
            : [{ first_name: 'Noah', last_name: 'Kim', company: 'Stripe', member_id: 'm_noah' }],
          cursor: first ? 'c2' : null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const conns = await linkedInConnections('acc_1', { fetch: fn });
    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({
      firstName: 'Priya',
      lastName: 'Shah',
      company: 'Figma',
      position: 'Product Manager',
      url: 'https://linkedin.com/in/priya',
      connectedOn: '2026-03-04',
      memberId: 'm_priya',
    });
    expect(conns[1]!.firstName).toBe('Noah');
  });

  it('returns mutual connections, and an empty list when off or erroring', async () => {
    setUnipileUrlForTests(BASE);
    const { fn } = stub({
      '/mutuals': { body: { mutuals: [{ name: 'Mia Chen', headline: 'PM at Stripe', member_id: 'm_mia' }] } },
    });
    const ms = await mutualConnections('acc_1', 'm_target', fn);
    expect(ms).toEqual([{ name: 'Mia Chen', headline: 'PM at Stripe', url: undefined, memberId: 'm_mia' }]);
    // off
    setUnipileUrlForTests(null);
    expect(await mutualConnections('acc_1', 'm_target', fn)).toEqual([]);
    // error does not throw
    setUnipileUrlForTests(BASE);
    const bad = stub({ '/mutuals': { status: 500, body: {} } });
    expect(await mutualConnections('acc_1', 'm_target', bad.fn)).toEqual([]);
  });
});

describe('Village (warm intros) adapter', () => {
  it('is off until a proxy url is set', () => {
    setVillageUrlForTests(null);
    expect(villageConfigured()).toBe(false);
    setVillageUrlForTests(BASE);
    expect(villageConfigured()).toBe(true);
  });

  it('returns warm paths sorted by warmth, mapped from the api shape', async () => {
    setVillageUrlForTests(BASE);
    const { fn, calls } = stub({
      '/paths': {
        body: {
          paths: [
            {
              introducer: { name: 'Sam Ortiz', headline: 'EM at Stripe' },
              warmth: 0.4,
              hops: ['You', 'Sam Ortiz', 'Target'],
            },
            {
              introducer: { name: 'Mia Chen', linkedin_url: 'https://linkedin.com/in/mia' },
              warmth: 0.9,
              hops: ['You', 'Mia Chen', 'Target'],
              note: 'worked together',
            },
          ],
        },
      },
    });
    const paths = await villagePaths({ name: 'Dana Lee', company: 'Stripe' }, { fetch: fn });
    expect(paths.map((p) => p.introducer.name)).toEqual(['Mia Chen', 'Sam Ortiz']);
    expect(paths[0]).toMatchObject({ warmth: 0.9, note: 'worked together' });
    expect(calls[0]!.body).toMatchObject({ name: 'Dana Lee', company: 'Stripe' });
  });

  it('returns an empty list when off, when given nothing, or on error', async () => {
    setVillageUrlForTests(null);
    expect(await villagePaths({ name: 'X' })).toEqual([]);
    setVillageUrlForTests(BASE);
    expect(await villagePaths({})).toEqual([]);
    const bad = stub({ '/paths': { status: 502, body: {} } });
    expect(await villagePaths({ name: 'X' }, { fetch: bad.fn })).toEqual([]);
  });
});
