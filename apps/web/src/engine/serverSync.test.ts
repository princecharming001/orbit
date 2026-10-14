import type { CoffeeChat, MeetingNote, Person, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import {
  flushQueue,
  installOutboxHooks,
  pullNow,
  pushOutbox,
  refreshSyncStatus,
  serverIdOf,
  syncStatusNow,
  writeFromServer,
} from './serverSync';

let api: FakeOrbitApi;
let user: User;
const at = '2026-10-06T12:00:00.000Z';
const P1 = '0b8f6a0e-1111-4c2e-8d1a-000000000001';
const P2 = '0b8f6a0e-1111-4c2e-8d1a-000000000002';

function personRow(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, userId: user.id, displayName: name, createdAt: at, updatedAt: at, ...extra };
}

beforeEach(async () => {
  await wipeDatabase();
  ({ api, user } = await signInToFakeApi());
  installOutboxHooks();
});

afterEach(async () => {
  await leaveFakeApi();
});

describe('pull', () => {
  it('pages through /sync/pull with the stored cursor, in dependency order, and fills what screens need', async () => {
    api.state.pages.push(
      {
        changes: {
          // the server sends tables in any order; people land before the chat that points at them
          chats: [
            {
              id: 'c0000000-0000-4000-8000-000000000001',
              userId: user.id,
              personId: P1,
              stage: 'identified',
              stageEnteredAt: at,
              createdAt: at,
            },
          ],
          people: [personRow(P1, 'Priya Shah', { tieScore: 78, currentTitle: null })],
        },
      },
      {
        changes: {
          people: [personRow(P2, 'Dan Ortiz')],
          tie_scores: [
            {
              personId: P2,
              userId: user.id,
              score: 42,
              band: 'warm',
              explanation: ['3 meetings in the last 2 years'],
            },
          ],
        },
      },
    );
    const out = await pullNow(user.id);
    expect(out).toMatchObject({ ok: true, pages: 2 });
    expect(out.tables.sort()).toEqual(['chats', 'people', 'tie_scores']);
    const priya = (await db.people.get(P1)) as Person;
    // defaults for what a server row leaves out; a null becomes absent
    expect(priya).toMatchObject({
      firstName: 'Priya',
      lastName: 'Shah',
      emails: [],
      tags: [],
      isHuman: true,
    });
    expect(priya.strength).toBeCloseTo(0.78);
    expect('currentTitle' in priya).toBe(false);
    // the tie score lands on the person too
    expect(await db.people.get(P2)).toMatchObject({ tieScore: 42, tieBand: 'warm', strength: 0.42 });
    expect((await db.people.get(P2))?.tieExplanation).toEqual(['3 meetings in the last 2 years']);
    expect(await db.chats.count()).toBe(1);
    // the cursor is kept: the next pull asks from where this one ended
    expect((await db.kv.get('serverSync.cursor'))?.value).toBe('c2');
    api.calls.length = 0;
    await pullNow(user.id);
    expect(api.calls[0]).toMatchObject({ route: '/sync/pull', body: { cursor: 'c2' } });
  });

  it('deletes the ids the server says are gone', async () => {
    api.state.pages.push({ changes: { people: [personRow(P1, 'Priya Shah'), personRow(P2, 'Dan Ortiz')] } });
    await pullNow(user.id);
    api.state.pages.push({ changes: {}, deleted: { people: [P2] } });
    await pullNow(user.id);
    expect(await db.people.get(P2)).toBeUndefined();
    expect(await db.people.get(P1)).toBeDefined();
  });

  it('never queues pulled rows to go back up', async () => {
    api.state.pages.push({ changes: { people: [personRow(P1, 'Priya Shah')] } });
    await pullNow(user.id);
    await flushQueue();
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps the status the poll reads', async () => {
    api.state.status.counts.messages = 1240;
    await refreshSyncStatus();
    expect(syncStatusNow()?.counts.messages).toBe(1240);
  });
});

