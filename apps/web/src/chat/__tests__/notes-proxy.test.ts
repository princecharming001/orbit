import { describe, expect, it, vi } from 'vitest';
import {
  bookingUrl,
  CALCOM_EVENT_TYPES_VERSION,
  defaultOrigins,
  MCP_SERVERS,
  makeHandler,
  mapFathomMeeting,
  memoryTake,
  readRpc,
} from '../../../../../supabase/functions/orbit-notes/notes';

const ORIGIN = 'https://tryorbit.today';
const KEY = 'fathom_test_key_123456';

function handler(fetchImpl: typeof fetch, limits = { perMinute: 30, perDay: 400 }) {
  return makeHandler({ origins: defaultOrigins, take: memoryTake(), fetch: fetchImpl, limits });
}

const post = (path: string, body: unknown, origin = ORIGIN) =>
  new Request(`https://x.supabase.co/functions/v1/orbit-notes${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify(body),
  });

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fathomItem = {
  recording_id: 4242,
  title: 'Coffee chat',
  meeting_title: 'Alex <> Priya',
  url: 'https://fathom.video/calls/1',
  share_url: 'https://fathom.video/share/abc',
  created_at: '2026-10-10T16:30:00Z',
  scheduled_start_time: '2026-10-10T16:00:00Z',
  recording_start_time: '2026-10-10T16:01:00Z',
  calendar_invitees: [
    { name: 'Alex Rivera', email: 'alex@cornell.edu', is_external: false },
    { name: 'Priya Ahmed', email: 'priya@stripe.com', is_external: true },
  ],
  recorded_by: { name: 'Alex', email: 'alex@cornell.edu' },
  default_summary: { template_name: 'General', markdown_formatted: '## Notes\n- Priya leads onboarding' },
  action_items: [
    { description: 'Send Priya the project link', completed: false, assignee: { name: 'Alex Rivera' } },
    { description: '', completed: false },
  ],
};

describe('orbit-notes proxy', () => {
  it('answers preflight from Orbit and refuses other sites', async () => {
    const h = handler(vi.fn() as unknown as typeof fetch);
    const pre = (origin: string) =>
      h(
        new Request('https://x/functions/v1/orbit-notes/fathom/meetings', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
      );
    expect((await pre(ORIGIN)).status).toBe(204);
    expect((await pre('https://evil.example.com')).status).toBe(403);
    expect((await h(post('/fathom/meetings', { apiKey: KEY }, 'https://evil.example.com'))).status).toBe(403);
  });

  it('forwards the Fathom key with summaries and action items, and trims each meeting', async () => {
    const f = vi.fn(async () => ok({ items: [fathomItem], next_cursor: 'c2', limit: 10 }));
    const res = await handler(f as unknown as typeof fetch)(
      post('/fathom/meetings', { apiKey: KEY, createdAfter: '2026-09-01T00:00:00Z' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; meetings: unknown[]; nextCursor: string };
    expect(body).toMatchObject({ ok: true, nextCursor: 'c2' });
    expect(body.meetings).toEqual([
      {
        id: '4242',
        title: 'Alex <> Priya',
        url: 'https://fathom.video/share/abc',
        startAt: '2026-10-10T16:01:00Z',
        invitees: [
          { name: 'Alex Rivera', email: 'alex@cornell.edu', external: false },
          { name: 'Priya Ahmed', email: 'priya@stripe.com', external: true },
        ],
        recordedBy: 'alex@cornell.edu',
        summary: '## Notes\n- Priya leads onboarding',
        actionItems: [{ text: 'Send Priya the project link', done: false, assignee: 'Alex Rivera' }],
      },
    ]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://api.fathom.ai/external/v1/meetings?');
    expect(url).toContain('include_summary=true');
    expect(url).toContain('include_action_items=true');
    expect(url).toContain('created_after=2026-09-01T00%3A00%3A00.000Z');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(KEY);
  });

  it('says plainly when Fathom refuses the key, and never echoes it', async () => {
    const f = vi.fn(async () => new Response('{"error":"nope"}', { status: 401 }));
    const res = await handler(f as unknown as typeof fetch)(post('/fathom/meetings', { apiKey: KEY }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, reason: 'bad_key' });
    expect(text).not.toContain(KEY);
  });

  it('needs a key, and only on known routes', async () => {
    const h = handler(vi.fn() as unknown as typeof fetch);
    expect((await h(post('/fathom/meetings', {}))).status).toBe(400);
    expect((await h(post('/fathom/meetings', { apiKey: 'has spaces in it' }))).status).toBe(400);
    expect((await h(post('/elsewhere', { apiKey: KEY }))).status).toBe(404);
  });

  it('counts calls per visitor', async () => {
    const f = vi.fn(async () => ok({ items: [] }));
    const h = handler(f as unknown as typeof fetch, { perMinute: 1, perDay: 10 });
    expect((await h(post('/fathom/meetings', { apiKey: KEY }))).status).toBe(200);
    const limited = await h(post('/fathom/meetings', { apiKey: KEY }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-orbit-limit')).toBe('minute');
  });

  it('lists Cal.com event types with their booking links', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/v2/me')
        ? ok({ status: 'success', data: { username: 'alex-rivera', email: 'alex@cornell.edu' } })
        : ok({
            status: 'success',
            data: [
              {
                id: 1,
                title: '30 min coffee chat',
                slug: '30min',
                lengthInMinutes: 30,
                hidden: false,
                bookingUrl: 'https://cal.com/alex-rivera/30min',
              },
              { id: 2, title: 'Quick call', slug: '15min', lengthInMinutes: 15, hidden: true },
            ],
          }),
    );
    const res = await handler(f as unknown as typeof fetch)(
      post('/calcom/event-types', { apiKey: 'cal_live_abc123456' }),
    );
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      username: 'alex-rivera',
      eventTypes: [
        {
          id: 1,
          title: '30 min coffee chat',
          slug: '30min',
          minutes: 30,
          hidden: false,
          url: 'https://cal.com/alex-rivera/30min',
        },
        {
          id: 2,
          title: 'Quick call',
          slug: '15min',
          minutes: 15,
          hidden: true,
          url: 'https://cal.com/alex-rivera/15min',
        },
      ],
    });
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer cal_live_abc123456');
    expect((calls[1]![1].headers as Record<string, string>)['cal-api-version']).toBe(
      CALCOM_EVENT_TYPES_VERSION,
    );
  });

  it('maps edge cases: a meeting with no id is skipped; a booking link falls back to cal.com/user/slug', () => {
    expect(mapFathomMeeting({ title: 'x' })).toBeUndefined();
    expect(bookingUrl('sam', { slug: 'chat' })).toBe('https://cal.com/sam/chat');
    expect(bookingUrl('sam', { slug: 'chat', bookingUrl: 'https://book.sam.dev/chat' })).toBe(
      'https://book.sam.dev/chat',
    );
    expect(bookingUrl(undefined, { slug: 'chat' })).toBeUndefined();
  });
});

describe('signing in to Cal.com and Fathom', () => {
  const oauth = {
    calcom: { clientId: 'cal_client', clientSecret: 'cal_secret_value' },
    fathom: { clientId: 'fathom_client', clientSecret: 'fathom_secret_value' },
  };
  const withOAuth = (f: typeof fetch) =>
    makeHandler({ origins: defaultOrigins, take: memoryTake(), fetch: f, oauth });

  it('says which sign-ins are set up, with the public ids only', async () => {
    const r = await withOAuth(vi.fn() as unknown as typeof fetch)(post('/oauth/config', {}));
    const j = await r.json();
    expect(j).toEqual({ ok: true, calcom: 'cal_client', fathom: 'fathom_client' });
    expect(JSON.stringify(j)).not.toContain('secret');
    const off = await handler(vi.fn() as unknown as typeof fetch)(post('/oauth/config', {}));
    expect(await off.json()).toEqual({ ok: true, calcom: null, fathom: null });
  });

  it('trades a code for tokens with the secret it holds, only for a redirect back to Orbit', async () => {
    const f = vi.fn(async () =>
      ok({ access_token: 'acc_123456789012', refresh_token: 'ref_123456789012', expires_in: 1800 }),
    ) as unknown as typeof fetch;
    const h = withOAuth(f);
    const r = await h(
      post('/oauth/token', {
        provider: 'calcom',
        code: 'code_1',
        redirectUri: 'https://tryorbit.today/auth/app',
      }),
    );
    expect(await r.json()).toMatchObject({ ok: true, accessToken: 'acc_123456789012', expiresIn: 1800 });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.cal.com/v2/auth/oauth2/token');
    expect(String(init.body)).toContain('client_secret=cal_secret_value');
    expect(String(init.body)).toContain('grant_type=authorization_code');
    // a code meant for somebody else's site is never exchanged
    const away = await h(
      post('/oauth/token', { provider: 'calcom', code: 'c', redirectUri: 'https://evil.example.com/cb' }),
    );
    expect(await away.json()).toMatchObject({ ok: false, reason: 'refused' });
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('a signed-in Fathom reads each summary from the recording, and sends the token as a bearer', async () => {
    const calls: string[] = [];
    const f = vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${u} ${(init?.headers as Record<string, string>)?.Authorization ?? ''}`);
      if (u.includes('/recordings/4242/summary'))
        return ok({ summary: { template_name: 'General', markdown_formatted: '## From the recording' } });
      return ok({ items: [{ ...fathomItem, default_summary: null }], next_cursor: null });
    }) as unknown as typeof fetch;
    const r = await handler(f)(post('/fathom/meetings', { accessToken: 'acc_fathom_token_1' }));
    const j = await r.json();
    expect(j.meetings[0].summary).toBe('## From the recording');
    expect(calls[0]).not.toContain('include_summary');
    expect(calls.every((c) => c.endsWith('Bearer acc_fathom_token_1'))).toBe(true);
  });
});

