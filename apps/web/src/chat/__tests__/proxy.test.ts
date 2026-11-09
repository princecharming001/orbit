import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Bucket,
  buckets,
  DEFAULT_LIMITS,
  defaultOrigins,
  filterBetas,
  makeHandler,
  meter,
  rejectBody,
  type Spend,
  subjectOf,
  type Take,
  UPSTREAM,
  type UsageRow,
  verifyOrbitSession,
} from '../../../../../supabase/functions/orbit-claude/proxy';
import { describeLlmFailure, toLlmError } from '../../integrations/anthropic';
import { readPrefs, writePrefs } from '../../integrations/prefs';
import {
  setSharedClaudeUrlForTests,
  sharedClaudeAvailable,
  sharedClaudePause,
} from '../../integrations/shared-claude';
import { chatClient, SHARED_KEY } from '../agent/client';
import { CHAT_BETAS, FALLBACK_MODELS, MAX_TOKENS } from '../agent/loop';
import { chatMode, chatModeNote } from '../agent/mode';

const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-claude';
const SERVER_KEY = 'server-side-key-not-real';

const sse = (events: [string, unknown][]) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

const STREAM = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function memSpend(start: Record<string, number> = {}) {
  const totals = new Map(Object.entries(start));
  const adds: [string, number][] = [];
  const spend: Spend = {
    total: async (s) => totals.get(s) ?? 0,
    add: async (s, usd) => {
      adds.push([s, usd]);
      totals.set(s, (totals.get(s) ?? 0) + usd);
    },
  };
  return { spend, totals, adds };
}

function harness(
  opts: {
    take?: Take;
    apiKey?: string | undefined;
    upstreamStatus?: number;
    spend?: Spend;
    sessionSecret?: string | (() => Promise<string | undefined>);
    enabled?: () => Promise<boolean>;
    usage?: (row: UsageRow) => Promise<void>;
    headers?: Record<string, string>;
    monthlyUsd?: number;
    ownerId?: string | (() => Promise<string | undefined>);
  } = {},
) {
  const upstream: Seen[] = [];
  const taken: Bucket[][] = [];
  const handler = makeHandler({
    apiKey: 'apiKey' in opts ? opts.apiKey : SERVER_KEY,
    origins: defaultOrigins,
    spend: opts.spend,
    sessionSecret: opts.sessionSecret,
    enabled: opts.enabled,
    usage: opts.usage,
    monthlyUsd: opts.monthlyUsd,
    ownerId: opts.ownerId,
    take:
      opts.take ??
      (async (bs) => {
        taken.push(bs);
        return { allowed: true };
      }),
    fetch: (async (url: string, init: RequestInit) => {
      upstream.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(init.body as string),
      });
      const status = opts.upstreamStatus ?? 200;
      return status === 200
        ? new Response(STREAM, {
            status,
            headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' },
          })
        : new Response(
            JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x' } }),
            {
              status,
              headers: { 'content-type': 'application/json' },
            },
          );
    }) as typeof fetch,
  });
  // the browser side: every SDK request goes through the handler, as if over the network, with the page's Origin
  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set('origin', ORIGIN);
    headers.set('x-forwarded-for', '203.0.113.7, 10.0.0.1');
    return handler(new Request(req, { headers }));
  }) as typeof fetch;
  const client = new Anthropic({
    apiKey: SHARED_KEY,
    baseURL: BASE,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    fetch: browserFetch,
    ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
  });
  return { handler, client, upstream, taken };
}

