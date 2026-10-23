import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { MODEL } from '../../integrations/anthropic';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { z } from '../../zod';
import { createChatEngine } from '../agent';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { ChatStore, unpairedToolUses } from '../agent/store';
import { type FakeAnthropic, messageRequests, scriptedFetch } from '../test/fakeAnthropic';
import { makeStubRegistry, type StubRegistry } from '../test/stubRegistry';
import type { ChatEngine, ToolSpec, TurnEvent } from '../types';

let user: User;
let stub: StubRegistry;
let fake: FakeAnthropic;
let store: ChatStore;
let engine: ChatEngine;

async function addPerson(id: string, first: string, last: string, org: string) {
  await db.people.add({
    id,
    userId: user.id,
    displayName: `${first} ${last}`,
    firstName: first,
    lastName: last,
    nameNormalized: `${first} ${last}`.toLowerCase(),
    emails: [],
    currentOrganizationRaw: org,
    relationshipType: 'contact',
    strength: 0.5,
    interactionCount: 0,
    sources: [],
    isHuman: true,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as never);
}

async function send(conversationId: string, text: string, signal?: AbortSignal) {
  const events: TurnEvent[] = [];
  await engine.send(conversationId, text, (e) => events.push(e), signal);
  return events;
}
const kinds = (events: TurnEvent[]) => events.map((e) => e.type);
const result = (events: TurnEvent[]) =>
  events.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }> | undefined;

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  user = await createLocalUser({
    fullName: 'Sam Lee',
    firstName: 'Sam',
    school: 'Cornell',
    timezone: 'America/New_York',
  });
  await addPerson('p1', 'Priya', 'Patel', 'Stripe');
  await addPerson('p2', 'Daniel', 'Kim', 'Ramp');
  stub = makeStubRegistry();
  fake = scriptedFetch();
  store = new ChatStore();
  setChatClientFactoryForTests((key) => makeChatClient(key, { fetch: fake.fetch, maxRetries: 0 }));
  engine = createChatEngine({
    registry: stub.registry,
    execute: stub.execute,
    user: () => user,
    store,
    prefixMismatch: 'error',
  });
});
afterEach(() => setChatClientFactoryForTests(undefined));

describe('mode', () => {
  it('is router without a key, with a note that points at Settings, and llm once a key is saved', () => {
    expect(engine.mode()).toBe('router');
    expect(engine.modeNote()).toMatchObject({ href: '/settings/integrations' });
    expect(engine.modeNote()?.text).toMatch(/Without a Claude key/);
    expect(engine.modeNote()?.text).not.toMatch(/[—–!]/);
    writePrefs({ anthropicApiKey: 'sk-ant-test' });
    expect(engine.mode()).toBe('llm');
    expect(engine.modeNote()).toBeUndefined();
    writePrefs({ llmFeatures: { chat: false } });
    expect(engine.mode()).toBe('router');
    expect(engine.modeNote()?.text).toMatch(/turned off/);
    writePrefs({ llmFeatures: { chat: true }, llmDailyRequestCap: 0 });
    expect(engine.mode()).toBe('router');
    expect(engine.modeNote()?.text).toMatch(/daily limit/);
  });
});