describe('orbit-notes: meeting apps over MCP (Granola, Wispr Flow)', () => {
  const sse = (msg: unknown) =>
    new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess_1' },
    });

  it('reads a JSON-RPC answer from JSON or from an event stream', () => {
    expect(readRpc('{"jsonrpc":"2.0","id":3,"result":{"a":1}}', 'application/json', 3)).toMatchObject({
      result: { a: 1 },
    });
    const stream =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
    expect(readRpc(stream, 'text/event-stream', 2)).toMatchObject({ result: { b: 2 } });
    expect(readRpc('nope', 'application/json', 1)).toBeUndefined();
  });

  it('opens one session, sends the token only to that app, and returns each tool call', async () => {
    const seen: { url: string; method: string; auth?: string; session?: string }[] = [];
    const f = vi.fn(async (u: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      const msg = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { name?: string };
      };
      seen.push({ url: u, method: msg.method, auth: h.authorization, session: h['mcp-session-id'] });
      if (msg.method === 'initialize')
        return sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (msg.method === 'tools/list')
        return sse({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'list_meetings' }, { name: 'get_meetings' }] },
        });
      return ok({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `<meetings_data count="0"></meetings_data>` }] },
      });
    }) as unknown as typeof fetch;
    const r = await handler(f)(
      post('/mcp/call', {
        server: 'granola',
        accessToken: 'gra_token_123456',
        list: true,
        calls: [{ name: 'list_meetings', arguments: { time_range: 'last_30_days' } }],
      }),
    );
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, tools: ['list_meetings', 'get_meetings'] });
    expect(j.results[0]).toMatchObject({ ok: true, text: '<meetings_data count="0"></meetings_data>' });
    expect(seen.map((s) => s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    expect(seen.every((s) => s.url === MCP_SERVERS.granola && s.auth === 'Bearer gra_token_123456')).toBe(
      true,
    );
    // every call after the first carries the session the server opened
    expect(seen.slice(1).every((s) => s.session === 'sess_1')).toBe(true);
  });

  it('refuses tools that change anything, unknown servers, and a call without a sign-in', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const h = handler(f);
    const body = { server: 'wispr', accessToken: 'wis_token_123456' };
    for (const req of [
      post('/mcp/call', { ...body, calls: [{ name: 'add_task' }] }),
      post('/mcp/call', { ...body, calls: [{ name: 'update_task' }] }),
      post('/mcp/call', {
        server: 'granola',
        accessToken: 'gra_token_123456',
        calls: [{ name: 'sign_out' }],
      }),
      post('/mcp/call', { server: 'evil', accessToken: 'tok_123456789', calls: [] }),
    ])
      expect(await (await h(req)).json()).toMatchObject({ ok: false, reason: 'refused' });
    expect((await h(post('/mcp/call', { server: 'wispr', calls: [] }))).status).toBe(400);
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('a token the app no longer accepts asks the student to connect again', async () => {
    const f = vi.fn(
      async () => new Response('{"error":"invalid_token"}', { status: 401 }),
    ) as unknown as typeof fetch;
    const r = await handler(f)(
      post('/mcp/call', {
        server: 'wispr',
        accessToken: 'wis_token_123456',
        calls: [{ name: 'search_meetings' }],
      }),
    );
    expect(await r.json()).toMatchObject({
      ok: false,
      reason: 'bad_key',
      message: 'Wispr Flow needs you to connect again.',
    });
  });
});
