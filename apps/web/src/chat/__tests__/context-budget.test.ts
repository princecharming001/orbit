/**
 * What one chat turn costs in context, measured on the demo account: the frozen system block, the tool list, the
 * snapshot, a few typical tool results and the Remembered line. Offline the sizes are estimated at four characters a
 * token; with ANTHROPIC_API_KEY set the token-count endpoint gives exact numbers for the chat model, and a short real
 * conversation reports how much of each request was read from the prompt cache. Nothing here prints the key.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDemo } from '../../engine/demo';
import { MODEL } from '../../integrations/anthropic';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { createChatEngine } from '../agent';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { buildRunnerTools, projectEnvelope } from '../agent/loop';
import { buildSnapshot, estimateTokens } from '../agent/snapshot';
import { ChatStore } from '../agent/store';
import { stableSystemText } from '../agent/system';
import { execute, registry } from '../registry';
import type { TurnEvent } from '../types';
import { makeCtx, NOW } from './helpers';

const KEY = process.env.ANTHROPIC_API_KEY;

let user: User;
const rows: [string, number | string][] = [];
const note = (what: string, v: number | string) => rows.push([what, v]);

beforeAll(async () => {
  await clearPrefs();
  user = await loadDemo({ reset: true, now: NOW });
  writePrefs({ anthropicApiKey: 'k' });
}, 60_000);

afterEach(() => {
  if (!rows.length) return;
  const width = Math.max(...rows.map(([w]) => w.length));
  console.log(
    `\ncontext budget (${KEY ? 'token-count endpoint' : 'chars/4 estimate'}):\n${rows
      .map(([w, v]) => `  ${w.padEnd(width)}  ${v}`)
      .join('\n')}\n`,
  );
  rows.length = 0;
});

/** The tool definitions as the API sees them (no `run`, no cache marker). */
function apiTools(): Anthropic.Beta.BetaTool[] {
  return buildRunnerTools(registry, { onRun: async () => ({ kind: 'text', data: {}, summary: '' }) }).map(
    (t) => {
      const { name, description, input_schema } = t as unknown as Anthropic.Beta.BetaTool;
      return { name, description, input_schema };
    },
  );
}

async function countTokens(parts: {
  system?: string;
  tools?: Anthropic.Beta.BetaTool[];
  text: string;
}): Promise<number> {
  if (!KEY)
    return estimateTokens([parts.system ?? '', JSON.stringify(parts.tools ?? ''), parts.text].join(''));
  const client = new Anthropic({ apiKey: KEY, maxRetries: 2, dangerouslyAllowBrowser: true });
  const r = await client.beta.messages.countTokens({
    model: MODEL,
    ...(parts.system ? { system: parts.system } : {}),
    ...(parts.tools ? { tools: parts.tools } : {}),
    messages: [{ role: 'user', content: parts.text }],
  });
  return r.input_tokens;
}

describe('the context of one turn, demo account', () => {
  it('measures the system block, the tools, the snapshot and typical tool results', async () => {
    const tools = apiTools();
    const base = await countTokens({ text: 'hi' });
    const system = (await countTokens({ system: stableSystemText(), text: 'hi' })) - base;
    const toolList = (await countTokens({ system: stableSystemText(), tools, text: 'hi' })) - base - system;
    note('tools offered to the model', tools.length);
    note('system block (tokens)', system);
    note('tool list (tokens)', toolList);
    note('tool list per tool (avg)', Math.round(toolList / tools.length));
    const largest = [...tools]
      .map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 5);
    note('five largest tools (chars)', largest.map((t) => `${t.name} ${t.chars}`).join(', '));

    const snap = await buildSnapshot(user.id, NOW, { lastUserText: 'who should I meet this week?' });
    note('snapshot (tokens)', (await countTokens({ text: snap.text })) - base);
    note('snapshot (chars)', snap.text.length);
    // 700 plus the Resume line (at most 520 characters), so the chat knows the student's background every turn
    expect(estimateTokens(snap.text)).toBeLessThanOrEqual(800);

    const ctx = () => makeCtx(user, { caller: 'llm' });
    const samples: [string, Record<string, unknown>][] = [
      ['get_today_brief', {}],
      ['list_pipeline', {}],
      ['search_people', { query: 'product' }],
      ['list_drafts', {}],
    ];
    for (const [name, input] of samples) {
      const spec = registry.get(name);
      if (!spec) continue;
      const env = await execute(name, input, ctx());
      const text = projectEnvelope(spec, env);
      note(`tool_result ${name} (tokens)`, (await countTokens({ text })) - base);
    }
    expect(system).toBeGreaterThan(500);
    expect(toolList).toBeGreaterThan(1000);
  }, 120_000);
});

describe.skipIf(!KEY)('live: cache reads across three turns on the demo account', () => {
  afterEach(() => setChatClientFactoryForTests(undefined));

  it('reads the prefix from the cache on every request after the first', async () => {
    writePrefs({ anthropicApiKey: KEY, llmDailyRequestCap: 5000, llmDailyTokenCap: 50_000_000 });
    setChatClientFactoryForTests((key) => makeChatClient(key, { maxRetries: 1 }));
    const store = new ChatStore();
    const engine = createChatEngine({ registry, execute, user: () => user, store, now: () => NOW });
    const c = await engine.startConversation({ temporary: false });
    const say = async (text: string) => {
      const events: TurnEvent[] = [];
      await engine.send(c.id, text, (e) => events.push(e));
      const err = events.find((e) => e.type === 'error');
      if (err && err.type === 'error') throw new Error(`${err.kind}: ${err.message}`);
    };
    await say('what is on today?');
    await say('I prefer morning calls, keep that in mind.');
    await say('who should I meet about PM internships this week?');
    const messages = await store.messages(c.id);
    const requests = messages.filter((m) => m.role === 'assistant' && m.usage);
    requests.forEach((m, i) => {
      const u = m.usage!;
      note(
        `request ${i + 1}`,
        `input ${u.input}, cache read ${u.cacheRead ?? 0}, cache write ${u.cacheWrite ?? 0}, output ${u.output}`,
      );
    });
    const snapshots = messages.filter((m) => m.meta === 'snapshot' || m.meta === 'memory');
    note(
      'context rows appended',
      snapshots.map((m) => `${m.meta} ${estimateTokens(JSON.stringify(m.content))}t`).join(', '),
    );
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const m of requests.slice(1)) expect(m.usage!.cacheRead ?? 0).toBeGreaterThan(0);
  }, 300_000);
});
