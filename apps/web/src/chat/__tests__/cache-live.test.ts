import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { MODEL } from '../../integrations/anthropic';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { runTurn } from '../agent/loop';
import { ChatStore, unpairedToolUses } from '../agent/store';
import { makeStubRegistry } from '../test/stubRegistry';
import type { TurnEvent } from '../types';

/**
 * Opt-in live check against the real API: two turns of one conversation, with the preserved-thinking prefix check
 * set to `error` so any edit to the replayed history fails the test, and the second turn must read from the prompt
 * cache. Runs only with ANTHROPIC_API_KEY set; it costs real tokens.
 */
const KEY = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!KEY)('live: prompt cache and preserved thinking', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    await clearPrefs();
    writePrefs({ anthropicApiKey: KEY });
    user = await createLocalUser({
      fullName: 'Live Test',
      firstName: 'Live',
      school: 'Cornell',
      timezone: 'UTC',
    });
    setChatClientFactoryForTests((key) => makeChatClient(key, { maxRetries: 1 }));
  });
  afterEach(() => setChatClientFactoryForTests(undefined));

  it('reads the cached prefix on the second turn and replays thinking blocks without a binding error', async () => {
    const stub = makeStubRegistry();
    const store = new ChatStore();
    const conversation = await store.createConversation({ userId: user.id, model: MODEL, temporary: false });
    const client = makeChatClient(KEY!, { maxRetries: 1 });
    const deps = {
      client,
      registry: stub.registry,
      execute: stub.execute,
      store,
      user,
      conversation,
      prefixMismatch: 'error' as const,
    };
    const events: TurnEvent[] = [];
    const say = (text: string) => runTurn(deps, [{ type: 'text', text }], (e) => events.push(e));
    await say('What is on today? Use the brief tool, then answer in one sentence.');
    await say('Thanks. Now say "ok" and nothing else.');
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toEqual([]);
    const rows = await store.messages(conversation.id);
    expect(unpairedToolUses(rows)).toEqual([]);
    const assistants = rows.filter((r) => r.role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(assistants.at(-1)!.usage?.cacheRead ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
