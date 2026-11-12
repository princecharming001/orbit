import { describe, expect, it } from 'vitest';
import {
  bridgeStatuses,
  type CircleAccount,
  type ListRead,
  type LookupState,
  type LookupStep,
  listComplete,
  nextLookupStep,
} from '../graph/socialLookup';

/**
 * Plan 43 §3.6 and §8.3: a fake platform with a known follow graph. The lookup must find every bridge and invent none,
 * never say "no one" from a list it did not finish, stop early only when that is safe, and read as little as it can.
 */

type Graph = Map<string, Set<string>>; // who each account follows

function makeGraph(edges: [string, string][]): Graph {
  const g: Graph = new Map();
  for (const [a, b] of edges) {
    if (!g.has(a)) g.set(a, new Set());
    g.get(a)!.add(b);
  }
  return g;
}
const following = (g: Graph, a: string) => g.get(a) ?? new Set<string>();
const followers = (g: Graph, a: string) => new Set([...g].filter(([, f]) => f.has(a)).map(([x]) => x));

/** Run the lookup against the graph, counting reads, the way the server job will. */
function run(
  g: Graph,
  target: string,
  circle: CircleAccount[],
  opts: {
    platform?: 'instagram' | 'x';
    student?: string;
    privateTarget?: boolean;
    truncate?: Set<string>;
  } = {},
): { step: Extract<LookupStep, { do: 'done' }>; reads: string[] } {
  const platform = opts.platform ?? 'instagram';
  const student = opts.student ?? 'me';
  const read = (ids: Set<string>, key: string): ListRead => {
    // a list the platform stopped returning part way: what came back holds nobody in the circle
    if (opts.truncate?.has(key)) return { ids: new Set(), ended: false, total: ids.size };
    return { ids, ended: true, total: ids.size };
  };
  const state: LookupState = {
    platform,
    targetAccountId: target,
    circle,
    target: { followerCount: followers(g, target).size, followingCount: following(g, target).size },
    candidates: new Map(),
    profileRead: false,
    tried: new Set<string>(),
  };
  const cands = state.candidates as Map<string, LookupState['target']>;
  const reads: string[] = [];
  for (let i = 0; i < 50; i++) {
    const step = nextLookupStep(state);
    if (step.do === 'done') return { step, reads };
    if (step.do === 'profile') {
      reads.push('profile');
      state.profileRead = true;
      state.target.isPrivate = !!opts.privateTarget;
      state.count = [...following(g, student)].filter((a) => following(g, a).has(target)).length;
      continue;
    }
    const key = `${step.accountId}.${step.list}`;
    reads.push(key);
    (state.tried as Set<string>).add(key);
    const ids = step.list === 'following' ? following(g, step.accountId) : followers(g, step.accountId);
    if (step.accountId === target) state.target[step.list] = read(ids, key);
    else {
      const cur = cands.get(step.accountId) ?? {};
      cands.set(step.accountId, { ...cur, [step.list]: read(ids, key) });
    }
  }
  throw new Error('lookup did not finish');
}

const c = (accountId: string, studentFollows = true): CircleAccount => ({
  accountId,
  personId: `p-${accountId}`,
  studentFollows,
});

