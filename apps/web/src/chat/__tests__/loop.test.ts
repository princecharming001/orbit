import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { localRemember } from '../../engine/memoryLocal';
import { MODEL } from '../../integrations/anthropic';
import { clearPrefs, readPrefs, todaysLlmUsage, writePrefs } from '../../integrations/prefs';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { CHAT_BETAS, runTurn, type TurnDeps } from '../agent/loop';
import { ChatStore, unpairedToolUses } from '../agent/store';
import { type FakeAnthropic, messageRequests, type ScriptTurn, scriptedFetch } from '../test/fakeAnthropic';
import { makeStubRegistry, type StubRegistry } from '../test/stubRegistry';
import { offerChoices } from '../tools/widgets';
import type { ChatConversation, ToolSpec, TurnEvent } from '../types';
import { type AssistantTurn, hydrate } from '../ui/threadStore';

let user: User;
let store: ChatStore;
let stub: StubRegistry;
let fake: FakeAnthropic;
let conversation: ChatConversation;

function deps(extra: Partial<TurnDeps> = {}): TurnDeps {
  const client = makeChatClient('sk-ant-test', { fetch: fake.fetch, maxRetries: 0 });
  return {
    client,
    registry: stub.registry,
    execute: stub.execute,
    store,
    user,
    conversation,
    prefixMismatch: 'error',
    ...extra,
  };
}

async function turn(text: string, script: ScriptTurn[], extra: Partial<TurnDeps> = {}, signal?: AbortSignal) {
  fake.push(...script);
  const events: TurnEvent[] = [];
  await runTurn(deps(extra), [{ type: 'text', text }], (e) => events.push(e), signal);
  return events;
}

const text = (events: TurnEvent[]) =>
  events
    .filter((e): e is Extract<TurnEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
const kinds = (events: TurnEvent[]) => events.map((e) => e.type);
const errorOf = (events: TurnEvent[]) =>
  events.find((e) => e.type === 'error') as Extract<TurnEvent, { type: 'error' }>;

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  writePrefs({ anthropicApiKey: 'sk-ant-test' });
  user = await createLocalUser({
    fullName: 'Sam Lee',
    firstName: 'Sam',
    school: 'Cornell',
    timezone: 'America/New_York',
  });
  store = new ChatStore();
  stub = makeStubRegistry();
  fake = scriptedFetch();
  setChatClientFactoryForTests((key) => makeChatClient(key, { fetch: fake.fetch, maxRetries: 0 }));
  conversation = await store.createConversation({ userId: user.id, model: MODEL, temporary: false });
});
afterEach(() => setChatClientFactoryForTests(undefined));

