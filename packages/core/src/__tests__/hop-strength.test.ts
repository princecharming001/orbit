import { describe, expect, it } from 'vitest';
import {
  hopBand,
  hopEvidence,
  pAsk,
  pairKeyOf,
  pairPhrase,
  type RoutePerson,
  rankWarmPaths,
  type WarmPathInput,
} from '../graph/route';
import {
  combineTies,
  decayedTieWeight,
  type EngagementItem,
  engagementScore,
  HOP_WEIGHTS,
  isRoutable,
  mergeTies,
  type PairEvidenceInput,
  pairEvidenceTies,
  pairFading,
  type Tie,
  type TiePair,
  withCommonContacts,
} from '../graph/ties';
import { functionOf, seniorityClass, seniorityFit } from '../graph/titles';

const NOW = new Date('2026-10-14T12:00:00Z');
const RECENT = '2026-08-01T00:00:00Z';
const MUTUAL = 0.3 * 0.95;
const nor = (...ws: number[]) => 1 - ws.reduce((a, w) => a * (1 - w), 1);

const rp = (id: string, score: number, extra: Partial<RoutePerson> = {}): RoutePerson => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  score,
  ...extra,
});

const tie = (
  a: string,
  b: string,
  kind: Tie['kind'],
  weight: number,
  confidence: number,
  evidence: Record<string, unknown> = {},
  lastSeenAt?: string,
  firstSeenAt?: string,
): Tie => {
  const [x, y] = a < b ? [a, b] : [b, a];
  return {
    id: `${x}|${y}|${kind}`,
    userId: 'u',
    aId: x,
    bId: y,
    kind,
    weight,
    confidence,
    evidence,
    lastSeenAt,
    firstSeenAt,
  };
};

/** n items of one kind from actor to other, on the other's posts, recent, popularity known */
const acts = (
  actorId: string,
  otherId: string,
  kind: EngagementItem['kind'],
  n: number,
  at: string | undefined = RECENT,
  postAuthorId = kind === 'reply' ? actorId : otherId,
): EngagementItem[] =>
  Array.from({ length: n }, (_, i) => ({
    actorId,
    otherId,
    kind,
    postAuthorId,
    postId: `${actorId}-${otherId}-${kind}-${i}`,
    commentId: kind === 'comment' || kind === 'reply' ? `c-${actorId}-${otherId}-${i}` : undefined,
    at,
  }));

const evidence = (extra: Partial<PairEvidenceInput>, people: string[]): Tie[] =>
  pairEvidenceTies({ userId: 'u', people: new Set(people), now: NOW, ...extra });

const followersOf = (entries: [string, number][]) => new Map(entries);

const routeInput = (
  people: RoutePerson[],
  pairs: Map<string, TiePair>,
  extra: Partial<WarmPathInput> = {},
): WarmPathInput => ({
  targetId: 'arlan',
  people: new Map(people.map((p) => [p.id, p])),
  pairs,
  now: NOW,
  goal: 'advice',
  ...extra,
});

const mutual = (id: string) => ({ introducerId: id, kind: 'linkedin_mutual' as const });

