/**
 * The swarm limit (migration 20261206, _shared/linkedinTargets.ts) on both paths. LinkedIn bans many accounts opening
 * the same profile, so a read aimed at one person first asks public.orbit_linkedin_target_take (here the real function
 * on PGlite). Browser path: orbit-connectors /mutuals, /profile and /photo. Server path: the Unipile research client,
 * gatherExternalCandidates and the hop evidence. A refusal is "not now": no LinkedIn call, nothing kept as "none",
 * counted for the day as kind 'swarm'. Unipile is stubbed by URL; nothing here reaches the network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  sqlTargetTake,
  type TargetTake,
  targetLimitsFrom,
  targetVerdict,
} from '../../functions/_shared/linkedinTargets.ts';
import { gatherExternalCandidates } from '../../functions/_shared/paths/externalCandidates.ts';
import { gatherHopEvidence } from '../../functions/_shared/paths/hopEvidence.ts';
import { createUnipileResearch } from '../../functions/_shared/providers/unipileResearch.ts';
import { createVillage } from '../../functions/_shared/providers/village.ts';
import type { CacheDep } from '../../functions/_shared/research/deps.ts';
import { runReadingStep } from '../../functions/_shared/search/reading.ts';
import {
  accountToken,
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
  memoryTake,
  postgrestTargetTake,
  type SharedReads,
} from '../../functions/orbit-connectors/connectors.ts';
import { type CallCount, mutualsKey, personKey } from '../../functions/orbit-connectors/people.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await t.pg.exec('delete from orbit_private.linkedin_target_reads; delete from orbit.linkedin_calls_daily;');
});

/** The real take on PGlite, recording who asked; `gap` seconds between two accounts (0 to test the day's count). */
function dbTake(gap = 0, max = 3): TargetTake & { asked: string[] } {
  const asked: string[] = [];
  const take = (async (account: string, target: string) => {
    asked.push(`${account}|${target}`);
    const [r] = await t.db.sql<{ v: unknown }>`
      select public.orbit_linkedin_target_take(${target}, ${account}, ${max}::int, ${gap}::int) as v`;
    return targetVerdict(r!.v);
  }) as TargetTake & { asked: string[] };
  take.asked = asked;
  return take;
}

/** A shared store whose keys can be read back. */
function store(): SharedReads & { m: Map<string, Record<string, unknown>> } {
  const m = new Map<string, Record<string, unknown>>();
  return {
    m,
    get: async (k) => m.get(k),
    put: async (k, v) => {
      m.set(k, v);
    },
  };
}

// ---- the browser path: orbit-connectors --------------------------------------------------------------------------

const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const SIGNING = 'test-signing-key-not-a-real-one';
const TARGET = 'ACoAAA123';
const PROFILE = {
  provider_id: TARGET,
  public_identifier: 'omar-haddad',
  first_name: 'Omar',
  last_name: 'Haddad',
  headline: 'President at Enactus Berkeley',
  network_distance: 'SECOND_DEGREE',
  shared_connections_count: 2,
  work_experience: [{ position: 'President', company: 'Enactus Berkeley', current: true }],
  throttled_sections: [],
};

