/**
 * Memory in this browser (plan 17 §G): the same calls as account mode, kept in the `memories` table; recall ranked
 * by MiniSearch relevance, importance and recency.
 */
import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { createLocalUser } from './account';
import { forget, listMemories, remember, rememberedLines, searchMemories } from './memory';
import { LOCAL_MEMORY_MAX, localRemember, localSearch, sameMemory } from './memoryLocal';

let user: User;
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));

beforeEach(async () => {
  await wipeDatabase();
  setOrbitApiBaseForTests(null);
  user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex' });
});
afterEach(() => setOrbitApiBaseForTests(undefined));

describe('local memory: remember, list, forget', () => {
  it('keeps what the student said with its words, kind, importance and turn, and lists newest first', async () => {
    const a = await localRemember(
      user.id,
      {
        text: 'Prefers morning calls',
        kind: 'preference',
        quote: 'I prefer morning calls',
        importance: 0.6,
        source: 'rules',
        sourceTurn: { conversationId: 'c1', seq: 3 },
      },
      day(1),
    );
    expect(a?.deduped).toBe(false);
    await localRemember(
      user.id,
      { text: 'Targeting PM internships in New York', kind: 'goal_detail' },
      day(2),
    );
    const row = await db.memories.get(a!.memory.id);
    expect(row).toMatchObject({
      userId: user.id,
      kind: 'preference',
      quote: 'I prefer morning calls',
      source: 'rules',
      sourceTurn: { conversationId: 'c1', seq: 3 },
      createdAt: day(1).toISOString(),
    });
    const r = await listMemories(user);
    expect(r.ok && r.memories.map((m) => m.text)).toEqual([
      'Targeting PM internships in New York',
      'Prefers morning calls',
    ]);
  });

  it('refreshes a memory it already has instead of keeping two, and takes the longer wording', async () => {
    await remember(user, { text: 'Prefers morning calls', kind: 'preference' });
    const again = await remember(user, { text: 'prefers morning calls.', kind: 'preference' });
    expect(again.ok && again.deduped).toBe(true);
    const longer = await localRemember(user.id, {
      text: 'Targeting PM internships at fintech startups in New York',
      kind: 'goal_detail',
    });
    const shorter = await localRemember(user.id, {
      text: 'Targeting PM internships at fintech startups',
      kind: 'goal_detail',
    });
    expect(shorter?.deduped).toBe(true);
    expect((await db.memories.get(longer!.memory.id))?.text).toBe(
      'Targeting PM internships at fintech startups in New York',
    );
    expect(await db.memories.count()).toBe(2);
    expect(sameMemory('Prefers morning calls', 'Prefers evening calls')).toBe(false);
  });

  it('forgets for good: the words are blanked and the memory is gone from every list', async () => {
    const r = await remember(user, { text: 'Prefers morning calls', kind: 'preference' });
    if (!r.ok) throw new Error(r.message);
    expect((await forget(user, r.memory.id)).ok).toBe(true);
    const row = await db.memories.get(r.memory.id);
    expect(row?.text).toBe('');
    expect(row?.deletedAt).toBeDefined();
    const list = await listMemories(user);
    expect(list.ok && list.memories).toEqual([]);
    expect((await forget(user, r.memory.id)).ok).toBe(false);
  });

  it('never keeps a sensitive topic Orbit read by itself, but keeps one the student asked it to remember', async () => {
    expect(
      await localRemember(user.id, { text: 'Was diagnosed with ADHD', kind: 'note', source: 'rules' }),
    ).toBeUndefined();
    expect(
      await localRemember(user.id, { text: 'Is Catholic', kind: 'note', source: 'chat' }),
    ).toBeUndefined();
    const asked = await remember(user, {
      text: 'Fasts during Ramadan, no lunch meetings',
      kind: 'constraint',
    });
    expect(asked.ok).toBe(true);
  });

  it('keeps at most 500, dropping the least important and longest unseen first', async () => {
    await db.memories.bulkAdd(
      Array.from({ length: LOCAL_MEMORY_MAX }, (_, i) => ({
        id: `m${i}`,
        userId: user.id,
        kind: 'note' as const,
        text: `Fact number ${i} zz${i}`,
        importance: i === 0 ? 0.1 : 0.5,
        source: 'rules' as const,
        createdAt: day(1).toISOString(),
        lastSeenAt: day(1).toISOString(),
      })),
    );
    await localRemember(user.id, { text: 'Prefers morning calls', kind: 'preference' }, day(5));
    const list = await listMemories(user);
    expect(list.ok && list.memories.length).toBe(LOCAL_MEMORY_MAX);
    expect((await db.memories.get('m0'))?.deletedAt).toBeDefined();
  }, 30_000);
});

describe('local recall', () => {
  beforeEach(async () => {
    await localRemember(
      user.id,
      { text: 'Prefers morning calls', kind: 'preference', importance: 0.6 },
      day(1),
    );
    await localRemember(
      user.id,
      {
        text: 'Targeting product manager internships at fintech startups in New York',
        kind: 'goal_detail',
        importance: 0.8,
      },
      day(2),
    );
    await localRemember(
      user.id,
      { text: 'Cannot do calls on Fridays', kind: 'constraint', importance: 0.7 },
      day(3),
    );
    await localRemember(user.id, { text: 'Interned at Amma Health', kind: 'note', importance: 0.6 }, day(4));
  });

  it('ranks by what the query is about, with prefixes and small typos', async () => {
    const calls = await localSearch(user.id, 'what times work for calls', { now: day(5) });
    expect(
      calls
        .slice(0, 2)
        .map((m) => m.text)
        .sort(),
    ).toEqual(['Cannot do calls on Fridays', 'Prefers morning calls']);
    const intern = await searchMemories(user, 'internship goals');
    expect(intern.ok && intern.memories[0]!.text).toMatch(/^Targeting product manager internships/);
    const typo = await localSearch(user.id, 'fintch', { now: day(5), onlyMatches: true });
    expect(typo.map((m) => m.text)).toEqual([
      'Targeting product manager internships at fintech startups in New York',
    ]);
  });

  it('weighs importance and recency when relevance ties', async () => {
    await localRemember(
      user.id,
      { text: 'Prefers calls on Zoom', kind: 'preference', importance: 0.9 },
      day(20),
    );
    const r = await localSearch(user.id, 'calls', { now: day(21) });
    expect(r[0]!.text).toBe('Prefers calls on Zoom');
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score);
  });

  it('recall says nothing for a query nothing matches, and everything for "what do you remember"', async () => {
    const none = await searchMemories(user, 'GPA');
    expect(none.ok && none.memories).toEqual([]);
    const all = await searchMemories(user, 'preferences and goals');
    expect(all.ok && all.memories).toHaveLength(4);
  });

  it('gives the chat its Remembered lines with ids, the closest first, within the budget', async () => {
    const lines = await rememberedLines(user, 'who should I ask about fintech internships?', {
      maxChars: 120,
    });
    expect(lines[0]).toMatch(/^mem_\S+ Targeting product manager internships/);
    expect(lines.join('; ').length).toBeLessThanOrEqual(120);
    expect(await rememberedLines(user, '')).toEqual([]);
  });
});
