// @vitest-environment node
/**
 * Orbit's shared Claude access for calls other than the chat (plan 17 §G): reading what the student said after a turn
 * (`x-orbit-call: memory`) and reading a resume (`resume`). Same style as proxy.test.ts: the real handler with a fake
 * counter store and a fake Anthropic, and the app's own client sending through it. Runs in Node, where the SDK's
 * AbortSignal and the handler's Request agree.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Bucket,
  buckets,
  CALL_LIMITS,
  callOf,
  DEFAULT_LIMITS,
  defaultOrigins,
  makeHandler,
  rejectCall,
  type Take,
} from '../../../../../supabase/functions/orbit-claude/proxy';
import {
  claudeReachable,
  llmExtractMemories,
  llmResumeParse,
  setSharedLlmClientFactoryForTests,
  toLlmError,
} from '../../integrations/anthropic';
import { readPrefs, writePrefs } from '../../integrations/prefs';
import { setSharedClaudeUrlForTests, sharedClaudePause } from '../../integrations/shared-claude';

const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-claude';

interface Seen {
  headers: Headers;
  body: Record<string, unknown>;
}

function harness(opts: { take?: Take; answer?: unknown } = {}) {
  const upstream: Seen[] = [];
  const taken: Bucket[][] = [];
  const handler = makeHandler({
    apiKey: 'server-key',
    origins: defaultOrigins,
    take:
      opts.take ??
      (async (bs) => {
        taken.push(bs);
        return { allowed: true };
      }),
    fetch: (async (_url: string, init: RequestInit) => {
      upstream.push({ headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(opts.answer ?? {}) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  return { handler, post, upstream, taken };
}

const read = (call: 'memory' | 'resume', extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  max_tokens: call === 'memory' ? 1024 : 8192,
  messages: [{ role: 'user', content: 'I am targeting PM internships' }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
  ...extra,
});

describe('the proxy: memory and resume reads', () => {
  it('forwards a memory read, counted with the chat and in its own daily counter', async () => {
    const { post, upstream, taken } = harness({ answer: { memories: [] } });
    const res = await post(read('memory'), { 'x-orbit-call': 'memory' });
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get('x-api-key')).toBe('server-key');
    const keys = taken[0]!.map((b) => b.key);
    expect(keys).toHaveLength(4);
    expect(keys.some((k) => k.startsWith('orbit:day:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('orbit:memory:'))).toBe(true);
    expect(taken[0]!.find((b) => b.key.startsWith('orbit:memory:'))!.limit).toBe(200);
  });

  it('holds resumes to 5 a day by default, and the chat to its three counters', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(buckets('v', now, DEFAULT_LIMITS)).toHaveLength(3);
    const resume = buckets('v', now, DEFAULT_LIMITS, 'resume');
    expect(resume[3]).toEqual({
      key: 'orbit:resume:2026-10-22:v',
      limit: 5,
      expires: '2026-10-23T00:00:00.000Z',
    });
    expect(buckets('v', now, { ...DEFAULT_LIMITS, perDayCall: { resume: 9 } }, 'resume')[3]!.limit).toBe(9);
  });

  it('refuses tools, thinking, a second message, too many tokens, a big body and unknown call types', async () => {
    const { post, upstream, taken } = harness();
    const bad: [Record<string, unknown>, string][] = [
      [read('memory', { max_tokens: CALL_LIMITS.memory.maxTokens + 1 }), 'memory'],
      [read('memory', { tools: [{ name: 'x', input_schema: { type: 'object' } }] }), 'memory'],
      [read('memory', { thinking: { type: 'enabled', budget_tokens: 2000 } }), 'memory'],
      [
        read('memory', {
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
          ],
        }),
        'memory',
      ],
      [
        read('memory', { messages: [{ role: 'user', content: 'x'.repeat(CALL_LIMITS.memory.maxBytes) }] }),
        'memory',
      ],
      [read('resume', { max_tokens: 9000 }), 'resume'],
      [read('memory'), 'drafts'],
    ];
    for (const [body, call] of bad) {
      const res = await post(body, { 'x-orbit-call': call });
      expect(res.status, `${call} ${JSON.stringify(body).slice(0, 80)}`).toBe(400);
    }
    expect(upstream).toHaveLength(0);
    expect(taken).toHaveLength(0);
    // the chat keeps its own rules: tools and a long conversation are fine without the header
    expect(rejectCall('chat', read('memory', { tools: [{}] }), 10)).toBeUndefined();
    expect(callOf(new Request(BASE, { headers: { 'x-orbit-call': 'RESUME' } }))).toBe('resume');
    expect(callOf(new Request(BASE))).toBe('chat');
  });

  it('answers a used-up resume count with x-orbit-limit "call", which does not pause the chat', async () => {
    const { post, upstream } = harness({
      take: async (bs) => {
        const over = bs.find((b) => b.key.startsWith('orbit:resume:'));
        return over ? { allowed: false, over: over.key } : { allowed: true };
      },
    });
    const res = await post(read('resume'), { 'x-orbit-call': 'resume' });
    expect(res.status).toBe(429);
    expect(res.headers.get('x-orbit-limit')).toBe('call');
    expect(upstream).toHaveLength(0);
    expect((await post(read('memory'), { 'x-orbit-call': 'memory' })).status).toBe(200);
  });
});

describe('the app on shared access: memory and resume reads', () => {
  const sent: Record<string, string>[] = [];
  let h: ReturnType<typeof harness>;
  const answer = {
    memories: [
      {
        kind: 'goal_detail',
        text: 'Targeting PM internships at fintech startups in New York',
        person_name: null,
        importance: 0.8,
        quote: "I'm targeting PM internships at fintech startups in New York",
      },
    ],
    recruiting: {
      functions: ['pm'],
      industries: ['fintech'],
      locations: ['New York'],
      organizations: [],
      phrase: 'PM internships at fintech startups in New York',
      quote: "I'm targeting PM internships at fintech startups in New York",
    },
  };

  beforeEach(() => {
    sent.length = 0;
    writePrefs({ anthropicApiKey: undefined, sharedClaudePause: undefined, llmUsage: undefined });
    setSharedClaudeUrlForTests(BASE);
    h = harness({ answer });
    setSharedLlmClientFactoryForTests(
      (_call, headers) =>
        new Anthropic({
          apiKey: 'orbit-shared',
          baseURL: BASE,
          defaultHeaders: headers,
          maxRetries: 0,
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            sent.push(Object.fromEntries(req.headers.entries()));
            const headers2 = new Headers(req.headers);
            headers2.set('origin', ORIGIN);
            return h.handler(new Request(req, { headers: headers2 }));
          }) as typeof fetch,
        }),
    );
  });
  afterEach(() => {
    setSharedLlmClientFactoryForTests(undefined);
    setSharedClaudeUrlForTests(undefined);
  });

  it('reads a chat turn through the proxy as a memory call, within its token limit, counted against the day', async () => {
    expect(claudeReachable('chat', 'memory')).toBe(true);
    const before = readPrefs().llmUsage?.requests ?? 0;
    const r = await llmExtractMemories(
      [{ role: 'user', text: "I'm targeting PM internships at fintech startups in New York" }],
      [],
    );
    expect(r?.memories[0]?.text).toBe('Targeting PM internships at fintech startups in New York');
    expect(sent[0]!['x-orbit-call']).toBe('memory');
    expect(h.upstream[0]!.body.max_tokens).toBe(1024);
    expect(h.upstream[0]!.body.tools).toBeUndefined();
    expect(readPrefs().llmUsage?.requests).toBe(before + 1);
  });

  it('parses a resume through the proxy as a resume call', async () => {
    h = harness({
      answer: {
        facets: [
          {
            kind: 'education',
            title: 'B.S. Computer Science',
            organization_name: 'University of Michigan',
            start_date: null,
            end_date: '2027-05-01',
            text: 'B.S. Computer Science, University of Michigan',
            keywords: ['computer', 'science'],
          },
        ],
      },
    });
    const facets = await llmResumeParse('Ravi Jain\nEDUCATION\nUniversity of Michigan', 'r1');
    expect(sent[0]!['x-orbit-call']).toBe('resume');
    expect(facets?.[0]).toMatchObject({ kind: 'education', organizationName: 'University of Michigan' });
  });

  it('never uses the shared access when the student has a key of their own', () => {
    writePrefs({ anthropicApiKey: 'sk-own' });
    expect(claudeReachable('resume', 'resume')).toBe(false);
    writePrefs({ anthropicApiKey: undefined });
  });

  it('a used-up resume count is a plain failure: the chat on shared access is not paused', async () => {
    h = harness({
      take: async (bs) => {
        const over = bs.find((b) => b.key.startsWith('orbit:resume:'));
        return over ? { allowed: false, over: over.key } : { allowed: true };
      },
    });
    const err = await llmResumeParse('text', 'r2').then(
      () => undefined,
      (e) => toLlmError(e),
    );
    expect(err?.reason).toBe('shared_limit');
    expect(sharedClaudePause()).toBeUndefined();
  });
});
