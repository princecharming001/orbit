/**
 * Plan 21 in the browser: LinkedIn activity read for one target (order, cache, budget, privacy), turned into pair
 * evidence, and the routes and "People who know them" weighed by it, with the student's word on top.
 */
import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, type EngagementRow, wipeDatabase } from '../db/schema';
import { buildReachGraph, mutualStandings, reachPersonIn } from './graph';
import {
  checkHops,
  checkState,
  ENGAGEMENT_FRESH_MS,
  type EngagementPage,
  evidenceFrom,
  forgetEngagement,
  type HopReader,
  type ReadOutcome,
  resetHopEvidenceForTests,
} from './hopEvidence';
import { clearPairNote, pairNotesFor, setPairNote } from './pairNotes';

const NOW = new Date('2026-10-20T15:00:00Z');
const RECENT = '2026-09-01T00:00:00Z';
/** when the activity was read: within the last thirty days */
const READ = '2026-10-15T00:00:00Z';

const user: User = {
  id: 'u1',
  email: 'ravi@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: [],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => {
  const [firstName, ...rest] = name.split(' ');
  return {
    id,
    userId: user.id,
    displayName: name,
    firstName: firstName!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['linkedin_csv'],
    isHuman: true,
    tags: [],
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    linkedinConnectedOn: '2024-01-01',
    ...extra,
  };
};

// Arlan is the target (not connected to the student); Noah knows the student well, Jai less so; both are mutuals
const ARLAN = person('p_arlan', 'Arlan Rakhmetzhanov', {
  linkedinMemberId: 'm_arlan',
  linkedinConnectedOn: undefined,
});
const NOAH = person('p_noah', 'Noah Kim', { linkedinMemberId: 'm_noah', strength: 0.65 });
const JAI = person('p_jai', 'Jai Patel', { linkedinMemberId: 'm_jai', strength: 0.4 });
const mutuals = [NOAH, JAI];
const candidates = mutuals.map((m) => ({ introducerId: m.id, kind: 'linkedin_mutual' as const }));

/** A fake LinkedIn: pages by member and want, a profile per member, a call log, and an optional daily allowance. */
function fakeReader(
  pages: Record<string, Partial<Record<string, EngagementPage['items']>>>,
  profiles: Record<string, { followers?: number }> = {},
  allowance = Number.POSITIVE_INFINITY,
): HopReader & { calls: string[] } {
  const calls: string[] = [];
  const spend = <T>(label: string, v: () => ReadOutcome<T>): ReadOutcome<T> => {
    if (calls.length >= allowance) return { ok: false, reason: 'limit', message: 'limit' };
    calls.push(label);
    return v();
  };
  return {
    calls,
    async page(memberId, want, postId) {
      return spend(`${memberId}:${want}${postId ? `:${postId}` : ''}`, () => {
        const items = pages[memberId]?.[want === 'thread' ? `thread:${postId}` : want];
        if (items === undefined && pages[memberId] === undefined)
          return { ok: false, reason: 'unavailable', message: 'hidden' };
        return { ok: true, value: { want, items: items ?? [] } as EngagementPage };
      });
    },
    async profile(memberId) {
      return spend(`${memberId}:profile`, () => ({ ok: true, value: profiles[memberId] ?? {} }));
    },
  };
}

/** Arlan's posts, and Jai and Arlan commenting on each other's posts; Noah silent. */
const linkedIn = () =>
  fakeReader(
    {
      m_arlan: {
        posts: [
          { id: 'a1', at: RECENT, mentions: [], tagged: 0 },
          { id: 'a2', at: RECENT, mentions: [], tagged: 0 },
        ],
        reactions: [],
        comments: [
          { id: 'ac1', postId: 'j1', at: RECENT },
          { id: 'ac2', postId: 'a1', at: RECENT, threadId: 'jc1' },
        ],
        'thread:a1': [{ id: 'jc1', commenterId: 'm_jai', at: RECENT }],
        'thread:a2': [{ id: 'jc2', commenterId: 'm_jai', at: RECENT }],
      },
      m_jai: {
        reactions: [{ postId: 'a2', authorId: 'm_arlan' }],
        comments: [
          { id: 'jc1', postId: 'a1', at: RECENT },
          { id: 'jc2', postId: 'a2', at: RECENT },
        ],
      },
      m_noah: { reactions: [], comments: [] },
    },
    { m_arlan: { followers: 1500 }, m_jai: { followers: 900 }, m_noah: { followers: 700 } },
  );

beforeEach(async () => {
  await wipeDatabase();
  resetHopEvidenceForTests();
  await db.users.put(user);
  await db.people.bulkPut([ARLAN, NOAH, JAI]);
});
afterEach(() => resetHopEvidenceForTests());