describe('engagement (plan 21 §3.3)', () => {
  const known = followersOf([
    ['a', 1000],
    ['b', 1000],
  ]);
  const score = (items: EngagementItem[], followers = known) =>
    engagementScore(items, { followers, now: NOW });

  it('matches the worked values', () => {
    expect(score(acts('a', 'b', 'reaction', 1)).w).toBeCloseTo(0.025, 3);
    expect(score(acts('a', 'b', 'reaction', 6)).w).toBeCloseTo(0.136, 3);
    expect(score(acts('a', 'b', 'comment', 1)).w).toBeCloseTo(0.213, 3);
    expect(score(acts('a', 'b', 'comment', 3)).w).toBe(HOP_WEIGHTS.engagement.oneWayCap);
    const replied = score([...acts('a', 'b', 'comment', 1), ...acts('b', 'a', 'reply', 1)]);
    expect(replied.reciprocal).toBe(true);
    expect(replied.E).toBeCloseTo(2.5, 10);
    expect(replied.w).toBeCloseTo(0.424, 3);
    expect(score([...acts('a', 'b', 'comment', 3), ...acts('b', 'a', 'comment', 3)]).w).toBe(0.5);
  });

  it('caps reactions, one-way and reciprocal engagement (acceptance 5)', () => {
    const likes = score(acts('a', 'b', 'reaction', 20));
    expect(likes.E).toBe(HOP_WEIGHTS.engagement.reactionCap);
    expect(likes.w).toBeCloseTo(0.213, 3);
    expect(score(acts('a', 'b', 'comment', 10)).w).toBe(0.25);
    expect(score([...acts('a', 'b', 'comment', 10), ...acts('b', 'a', 'comment', 10)]).w).toBe(0.5);
    // reactions both ways are not reciprocity: only something written is
    expect(score([...acts('a', 'b', 'reaction', 9), ...acts('b', 'a', 'reaction', 9)]).reciprocal).toBe(
      false,
    );
  });

  it('discounts popular authors: likes linearly, comments by the square root (acceptance 3)', () => {
    const small = MUTUAL;
    const lift = (followers: number) =>
      nor(MUTUAL, score(acts('a', 'b', 'reaction', 6), followersOf([['b', followers]])).w * 0.9) - small;
    expect(lift(1000)).toBeGreaterThanOrEqual(0.08);
    expect(lift(100_000)).toBeLessThan(0.01);
    const comments = score(acts('a', 'b', 'comment', 3), followersOf([['b', 30_000]]));
    expect(comments.E).toBeCloseTo(3 * Math.sqrt(2000 / 30_000), 10);
    expect(comments.w).toBeCloseTo(0.171, 3);
  });

  it('never lets an unknown audience lift a hop past "connected"', () => {
    const both = [...acts('a', 'b', 'comment', 5), ...acts('b', 'a', 'comment', 5)];
    const s = score(both, new Map());
    expect(s.popularityKnown).toBe(false);
    expect(s.w).toBeLessThanOrEqual(HOP_WEIGHTS.engagement.oneWayCap);
    expect(hopBand(nor(MUTUAL, s.w * 0.9))).toBe('connected');
  });

  it('weighs old and undated items at 0.35 of fresh ones, on E (acceptance 4)', () => {
    const fresh = score(acts('a', 'b', 'comment', 1)).E;
    expect(score(acts('a', 'b', 'comment', 1, '2024-01-01T00:00:00Z')).E).toBeCloseTo(0.35 * fresh, 10);
    expect(score(acts('a', 'b', 'comment', 1, '2025-06-01T00:00:00Z')).E).toBeCloseTo(0.6 * fresh, 10);
    const undated = acts('a', 'b', 'comment', 1).map((i) => ({ ...i, at: undefined }));
    expect(score(undated).E).toBeCloseTo(0.35 * fresh, 10);
  });

  it('halves a serial liker’s reactions and counts each act once', () => {
    const items = acts('a', 'b', 'reaction', 6);
    const liker = engagementScore(items, {
      followers: known,
      reactionVolume: new Map([['a', 90]]),
      now: NOW,
    });
    expect(liker.E).toBeCloseTo(score(items).E / 2, 10);
    expect(score([...items, ...items]).E).toBeCloseTo(score(items).E, 10);
    expect(score([...items, ...items]).counts.a!.reactions).toBe(6);
  });
});