describe('push', () => {
  beforeEach(async () => {
    api.state.pages.push({ changes: { people: [personRow(P1, 'Priya Shah')] } });
    await pullNow(user.id);
  });

  it('queues a chat, its stage event and a note made in this browser, and pushes them under uuids in order', async () => {
    const chatId = newId('chat');
    const chat = {
      id: chatId,
      userId: user.id,
      personId: P1,
      stage: 'outreach_sent',
      stageEnteredAt: at,
      createdAt: at,
      updatedAt: at,
      source: 'manual',
    } as unknown as CoffeeChat;
    await db.chats.add(chat);
    await db.stageEvents.add({
      id: newId('se'),
      userId: user.id,
      chatId,
      fromStage: 'identified',
      toStage: 'outreach_sent',
      status: 'applied',
      actor: 'user:select',
      createdAt: at,
    } as never);
    const note: MeetingNote = {
      id: newId('note'),
      userId: user.id,
      personIds: [P1],
      chatId,
      source: 'manual',
      occurredAt: at,
      rawText: 'Coffee with Priya.',
      matchStatus: 'matched',
      createdAt: at,
    } as unknown as MeetingNote;
    await db.notes.add(note);
    // an edit to the same chat is one change, not two
    await db.chats.update(chatId, { stage: 'replied' });
    await flushQueue();
    expect(await db.outbox.count()).toBe(3);
    const out = await pushOutbox();
    expect(out).toMatchObject({ ok: true, sent: 3 });
    expect(api.state.pushed.map((c) => c.table)).toEqual(['chats', 'stage_events', 'notes']);
    const pushedChat = api.state.pushed[0]!;
    expect(pushedChat.id).toBe(serverIdOf(chatId));
    expect(pushedChat.row).toMatchObject({ personId: P1, stage: 'replied' });
    expect((pushedChat.row!.data as Record<string, unknown>).source).toBe('manual');
    expect(api.state.pushed[1]!.row).toMatchObject({ chatId: serverIdOf(chatId), actor: 'user' });
    expect(api.state.pushed[2]!.row).toMatchObject({ personIds: [P1], chatId: serverIdOf(chatId) });
    expect(await db.outbox.count()).toBe(0);
    // the copy that comes back keeps the local id
    api.state.pages.push({
      changes: { chats: [{ ...chatToServer(chat, serverIdOf(chatId)!), stage: 'scheduled' }] },
    });
    await pullNow(user.id);
    expect(await db.chats.count()).toBe(1);
    expect((await db.chats.get(chatId))?.stage).toBe('scheduled');
  });

  it('sends only the hand-edited fields of a person the server knows', async () => {
    await db.people.update(P1, { tags: ['payments'], relationshipType: 'mentor', summary: 'x' });
    await pushOutbox();
    expect(api.state.pushed).toEqual([
      expect.objectContaining({
        table: 'people',
        id: P1,
        row: expect.objectContaining({ tags: ['payments'], relationshipType: 'mentor' }),
      }),
    ]);
    expect(api.state.pushed[0]!.row).not.toHaveProperty('summary');
  });

  it('pushes a draft body edit and a discard, never a local-only draft', async () => {
    const D = 'd0000000-0000-4000-8000-000000000001';
    await writeFromServer(
      'drafts',
      [
        {
          id: D,
          userId: user.id,
          personId: P1,
          channel: 'gmail',
          kind: 'reply',
          body: 'Hi',
          status: 'draft',
          createdAt: at,
        },
      ],
      user.id,
    );
    expect((await db.outbound.get(D))?.bodyDraft).toBe('Hi');
    await db.outbound.update(D, { bodyFinal: 'Hi Priya, Tuesday works.' });
    await db.outbound.add({
      id: newId('out'),
      userId: user.id,
      personId: P1,
      channel: 'gmail',
      kind: 'outreach',
      bodyDraft: 'x',
      status: 'draft',
      generatedBy: 'template',
      createdAt: at,
    });
    await pushOutbox();
    expect(api.state.pushed).toEqual([
      { table: 'drafts', op: 'upsert', id: D, row: { body: 'Hi Priya, Tuesday works.', subject: null } },
    ]);
    await db.outbound.update(D, { status: 'cancelled' });
    await pushOutbox();
    expect(api.state.pushed.at(-1)).toEqual({
      table: 'drafts',
      op: 'upsert',
      id: D,
      row: { status: 'discarded' },
    });
  });

  it('drops a change the server refuses for good, and keeps one that failed for now', async () => {
    await db.tieLabels.put({ personId: P1, userId: user.id, closeness: 4, updatedAt: at });
    api.state.rejectPush.set(P1, 'not_found');
    const refused = await pushOutbox();
    expect(refused).toMatchObject({ dropped: 1, sent: 0 });
    expect(await db.outbox.count()).toBe(0);
    await db.tieLabels.put({ personId: P1, userId: user.id, closeness: 5, updatedAt: at });
    api.state.rejectPush.set(P1, 'failed');
    const later = await pushOutbox();
    expect(later).toMatchObject({ failed: 1 });
    expect((await db.outbox.toArray())[0]).toMatchObject({ table: 'tie_labels', attempts: 1 });
    api.state.rejectPush.clear();
    expect(await pushOutbox()).toMatchObject({ sent: 1 });
    expect(api.state.pushed.at(-1)).toEqual({
      table: 'tie_labels',
      op: 'upsert',
      id: P1,
      row: { closeness: 5 },
    });
  });

  it('keeps everything queued when the server cannot be reached', async () => {
    await db.people.update(P1, { tags: ['a'] });
    api.state.access.clear();
    api.state.refresh = undefined;
    const out = await pushOutbox();
    expect(out.ok).toBe(false);
    expect(await db.outbox.count()).toBe(1);
  });

  it('does nothing for rows that are not the signed-in account', async () => {
    await db.people.add({
      ...(personRow('p_local', 'Local Only') as unknown as Person),
      userId: 'someone-else',
    });
    await flushQueue();
    expect(await db.outbox.count()).toBe(0);
  });
});

function chatToServer(c: CoffeeChat, id: string) {
  return { ...c, id, personId: c.personId };
}