function harness(over: Partial<ConnectorDeps> = {}) {
  const upstream: string[] = [];
  const counted: CallCount[] = [];
  const at = new Date('2026-11-12T09:00:00Z');
  const shared = store();
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: undefined,
    villageBase: undefined,
    origins: defaultOrigins,
    signingKey: SIGNING,
    browserKept: async () => true,
    now: () => at,
    take: memoryTake(() => at.getTime()),
    sleep: async () => {},
    shared,
    calls: async (row) => {
      counted.push(row);
    },
    fetch: (async (url: string) => {
      upstream.push(url);
      if (url.startsWith('https://media.licdn.com/')) return new Response(new Uint8Array([1]));
      if (url.includes('/api/v1/users/')) return new Response(JSON.stringify(PROFILE));
      if (url.includes('/api/v1/linkedin/search'))
        return new Response(
          JSON.stringify({
            items: [
              { name: 'Mia Chen', member_id: 'ACoMia', network_distance: 'DISTANCE_1' },
              { name: 'Sam Roy', member_id: 'ACoSam', network_distance: 'DISTANCE_1' },
            ],
            cursor: null,
            paging: { total_count: 2 },
            config: { params: { connections_of: [TARGET] } },
          }),
        );
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
    ...over,
  };
  const handler = makeHandler(deps);
  const tokens = new Map<string, string>();
  const post = async (path: string, account: string, body: Record<string, unknown>) => {
    if (!tokens.has(account)) tokens.set(account, await accountToken(account, SIGNING));
    const res = await handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ accountId: account, token: tokens.get(account), ...body }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const reads = () => upstream.filter((u) => u.includes('unipile.com'));
  return { post, upstream, reads, counted, shared };
}

describe('orbit-connectors: the swarm limit', () => {
  it('lets three accounts find who they share with one person, and tells the fourth to come back later', async () => {
    const take = dbTake(0);
    const h = harness({ targetTake: take });
    for (const a of ['a1', 'b2', 'c3']) {
      const r = await h.post('/mutuals', a, { targetMemberId: TARGET });
      expect(r.body).toMatchObject({ verified: true, count: 2 });
    }
    const before = h.reads().length;
    const fourth = await h.post('/mutuals', 'd4', { targetMemberId: TARGET });
    expect(fourth.status).toBe(200);
    expect(fourth.body).toMatchObject({
      ok: false,
      reason: 'busy',
      message: 'Orbit will check who you both know a little later.',
    });
    expect(Date.parse(fourth.body.retryAt)).toBeGreaterThan(Date.now() + 23 * 3600_000);
    // no read of the person and nothing kept for the fourth account: never a "none" answer
    expect(h.reads().length).toBe(before);
    expect(h.shared.m.has(await mutualsKey('d4', TARGET))).toBe(false);
    expect(h.shared.m.has(await mutualsKey('a1', TARGET))).toBe(true);
    // the refusal is counted for the day
    expect(h.counted).toContainEqual({ accountId: 'd4', kind: 'swarm', caller: 'mutuals', refused: 1 });
  });

  it('keeps a second account a gap behind the first', async () => {
    const h = harness({ targetTake: dbTake(1200) });
    expect((await h.post('/mutuals', 'a1', { targetMemberId: TARGET })).body).toMatchObject({
      verified: true,
    });
    const n = h.reads().length;
    const second = await h.post('/mutuals', 'b2', { targetMemberId: TARGET });
    expect(second.body).toMatchObject({ ok: false, reason: 'busy' });
    expect(h.reads().length).toBe(n);
  });

  it('asks nothing when a kept answer, the viewer record or the shared record answers', async () => {
    const take = dbTake(0);
    const h = harness({ targetTake: take });
    await h.post('/mutuals', 'a1', { targetMemberId: TARGET });
    const asked = take.asked.length;
    // the kept answer (two weeks)
    expect((await h.post('/mutuals', 'a1', { targetMemberId: TARGET })).body).toMatchObject({ kept: true });
    // the profile that read kept, for this account and in public for everyone
    expect((await h.post('/profile', 'a1', { identifier: TARGET })).body).toMatchObject({
      ok: true,
      shared: true,
    });
    expect((await h.post('/profile', 'z9', { identifier: TARGET, public: true })).body).toMatchObject({
      ok: true,
      shared: true,
    });
    expect(take.asked.length).toBe(asked);
  });

  it('lets the same account ask again and again', async () => {
    const h = harness({ targetTake: dbTake(1200) });
    for (let i = 0; i < 3; i++)
      expect((await h.post('/mutuals', 'a1', { targetMemberId: TARGET, fresh: true })).body).toMatchObject({
        verified: true,
      });
    expect(h.counted.filter((c) => c.kind === 'swarm')).toEqual([]);
  });

  it('a refused profile read answers with the public record Orbit keeps, else later', async () => {
    const take = dbTake(1200);
    const h = harness({ targetTake: take });
    // a1 reads the plain profile: kept for everyone under each of their names
    expect((await h.post('/profile', 'a1', { identifier: 'omar-haddad' })).body).toMatchObject({ ok: true });
    expect(h.shared.m.has(await personKey('omar-haddad'))).toBe(true);
    const n = h.reads().length;
    // b2 wants what only its own read has (distance, contact): refused, so the public record
    const kept = await h.post('/profile', 'b2', { identifier: 'omar-haddad' });
    expect(kept.body).toMatchObject({ ok: true, shared: true, profile: { headline: PROFILE.headline } });
    // more sections than anyone kept: later
    const later = await h.post('/profile', 'b2', { identifier: 'omar-haddad', sections: ['experience'] });
    expect(later.body).toMatchObject({ ok: false, reason: 'busy' });
    expect(later.body.retryAt).toEqual(expect.any(String));
    // a photo read of someone another account looked up a moment ago: later too
    await take('x0', 'acophoto');
    expect((await h.post('/photo', 'c3', { identifier: 'ACoPhoto' })).body).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(h.reads().length).toBe(n);
    expect(h.counted.filter((c) => c.kind === 'swarm').map((c) => c.caller)).toEqual([
      'enrich',
      'enrich',
      'photo',
    ]);
  });

  it('someone’s activity is a look at them too; a thread (one post) is not', async () => {
    const take = dbTake(1200);
    const h = harness({ targetTake: take });
    await take('x0', 'acoactive');
    const n = h.reads().length;
    expect((await h.post('/engagement', 'a1', { memberId: 'ACoActive', want: 'posts' })).body).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(h.reads().length).toBe(n);
    const asked = take.asked.length;
    await h.post('/engagement', 'a1', { want: 'thread', postId: '7001' });
    expect(take.asked.length).toBe(asked);
  });

  it('answers 503 when the take cannot be asked, and never reads uncounted', async () => {
    const h = harness({
      targetTake: async () => {
        throw new Error('down');
      },
    });
    expect((await h.post('/mutuals', 'a1', { targetMemberId: TARGET })).status).toBe(503);
    expect((await h.post('/profile', 'a1', { identifier: TARGET })).status).toBe(503);
    expect(h.reads()).toEqual([]);
  });

  it('postgrestTargetTake calls the service-role function with the limits', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const take = postgrestTargetTake(
      'https://db.test',
      'service-key-not-real',
      { accountsPerDay: 2, gapSeconds: 600 },
      (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ allowed: false, retryAt: '2026-11-13T09:00:00.000Z' }));
      }) as unknown as typeof fetch,
    );
    expect(await take('a1', 'acoaaa123')).toEqual({ allowed: false, retryAt: '2026-11-13T09:00:00.000Z' });
    expect(calls).toEqual([
      {
        url: 'https://db.test/rest/v1/rpc/orbit_linkedin_target_take',
        body: { p_target: 'acoaaa123', p_account: 'a1', p_max_accounts: 2, p_gap_seconds: 600 },
      },
    ]);
  });
});

