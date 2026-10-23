/**
 * What the chat learns after a turn in account mode (afterTurn.ts): memories through /memory/extract and goal offers
 * through /goals/infer, both after the reply and never in its way.
 */
import type { ProposedGoal, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { setOrbitApiBaseForTests, setOrbitApiFetchForTests } from '../../integrations/orbitApi';
import { clearPrefs } from '../../integrations/prefs';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import type { FakeOrbitApi } from '../../test/fakeOrbitApi';
import { createChatEngine } from '../agent';
import {
  lastTurns,
  mentionsPlans,
  offeredGoal,
  resetGoalOffersForTests,
  textTurns,
  trackMessage,
  worthRemembering,
} from '../agent/afterTurn';
import { buildSnapshot } from '../agent/snapshot';
import { ChatStore } from '../agent/store';
import { execute, registry } from '../registry';
import type { ChatEngine, ChatMessage, TurnEvent } from '../types';

const PRE_SEED: ProposedGoal = {
  kind: 'fundraising',
  title: 'Raise a pre-seed round',
  targets: { organizations: [], roles: ['angel investor'], geographies: ['Bay Area'], people: [] },
  criteria: { sector: 'climate' },
  successMetric: null,
  dueAt: null,
  isUpdateOf: null,
  quote: "I'm trying to raise a pre-seed round",
};

function msg(
  seq: number,
  role: ChatMessage['role'],
  content: unknown,
  meta?: ChatMessage['meta'],
): ChatMessage {
  return { id: `m${seq}`, conversationId: 'c', userId: 'u', seq, role, content, meta, createdAt: '' };
}

describe('turns for the server', () => {
  it('keeps what the student wrote and what Orbit answered, without tool rows, snapshots or notes', () => {
    const turns = textTurns([
      msg(1, 'user', [{ type: 'text', text: 'Hi, I want to find a mentor in fintech' }]),
      msg(2, 'system', [{ type: 'text', text: 'Today is ...' }], 'snapshot'),
      msg(3, 'assistant', [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 't1', name: 'find_people', input: {} },
      ]),
      msg(4, 'user', [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }]),
      msg(5, 'assistant', [{ type: 'text', text: 'Here are three people.' }]),
      msg(6, 'user', [{ type: 'text', text: '[Orbit] Approved conf_1' }], 'decision'),
      msg(7, 'user', [{ type: 'text', text: 'Thanks' }]),
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'Hi, I want to find a mentor in fintech' },
      { role: 'assistant', text: 'Let me look.\nHere are three people.' },
      { role: 'user', text: 'Thanks' },
    ]);
    expect(lastTurns(turns, 2)).toEqual(turns);
    expect(lastTurns(turns, 1)).toEqual([{ role: 'user', text: 'Thanks' }]);
  });

  it('stays within 6 turns and 8,000 characters', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: 'x'.repeat(3000),
    }));
    const t = lastTurns(many, 6);
    expect(t.length).toBeLessThanOrEqual(6);
    expect(t.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(8000);
  });

  it('knows the §1.6 plan words, and writes a Yes the router reads', () => {
    for (const s of [
      'We want to raise a seed round',
      "I'm applying to PM internships",
      'looking for a co-founder',
      'need customers for my app',
      'want to collaborate on a paper',
    ])
      expect(mentionsPlans(s)).toBe(true);
    expect(mentionsPlans('What is on my calendar today?')).toBe(false);
    expect(trackMessage(PRE_SEED)).toBe('Track a goal: Raise a pre-seed round');
  });

  it('spends a memory read only on a message that states something', () => {
    for (const s of [
      'I prefer morning calls, never on Fridays',
      "Don't contact Maya Chen again, please",
      'Maya offered to refer me in March, which was kind',
    ])
      expect(worthRemembering(s), s).toBe(true);
    for (const s of [
      'ok thanks',
      'Who should I email about PM roles today?',
      'Find PMs in New York for me please',
      'Draft a thank-you to Lena from this morning',
    ])
      expect(worthRemembering(s), s).toBe(false);
    expect(trackMessage({ ...PRE_SEED, kind: 'community', title: 'Grow the robotics group' })).toBe(
      'Track a goal: Grow the robotics group (community)',
    );
  });
});

