import { describe, expect, it } from 'vitest';
import {
  accountToken,
  type Bucket,
  type ConnectorDeps,
  defaultOrigins,
  isoDate,
  makeHandler,
  mapRelation,
  memoryLinks,
  memoryTake,
  postDate,
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
const SIGNING = 'test-signing-key-not-a-real-one';
// the tokens /connect/status hands a browser for these accounts
const TOKEN: Record<string, string> = {
  a1: await accountToken('a1', SIGNING),
  acc_1: await accountToken('acc_1', SIGNING),
};

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

function harness(over: Partial<ConnectorDeps> = {}, upstreamOver?: Upstream) {
  const upstream: { url: string; method: string; body: unknown }[] = [];
  const answer: Upstream = (url, init) => {
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
    // a plain profile read: LinkedIn says how many connections the student shares with that member
    if (/\/api\/v1\/users\/(?!relations|me\b|invite)[^/?]+\?account_id=/.test(url))
      return new Response(JSON.stringify({ provider_id: 'ACoT', shared_connections_count: 1 }), {
        status: 200,
      });
    if (url.includes('/linkedin/search'))
      // LinkedIn says which filters it applied (config.params), as Unipile's answers do
      return new Response(
        JSON.stringify({
          items: [{ name: 'Mia Chen', member_id: 'm2' }],
          config: { params: JSON.parse((init?.body as string) || '{}') },
        }),
        { status: 200 },
      );
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
    signingKey: SIGNING,
    fetch: (async (url: string, init: RequestInit = {}) => {
      upstream.push({
        url,
        method: init.method ?? 'GET',
        body:
          typeof init.body === 'string'
            ? JSON.parse(init.body)
            : init.body instanceof FormData
              ? Object.fromEntries(init.body)
              : undefined,
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

  it("matches a LinkedIn sign-in through Unipile's signed callback, even when the account's name is the person's", async () => {
    const links = memoryLinks();
    const accountState = (url: string) =>
      url.endsWith('/api/v1/accounts/acc_9')
        ? new Response(JSON.stringify({ id: 'acc_9', name: 'Anish Polakala', sources: [{ status: 'OK' }] }), {
            status: 200,
          })
        : url.includes('/api/v1/accounts?')
          ? // the account list names the account after the person, not after Orbit's reference
            new Response(
              JSON.stringify({
                items: [{ id: 'acc_9', name: 'Anish Polakala', sources: [{ status: 'OK' }] }],
              }),
            )
          : url.includes('/hosted/accounts/link')
            ? new Response(JSON.stringify({ url: 'https://unipile/login' }), { status: 200 })
            : new Response('{}', { status: 404 });
    const { handler, upstream } = harness(
      { links, publicUrl: 'https://x.supabase.co/functions/v1/orbit-connectors' },
      accountState,
    );
    await handler(post('/connect/start', {}));
    const notifyUrl = String((upstream[0]!.body as { notify_url?: string }).notify_url);
    expect(notifyUrl).toMatch(
      /^https:\/\/x\.supabase\.co\/functions\/v1\/orbit-connectors\/connect\/notify\?ref=ref1&sig=/,
    );
    // before Unipile reports back, still waiting
    expect(await (await handler(post('/connect/status', { ref: 'ref1' }))).json()).toEqual({
      status: 'pending',
    });
    const report = (url: string, body: unknown) =>
      handler(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    // a forged report: wrong signature, or another sign-in's reference
    const forged = notifyUrl.replace(/sig=[^&]+/, 'sig=nope');
    expect(
      (await report(forged, { status: 'CREATION_SUCCESS', account_id: 'acc_evil', name: 'ref1' })).status,
    ).toBe(403);
    expect(
      (await report(notifyUrl, { status: 'CREATION_SUCCESS', account_id: 'acc_evil', name: 'ref2' })).status,
    ).toBe(400);
    // Unipile's real report
    expect(
      (await report(notifyUrl, { status: 'CREATION_SUCCESS', account_id: 'acc_9', name: 'ref1' })).status,
    ).toBe(200);
    expect(await (await handler(post('/connect/status', { ref: 'ref1' }))).json()).toEqual({
      status: 'connected',
      accountId: 'acc_9',
      token: TOKEN.acc_9 ?? expect.any(String),
    });
  });

  it('maps the connect status: connected, pending, failed sign-ins as error', async () => {
    const ok = harness();
    expect(await (await ok.handler(post('/connect/status', { ref: 'ref1' }))).json()).toEqual({
      status: 'connected',
      accountId: 'acc_1',
      token: TOKEN.acc_1,
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
    const r2 = await down.handler(post('/relations', { accountId: 'a1', token: TOKEN.a1 }));
    expect(r2.status).toBe(502);
    expect(await r2.json()).toEqual({ error: 'unipile 500' });
  });

  it("returns the student's own profile with their photo kept as an image, fetched only from LinkedIn", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const seen: string[] = [];
    const me = harness({}, (url) => {
      seen.push(url);
      if (url.includes('/api/v1/users/me'))
        return new Response(
          JSON.stringify({
            first_name: 'Anish',
            last_name: 'P',
            headline: 'Student at Berkeley',
            profile_picture_url: 'https://media.licdn.com/dms/image/abc/profile.jpg',
          }),
          { status: 200 },
        );
      if (url.startsWith('https://media.licdn.com/'))
        return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      return new Response('{}', { status: 404 });
    });
    const r = (await (await me.handler(post('/me', { accountId: 'a1', token: TOKEN.a1 }))).json()) as {
      firstName: string;
      picture?: string;
    };
    expect(r.firstName).toBe('Anish');
    expect(r.picture).toBe(`data:image/jpeg;base64,${btoa(String.fromCharCode(...jpeg))}`);
    // a photo link anywhere but LinkedIn's image hosts is never fetched
    const away = harness({}, (url) =>
      url.includes('/api/v1/users/me')
        ? new Response(
            JSON.stringify({ first_name: 'A', profile_picture_url: 'https://evil.example/x.jpg' }),
            {
              status: 200,
            },
          )
        : new Response('nope', { status: 500 }),
    );
    const r2 = (await (await away.handler(post('/me', { accountId: 'a1', token: TOKEN.a1 }))).json()) as {
      picture?: string;
    };
    expect(r2.picture).toBeUndefined();
    // and it needs the account's token, like every account route
    expect((await me.handler(post('/me', { accountId: 'a1' }))).status).toBeGreaterThanOrEqual(400);
  });

  it('reads a relation whichever shape Unipile sends: a numeric date, a name in one field, a slug for the link', () => {
    expect(isoDate(1_727_000_000_000)).toBe('2024-09-22T10:13:20.000Z');
    expect(isoDate(1_727_000_000)).toBe('2024-09-22T10:13:20.000Z');
    expect(isoDate('2024-09-22T10:13:20Z')).toBe('2024-09-22T10:13:20.000Z');
    expect(isoDate('nonsense')).toBeUndefined();
    expect(
      mapRelation({
        display_name: 'Ana de la Cruz',
        public_identifier: 'ana-dlc',
        created_at: 1_727_000_000_000,
        provider_id: 'ACo123',
        profile_picture_url: 'https://media.licdn.com/dms/image/x.jpg',
      }),
    ).toMatchObject({
      first_name: 'Ana',
      last_name: 'de la Cruz',
      public_profile_url: 'https://www.linkedin.com/in/ana-dlc',
      connected_at: '2024-09-22T10:13:20.000Z',
      member_id: 'ACo123',
      picture_url: 'https://media.licdn.com/dms/image/x.jpg',
    });
  });

  it('maps relations and mutuals, and forwards Village paths', async () => {
    const { handler } = harness();
    const rel = (await (await handler(post('/relations', { accountId: 'a1', token: TOKEN.a1 }))).json()) as {
      items: { first_name: string }[];
    };
    expect(rel.items[0]!.first_name).toBe('Priya');
    const mut = (await (
      await handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 't' }))
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

  it('refuses an account route without the token this browser was given, before reaching Unipile', async () => {
    const { handler, upstream } = harness();
    for (const [path, body] of [
      ['/relations', { accountId: 'a1' }],
      ['/mutuals', { accountId: 'a1', token: TOKEN.acc_1, targetMemberId: 't' }],
      ['/disconnect', { accountId: 'acc_1', token: 'forged' }],
      ['/send', { accountId: 'acc_1', text: 'hi', memberId: 'm1' }],
    ] as const) {
      const r = await handler(post(path, body));
      expect(r.status).toBe(403);
    }
    expect(upstream).toHaveLength(0);
    // and with no signing key at all, no account route is open
    const unsigned = harness({ signingKey: undefined });
    expect((await unsigned.handler(post('/relations', { accountId: 'a1', token: TOKEN.a1 }))).status).toBe(
      403,
    );
  });

  it('sends a message to a connection as a new chat from the student’s account', async () => {
    const { handler, upstream } = harness({}, (url) =>
      url.endsWith('/api/v1/chats')
        ? new Response(JSON.stringify({ object: 'ChatStarted', chat_id: 'c1', message_id: 'msg1' }), {
            status: 201,
          })
        : new Response('{}', { status: 404 }),
    );
    const r = await handler(
      post('/send', {
        accountId: 'acc_1',
        token: TOKEN.acc_1,
        memberId: 'm1',
        text: ' Hi Priya ',
        invite: false,
      }),
    );
    expect(await r.json()).toEqual({
      ok: true,
      invited: false,
      chatId: 'c1',
      messageId: 'msg1',
      memberId: 'm1',
    });
    expect(upstream).toEqual([
      {
        url: 'https://api1.unipile.com:443/api/v1/chats',
        method: 'POST',
        body: { account_id: 'acc_1', text: 'Hi Priya', attendees_ids: 'm1' },
      },
    ]);
  });

  it('sends a connection request with the note to someone not connected, looking them up by profile name', async () => {
    const { handler, upstream } = harness({}, (url) =>
      url.includes('/api/v1/users/dana-lee?')
        ? new Response(JSON.stringify({ provider_id: 'ACoAA1' }), { status: 200 })
        : url.endsWith('/api/v1/users/invite')
          ? new Response(JSON.stringify({ object: 'UserInvitationSent', invitation_id: 'inv1' }), {
              status: 201,
            })
          : new Response('{}', { status: 404 }),
    );
    const r = await handler(
      post('/send', {
        accountId: 'acc_1',
        token: TOKEN.acc_1,
        slug: 'dana-lee',
        text: 'Hi Dana',
        invite: true,
      }),
    );
    expect(await r.json()).toEqual({ ok: true, invited: true, messageId: 'inv1', memberId: 'ACoAA1' });
    expect(upstream[0]!.url).toBe('https://api1.unipile.com:443/api/v1/users/dana-lee?account_id=acc_1');
    expect(upstream[1]).toMatchObject({
      url: 'https://api1.unipile.com:443/api/v1/users/invite',
      body: { account_id: 'acc_1', provider_id: 'ACoAA1', message: 'Hi Dana' },
    });
    // a note longer than LinkedIn allows never leaves
    const long = harness();
    const r2 = await long.handler(
      post('/send', {
        accountId: 'acc_1',
        token: TOKEN.acc_1,
        slug: 'dana-lee',
        text: 'x'.repeat(301),
        invite: true,
      }),
    );
    expect(await r2.json()).toMatchObject({ ok: false, reason: 'bad_request' });
    expect(long.upstream).toHaveLength(0);
  });

  it('passes on what LinkedIn says when it refuses, and stops an account at its daily sends', async () => {
    const refused = harness(
      {},
      () =>
        new Response(JSON.stringify({ title: 'Recipient cannot be reached', status: 422 }), { status: 422 }),
    );
    const r = await refused.handler(
      post('/send', { accountId: 'acc_1', token: TOKEN.acc_1, memberId: 'm1', text: 'Hi' }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false, reason: 'refused', message: 'Recipient cannot be reached' });
    const at = new Date('2026-10-16T09:00:00Z');
    const capped = harness(
      { sendsPerDay: 2, now: () => at, take: memoryTake(() => at.getTime()) },
      () => new Response(JSON.stringify({ chat_id: 'c', message_id: 'm' }), { status: 201 }),
    );
    const send = () =>
      capped.handler(post('/send', { accountId: 'acc_1', token: TOKEN.acc_1, memberId: 'm1', text: 'Hi' }));
    expect(await (await send()).json()).toMatchObject({ ok: true });
    expect(await (await send()).json()).toMatchObject({ ok: true });
    expect(await (await send()).json()).toMatchObject({ ok: false, reason: 'limit' });
    expect(capped.upstream).toHaveLength(2);
  });

  it('asks LinkedIn for mutual connections: the target profile for the shared count, then the 1st degree filtered by "Connections of"', async () => {
    const { handler, upstream } = harness();
    const r = (await (
      await handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }))
    ).json()) as { verified: boolean; count: number; mutuals: { name: string }[] };
    expect(upstream[0]!.url).toBe('https://api1.unipile.com:443/api/v1/users/ACoT?account_id=a1');
    expect(upstream[1]!.body).toEqual({
      api: 'classic',
      category: 'people',
      network_distance: [1],
      connections_of: ['ACoT'],
    });
    expect(r).toMatchObject({ verified: true, count: 1, mutuals: [{ name: 'Mia Chen' }] });
  });

  it('claims nothing when LinkedIn gives no shared count, and searches nothing when it says zero', async () => {
    const profile = (body: Record<string, unknown>) => (url: string) =>
      url.includes('/api/v1/users/ACoT?')
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response('{}', { status: 404 });
    const none = harness({}, profile({ provider_id: 'ACoT' }));
    expect(
      await (
        await none.handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }))
      ).json(),
    ).toEqual({ mutuals: [], verified: false, reason: 'no_shared_count' });
    const zero = harness({}, profile({ provider_id: 'ACoT', shared_connections_count: 0 }));
    expect(
      await (
        await zero.handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }))
      ).json(),
    ).toEqual({ mutuals: [], verified: true, count: 0 });
    expect(zero.upstream).toHaveLength(1);
  });

  it("a search far bigger than the shared count is the student's own connections, never shown as mutual ones", async () => {
    const { handler } = harness({}, (url, init) =>
      url.includes('/api/v1/users/ACoT?')
        ? new Response(JSON.stringify({ provider_id: 'ACoT', shared_connections_count: 3 }), { status: 200 })
        : new Response(
            JSON.stringify({
              items: [{ name: 'Hem Baid', member_id: 'm_hem', network_distance: 'DISTANCE_1' }],
              config: { params: JSON.parse((init?.body as string) || '{}') },
              paging: { total_count: 1512 },
            }),
            { status: 200 },
          ),
    );
    const r = await (
      await handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }))
    ).json();
    expect(r).toEqual({ mutuals: [], verified: false, reason: 'unfiltered', count: 3 });
  });

  it('a 502 carries what Unipile said, so a refusal can be read from the logs', async () => {
    const { handler } = harness({}, (url) =>
      url.includes('/api/v1/users/ACoT?')
        ? new Response(JSON.stringify({ provider_id: 'ACoT', shared_connections_count: 3 }), { status: 200 })
        : new Response(JSON.stringify({ type: 'errors/invalid_parameters', detail: 'connections_of' }), {
            status: 400,
          }),
    );
    const res = await handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      'unipile 400: {"type":"errors/invalid_parameters","detail":"connections_of"}',
    );
  });

  it('an answer LinkedIn did not filter by "Connections of" is never passed off as mutual connections', async () => {
    // LinkedIn dropped the filter: the student's own connections came back, and the search says so
    const { handler } = harness({}, (url) =>
      url.includes('/api/v1/users/ACoT?')
        ? new Response(JSON.stringify({ provider_id: 'ACoT', shared_connections_count: 3 }), { status: 200 })
        : url.includes('/linkedin/search')
          ? new Response(
              JSON.stringify({
                items: [{ name: 'Hem Baid', member_id: 'm_hem', network_distance: 'DISTANCE_1' }],
                config: { params: { api: 'classic', category: 'people', network_distance: [1] } },
              }),
              { status: 200 },
            )
          : new Response('{}', { status: 404 }),
    );
    const r = (await (
      await handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }))
    ).json()) as { verified: boolean; mutuals: unknown[] };
    expect(r).toEqual({ mutuals: [], verified: false, reason: 'filter_dropped' });
  });

  it('reads every page of mutual connections, and leaves out the target and anyone not 1st degree', async () => {
    let page = 0;
    const { handler, upstream } = harness({}, (url, init) => {
      if (url.includes('/api/v1/users/ACoT?'))
        return new Response(JSON.stringify({ provider_id: 'ACoT', shared_connections_count: 2 }), {
          status: 200,
        });
      if (!url.includes('/linkedin/search')) return new Response('{}', { status: 404 });
      page++;
      const params = JSON.parse(init.body as string);
      const items =
        page === 1
          ? [
              { name: 'Mia Chen', member_id: 'm_mia', network_distance: 'DISTANCE_1' },
              { name: 'The Target', member_id: 'ACoT', network_distance: 'DISTANCE_1' },
            ]
          : [
              { name: 'Ben Ortiz', member_id: 'm_ben', network_distance: 'DISTANCE_1' },
              { name: 'Far Away', member_id: 'm_far', network_distance: 'DISTANCE_2' },
            ];
      return new Response(
        JSON.stringify({
          items,
          config: { params },
          paging: { total_count: 2 },
          cursor: page === 1 ? 'next' : null,
        }),
        { status: 200 },
      );
    });
    const r = (await (
      await handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }))
    ).json()) as { verified: boolean; count: number; mutuals: { name: string }[] };
    expect(r.verified).toBe(true);
    expect(r.count).toBe(2);
    expect(r.mutuals.map((m) => m.name)).toEqual(['Mia Chen', 'Ben Ortiz']);
    expect(upstream).toHaveLength(3);
    expect(upstream[2]!.url).toContain('cursor=next');
  });

  it('reads the inbox: 1:1 messages with who they are with, leaving out events, hidden ones and group chats', async () => {
    const messages = [
      {
        id: 'm1',
        chat_id: 'c1',
        sender_id: 'ACoP',
        text: 'Happy to chat Thursday!',
        timestamp: '2026-10-18T15:00:00.000Z',
        is_sender: 0,
      },
      {
        id: 'm2',
        chat_id: 'c1',
        sender_id: 'ME',
        text: 'Hi Priya, could we talk?',
        timestamp: '2026-10-17T15:00:00.000Z',
        is_sender: 1,
      },
      {
        id: 'm3',
        chat_id: 'c2',
        sender_id: 'ACoG',
        text: 'Group hello',
        timestamp: '2026-10-18T10:00:00.000Z',
        is_sender: 0,
      },
      {
        id: 'm4',
        chat_id: 'c1',
        sender_id: 'ACoP',
        text: 'reacted',
        timestamp: '2026-10-18T16:00:00.000Z',
        is_sender: 0,
        is_event: 1,
      },
      {
        id: 'm5',
        chat_id: 'c1',
        sender_id: 'ACoP',
        text: 'gone',
        timestamp: '2026-10-18T16:30:00.000Z',
        is_sender: 0,
        deleted: 1,
      },
    ];
    const { handler, upstream } = harness({}, (url) => {
      if (url.includes('/api/v1/messages?'))
        return new Response(JSON.stringify({ items: messages, cursor: null }));
      if (url.endsWith('/chats/c1'))
        return new Response(
          JSON.stringify({ id: 'c1', type: 0, name: 'Priya Shah', attendee_provider_id: 'ACoP' }),
        );
      if (url.endsWith('/chats/c2')) return new Response(JSON.stringify({ id: 'c2', type: 1, name: 'Club' }));
      return new Response('{}', { status: 404 });
    });
    const r = (await (
      await handler(post('/inbox', { accountId: 'a1', token: TOKEN.a1, after: '2026-10-10T00:00:00Z' }))
    ).json()) as {
      messages: { id: string; fromMe: boolean; counterpart: { providerId: string } }[];
      latest: string;
    };
    expect(upstream[0]!.url).toContain('account_id=a1');
    expect(upstream[0]!.url).toContain(`after=${encodeURIComponent('2026-10-10T00:00:00.000Z')}`);
    expect(r.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(r.messages[0]).toMatchObject({
      fromMe: false,
      counterpart: { providerId: 'ACoP', name: 'Priya Shah' },
    });
    expect(r.messages[1]!.fromMe).toBe(true);
    expect(r.latest).toBe('2026-10-18T16:30:00.000Z');
    // each chat is looked up once
    expect(upstream.filter((u) => u.url.endsWith('/chats/c1'))).toHaveLength(1);
  });

  it('reads the inbox on with a cursor instead of dropping what one call cannot read, and names chats from one list', async () => {
    const page = (n: number) =>
      Array.from({ length: 3 }, (_, i) => ({
        id: `p${n}m${i}`,
        chat_id: 'c1',
        sender_id: 'ACoP',
        text: `message ${n}.${i}`,
        timestamp: `2026-10-${String(18 - n).padStart(2, '0')}T1${i}:00:00.000Z`,
        is_sender: 0,
      }));
    const { handler, upstream } = harness({}, (url) => {
      if (url.includes('/api/v1/messages?')) {
        const n = Number(new URL(url).searchParams.get('cursor')?.slice(1) ?? 0);
        return new Response(JSON.stringify({ items: page(n), cursor: `k${n + 1}` }));
      }
      if (url.includes('/api/v1/chats?'))
        return new Response(
          JSON.stringify({
            items: [{ id: 'c1', type: 0, name: 'Priya Shah', attendee_provider_id: 'ACoP' }],
            cursor: null,
          }),
        );
      return new Response('{}', { status: 404 });
    });
    const ask = async (extra: Record<string, unknown>) =>
      (await (
        await handler(
          post('/inbox', { accountId: 'a1', token: TOKEN.a1, after: '2026-10-01T00:00:00Z', ...extra }),
        )
      ).json()) as { messages: { id: string }[]; cursor: string | null; more: boolean; complete: boolean };
    const first = await ask({});
    // four pages, then the cursor for the rest: nothing silently left behind
    expect(first.messages).toHaveLength(12);
    expect(first).toMatchObject({ more: true, cursor: 'k4', complete: true });
    // who the chat is with came from the chat list, not one lookup per chat
    expect(upstream.filter((u) => u.url.includes('/api/v1/chats?'))).toHaveLength(1);
    expect(upstream.some((u) => u.url.endsWith('/chats/c1'))).toBe(false);
    const next = await ask({ cursor: first.cursor });
    expect(next.messages[0]!.id).toBe('p4m0');
    const resumed = upstream.filter((u) => u.url.includes('/api/v1/messages?')).at(-4)!.url;
    expect(resumed).toContain('cursor=k4');
    expect(resumed).not.toContain('after=');
  });

  it('says the inbox is incomplete when a chat cannot be looked up, instead of dropping its messages quietly', async () => {
    const { handler } = harness({}, (url) => {
      if (url.includes('/api/v1/messages?'))
        return new Response(
          JSON.stringify({
            items: [
              { id: 'm1', chat_id: 'cx', text: 'hi', timestamp: '2026-10-18T10:00:00.000Z', is_sender: 0 },
            ],
            cursor: null,
          }),
        );
      if (url.includes('/api/v1/chats/cx')) return new Response('{}', { status: 500 });
      if (url.includes('/api/v1/chats?')) return new Response(JSON.stringify({ items: [], cursor: null }));
      return new Response('{}', { status: 404 });
    });
    const r = (await (await handler(post('/inbox', { accountId: 'a1', token: TOKEN.a1 }))).json()) as {
      messages: unknown[];
      complete: boolean;
    };
    expect(r.messages).toHaveLength(0);
    expect(r.complete).toBe(false);
  });

  it('reads the whole 1:1 chat history across calls with a signed cursor: groups, ads and events left out', async () => {
    const msgs: Record<string, Record<string, unknown>[]> = {
      // 30 pages of ten: more than one call reads
      c1: Array.from({ length: 300 }, (_, i) => ({
        id: `a${i}`,
        chat_id: 'c1',
        text: `${'long text '.repeat(30)}${i}`,
        timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(),
        is_sender: i % 2,
      })),
      c3: [
        { id: 'b1', chat_id: 'c3', text: 'Hi!', timestamp: '2026-10-18T10:00:00.000Z', is_sender: 0 },
        { id: 'b2', chat_id: 'c3', text: 'liked', timestamp: '2026-10-18T10:01:00.000Z', is_event: 1 },
        { id: 'b3', chat_id: 'c3', text: 'gone', timestamp: '2026-10-18T10:02:00.000Z', deleted: 1 },
        { id: 'b4', chat_id: 'c3', text: null, timestamp: '2026-10-18T10:03:00.000Z', is_sender: true },
      ],
    };
    const { handler, upstream } = harness({}, (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/chats')
        return new Response(
          JSON.stringify({
            items: [
              { id: 'c1', type: 0, name: 'Priya Shah', attendee_provider_id: 'ACoP' },
              { id: 'c2', type: 1, name: 'Club', attendee_provider_id: 'ACoG' },
              { id: 'c4', type: 0, content_type: 'sponsored', attendee_provider_id: 'ACoAd' },
              { id: 'c3', type: 0, name: 'Sam Lee', attendee_provider_id: 'ACoS' },
            ],
            cursor: null,
          }),
        );
      const m = /\/chats\/(c\d)\/messages$/.exec(u.pathname);
      if (m) {
        // ten a page, newest first, so a chat takes more than one call
        const all = [...(msgs[m[1]!] ?? [])].reverse();
        const from = Number(u.searchParams.get('cursor') ?? 0);
        const items = all.slice(from, from + 10);
        return new Response(
          JSON.stringify({ items, cursor: from + 10 < all.length ? String(from + 10) : null }),
        );
      }
      return new Response('{}', { status: 404 });
    });
    type Hist = {
      chats: {
        chatId: string;
        memberId: string;
        messages: { id: string; out: boolean; text: string; at: string }[];
      }[];
      cursor: string | null;
      latest: string | null;
    };
    const ask = async (extra: Record<string, unknown>) =>
      (await (
        await handler(post('/chats/history', { accountId: 'a1', token: TOKEN.a1, ...extra }))
      ).json()) as Hist;
    const got: Hist['chats'] = [];
    let r = await ask({});
    got.push(...r.chats);
    let calls = 1;
    while (r.cursor && calls < 10) {
      r = await ask({ cursor: r.cursor });
      got.push(...r.chats);
      calls++;
    }
    expect(r.cursor).toBeNull();
    const ids = got.flatMap((c) => c.messages.map((m) => m.id));
    // every message of both 1:1 chats, each once; the group, the ad, the event and the deleted one left out
    expect(calls).toBeGreaterThan(1);
    expect(ids.filter((id) => id.startsWith('a'))).toHaveLength(300);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('b')).sort()).toEqual(['b1', 'b4']);
    expect(new Set(got.map((c) => c.memberId))).toEqual(new Set(['ACoP', 'ACoS']));
    const sample = got.find((c) => c.chatId === 'c1')!.messages[0]!;
    expect(sample.text.length).toBeLessThanOrEqual(140);
    expect(got.find((c) => c.chatId === 'c3')!.messages.find((m) => m.id === 'b4')).toMatchObject({
      out: true,
      text: '',
    });
    // the whole history: no `after` was sent
    expect(upstream.some((u) => u.url.includes('after='))).toBe(false);
    expect(upstream.some((u) => u.url.includes('/chats/c2/'))).toBe(false);

    // since a checkpoint: `after` goes to the chat list and to each chat's messages
    upstream.length = 0;
    await ask({ after: '2026-10-01T00:00:00Z' });
    const after = encodeURIComponent('2026-10-01T00:00:00.000Z');
    expect(upstream[0]!.url).toContain(`after=${after}`);
    expect(upstream[0]!.url).toContain('account_type=LINKEDIN');
    expect(upstream.find((u) => u.url.includes('/messages'))!.url).toContain(`after=${after}`);
  });

  it('refuses a history cursor it did not sign for this account', async () => {
    const { handler, upstream } = harness({}, (url) =>
      url.includes('/api/v1/chats')
        ? new Response(
            JSON.stringify({ items: [{ id: 'c1', type: 0, attendee_provider_id: 'ACoP' }], cursor: 'more' }),
          )
        : new Response(JSON.stringify({ items: [], cursor: null })),
    );
    const forged = `${btoa(JSON.stringify({ q: [{ id: 'someone-elses-chat', m: 'x' }], c: null }))}.bad`;
    const r = (await (
      await handler(post('/chats/history', { accountId: 'a1', token: TOKEN.a1, cursor: forged }))
    ).json()) as {
      ok: boolean;
      reason: string;
    };
    expect(r).toMatchObject({ ok: false, reason: 'bad_cursor' });
    expect(upstream).toHaveLength(0);
    // a real cursor for a1 is no good for acc_1 either
    const real = (await (
      await handler(post('/chats/history', { accountId: 'a1', token: TOKEN.a1 }))
    ).json()) as {
      cursor: string;
    };
    expect(real.cursor).toBeTruthy();
    const other = (await (
      await handler(post('/chats/history', { accountId: 'acc_1', token: TOKEN.acc_1, cursor: real.cursor }))
    ).json()) as { reason: string };
    expect(other.reason).toBe('bad_cursor');
  });

  it('reads who commented on and reacted to the student’s posts, and whose posts they commented on', async () => {
    const NOW = new Date('2026-10-20T12:00:00.000Z');
    const { handler, upstream } = harness({ now: () => NOW }, (url) => {
      const u = new URL(url);
      expect(u.searchParams.get('account_id')).toBe('a1');
      const p = u.pathname;
      if (p === '/api/v1/users/me') return new Response(JSON.stringify({ provider_id: 'ACoME' }));
      if (p === '/api/v1/users/ACoME/posts')
        return new Response(
          JSON.stringify({
            items: [
              {
                id: '71',
                social_id: 'urn:li:activity:71',
                parsed_datetime: '2026-10-10T09:00:00.000Z',
                comment_counter: 2,
                reaction_counter: 3,
              },
              {
                id: '72',
                social_id: 'urn:li:activity:72',
                parsed_datetime: '2026-09-01T09:00:00.000Z',
                comment_counter: 1,
                reaction_counter: 1,
              },
              {
                id: '73',
                social_id: 'urn:li:activity:73',
                parsed_datetime: '2026-08-01T09:00:00.000Z',
                comment_counter: 0,
                reaction_counter: 0,
              },
            ],
            cursor: 'older',
          }),
        );
      if (
        p === '/api/v1/posts/urn%3Ali%3Aactivity%3A71/comments' ||
        p === '/api/v1/posts/urn:li:activity:71/comments'
      )
        return new Response(
          JSON.stringify({
            items: [
              { id: 'k1', date: '3d', text: 'Congrats!', author_details: { id: 'ACoP' } },
              {
                id: 'k2',
                date: '2026-10-12T08:00:00.000Z',
                text: 'Thanks all',
                author_details: { id: 'ACoME' },
              },
            ],
            cursor: null,
          }),
        );
      if (p.endsWith('activity%3A71/reactions') || p.endsWith('activity:71/reactions')) {
        const page2 = u.searchParams.get('cursor') === 'r2';
        return new Response(
          JSON.stringify({
            items: page2
              ? [{ value: 'LIKE', author: { id: 'ACoQ', type: 'INDIVIDUAL' } }]
              : [
                  { value: 'LIKE', author: { id: 'ACoP', type: 'INDIVIDUAL' } },
                  { value: 'LIKE', author: { id: '1234', type: 'COMPANY' } },
                ],
            paging: { cursor: page2 ? null : 'r2' },
          }),
        );
      }
      if (p === '/api/v1/users/ACoME/comments')
        return new Response(
          JSON.stringify({
            items: [
              { id: 'o1', post_id: 'urn:li:activity:99', date: '1w', text: 'Great point' },
              { id: 'o2', post_id: 'urn:li:activity:71', date: '2d', text: 'reply on my own post' },
            ],
            cursor: null,
          }),
        );
      if (p === '/api/v1/posts/99')
        return new Response(
          JSON.stringify({
            author: { id: 'ACoR', is_company: false },
            parsed_datetime: '2026-10-01T00:00:00.000Z',
          }),
        );
      return new Response('{}', { status: 404 });
    });
    type Items = {
      items: { kind: string; memberId: string; at: string; id: string }[];
      postsRead: { socialId: string; seen: string }[];
      ownDone: boolean;
      olderPosts: boolean;
      cursor: string | null;
    };
    const ask = async (extra: Record<string, unknown>) =>
      (await (
        await handler(post('/posts/activity', { accountId: 'a1', token: TOKEN.a1, ...extra }))
      ).json()) as Items;
    const all: Items['items'] = [];
    const read: Items['postsRead'] = [];
    let ownDone = false;
    // the post the student already read at these counts is skipped
    let r = await ask({ seen: { 'urn:li:activity:72': '1:1' } });
    expect(r.olderPosts).toBe(true);
    for (;;) {
      all.push(...r.items);
      read.push(...r.postsRead);
      ownDone ||= r.ownDone;
      if (!r.cursor) break;
      r = await ask({ cursor: r.cursor });
    }
    expect(all.map((i) => [i.kind, i.memberId, i.at]).sort()).toEqual([
      ['comment_in', 'ACoP', '2026-10-17T12:00:00.000Z'],
      ['comment_out', 'ACoR', '2026-10-13T12:00:00.000Z'],
      ['reaction_in', 'ACoP', '2026-10-10T09:00:00.000Z'],
      ['reaction_in', 'ACoQ', '2026-10-10T09:00:00.000Z'],
    ]);
    expect(read.sort((a, b) => a.socialId.localeCompare(b.socialId))).toEqual([
      { socialId: 'urn:li:activity:71', seen: '2:3' },
      { socialId: 'urn:li:activity:73', seen: '0:0' },
    ]);
    expect(ownDone).toBe(true);
    expect(upstream.some((u) => u.url.includes('activity%3A72') || u.url.includes('activity:72'))).toBe(
      false,
    );
  });

  it('stops an account at its daily post reads', async () => {
    // a posts ledger of 1: /posts/activity may use round(85%) of it, one unit per call
    const { handler } = harness({ ledger: { posts: 1 } }, (url) =>
      url.includes('/users/me')
        ? new Response(JSON.stringify({ provider_id: 'ACoME' }))
        : new Response(JSON.stringify({ items: [], cursor: null })),
    );
    expect(
      (await (await handler(post('/posts/activity', { accountId: 'a1', token: TOKEN.a1 }))).json()) as object,
    ).toMatchObject({
      ok: true,
    });
    expect(
      (await (await handler(post('/posts/activity', { accountId: 'a1', token: TOKEN.a1 }))).json()) as object,
    ).toMatchObject({
      ok: false,
      reason: 'limit',
    });
  });

  describe('third-party engagement (/engagement)', () => {
    const AT = new Date('2026-10-20T12:00:00Z');
    const LIMIT_MSG = 'Orbit has read as much from LinkedIn as it allows today. It carries on tomorrow.';
    /** A harness whose waits return at once but are recorded, in order with the upstream calls. */
    const paced = (answer: Upstream, over: Partial<ConnectorDeps> = {}, random = 0) => {
      const events: string[] = [];
      const waits: number[] = [];
      const h = harness(
        {
          now: () => AT,
          take: memoryTake(() => AT.getTime()),
          sleep: async (ms) => {
            waits.push(ms);
            events.push('sleep');
          },
          random: () => random,
          ...over,
        },
        (url, init) => {
          events.push('fetch');
          return answer(url, init);
        },
      );
      const read = (body: Record<string, unknown>) =>
        h.handler(post('/engagement', { accountId: 'a1', token: TOKEN.a1, ...body }));
      return { ...h, read, waits, events };
    };
    const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

    it("maps a person's posts in one upstream call: activity ids, counters, reposts, and whom they mention", async () => {
      const { read, upstream, waits, events } = paced(
        ok({
          items: [
            {
              id: '7250000000000000001',
              social_id: 'urn:li:activity:7250000000000000001',
              parsed_datetime: '2026-10-01T09:00:00.000Z',
              text: 'Thrilled to share a SECRET_POST_TEXT announcement',
              reaction_counter: 42,
              comment_counter: '3',
              is_repost: false,
              author: { id: 'ACoB' },
              mentions: [
                { name: 'Ana Ruiz', profile_urn: 'urn:li:fsd_profile:ACoAna' },
                { name: 'Sam Ortiz', provider_id: 'ACoSam' },
                { name: 'Only A Link', url: 'https://www.linkedin.com/in/only-a-link' },
                { name: 'Stripe', type: 'COMPANY', id: 'urn:li:fsd_company:1' },
              ],
            },
            {
              id: '7250000000000000002',
              social_id: 'urn:li:activity:7250000000000000002',
              date: '2w',
              reaction_counter: 0,
              is_repost: true,
              repost_content: { author: { id: 'ACoOrig' } },
            },
            { text: 'no id at all' },
          ],
          cursor: 'next-posts',
        }),
      );
      const res = await read({ memberId: 'ACoB', want: 'posts', cursor: 'prev' });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain('SECRET_POST_TEXT');
      expect(JSON.parse(raw)).toEqual({
        ok: true,
        want: 'posts',
        items: [
          {
            id: '7250000000000000001',
            socialId: 'urn:li:activity:7250000000000000001',
            at: '2026-10-01T09:00:00.000Z',
            reactions: 42,
            comments: 3,
            mentions: ['ACoAna', 'ACoSam'],
            tagged: 3,
          },
          {
            id: '7250000000000000002',
            socialId: 'urn:li:activity:7250000000000000002',
            at: '2026-10-06T12:00:00.000Z',
            reactions: 0,
            comments: 0,
            repostOf: 'ACoOrig',
            mentions: [],
            tagged: 0,
          },
        ],
        cursor: 'next-posts',
      });
      expect(upstream).toHaveLength(1);
      const url = new URL(upstream[0]!.url);
      expect(url.pathname).toBe('/api/v1/users/ACoB/posts');
      expect(Object.fromEntries(url.searchParams)).toEqual({ account_id: 'a1', limit: '20', cursor: 'prev' });
      // one random wait, before the call
      expect(events).toEqual(['sleep', 'fetch']);
      expect(waits).toEqual([400]);
    });

    it('spaces each call by 400 to 1,500 ms at random', async () => {
      const top = paced(ok({ items: [] }), {}, 0.99999999);
      await top.read({ memberId: 'ACoB', want: 'reactions' });
      expect(top.waits).toEqual([1500]);
      const mid = paced(ok({ items: [] }), {}, 0.5);
      await mid.read({ memberId: 'ACoB', want: 'comments' });
      expect(mid.waits[0]).toBeGreaterThanOrEqual(400);
      expect(mid.waits[0]).toBeLessThanOrEqual(1500);
    });

    it('maps reactions to the post and its author, leaving out companies', async () => {
      const { read, upstream } = paced(
        ok({
          items: [
            {
              value: 'LIKE',
              post_id: 'urn:li:activity:7250000000000000001',
              author: { id: 'ACoB', type: 'PERSON' },
            },
            {
              value: 'PRAISE',
              post_id: '7250000000000000009',
              comment_id: '7250000000000000777',
              author: { id: 'ACoC', name: 'Cy' },
            },
            { value: 'LIKE', post_id: '7250000000000000010', author: { id: 'C1', type: 'COMPANY' } },
            { value: 'LIKE', author: { id: 'ACoD' } },
          ],
          cursor: 'r2',
        }),
      );
      expect(await (await read({ memberId: 'ACoA', want: 'reactions' })).json()).toEqual({
        ok: true,
        want: 'reactions',
        items: [
          { postId: '7250000000000000001', authorId: 'ACoB', onComment: false },
          { postId: '7250000000000000009', authorId: 'ACoC', onComment: true },
        ],
        cursor: 'r2',
      });
      const url = new URL(upstream[0]!.url);
      expect(url.pathname).toBe('/api/v1/users/ACoA/reactions');
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.has('cursor')).toBe(false);
    });

    it("maps a person's comments to post ids and dates, never their text", async () => {
      const { read, upstream } = paced(
        ok({
          items: [
            {
              id: 'c1',
              post_id: '7250000000000000001',
              post_urn: 'urn:li:activity:7250000000000000001',
              date: '2026-10-10T08:00:00.000Z',
              text: 'SECRET_COMMENT_TEXT congrats!',
              author_details: { id: 'ACoA' },
            },
            { id: 'c2', post_id: '7250000000000000003', thread_id: 'c0', date: '3d', text: 'reply' },
            { id: 'c3', text: 'no post' },
          ],
          cursor: null,
        }),
      );
      const raw = await (await read({ memberId: 'ACoA', want: 'comments' })).text();
      expect(raw).not.toContain('SECRET_COMMENT_TEXT');
      expect(raw).not.toContain('reply');
      expect(JSON.parse(raw)).toEqual({
        ok: true,
        want: 'comments',
        items: [
          { id: 'c1', postId: '7250000000000000001', at: '2026-10-10T08:00:00.000Z' },
          { id: 'c2', postId: '7250000000000000003', at: '2026-10-17T12:00:00.000Z', threadId: 'c0' },
        ],
        cursor: null,
      });
      expect(new URL(upstream[0]!.url).pathname).toBe('/api/v1/users/ACoA/comments');
    });

    it("reads one post's comment thread by its activity URN: who commented and when, never what", async () => {
      const { read, upstream } = paced(
        ok({
          items: [
            {
              id: 'k1',
              author_details: { id: 'ACoA' },
              date: '1w',
              text: 'SECRET_THREAD_TEXT',
              reply_counter: 1,
            },
            { id: 'k2', author: { id: 'ACoB', name: 'Bea' }, date: '2026-10-19T10:00:00Z' },
            { id: 'k3', author: { id: 'C9', type: 'COMPANY' } },
            { id: 'k4', text: 'nobody' },
          ],
          paging: { cursor: 't2' },
        }),
      );
      const raw = await (
        await read({ memberId: 'ACoB', want: 'thread', postId: '7250000000000000001' })
      ).text();
      expect(raw).not.toContain('SECRET_THREAD_TEXT');
      expect(JSON.parse(raw)).toEqual({
        ok: true,
        want: 'thread',
        items: [
          { id: 'k1', commenterId: 'ACoA', at: '2026-10-13T12:00:00.000Z' },
          { id: 'k2', commenterId: 'ACoB', at: '2026-10-19T10:00:00.000Z' },
        ],
        cursor: 't2',
      });
      const url = new URL(upstream[0]!.url);
      expect(decodeURIComponent(url.pathname)).toBe(
        '/api/v1/posts/urn:li:activity:7250000000000000001/comments',
      );
      expect(url.searchParams.get('limit')).toBe('50');
    });

    it("says LinkedIn wouldn't show the activity on a 404 or 422, and a 502 with Unipile's words otherwise", async () => {
      for (const status of [404, 422]) {
        const { read } = paced(() => new Response(JSON.stringify({ title: 'nope' }), { status }));
        const res = await read({ memberId: 'ACoB', want: 'posts' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          ok: false,
          reason: 'unavailable',
          message: "LinkedIn wouldn't show this person's activity.",
        });
      }
      const long = 'x'.repeat(500);
      const { read } = paced(() => new Response(JSON.stringify({ detail: long }), { status: 500 }));
      const res = await read({ memberId: 'ACoB', want: 'posts' });
      expect(res.status).toBe(502);
      const { error } = (await res.json()) as { error: string };
      expect(error).toBe(`unipile 500: ${`{"detail":"${long}`.slice(0, 200)}`);
      expect(error).not.toContain('u-key');
    });

    it('needs the token and a well-formed ask, and spends nothing on a bad one', async () => {
      const { handler, read, upstream } = paced(ok({ items: [] }), { ledger: { posts: 1 } });
      expect(
        (await handler(post('/engagement', { accountId: 'a1', memberId: 'ACoB', want: 'posts' }))).status,
      ).toBe(403);
      for (const bad of [
        { memberId: 'ACoB', want: 'everything' },
        { want: 'posts' },
        { memberId: 'ACoB', want: 'thread' },
      ])
        expect(await (await read(bad)).json()).toMatchObject({ ok: false, reason: 'bad_request' });
      expect(upstream).toHaveLength(0);
      // the one unit of the day is still there
      expect(await (await read({ memberId: 'ACoB', want: 'posts' })).json()).toMatchObject({ ok: true });
      expect(await (await read({ memberId: 'ACoB', want: 'posts' })).json()).toEqual({
        ok: false,
        reason: 'limit',
        message: LIMIT_MSG,
      });
      expect(upstream).toHaveLength(1);
    });

    it('shares the posts ledger with /posts/activity, which stops first (85%)', async () => {
      const { handler, read, upstream } = paced(
        (url) =>
          url.includes('/users/me')
            ? new Response(JSON.stringify({ provider_id: 'ACoME' }))
            : new Response(JSON.stringify({ items: [], cursor: null })),
        { ledger: { posts: 4 } },
      );
      const activity = () => handler(post('/posts/activity', { accountId: 'a1', token: TOKEN.a1 }));
      // round(85% of 4) = 3 calls of /posts/activity
      for (let i = 0; i < 3; i++) expect(await (await activity()).json()).toMatchObject({ ok: true });
      const before = upstream.length;
      expect(await (await activity()).json()).toEqual({ ok: false, reason: 'limit', message: LIMIT_MSG });
      expect(upstream).toHaveLength(before);
      // engagement for a target the student opened still has the last unit
      expect(await (await read({ memberId: 'ACoB', want: 'posts' })).json()).toMatchObject({ ok: true });
      expect(await (await read({ memberId: 'ACoB', want: 'posts' })).json()).toMatchObject({
        reason: 'limit',
      });
    });
  });

  describe('LinkedIn ledgers', () => {
    const AT = new Date('2026-10-20T12:00:00Z');
    const ledger = (handler: (r: Request) => Promise<Response>) =>
      handler(post('/ledger', { accountId: 'a1', token: TOKEN.a1 })).then((r) => r.json());
    /** Mutual connections over two pages of one person each. */
    const twoPages: Upstream = (url, init) => {
      if (url.includes('/api/v1/users/ACoT?'))
        return new Response(JSON.stringify({ provider_id: 'ACoT', shared_connections_count: 2 }));
      const params = JSON.parse((init.body as string) || '{}');
      const second = url.includes('cursor=p2');
      return new Response(
        JSON.stringify({
          items: [{ name: second ? 'Ben Ortiz' : 'Mia Chen', member_id: second ? 'm_ben' : 'm_mia' }],
          config: { params },
          paging: { total_count: 2 },
          cursor: second ? null : 'p2',
        }),
      );
    };
    const mutuals = (handler: (r: Request) => Promise<Response>) =>
      handler(post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' })).then((r) =>
        r.json(),
      );

    it("reports each ledger's use today without counting, and needs the token", async () => {
      const { handler, upstream } = harness(
        { now: () => AT, take: memoryTake(() => AT.getTime()), ledger: { search: 50 } },
        twoPages,
      );
      const empty = {
        ok: true,
        day: '2026-10-20',
        profile: { used: 0, limit: 100 },
        posts: { used: 0, limit: 100 },
        search: { used: 0, limit: 50 },
      };
      expect(await ledger(handler)).toEqual(empty);
      expect(await ledger(handler)).toEqual(empty);
      expect((await handler(post('/ledger', { accountId: 'a1' }))).status).toBe(403);
      expect(upstream).toHaveLength(0);
      // /mutuals: one profile read for the shared count, one search unit per page
      const r = (await mutuals(handler)) as { verified: boolean; mutuals: { name: string }[] };
      expect(r.verified).toBe(true);
      expect(r.mutuals.map((m) => m.name)).toEqual(['Mia Chen', 'Ben Ortiz']);
      expect(upstream).toHaveLength(3);
      expect(await ledger(handler)).toEqual({
        ...empty,
        profile: { used: 1, limit: 100 },
        search: { used: 2, limit: 50 },
      });
    });

    it('answers 503 for the report when the counter store cannot be read without counting', async () => {
      const { handler } = harness({ take: async () => ({ allowed: true }) });
      expect((await handler(post('/ledger', { accountId: 'a1', token: TOKEN.a1 }))).status).toBe(503);
    });

    it('keeps what /mutuals read when the search ledger runs out between pages, and refuses before the first', async () => {
      const one = harness(
        { now: () => AT, take: memoryTake(() => AT.getTime()), ledger: { search: 1 } },
        twoPages,
      );
      expect(await mutuals(one.handler)).toMatchObject({
        verified: true,
        count: 2,
        limited: true,
        mutuals: [{ name: 'Mia Chen' }],
      });
      expect(one.upstream).toHaveLength(2);
      expect(await mutuals(one.handler)).toEqual({
        ok: false,
        reason: 'limit',
        message: 'Orbit has read as much from LinkedIn as it allows today. It carries on tomorrow.',
      });
    });

    it('stops Discover at 80% of the search ledger while mutual connections can still page', async () => {
      const { handler } = harness(
        { now: () => AT, take: memoryTake(() => AT.getTime()), ledger: { search: 5 } },
        (url, init) =>
          url.includes('/api/v1/users/ACoT?') || !url.includes('/linkedin/search/parameters')
            ? twoPages(url, init)
            : new Response('{}', { status: 404 }),
      );
      const search = () => handler(post('/search', { accountId: 'a1', token: TOKEN.a1, keywords: 'pm' }));
      for (let i = 0; i < 4; i++) expect(await (await search()).json()).toMatchObject({ ok: true });
      expect(await (await search()).json()).toMatchObject({ ok: false, reason: 'limit' });
      expect(await mutuals(handler)).toMatchObject({
        verified: true,
        limited: true,
        mutuals: [{ name: 'Mia Chen' }],
      });
      expect(await ledger(handler)).toMatchObject({ search: { used: 5, limit: 5 } });
    });

    it('refuses /mutuals before reading anything once route profile reads are spent, but not photos at 80%', async () => {
      const { handler, upstream } = harness(
        { now: () => AT, take: memoryTake(() => AT.getTime()), ledger: { profile: 5 } },
        (url, init) =>
          url.includes('/api/v1/users/x?')
            ? new Response(JSON.stringify({ provider_id: 'x' }))
            : twoPages(url, init),
      );
      const photo = () => handler(post('/photo', { accountId: 'a1', token: TOKEN.a1, identifier: 'x' }));
      for (let i = 0; i < 4; i++) expect(await (await photo()).json()).toMatchObject({ ok: true });
      // photos stop at round(80% of 5) = 4, the route read still gets the fifth
      expect(await (await photo()).json()).toMatchObject({ ok: false, reason: 'limit' });
      expect(await mutuals(handler)).toMatchObject({ verified: true });
      const before = upstream.length;
      expect(await mutuals(handler)).toMatchObject({ ok: false, reason: 'limit' });
      expect(upstream).toHaveLength(before);
    });

    it('fails closed with a 503 when the counter store is down mid-way through /mutuals', async () => {
      let calls = 0;
      const { handler } = harness(
        {
          take: async () => {
            calls++;
            // the visitor buckets pass; the ledger cannot be counted
            if (calls > 1) throw new Error('db down');
            return { allowed: true };
          },
        },
        twoPages,
      );
      const res = await handler(
        post('/mutuals', { accountId: 'a1', token: TOKEN.a1, targetMemberId: 'ACoT' }),
      );
      expect(res.status).toBe(503);
    });

    it('peeks at the counters table without counting, ignoring expired counts', async () => {
      const calls: string[] = [];
      const take = postgrestTake(
        'https://db.test',
        'svc',
        (async (url: string) => {
          calls.push(url);
          return new Response(
            JSON.stringify([
              {
                bucket: 'connectors:li:profile:2026-10-20:a1',
                count: 31,
                expires_at: '2026-10-21T00:00:00Z',
              },
              { bucket: 'connectors:li:posts:2026-10-20:a1', count: 9, expires_at: '2026-10-19T00:00:00Z' },
            ]),
          );
        }) as unknown as typeof fetch,
        () => AT.getTime(),
      );
      expect(
        await take.peek!([
          'connectors:li:profile:2026-10-20:a1',
          'connectors:li:posts:2026-10-20:a1',
          'connectors:li:search:2026-10-20:a1',
        ]),
      ).toEqual([31, 0, 0]);
      const url = new URL(calls[0]!);
      expect(url.pathname).toBe('/rest/v1/orbit_proxy_counters');
      expect(url.searchParams.get('bucket')).toBe(
        'in.("connectors:li:profile:2026-10-20:a1","connectors:li:posts:2026-10-20:a1","connectors:li:search:2026-10-20:a1")',
      );
    });
  });

  it('reads LinkedIn’s relative dates on comments', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    expect(postDate('3d', now)).toBe('2026-10-17T12:00:00.000Z');
    expect(postDate('2w', now)).toBe('2026-10-06T12:00:00.000Z');
    expect(postDate('5mo', now)).toBe('2026-05-20T12:00:00.000Z');
    expect(postDate('1yr', now)).toBe('2025-10-20T12:00:00.000Z');
    expect(postDate('4h', now)).toBe('2026-10-20T08:00:00.000Z');
    expect(postDate('2026-10-01T10:00:00Z', now)).toBe('2026-10-01T10:00:00.000Z');
    expect(postDate('yesterday-ish', now)).toBeUndefined();
  });

  it('refuses the inbox and search without the account token', async () => {
    const { handler, upstream } = harness();
    expect((await handler(post('/inbox', { accountId: 'a1' }))).status).toBe(403);
    expect((await handler(post('/search', { accountId: 'a1', keywords: 'x' }))).status).toBe(403);
    expect(upstream).toHaveLength(0);
  });

  it('searches LinkedIn past the student’s network, turning a company and school into LinkedIn ids', async () => {
    const { handler, upstream } = harness({}, (url, init) => {
      if (url.includes('/search/parameters') && url.includes('type=COMPANY'))
        return new Response(JSON.stringify({ items: [{ id: '1382', title: 'Goldman Sachs' }] }));
      if (url.includes('/search/parameters')) return new Response(JSON.stringify({ items: [] }));
      if (url.includes('/linkedin/search?') && init.method === 'POST')
        return new Response(
          JSON.stringify({
            items: [
              {
                type: 'PEOPLE',
                id: 'ACoX',
                name: 'Lena Park',
                headline: 'Analyst at Goldman Sachs',
                location: 'New York',
                profile_url: 'https://www.linkedin.com/in/lena-park',
                network_distance: 'DISTANCE_2',
              },
              { type: 'PEOPLE', id: 'ACoY', name: '', headline: 'LinkedIn Member' },
            ],
            cursor: 'next1',
            paging: { start: 0, page_count: 10, total_count: 240 },
          }),
        );
      return new Response('{}', { status: 404 });
    });
    const r = (await (
      await handler(
        post('/search', {
          accountId: 'a1',
          token: TOKEN.a1,
          title: 'analyst',
          company: 'Goldman Sachs',
          school: 'Nowhere U',
        }),
      )
    ).json()) as { ok: boolean; people: unknown[]; cursor: string; total: number };
    const search = upstream.find((u) => u.method === 'POST')!;
    expect(search.url).toContain('limit=10');
    expect(search.body).toEqual({
      api: 'classic',
      category: 'people',
      network_distance: [2, 3],
      company: ['1382'],
      // a school LinkedIn does not know is searched by name
      advanced_keywords: { title: 'analyst', school: 'Nowhere U' },
    });
    expect(r).toEqual({
      ok: true,
      people: [
        {
          memberId: 'ACoX',
          name: 'Lena Park',
          headline: 'Analyst at Goldman Sachs',
          location: 'New York',
          profileUrl: 'https://www.linkedin.com/in/lena-park',
          distance: 2,
        },
      ],
      cursor: 'next1',
      total: 240,
    });
  });

  it('asks for something to search for, and stops an account at its daily searches', async () => {
    const at = new Date('2026-10-16T09:00:00Z');
    const { handler, upstream } = harness(
      { ledger: { search: 1 }, now: () => at, take: memoryTake(() => at.getTime()) },
      () => new Response(JSON.stringify({ items: [], cursor: null })),
    );
    const search = (body: Record<string, unknown>) =>
      handler(post('/search', { accountId: 'a1', token: TOKEN.a1, ...body }));
    expect(await (await search({ keywords: 'product manager' })).json()).toMatchObject({ ok: true });
    expect(await (await search({ keywords: 'again' })).json()).toMatchObject({ ok: false, reason: 'limit' });
    expect(upstream).toHaveLength(1);
    const empty = harness();
    expect(
      await (await empty.handler(post('/search', { accountId: 'a1', token: TOKEN.a1 }))).json(),
    ).toMatchObject({ ok: false, reason: 'bad_request' });
  });

  it('unlinks an account with a DELETE, and an account already gone counts as unlinked', async () => {
    const { handler, upstream } = harness();
    const r = await handler(post('/disconnect', { accountId: 'acc_1', token: TOKEN.acc_1 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(upstream[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api1.unipile.com:443/api/v1/accounts/acc_1',
    });
    const gone = harness({}, () => new Response('{}', { status: 404 }));
    expect((await gone.handler(post('/disconnect', { accountId: 'acc_1', token: TOKEN.acc_1 }))).status).toBe(
      200,
    );
    const fails = harness({}, () => new Response('{}', { status: 500 }));
    expect(
      (await fails.handler(post('/disconnect', { accountId: 'acc_1', token: TOKEN.acc_1 }))).status,
    ).toBe(502);
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
    expect((await noVillage.handler(post('/relations', { accountId: 'a1', token: TOKEN.a1 }))).status).toBe(
      200,
    );
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
