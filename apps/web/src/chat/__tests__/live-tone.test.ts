/**
 * Live tone: the REAL engine and registry against the REAL Claude API, checking that the chat talks like a friend.
 * Skipped unless ANTHROPIC_API_KEY is set, so CI never calls the API. It needs the offer_choices and show_setup
 * tools in the registry. Each scenario seeds an account state (the demo, or an empty account), says one thing, and
 * checks the shape of the reply, never exact wording. A compact transcript of each scenario is printed for review.
 * The key only lives in the in-memory prefs of this run and is never printed.
 *
 * Run: ANTHROPIC_API_KEY=... NODE_USE_ENV_PROXY=1 pnpm --filter @orbit/web exec vitest run src/chat/__tests__/live-tone
 */
import type { User } from '@orbit/core';
import { afterAll, describe, expect, it } from 'vitest';
import { wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { loadDemo } from '../../engine/demo';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { createChatEngine } from '../agent';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { execute, registry } from '../registry';
import type { ChatEngine, ResultEnvelope, TurnEvent } from '../types';
import { NOW } from './helpers';

const KEY = process.env.ANTHROPIC_API_KEY;

interface Said {
  events: TurnEvent[];
  tools: string[];
  envs: { tool: string; env: ResultEnvelope }[];
  text: string;
  error?: string;
}

let user: User;
let engine: ChatEngine;

async function setup(state: 'demo' | 'empty') {
  await clearPrefs();
  if (state === 'demo') user = await loadDemo({ reset: true, now: NOW });
  else {
    await wipeDatabase();
    user = await createLocalUser({
      fullName: 'Alex Kim',
      firstName: 'Alex',
      school: 'Cornell',
      graduationYear: 2027,
      timezone: 'America/New_York',
      onboardingCompletedAt: NOW.toISOString(),
    });
  }
  writePrefs({ anthropicApiKey: KEY, llmDailyRequestCap: 1000, llmDailyTokenCap: 50_000_000 });
  setChatClientFactoryForTests((key) => makeChatClient(key, { maxRetries: 2 }));
  engine = createChatEngine({ registry, execute, user: () => user, now: () => NOW });
}

async function say(text: string): Promise<Said> {
  const id = (await engine.startConversation({ temporary: false })).id;
  expect(engine.mode(), 'still talking to Claude').toBe('llm');
  const events: TurnEvent[] = [];
  await engine.send(id, text, (e) => events.push(e));
  const names = new Map<string, string>();
  for (const e of events) if (e.type === 'tool_start') names.set(e.toolUseId, e.toolName);
  const err = events.find((e) => e.type === 'error') as Extract<TurnEvent, { type: 'error' }> | undefined;
  return {
    events,
    tools: [...names.values()],
    envs: events.flatMap((e) =>
      e.type === 'tool_result' ? [{ tool: names.get(e.toolUseId) ?? '?', env: e.envelope }] : [],
    ),
    text: events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join(''),
    error: err ? `${err.kind}: ${err.message}` : undefined,
  };
}

/** A compact transcript for review: the student's line, each tool with its result kind, the assistant's words. */
function show(id: string, student: string, t: Said) {
  const tools = t.envs.map((e) => `${e.tool}:${e.env.kind}`).join(', ') || 'none';
  console.log(
    `\n[live-tone ${id}] student: ${student}\n  tools: ${tools}\n  assistant: ${t.text.trim() || '(no prose)'}`,
  );
}

const WRITES = new Set([...registry.values()].filter((t) => t.kind !== 'read').map((t) => t.name));

/** The shape of a friend's reply. */
function expectConversational(t: Said) {
  expect(t.error, t.error).toBeUndefined();
  expect(t.events.at(-1)?.type).toBe('done');
  const words = t.text.trim().split(/\s+/).filter(Boolean).length;
  expect(words, t.text).toBeLessThanOrEqual(70);
  expect((t.text.match(/\?/g) ?? []).length, t.text).toBeLessThanOrEqual(1);
  expect(t.text, 'heading').not.toMatch(/^\s*#{1,6}\s/m);
  expect(t.text, 'list').not.toMatch(/^\s*(\d+[.)]|[-*•])\s/m);
  expect(t.text, 'bold').not.toMatch(/\*\*|__/);
  expect(t.text, 'dash').not.toMatch(/[—–]/);
  expect(t.text, 'exclamation').not.toMatch(/!/);
}

const usedAny = (t: Said, names: string[]) => t.tools.some((n) => names.includes(n));

describe.skipIf(!KEY)('live tone: Claude talks like a friend', () => {
  afterAll(async () => {
    setChatClientFactoryForTests(undefined);
    await clearPrefs();
  });

  describe('empty account', () => {
    it('(a) "hey": a greeting and one easy step, with choices or a setup widget', async () => {
      await setup('empty');
      const t = await say('hey');
      show('a', 'hey', t);
      expectConversational(t);
      expect(usedAny(t, ['offer_choices', 'show_setup']), t.tools.join(',')).toBe(true);
      expect(t.tools.filter((n) => WRITES.has(n))).toEqual([]);
    }, 180_000);

    it('(b) "what can you do?": short, with choices or a setup widget', async () => {
      await setup('empty');
      const t = await say('what can you do?');
      show('b', 'what can you do?', t);
      expectConversational(t);
      expect(usedAny(t, ['offer_choices', 'show_setup']), t.tools.join(',')).toBe(true);
    }, 180_000);

    it('(f) "I want to connect my LinkedIn": the drop zone, not a list of steps', async () => {
      await setup('empty');
      const t = await say('I want to connect my LinkedIn');
      show('f', 'I want to connect my LinkedIn', t);
      expectConversational(t);
      expect(t.tools, t.tools.join(',')).toContain('show_setup');
      const widget = t.envs.find((e) => e.tool === 'show_setup')?.env;
      expect(widget?.kind).toBe('setup');
      expect((widget?.data as { what?: string } | undefined)?.what).toBe('linkedin');
    }, 180_000);
  });

  describe('demo account', () => {
    it('(c) "hey": a greeting and the one useful thing, nothing changed', async () => {
      await setup('demo');
      const t = await say('hey');
      show('c', 'hey', t);
      expectConversational(t);
      expect(t.tools.filter((n) => WRITES.has(n))).toEqual([]);
    }, 180_000);

    it('(d) "help me get started": one next step, nothing changed', async () => {
      await setup('demo');
      const t = await say('help me get started');
      show('d', 'help me get started', t);
      expectConversational(t);
      expect(t.tools.filter((n) => WRITES.has(n))).toEqual([]);
    }, 180_000);

    it('(e) "who should I message today?": shows the real thing', async () => {
      await setup('demo');
      const t = await say('who should I message today?');
      show('e', 'who should I message today?', t);
      expectConversational(t);
      expect(
        usedAny(t, ['get_today_brief', 'list_pipeline', 'list_drafts', 'list_recommendations']),
        t.tools.join(','),
      ).toBe(true);
    }, 180_000);
  });
});