describe('the mutual lookup (plan 43 §3.6)', () => {
  it('finds every bridge and invents none', () => {
    const g = makeGraph([
      ['me', 'maya'],
      ['maya', 'me'],
      ['me', 'omar'],
      ['omar', 'me'],
      ['me', 'lena'],
      ['maya', 'priya'],
      ['priya', 'maya'], // bridge
      ['omar', 'priya'], // a fan of priya
      ['priya', 'lena'], // priya follows lena, lena does not follow back
      ['priya', 'celeb'],
      ['x1', 'priya'],
      ['x2', 'priya'],
    ]);
    const { step } = run(g, 'priya', [c('maya'), c('omar'), c('lena')]);
    expect(step.bridges.map((b) => b.accountId)).toEqual(['maya']);
    expect(step.oneWay.map((b) => b.accountId).sort()).toEqual(['lena', 'omar']);
    expect(step.partial).toBe(false);
  });

  it('stops after one call when the count is zero and the whole circle is followed', () => {
    const g = makeGraph([
      ['me', 'maya'],
      ['maya', 'me'],
      ['priya', 'maya'],
    ]);
    const { step, reads } = run(g, 'priya', [c('maya')]);
    expect(reads).toEqual(['profile']);
    expect(step.bridges).toEqual([]);
    expect(step.reason).toBe('none');
  });

  it('does not trust a zero count when a circle account is one the student does not follow', () => {
    // the student texts Omar and his account is attached, but the student does not follow it: Instagram's count cannot see him
    const g = makeGraph([
      ['omar', 'priya'],
      ['priya', 'omar'],
    ]);
    const { step, reads } = run(g, 'priya', [c('omar', false)]);
    expect(reads[0]).toBe('profile');
    expect(reads.length).toBeGreaterThan(1);
    expect(step.bridges.map((b) => b.accountId)).toEqual(['omar']);
  });

  it('never says no one from a list it did not finish', () => {
    const g = makeGraph([
      ['me', 'maya'],
      ['maya', 'me'],
      ['maya', 'priya'],
      ['priya', 'maya'],
      ['a', 'priya'],
      ['b', 'priya'],
    ]);
    const { step } = run(g, 'priya', [c('maya')], {
      truncate: new Set(['priya.following', 'priya.followers', 'maya.following', 'maya.followers']),
    });
    expect(step.reason).toBeUndefined();
    expect(step.bridges).toEqual([]);
    expect(step.partial).toBe(true);
  });

  it('reads the shorter of the target lists first', () => {
    const edges: [string, string][] = [
      ['me', 'maya'],
      ['maya', 'me'],
      ['maya', 'priya'],
      ['priya', 'maya'],
    ];
    for (let i = 0; i < 40; i++) edges.push([`fan${i}`, 'priya']);
    const { reads } = run(makeGraph(edges), 'priya', [c('maya')]);
    expect(reads.slice(0, 2)).toEqual(['profile', 'priya.following']);
  });

  it('checks from the candidate side when the target lists are too long to read', () => {
    const edges: [string, string][] = [
      ['me', 'maya'],
      ['maya', 'me'],
      ['maya', 'star'],
      ['star', 'maya'],
    ];
    for (let i = 0; i < 2100; i++) {
      edges.push([`fan${i}`, 'star']);
      edges.push(['star', `pick${i}`]);
    }
    const { step, reads } = run(makeGraph(edges), 'star', [c('maya')]);
    expect(reads).not.toContain('star.followers');
    expect(reads).not.toContain('star.following');
    expect(reads.some((r) => r.startsWith('maya.'))).toBe(true);
    expect(step.bridges.map((b) => b.accountId)).toEqual(['maya']);
  });

  it('stops at a private target', () => {
    const g = makeGraph([
      ['me', 'maya'],
      ['maya', 'me'],
      ['maya', 'priya'],
      ['priya', 'maya'],
    ]);
    const { step, reads } = run(g, 'priya', [c('maya')], { privateTarget: true });
    expect(reads).toEqual(['profile']);
    expect(step.reason).toBe('private');
  });

  it('on X, with no count, still finds bridges by the lists', () => {
    const g = makeGraph([
      ['me', 'maya'],
      ['maya', 'me'],
      ['maya', 'priya'],
      ['priya', 'maya'],
    ]);
    const { step, reads } = run(g, 'priya', [c('maya')], { platform: 'x' });
    expect(reads).not.toContain('profile');
    expect(step.bridges.map((b) => b.accountId)).toEqual(['maya']);
  });

  it('answers from lists another student already completed, with no read at all', () => {
    const state: LookupState = {
      platform: 'instagram',
      targetAccountId: 'priya',
      circle: [c('maya')],
      target: {
        following: { ids: new Set(['maya']), ended: true, total: 1 },
        followers: { ids: new Set(['maya', 'x']), ended: true, total: 2 },
      },
      candidates: new Map(),
      profileRead: false,
    };
    const step = nextLookupStep(state);
    expect(step.do).toBe('done');
    expect(step.do === 'done' && step.bridges.map((b) => b.accountId)).toEqual(['maya']);
  });

  it('has nothing to do without a circle', () => {
    expect(
      nextLookupStep({
        platform: 'instagram',
        targetAccountId: 't',
        circle: [],
        target: {},
        candidates: new Map(),
        profileRead: false,
      }),
    ).toMatchObject({
      do: 'done',
      reason: 'no_circle',
    });
  });

  it('counts a list as complete only when it ended and holds nine tenths of the count', () => {
    expect(listComplete(undefined)).toBe(false);
    expect(listComplete({ ids: new Set(['a']), ended: false, total: 1 })).toBe(false);
    expect(
      listComplete({ ids: new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']), ended: true, total: 10 }),
    ).toBe(true);
    expect(listComplete({ ids: new Set(['a', 'b']), ended: true, total: 10 })).toBe(false);
    expect(listComplete({ ids: new Set(), ended: true })).toBe(true);
  });

  it('reads both directions from what it holds', () => {
    const s: LookupState = {
      platform: 'x',
      targetAccountId: 't',
      circle: [c('a'), c('b')],
      target: { following: { ids: new Set(['a']), ended: true } },
      candidates: new Map([['b', { following: { ids: new Set(['t']), ended: true } }]]),
      profileRead: true,
    };
    const byId = Object.fromEntries(bridgeStatuses(s).map((b) => [b.accountId, b]));
    expect(byId.a).toMatchObject({ targetFollows: 'yes', followsTarget: 'unknown' });
    expect(byId.b).toMatchObject({ targetFollows: 'no', followsTarget: 'yes' });
  });
});