describe('pair evidence ties (plan 21 §3.2)', () => {
  it('makes engagement, recommendations, mentions and the student’s word into ties between known people only', () => {
    const ties = evidence(
      {
        engagement: [...acts('a', 'b', 'comment', 2), ...acts('a', 'stranger', 'comment', 2)],
        followers: followersOf([['b', 500]]),
        recommendations: [{ authorId: 'a', subjectId: 'c', year: 2025, caption: 'x'.repeat(200) }],
        mentions: [
          { authorId: 'b', mentionedId: 'c', postId: 'p1', at: RECENT, tagged: 1 },
          { authorId: 'a', mentionedId: 'b', postId: 'p2', at: RECENT, tagged: 20 },
        ],
        studentSays: [{ aId: 'c', bId: 'a', at: RECENT }],
      },
      ['a', 'b', 'c'],
    );
    const kinds = ties.map((t) => `${t.aId}|${t.bId}|${t.kind}`).sort();
    expect(kinds).toEqual([
      'a|b|linkedin_engagement',
      'a|b|linkedin_mention',
      'a|c|linkedin_recommendation',
      'a|c|student_says_close',
      'b|c|linkedin_mention',
    ]);
    const rec = ties.find((t) => t.kind === 'linkedin_recommendation')!;
    expect(rec.evidence.caption).toHaveLength(80);
    expect(ties.find((t) => t.id === 'a|b|linkedin_mention')!.weight).toBeCloseTo(0.6 / 19, 10);
    expect(ties.find((t) => t.id === 'b|c|linkedin_mention')!.weight).toBeCloseTo(0.6, 10);
  });

  it('a recommendation is a strong hop on its own, and fades over five-year half-lives (acceptance 7)', () => {
    const ties = evidence({ recommendations: [{ authorId: 'a', subjectId: 'b', year: 2026 }] }, ['a', 'b']);
    // 0.85 × 0.95 = 0.81 when written, a little less a few months on: "close" on its own
    const w0 = combineTies(ties, NOW).get('a|b')!.weight;
    expect(w0).toBeGreaterThan(0.75);
    expect(hopBand(w0)).toBe('close');
    const old = evidence({ recommendations: [{ authorId: 'a', subjectId: 'b', year: 2015 }] }, [
      'a',
      'b',
    ])[0]!;
    const w = decayedTieWeight(old, NOW);
    expect(w).toBeGreaterThan(0.15);
    expect(w).toBeLessThan(0.2);
  });

  it('support-only kinds never create a route (acceptance 9)', () => {
    const ties = evidence(
      {
        engagement: [...acts('a', 'b', 'comment', 5), ...acts('b', 'a', 'comment', 5)],
        followers: followersOf([
          ['a', 100],
          ['b', 100],
        ]),
        mentions: [{ authorId: 'a', mentionedId: 'b', postId: 'p', at: RECENT, tagged: 1 }],
      },
      ['a', 'b'],
    );
    const pair = combineTies(ties, NOW).get('a|b')!;
    expect(pair.confidence).toBeGreaterThan(0.5);
    expect(isRoutable(pair)).toBe(false);
    // and with a real kind, the pair routes
    expect(
      isRoutable(
        mergeTies(new Map([['a|b', pair]]), [tie('a', 'b', 'co_tenure', 0.5, 0.6)], NOW).get('a|b')!,
      ),
    ).toBe(true);
    const r = rankWarmPaths(
      routeInput(
        [rp('a', 70), rp('arlan', 0)],
        combineTies(
          evidence(
            { engagement: [...acts('a', 'arlan', 'comment', 4), ...acts('arlan', 'a', 'comment', 4)] },
            ['a', 'arlan'],
          ),
          NOW,
        ),
      ),
    );
    expect(r.paths).toEqual([]);
  });

  it('merging is idempotent and leaves the input alone', () => {
    const base = combineTies([tie('a', 'b', 'email_exchange', 0.6, 0.95, {}, RECENT)], NOW);
    const add = evidence({ studentSays: [{ aId: 'a', bId: 'b' }] }, ['a', 'b']);
    const once = mergeTies(base, add, NOW);
    expect(mergeTies(once, add, NOW).get('a|b')!.weight).toBeCloseTo(once.get('a|b')!.weight, 12);
    expect(base.get('a|b')!.kinds).toEqual(['email_exchange']);
  });
});

