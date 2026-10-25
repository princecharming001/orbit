import { combineTies } from '@orbit/core/graph/ties';
import { describe, expect, it } from 'vitest';
import {
  gatherHopEvidence,
  HOP_READS_PER_DAY,
  type HopBudget,
  type HopEvidenceDeps,
  type HopRef,
} from '../../functions/_shared/paths/hopEvidence';
import { introHopFeatures } from '../../functions/_shared/paths/outcomes';
import {
  createUnipileResearch,
  postKeys,
  profileSignals,
} from '../../functions/_shared/providers/unipileResearch';
import type { CacheDep } from '../../functions/_shared/research/deps';

// ---- small in-memory stand-ins (as apps/web/src/server/__tests__/fakes.ts) ------------------------------------------

interface Call {
  url: string;
  method: string;
}
type Route = (call: Call) => Response | Promise<Response> | undefined;

/** A fetch that answers from routes in order and records every call; an unmatched call is a 599. */
function fakeFetch(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? 'GET' };
    calls.push(call);
    for (const r of routes) {
      const res = await r(call);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: `no route for ${url}` }), { status: 599 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const instant = async () => {};
const DAY = 86_400_000;

function manualClock(start: number) {
  let t = start;
  return {
    clock: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function memoryCache(
  clock: () => number,
): CacheDep & { rows: Map<string, { response: unknown; expiresAt: Date }> } {
  const rows = new Map<string, { response: unknown; expiresAt: Date }>();
  return {
    rows,
    async get(userId, key) {
      const r = rows.get(`${userId}:${key}`);
      if (!r || r.expiresAt.getTime() <= clock()) return undefined;
      return structuredClone(r.response);
    },
    async put(userId, e) {
      rows.set(`${userId}:${e.key}`, { response: structuredClone(e.response), expiresAt: e.expiresAt });
    },
  };
}

const UNIPILE = 'https://api9.unipile.com:13999';
const START = Date.parse('2026-10-25T12:00:00Z');
const recent = (days: number) => new Date(START - days * DAY).toISOString();

const P = {
  arlan: 'a0000000-0000-4000-8000-000000000001',
  jai: 'a0000000-0000-4000-8000-000000000002',
  noah: 'a0000000-0000-4000-8000-000000000003',
  mia: 'a0000000-0000-4000-8000-000000000004',
  dana: 'a0000000-0000-4000-8000-000000000005',
};
const ARLAN: HopRef = { personId: P.arlan, memberId: 'ACoAArlan' };
const JAI: HopRef = { personId: P.jai, memberId: 'ACoAJai' };
const NOAH: HopRef = { personId: P.noah, memberId: 'ACoANoah' };

/** Text that must never be stored: comment text, post text, recommendation bodies. */
const SECRET = 'SECRET-TEXT';

function memoryBudget(limit = HOP_READS_PER_DAY): HopBudget & { spent: string[] } {
  const spent: string[] = [];
  return {
    spent,
    async take(accountId, _userId, ledger) {
      if (spent.length >= limit) return false;
      spent.push(`${accountId}:${ledger}`);
      return true;
    },
  };
}

/** Unipile as plan 21 reads it, for Arlan (the target), Jai (comments, Arlan replies), Noah (recommended Arlan). */
function linkedin(over: Record<string, unknown> = {}) {
  return fakeFetch((c: Call) => {
    const u = new URL(c.url);
    const path = u.pathname;
    if (path in over) return json(over[path]);
    switch (path) {
      case '/api/v1/users/ACoAArlan':
        return json({
          provider_id: 'ACoAArlan',
          follower_count: 1500,
          connections_count: 900,
          recommendations: {
            received: [
              {
                actor: { provider_id: 'ACoANoah', first_name: 'Noah' },
                caption:
                  'Noah managed Arlan directly at Figma, and this caption goes on past eighty characters',
                text: `${SECRET} a long recommendation body`,
                date: 'March 2019',
              },
              { actor: { provider_id: 'ACoAStranger' }, text: SECRET },
            ],
            given: [],
          },
        });
      case '/api/v1/users/ACoAArlan/posts':
        return json({
          items: [
            {
              id: '7001',
              social_id: 'urn:li:activity:7001001',
              parsed_datetime: recent(20),
              text: `${SECRET} post`,
              comment_counter: 3,
              reaction_counter: 40,
              mentions: [{ id: 'ACoAJai', name: 'Jai' }, { id: 'ACoAStranger' }],
            },
            {
              id: '7002',
              parsed_datetime: recent(40),
              is_repost: true,
              repost_content: { author: { id: 'ACoAJai' }, text: SECRET },
            },
            { id: '7003', parsed_datetime: recent(5), comment_counter: 0 },
          ],
        });
      case '/api/v1/users/ACoAArlan/reactions':
        return json({
          items: [
            { value: 'LIKE', post_id: 'urn:li:activity:9001001', author: { id: 'ACoAJai', type: 'PERSON' } },
            { value: 'LIKE', post_id: '9002002', author: { id: 'ACoAUnknown', type: 'PERSON' } },
          ],
        });
      case '/api/v1/users/ACoAArlan/comments':
        // Arlan's reply on his own post, in the thread of Jai's comment
        return json({
          items: [
            {
              id: '6660001',
              post_id: '7001',
              thread_id: '5550001',
              date: recent(18),
              text: `${SECRET} thanks Jai`,
            },
          ],
        });
      case '/api/v1/users/ACoAJai/reactions':
        return json({
          items: [{ value: 'LIKE', post_id: 'urn:li:activity:7001001', author: { id: 'ACoAArlan' } }],
        });
      case '/api/v1/users/ACoAJai/comments':
        return json({
          items: [{ id: '5550001', post_id: '7001', date: recent(19), text: `${SECRET} great post` }],
        });
      case '/api/v1/users/ACoANoah/reactions':
      case '/api/v1/users/ACoANoah/comments':
        return json({ items: [] });
      case '/api/v1/posts/7001/comments':
        return json({
          items: [
            {
              id: 'urn:li:comment:(urn:li:activity:7001001,5550001)',
              author_details: { id: 'ACoAJai', name: 'Jai' },
              date: recent(19),
              text: SECRET,
            },
            { id: '5550002', author_details: { id: 'ACoAStranger' }, text: SECRET },
          ],
        });
      default:
        if (/^\/api\/v1\/users\/[^/]+\/(posts|reactions|comments)$/.test(path)) return json({ items: [] });
        if (/^\/api\/v1\/users\/[^/]+$/.test(path)) return json({ provider_id: path.split('/').pop() });
        return undefined;
    }
  });
}

function setup(net = linkedin(), budget = memoryBudget()) {
  const time = manualClock(START);
  const cache = memoryCache(time.clock);
  const deps: HopEvidenceDeps = {
    unipile: createUnipileResearch({ fetch: net.fetch, apiKey: 'uk', baseUrl: UNIPILE, sleep: instant }),
    cache,
    budget,
    clock: time.clock,
    pace: instant,
  };
  return { net, cache, budget, time, deps };
}

const input = (mutuals: HopRef[] = [JAI, NOAH], followers: Record<string, number> = { [P.jai]: 800 }) => ({
  userId: 'u1',
  unipileAccountId: 'acc1',
  target: ARLAN,
  mutuals,
  followers,
});

const paths = (calls: Call[]) => calls.map((c) => new URL(c.url).pathname.replace('/api/v1', ''));

describe('hop evidence (plan 21 §4, account mode)', () => {
  it('reads in the plan’s order: target profile, target pages, mutuals’ pages, then the target’s threads', async () => {
    const s = setup();
    const r = await gatherHopEvidence(s.deps, input());
    expect(paths(s.net.calls)).toEqual([
      '/users/ACoAArlan',
      '/users/ACoAArlan/posts',
      '/users/ACoAArlan/reactions',
      '/users/ACoAArlan/comments',
      '/users/ACoAJai/reactions',
      '/users/ACoAJai/comments',
      '/users/ACoANoah/reactions',
      '/users/ACoANoah/comments',
      // only the commented, non-repost post; the reposted and the comment-less posts are not read
      '/posts/7001/comments',
    ]);
    expect(new URL(s.net.calls[0]!.url).searchParams.get('linkedin_sections')).toBe(
      'recommendations_received,recommendations_given',
    );
    expect(r.reads).toBe(9);
    expect(s.budget.spent).toHaveLength(9);
    expect(s.budget.spent.slice(0, 2)).toEqual(['acc1:profile', 'acc1:posts']);
    expect(r.complete).toBe(true);
    expect(r.target).toEqual({ followers: 1500, connections: 900 });
  });

  it('maps member ids to people and turns the evidence into ties; unknown member ids are dropped', async () => {
    const s = setup();
    const r = await gatherHopEvidence(s.deps, input());
    const ev = r.evidence;
    const people = new Set(
      [...(ev.engagement ?? []).flatMap((e) => [e.actorId, e.otherId, e.postAuthorId])].concat(
        (ev.mentions ?? []).flatMap((m) => [m.authorId, m.mentionedId]),
        (ev.recommendations ?? []).flatMap((x) => [x.authorId, x.subjectId]),
      ),
    );
    expect([...people].sort()).toEqual([P.arlan, P.jai, P.noah].sort());
    const kinds = (ev.engagement ?? [])
      .map((e) => `${e.actorId === P.arlan ? 'arlan' : 'jai'}:${e.kind}`)
      .sort();
    // Jai's reaction and comment (from his pages and again from the thread: one comment), Arlan's reply, reaction, repost
    expect(kinds).toEqual([
      'arlan:reaction',
      'arlan:reply',
      'arlan:repost',
      'jai:comment',
      'jai:comment',
      'jai:reaction',
    ]);
    const jaiComments = (ev.engagement ?? []).filter((e) => e.kind === 'comment');
    expect(new Set(jaiComments.map((e) => e.commentId)).size).toBe(1);
    // the reaction to Arlan's post is dated by the post; Arlan's reaction to Jai's post has no date
    expect((ev.engagement ?? []).find((e) => e.kind === 'reaction' && e.actorId === P.jai)?.at).toBe(
      recent(20),
    );
    expect(
      (ev.engagement ?? []).find((e) => e.kind === 'reaction' && e.actorId === P.arlan)?.at,
    ).toBeUndefined();
    expect(ev.mentions).toEqual([
      { authorId: P.arlan, mentionedId: P.jai, postId: '7001', at: recent(20), tagged: 2 },
    ]);
    expect(ev.recommendations).toEqual([
      {
        authorId: P.noah,
        subjectId: P.arlan,
        year: 2019,
        caption: 'Noah managed Arlan directly at Figma, and this caption goes on past eighty chara',
      },
    ]);
    expect(ev.followers?.get(P.arlan)).toBe(1500);
    expect(ev.reactionVolume?.get(P.jai)).toBe(1);

    const byKind = Object.fromEntries(
      r.ties.map((t) => [`${t.aId === P.arlan ? t.bId : t.aId}|${t.kind}`, t]),
    );
    expect(Object.keys(byKind).sort()).toEqual(
      [
        `${P.jai}|linkedin_engagement`,
        `${P.jai}|linkedin_mention`,
        `${P.noah}|linkedin_recommendation`,
      ].sort(),
    );
    const eng = byKind[`${P.jai}|linkedin_engagement`]!;
    expect(eng.evidence.reciprocal).toBe(true);
    expect(eng.evidence.popularityKnown).toBe(true);
    expect(eng.weight).toBeGreaterThan(0.25);
    expect(eng.weight).toBeLessThanOrEqual(0.5);
    expect(byKind[`${P.noah}|linkedin_recommendation`]!.weight).toBeCloseTo(0.85);
    // every (target, mutual) pair was checked for every kind
    expect(r.checked.map((c) => c.kinds)).toEqual([
      ['linkedin_engagement', 'linkedin_mention', 'linkedin_recommendation'],
      ['linkedin_engagement', 'linkedin_mention', 'linkedin_recommendation'],
    ]);
  });

  it('without the mutual’s follower count, engagement on their posts keeps the hop at the one-way cap', async () => {
    const s = setup();
    const r = await gatherHopEvidence(s.deps, input([JAI, NOAH], {}));
    const eng = r.ties.find((t) => t.kind === 'linkedin_engagement')!;
    expect(eng.evidence.popularityKnown).toBe(false);
    expect(eng.weight).toBeLessThanOrEqual(0.25);
  });

  it('one-way engagement (Jai on Arlan’s posts only) adds nothing to the pair, only to Jai’s side (core, directional)', async () => {
    const s = setup(
      linkedin({
        '/api/v1/users/ACoAArlan/comments': { items: [] },
        '/api/v1/users/ACoAArlan/reactions': { items: [] },
        '/api/v1/users/ACoAArlan/posts': {
          items: [{ id: '7001', parsed_datetime: recent(20), comment_counter: 3 }],
        },
      }),
    );
    const r = await gatherHopEvidence(s.deps, input());
    const eng = r.ties.find((t) => t.kind === 'linkedin_engagement')!;
    expect(eng.evidence.reciprocal).toBe(false);
    expect(eng.weight).toBe(0);
    const wBy = eng.evidence.wBy as Record<string, number>;
    expect(wBy[P.jai]).toBeGreaterThan(0);
    expect(wBy[P.arlan] ?? 0).toBe(0);
  });

  it('stores no comment text, post text or recommendation body, in the cache or in a tie', async () => {
    const s = setup();
    const r = await gatherHopEvidence(s.deps, input());
    const cached = JSON.stringify([...s.cache.rows.values()].map((x) => x.response));
    expect(cached).not.toContain(SECRET);
    expect(cached).not.toContain('great post');
    expect(JSON.stringify(r.ties)).not.toContain(SECRET);
    expect(JSON.stringify(r.evidence.recommendations)).not.toContain(SECRET);
  });

  it('reuses every page for 30 days: a repeat reads nothing, a second target reuses a shared mutual’s pages', async () => {
    const s = setup();
    await gatherHopEvidence(s.deps, input());
    const first = s.net.calls.length;
    const again = await gatherHopEvidence(s.deps, input());
    expect(s.net.calls.length).toBe(first);
    expect(again.reads).toBe(0);
    expect(again.cached).toBe(9);
    expect(again.ties.length).toBeGreaterThan(0);
    // another target Jai is a mutual of: Jai's reactions and comments come from the cache
    const dana: HopRef = { personId: P.dana, memberId: 'ACoADana' };
    const other = await gatherHopEvidence(s.deps, { ...input([JAI]), target: dana });
    const danaCalls = paths(s.net.calls.slice(first));
    expect(danaCalls).toEqual([
      '/users/ACoADana',
      '/users/ACoADana/posts',
      '/users/ACoADana/reactions',
      '/users/ACoADana/comments',
    ]);
    expect(other.cached).toBe(2);
    // 30 days later everything is read again
    s.time.advance(31 * DAY);
    const later = await gatherHopEvidence(s.deps, input());
    expect(later.reads).toBe(9);
  });

  it('stops at the daily budget and works with what it has; nothing past the stop is read', async () => {
    const s = setup(linkedin(), memoryBudget(5));
    const r = await gatherHopEvidence(s.deps, input());
    expect(r.reads).toBe(5);
    expect(r.stoppedBy).toBe('budget');
    expect(r.complete).toBe(false);
    expect(paths(s.net.calls)).toEqual([
      '/users/ACoAArlan',
      '/users/ACoAArlan/posts',
      '/users/ACoAArlan/reactions',
      '/users/ACoAArlan/comments',
      '/users/ACoAJai/reactions',
    ]);
    // Jai's side is half read: his engagement pair is not "checked", so a stored row will not be replaced
    const jai = r.checked.find((c) => c.aId === P.jai || c.bId === P.jai)!;
    expect(jai.kinds).not.toContain('linkedin_engagement');
    expect(jai.kinds).toContain('linkedin_recommendation');
    // the next day the cache carries the read pages and only the rest is read
    const s2 = { ...s.deps, budget: memoryBudget() };
    const next = await gatherHopEvidence(s2, input());
    expect(next.cached).toBe(5);
    expect(next.reads).toBe(4);
    expect(next.complete).toBe(true);
  });

  it('reads the top five mutuals only; the rest are matched from cached pages, never read', async () => {
    const s = setup();
    const many: HopRef[] = Array.from({ length: 7 }, (_, i) => ({
      personId: `b0000000-0000-4000-8000-00000000000${i}`,
      memberId: `ACoAM${i}`,
    }));
    const r = await gatherHopEvidence(s.deps, input(many));
    const read = paths(s.net.calls).filter((p) => p.startsWith('/users/ACoAM'));
    expect(read).toHaveLength(10);
    expect(read.some((p) => p.includes('ACoAM5') || p.includes('ACoAM6'))).toBe(false);
    expect(r.complete).toBe(true);
  });

  it('a private profile (422) is remembered as "could not check" for 30 days', async () => {
    const s = setup(
      fakeFetch(
        (c: Call) => (c.url.includes('/users/ACoAArlan?') ? json({ error: 'private' }, 422) : undefined),
        (c: Call) => (/\/users\/[^/]+\/\w+\?/.test(c.url) ? json({ items: [] }) : undefined),
        (c: Call) => (c.url.includes('/posts/') ? json({ items: [] }) : undefined),
      ),
    );
    const r = await gatherHopEvidence(s.deps, input());
    expect(r.errors).toEqual([]);
    expect(r.checked.every((c) => !c.kinds.includes('linkedin_recommendation'))).toBe(true);
    const before = s.net.calls.length;
    await gatherHopEvidence(s.deps, input());
    expect(s.net.calls.length).toBe(before);
  });

  it('a failed read is not cached and leaves the pair unchecked', async () => {
    const s = setup();
    const flaky = fakeFetch((c: Call) =>
      c.url.includes('/users/ACoAJai/comments') ? json({ error: 'boom' }, 400) : undefined,
    );
    const deps = {
      ...s.deps,
      unipile: createUnipileResearch({
        fetch: (async (url: string, init?: RequestInit) =>
          url.includes('/users/ACoAJai/comments')
            ? flaky.fetch(url, init)
            : s.net.fetch(url, init)) as typeof fetch,
        apiKey: 'uk',
        baseUrl: UNIPILE,
        sleep: instant,
      }),
    };
    const r = await gatherHopEvidence(deps, input());
    expect(r.errors.join(' ')).toContain('comments');
    expect(r.complete).toBe(false);
    const jai = r.checked.find((c) => c.aId === P.jai || c.bId === P.jai)!;
    expect(jai.kinds).not.toContain('linkedin_engagement');
  });

  it('feeds core: the pair reads stronger with the new ties, and support-only engagement never routes alone', async () => {
    const s = setup();
    const r = await gatherHopEvidence(s.deps, input());
    const pairs = combineTies(r.ties, new Date(START));
    const jai = [...pairs.values()].find((p) => p.aId === P.jai || p.bId === P.jai)!;
    expect(jai.kinds.sort()).toEqual(['linkedin_engagement', 'linkedin_mention']);
    expect(jai.weight).toBeGreaterThan(0.3);
  });
});

describe('Unipile engagement pages (plan 21 §2)', () => {
  it('maps posts, reactions, comments and threads to ids, dates and counts only', async () => {
    const net = linkedin();
    const u = createUnipileResearch({ fetch: net.fetch, apiKey: 'uk', baseUrl: UNIPILE, sleep: instant });
    const posts = await u.postsOf('acc1', 'ACoAArlan');
    expect(posts.ok && posts.value.items[0]).toEqual({
      id: '7001',
      keys: ['7001', 'urn:li:activity:7001001', '7001001'],
      at: recent(20),
      reactions: 40,
      comments: 3,
      repostOf: undefined,
      mentions: ['ACoAJai', 'ACoAStranger'],
    });
    expect(posts.ok && posts.value.items[1]!.repostOf).toBe('ACoAJai');
    expect(new URL(net.calls[0]!.url).searchParams.get('limit')).toBe('100');
    const reactions = await u.reactionsOf('acc1', 'ACoAArlan');
    expect(reactions.ok && reactions.value.items[0]).toEqual({
      postKeys: ['urn:li:activity:9001001', '9001001'],
      authorId: 'ACoAJai',
      onComment: false,
    });
    const comments = await u.commentsOf('acc1', 'ACoAArlan');
    expect(comments.ok && comments.value.items).toEqual([
      { id: '6660001', postKeys: ['7001'], threadId: '5550001', at: recent(18) },
    ]);
    const thread = await u.postComments('acc1', '7001');
    expect(thread.ok && thread.value.items[0]).toEqual({
      id: 'urn:li:comment:(urn:li:activity:7001001,5550001)',
      authorId: 'ACoAJai',
      at: recent(19),
    });
    expect(JSON.stringify([posts, reactions, comments, thread])).not.toContain(SECRET);
  });

  it('reads followers, connections and recommendations from a profile, never a recommendation body', () => {
    const s = profileSignals({
      follower_count: 12,
      connections_count: 34,
      throttled_sections: ['recommendations_given'],
      recommendations: {
        received: [{ actor: { provider_id: 'A' }, caption: 'Worked together', year: 2021, text: SECRET }],
        given: [{ author: { id: 'B' } }, { nobody: true }],
      },
    });
    expect(s).toEqual({
      followers: 12,
      connections: 34,
      received: [{ actorId: 'A', year: 2021, caption: 'Worked together' }],
      given: [{ actorId: 'B' }],
      recommendationsThrottled: true,
    });
    expect(postKeys('urn:li:comment:(urn:li:activity:1,2345678)')).toEqual([
      'urn:li:comment:(urn:li:activity:1,2345678)',
      '2345678',
    ]);
  });
});

describe('intro hop features (plan 21 §8)', () => {
  it('freezes P and each hop’s p, kind and band, cleaned of anything the client made up', () => {
    const f = introHopFeatures(
      {
        hops: [
          { fromId: 'user', toId: 'a', p: 0.7, kind: 'strength' },
          { fromId: 'a', toId: 'b', p: 0.61, kind: 'linkedin_engagement', band: 'close' },
          { fromId: 'b', toId: 'c', p: 7, kind: 'made_up' },
          { nope: true },
        ],
      },
      0.42,
    );
    expect(f).toEqual({
      p: 0.42,
      hops: [
        { fromId: 'user', toId: 'a', p: 0.7, kind: 'strength' },
        { fromId: 'a', toId: 'b', p: 0.61, kind: 'linkedin_engagement', band: 'know' },
        { fromId: 'b', toId: 'c', p: 1, kind: 'unknown', band: 'close' },
      ],
    });
    expect(introHopFeatures(null, 2)).toEqual({ p: 1, hops: [] });
  });
});
