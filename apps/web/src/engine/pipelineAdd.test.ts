import { newId, type Person } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { addToPipeline, oneCardEach } from './pipelineAdd';

const user = { id: 'u_pipe' };
async function person(over: Partial<Person> = {}): Promise<Person> {
  const now = new Date().toISOString();
  const p = {
    id: newId('p'),
    userId: user.id,
    displayName: 'Priya Shah',
    firstName: 'Priya',
    primaryEmail: 'priya@evercore.com',
    emails: ['priya@evercore.com'],
    isHuman: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Person;
  await db.people.add(p);
  return p;
}

describe('addToPipeline (Add a person)', () => {
  it('puts someone on the pipeline at To contact once, and keeps a card they already have', async () => {
    const p = await person();
    const a = await addToPipeline(user, p.id);
    expect(a).toMatchObject({ added: true, chat: { stage: 'identified', outreachChannel: 'gmail' } });
    const b = await addToPipeline(user, p.id);
    expect(b).toMatchObject({ added: false });
    expect(b!.chat.id).toBe(a!.chat.id);
    expect(await db.chats.where('personId').equals(p.id).count()).toBe(1);
    const events = await db.stageEvents.where('chatId').equals(a!.chat.id).toArray();
    expect(events.map((e) => e.toStage)).toEqual(['identified']);
  });
  it('an archived chat does not count; LinkedIn only is reached on LinkedIn; never another student’s person', async () => {
    const p = await person({
      primaryEmail: undefined,
      emails: [],
      linkedinUrl: 'https://www.linkedin.com/in/x',
    });
    const now = new Date().toISOString();
    await db.chats.add({
      id: newId('c'),
      userId: user.id,
      personId: p.id,
      stage: 'archived',
      stageEnteredAt: now,
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: now,
      updatedAt: now,
    });
    const r = await addToPipeline(user, p.id);
    expect(r).toMatchObject({ added: true, chat: { stage: 'identified', outreachChannel: 'linkedin' } });
    const other = await person({ userId: 'u_other' });
    expect(await addToPipeline(user, other.id)).toBeUndefined();
  });
});

describe('oneCardEach (the board never shows a person twice)', () => {
  const U = '0b8f6a0e-1111-4c2e-8d1a-0000000000';
  const chat = (id: string, personId: string, stage: string, updatedAt: string) =>
    ({ id, personId, stage, updatedAt }) as never as {
      id: string;
      personId: string;
      stage: 'identified';
      updatedAt: string;
    };

  it('the same card stored twice, and the same person stored twice, are one card: the one touched last', () => {
    const cards = oneCardEach([
      // the card made here and the server's copy of it
      chat(`c_${U}01`, `p_${U}a1`, 'identified', '2026-11-22T09:00:00Z'),
      chat(`${U}01`, `${U}a1`, 'contacted', '2026-11-23T09:00:00Z'),
      // someone else, once
      chat(`c_${U}02`, `p_${U}a2`, 'identified', '2026-11-22T09:00:00Z'),
    ]);
    expect(cards.map((c) => [c.id, c.stage])).toEqual([
      [`${U}01`, 'contacted'],
      [`c_${U}02`, 'identified'],
    ]);
  });

  it('two open cards for one person made in a race are one; their archived history all stays', () => {
    const cards = oneCardEach([
      chat('c1', 'p1', 'identified', '2026-11-22T09:00:00Z'),
      chat('c2', 'p1', 'identified', '2026-11-22T09:00:01Z'),
      chat('c0', 'p1', 'archived', '2026-10-01T09:00:00Z'),
      chat('c00', 'p1', 'archived', '2026-09-01T09:00:00Z'),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['c2', 'c0', 'c00']);
  });

  it('a board with no doubles is unchanged, in the same order', () => {
    const all = [
      chat('c1', 'p1', 'identified', 'a'),
      chat('c2', 'p2', 'replied', 'b'),
      chat('c3', 'p3', 'archived', 'c'),
    ];
    expect(oneCardEach(all)).toEqual(all);
  });
});