describe('common contacts (plan 21 §3.6)', () => {
  it('counts each common contact at the weaker of its two real ties, only on routable pairs', () => {
    const pairs = combineTies(
      [
        tie('a', 'b', 'linkedin_mutual', 0.3, 0.95),
        tie('a', 'c', 'email_exchange', 0.6, 0.95, {}, RECENT),
        tie('b', 'c', 'email_cc', 0.45, 0.85, {}, RECENT),
        // an affiliation alone is not a real tie: d is no common contact
        tie('a', 'd', 'same_current_company', 0.35, 0.35),
        tie('b', 'd', 'same_current_company', 0.35, 0.35),
      ],
      NOW,
    );
    const out = withCommonContacts(pairs, NOW);
    const cc = out.get('a|b')!.ties.find((t) => t.kind === 'common_contacts')!;
    const weaker = decayedTieWeight(tie('b', 'c', 'email_cc', 0.45, 0.85, {}, RECENT), NOW) * 0.85;
    expect(cc.evidence).toMatchObject({ n: 1, ids: ['c'] });
    expect(cc.weight).toBeCloseTo(0.5 * (1 - Math.exp(-weaker / 2)), 6);
    expect(out.get('a|d')!.kinds).not.toContain('common_contacts');
    // computing twice adds nothing
    expect(withCommonContacts(out, NOW).get('a|b')!.weight).toBeCloseTo(out.get('a|b')!.weight, 12);
  });
});

