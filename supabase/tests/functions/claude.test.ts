import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { recordUsage } from '../../functions/_shared/budget.ts';
import { costUsd, makeClaude, TASKS } from '../../functions/_shared/claude.ts';
import { jsonRes, recordingFetch } from '../helpers/google.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const Schema = z.object({ kind: z.enum(['interested', 'decline']), confidence: z.number() });

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: JSON.stringify({ kind: 'interested', confidence: 0.9 }) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0,
  },
  ...over,
});

function fakeApi(answers: Record<string, unknown>[]) {
  let i = 0;
  return recordingFetch(() => jsonRes(200, answers[Math.min(i++, answers.length - 1)]));
}

const request = {
  task: 'classify' as const,
  system: 'Classify the reply.',
  user: 'Sounds great!',
  schema: Schema,
};

describe('claude helper (§13.1)', () => {
  it('answers unconfigured with no key and makes no call', async () => {
    const api = fakeApi([message()]);
    const c = makeClaude({ apiKey: undefined, fetch: api.fetch });
    expect(c.configured).toBe(false);
    expect(await c.structured({ ...request, userId: null })).toEqual({ ok: false, unconfigured: true });
    expect(api.calls).toHaveLength(0);
  });

  it('calls the task’s model with a cached system prompt and structured output, and records usage', async () => {
    const u = await makeUser(t.db);
    const api = fakeApi([message()]);
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch, db: t.db });
    const r = await c.structured({ ...request, userId: u });
    expect(r).toMatchObject({
      ok: true,
      data: { kind: 'interested', confidence: 0.9 },
      model: 'claude-haiku-5-5',
    });
    const sent = JSON.parse(api.calls[0]!.body);
    expect(api.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.model).toBe(TASKS.classify.model);
    expect(sent.system[0]).toEqual({
      type: 'text',
      text: 'Classify the reply.',
      cache_control: { type: 'ephemeral' },
    });
    expect(sent.output_config.effort).toBe('low');
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(sent.output_config.format.schema.required).toEqual(['kind', 'confidence']);
    expect(JSON.stringify(sent.output_config.format.schema.properties.kind)).toContain('interested');
    const [row] = await t.db.sql<{ provider: string; operation: string; units: string; cost_usd: string }>`
      select provider, operation, units::text, cost_usd::text from orbit.usage_ledger where user_id = ${u}::uuid`;
    expect(row).toMatchObject({ provider: 'anthropic', operation: 'classify', units: '1100' });
    expect(Number(row!.cost_usd)).toBeCloseTo(
      costUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000 }),
      5,
    );
  });

  it('uses Opus 5.5 for drafting and Haiku 5.5 for bulk work', () => {
    expect(TASKS.compose.model).toBe('claude-opus-5-5');
    expect(TASKS.reply.model).toBe('claude-opus-5-5');
    expect(TASKS.dossier.model).toBe('claude-opus-5-5');
    expect(TASKS.fit.model).toBe('claude-haiku-5-5');
    expect(TASKS.judge.model).toBe('claude-sonnet-5-5');
    expect(costUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(4);
  });

  it('reports a refusal so the caller takes its fallback path', async () => {
    const api = fakeApi([
      message({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      }),
    ]);
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch });
    expect(await c.structured({ ...request, userId: null })).toEqual({
      ok: false,
      refused: true,
      category: 'cyber',
    });
  });

  it('retries once with twice the room after max_tokens', async () => {
    const cut = message({ content: [{ type: 'text', text: '{"kind":"inter' }], stop_reason: 'max_tokens' });
    const api = fakeApi([cut, message()]);
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch });
    const r = await c.structured({ ...request, userId: null });
    expect(r.ok).toBe(true);
    expect(api.calls.map((x) => JSON.parse(x.body).max_tokens)).toEqual([1000, 2000]);
    const twice = fakeApi([cut, cut]);
    const c2 = makeClaude({ apiKey: 'sk-placeholder', fetch: twice.fetch });
    expect(await c2.structured({ ...request, userId: null })).toEqual({ ok: false, error: 'max_tokens' });
  });

  it('reports output that does not match the schema', async () => {
    const api = fakeApi([message({ content: [{ type: 'text', text: '{"kind":"maybe","confidence":1}' }] })]);
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch });
    expect(await c.structured({ ...request, userId: null })).toMatchObject({
      ok: false,
      error: 'invalid_output',
    });
  });

  it('returns budget_exceeded before calling when the user is over the daily cap', async () => {
    const u = await makeUser(t.db);
    await recordUsage(t.db, { userId: u, provider: 'anthropic', operation: 'compose', units: 1, costUsd: 2 });
    const api = fakeApi([message()]);
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch, db: t.db });
    expect(await c.structured({ ...request, userId: u })).toMatchObject({
      ok: false,
      budgetExceeded: true,
      cap: 'claude_daily_usd',
    });
    expect(api.calls).toHaveLength(0);
  });

  it('reports API failures as a value', async () => {
    const api = recordingFetch(() =>
      jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }),
    );
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch });
    expect(await c.structured({ ...request, userId: null })).toMatchObject({ ok: false, error: 'api_error' });
  });
});
