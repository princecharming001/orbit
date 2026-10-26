import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { createLocalUser } from './account';
import { listGoals, saveGoal } from './goals';
import { saveOwnWords } from './ownWords';

describe('saving the student own words (plan 24)', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('keeps each answer in the goals row and puts the aim and the win on the recruiting goal', async () => {
    const u = await createLocalUser({ fullName: 'Sam Okafor', school: 'Michigan' });
    await saveGoal(u, { kind: 'recruiting', source: 'onboarding' });
    await saveOwnWords(u, { aim: '  PM at fintechs. ', success: 'Five chats by November.' });
    const row = await db.goals.get(u.id);
    expect(row).toMatchObject({ aim: 'PM at fintechs.', success: 'Five chats by November.' });
    let [g] = await listGoals(u.id);
    expect(g).toMatchObject({ description: 'PM at fintechs.', successMetric: 'Five chats by November.' });
    // another answer leaves these alone; clearing the aim clears the description it wrote
    await saveOwnWords(u, { neverDo: 'No exclamation marks.' });
    await saveOwnWords(u, { aim: '' });
    expect((await db.goals.get(u.id))?.aim).toBeUndefined();
    expect((await db.goals.get(u.id))?.neverDo).toBe('No exclamation marks.');
    [g] = await listGoals(u.id);
    expect(g?.description).toBe('');
    expect(g?.successMetric).toBe('Five chats by November.');
  });

  it('never replaces a description the goal got some other way', async () => {
    const u = await createLocalUser({ fullName: 'Sam Okafor', school: 'Michigan' });
    await saveGoal(u, { kind: 'recruiting', description: 'Written in the chat' });
    await saveOwnWords(u, { aim: 'PM at fintechs.' });
    expect((await listGoals(u.id))[0]?.description).toBe('Written in the chat');
  });
});
