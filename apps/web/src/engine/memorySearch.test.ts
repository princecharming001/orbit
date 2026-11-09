import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ calls: [] as { route: string; body: unknown }[] }));

vi.mock('../integrations/orbitApi', async (orig) => ({
  ...(await orig<typeof import('../integrations/orbitApi')>()),
  isServerUser: () => true,
  callApi: async (route: string, body: unknown) => {
    api.calls.push({ route, body });
    if (route === '/memory/search')
      return {
        ok: true,
        value: { memories: [{ id: 'mem_1', text: 'Wants fintech', kind: 'goal_detail', score: 1 }] },
      };
    if (route === '/memory/add')
      return { ok: true, value: { memory: { id: 'mem_2', text: 'x', kind: 'note' }, deduped: false } };
    return { ok: false, message: 'no' };
  },
}));

import {
  MEMORY_SEARCH_KEEP_MS,
  remember,
  rememberedLines,
  resetMemorySearchMemo,
  searchMemories,
} from './memory';

const user = { id: 'u_server' };
const searches = () => api.calls.filter((c) => c.route === '/memory/search').length;

beforeEach(() => {
  api.calls = [];
  resetMemorySearchMemo();
  vi.useRealTimers();
});

describe('memory search on the server (plan 34 B3)', () => {
  it('asks once for the same words within ten minutes, and again after', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-09T12:00:00Z') });
    await searchMemories(user, 'Fintech internships in NYC');
    await searchMemories(user, '  fintech   internships in nyc ');
    expect(searches()).toBe(1);
    vi.setSystemTime(Date.now() + MEMORY_SEARCH_KEEP_MS + 1);
    await searchMemories(user, 'Fintech internships in NYC');
    expect(searches()).toBe(2);
  });

  it('a new memory clears what was kept', async () => {
    await searchMemories(user, 'Fintech internships in NYC');
    await remember(user, { text: 'Prefers mornings', kind: 'preference' });
    await searchMemories(user, 'Fintech internships in NYC');
    expect(searches()).toBe(2);
  });

  it('skips the search for a few words like "ok thanks"', async () => {
    expect(await rememberedLines(user, 'ok thanks')).toEqual([]);
    expect(searches()).toBe(0);
    expect(await rememberedLines(user, 'who should I write to at Stripe')).toEqual(['mem_1 Wants fintech']);
    expect(searches()).toBe(1);
  });
});