describe('after a turn, in account mode', () => {
  let api: FakeOrbitApi;
  let user: User;
  let store: ChatStore;
  let engine: ChatEngine;

  beforeEach(async () => {
    await wipeDatabase();
    await clearPrefs();
    resetGoalOffersForTests();
    ({ api, user } = await signInToFakeApi());
    store = new ChatStore();
    engine = createChatEngine({ registry, execute, user: () => user, store });
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  const send = async (conversationId: string, text: string, events: TurnEvent[] = []) => {
    await engine.send(conversationId, text, (e) => events.push(e));
    return events;
  };
  const calls = (route: string) => api.calls.filter((c) => c.route === route);

  it('sends the last turns to /memory/extract, and nothing for a short message or a temporary chat', async () => {
    api.state.extractable = [{ text: 'Prefers morning calls', kind: 'preference' }];
    const c = await engine.startConversation({ temporary: false });
    await send(c.id, 'I prefer morning calls, never on Fridays');
    await vi.waitFor(() => expect(calls('/memory/extract')).toHaveLength(1));
    const turns = calls('/memory/extract')[0]!.body.turns as { role: string; text: string }[];
    expect(turns[0]).toEqual({ role: 'user', text: 'I prefer morning calls, never on Fridays' });
    expect(turns.slice(1).every((t) => t.role === 'assistant')).toBe(true);
    expect(api.state.memories.map((m) => m.text)).toEqual(['Prefers morning calls']);
    await send(c.id, 'ok thanks');
    // a question long enough to count still states nothing: no read
    await send(c.id, 'Who should I email about PM roles today, any ideas?');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls('/memory/extract')).toHaveLength(1);
    await send(c.id, 'And I can only meet after 4pm on weekdays');
    await vi.waitFor(() => expect(calls('/memory/extract')).toHaveLength(2));
    // the last two student turns and the replies after them
    const second = calls('/memory/extract')[1]!.body.turns as { role: string; text: string }[];
    expect(second.filter((t) => t.role === 'user').map((t) => t.text)).toEqual([
      'Who should I email about PM roles today, any ideas?',
      'And I can only meet after 4pm on weekdays',
    ]);
    const temp = await engine.startConversation({ temporary: true });
    await send(temp.id, 'I prefer morning calls, never on Fridays');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls('/memory/extract')).toHaveLength(2);
    // no plan words: no goal inference
    expect(calls('/goals/infer')).toHaveLength(0);
  });

  it('never holds up the reply, and a failing server changes nothing in the chat', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setOrbitApiFetchForTests(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/memory/extract')) {
        await gate;
        return new Response(JSON.stringify({ error: { code: 'failed', message: 'down' } }), { status: 500 });
      }
      return api.fetch(input, init);
    });
    const c = await engine.startConversation({ temporary: false });
    const events = await send(c.id, 'I prefer morning calls, never on Fridays');
    // the turn is over while the extraction is still waiting
    expect(events.map((e) => e.type)).toContain('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('offers a goal the student talked about under the reply, then set_goal tracks it on yes', async () => {
    api.state.proposals = [PRE_SEED];
    const c = await engine.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    await send(c.id, "I'm trying to raise a pre-seed round for my climate startup", events);
    const offered = (e: TurnEvent) => e.type === 'tool_result' && e.envelope.kind === 'choices';
    await vi.waitFor(() => expect(events.some(offered)).toBe(true));
    expect(calls('/goals/infer')[0]!.body.turns).toEqual([
      { role: 'user', text: "I'm trying to raise a pre-seed round for my climate startup" },
      ...(calls('/goals/infer')[0]!.body.turns as unknown[]).slice(1),
    ]);
    const text = events
      .filter((e): e is Extract<TurnEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toContain('Want me to track this as a goal? Fundraising: Raise a pre-seed round.');
    const choices = events.find(offered) as Extract<TurnEvent, { type: 'tool_result' }>;
    expect(choices.envelope).toMatchObject({
      kind: 'choices',
      data: {
        options: [
          { label: 'Yes, track it', message: 'Track a goal: Raise a pre-seed round' },
          { label: 'Not now', message: 'Not now, thanks.' },
        ],
      },
    });
    // nothing was saved; the model hears about the offer in the next snapshot
    expect(api.state.goals).toEqual([]);
    expect(offeredGoal(user.id)).toEqual(PRE_SEED);
    const snap = await buildSnapshot(user.id, new Date());
    expect(snap.text).toContain('Goal offered under your last reply ("Want me to track this as a goal?")');
    expect(snap.text).toContain('"title":"Raise a pre-seed round"');
    expect(snap.text).toContain(`evidence ${JSON.stringify(PRE_SEED.quote)}`);
    // the stored history the model replays has no extra rows
    const stored = await store.messages(c.id);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);

    // Yes: the router reads the choice as set_goal
    api.state.proposals = [];
    await send(c.id, 'Track a goal: Raise a pre-seed round');
    await vi.waitFor(() =>
      expect(api.state.goals.map((g) => [g.kind, g.title])).toEqual([
        ['fundraising', 'Raise a pre-seed round'],
      ]),
    );
    // the offer had its turn
    await vi.waitFor(() => expect(offeredGoal(user.id)).toBeUndefined());
  });

  it('offers nothing for a goal that is already tracked', async () => {
    await db.userGoals.put({
      id: crypto.randomUUID(),
      userId: user.id,
      kind: 'fundraising',
      title: 'Raise a pre-seed round',
      targets: { organizations: [], roles: [], geographies: [], people: [] },
      criteria: {},
      priority: 2,
      status: 'active',
      source: 'user',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    });
    api.state.proposals = [PRE_SEED];
    const c = await engine.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    await send(c.id, "I'm trying to raise a pre-seed round for my climate startup", events);
    await vi.waitFor(() => expect(calls('/goals/infer')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === 'tool_result' && e.envelope.kind === 'choices')).toBe(false);
    expect(offeredGoal(user.id)).toBeUndefined();
  });
});

describe('after a turn, in local mode', () => {
  beforeEach(async () => {
    await wipeDatabase();
    await clearPrefs();
    setOrbitApiBaseForTests(null);
  });
  afterEach(() => setOrbitApiBaseForTests(undefined));

  it('asks no server', async () => {
    const user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex', school: 'Cornell' });
    const fetchSpy = vi.fn();
    setOrbitApiFetchForTests(fetchSpy as unknown as typeof fetch);
    const engine = createChatEngine({ registry, execute, user: () => user, store: new ChatStore() });
    const c = await engine.startConversation({ temporary: false });
    await engine.send(c.id, "I'm trying to raise a pre-seed round for my climate startup", () => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).not.toHaveBeenCalled();
    setOrbitApiFetchForTests(undefined);
  });
});
