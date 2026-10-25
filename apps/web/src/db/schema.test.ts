import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { OrbitDB } from './schema';

const NAME = 'orbit-upgrade-test';

afterEach(async () => {
  await Dexie.delete(NAME);
});

describe('the browser database upgrade to version 8 (plan 24)', () => {
  it('moves the retired "Anything else?" into what the student is going for, after an aim already there', async () => {
    // a database as version 7 left it: goals with the free text
    const old = new Dexie(NAME);
    old.version(7).stores({ goals: 'userId' });
    await old.open();
    await old.table('goals').bulkPut([
      { userId: 'u1', cycleLabel: 'Summer 2027', targetFunctions: ['pm'], freeText: ' Small teams. ' },
      { userId: 'u2', cycleLabel: 'Summer 2027', targetFunctions: [], freeText: 'Mission first', aim: 'PM' },
      { userId: 'u3', cycleLabel: 'Summer 2027', targetFunctions: [], freeText: '   ' },
    ]);
    old.close();
    const db = new OrbitDB(NAME);
    await db.open();
    const rows = await db.goals.toArray();
    const by = new Map(rows.map((r) => [r.userId, r as unknown as Record<string, unknown>]));
    expect(by.get('u1')).toMatchObject({ aim: 'Small teams.', targetFunctions: ['pm'] });
    expect(by.get('u2')?.aim).toBe('PM\n\nMission first');
    expect(by.get('u3')?.aim).toBeUndefined();
    for (const r of rows) expect('freeText' in r).toBe(false);
    db.close();
  });
});
