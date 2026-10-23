import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { ChatStore, conversationNonce, unpairedToolUses } from '../agent/store';

let store: ChatStore;
beforeEach(async () => {
  await wipeDatabase();
  store = new ChatStore();
});

describe('conversations', () => {
  it('creates, lists newest first, renames and archives saved conversations', async () => {
    const a = await store.createConversation({
      userId: 'u1',
      model: 'm',
      temporary: false,
      now: new Date('2026-10-12T10:00:00Z'),
    });
    const b = await store.createConversation({
      userId: 'u1',
      model: 'm',
      temporary: false,
      now: new Date('2026-10-12T11:00:00Z'),
    });
    await store.createConversation({ userId: 'u2', model: 'm', temporary: false });
    expect((await store.listConversations('u1')).map((c) => c.id)).toEqual([b.id, a.id]);
    await store.append(a.id, { role: 'user', content: 'hi' }, new Date('2026-10-12T12:00:00Z'));
    expect((await store.listConversations('u1')).map((c) => c.id)).toEqual([a.id, b.id]);
    await store.renameConversation(a.id, '  Priya follow-up  ');
    expect((await store.getConversation(a.id))?.title).toBe('Priya follow-up');
    await store.archiveConversation(b.id);
    expect((await store.listConversations('u1')).map((c) => c.id)).toEqual([a.id]);
    expect((await store.getConversation(b.id))?.archivedAt).toBeTruthy();
    expect((await store.getConversation(a.id))?.model).toBe('m');
  });

  it('keeps a temporary conversation in memory only, with its actions, and never lists it', async () => {
    const t = await store.createConversation({ userId: 'u1', model: 'm', temporary: true });
    expect(store.isTemporary(t.id)).toBe(true);
    await store.append(t.id, { role: 'user', content: [{ type: 'text', text: 'secret' }] });
    await store.append(t.id, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    await store.putAction({
      id: 'conf_t',
      conversationId: t.id,
      userId: 'u1',
      toolName: 'send_draft',
      input: {},
      status: 'pending',
      createdAt: 'a',
      updatedAt: 'a',
    });
    expect((await store.messages(t.id)).map((m) => m.seq)).toEqual([1, 2]);
    expect((await store.getAction('conf_t'))?.status).toBe('pending');
    expect(await db.chatConversations.count()).toBe(0);
    expect(await db.chatMessages.count()).toBe(0);
    expect(await db.chatActions.count()).toBe(0);
    expect(await store.listConversations('u1')).toEqual([]);
    await store.archiveConversation(t.id);
    expect(await store.getConversation(t.id)).toBeUndefined();
  });

  it('derives a stable sixteen-hex nonce from the conversation id', () => {
    expect(conversationNonce('conv_0b1c2d3e-4f50-4617-8899-aabbccddeeff')).toBe('0b1c2d3e4f504617');
    expect(conversationNonce('x')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('append-only messages', () => {
  it('numbers rows in order, stores whole content blocks and bumps the conversation', async () => {
    const c = await store.createConversation({ userId: 'u1', model: 'm', temporary: false });
    const content = [
      { type: 'thinking', thinking: 'note', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_pipeline', input: { stage: 'replied' } },
    ];
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    const row = await store.append(c.id, {
      role: 'assistant',
      content,
      model: 'm',
      usage: { input: 10, output: 2 },
      stopReason: 'tool_use',
    });
    expect(row.seq).toBe(2);
    const rows = await store.messages(c.id);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]!.content).toEqual(content);
    expect(rows[1]!.model).toBe('m');
    expect((await store.getConversation(c.id))!.updatedAt >= c.updatedAt).toBe(true);
  });

  it('replays every row but error notes and orphaned snapshots', async () => {
    const c = await store.createConversation({ userId: 'u1', model: 'm', temporary: false });
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'one' }] });
    await store.append(c.id, {
      role: 'system',
      content: [{ type: 'text', text: 'Today is Mon 2026-10-12, 09:41, UTC.\nA' }],
      meta: 'snapshot',
    });
    await store.append(c.id, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'two' }] });
    await store.append(c.id, {
      role: 'system',
      content: [{ type: 'text', text: 'Today is Mon 2026-10-12, 09:42, UTC.\nB' }],
      meta: 'snapshot',
    });
    await store.append(c.id, {
      role: 'system',
      content: [{ type: 'text', text: 'Could not reach Claude.' }],
      meta: 'error',
    });
    // the dangling snapshot is not replayed (the next student turn would follow it), and does not count as seen
    const h = await store.history(c.id);
    expect(h.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(await store.lastSnapshotText(c.id)).toMatch(/09:41/);
    expect(await store.messages(c.id)).toHaveLength(6);
  });

  it('forgets a snapshot that a compaction block stands in for, and reads the last Remembered line', async () => {
    const c = await store.createConversation({ userId: 'u1', model: 'm', temporary: false });
    const snap = (clock: string, more: string) =>
      store.append(c.id, {
        role: 'system',
        content: [{ type: 'text', text: `Today is Mon 2026-10-12, ${clock}, UTC.\nA\n${more}` }],
        meta: 'snapshot',
      });
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'one' }] });
    await snap('09:41', 'Remembered (ids): mem_1 Prefers morning calls.');
    await store.append(c.id, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'two' }] });
    await store.append(c.id, {
      role: 'system',
      content: [{ type: 'text', text: 'Remembered (ids): mem_2 Targeting PM internships.' }],
      meta: 'memory',
    });
    await store.append(c.id, { role: 'assistant', content: [{ type: 'text', text: 'sure' }] });
    // the snapshot is the last one; the memory row is the newest context of either kind
    expect(await store.lastContextTexts(c.id)).toEqual({
      snapshot: 'Today is Mon 2026-10-12, 09:41, UTC.\nA\nRemembered (ids): mem_1 Prefers morning calls.',
      memory: 'Remembered (ids): mem_2 Targeting PM internships.',
    });
    // a compaction block replaces everything before it: the model no longer sees that snapshot
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'three' }] });
    await store.append(c.id, {
      role: 'assistant',
      content: [
        { type: 'compaction', content: 'Summary so far.', encrypted_content: 'enc' },
        { type: 'text', text: 'Continuing.' },
      ],
    });
    expect(await store.lastContextTexts(c.id)).toEqual({ snapshot: undefined, memory: undefined });
    expect(await store.lastSnapshotText(c.id)).toBeUndefined();
    await store.append(c.id, { role: 'user', content: [{ type: 'text', text: 'four' }] });
    await snap('10:05', 'B');
    await store.append(c.id, { role: 'assistant', content: [{ type: 'text', text: 'yes' }] });
    expect(await store.lastSnapshotText(c.id)).toMatch(/10:05/);
    expect((await store.history(c.id)).length).toBe(11);
  });

  it('finds tool_use blocks without a tool_result in the next row', () => {
    const rows = [
      { role: 'user' as const, content: 'x' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use', id: 'a', name: 't', input: {} },
          { type: 'tool_use', id: 'b', name: 't', input: {} },
        ],
      },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'a', content: '{}' }] },
    ];
    expect(unpairedToolUses(rows)).toEqual(['b']);
    expect(unpairedToolUses(rows.slice(0, 2))).toEqual(['a', 'b']);
  });
});

describe('actions', () => {
  it('stores, updates and lists tool executions per conversation', async () => {
    const c = await store.createConversation({ userId: 'u1', model: 'm', temporary: false });
    await store.putAction({
      id: 'toolu_1',
      conversationId: c.id,
      userId: 'u1',
      toolName: 'add_note',
      input: { text: 'a' },
      status: 'running',
      createdAt: '1',
      updatedAt: '1',
    });
    await store.putAction({
      id: 'conf_1',
      conversationId: c.id,
      userId: 'u1',
      toolName: 'send_draft',
      input: {},
      status: 'pending',
      createdAt: '2',
      updatedAt: '2',
    });
    const done = await store.updateAction('toolu_1', {
      status: 'done',
      envelope: { kind: 'note', data: {}, summary: 'Saved.' },
    });
    expect(done?.status).toBe('done');
    expect((await store.actions(c.id)).map((a) => [a.id, a.status])).toEqual([
      ['toolu_1', 'done'],
      ['conf_1', 'pending'],
    ]);
    expect(await store.updateAction('missing', { status: 'done' })).toBeUndefined();
  });
});
