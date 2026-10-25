/**
 * Plan 21 §11, the simulation: 200 synthetic targets, each with 5–30 LinkedIn mutuals whose true closeness to the
 * target is known, and the public evidence real people leave — sparse for colleagues (most never touch each other's
 * posts), loud for fans (who comment and react a lot on people who do not know them). The routes are ranked as the app
 * ranks them; the test checks they track the truth better than ranking by the student's own ties alone, that fans
 * never jump ahead of a colleague with real evidence, and that nothing gets worse where there is no evidence.
 *
 * The mixture and rates below are assumptions, not measurements: they are to be recalibrated from a real account's
 * sparsity (plan 21 §11). Seeded, so the numbers are stable.
 */
import { describe, expect, it } from 'vitest';
import { pAsk, type RoutePerson, rankWarmPaths } from '../graph/route';
import { combineTies, type EngagementItem, pairEvidenceTies, type Tie } from '../graph/ties';

const NOW = new Date('2026-10-14T12:00:00Z');

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

type Kind = 'colleague' | 'acquaintance' | 'fan';
interface Mutual {
  id: string;
  score: number;
  kind: Kind;
  /** true chance they would make the intro well */
  know: number;
  /** has any evidence beyond the connection */
  evidence: boolean;
}

function network(seed: number) {
  const r = rng(seed);
  const between = (lo: number, hi: number) => lo + r() * (hi - lo);
  const n = 5 + Math.floor(r() * 26);
  const followers = Math.round(10 ** between(2.7, 5)); // ~500 to 100,000
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const mutuals: Mutual[] = [];
  const engagement: EngagementItem[] = [];
  const recommendations: { authorId: string; subjectId: string; year?: number }[] = [];
  const ties: Tie[] = [];
  let post = 0;
  const act = (actor: string, other: string, kind: EngagementItem['kind'], count: number) => {
    for (let i = 0; i < count; i++) {
      post++;
      engagement.push({
        actorId: actor,
        otherId: other,
        kind,
        postAuthorId: kind === 'reply' ? actor : other,
        postId: `p${post}`,
        commentId: kind === 'comment' || kind === 'reply' ? `c${post}` : undefined,
        at: daysAgo(between(5, 500)),
      });
    }
  };
  for (let i = 0; i < n; i++) {
    const id = `m${i}`;
    const u = r();
    const kind: Kind = u < 0.2 ? 'colleague' : u < 0.7 ? 'acquaintance' : 'fan';
    const know =
      kind === 'colleague'
        ? between(0.6, 0.95)
        : kind === 'acquaintance'
          ? between(0.15, 0.4)
          : between(0, 0.12);
    let evidence = false;
    if (kind === 'colleague') {
      if (r() < 0.25) {
        act(id, 't', 'comment', 1 + Math.floor(r() * 3));
        act('t', id, r() < 0.5 ? 'comment' : 'reply', 1 + Math.floor(r() * 2));
        evidence = true;
      }
      if (r() < 0.3) {
        act(id, 't', 'reaction', 1 + Math.floor(r() * 6));
        evidence = true;
      }
      // the target engaging with a colleague's posts: the side that says the target knows them
      if (r() < 0.2) {
        act('t', id, r() < 0.5 ? 'comment' : 'reaction', 1 + Math.floor(r() * 3));
        evidence = true;
      }
      if (r() < 0.12) {
        recommendations.push({
          authorId: r() < 0.5 ? id : 't',
          subjectId: 't',
          year: 2022 + Math.floor(r() * 4),
        });
        evidence = true;
      }
      if (r() < 0.3) {
        // worked together at a small company (what plan 17 §E reads from both profiles)
        ties.push({
          id: `${id}|t|co_tenure`,
          userId: 'u',
          aId: id < 't' ? id : 't',
          bId: id < 't' ? 't' : id,
          kind: 'co_tenure',
          weight: 0.55,
          confidence: 0.75,
          evidence: { orgName: 'Small Co', overlapMonths: 14, sizeBucket: '11-50' },
        });
        evidence = true;
      }
    } else if (kind === 'acquaintance') {
      if (r() < 0.1) {
        act(id, 't', 'comment', 1);
        evidence = true;
      }
      if (r() < 0.2) {
        act(id, 't', 'reaction', 1 + Math.floor(r() * 4));
        evidence = true;
      }
      if (r() < 0.05) {
        act('t', id, 'reaction', 1);
        evidence = true;
      }
    } else {
      // the fan pattern: lots of one-way engagement with someone who does not know them
      if (r() < 0.6) {
        act(id, 't', 'comment', 2 + Math.floor(r() * 5));
        act(id, 't', 'reaction', 5 + Math.floor(r() * 16));
        evidence = true;
      }
    }
    mutuals.push({ id, score: Math.round(between(10, 90)), kind, know, evidence });
  }
  const ids = new Set(['t', ...mutuals.map((m) => m.id)]);
  const followersMap = new Map([
    ['t', followers],
    ...mutuals.map((m) => [m.id, Math.round(10 ** between(2.3, 3.5))] as const),
  ]);
  const evidenceTies = pairEvidenceTies({
    userId: 'u',
    people: ids,
    engagement,
    recommendations,
    followers: followersMap,
    now: NOW,
  });
  return { mutuals, pairs: combineTies([...ties, ...evidenceTies], NOW) };
}

