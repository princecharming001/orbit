import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from './account';
import { cleanUpGuesses } from './cleanup';

async function person(user: User, name: string, patch: Record<string, unknown> = {}) {
  const [first, last] = name.split(' ');
  const id = newId('p');
  await db.people.put({
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: last ?? '',
    nameNormalized: name.toLowerCase(),
    emails: [`${first!.toLowerCase()}@x.com`],
    sources: ['gmail'],
    isHuman: true,
    strength: 0.2,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...patch,
  } as never);
  return id;
}

async function chat(user: User, personId: string) {
  const id = newId('c');
  await db.chats.put({
    id,
    userId: user.id,
    personId,
    stage: 'identified',
    stageEnteredAt: '2026-10-01T00:00:00Z',
    source: 'detected',
    goalTags: [],
    outreachChannel: 'gmail',
    bumpCount: 0,
    priority: 2,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  } as never);
  return id;
}

describe('cleaning up what older versions guessed', () => {
  beforeEach(async () => {
    await wipeDatabase();
  });

  it('removes chats from mail the student never answered, keeps the ones they wrote in, and runs once', async () => {
    const user = await createLocalUser({ fullName: 'Sam Lee', school: 'Cornell University' });
    const cold = await person(user, 'Vonetta Donmore');
    const real = await person(user, 'Ana Ruiz');
    const coldChat = await chat(user, cold);
    const realChat = await chat(user, real);
    await db.touchpoints.put({
      id: newId('tp'),
      userId: user.id,
      personId: real,
      kind: 'email_out',
      occurredAt: '2026-10-02T00:00:00Z',
      refTable: 'messages',
      refId: 'm1',
      weight: 0.6,
    });
    await db.suggestions.put({
      id: newId('s'),
      userId: user.id,
      personId: cold,
      chatId: coldChat,
      kind: 'confirm_stage',
      status: 'pending',
      dedupeKey: 'k1',
      priorityScore: 1,
      payload: {},
      reasonText: 'Looks like Vonetta replied. Mark this chat as replied?',
      createdAt: '2026-10-02T00:00:00Z',
    } as never);
    const stats = await cleanUpGuesses(user);
    expect(stats?.chats).toBe(1);
    expect(await db.chats.get(coldChat)).toBeUndefined();
    expect(await db.chats.get(realChat)).toBeDefined();
    expect(await db.suggestions.where('chatId').equals(coldChat).count()).toBe(0);
    expect(await cleanUpGuesses(user)).toBeUndefined();
  });

  it('takes the alum label off people known only by a school address', async () => {
    const user = await createLocalUser({ fullName: 'Sam Lee', school: 'Cornell University' });
    const prof = await person(user, 'Dana Wu', { isAlumni: true, school: 'Cornell University' });
    await cleanUpGuesses(user);
    expect((await db.people.get(prof))?.isAlumni).toBe(false);
  });

  it('leaves the demo alone', async () => {
    const demo = await createLocalUser({ id: 'demo-user', fullName: 'Alex Rivera' });
    expect(await cleanUpGuesses(demo)).toBeUndefined();
  });
});