describe('routes weigh every hop (plan 21 §11)', () => {
  const recip = (a: string, b: string, n = 3) =>
    evidence(
      {
        engagement: [...acts(a, b, 'comment', n), ...acts(b, a, 'comment', n)],
        followers: followersOf([
          [a, 900],
          [b, 1500],
        ]),
      },
      [a, b],
    );
  const oneWay = (a: string, b: string, n = 3) =>
    evidence({ engagement: acts(a, b, 'comment', n), followers: followersOf([[b, 1500]]) }, [a, b]);
  const people = [rp('noah', 65), rp('jai', 40), rp('arlan', 0)];

  it('the weakest hop decides, when the evidence is real (acceptance 1)', () => {
    const r = rankWarmPaths(
      routeInput(people, combineTies(recip('jai', 'arlan'), NOW), {
        candidates: [mutual('noah'), mutual('jai')],
      }),
    );
    expect(r.paths.map((p) => p.firstHopId)).toEqual(['jai', 'noah']);
    const [jai, noah] = r.paths;
    expect(noah!.p).toBeCloseTo(pAsk({ score: 65 }) * MUTUAL, 10);
    expect(noah!.p).toBeCloseTo(0.184, 3);
    expect(jai!.p).toBeCloseTo(pAsk({ score: 40 }) * nor(MUTUAL, 0.5 * 0.9), 10);
    expect(jai!.p).toBeCloseTo(0.243, 3);
    expect(jai!.hops[1]).toMatchObject({ kind: 'linkedin_mutual', band: 'know' });
    expect(noah!.hops[1]).toMatchObject({ band: 'connected' });
    expect(jai!.reasonText).toContain(
      'Jai is connected to Arlan on LinkedIn, and trades comments with Arlan on LinkedIn',
    );
    expect(noah!.reasonText).toContain('Noah is connected to Arlan on LinkedIn.');
  });

  it('fandom does not (acceptance 2)', () => {
    const r = rankWarmPaths(
      routeInput(people, combineTies(oneWay('jai', 'arlan'), NOW), {
        candidates: [mutual('noah'), mutual('jai')],
      }),
    );
    expect(r.paths.map((p) => p.firstHopId)).toEqual(['noah', 'jai']);
    const jai = r.paths[1]!;
    expect(jai.p).toBeCloseTo(0.179, 3);
    expect(jai.hops[1]!.band).toBe('connected');
    expect(jai.reasonText).toContain('has left 3 comments on Arlan’s posts');
  });

  it('a long route names its weak link and ranks below a sound short one (acceptance 6)', () => {
    const pairs = combineTies(
      [
        tie('amy', 'bo', 'email_exchange', 0.9, 0.95, { threads: 2 }, RECENT),
        tie('bo', 'arlan', 'linkedin_mutual', 0.3, 0.95),
        tie('cy', 'arlan', 'email_exchange', 0.6, 0.95, { threads: 1 }, RECENT),
      ],
      NOW,
    );
    const r = rankWarmPaths(routeInput([rp('amy', 70), rp('bo', 0), rp('cy', 70), rp('arlan', 0)], pairs));
    const long = r.paths.find((p) => p.nodes.length === 4)!;
    const short = r.paths.find((p) => p.nodes.length === 3)!;
    expect(short.p - long.p).toBeGreaterThan(0.05);
    expect(long.hops.slice(1).map((h) => h.band)).toEqual(['close', 'connected']);
    expect(long.reasonText).toContain('The weak link: Bo is connected to Arlan on LinkedIn.');
    expect(short.reasonText).not.toContain('weak link');
  });

  it('the student’s word wins: a blocked pair is no route, "close" lifts a plain connection (acceptance 8)', () => {
    const pairs = combineTies(recip('jai', 'arlan'), NOW);
    const blocked = new Set([pairKeyOf('jai', 'arlan')]);
    const r = rankWarmPaths(
      routeInput(people, pairs, { candidates: [mutual('noah'), mutual('jai')], blockedPairs: blocked }),
    );
    expect(r.paths.map((p) => p.firstHopId)).toEqual(['noah']);
    const close = mergeTies(
      new Map(),
      evidence({ studentSays: [{ aId: 'noah', bId: 'arlan' }] }, ['noah', 'arlan']),
      NOW,
    );
    const c = rankWarmPaths(routeInput(people, close, { candidates: [mutual('noah')] }));
    expect(c.paths[0]!.hops[1]!.band).toBe('close');
    expect(c.paths[0]!.hops[1]!.kind).toBe('student_says_close');
    expect(c.paths[0]!.reasonText).toContain('Noah is close to Arlan (you said)');
  });

  it('silence never lowers a connection (§3.4)', () => {
    // Arlan is popular and Noah never touched his posts: the hop is the plain connection, no less
    const r = rankWarmPaths(routeInput(people, new Map(), { candidates: [mutual('noah')] }));
    expect(r.paths[0]!.hops[1]!.p).toBeCloseTo(MUTUAL, 10);
  });
});

describe('fading (plan 21, tie decay)', () => {
  it('flags a pair whose evidence went quiet for eight of its usual gaps', () => {
    const quiet = tie(
      'a',
      'b',
      'email_exchange',
      0.7,
      0.95,
      { threads: 4 },
      '2024-04-01T00:00:00Z',
      '2024-01-01T00:00:00Z',
    );
    expect(pairFading(combineTies([quiet], NOW).get('a|b')!, NOW)).toBe(true);
    const live = tie('a', 'b', 'email_exchange', 0.7, 0.95, { threads: 4 }, RECENT, '2026-05-01T00:00:00Z');
    expect(pairFading(combineTies([live], NOW).get('a|b')!, NOW)).toBe(false);
    // two events are not a rhythm
    const few = tie(
      'a',
      'b',
      'email_exchange',
      0.7,
      0.95,
      { threads: 2 },
      '2024-04-01T00:00:00Z',
      '2024-01-01T00:00:00Z',
    );
    expect(pairFading(combineTies([few], NOW).get('a|b')!, NOW)).toBe(false);
  });
});