describe('request shape', () => {
  it('sends the beta headers, fallbacks, compaction, caching, adaptive thinking with updates and strict eager tools', async () => {
    const events = await turn('hi', [{ text: 'Hello Sam.' }]);
    expect(text(events)).toBe('Hello Sam.');
    expect(kinds(events).at(-1)).toBe('done');
    const [req] = messageRequests(fake);
    expect(req).toBeTruthy();
    const betas = req!.headers['anthropic-beta']!.split(',').map((s) => s.trim());
    for (const b of CHAT_BETAS) expect(betas).toContain(b);
    const body = req!.body;
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(16_000);
    expect(body.stream).toBe(true);
    expect(body.fallbacks).toEqual([{ model: 'claude-opus-5' }]);
    expect(body.context_management.edits[0].type).toBe('compact_20260112');
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    // the frozen block carries the breakpoint and is the same for everyone; the student's playbook block (plan 28)
    // and the conversation's tag rule follow, neither with a breakpoint of its own
    expect(body.system).toHaveLength(3);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.system[1].text).toMatch(/^Playbook\. What a sharp friend/);
    expect(body.system[1].text).toMatch(/## Networking etiquette/);
    expect(body.system[2].cache_control).toBeUndefined();
    expect(body.thinking).toEqual({
      type: 'adaptive',
      display: 'updates',
      block_binding: { prefix_mismatch_behavior: 'error' },
    });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.tool_choice).toBeUndefined();
    expect(body.max_iterations).toBeUndefined();
    // the client tools sorted, then Claude's own web search, a few searches a request
    const web = body.tools.at(-1);
    expect(web).toEqual({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
      cache_control: { type: 'ephemeral' },
    });
    const client = body.tools.slice(0, -1);
    const names = client.map((t: { name: string }) => t.name);
    expect(names).toEqual([...names].sort());
    // the imports take text or base64 like the real registry, so every tool has a JSON Schema form and is offered
    expect(names).toEqual([...stub.registry.keys()].sort());
    // one cache breakpoint after the last tool, so every conversation shares the cached tool list
    expect(client.some((t: { cache_control?: unknown }) => t.cache_control)).toBe(false);
    for (const t of client) {
      // strict on the risky tools (the API allows twenty strict tools); the rest are validated by Zod before they run
      expect(t.strict).toBe(stub.registry.get(t.name)!.kind === 'risky');
      expect(JSON.stringify(t.input_schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|\$schema)"/);
      expect(t.eager_input_streaming).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.run).toBeUndefined();
    }
    // the system block is frozen: no date, no name, no counts; the volatile snapshot is a system message instead
    expect(body.system[0].text).not.toMatch(/Sam|2026|Today is/);
    expect(body.system[0].text).not.toMatch(/untrusted_[0-9a-f]{16}/);
    expect(body.system[2].text).toMatch(/untrusted_[0-9a-f]{16}/);
    expect(body.system[1].text).not.toMatch(/untrusted_[0-9a-f]{16}/);
    expect(body.system[0].text).toMatch(/needs_confirmation/);
    expect(body.system[0].text).toMatch(/[Nn]ever claim an action happened/);
    expect(body.system[0].text).toMatch(/Voice:/);
    expect(body.system[0].text).toMatch(/offer_choices/);
    expect(body.system[0].text).toMatch(/show_setup/);
    expect(body.system[0].text).not.toMatch(/[—–!]/);
    const sys = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(sys.content[0].text).toMatch(/^Today is \w{3} \d{4}-\d{2}-\d{2}, \d{2}:\d{2}, America\/New_York/);
    expect(sys.content[0].text).toContain('Sam Lee');
    // the volatile context says where setup stands, in one line
    expect(sys.content[0].text).toMatch(/^Setup: people \d+, /m);
  });

  it("uses 'low' effort in quick mode", async () => {
    await turn('hi', [{ text: 'ok' }], { quick: true });
    expect(messageRequests(fake)[0]!.body.output_config).toEqual({ effort: 'low' });
  });
});

describe('never a reply without words', () => {
  it('asks once more, with tools off, when a turn ends on cards alone, and streams that answer', async () => {
    const events = await turn('how many replied', [
      { toolCalls: [{ id: 'toolu_q', name: 'list_pipeline', input: {} }] },
      { stopReason: 'end_turn' },
      { text: 'Two replied and three are still waiting.' },
    ]);
    expect(text(events)).toBe('Two replied and three are still waiting.');
    expect(kinds(events).at(-1)).toBe('done');
    const reqs = messageRequests(fake);
    const last = reqs.at(-1)!.body;
    expect(last.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(last.messages.at(-1))).toMatch(/Your reply had no answer in words/);
    // the nudge and the answer are stored, so the next turn replays a valid history
    const rows = await store.history(conversation.id);
    expect(rows.at(-1)?.role).toBe('assistant');
    expect(JSON.stringify(rows.at(-2))).toMatch(/Your reply had no answer in words/);
  });

  it('does not ask again when the turn already said something', async () => {
    await turn('hi', [{ text: 'Hello Sam.' }]);
    expect(messageRequests(fake)).toHaveLength(1);
  });
});

