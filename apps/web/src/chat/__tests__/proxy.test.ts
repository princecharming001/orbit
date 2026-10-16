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
    sessionSecret?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const upstream: Seen[] = [];
  const taken: Bucket[][] = [];
  const handler = makeHandler({
    apiKey: 'apiKey' in opts ? opts.apiKey : SERVER_KEY,
    origins: defaultOrigins,
    spend: opts.spend,
    sessionSecret: opts.sessionSecret,
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
      { ...chatParams, max_tokens: MAX_TOKENS + 1 },
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

describe('the $20 per-user cap on Orbit’s key', () => {
  afterEach(() => {
    setSharedClaudeUrlForTests(undefined);
    writePrefs({ sharedClaudePause: undefined });
  });

  it('prices each streamed answer at the chat model’s rates and charges this browser', async () => {
    const m = memSpend();
    const { client } = harness({ spend: m.spend, headers: { 'x-orbit-client': CLIENT } });
    const res = await client.beta.messages.create({ ...chatParams, stream: true }).withResponse();
    expect(res.response.headers.get('x-orbit-budget-remaining')).toBe('20.00');
    for await (const _ of res.data) {
      // read the stream through, as the chat does
    }
    // 10 input tokens at $4/M at message_start, then 1 output token at $20/M at message_delta
    expect(m.adds.map(([s]) => s)).toEqual([`client:${CLIENT}`, `client:${CLIENT}`]);
    expect(m.adds[0]![1]).toBeCloseTo(0.00004, 10);
    expect(m.adds[1]![1]).toBeCloseTo(0.00002, 10);
  });

  it('refuses before calling Anthropic once the user has spent $20, and the chat says so and stops asking', async () => {
    setSharedClaudeUrlForTests(BASE);
    const m = memSpend({ [`client:${CLIENT}`]: 20.0001 });
    const { client, upstream } = harness({ spend: m.spend, headers: { 'x-orbit-client': CLIENT } });
    const raw = await client.beta.messages.create(chatParams).catch((e) => e);
    expect(raw).toBeInstanceOf(Anthropic.RateLimitError);
    expect(raw.headers.get('x-orbit-limit')).toBe('budget');
    expect(upstream).toHaveLength(0);
    const err = toLlmError(raw);
    expect(err.reason).toBe('shared_limit');
    expect(describeLlmFailure(err).title).toBe('Your included Claude is used up');
    expect(readPrefs().sharedClaudePause?.reason).toBe('budget');
    expect(chatMode()).toBe('router');
    expect(chatModeNote()?.text).toMatch(/used all the Claude that Orbit includes/);
    // not back tomorrow: the allowance does not reset by itself
    expect(sharedClaudeAvailable(new Date(Date.now() + 2 * 24 * 3600_000))).toBe(false);
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