describe('router mode', () => {
  it('answers a command by running the tool directly and stores the turn', async () => {
    const c = await engine.startConversation({ temporary: false });
    const events = await send(c.id, 'who went quiet');
    expect(kinds(events)).toEqual(['tool_start', 'tool_result', 'done']);
    expect(result(events)?.envelope.kind).toBe('pipeline');
    expect(stub.calls[0]).toMatchObject({ name: 'list_pipeline', input: { quietOnly: true } });
    expect(stub.calls[0]!.ctx.caller).toBe('router');
    const { messages, actions } = await engine.loadConversation(c.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((messages[1]!.content as { text: string }[])[0]!.text).toBe('No chat went quiet.');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.envelope?.kind).toBe('pipeline');
    expect(actions[0]!.messageId).toBe(messages[1]!.id);
    expect(messageRequests(fake)).toHaveLength(0);
  });

  it('says a friendly line first and shows the choices under it, storing only the line', async () => {
    // the conversation tools live elsewhere; a minimal stand-in with the same contract
    const offer = {
      name: 'offer_choices',
      kind: 'read',
      description: 'choices',
      input: z.object({
        options: z
          .array(z.object({ label: z.string(), message: z.string() }))
          .min(2)
          .max(3),
      }),
      capabilities: [],
      execute: async (input: { options: unknown[] }) => ({
        kind: 'choices' as const,
        data: { options: input.options },
        summary: 'Offered 2 choices.',
      }),
    } as unknown as ToolSpec;
    const registry = new Map<string, ToolSpec>([...stub.registry, ['offer_choices', offer]]);
    const execute = (name: string, input: unknown, ctx: Parameters<typeof stub.execute>[2]) =>
      name === 'offer_choices' ? offer.execute(input as never, ctx) : stub.execute(name, input, ctx);
    engine = createChatEngine({ registry, execute, user: () => user, store });
    const c = await engine.startConversation({ temporary: false });
    const events = await send(c.id, 'hey');
    expect(kinds(events)).toEqual(['text', 'tool_start', 'tool_result', 'done']);
    const line = (events[0] as { delta: string }).delta;
    // the greeting varies by message, in the student's register (lowercase "hey" gets lowercase back)
    expect(line).toMatch(/^(?:hey|hi) Sam(?:, good to see you)?\. /);
    expect(result(events)?.envelope.kind).toBe('choices');
    const { messages } = await engine.loadConversation(c.id);
    expect((messages[1]!.content as { text: string }[])[0]!.text).toBe(line);
  });

  it('resolves people from the database for a draft command', async () => {
    const c = await engine.startConversation({ temporary: false });
    const events = await send(c.id, 'draft a thank you to Priya');
    expect(result(events)?.envelope.kind).toBe('draft');
    expect(stub.calls[0]).toMatchObject({
      name: 'create_draft',
      input: { kind: 'thank_you', personId: 'p1' },
    });
  });

  it('refuses free-form questions honestly, with the settings route', async () => {
    const c = await engine.startConversation({ temporary: false });
    const events = await send(c.id, 'why has Priya not replied?');
    expect(kinds(events)).toEqual(['text', 'tool_result', 'done']);
    const text = (events[0] as { delta: string }).delta;
    expect(text).toMatch(/needs a Claude key/);
    expect(text).toMatch(/Settings, Integrations/);
    expect(result(events)?.envelope.href).toBe('/settings/integrations');
    expect(stub.calls).toHaveLength(0);
  });

  it('runs chips directly with fixed input in both modes and stores the chip text as the student turn', async () => {
    // the stub has no open_page, so the two chips that open a page are left out
    expect(engine.chips().map((ch) => ch.id)).toEqual([
      'who-today',
      'thank-you',
      'quiet',
      'prep',
      'linkedin',
      'pipeline',
    ]);
    const c = await engine.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    await engine.runChip(c.id, 'who-today', (e) => events.push(e));
    expect(kinds(events)).toEqual(['tool_start', 'tool_result', 'done']);
    expect(stub.calls[0]).toMatchObject({ name: 'get_today_brief', input: {} });
    expect(stub.calls[0]!.ctx.caller).toBe('ui');
    const { messages } = await engine.loadConversation(c.id);
    expect((messages[0]!.content as { text: string }[])[0]!.text).toBe('Who should I message today?');
    writePrefs({ anthropicApiKey: 'sk-ant-test' });
    await engine.runChip(c.id, 'quiet', () => {});
    expect(stub.calls[1]!.name).toBe('list_pipeline');
    expect(messageRequests(fake)).toHaveLength(0);
  });

  it('keeps a temporary conversation out of Dexie', async () => {
    const c = await engine.startConversation({ temporary: true });
    await send(c.id, 'who went quiet');
    expect(await db.chatConversations.count()).toBe(0);
    expect(await db.chatMessages.count()).toBe(0);
    expect(await db.chatActions.count()).toBe(0);
    expect((await engine.loadConversation(c.id)).messages).toHaveLength(2);
    expect(await engine.listConversations()).toEqual([]);
  });
});