describe('tools', () => {
  it('runs parallel tool calls and returns every result in one user message, in the model order', async () => {
    const events = await turn('what is on and who went quiet', [
      {
        thinking: ['Checking the brief and the pipeline.'],
        text: 'Let me look.',
        toolCalls: [
          { id: 'toolu_a', name: 'get_today_brief', input: {} },
          { id: 'toolu_b', name: 'list_pipeline', input: { stage: 'no_response' } },
        ],
      },
      { text: 'One card today and nobody went quiet.' },
    ]);
    expect(kinds(events)).toEqual([
      'progress',
      'text',
      'text',
      'text',
      'tool_start',
      'tool_start',
      'tool_result',
      'tool_result',
      'text',
      'text',
      'text',
      'done',
    ]);
    expect(events[0]).toEqual({ type: 'progress', text: 'Checking the brief and the pipeline.' });
    expect(events[4]).toEqual({
      type: 'tool_start',
      toolUseId: 'toolu_a',
      toolName: 'get_today_brief',
      progress: 'Looking at your day',
    });
    const results = events.filter((e) => e.type === 'tool_result') as Extract<
      TurnEvent,
      { type: 'tool_result' }
    >[];
    expect(results.map((r) => r.toolUseId)).toEqual(['toolu_a', 'toolu_b']);
    expect(results[0]!.envelope.kind).toBe('brief');
    expect(stub.calls.map((c) => c.name)).toEqual(['get_today_brief', 'list_pipeline']);
    expect(stub.calls[1]!.input).toEqual({ stage: 'no_response' });
    expect(stub.calls[0]!.ctx).toMatchObject({
      caller: 'llm',
      toolUseId: 'toolu_a',
      conversationId: conversation.id,
    });

    const reqs = messageRequests(fake);
    expect(reqs).toHaveLength(2);
    const last = reqs[1]!.body.messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.content.map((b: { type: string; tool_use_id: string }) => [b.type, b.tool_use_id])).toEqual([
      ['tool_result', 'toolu_a'],
      ['tool_result', 'toolu_b'],
    ]);
    // the model reads the projection, not the full data
    expect(JSON.parse(last.content[0].content)).toEqual({
      kind: 'brief',
      summary: 'One card today: thank Priya Patel.',
      data: { cards: 1 },
      href: '/inbox',
    });
    expect(last.content[0].is_error).toBeUndefined();
    // thinking blocks go back unchanged
    const assistant = reqs[1]!.body.messages.at(-2);
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0].type).toBe('thinking');
    expect(assistant.content[0].signature).toMatch(/^sig_/);

    // the stored history mirrors the runner's own messages, block for block
    const rows = await store.messages(conversation.id);
    expect(rows.map((r) => [r.role, r.meta ?? ''])).toEqual([
      ['user', ''],
      ['system', 'snapshot'],
      ['assistant', ''],
      ['user', ''],
      ['assistant', ''],
    ]);
    expect(JSON.stringify(rows[3]!.content)).toBe(JSON.stringify(last.content));
    expect(unpairedToolUses(rows)).toEqual([]);
    expect(rows[2]!.model).toBe(MODEL);
    expect(rows[2]!.usage).toMatchObject({ input: 1000, output: 50 });
    const actions = await store.actions(conversation.id);
    expect(actions.map((a) => [a.id, a.status])).toEqual([
      ['toolu_a', 'done'],
      ['toolu_b', 'done'],
    ]);
    expect(actions[0]!.messageId).toBe(rows[2]!.id);
    expect(actions[0]!.envelope?.data).toEqual({
      cards: [{ id: 's_1', kind: 'thank_you', person: 'Priya Patel' }],
    });
  });

  it('keeps the cached prefix byte-identical across turns and appends the snapshot only when it changed', async () => {
    await turn('first', [
      { text: 'Looking.', toolCalls: [{ id: 'toolu_1', name: 'list_drafts', input: { list: 'to_send' } }] },
      { thinking: ['Nothing waiting.'], text: 'No drafts waiting.' },
    ]);
    await turn('second', [{ text: 'Still nothing.' }]);
    const reqs = messageRequests(fake);
    expect(reqs).toHaveLength(3);
    const [r1, r2, r3] = reqs as [(typeof reqs)[0], (typeof reqs)[0], (typeof reqs)[0]];
    for (const k of [
      'system',
      'tools',
      'model',
      'thinking',
      'output_config',
      'fallbacks',
      'context_management',
    ])
      expect(JSON.stringify(r3.body[k])).toBe(JSON.stringify(r1.body[k]));
    // turn 2 replays everything turn 1 sent, then the final assistant message of turn 1, then the new user turn
    const n = r2.body.messages.length;
    expect(JSON.stringify(r3.body.messages.slice(0, n))).toBe(JSON.stringify(r2.body.messages));
    const tail = r3.body.messages.slice(n);
    expect(tail.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user']);
    expect(tail[0].content.map((b: { type: string }) => b.type)).toEqual(['thinking', 'text']);
    expect(tail[0].content[1].text).toBe('No drafts waiting.');
    expect(tail[1].content).toEqual([{ type: 'text', text: 'second' }]);
    // one snapshot in the whole history: the second turn's was identical but for the clock
    expect(r3.body.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1);
  });

  it('appends only the Remembered line when the memories changed and nothing else did', async () => {
    await localRemember(user.id, { text: 'Prefers morning calls', kind: 'preference' });
    await turn('what times work for calls?', [{ text: 'Mornings.' }]);
    await localRemember(user.id, { text: 'Targeting PM internships in New York', kind: 'goal_detail' });
    await turn('who should I meet for PM internships?', [{ text: 'A few people.' }]);
    // the same memories, in whatever order they rank for this message: nothing new to say
    await turn('calls or internships first?', [{ text: 'Calls.' }]);
    const rows = await store.messages(conversation.id);
    expect(rows.map((r) => [r.role, r.meta ?? ''])).toEqual([
      ['user', ''],
      ['system', 'snapshot'],
      ['assistant', ''],
      ['user', ''],
      ['system', 'memory'],
      ['assistant', ''],
      ['user', ''],
      ['assistant', ''],
    ]);
    const textOf = (row: { content: unknown }) => (row.content as { text: string }[])[0]!.text;
    // the snapshot carries the Remembered line last; the memory row is that line alone, in id order
    expect(textOf(rows[1]!)).toMatch(/\nRemembered \(ids\): mem_\S+ Prefers morning calls\.$/);
    expect(textOf(rows[4]!)).toMatch(/^Remembered \(ids\): mem_\S+ [^;]+; mem_\S+ [^;]+\.$/);
    expect(textOf(rows[4]!)).not.toMatch(/Today is/);
    const ids = textOf(rows[4]!).match(/mem_\S+/g)!;
    expect(ids).toEqual([...ids].sort());
    // every request replays the one before it unchanged
    const reqs = messageRequests(fake);
    expect(reqs).toHaveLength(3);
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1]!.body.messages;
      expect(JSON.stringify(reqs[i]!.body.messages.slice(0, prev.length))).toBe(JSON.stringify(prev));
    }
    expect(reqs[1]!.body.messages.slice(-3).map((m: { role: string }) => m.role)).toEqual([
      'assistant',
      'user',
      'system',
    ]);
    expect(reqs[2]!.body.messages.slice(-2).map((m: { role: string }) => m.role)).toEqual([
      'assistant',
      'user',
    ]);
  });

  it('sends a fresh snapshot after a compaction block, which stands in for the earlier one', async () => {
    await turn('long chat', [{ compaction: { content: 'Summary so far.' }, text: 'Continuing.' }]);
    await turn('and now?', [{ text: 'Still here.' }]);
    const rows = await store.messages(conversation.id);
    expect(rows.map((r) => [r.role, r.meta ?? ''])).toEqual([
      ['user', ''],
      ['system', 'snapshot'],
      ['assistant', ''],
      ['user', ''],
      ['system', 'snapshot'],
      ['assistant', ''],
    ]);
    expect(unpairedToolUses(rows)).toEqual([]);
  });

  it('answers a tool that throws with an is_error result and an error envelope, without the raw error in the copy', async () => {
    const events = await turn('explode', [
      { toolCalls: [{ id: 'toolu_x', name: 'explode', input: { why: 'test' } }] },
      { text: 'That tool failed.' },
    ]);
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      TurnEvent,
      { type: 'tool_result' }
    >;
    expect(result.envelope.kind).toBe('error');
    expect(result.envelope.summary).toBe('The tool could not finish.');
    const last = messageRequests(fake)[1]!.body.messages.at(-1);
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true });
    expect(JSON.parse(last.content[0].content).kind).toBe('error');
    const rows = await store.messages(conversation.id);
    expect(JSON.stringify(rows[3]!.content)).toBe(JSON.stringify(last.content));
    expect((await store.getAction('toolu_x'))?.status).toBe('error');
    expect(kinds(events).at(-1)).toBe('done');
  });

  it('never runs a tool whose input failed validation and mirrors the runner is_error result', async () => {
    // truncated JSON parses as {} and fails the schema (personId and stage are required)
    await turn('move', [
      { toolCalls: [{ id: 'toolu_bad', name: 'move_pipeline_stage', rawJson: '{"personId": "p1", "sta' }] },
      { text: 'I could not do that.' },
    ]);
    expect(stub.calls).toHaveLength(0);
    const last = messageRequests(fake)[1]!.body.messages.at(-1);
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true });
    const rows = await store.messages(conversation.id);
    expect(JSON.stringify(rows[3]!.content)).toBe(JSON.stringify(last.content));
    expect(unpairedToolUses(rows)).toEqual([]);
  });

  it('records a pending confirmation for a risky tool and stops the turn without claiming the action happened', async () => {
    const events = await turn('send it', [
      { toolCalls: [{ id: 'toolu_s', name: 'send_draft', input: { draftId: 'out_1' } }] },
      { text: 'Approve to send it.' },
    ]);
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      TurnEvent,
      { type: 'tool_result' }
    >;
    expect(result.envelope.kind).toBe('needs_confirmation');
    expect(result.envelope.confirmationId).toBe('conf_1');
    const pending = await store.getAction('conf_1');
    expect(pending).toMatchObject({ status: 'pending', toolName: 'send_draft', input: { draftId: 'out_1' } });
    expect(pending?.expiresAt).toBeTruthy();
  });
});