// ---- the server path ---------------------------------------------------------------------------------------------

const UNIPILE = 'https://api9.unipile.com:13999';

function unipileFetch() {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path.includes('/linkedin/search'))
      return new Response(
        JSON.stringify({
          items: [{ id: 'ACoMia', name: 'Mia Chen', network_distance: 'DISTANCE_1' }],
          paging: { total_count: 1 },
          config: { params: { connections_of: [TARGET] } },
        }),
      );
    if (/\/users\/[^/]+\/(posts|reactions|comments)$/.test(path))
      return new Response(JSON.stringify({ items: [] }));
    if (/\/users\/[^/]+$/.test(path))
      return new Response(
        JSON.stringify({ provider_id: path.split('/').pop(), shared_connections_count: 1 }),
      );
    return new Response('{}', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function memoryCache(): CacheDep & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async (u, k) => rows.get(`${u}:${k}`),
    put: async (u, e) => {
      rows.set(`${u}:${e.key}`, e.response);
    },
  };
}

const USER = 'a0000000-0000-4000-8000-000000000001';
const TARGET_PERSON = 'a0000000-0000-4000-8000-000000000002';
const MIA = 'a0000000-0000-4000-8000-000000000003';

describe('the server path: the swarm limit', () => {
  it('the research client asks before each read of a person and makes no call when refused', async () => {
    const net = unipileFetch();
    const take = dbTake(1200);
    const u = createUnipileResearch({ fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE, targetTake: take });
    expect((await u.profile('acc-1', TARGET)).ok).toBe(true);
    expect((await u.reactionsOf('acc-1', TARGET)).ok).toBe(true);
    const n = net.calls.length;
    for (const r of [
      await u.profile('acc-2', TARGET),
      await u.posts('acc-2', TARGET),
      await u.postsOf('acc-2', TARGET),
      await u.reactionsOf('acc-2', TARGET),
      await u.commentsOf('acc-2', TARGET),
      await u.mutuals('acc-2', TARGET),
    ])
      expect(r).toMatchObject({ ok: false, kind: 'busy', retryAt: expect.any(String) });
    expect(net.calls.length).toBe(n);
    // one take per mutuals lookup, not one for its profile read and another for its search
    const asked = take.asked.length;
    expect((await u.mutuals('acc-1', TARGET)).ok).toBe(true);
    expect(take.asked.length).toBe(asked + 1);
  });

  it('gatherExternalCandidates: a refused lookup writes no mutual ties, keeps nothing and says mutuals are pending', async () => {
    const net = unipileFetch();
    const cache = memoryCache();
    const refuse: TargetTake = async () => ({ allowed: false, retryAt: '2026-11-13T10:00:00.000Z' });
    const unipile = createUnipileResearch({
      fetch: net.fetch,
      apiKey: 'k',
      baseUrl: UNIPILE,
      targetTake: refuse,
    });
    const village = createVillage({ fetch: net.fetch });
    const deps = {
      unipile,
      village,
      cache,
      clock: () => Date.now(),
      resolvePerson: async () => MIA,
    };
    const input = {
      userId: USER,
      target: { kind: 'person' as const, personId: TARGET_PERSON, memberId: TARGET, name: 'Omar Haddad' },
      unipileAccountId: 'acc-1',
    };
    const r = await gatherExternalCandidates(deps, input);
    expect(r.ties).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(r.mutualsPending).toEqual({ retryAt: '2026-11-13T10:00:00.000Z' });
    expect(r.skipped).toContain('mutuals: not checked yet');
    expect(cache.rows.size).toBe(0);
    expect(net.calls).toEqual([]);
    // allowed: the mutual tie is written and the answer kept, and nothing is pending
    const ok = await gatherExternalCandidates(
      { ...deps, unipile: createUnipileResearch({ fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE }) },
      input,
    );
    expect(ok.mutualsPending).toBeUndefined();
    expect(ok.ties).toHaveLength(1);
    expect(cache.rows.size).toBe(1);
  });

  it('hop evidence: a refused person is skipped before the day’s allowance is spent, nothing kept, not complete', async () => {
    const net = unipileFetch();
    const cache = memoryCache();
    const spent: string[] = [];
    // the target is fine; the mutual was looked up by other accounts lately
    const take: TargetTake = async (_a, target) => ({ allowed: target !== 'ACoMia' });
    const r = await gatherHopEvidence(
      {
        unipile: createUnipileResearch({ fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE, targetTake: take }),
        cache,
        budget: {
          take: async (a, _u, ledger) => {
            spent.push(`${a}:${ledger}`);
            return true;
          },
        },
        clock: () => Date.now(),
        targetTake: take,
      },
      {
        userId: USER,
        unipileAccountId: 'acc-1',
        target: { personId: TARGET_PERSON, memberId: TARGET },
        mutuals: [{ personId: MIA, memberId: 'ACoMia' }],
      },
    );
    expect(r.complete).toBe(false);
    expect(net.calls.some((c) => c.includes('ACoMia'))).toBe(false);
    // the target's profile, posts, reactions and comments: four reads, four units; none for Mia
    expect(spent).toHaveLength(4);
    expect([...cache.rows.keys()].length).toBe(4);
    expect(r.errors).toEqual(['reactions: not now', 'comments: not now']);
  });

  it('profile reading skips a person other accounts looked up lately, and marks nothing', async () => {
    const u = await makeUser(t.db);
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, linkedin_member_id)
      values (${u}::uuid, 'Omar Haddad', 'omar haddad', 'ACoReading') returning id`;
    const net = unipileFetch();
    const take = sqlTargetTake(t.db);
    await take('acc-other', 'ACoReading', 'reading');
    const step = await runReadingStep(
      t.db,
      {
        fetch: net.fetch,
        apiKey: 'k',
        baseUrl: UNIPILE,
        sleep: async () => {},
        random: () => 0,
        clock: Date.now,
        targetTake: take,
      },
      u,
      'acc-1',
      new Date(),
      { mode: 'ask', personIds: [p!.id] },
    );
    expect(step.later).toBe(1);
    expect(step.profiles).toBe(0);
    expect(net.calls.filter((c) => c.includes('ACoReading'))).toEqual([]);
    const reads = await t.db.sql`select 1 from orbit.profile_reads where person_id = ${p!.id}::uuid`;
    expect(reads).toHaveLength(0);
  });

  it('sqlTargetTake counts a refusal for the day as kind swarm, and reads its limits from the environment', async () => {
    const take = sqlTargetTake(t.db, { accountsPerDay: 3, gapSeconds: 1200 });
    expect(await take('acc-1', 'ACoServer', 'hop')).toEqual({ allowed: true });
    const refused = await take('acc-2', 'ACoServer', 'hop');
    expect(refused.allowed).toBe(false);
    const rows = await t.db.sql<{ linkedin_account: string; kind: string; caller: string; refused: number }>`
      select linkedin_account, kind, caller, refused from orbit.linkedin_calls_daily`;
    expect(rows).toEqual([{ linkedin_account: 'acc-2', kind: 'swarm', caller: 'hop', refused: 1 }]);
    expect(targetLimitsFrom(() => undefined)).toEqual({ accountsPerDay: 3, gapSeconds: 1200 });
    expect(
      targetLimitsFrom(
        (n) => ({ ORBIT_LINKEDIN_TARGET_ACCOUNTS_PER_DAY: '5', ORBIT_LINKEDIN_TARGET_GAP_SECONDS: 'x' })[n],
      ),
    ).toEqual({ accountsPerDay: 5, gapSeconds: 1200 });
  });
});