const chatParams = {
  model: 'claude-opus-5-5',
  max_tokens: MAX_TOKENS,
  betas: [...CHAT_BETAS],
  fallbacks: FALLBACK_MODELS,
  tools: [{ name: 'get_brief', description: 'x', input_schema: { type: 'object' as const, properties: {} } }],
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('Orbit Claude proxy', () => {
  it('streams a chat request through with the server key and only the allowed betas', async () => {
    const { client, upstream, taken } = harness();
    const stream = client.beta.messages.stream(chatParams);
    let text = '';
    stream.on('text', (d) => (text += d));
    const msg = await stream.finalMessage();
    expect(text).toBe('Hi');
    expect(msg.stop_reason).toBe('end_turn');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe(UPSTREAM);
    expect(upstream[0]!.headers.get('x-api-key')).toBe(SERVER_KEY);
    expect(upstream[0]!.headers.get('anthropic-beta')!.split(',').sort()).toEqual([...CHAT_BETAS].sort());
    expect(upstream[0]!.body.model).toBe('claude-opus-5-5');
    // the visitor is a hash, never the raw IP
    expect(taken[0]!.map((b) => b.key).join(' ')).not.toContain('203.0.113.7');
    expect(taken[0]).toHaveLength(3);
  });

  it('answers the CORS preflight for Orbit and refuses other sites', async () => {
    const { handler } = harness();
    const pre = (origin: string) =>
      handler(
        new Request(`${BASE}/v1/messages`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-headers': 'x-api-key,anthropic-beta,content-type' },
        }),
      );
    const ok = await pre(ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-headers')).toContain('anthropic-beta');
    expect((await pre('https://evil.example')).status).toBe(403);
    const post = await handler(
      new Request(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        body: JSON.stringify(chatParams),
      }),
    );
    expect(post.status).toBe(403);
  });

  it('refuses other models, oversized max_tokens, server tools and MCP servers before spending anything', async () => {
    const { client, upstream, taken } = harness();
    const bad = [
      { ...chatParams, model: 'claude-other' },
      { ...chatParams, max_tokens: 16_001 },
      { ...chatParams, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      { ...chatParams, fallbacks: [{ model: 'claude-other' }] },
      { ...chatParams, mcp_servers: [{ type: 'url', url: 'https://x', name: 'x' }] },
    ];
    for (const p of bad) {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed params
      await expect(client.beta.messages.create(p as any)).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    }
    expect(upstream).toHaveLength(0);
    expect(taken).toHaveLength(0);
  });

  it("lets exactly Claude's web search through, a few searches a request, and nothing that widens it", () => {
    const ok = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 };
    expect(rejectBody({ ...chatParams, tools: [ok] })).toBeUndefined();
    expect(
      rejectBody({ ...chatParams, tools: [{ ...ok, cache_control: { type: 'ephemeral' } }] }),
    ).toBeUndefined();
    for (const bad of [
      { ...ok, max_uses: 6 },
      { type: 'web_search_20260209', name: 'web_search' },
      { ...ok, allowed_callers: ['code_execution_20260120'] },
      { ...ok, name: 'other' },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1 },
      { type: 'code_execution_20260521', name: 'code_execution' },
    ])
      expect(rejectBody({ ...chatParams, tools: [bad] }), JSON.stringify(bad)).toBeTruthy();
  });

  it('lets the BM25 tool search and deferred client tools through, and still refuses every other server tool (plan 35 A1)', () => {
    const search = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' };
    const deferred = {
      name: 'get_settings',
      description: 'Read the settings.',
      input_schema: { type: 'object', properties: {} },
      defer_loading: true,
    };
    const web = { type: 'web_search_20260209', name: 'web_search', max_uses: 2 };
    expect(rejectBody({ ...chatParams, tools: [deferred, search, web] })).toBeUndefined();
    for (const bad of [
      { ...search, name: 'other' },
      { ...search, defer_loading: true },
      { ...search, allowed_callers: ['code_execution_20260120'] },
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      { type: 'memory_20250818', name: 'memory' },
      { type: 'web_fetch_20260309', name: 'web_fetch' },
      { type: 'mcp_toolset', mcp_server_name: 'x' },
    ])
      expect(rejectBody({ ...chatParams, tools: [deferred, bad] }), JSON.stringify(bad)).toBeTruthy();
  });

  it('turns a used-up day into a rate limit error the app recognises, without retrying', async () => {
    const { client, upstream } = harness({
      take: async (bs) => ({ allowed: false, over: bs[1]!.key }),
    });
    const err = await client.beta.messages.create(chatParams).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(err.headers.get('x-orbit-limit')).toBe('day');
    expect(upstream).toHaveLength(0);
  });

  it('reports a missing or rejected server key as unavailable, never as the visitor key being wrong', async () => {
    const none = harness({ apiKey: undefined });
    const e1 = await none.client.beta.messages.create(chatParams).catch((e) => e);
    expect(e1.status).toBe(503);
    expect(e1.headers.get('x-orbit-limit')).toBe('unconfigured');
    const rejected = harness({ upstreamStatus: 401 });
    const e2 = await rejected.client.beta.messages.create(chatParams).catch((e) => e);
    expect(e2.status).toBe(503);
    expect(e2.headers.get('x-orbit-limit')).toBe('unconfigured');
  });

  it('reads the key through a lookup, and treats a failed lookup as not set up', async () => {
    const ok = harness({ apiKey: undefined });
    const lookup = makeHandler({
      apiKey: async () => SERVER_KEY,
      origins: defaultOrigins,
      take: async () => ({ allowed: true }),
      fetch: (async () =>
        new Response(STREAM, {
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    });
    const res = await lookup(
      new Request(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(chatParams),
      }),
    );
    expect(res.status).toBe(200);
    const failing = makeHandler({
      apiKey: async () => {
        throw new Error('down');
      },
      origins: defaultOrigins,
      take: async () => ({ allowed: true }),
    });
    const res2 = await failing(
      new Request(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(chatParams),
      }),
    );
    expect(res2.status).toBe(503);
    expect(res2.headers.get('x-orbit-limit')).toBe('unconfigured');
    expect(ok.upstream).toHaveLength(0);
  });

  it('fails closed when the counter store is down', async () => {
    const { client, upstream } = harness({
      take: async () => {
        throw new Error('db down');
      },
    });
    const err = await client.beta.messages.create(chatParams).catch((e) => e);
    expect(err.status).toBe(503);
    expect(upstream).toHaveLength(0);
  });

  it('builds minute, day and global buckets that expire at the end of their window', () => {
    const bs = buckets('v', new Date('2026-10-12T13:45:10Z'), DEFAULT_LIMITS);
    expect(bs.map((b) => b.expires)).toEqual([
      '2026-10-12T13:46:00.000Z',
      '2026-10-13T00:00:00.000Z',
      '2026-10-13T00:00:00.000Z',
    ]);
    expect(bs[2]!.key).toBe('orbit:global:2026-10-12');
  });

  it('keeps only known betas and checks bodies', () => {
    expect(filterBetas('compact-2026-01-12, files-api-2025-04-14')).toBe('compact-2026-01-12');
    expect(filterBetas('files-api-2025-04-14')).toBeUndefined();
    expect(rejectBody(chatParams)).toBeUndefined();
    expect(rejectBody([])).toBeDefined();
    expect(rejectBody({ ...chatParams, messages: [] })).toBeDefined();
  });
});

