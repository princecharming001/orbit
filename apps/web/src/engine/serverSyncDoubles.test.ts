/**
 * Nothing this browser made is ever in it twice. A row made here has its own id (`c_<uuid>`) and goes up to the
 * server as `<uuid>`; when the server's copy comes down it must land on the row, not beside it. That used to hang on
 * a map of server id to local id, and the map was forgotten on sign-out while the rows stayed: signing back in
 * brought every person, card, note and draft made in the browser down a second time (two cards for one person under
 * "To contact"). A second tab that kept its own copy of the map did the same.
 */
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
  repairDoubledRows,
  resetSyncState,
  serverIdOf,
  writeFromServer,
} from './serverSync';

let api: FakeOrbitApi;
let user: User;
const at = '2026-11-22T09:31:22.000Z';

beforeEach(async () => {
  await wipeDatabase();
  ({ api, user } = await signInToFakeApi());
  installOutboxHooks();
});
afterEach(async () => {
  await leaveFakeApi();
});

async function addHere() {
  const personId = newId('p');
  const chatId = newId('c');
  const noteId = newId('n');
  await db.people.add({
    id: personId,
    userId: user.id,
    displayName: 'Shelby Haas-Sapp',
    firstName: 'Shelby',
    lastName: 'Haas-Sapp',
    nameNormalized: 'shelby haas-sapp',
    headline: 'I teach sales',
    emails: [],
    tags: [],
    relationshipType: 'unknown',
    sources: ['manual'],
    isHuman: true,
    strength: 0,
    interactionCount: 0,
    createdAt: at,
    updatedAt: at,
  } as unknown as Person);
  await db.chats.add({
    id: chatId,
    userId: user.id,
    personId,
    stage: 'identified',
    stageEnteredAt: at,
    createdAt: at,
    updatedAt: at,
  } as unknown as CoffeeChat);
  await db.notes.add({
    id: noteId,
    userId: user.id,
    personId,
    chatId,
    body: 'Met at the sales panel',
    createdAt: at,
    updatedAt: at,
  } as unknown as MeetingNote);
  return { personId, chatId, noteId };
}

/** The server's copies of what was made here, as a pull sends them: under bare uuids, pointing at bare uuids. */
function serverCopies(
  ids: { personId: string; chatId: string; noteId: string },
  over: { stage?: string } = {},
) {
  const [p, c, n] = [serverIdOf(ids.personId)!, serverIdOf(ids.chatId)!, serverIdOf(ids.noteId)!];
  return {
    people: [
      {
        id: p,
        userId: user.id,
        displayName: 'Shelby Haas-Sapp',
        headline: 'I teach sales',
        createdAt: at,
        updatedAt: at,
      },
    ],
    chats: [
      {
        id: c,
        userId: user.id,
        personId: p,
        stage: over.stage ?? 'identified',
        stageEnteredAt: at,
        createdAt: at,
      },
    ],
    notes: [
      { id: n, userId: user.id, personId: p, chatId: c, body: 'Met at the sales panel', createdAt: at },
    ],
  };
}

const ids = async () => ({
  people: (await db.people.toCollection().primaryKeys()).filter((k) => !String(k).startsWith('u')).sort(),
  chats: (await db.chats.toCollection().primaryKeys()).sort(),
  notes: (await db.notes.toCollection().primaryKeys()).sort(),
});

