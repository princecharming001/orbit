import { afterEach, describe, expect, it } from 'vitest';
import { setConnectorModeForTests } from './connectorOutcome';
import { linkedInProfile } from './enrichmentProxy';
import {
  disconnectLinkedInAccount,
  linkedInConnections,
  linkedInConnectStatus,
  linkedInEngagement,
  linkedInLedger,
  mutualConnections,
  SEARCH_LIMIT_STATUS,
  setUnipileUrlForTests,
  startLinkedInConnect,
  unipileConfigured,
} from './unipile';
import {
  setVillageRefusedForTests,
  setVillageUrlForTests,
  villageConfigured,
  villageLookup,
  villagePaths,
  villageRefused,
} from './village';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';

/** A fetch that answers by path, recording the calls. */
function stub(routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = key ? routes[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const UNCONFIGURED = {
  status: 503,
  body: { error: 'not configured' },
  headers: { 'x-orbit-connector': 'unconfigured' },
};

/** A fetch that never answers until aborted. */
const hanging = (async (_url: string, init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;

afterEach(() => {
  setUnipileUrlForTests(undefined);
  setVillageUrlForTests(undefined);
  setConnectorModeForTests(undefined);
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
    expect(await startLinkedInConnect({ fetch: fn })).toEqual({
      ok: true,
      value: { url: 'https://unipile/login/abc', ref: 'ref_1' },
    });
    expect(await linkedInConnectStatus('ref_1', { fetch: fn })).toEqual({
      ok: true,
      value: { status: 'connected', accountId: 'acc_1', message: undefined },
    });
  });

  it('reads a failed sign-in as error and anything unknown as pending', async () => {
    setUnipileUrlForTests(BASE);
    const failed = stub({ '/connect/status': { body: { status: 'error', message: 'Wrong password' } } });
    const r = await linkedInConnectStatus('r', { fetch: failed.fn });
    expect(r).toMatchObject({ ok: true, value: { status: 'error', message: 'Wrong password' } });
    const odd = stub({ '/connect/status': { body: { status: 'CONNECTING' } } });
    expect(await linkedInConnectStatus('r', { fetch: odd.fn })).toMatchObject({
      ok: true,
      value: { status: 'pending' },
    });
  });

  it('says unconfigured when the proxy has no Unipile key yet', async () => {
    setUnipileUrlForTests(BASE);
    const { fn } = stub({ '/connect/start': UNCONFIGURED, '/relations': UNCONFIGURED });
    expect(await startLinkedInConnect({ fetch: fn })).toMatchObject({ ok: false, reason: 'unconfigured' });
    expect(await linkedInConnections('a', { fetch: fn })).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
    // with no proxy at all it is unconfigured too, and nothing is fetched
    setUnipileUrlForTests(null);
    expect(await startLinkedInConnect({ fetch: hanging })).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('a test can ask for the unconfigured answer without any network', async () => {
    setConnectorModeForTests('unconfigured');
    expect(unipileConfigured()).toBe(true);
    expect(await startLinkedInConnect({ fetch: hanging })).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
    setConnectorModeForTests('off');
    expect(unipileConfigured()).toBe(false);
  });

  it('gives up after its timeout instead of hanging', async () => {
    setUnipileUrlForTests(BASE);
    const r = await linkedInConnections('a', { fetch: hanging, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('reports other failures as errors with the status', async () => {
    setUnipileUrlForTests(BASE);
    const { fn } = stub({ '/relations': { status: 502, body: { error: 'unipile 500' } } });
    expect(await linkedInConnections('a', { fetch: fn })).toMatchObject({
      ok: false,
      reason: 'error',
      status: 502,
    });
  });

  it('pages all connections and maps them to the import shape', async () => {
    setUnipileUrlForTests(BASE);
    let page = 0;
    const cursors: unknown[] = [];
    const fn = (async (_url: string, init: RequestInit) => {
      cursors.push((JSON.parse(init.body as string) as { cursor?: unknown }).cursor);
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
    const counts: number[] = [];
    const r = await linkedInConnections('acc_1', { fetch: fn, onProgress: (n) => counts.push(n) });
    if (!r.ok) throw new Error(r.message);
    expect(r.value).toHaveLength(2);
    expect(r.value[0]).toMatchObject({
      firstName: 'Priya',
      lastName: 'Shah',
      company: 'Figma',
      position: 'Product Manager',
      url: 'https://linkedin.com/in/priya',
      connectedOn: '2026-03-04',
      memberId: 'm_priya',
    });
    expect(r.value[1]!.firstName).toBe('Noah');
    expect(cursors).toEqual([undefined, 'c2']);
    expect(counts).toEqual([1, 2]);
  });

  it('returns mutual connections, and a typed failure when off or erroring', async () => {
    setUnipileUrlForTests(BASE);
    const { fn } = stub({
      '/mutuals': {
        body: {
          verified: true,
          mutuals: [{ name: 'Mia Chen', headline: 'PM at Stripe', member_id: 'm_mia' }],
        },
      },
    });
    expect(await mutualConnections('acc_1', 'm_target', { fetch: fn })).toEqual({
      ok: true,
      value: [{ name: 'Mia Chen', headline: 'PM at Stripe', url: undefined, memberId: 'm_mia' }],
    });
    setUnipileUrlForTests(null);
    expect(await mutualConnections('acc_1', 'm_target', { fetch: fn })).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
    setUnipileUrlForTests(BASE);
    const bad = stub({ '/mutuals': { status: 500, body: {} } });
    expect(await mutualConnections('acc_1', 'm_target', { fetch: bad.fn })).toMatchObject({
      ok: false,
      reason: 'error',
    });
  });

  it('says when mutual connections stopped at the day’s LinkedIn reads', async () => {
    setUnipileUrlForTests(BASE);
    const { fn } = stub({
      '/mutuals': {
        body: {
          ok: false,
          reason: 'limit',
          message: 'Orbit has read as much from LinkedIn as it allows today. It carries on tomorrow.',
        },
      },
    });
    expect(await mutualConnections('acc_1', 'm_target', { fetch: fn })).toEqual({
      ok: false,
      reason: 'error',
      message: 'Orbit has read as much from LinkedIn as it allows today. It carries on tomorrow.',
      status: SEARCH_LIMIT_STATUS,
    });
  });

  it('reads one page of engagement with the token, keeping only well-formed items', async () => {
    setUnipileUrlForTests(BASE);
    const { fn, calls } = stub({
      '/engagement': {
        body: {
          ok: true,
          want: 'posts',
          items: [
            {
              id: '725',
              socialId: 'urn:li:activity:725',
              at: '2026-10-01T09:00:00.000Z',
              reactions: 4,
              comments: 1,
              mentions: ['ACoAna', 7],
              tagged: 2,
              text: 'never kept',
            },
            { id: '726', at: 'not a date', reactions: -1 },
            { reactions: 3 },
          ],
          cursor: 'c2',
        },
      },
    });
    const r = await linkedInEngagement(
      'acc_1',
      { memberId: 'ACoB', want: 'posts', cursor: 'c1' },
      { token: 'tok', fetch: fn },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        want: 'posts',
        items: [
          {
            id: '725',
            socialId: 'urn:li:activity:725',
            at: '2026-10-01T09:00:00.000Z',
            reactions: 4,
            comments: 1,
            mentions: ['ACoAna'],
            tagged: 2,
          },
          { id: '726', reactions: 0, comments: 0, mentions: [], tagged: 0 },
        ],
        cursor: 'c2',
      },
    });
    expect(calls[0]).toEqual({
      url: `${BASE}/engagement`,
      body: { accountId: 'acc_1', token: 'tok', memberId: 'ACoB', want: 'posts', cursor: 'c1' },
    });
  });

  it('maps reactions, comments and threads, and passes the post for a thread', async () => {
    setUnipileUrlForTests(BASE);
    const page = (want: string, items: unknown[]) =>
      stub({ '/engagement': { body: { ok: true, want, items, cursor: null } } });
    const reactions = page('reactions', [
      { postId: '1', authorId: 'ACoB', onComment: true },
      { postId: '2' },
    ]);
    expect(
      await linkedInEngagement('acc_1', { memberId: 'ACoA', want: 'reactions' }, { fetch: reactions.fn }),
    ).toEqual({
      ok: true,
      value: { want: 'reactions', items: [{ postId: '1', authorId: 'ACoB', onComment: true }], cursor: null },
    });
    const comments = page('comments', [{ id: 'c1', postId: '1', threadId: 'c0', text: 'x' }, { id: 'c2' }]);
    expect(
      await linkedInEngagement('acc_1', { memberId: 'ACoA', want: 'comments' }, { fetch: comments.fn }),
    ).toEqual({
      ok: true,
      value: { want: 'comments', items: [{ id: 'c1', postId: '1', threadId: 'c0' }], cursor: null },
    });
    const thread = page('thread', [{ id: 'k1', commenterId: 'ACoA', at: '2026-10-19T10:00:00.000Z' }]);
    expect(
      await linkedInEngagement(
        'acc_1',
        { memberId: 'ACoB', want: 'thread', postId: '725' },
        { fetch: thread.fn },
      ),
    ).toEqual({
      ok: true,
      value: {
        want: 'thread',
        items: [{ id: 'k1', commenterId: 'ACoA', at: '2026-10-19T10:00:00.000Z' }],
        cursor: null,
      },
    });
    expect(thread.calls[0]!.body).toMatchObject({ want: 'thread', postId: '725' });
  });

  it('says limit and unavailable apart from errors, and unconfigured when off', async () => {
    setUnipileUrlForTests(BASE);
    for (const reason of ['limit', 'unavailable'] as const) {
      const { fn } = stub({ '/engagement': { body: { ok: false, reason, message: `m-${reason}` } } });
      expect(await linkedInEngagement('acc_1', { memberId: 'ACoB', want: 'posts' }, { fetch: fn })).toEqual({
        ok: false,
        reason,
        message: `m-${reason}`,
      });
    }
    const down = stub({ '/engagement': { status: 502, body: { error: 'unipile 500' } } });
    expect(
      await linkedInEngagement('acc_1', { memberId: 'ACoB', want: 'posts' }, { fetch: down.fn }),
    ).toMatchObject({ ok: false, reason: 'error', status: 502 });
    setUnipileUrlForTests(null);
    expect(await linkedInEngagement('acc_1', { memberId: 'ACoB', want: 'posts' })).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it("reads today's LinkedIn ledgers", async () => {
    setUnipileUrlForTests(BASE);
    const { fn, calls } = stub({
      '/ledger': {
        body: {
          ok: true,
          day: '2026-10-20',
          profile: { used: 31, limit: 100 },
          posts: { used: 4, limit: 100 },
          search: { used: 0, limit: 100 },
        },
      },
    });
    expect(await linkedInLedger('acc_1', { token: 'tok', fetch: fn })).toEqual({
      ok: true,
      value: {
        day: '2026-10-20',
        profile: { used: 31, limit: 100 },
        posts: { used: 4, limit: 100 },
        search: { used: 0, limit: 100 },
      },
    });
    expect(calls[0]).toEqual({ url: `${BASE}/ledger`, body: { accountId: 'acc_1', token: 'tok' } });
    const bad = stub({ '/ledger': { status: 503, body: { error: 'unavailable right now' } } });
    expect(await linkedInLedger('acc_1', { fetch: bad.fn })).toMatchObject({ ok: false, reason: 'error' });
  });

  it('asks a profile for recommendations and marks a route read, and keeps the new counts', async () => {
    setUnipileUrlForTests(BASE);
    const { fn, calls } = stub({
      '/profile': {
        body: {
          ok: true,
          profile: {
            providerId: 'ACoB',
            experience: [],
            education: [],
            throttled: [],
            followerCount: 1200,
            connectionsCount: 500,
            recommendations: [{ direction: 'received', actorId: 'ACoA', year: 2023 }],
          },
        },
      },
    });
    const r = await linkedInProfile('acc_1', 'ACoB', ['experience'], {
      fetch: fn,
      recommendations: true,
      purpose: 'route',
    });
    expect(r).toMatchObject({
      ok: true,
      value: {
        followerCount: 1200,
        connectionsCount: 500,
        recommendations: [{ direction: 'received', actorId: 'ACoA', year: 2023 }],
      },
    });
    expect(calls[0]!.body).toMatchObject({
      recommendations: true,
      purpose: 'route',
      sections: ['experience'],
    });
  });

  it('asks the proxy to unlink an account', async () => {
    setUnipileUrlForTests(BASE);
    const { fn, calls } = stub({ '/disconnect': { body: { ok: true } } });
    expect(await disconnectLinkedInAccount('acc_1', { fetch: fn })).toEqual({
      ok: true,
      value: { disconnected: true },
    });
    expect(calls[0]).toMatchObject({ url: `${BASE}/disconnect`, body: { accountId: 'acc_1' } });
  });
});

describe('Village (warm intros) adapter', () => {
  it('is off until a proxy url is set', () => {
    setVillageUrlForTests(null);
    expect(villageConfigured()).toBe(false);
    setVillageUrlForTests(BASE);
    expect(villageConfigured()).toBe(true);
  });

  it('a refused key pauses Village for the day: the next lookup asks nothing, and Settings can say so', async () => {
    setVillageUrlForTests(BASE);
    setVillageRefusedForTests(undefined);
    const { fn, calls } = stub({ '/paths': { body: { paths: [], reason: 'unauthorized' } } });
    const r = await villageLookup({ name: 'Dana Lee', company: 'Stripe' }, { fetch: fn });
    expect(r).toMatchObject({ ok: false, reason: 'error', status: 401 });
    expect(villageRefused()).toBe(true);
    expect(await villageLookup({ name: 'Dana Lee', company: 'Stripe' }, { fetch: fn })).toEqual({
      ok: true,
      value: [],
    });
    expect(calls).toHaveLength(1);
    expect(villageRefused(Date.now() + 25 * 60 * 60_000)).toBe(false);
    setVillageRefusedForTests(undefined);
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

  it('says unconfigured, timeout or error in the typed lookup', async () => {
    setVillageUrlForTests(BASE);
    const off = stub({ '/paths': UNCONFIGURED });
    expect(await villageLookup({ company: 'Stripe' }, { fetch: off.fn })).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
    expect(await villageLookup({ company: 'Stripe' }, { fetch: hanging, timeoutMs: 20 })).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
    const bad = stub({ '/paths': { status: 404, body: {} } });
    expect(await villageLookup({ company: 'Stripe' }, { fetch: bad.fn })).toMatchObject({
      ok: false,
      reason: 'error',
      status: 404,
    });
  });
});

describe('a LinkedIn connection date', () => {
  it('reads ISO text and epoch milliseconds or seconds alike', async () => {
    const { connectedDay } = await import('./unipile');
    expect(connectedDay('2024-09-22T10:13:20.000Z')).toBe('2024-09-22');
    expect(connectedDay(1_727_000_000_000)).toBe('2024-09-22');
    expect(connectedDay('1727000000')).toBe('2024-09-22');
    expect(connectedDay(undefined)).toBeUndefined();
  });
});