describe('the app on shared access', () => {
  beforeEach(() => {
    writePrefs({ anthropicApiKey: undefined, sharedClaudePause: undefined, llmFeatures: { chat: true } });
  });
  afterEach(() => {
    setSharedClaudeUrlForTests(undefined);
    writePrefs({ sharedClaudePause: undefined });
  });

  it('chats with Claude without a key when the shared access is configured', () => {
    setSharedClaudeUrlForTests(null);
    expect(chatMode()).toBe('router');
    setSharedClaudeUrlForTests(BASE);
    expect(sharedClaudeAvailable()).toBe(true);
    expect(chatMode()).toBe('llm');
    expect(chatModeNote()).toBeUndefined();
    expect(chatClient()).toBeDefined();
  });

  it('prefers the student own key and respects the chat switch', () => {
    setSharedClaudeUrlForTests(BASE);
    writePrefs({ llmFeatures: { chat: false } });
    expect(chatMode()).toBe('router');
    expect(chatModeNote()?.text).toMatch(/turned off/);
    writePrefs({ llmFeatures: { chat: true }, anthropicApiKey: 'sk-ant-test-own' });
    expect(sharedClaudeAvailable()).toBe(false);
    expect(chatMode()).toBe('llm');
  });

  it('pauses until tomorrow after the daily limit, then explains why the chat is on commands', async () => {
    setSharedClaudeUrlForTests(BASE);
    const { client } = harness({ take: async (bs) => ({ allowed: false, over: bs[2]!.key }) });
    const raw = await client.beta.messages.create(chatParams).catch((e) => e);
    const err = toLlmError(raw);
    expect(err.reason).toBe('shared_limit');
    expect(describeLlmFailure(err).body).toMatch(/own Anthropic key/);
    expect(readPrefs().sharedClaudePause?.reason).toBe('global');
    expect(sharedClaudePause()).toBeDefined();
    expect(chatMode()).toBe('router');
    expect(chatModeNote()?.text).toMatch(/reached today's limit/);
    // the next day it is available again
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    expect(sharedClaudeAvailable(tomorrow)).toBe(true);
  });

  it('treats a busy minute as a short rate limit, not a pause', async () => {
    setSharedClaudeUrlForTests(BASE);
    const { client } = harness({ take: async (bs) => ({ allowed: false, over: bs[0]!.key }) });
    const err = toLlmError(await client.beta.messages.create(chatParams).catch((e) => e));
    expect(err.reason).toBe('rate_limit');
    expect(sharedClaudePause()).toBeUndefined();
    expect(chatMode()).toBe('llm');
  });
});

const SECRET = 'a-session-secret-that-is-long-enough-to-sign-with';
const b64url = (b: Uint8Array | string) =>
  Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function accessToken(claims: Record<string, unknown>, secret = SECRET) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
const USER = '0b7f6c2e-8a51-4c1e-9d0a-3f2b1c4d5e6f';
const CLIENT = 'f00dfeedc0ffee0123456789abcdef01';

describe('the $3 per-user daily cap on Orbit’s key', () => {
  afterEach(() => {
    setSharedClaudeUrlForTests(undefined);
    writePrefs({ sharedClaudePause: undefined });
  });

  it('prices each streamed answer at the chat model’s rates and charges this browser', async () => {
    const m = memSpend();
    const { client } = harness({ spend: m.spend, headers: { 'x-orbit-client': CLIENT } });
    const res = await client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    expect(res.response.headers.get('x-orbit-budget-remaining')).toBe('3.00');
    for await (const _ of res.data) {
      // read the stream through, as the chat does
    }
    // 10 input tokens at $4/M at message_start, then 1 output token at $20/M at message_delta
    const mine = m.adds.filter(([s]) => s === `client:${CLIENT}:${new Date().toISOString().slice(0, 10)}`);
    expect(mine).toHaveLength(2);
    expect(mine[0]![1]).toBeCloseTo(0.00004, 10);
    expect(mine[1]![1]).toBeCloseTo(0.00002, 10);
    // the same dollars count toward the day's total and, with nobody signed in, this network's day
    const day = new Date().toISOString().slice(0, 10);
    expect(m.adds.filter(([s]) => s === `global:${day}`)).toHaveLength(2);
    expect(m.adds.filter(([s]) => s.startsWith('ipday:') && s.endsWith(day))).toHaveLength(2);
  });

  it('a script rotating its browser id gets no fresh allowance: the network’s day stops it, and a signed-in user is not counted there', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const m = memSpend();
    // spend the network's day under one browser id
    const first = harness({ spend: m.spend, headers: { 'x-orbit-client': CLIENT } });
    const res = await first.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of res.data) {
      // read through
    }
    const ipKey = m.adds.map(([s]) => s).find((s) => s.startsWith('ipday:'))!;
    expect(ipKey.endsWith(day)).toBe(true);
    const over = memSpend({ [ipKey]: 10.5 });
    const rotated = harness({ spend: over.spend, headers: { 'x-orbit-client': 'a'.repeat(32) } });
    const raw = await rotated.client.beta.messages.create(chatParams).catch((e) => e);
    expect(raw).toBeInstanceOf(Anthropic.RateLimitError);
    expect(rotated.upstream).toHaveLength(0);
    // a signed-in user on that network still chats, charged to themselves and the day, never the network
    const signedIn = harness({
      spend: over.spend,
      sessionSecret: SECRET,
      headers: {
        'x-orbit-session': await accessToken({
          sub: USER,
          aud: 'orbit',
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
        'x-orbit-client': CLIENT,
      },
    });
    const ok = await signedIn.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of ok.data) {
      // read through
    }
    expect(signedIn.upstream).toHaveLength(1);
    expect(over.adds.map(([s]) => s).filter((s) => s.startsWith('ipday:'))).toHaveLength(0);
    expect(over.adds.map(([s]) => s)).toContain(`user:${USER}:${new Date().toISOString().slice(0, 10)}`);
    // and to their lifetime total, the subject the server's own caps read, and their month: four adds per priced event
    expect(over.adds.map(([s]) => s)).toContain(`user:${USER}`);
    const perEvent = over.adds.filter(([s]) => !s.startsWith('ipday:'));
    expect(perEvent).toHaveLength(8);
  });

  it('reads the session key through a lookup (the copy in Vault) and charges the signed-in user', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const m = memSpend();
    const signedIn = harness({
      spend: m.spend,
      sessionSecret: async () => SECRET,
      headers: {
        'x-orbit-session': await accessToken({
          sub: USER,
          aud: 'orbit',
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
        'x-orbit-client': CLIENT,
      },
    });
    const ok = await signedIn.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of ok.data) {
      // read through
    }
    const subjects = new Set(m.adds.map(([s]) => s));
    expect(subjects).toEqual(
      new Set([`user:${USER}:${day}`, `global:${day}`, `user:${USER}`, `user:${USER}:m:${day.slice(0, 7)}`]),
    );
    // a lookup that fails leaves the request counted by browser, never refused
    const broken = memSpend();
    const fallback = harness({
      spend: broken.spend,
      sessionSecret: async () => {
        throw new Error('vault down');
      },
      headers: { 'x-orbit-client': CLIENT },
    });
    const res = await fallback.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of res.data) {
      // read through
    }
    expect(broken.adds.map(([s]) => s)).toContain(`client:${CLIENT}:${day}`);
  });

  it('answers unconfigured without calling Anthropic while the anthropic switch is off', async () => {
    const off = harness({ enabled: async () => false, headers: { 'x-orbit-client': CLIENT } });
    const raw = await off.client.beta.messages.create(chatParams).catch((e) => e);
    expect(raw.status).toBe(503);
    expect(raw.headers.get('x-orbit-limit')).toBe('unconfigured');
    expect(off.upstream).toHaveLength(0);
    // a switch store that cannot answer counts as on
    const flaky = harness({
      enabled: async () => {
        throw new Error('store down');
      },
    });
    await flaky.client.beta.messages.create(chatParams);
    expect(flaky.upstream).toHaveLength(1);
  });

  it('writes one usage row per answer with its tokens, searches and the turn iteration', async () => {
    const rows: UsageRow[] = [];
    const m = memSpend();
    const { client } = harness({
      spend: m.spend,
      usage: async (r) => {
        rows.push(r);
      },
      headers: { 'x-orbit-client': CLIENT, 'x-orbit-iterations': '2' },
    });
    const res = await client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of res.data) {
      // read through
    }
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.subject).toBe(`client:${CLIENT}:${new Date().toISOString().slice(0, 10)}`);
    expect(row.call).toBe('chat');
    expect(row.iterations).toBe(2);
    expect(row.input).toBe(10);
    expect(row.output).toBe(1);
    expect(row.usd).toBeCloseTo(0.00006, 8);
  });

  it('the day’s total across everyone is a hard stop before Anthropic is called', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const m = memSpend({ [`global:${day}`]: 25 });
    const { client, upstream } = harness({ spend: m.spend, headers: { 'x-orbit-client': CLIENT } });
    const raw = await client.beta.messages.create(chatParams).catch((e) => e);
    expect(raw).toBeInstanceOf(Anthropic.RateLimitError);
    expect(raw.headers.get('x-orbit-limit')).toBe('global');
    expect(upstream).toHaveLength(0);
  });

  it('refuses before calling Anthropic once the user has spent today’s $3, and the chat pauses until midnight UTC', async () => {
    setSharedClaudeUrlForTests(BASE);
    const m = memSpend({ [`client:${CLIENT}:${new Date().toISOString().slice(0, 10)}`]: 3.0001 });
    const { client, upstream } = harness({ spend: m.spend, headers: { 'x-orbit-client': CLIENT } });
    const raw = await client.beta.messages.create(chatParams).catch((e) => e);
    expect(raw).toBeInstanceOf(Anthropic.RateLimitError);
    expect(raw.headers.get('x-orbit-limit')).toBe('budget');
    expect(upstream).toHaveLength(0);
    const err = toLlmError(raw);
    expect(err.reason).toBe('shared_limit');
    expect(describeLlmFailure(err).title).toBe("Today's included Claude is used up");
    expect(readPrefs().sharedClaudePause?.reason).toBe('budget');
    expect(chatMode()).toBe('router');
    expect(chatModeNote()?.text).toMatch(/used today's Claude that Orbit includes/);
    // back the next UTC day: the allowance is per day
    expect(sharedClaudeAvailable(new Date(Date.now() + 2 * 24 * 3600_000))).toBe(true);
  });

  it('a signed-in student who used the month’s $10 is stopped until the 1st, and the chat says so', async () => {
    setSharedClaudeUrlForTests(BASE);
    const month = new Date().toISOString().slice(0, 7);
    const session = await accessToken({ sub: USER, aud: 'orbit', exp: Math.floor(Date.now() / 1000) + 600 });
    const m = memSpend({ [`user:${USER}:m:${month}`]: 10.01 });
    const { client, upstream } = harness({
      spend: m.spend,
      sessionSecret: SECRET,
      headers: { 'x-orbit-session': session, 'x-orbit-client': CLIENT },
    });
    const raw = await client.beta.messages.create(chatParams).catch((e) => e);
    expect(raw).toBeInstanceOf(Anthropic.RateLimitError);
    expect(raw.headers.get('x-orbit-limit')).toBe('budget');
    expect(raw.headers.get('x-orbit-budget-scope')).toBe('month');
    const reset = new Date(raw.headers.get('x-orbit-reset'));
    expect(reset.getUTCDate()).toBe(1);
    expect(reset.getTime()).toBeGreaterThan(Date.now());
    expect(upstream).toHaveLength(0);
    const err = toLlmError(raw);
    expect(err.reason).toBe('shared_limit');
    expect(describeLlmFailure(err).title).toBe("This month's included Claude is used up");
    expect(readPrefs().sharedClaudePause).toMatchObject({ reason: 'budget', scope: 'month' });
    expect(chatMode()).toBe('router');
    expect(chatModeNote()?.text).toMatch(/used this month's Claude that Orbit includes/);
    // still paused tomorrow (a day's pause would have ended), back once the month turns
    expect(sharedClaudeAvailable(new Date(Date.now() + 26 * 3600_000))).toBe(
      reset.getTime() < Date.now() + 26 * 3600_000,
    );
    expect(sharedClaudeAvailable(new Date(reset.getTime() + 1000))).toBe(true);
    // under the allowance the answer says how much is left, the smaller of the day and the month
    const under = memSpend({ [`user:${USER}:m:${month}`]: 9.5 });
    const ok = harness({
      spend: under.spend,
      sessionSecret: SECRET,
      headers: { 'x-orbit-session': session, 'x-orbit-client': CLIENT },
    });
    const res = await ok.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    expect(res.response.headers.get('x-orbit-budget-remaining')).toBe('0.50');
    for await (const _ of res.data) {
      // read through
    }
  });

  it('the owner has no monthly allowance, and someone not signed in is never held to one', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const session = await accessToken({ sub: USER, aud: 'orbit', exp: Math.floor(Date.now() / 1000) + 600 });
    const m = memSpend({ [`user:${USER}:m:${month}`]: 50 });
    const owner = harness({
      spend: m.spend,
      sessionSecret: SECRET,
      ownerId: async () => USER,
      headers: { 'x-orbit-session': session, 'x-orbit-client': CLIENT },
    });
    const res = await owner.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of res.data) {
      // read through
    }
    expect(owner.upstream).toHaveLength(1);
    // still metered, so the owner's month shows on the cost page
    expect(m.adds.map(([s]) => s)).toContain(`user:${USER}:m:${month}`);
    // a browser without an account has its own daily caps and no month subject
    const anon = memSpend();
    const browser = harness({ spend: anon.spend, headers: { 'x-orbit-client': CLIENT } });
    const r2 = await browser.client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    for await (const _ of r2.data) {
      // read through
    }
    expect(anon.adds.some(([s]) => s.includes(':m:'))).toBe(false);
  });

  it('counts a signed-in student by their account, and anyone else by browser, then by IP', async () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const exp = Math.floor(now.getTime() / 1000) + 600;
    const good = await accessToken({ sub: USER, sid: USER, aud: 'orbit', exp });
    expect(await verifyOrbitSession(good, SECRET, now)).toBe(USER);
    expect(await verifyOrbitSession(good, `${SECRET}-other`, now)).toBeUndefined();
    expect(
      await verifyOrbitSession(await accessToken({ sub: USER, aud: 'orbit', exp: 1 }), SECRET, now),
    ).toBeUndefined();
    expect(
      await verifyOrbitSession(await accessToken({ sub: USER, aud: 'other', exp }), SECRET, now),
    ).toBeUndefined();
    const req = (h: Record<string, string>) => new Request('https://x.test/v1/messages', { headers: h });
    expect(
      await subjectOf(req({ 'x-orbit-session': good, 'x-orbit-client': CLIENT }), 'iphash', SECRET, now),
    ).toBe(`user:${USER}`);
    expect(
      await subjectOf(req({ 'x-orbit-session': 'junk', 'x-orbit-client': CLIENT }), 'iphash', SECRET, now),
    ).toBe(`client:${CLIENT}`);
    expect(await subjectOf(req({ 'x-orbit-client': 'short' }), 'iphash', SECRET, now)).toBe('ip:iphash');
  });

  it('charges each web search, and the input its results add after the start, once', async () => {
    const events = [
      {
        type: 'message_start',
        message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1 } },
      },
      {
        type: 'message_delta',
        usage: { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
      },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const charged: number[] = [];
    await new Response(
      meter(new Response(sse).body!, true, async (usd) => {
        charged.push(usd);
      }),
    ).text();
    expect(charged[0]).toBeCloseTo((1000 * 4) / 1e6, 10);
    // 3,000 more input tokens read with the results, 300 output, and two searches at a cent each
    expect(charged[1]).toBeCloseTo((3000 * 4 + 300 * 20) / 1e6 + 0.02, 10);
    // the totals for the usage row: every token once, the searches, and the whole price
    let totals: { input: number; output: number; webSearches: number; usd: number } | undefined;
    await new Response(
      meter(
        new Response(sse).body!,
        true,
        async () => {},
        async (t) => {
          totals = t;
        },
      ),
    ).text();
    expect(totals).toMatchObject({ input: 4000, output: 300, webSearches: 2 });
    expect(totals!.usd).toBeCloseTo((4000 * 4 + 300 * 20) / 1e6 + 0.02, 5);
  });

  it('prices a JSON answer at the end, and never breaks the answer when the spend store fails', async () => {
    const answer = JSON.stringify({
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000 },
    });
    const charged: number[] = [];
    const out = await new Response(
      meter(new Response(answer).body!, false, async (usd) => {
        charged.push(usd);
      }),
    ).text();
    expect(out).toBe(answer);
    expect(charged[0]).toBeCloseTo((1000 * 4 + 500 * 20 + 10_000 * 0.2) / 1e6, 10);
    const still = await new Response(
      meter(new Response(STREAM).body!, true, async () => {
        throw new Error('store down');
      }),
    ).text();
    expect(still).toBe(STREAM);
  });
});