describe('llm mode', () => {
  beforeEach(() => writePrefs({ anthropicApiKey: 'sk-ant-test' }));

  it('streams a Claude turn through the fake and persists it', async () => {
    const c = await engine.startConversation({ temporary: false });
    fake.push({ text: 'Hello Sam.' });
    const events = await send(c.id, 'hi');
    expect(kinds(events).at(-1)).toBe('done');
    expect(messageRequests(fake)).toHaveLength(1);
    const { messages, conversation } = await engine.loadConversation(c.id);
    expect(messages.map((m) => [m.role, m.meta ?? ''])).toEqual([
      ['user', ''],
      ['system', 'snapshot'],
      ['assistant', ''],
    ]);
    expect(conversation.model).toBe(MODEL);
    expect((await engine.listConversations()).map((x) => x.id)).toEqual([c.id]);
  });

  it('approves a pending confirmation through execute with the token, records the decision and shows it to the model', async () => {
    const c = await engine.startConversation({ temporary: false });
    fake.push(
      { toolCalls: [{ id: 'toolu_s', name: 'send_draft', input: { draftId: 'out_1' } }] },
      { text: 'Approve to send it.' },
    );
    const events = await send(c.id, 'send the Priya draft');
    expect(result(events)?.envelope).toMatchObject({ kind: 'needs_confirmation', confirmationId: 'conf_1' });
    const env = await engine.approve('conf_1');
    expect(env.kind).toBe('draft');
    expect(env.summary).toMatch(/Queued/);
    const approved = stub.calls.at(-1)!;
    expect(approved).toMatchObject({ name: 'send_draft', input: { draftId: 'out_1' } });
    expect(approved.ctx).toMatchObject({ caller: 'ui', confirmation: 'conf_1', toolUseId: 'conf_1' });
    expect((await store.getAction('conf_1'))?.status).toBe('done');
    const { messages } = await engine.loadConversation(c.id);
    const decision = messages.at(-1)!;
    expect(decision.meta).toBe('decision');
    expect((decision.content as { text: string }[])[0]!.text).toMatch(
      /^\[Orbit\] Approved conf_1: send_draft -> Queued/,
    );
    // a second approval of the same token does nothing
    expect((await engine.approve('conf_1')).kind).toBe('error');
    expect(stub.calls.filter((x) => x.name === 'send_draft')).toHaveLength(2);
    // the next model turn sees the decision
    fake.push({ text: 'Sent.' });
    await send(c.id, 'thanks');
    const sent = messageRequests(fake).at(-1)!.body.messages;
    expect(
      sent.some((m: { content: { text?: string }[] }) =>
        m.content[0]?.text?.startsWith('[Orbit] Approved conf_1'),
      ),
    ).toBe(true);
    expect(unpairedToolUses(messages)).toEqual([]);
  });

  it('cancels a pending confirmation and records the decision', async () => {
    const c = await engine.startConversation({ temporary: false });
    fake.push(
      { toolCalls: [{ id: 'toolu_s', name: 'send_draft', input: { draftId: 'out_2' } }] },
      { text: 'Approve to send it.' },
    );
    await send(c.id, 'send it');
    await engine.cancel('conf_1');
    expect((await store.getAction('conf_1'))?.status).toBe('cancelled');
    const { messages } = await engine.loadConversation(c.id);
    expect((messages.at(-1)!.content as { text: string }[])[0]!.text).toBe('[Orbit] Cancelled conf_1.');
    expect((await engine.approve('conf_1')).summary).toMatch(/already cancelled/);
    expect((await engine.approve('conf_missing')).kind).toBe('error');
  });

  it('refuses an expired approval', async () => {
    const c = await engine.startConversation({ temporary: false });
    await store.putAction({
      id: 'conf_old',
      conversationId: c.id,
      userId: user.id,
      toolName: 'send_draft',
      input: { draftId: 'out_9' },
      status: 'pending',
      expiresAt: '2020-01-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    });
    const env = await engine.approve('conf_old');
    expect(env.kind).toBe('error');
    expect(env.summary).toMatch(/expired/);
    expect((await store.getAction('conf_old'))?.status).toBe('expired');
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses to continue a conversation pinned to another model', async () => {
    const c = await engine.startConversation({ temporary: false });
    await db.chatConversations.update(c.id, { model: 'claude-opus-5' });
    const events = await send(c.id, 'hi');
    expect(events).toEqual([
      { type: 'error', kind: 'other', message: expect.stringMatching(/different model/) },
    ]);
    expect(messageRequests(fake)).toHaveLength(0);
  });

  it('falls back to the router for a turn once the daily cap is reached', async () => {
    writePrefs({ llmDailyRequestCap: 0 });
    const c = await engine.startConversation({ temporary: false });
    const events = await send(c.id, 'who went quiet');
    expect(kinds(events)).toEqual(['tool_start', 'tool_result', 'done']);
    expect(messageRequests(fake)).toHaveLength(0);
  });

  it('renames and archives conversations', async () => {
    const c = await engine.startConversation({ temporary: false });
    await engine.renameConversation(c.id, 'Priya');
    expect((await engine.loadConversation(c.id)).conversation.title).toBe('Priya');
    await engine.archiveConversation(c.id);
    expect(await engine.listConversations()).toEqual([]);
  });
});

describe('attachments', () => {
  it('routes a note file to add_note with the text and the upload source', async () => {
    const c = await engine.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    await engine.attach(
      c.id,
      new File(['Met Priya. She suggested the platform team.'], 'coffee.txt'),
      'note',
      (e) => events.push(e),
    );
    expect(kinds(events)).toEqual(['tool_start', 'tool_result', 'done']);
    expect(stub.calls[0]).toMatchObject({
      name: 'add_note',
      input: { text: 'Met Priya. She suggested the platform team.', source: 'upload' },
    });
    const { messages } = await engine.loadConversation(c.id);
    expect((messages[0]!.content as { text: string }[])[0]!.text).toBe('Attached notes: coffee.txt');
  });

  it('routes an email to add_note as an uploaded file', async () => {
    const c = await engine.startConversation({ temporary: false });
    await engine.attach(
      c.id,
      new File(['From: priya@stripe.com\nHappy to chat.'], 'mail.eml'),
      'email',
      () => {},
    );
    expect(stub.calls[0]).toMatchObject({
      name: 'add_note',
      input: { text: 'From: priya@stripe.com\nHappy to chat.', source: 'upload' },
    });
    expect((stub.calls[0]!.input as { title?: string }).title).toBeUndefined();
  });

  it('routes a resume to save_resume and a LinkedIn export to import_linkedin, which ask for approval first', async () => {
    const c = await engine.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    const resume = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await engine.attach(c.id, resume, 'resume', (e) => events.push(e));
    expect(result(events)?.envelope.kind).toBe('needs_confirmation');
    expect(stub.calls[0]!.name).toBe('save_resume');
    expect(stub.calls[0]!.input).toEqual({
      filename: 'resume.pdf',
      base64: btoa('%PDF-1.4'),
      mimeType: 'application/pdf',
    });
    const env = await engine.approve(result(events)!.envelope.confirmationId!);
    expect(env).toMatchObject({ kind: 'import', summary: 'Resume read.' });
    const li: TurnEvent[] = [];
    await engine.attach(c.id, new File(['First Name,Last Name'], 'Connections.csv'), 'linkedin', (e) =>
      li.push(e),
    );
    expect(stub.calls.at(-1)).toMatchObject({
      name: 'import_linkedin',
      input: { csvText: 'First Name,Last Name', filename: 'Connections.csv' },
    });
    expect(result(li)?.envelope.kind).toBe('needs_confirmation');
  });

  it('says so when the registry has no tool for an attachment', async () => {
    const registry = new Map(stub.registry);
    registry.delete('save_resume');
    const e2 = createChatEngine({ registry, execute: stub.execute, user: () => user, store });
    const c = await e2.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    await e2.attach(c.id, new File(['x'], 'r.pdf'), 'resume', (e) => events.push(e));
    expect(events).toEqual([
      { type: 'error', kind: 'other', message: expect.stringMatching(/cannot take a resume/) },
    ]);
  });
});