describe("Claude's web search", () => {
  it('streams the query and the sources, stores the blocks as they came, and a reopened chat shows them', async () => {
    const results = [
      { title: 'Stripe opens 2027 internships', url: 'https://stripe.com/jobs/students' },
      { title: 'Stripe intern timeline', url: 'https://www.example.com/stripe-timeline' },
    ];
    const events = await turn('when do stripe internships open', [
      {
        webSearch: [{ id: 'srvtoolu_1', query: 'Stripe 2027 internship applications open', results }],
        text: 'Stripe opened its 2027 internships in August.',
      },
    ]);
    expect(text(events)).toBe('Stripe opened its 2027 internships in August.');
    expect(events).toContainEqual({
      type: 'web_search',
      id: 'srvtoolu_1',
      query: 'Stripe 2027 internship applications open',
    });
    expect(events).toContainEqual({ type: 'web_results', id: 'srvtoolu_1', sources: results, failed: false });
    expect(kinds(events).at(-1)).toBe('done');
    const rows = await store.messages(conversation.id);
    const assistant = rows.find((r) => r.role === 'assistant')!;
    const types = (assistant.content as { type: string }[]).map((b) => b.type);
    expect(types).toEqual(expect.arrayContaining(['server_tool_use', 'web_search_tool_result', 'text']));
    const turns = hydrate(rows, []);
    const answer = turns.find((t) => t.role === 'assistant') as AssistantTurn;
    expect(answer.blocks.find((b) => b.type === 'web')).toMatchObject({
      query: 'Stripe 2027 internship applications open',
      sources: results,
      status: 'done',
    });
  });

  it('says so when a search fails, and carries on a turn the search paused', async () => {
    const events = await turn('any news on ramp', [
      {
        webSearch: [{ id: 'srvtoolu_2', query: 'Ramp news', error: 'unavailable' }],
        stopReason: 'pause_turn',
      },
      { text: 'I could not reach the web just now.' },
    ]);
    expect(events).toContainEqual({ type: 'web_results', id: 'srvtoolu_2', sources: [], failed: true });
    expect(text(events)).toBe('I could not reach the web just now.');
    expect(kinds(events).at(-1)).toBe('done');
    // the paused answer went back as it came, and the turn finished in a second request
    const reqs = messageRequests(fake);
    expect(reqs).toHaveLength(2);
    const sent = reqs[1]!.body.messages.at(-1);
    expect(sent.role).toBe('assistant');
    expect(sent.content.map((b: { type: string }) => b.type)).toContain('server_tool_use');
  });
});