describe('checkHops (plan 21 §4)', () => {
  it('reads the target first (profile, posts, reactions, comments), then each mutual, then the target’s threads', async () => {
    const r = linkedIn();
    const out = await checkHops(user, ARLAN, [JAI, NOAH], { reader: r, now: NOW });
    expect(out).toEqual({ calls: 12, limited: false, failed: [] });
    expect(r.calls).toEqual([
      'm_arlan:profile',
      'm_arlan:posts',
      'm_arlan:reactions',
      'm_arlan:comments',
      'm_jai:reactions',
      'm_jai:comments',
      'm_jai:profile',
      'm_noah:reactions',
      'm_noah:comments',
      'm_noah:profile',
      'm_arlan:thread:a1',
      'm_arlan:thread:a2',
    ]);
    expect((await db.people.get(ARLAN.id))!.linkedinFollowers).toBe(1500);
    expect(checkState('m_jai')).toBe('done');
  });

  it('reads nothing fresh twice, and a mutual read for one target serves the next', async () => {
    const r = linkedIn();
    await checkHops(user, ARLAN, [JAI, NOAH], { reader: r, now: NOW });
    const first = r.calls.length;
    await checkHops(user, ARLAN, [JAI, NOAH], { reader: r, now: new Date(NOW.getTime() + 86_400_000) });
    expect(r.calls.length).toBe(first);
    // thirty days on, it reads again
    await checkHops(user, ARLAN, [JAI, NOAH], {
      reader: r,
      now: new Date(NOW.getTime() + ENGAGEMENT_FRESH_MS + 1),
    });
    expect(r.calls.length).toBeGreaterThan(first);
  });

  it('stops when LinkedIn’s allowance runs out, keeps what it read, and says the rest was not checked', async () => {
    const r = fakeReader(
      { m_arlan: { posts: [], reactions: [], comments: [] }, m_jai: {}, m_noah: {} },
      {},
      5,
    );
    const out = await checkHops(user, ARLAN, [JAI, NOAH], { reader: r, now: NOW });
    expect(out.limited).toBe(true);
    expect(r.calls).toHaveLength(5);
    expect(checkState('m_arlan')).toBe('done');
    expect(checkState('m_noah')).toBe('not_checked');
    expect((await db.engagement.get(`${user.id}:m_arlan`))?.posts).toEqual([]);
  });

  it('marks a person whose activity LinkedIn hides, and does not ask again for a month', async () => {
    const r = fakeReader({ m_arlan: { posts: [], reactions: [], comments: [] } });
    await checkHops(user, ARLAN, [JAI], { reader: r, now: NOW });
    expect((await db.engagement.get(`${user.id}:m_jai`))?.unavailableAt).toBe(NOW.toISOString());
    const before = r.calls.length;
    await checkHops(user, ARLAN, [JAI], { reader: r, now: new Date(NOW.getTime() + 86_400_000) });
    expect(r.calls.slice(before).filter((c) => c.startsWith('m_jai:'))).toEqual([]);
  });

  it('needs the target’s member id, and keeps no one’s words', async () => {
    const r = linkedIn();
    expect(await checkHops(user, { ...ARLAN, linkedinMemberId: undefined }, mutuals, { reader: r })).toEqual({
      calls: 0,
      limited: false,
      failed: [],
    });
    await checkHops(user, ARLAN, mutuals, { reader: r, now: NOW });
    const rows = await db.engagement.toArray();
    expect(JSON.stringify(rows)).not.toMatch(/"text"/);
  });

  it('forgets everything read on disconnect', async () => {
    await checkHops(user, ARLAN, mutuals, { reader: linkedIn(), now: NOW });
    expect(await db.engagement.count()).toBeGreaterThan(0);
    await forgetEngagement(user.id);
    expect(await db.engagement.count()).toBe(0);
  });
});

describe('evidenceFrom', () => {
  it('matches comments to the post’s author, finds the author’s replies, and drops people Orbit does not have', () => {
    const rows: EngagementRow[] = [
      {
        id: 'u1:m_arlan',
        userId: 'u1',
        memberId: 'm_arlan',
        postsAt: READ,
        threadsAt: READ,
        commentsAt: READ,
        posts: [
          { id: 'a1', at: RECENT, mentions: ['m_noah', 'm_stranger'], tagged: 2 },
          { id: 'a3', at: RECENT, repostOf: 'm_jai', mentions: [], tagged: 0 },
        ],
        comments: [{ id: 'ac2', postId: 'a1', at: RECENT, threadId: 'jc1' }],
        threads: {
          a1: [
            { id: 'jc1', commenterId: 'm_jai', at: RECENT },
            { id: 'xc', commenterId: 'm_stranger' },
          ],
        },
      },
      {
        id: 'u1:m_jai',
        userId: 'u1',
        memberId: 'm_jai',
        reactionsAt: READ,
        commentsAt: READ,
        reactions: [
          { postId: 'a1', authorId: 'm_arlan' },
          { postId: 'zz', authorId: 'm_stranger' },
        ],
        comments: [{ id: 'jc1', postId: 'a1', at: RECENT }],
      },
    ];
    const ev = evidenceFrom(
      rows,
      [ARLAN, NOAH, JAI, { ...ARLAN, id: 'p_x', linkedinMemberId: undefined }],
      NOW,
    );
    const items = ev.engagement!.map((i) => `${i.actorId}>${i.otherId}:${i.kind}`).sort();
    expect(items).toEqual([
      'p_arlan>p_jai:reply',
      'p_arlan>p_jai:repost',
      // the thread and Jai's own comments page name the same comment: core counts it once (by comment id)
      'p_jai>p_arlan:comment',
      'p_jai>p_arlan:comment',
      'p_jai>p_arlan:reaction',
    ]);
    expect(ev.engagement!.find((i) => i.kind === 'reaction')!.at).toBe(RECENT);
    expect(ev.mentions).toEqual([
      { authorId: 'p_arlan', mentionedId: 'p_noah', postId: 'a1', at: RECENT, tagged: 2 },
    ]);
  });

  it('ignores reads older than thirty days, and turns profile recommendations into pairs', () => {
    const stale: EngagementRow = {
      id: 'u1:m_jai',
      userId: 'u1',
      memberId: 'm_jai',
      reactionsAt: '2026-08-01T00:00:00Z',
      reactions: [{ postId: 'a1', authorId: 'm_arlan' }],
    };
    const withRec = {
      ...NOAH,
      linkedinRecommendations: [{ direction: 'received' as const, actorMemberId: 'm_arlan', year: 2025 }],
    };
    const ev = evidenceFrom([stale], [ARLAN, withRec, JAI], NOW);
    expect(ev.engagement).toEqual([]);
    expect(ev.recommendations).toEqual([
      { authorId: 'p_arlan', subjectId: 'p_noah', year: 2025, caption: undefined },
    ]);
  });
});

