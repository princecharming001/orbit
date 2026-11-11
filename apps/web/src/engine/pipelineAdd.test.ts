import { newId, type Person } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { addToPipeline } from './pipelineAdd';

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