describe('rows made in this browser come back onto themselves', () => {
  it('sign out and back in: the pull that starts over lands on the rows, one card for one person', async () => {
    const made = await addHere();
    await pushOutbox();
    // sign-out: the cursor is forgotten, the rows are still here
    await resetSyncState();
    api.state.pages.push({ changes: serverCopies(made, { stage: 'contacted' }) });
    await pullNow(user.id);
    const now = await ids();
    expect(now.chats).toEqual([made.chatId]);
    expect(now.notes).toEqual([made.noteId]);
    expect(now.people.filter((k) => k === made.personId || k === serverIdOf(made.personId))).toEqual([
      made.personId,
    ]);
    // the server's newer word is on the row, and it still points at the person made here
    expect(await db.chats.get(made.chatId)).toMatchObject({ stage: 'contacted', personId: made.personId });
    expect(await db.notes.get(made.noteId)).toMatchObject({ personId: made.personId, chatId: made.chatId });
    // and nothing is queued to go back up for it
    expect(await db.outbox.count()).toBe(0);
  });

  it('with no map at all (lost, or made before it was kept): the uuid inside the id is enough', async () => {
    const made = await addHere();
    await db.outbox.clear();
    await db.kv.delete('serverSync.aliases');
    const copies = serverCopies(made);
    await writeFromServer('people', copies.people, user.id);
    await writeFromServer('chats', copies.chats, user.id);
    await writeFromServer('notes', copies.notes, user.id);
    const now = await ids();
    expect(now.chats).toEqual([made.chatId]);
    expect(now.notes).toEqual([made.noteId]);
    expect(await db.people.get(serverIdOf(made.personId)!)).toBeUndefined();
    expect((await db.chats.get(made.chatId))!.personId).toBe(made.personId);
    // learned once, kept for the next pull
    const kept = (await db.kv.get('serverSync.aliases'))!.value as Record<string, string>;
    expect(kept[serverIdOf(made.chatId)!]).toBe(made.chatId);
    expect(kept[serverIdOf(made.personId)!]).toBe(made.personId);
  });

  it('a row another tab pushed a moment ago: the map is read from storage, not from this tab’s memory', async () => {
    // this tab reads the map (empty) once
    await writeFromServer('people', [], user.id);
    await writeFromServer(
      'chats',
      [
        {
          id: '0b8f6a0e-1111-4c2e-8d1a-0000000000aa',
          userId: user.id,
          personId: 'x',
          stage: 'identified',
          stageEnteredAt: at,
          createdAt: at,
        },
      ],
      user.id,
    );
    // the other tab adds a pair for a row whose id does not carry the uuid
    await db.chats.add({
      id: 'chat-made-elsewhere',
      userId: user.id,
      personId: 'x',
      stage: 'identified',
      stageEnteredAt: at,
      createdAt: at,
      updatedAt: at,
    } as unknown as CoffeeChat);
    await db.outbox.clear();
    await db.kv.put({
      key: 'serverSync.aliases',
      value: { '0b8f6a0e-1111-4c2e-8d1a-0000000000bb': 'chat-made-elsewhere' },
    });
    await writeFromServer(
      'chats',
      [
        {
          id: '0b8f6a0e-1111-4c2e-8d1a-0000000000bb',
          userId: user.id,
          personId: 'x',
          stage: 'replied',
          stageEnteredAt: at,
          createdAt: at,
        },
      ],
      user.id,
    );
    expect(await db.chats.get('0b8f6a0e-1111-4c2e-8d1a-0000000000bb')).toBeUndefined();
    expect((await db.chats.get('chat-made-elsewhere'))!.stage).toBe('replied');
  });
});

describe('doubles already in the browser are healed', () => {
  /** The state the bug left: the rows made here, and the server's copies beside them. */
  async function doubled(over: { stage?: string } = {}) {
    const made = await addHere();
    await db.outbox.clear();
    const copies = serverCopies(made, over);
    await db.transaction('rw', db.people, db.chats, db.notes, async () => {
      await db.people.put({
        ...(await db.people.get(made.personId))!,
        ...copies.people[0]!,
        photoUrl: undefined,
      } as never);
      await db.chats.put({ ...copies.chats[0]!, updatedAt: at } as never);
      await db.notes.put({ ...copies.notes[0]!, updatedAt: at } as never);
    });
    // the setup's own writes are not edits waiting to go up
    await flushQueue();
    await db.outbox.clear();
    return made;
  }

  it('one person, one card, one note; what pointed at a copy points at the row; nothing goes up', async () => {
    const made = await doubled({ stage: 'contacted' });
    expect((await ids()).chats).toHaveLength(2);
    expect(await repairDoubledRows()).toBe(3);
    const now = await ids();
    expect(now.chats).toEqual([made.chatId]);
    expect(now.notes).toEqual([made.noteId]);
    expect(await db.people.get(serverIdOf(made.personId)!)).toBeUndefined();
    expect(await db.people.get(made.personId)).toMatchObject({ displayName: 'Shelby Haas-Sapp' });
    expect(await db.chats.get(made.chatId)).toMatchObject({ stage: 'contacted', personId: made.personId });
    expect(await db.notes.get(made.noteId)).toMatchObject({ personId: made.personId, chatId: made.chatId });
    expect(await db.outbox.count()).toBe(0);
    // healed for good: a second run finds nothing, and the next pull lands on the rows
    expect(await repairDoubledRows()).toBe(0);
    await writeFromServer('chats', serverCopies(made, { stage: 'replied' }).chats, user.id);
    expect((await ids()).chats).toEqual([made.chatId]);
    expect((await db.chats.get(made.chatId))!.stage).toBe('replied');
  });

  it('an edit made here that has not gone up yet is the one kept', async () => {
    const made = await doubled({ stage: 'contacted' });
    await db.chats.update(made.chatId, { stage: 'scheduled' });
    await new Promise((r) => setTimeout(r, 0));
    await flushQueue();
    expect(await db.outbox.get(`chats:${made.chatId}`)).toBeDefined();
    await repairDoubledRows();
    expect((await ids()).chats).toEqual([made.chatId]);
    expect((await db.chats.get(made.chatId))!.stage).toBe('scheduled');
    // and it still goes up
    expect(await db.outbox.get(`chats:${made.chatId}`)).toBeDefined();
  });

  it('a browser with no doubles is left exactly as it is', async () => {
    const made = await addHere();
    await db.chats.put({
      id: '0b8f6a0e-1111-4c2e-8d1a-0000000000cc',
      userId: user.id,
      personId: made.personId,
      stage: 'archived',
      stageEnteredAt: at,
      createdAt: at,
      updatedAt: at,
    } as unknown as CoffeeChat);
    const before = await ids();
    expect(await repairDoubledRows()).toBe(0);
    expect(await ids()).toEqual(before);
    void api;
  });
});