describe('routes and People who know them, weighed by every hop (plan 21 §11)', () => {
  it('ranks Jai, who trades comments with Arlan, above Noah, who is only connected — and the student can undo it', async () => {
    let { g } = await buildReachGraph(user.id, NOW);
    let paths = reachPersonIn(g, ARLAN.id, 3, candidates);
    // before any reading: the student's own ties decide
    expect(paths.map((p) => p.hops[0]!.toId)).toEqual([NOAH.id, JAI.id]);

    await checkHops(user, ARLAN, [JAI, NOAH], { reader: linkedIn(), now: NOW });
    ({ g } = await buildReachGraph(user.id, NOW));
    paths = reachPersonIn(g, ARLAN.id, 3, candidates);
    expect(paths.map((p) => p.hops[0]!.toId)).toEqual([JAI.id, NOAH.id]);
    const jaiHop = paths[0]!.hops[1]!;
    expect(jaiHop.band).toBe('know');
    expect(jaiHop.text).toBe(
      'Jai is connected to Arlan on LinkedIn, and trades comments with Arlan on LinkedIn',
    );
    expect(paths[1]!.hops[1]!).toMatchObject({
      band: 'connected',
      text: 'Noah is connected to Arlan on LinkedIn',
    });

    const standing = mutualStandings(g, ARLAN.id, [NOAH.id, JAI.id]);
    expect(standing.get(JAI.id)!.ask * standing.get(JAI.id)!.know).toBeGreaterThan(
      standing.get(NOAH.id)!.ask * standing.get(NOAH.id)!.know,
    );
    expect(standing.get(JAI.id)!.band).toBe('know');

    // the student says Jai and Arlan don't really know each other: Jai's route goes, and comes back on undo
    await setPairNote(user.id, JAI.id, ARLAN.id, 'blocked', NOW);
    ({ g } = await buildReachGraph(user.id, NOW));
    expect(reachPersonIn(g, ARLAN.id, 3, candidates).map((p) => p.hops[0]!.toId)).toEqual([NOAH.id]);
    expect(mutualStandings(g, ARLAN.id, [JAI.id]).get(JAI.id)!.blocked).toBe(true);
    await clearPairNote(user.id, JAI.id, ARLAN.id, 'blocked');
    ({ g } = await buildReachGraph(user.id, NOW));
    expect(reachPersonIn(g, ARLAN.id, 3, candidates)).toHaveLength(2);
  });

  it('"they’re close" lifts a plain connection, and replaces a block on the same pair', async () => {
    await setPairNote(user.id, NOAH.id, ARLAN.id, 'blocked', NOW);
    await setPairNote(user.id, NOAH.id, ARLAN.id, 'close', NOW);
    const notes = await pairNotesFor(user.id);
    expect(notes.blocked.size).toBe(0);
    expect(notes.close).toHaveLength(1);
    const { g } = await buildReachGraph(user.id, NOW);
    const noah = reachPersonIn(g, ARLAN.id, 3, candidates).find((p) => p.hops[0]!.toId === NOAH.id)!;
    expect(noah.hops[1]!.band).toBe('close');
    expect(noah.hops[1]!.text).toContain('Noah is close to Arlan (you said)');
  });

  it('never lowers a connection for silence: Noah with no engagement reads exactly as a LinkedIn connection', async () => {
    await checkHops(user, ARLAN, [NOAH], { reader: linkedIn(), now: NOW });
    const { g } = await buildReachGraph(user.id, NOW);
    const noah = reachPersonIn(g, ARLAN.id, 3, candidates).find((p) => p.hops[0]!.toId === NOAH.id)!;
    expect(noah.hops[1]!.weight).toBeCloseTo(0.3 * 0.95, 10);
  });
});