describe('vocabulary (plan 21 §7, acceptance 10)', () => {
  const t = (kind: Tie['kind'], ev: Record<string, unknown>) => tie('a', 'b', kind, 0.5, 0.9, ev);
  it('phrases every new kind from either side', () => {
    expect(hopEvidence('a', t('linkedin_recommendation', { authorId: 'a' }), 'Bo')).toBe(
      'recommended Bo on LinkedIn',
    );
    expect(hopEvidence('b', t('linkedin_recommendation', { authorId: 'a' }), 'Al')).toBe(
      'was recommended on LinkedIn by Al',
    );
    expect(hopEvidence('a', t('linkedin_mention', { authorId: 'a' }), 'Bo')).toBe(
      'mentioned Bo in a LinkedIn post',
    );
    expect(hopEvidence('a', t('student_says_close', {}), 'Bo')).toBe('is close to Bo (you said)');
    expect(hopEvidence('a', t('common_contacts', { n: 3 }), 'Bo')).toBe('has 3 contacts in common with Bo');
    const counts = (a: Record<string, number>, b: Record<string, number>) => ({ counts: { a, b } });
    expect(
      hopEvidence(
        'a',
        t('linkedin_engagement', { reciprocal: true, ...counts({ comments: 2 }, { comments: 1 }) }),
        'Bo',
      ),
    ).toBe('trades comments with Bo on LinkedIn');
    expect(hopEvidence('a', t('linkedin_engagement', counts({ comments: 1 }, { replies: 1 })), 'Bo')).toBe(
      'has had a reply from Bo on LinkedIn',
    );
    expect(hopEvidence('a', t('linkedin_engagement', counts({ comments: 3 }, {})), 'Bo')).toBe(
      'has left 3 comments on Bo’s posts',
    );
    expect(hopEvidence('b', t('linkedin_engagement', counts({ comments: 3 }, {})), 'Al')).toBe(
      'has had 3 comments from Al on their posts',
    );
    expect(hopEvidence('a', t('linkedin_engagement', counts({ reactions: 6 }, {})), 'Bo')).toBe(
      'has reacted to 6 posts by Bo',
    );
    expect(hopEvidence('a', t('linkedin_engagement', counts({ reposts: 1 }, {})), 'Bo')).toBe(
      'has reposted Bo',
    );
  });

  it('a pair’s phrase is its carrying evidence, plus its best support', () => {
    const pair = combineTies(
      [
        tie('a', 'b', 'linkedin_mutual', 0.3, 0.95),
        t('linkedin_engagement', { counts: { a: { comments: 2 } } }),
      ],
      NOW,
    ).get('a|b')!;
    expect(pairPhrase('a', pair, 'Bo', NOW)).toBe(
      'is connected to Bo on LinkedIn, and has left 2 comments on Bo’s posts',
    );
    const plain = combineTies([tie('a', 'b', 'linkedin_mutual', 0.3, 0.95)], NOW).get('a|b')!;
    expect(pairPhrase('a', plain, 'Bo', NOW)).toBe('is connected to Bo on LinkedIn');
  });

  it('bands are pinned', () => {
    expect([0.7, 0.65, 0.6, 0.5, 0.45, 0.2, 0.19].map(hopBand)).toEqual([
      'close',
      'close',
      'know',
      'know',
      'connected',
      'connected',
      'unclear',
    ]);
  });
});

describe('titles (plan 21 §3.6)', () => {
  it('classes seniority and function, and says when two titles are peers', () => {
    expect(seniorityClass('Co-founder & CEO')).toBe(2);
    expect(seniorityClass('VP Engineering')).toBe(1);
    expect(seniorityClass('Software Engineer')).toBe(0);
    expect(seniorityClass('')).toBeUndefined();
    expect(functionOf('Senior Software Engineer')).toBe('engineering');
    expect(functionOf('Account Executive')).toBe('sales');
    expect(seniorityFit('Analyst', 'Associate')).toBe('same');
    expect(seniorityFit('Analyst', 'Managing Director')).toBe('gap');
    expect(seniorityFit('Analyst', 'Director')).toBeUndefined();
  });
});