describe('stop reasons', () => {
  it('runs no tool on max_tokens with a tool_use and leaves the stored history continuable', async () => {
    const events = await turn('do a lot', [
      {
        text: 'Working',
        toolCalls: [{ id: 'toolu_t', name: 'add_note', input: { text: 'long' } }],
        stopReason: 'max_tokens',
      },
    ]);
    expect(stub.calls).toHaveLength(0);
    const err = errorOf(events);
    expect(err.kind).toBe('other');
    expect(err.message).toMatch(/ran out of room/);
    expect(messageRequests(fake)).toHaveLength(1);
    const rows = await store.messages(conversation.id);
    expect(rows.map((r) => [r.role, r.meta ?? ''])).toEqual([
      ['user', ''],
      ['system', 'snapshot'],
      ['system', 'error'],
    ]);
    expect(unpairedToolUses(rows)).toEqual([]);
    // the next turn still works and does not replay the orphaned snapshot before the new user message
    const again = await turn('try again', [{ text: 'Done now.' }]);
    expect(kinds(again).at(-1)).toBe('done');
    const req = messageRequests(fake)[1]!.body.messages;
    expect(req.map((m: { role: string }) => m.role)).toEqual(['user', 'user', 'system']);
    expect(req[1].content).toEqual([{ type: 'text', text: 'try again' }]);
  });

  it('returns truncated text as the final message on max_tokens without a tool_use', async () => {
    const events = await turn('write', [{ text: 'A long answer that was cut', stopReason: 'max_tokens' }]);
    const done = events.at(-1) as Extract<TurnEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.stopReason).toBe('max_tokens');
    expect(text(events)).toBe('A long answer that was cut');
  });

  it('runs no tool on a refusal, stores the turn with cancelled results and shows the refusal copy', async () => {
    const events = await turn('bad', [
      {
        text: 'I cannot',
        toolCalls: [{ id: 'toolu_r', name: 'add_note', input: { text: 'x' } }],
        stopReason: 'refusal',
        stopDetails: { category: 'general_harms' },
      },
    ]);
    expect(stub.calls).toHaveLength(0);
    const err = errorOf(events);
    expect(err.kind).toBe('refusal');
    expect(err.message).toMatch(/declined/);
    const rows = await store.messages(conversation.id);
    expect(unpairedToolUses(rows)).toEqual([]);
    const paired = rows[3]!.content as { type: string; is_error?: boolean; content: string }[];
    expect(paired[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(paired[0]!.content).toMatch(/declined/);
    expect(readPrefs().lastLlmError?.reason).toBe('refusal');
  });

  it('re-issues the turn once when the tool JSON cannot be parsed, without running any tool twice', async () => {
    const events = await turn('move', [
      { toolCalls: [{ id: 'toolu_j', name: 'list_pipeline', rawJson: '}{', chunks: 1 }] },
      { toolCalls: [{ id: 'toolu_k', name: 'list_pipeline', input: {} }] },
      { text: 'Here is your pipeline.' },
    ]);
    expect(kinds(events).at(-1)).toBe('done');
    expect(stub.calls.map((c) => c.name)).toEqual(['list_pipeline']);
    const reqs = messageRequests(fake);
    expect(reqs).toHaveLength(3);
    // the failed turn was never appended: the retry sends the same messages as the first request
    expect(JSON.stringify(reqs[1]!.body.messages)).toBe(JSON.stringify(reqs[0]!.body.messages));
    const rows = await store.messages(conversation.id);
    expect(unpairedToolUses(rows)).toEqual([]);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(2);
  });

  it('gives up after two consecutive unparseable turns', async () => {
    const bad = { toolCalls: [{ id: 'toolu_j', name: 'list_pipeline', rawJson: '}{', chunks: 1 }] };
    const events = await turn('move', [bad, bad, bad]);
    expect(errorOf(events).kind).toBe('other');
    expect(messageRequests(fake)).toHaveLength(3);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('budget, abort and failures', () => {
  it('counts every iteration against the daily caps and stops with cancelled results when the token cap is hit', async () => {
    writePrefs({ llmDailyTokenCap: 1500 });
    const events = await turn('go', [
      {
        toolCalls: [{ id: 'toolu_c', name: 'get_today_brief', input: {} }],
        usage: { input_tokens: 1400, output_tokens: 200 },
      },
      { text: 'never served' },
    ]);
    expect(stub.calls).toHaveLength(0);
    expect(errorOf(events).kind).toBe('cap');
    expect(todaysLlmUsage(readPrefs())).toMatchObject({ requests: 1, inputTokens: 1400, outputTokens: 200 });
    expect(messageRequests(fake)).toHaveLength(1);
    const rows = await store.messages(conversation.id);
    expect(unpairedToolUses(rows)).toEqual([]);
    const paired = rows[3]!.content as { type: string; is_error?: boolean; content: string }[];
    expect(paired[0]!.content).toMatch(/daily limit/);
  });

  it('refuses to start when the request cap is already reached, without touching the history', async () => {
    writePrefs({ llmDailyRequestCap: 0 });
    const events = await turn('go', [{ text: 'never' }]);
    expect(errorOf(events).kind).toBe('cap');
    expect(messageRequests(fake)).toHaveLength(0);
    expect(await store.messages(conversation.id)).toHaveLength(0);
  });

  it('counts cached tokens at what they cost (a read is a tenth) and reads the usage of every iteration', async () => {
    await turn('go', [
      {
        toolCalls: [{ id: 'toolu_u', name: 'get_today_brief', input: {} }],
        usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10 },
      },
      { text: 'ok', usage: { input_tokens: 120, cache_read_input_tokens: 1000, output_tokens: 5 } },
    ]);
    expect(todaysLlmUsage(readPrefs())).toMatchObject({ requests: 1, inputTokens: 410, outputTokens: 15 });
    const rows = await store.messages(conversation.id);
    expect(rows[2]!.usage).toEqual({ input: 100, output: 10, cacheRead: 900, cacheWrite: 0 });
  });

  it('stops on abort while a tool runs, records a cancelled is_error result and does not count it as a failure', async () => {
    stub.delays.set('add_note', 5_000);
    const ctl = new AbortController();
    const p = turn(
      'note',
      [{ toolCalls: [{ id: 'toolu_n', name: 'add_note', input: { text: 'slow' } }] }, { text: 'never' }],
      {},
      ctl.signal,
    );
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    const events = await p;
    const err = errorOf(events);
    expect(err.kind).toBe('aborted');
    expect(err.message).toBe('Stopped.');
    const rows = await store.messages(conversation.id);
    expect(unpairedToolUses(rows)).toEqual([]);
    const paired = rows.find((r, i) => r.role === 'user' && i > 2)!.content as {
      is_error?: boolean;
      content: string;
    }[];
    expect(paired[0]).toMatchObject({ is_error: true });
    expect(paired[0]!.content).toMatch(/[Cc]ancelled/);
    expect(readPrefs().lastLlmError).toBeUndefined();
    expect((await store.getAction('toolu_n'))?.status).toBe('error');
  });

  it('stops on abort mid-stream and leaves only the user turn stored', async () => {
    const ctl = new AbortController();
    const p = turn('hello', [{ text: 'Hel', hang: true }], {}, ctl.signal);
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    const events = await p;
    expect(errorOf(events).kind).toBe('aborted');
    const rows = await store.messages(conversation.id);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(0);
    const again = await turn('again', [{ text: 'Hi.' }]);
    expect(kinds(again).at(-1)).toBe('done');
  });

  it('maps a rejected key to no_key, a server error to network and records the failure for Settings', async () => {
    const e1 = await turn('a', [
      { error: { status: 401, type: 'authentication_error', message: 'invalid x-api-key' } },
    ]);
    expect(errorOf(e1).kind).toBe('no_key');
    expect(errorOf(e1).message).not.toMatch(/x-api-key/);
    expect(readPrefs().lastLlmError?.reason).toBe('auth');
    const e2 = await turn('b', [{ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }]);
    expect(errorOf(e2).kind).toBe('network');
    const e3 = await turn('c', [{ error: { status: 429, type: 'rate_limit_error', message: 'slow down' } }]);
    expect(errorOf(e3).kind).toBe('network');
    const rows = await store.messages(conversation.id);
    expect(rows.filter((r) => r.meta === 'error')).toHaveLength(3);
    // error notes never reach the model
    const again = await turn('d', [{ text: 'ok' }]);
    expect(kinds(again).at(-1)).toBe('done');
    const sent = messageRequests(fake).at(-1)!.body.messages;
    expect(
      sent.some((m: { content: { text?: string }[] }) => m.content[0]?.text?.includes('stopped working')),
    ).toBe(false);
  });
});

describe('fallbacks and compaction', () => {
  it('stores a fallback block, shows who answered and replays the block next turn', async () => {
    const events = await turn('x', [
      { fallback: { from: MODEL, to: 'claude-opus-5' }, text: 'Answered by the fallback.' },
    ]);
    expect(events.some((e) => e.type === 'progress' && /claude-opus-5/.test(e.text))).toBe(true);
    const rows = await store.messages(conversation.id);
    const assistant = rows.find((r) => r.role === 'assistant')!;
    expect((assistant.content as { type: string }[])[0]!.type).toBe('fallback');
    expect(assistant.model).toBe('claude-opus-5');
    await turn('y', [{ text: 'ok' }]);
    const replayed = messageRequests(fake)[1]!.body.messages.find(
      (m: { role: string }) => m.role === 'assistant',
    );
    expect(replayed.content[0]).toMatchObject({
      type: 'fallback',
      from: { model: MODEL },
      to: { model: 'claude-opus-5' },
    });
  });

  it('stores a compaction block whole and replays it', async () => {
    await turn('long chat', [{ compaction: { content: 'Summary so far.' }, text: 'Continuing.' }]);
    await turn('next', [{ text: 'ok' }]);
    const replayed = messageRequests(fake)[1]!.body.messages.find(
      (m: { role: string }) => m.role === 'assistant',
    );
    expect(replayed.content[0]).toMatchObject({ type: 'compaction', content: 'Summary so far.' });
    expect(replayed.content[0].encrypted_content).toMatch(/^enc/);
  });
});

describe('a turn ends on the pills', () => {
  const pills = {
    id: 'toolu_pills',
    name: 'offer_choices',
    input: {
      options: [
        { label: 'Show me', message: 'Show my drafts' },
        { label: 'Not now', message: 'Not now' },
      ],
    },
  };
  /** the stub registry plus the real offer_choices, which only draws the pills */
  const withPills = (): Partial<TurnDeps> => {
    const spec = offerChoices as unknown as ToolSpec;
    return {
      registry: new Map<string, ToolSpec>([...stub.registry, ['offer_choices', spec]]),
      execute: (name, input, ctx) =>
        name === 'offer_choices'
          ? spec.execute(spec.input.parse(input), ctx)
          : stub.execute(name, input, ctx),
    };
  };

  it('drops the line the model adds after offer_choices when it already spoke, and keeps it out of the history', async () => {
    const events = await turn(
      'wsp',
      [
        { text: 'hey, not much. Lena is waiting on a thank-you. want to start there?', toolCalls: [pills] },
        { text: "hey. Lena's thank-you is ready to go." },
      ],
      withPills(),
    );
    expect(text(events)).toBe('hey, not much. Lena is waiting on a thank-you. want to start there?');
    expect(kinds(events).at(-1)).toBe('done');
    expect(messageRequests(fake)).toHaveLength(2);
    const rows = await store.history(conversation.id);
    expect(JSON.stringify(rows)).not.toMatch(/ready to go/);
    // the stored history still answers the tool_use, so the next turn replays
    expect(rows.at(-1)?.role).toBe('user');
    expect(JSON.stringify(rows.at(-1))).toMatch(/toolu_pills/);
    expect(unpairedToolUses(rows)).toEqual([]);
  });

  it('keeps the answer when the pills were called next to a read tool, since the answer comes after', async () => {
    const events = await turn(
      'who replied',
      [
        { text: 'Let me check.', toolCalls: [{ id: 'toolu_r', name: 'list_pipeline', input: {} }, pills] },
        { text: 'Two replied, Lena and Omar.' },
      ],
      withPills(),
    );
    expect(text(events)).toBe('Let me check.Two replied, Lena and Omar.');
    const rows = await store.history(conversation.id);
    expect(JSON.stringify(rows)).toMatch(/Two replied/);
  });

  it('keeps the answer after the pills when only a clause of intent came before them (plan 28)', async () => {
    const events = await turn(
      'what is a superday',
      [
        { text: 'One sec, checking.', toolCalls: [pills] },
        { text: 'A superday is the final round: several back to back interviews in one day.' },
      ],
      withPills(),
    );
    expect(text(events)).toBe(
      'One sec, checking.A superday is the final round: several back to back interviews in one day.',
    );
    const rows = await store.history(conversation.id);
    expect(JSON.stringify(rows)).toMatch(/final round/);
  });

  it('asks for the answer when the turn only said a clause before its lookups and pills (plan 28)', async () => {
    const events = await turn(
      'who replied',
      [
        { text: 'Let me check.', toolCalls: [{ id: 'toolu_r', name: 'list_pipeline', input: {} }] },
        { toolCalls: [pills] },
        { stopReason: 'end_turn' },
        { text: 'Two replied, Lena and Omar.' },
      ],
      withPills(),
    );
    expect(text(events)).toMatch(/Two replied, Lena and Omar\./);
    expect(messageRequests(fake)).toHaveLength(4);
    expect(JSON.stringify(messageRequests(fake).at(-1)!.body.messages.at(-1))).toMatch(/no answer in words/);
  });

  it('keeps the line when nothing was said before the pills', async () => {
    const events = await turn('wsp', [{ toolCalls: [pills] }, { text: 'hey, not much.' }], withPills());
    expect(text(events)).toBe('hey, not much.');
    expect(messageRequests(fake)).toHaveLength(2);
    const rows = await store.history(conversation.id);
    expect(rows.at(-1)?.role).toBe('assistant');
  });
});