describe('the hop simulation (plan 21 §11)', () => {
  const runs = Array.from({ length: 200 }, (_, i) => {
    const { mutuals, pairs } = network(1000 + i);
    const people = new Map<string, RoutePerson>([
      ['t', { id: 't', name: 'T', score: 0 }],
      ...mutuals.map((m) => [m.id, { id: m.id, name: m.id, score: m.score }] as const),
    ]);
    const r = rankWarmPaths({
      targetId: 't',
      people,
      pairs,
      candidates: mutuals.map((m) => ({ introducerId: m.id, kind: 'linkedin_mutual' as const })),
      goal: 'advice',
      now: NOW,
      limit: 100,
    });
    const p = new Map(r.paths.map((x) => [x.firstHopId, x.p]));
    const truth = mutuals.map((m) => pAsk({ score: Math.max(m.score, 12) }) * m.know);
    const ours = mutuals.map((m) => p.get(m.id) ?? 0);
    const today = mutuals.map((m) => pAsk({ score: Math.max(m.score, 12) }) * 0.3 * 0.95);
    // the best colleague with evidence, and where the fans landed relative to them
    const order = [...mutuals].sort((a, b) => (p.get(b.id) ?? 0) - (p.get(a.id) ?? 0));
    const top3 = order.slice(0, 3);
    const fanAheadOfColleague = top3.some(
      (f, i) =>
        f.kind === 'fan' &&
        order.slice(i + 1).some((c) => c.kind === 'colleague' && c.evidence && c.score > f.score),
    );
    return {
      ours: spearman(ours, truth),
      today: spearman(today, truth),
      anyEvidence: mutuals.some((m) => m.evidence && m.kind !== 'fan'),
      fanAheadOfColleague,
      coverage: mutuals.filter((m) => m.evidence).length / mutuals.length,
    };
  });
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

  it('tracks the truth better than ranking by the student’s own ties alone, and never worse', () => {
    const gain = runs.map((x) => x.ours - x.today);
    expect(mean(runs.map((x) => x.ours))).toBeGreaterThan(mean(runs.map((x) => x.today)) + 0.1);
    // where real evidence exists, the ranking improves on average by a clear margin
    expect(mean(runs.filter((x) => x.anyEvidence).map((x) => x.ours - x.today))).toBeGreaterThan(0.1);
    // and nowhere does it get meaningfully worse: fans' one-way engagement moves nothing, and the target's own
    // engagement with someone is evidence even where the simulated truth calls them an acquaintance
    expect(Math.min(...gain)).toBeGreaterThan(-0.05);
  });

  it('never puts a fan ahead of a colleague with real evidence whom the student knows at least as well', () => {
    expect(runs.filter((x) => x.fanAheadOfColleague)).toHaveLength(0);
  });

  it('reports coverage, so the numbers are read against how sparse evidence is', () => {
    const coverage = mean(runs.map((x) => x.coverage));
    expect(coverage).toBeGreaterThan(0.1);
    expect(coverage).toBeLessThan(0.6);
  });
});
