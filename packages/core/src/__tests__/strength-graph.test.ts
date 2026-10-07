import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/seed';
import {
  CONNECTORS_PER_LARGE_GROUP,
  describePairHop,
  describeUserTie,
  inferEdges,
  knownSizeBucket,
  sizeFactor,
} from '../graph/edges';
import { countOutsideWedges, countOverlaps, orbitLayout, ringRotation } from '../graph/layout';
import { addEdge, bestPathsFrom, kShortestPaths, makeGraph, toReachPath } from '../graph/paths';
import { computeStrength, interactionCount, isReciprocal, strengthTier } from '../scoring/strength';
import { endOfNextBusinessDay } from '../suggestions/rules';
import type { Affiliation, Edge, Organization, Person, Touchpoint } from '../types';

const tp = (kind: Touchpoint['kind'], daysAgo: number, weight: number): Touchpoint => ({
  id: `${kind}${daysAgo}`,
  userId: 'u',
  personId: 'p',
  kind,
  occurredAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  refTable: 'x',
  refId: 'y',
  weight,
});

describe('computeStrength', () => {
  it('is 0 without touchpoints and saturates with meetings', () => {
    expect(computeStrength([]).strength).toBe(0);
    const two = computeStrength([tp('meeting', 1, 1), tp('meeting', 3, 1)]).strength;
    expect(two).toBeGreaterThan(0.6);
    const old = computeStrength([tp('email_out', 400, 0.6)]).strength;
    expect(old).toBeLessThan(0.15);
    expect(strengthTier(two)).toBe('strong');
  });
  it('decays with time', () => {
    const fresh = computeStrength([tp('email_in', 2, 0.7)]).strength;
    const stale = computeStrength([tp('email_in', 120, 0.7)]).strength;
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe('paths', () => {
  it('finds k shortest paths and scores them', () => {
    const g = makeGraph();
    addEdge(g, 'user', 'a', 0.8, 'strength', 'you know a');
    addEdge(g, 'a', 't', 0.5, 'co_tenure', 'a worked with t');
    addEdge(g, 'user', 'b', 0.3, 'strength', 'you know b');
    addEdge(g, 'b', 't', 0.9, 'co_tenure', 'b worked with t');
    addEdge(g, 'user', 'c', 0.9, 'strength', 'you know c');
    addEdge(g, 'c', 'a', 0.5, 'email_cothread', '');
    const paths = kShortestPaths(g, 'user', 't', 3, 3);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths[0]).toEqual(['user', 'a', 't']);
    const rp = toReachPath(g, paths[0]!);
    expect(rp.score).toBeCloseTo(0.4, 5);
    expect(rp.band).toBe('strong');
  });
  it('respects hop limits', () => {
    const g = makeGraph();
    addEdge(g, 'user', 'a', 0.9, 'strength', '');
    addEdge(g, 'a', 'b', 0.9, 'co_tenure', '');
    addEdge(g, 'b', 'c', 0.9, 'co_tenure', '');
    addEdge(g, 'c', 't', 0.9, 'co_tenure', '');
    expect(kShortestPaths(g, 'user', 't', 1, 3)).toEqual([]);
    expect(kShortestPaths(g, 'user', 't', 1, 4).length).toBe(1);
  });
});

const person = (id: string, org: string, extra: Partial<Person> = {}): Person => ({
  id,
  userId: 'u',
  displayName: id,
  firstName: id,
  lastName: 'X',
  nameNormalized: id,
  emails: [],
  currentOrganizationRaw: org,
  relationshipType: 'unknown',
  strength: 0.5,
  interactionCount: 0,
  sources: ['manual'],
  isHuman: true,
  tags: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

describe('inferEdges', () => {
  it('creates co-tenure and school edges', () => {
    const people = [person('a', 'Stripe'), person('b', 'Figma'), person('c', 'Notion')];
    const affs: Affiliation[] = [
      {
        id: '1',
        userId: 'u',
        personId: 'a',
        kind: 'employment',
        nameRaw: 'Stripe',
        startDate: '2020-01-01',
        endDate: '2023-01-01',
        isCurrent: false,
        source: 'manual',
      },
      {
        id: '2',
        userId: 'u',
        personId: 'b',
        kind: 'employment',
        nameRaw: 'Stripe',
        startDate: '2021-01-01',
        endDate: '2024-01-01',
        isCurrent: false,
        source: 'manual',
      },
      {
        id: '3',
        userId: 'u',
        personId: 'a',
        kind: 'education',
        nameRaw: 'Cornell',
        startDate: '2014-08-01',
        endDate: '2018-05-01',
        isCurrent: false,
        source: 'manual',
      },
      {
        id: '4',
        userId: 'u',
        personId: 'c',
        kind: 'education',
        nameRaw: 'Cornell',
        startDate: '2016-08-01',
        endDate: '2020-05-01',
        isCurrent: false,
        source: 'manual',
      },
    ];
    const edges = inferEdges({
      userId: 'u',
      people,
      affiliations: affs,
      organizations: new Map(),
      threads: [],
      events: [],
    });
    const co = edges.find((e) => e.type === 'co_tenure');
    expect(co).toBeDefined();
    // 24 months overlap saturates the overlap term; Stripe is a large employer (5,001 to 10,000 people), so the
    // size factor is 0.4 rather than the old "unknown size" 0.5 (GRL-10).
    expect(co!.weight).toBeCloseTo(0.4, 5);
    expect(edges.find((e) => e.type === 'same_school_cohort')).toBeDefined();
  });
});

describe('orbitLayout', () => {
  it('places people on rings by strength with company arcs', () => {
    const people = [
      person('a', 'Stripe', { strength: 0.9 }),
      person('b', 'Stripe', { strength: 0.4 }),
      person('c', 'Figma', { strength: 0.1 }),
    ];
    const l = orbitLayout(people, new Map());
    expect(l.nodes.find((n) => n.id === 'a')!.ring).toBe(0);
    expect(l.nodes.find((n) => n.id === 'b')!.ring).toBe(1);
    expect(l.nodes.find((n) => n.id === 'c')!.ring).toBe(2);
    expect(l.groups.length).toBe(2);
    const total = l.groups.reduce((s, g) => s + (g.endAngle - g.startAngle), 0);
    expect(total).toBeCloseTo(Math.PI * 2, 5);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Regression tests for the graph, reach and map audit (GRL-01 .. GRL-16)

const NOW = new Date('2026-06-01T12:00:00Z');
const at = (kind: Touchpoint['kind'], daysAgo: number, weight: number, i = 0): Touchpoint => ({
  ...tp(kind, daysAgo, weight),
  id: `${kind}-${daysAgo}-${i}`,
  occurredAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
});

describe('computeStrength: reciprocity (GRL-01, GRL-02)', () => {
  it('unanswered cold outreach plus two bumps stays a weak tie', () => {
    const { strength } = computeStrength(
      [at('email_out', 2, 0.6), at('email_out', 9, 0.6), at('email_out', 16, 0.6)],
      NOW,
    );
    expect(strength).toBeLessThan(0.3);
    expect(strengthTier(strength)).toBe('weak');
    const one = computeStrength([at('email_out', 2, 0.6)], NOW).strength;
    expect(one).toBeLessThan(0.3);
    const five = computeStrength(
      [2, 8, 14, 20, 26].map((d, i) => at('email_out', d, 0.6, i)),
      NOW,
    ).strength;
    expect(strengthTier(five)).toBe('weak');
  });
  it('a reply turns the same outreach into a real tie', () => {
    const out = [at('email_out', 16, 0.6), at('email_out', 9, 0.6)];
    const before = computeStrength(out, NOW).strength;
    const after = computeStrength([...out, at('email_in', 2, 0.7)], NOW).strength;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(0.3);
  });
  it('mailing-list and group-thread CCs can never make a strong or even medium tie', () => {
    const month = Array.from({ length: 30 }, (_, i) => at('email_cc', i + 1, 0.1, i));
    expect(strengthTier(computeStrength(month, NOW).strength)).toBe('weak');
    const quarter = Array.from({ length: 100 }, (_, i) => at('email_cc', (i * 90) / 100, 0.1, i));
    expect(computeStrength(quarter, NOW).strength).toBeLessThan(0.3);
  });
  it('CC still nudges a real tie up, a little', () => {
    const base = [at('meeting', 10, 1)];
    const withCc = [...base, ...Array.from({ length: 20 }, (_, i) => at('email_cc', i + 1, 0.1, i))];
    const a = computeStrength(base, NOW).strength;
    const b = computeStrength(withCc, NOW).strength;
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(0.15);
  });
  it('counts only real interactions (no CCs, no LinkedIn connection)', () => {
    expect(interactionCount({ email_cc: 40, linkedin_connected: 1, email_in: 2, meeting: 1 })).toBe(3);
    expect(isReciprocal({ email_out: 3 })).toBe(false);
    expect(isReciprocal({ email_out: 3, email_in: 1 })).toBe(true);
  });
  it('two recent meetings still make a strong tie', () => {
    const two = computeStrength([at('meeting', 1, 1), at('meeting', 3, 1)], NOW).strength;
    expect(strengthTier(two)).toBe('strong');
  });
});

describe('computeStrength: canonical tiers (GRL-17)', () => {
  const tier = (tps: Touchpoint[]) => strengthTier(computeStrength(tps, NOW).strength);
  it('two meetings in the last month make a strong tie, wherever in the month they fell', () => {
    expect(tier([at('meeting', 20, 1), at('meeting', 30, 1, 1)])).toBe('strong');
    expect(tier([at('meeting', 10, 1), at('meeting', 25, 1, 1)])).toBe('strong');
    expect(tier([at('meeting', 30, 1), at('meeting', 31, 1, 1)])).toBe('strong');
  });
  it('one coffee chat is a medium tie, and old meetings drift back to medium', () => {
    expect(tier([at('meeting', 1, 1)])).toBe('medium');
    expect(tier([at('meeting', 60, 1), at('meeting', 62, 1, 1)])).toBe('medium');
    expect(tier([at('meeting', 200, 1)])).toBe('weak');
  });
  it('a single old touch stays near zero', () => {
    expect(computeStrength([at('email_in', 365, 0.7)], NOW).strength).toBeLessThan(0.15);
  });
  it('treats a touch a few hours ahead as happening now, and ignores ones further out', () => {
    const later = new Date(NOW.getTime() + 6 * 3_600_000).toISOString();
    const soon = computeStrength([{ ...at('meeting', 0, 1), occurredAt: later }], NOW);
    const now = computeStrength([at('meeting', 0, 1)], NOW);
    expect(soon.strength).toBeCloseTo(now.strength, 10);
    expect(soon.breakdown.recency).toBeLessThanOrEqual(1);
    expect(soon.breakdown.lastInteractionAt).toBe(NOW.toISOString());
    const nextWeek = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    expect(computeStrength([{ ...at('meeting', 0, 1), occurredAt: nextWeek }], NOW).strength).toBe(0);
  });
});

/** brute force: every simple path within the hop limit, cheapest first */
function allPaths(g: ReturnType<typeof makeGraph>, s: string, t: string, maxHops: number): string[][] {
  const out: string[][] = [];
  const walk = (path: string[]) => {
    const last = path[path.length - 1]!;
    if (last === t) {
      out.push(path);
      return;
    }
    if (path.length - 1 >= maxHops) return;
    for (const [v] of g.adj.get(last) ?? []) if (!path.includes(v)) walk([...path, v]);
  };
  walk([s]);
  return out;
}
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
function randomGraph(n: number, e: number, seed: number) {
  const r = rng(seed);
  const g = makeGraph();
  for (let i = 0; i < n; i++)
    if (r() < 0.7) addEdge(g, 'user', `p${i}`, 0.05 + r() * 0.9, 'strength', '', true);
  for (let k = 0; k < e; k++) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    if (a !== b) addEdge(g, `p${a}`, `p${b}`, 0.1 + r() * 0.85, 'co_tenure', '');
  }
  return g;
}

describe('paths: hop-limited k-shortest (GRL-03, GRL-04)', () => {
  it('finds the 2-hop route even when a cheaper but longer chain reaches the connector first', () => {
    const g = makeGraph();
    addEdge(g, 'user', 'a', 0.9, 'strength', '', true);
    addEdge(g, 'a', 'b', 0.9, 'co_tenure', '');
    addEdge(g, 'b', 'c', 0.9, 'co_tenure', '');
    addEdge(g, 'user', 'c', 0.12, 'strength', '', true);
    addEdge(g, 'c', 't', 0.9, 'co_tenure', '');
    const paths = kShortestPaths(g, 'user', 't', 3, 3);
    expect(paths[0]).toEqual(['user', 'c', 't']);
    expect(toReachPath(g, paths[0]!).score).toBeCloseTo(0.108, 3);
    expect(bestPathsFrom(g, 'user', 3).path('t')).toEqual(['user', 'c', 't']);
  });
  it('matches brute force on random graphs (top-k costs, simple paths, hop limit)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const g = randomGraph(12, 22, seed);
      for (const target of ['p3', 'p7', 'p11']) {
        if (!g.nodes.has(target)) continue;
        const brute = allPaths(g, 'user', target, 3)
          .map((p) => toReachPath(g, p).score)
          .sort((a, b) => b - a);
        const got = kShortestPaths(g, 'user', target, 4, 3);
        expect(got.length).toBe(Math.min(4, brute.length));
        got.forEach((p, i) => {
          expect(new Set(p).size).toBe(p.length);
          expect(p.length - 1).toBeLessThanOrEqual(3);
          expect(toReachPath(g, p).score).toBeCloseTo(brute[i]!, 9);
        });
        expect(bestPathsFrom(g, 'user', 3).score(target)).toBeCloseTo(brute[0] ?? 0, 9);
      }
    }
  });
  it('is fast at 2,000 people: one table for a whole recommendation batch', () => {
    const g = randomGraph(2000, 5000, 42);
    const t0 = performance.now();
    const table = bestPathsFrom(g, 'user', 3);
    let reachable = 0;
    for (let i = 0; i < 2000; i++) if (table.score(`p${i}`) > 0) reachable++;
    const tableMs = performance.now() - t0;
    expect(reachable).toBeGreaterThan(1500);
    expect(tableMs).toBeLessThan(500);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) kShortestPaths(g, 'user', `p${i}`, 5, 3);
    expect((performance.now() - t1) / 20).toBeLessThan(150);
  });
});

const empAff = (personId: string, nameRaw: string, extra: Partial<Affiliation> = {}): Affiliation => ({
  id: `${personId}-${nameRaw}-${extra.startDate ?? ''}-${extra.endDate ?? ''}`,
  userId: 'u',
  personId,
  kind: 'employment',
  nameRaw,
  isCurrent: false,
  source: 'manual',
  ...extra,
});
const infer = (people: Person[], affiliations: Affiliation[], orgs: Organization[] = []) =>
  inferEdges({
    userId: 'u',
    people,
    affiliations,
    organizations: new Map(orgs.map((o) => [o.id, o])),
    threads: [],
    events: [],
    now: NOW,
  });

describe('inferEdges (GRL-09, GRL-10, GRL-16)', () => {
  it('large groups are never dropped and stay linear in size', () => {
    for (const n of [151, 399, 401, 1200]) {
      const people = Array.from({ length: n }, (_, i) =>
        person(`s${i}`, '', { school: 'Cornell University', strength: (i % 97) / 100 }),
      );
      const edges = infer(people, []);
      const school = edges.filter((e) => e.type === 'same_school_cohort');
      expect(school.length).toBeGreaterThan(0);
      expect(school.length).toBeLessThanOrEqual(n * CONNECTORS_PER_LARGE_GROUP);
      const touched = new Set(school.flatMap((e) => [e.personAId, e.personBId]));
      expect(touched.size).toBe(n); // everyone keeps a route through the group's strongest ties
    }
  });
  it('weighs colleagues at a 30-person startup above colleagues at Google', () => {
    const people = [
      person('a', 'Tiny Co'),
      person('b', 'Tiny Co'),
      person('c', 'Google'),
      person('d', 'Google'),
    ];
    const orgs: Organization[] = [
      {
        id: 'o1',
        name: 'Tiny Co',
        nameNormalized: 'tiny co',
        domains: [],
        sizeBucket: '11-50',
      } as Organization,
    ];
    people[0]!.currentOrganizationId = 'o1';
    people[1]!.currentOrganizationId = 'o1';
    const edges = infer(people, [], orgs);
    const tiny = edges.find((e) => e.personAId === 'a' && e.personBId === 'b')!;
    const google = edges.find((e) => e.personAId === 'c' && e.personBId === 'd')!;
    expect(tiny.weight).toBeCloseTo(0.35, 5);
    expect(google.weight).toBeCloseTo(0.35 * 0.4, 5);
    expect(sizeFactor(undefined, 'Some Unknown LLC')).toBe(0.5);
    expect(sizeFactor(undefined, 'Some Unknown LLC', 40)).toBe(0.4);
    // the table is keyed by normalised name: legal suffixes are normalised away, unknown firms are not guessed
    expect(knownSizeBucket('Goldman Sachs & Co. LLC')).toBe('10001+');
    expect(knownSizeBucket('Goldman Sachs')).toBe('10001+');
    expect(knownSizeBucket('Some Unknown LLC')).toBeUndefined();
  });
  it('dateless past employment at the same company yields a weak edge, not nothing', () => {
    const people = [person('a', 'Figma'), person('b', 'Notion')];
    const edges = infer(people, [empAff('a', 'Ramp'), empAff('b', 'Ramp')]);
    const e = edges.find((x) => x.type === 'co_tenure');
    expect(e).toBeDefined();
    expect(e!.weight).toBeCloseTo(0.15 * 0.7, 5); // Ramp: 1,001 to 5,000 people
    expect(e!.evidence.datesUnknown).toBe(true);
    const endOnly = infer(people, [
      empAff('a', 'Ramp', { endDate: '2022-01-01' }),
      empAff('b', 'Ramp', { endDate: '2023-06-01' }),
    ]);
    expect(endOnly.some((x) => x.type === 'co_tenure')).toBe(true);
    // weaker than a dated overlap
    const dated = infer(people, [
      empAff('a', 'Ramp', { startDate: '2020-01-01', endDate: '2022-01-01' }),
      empAff('b', 'Ramp', { startDate: '2021-01-01', endDate: '2023-01-01' }),
    ]).find((x) => x.type === 'co_tenure')!;
    expect(dated.weight).toBeGreaterThan(e!.weight);
    // provably disjoint dates: no edge
    const disjoint = infer(people, [
      empAff('a', 'Ramp', { endDate: '2018-01-01' }),
      empAff('b', 'Ramp', { startDate: '2020-01-01', endDate: '2021-01-01' }),
    ]);
    expect(disjoint.some((x) => x.type === 'co_tenure')).toBe(false);
  });
  it('never claims "since YEAR" when one of two colleagues has no start date', () => {
    const a = named('a', 'Ana');
    const b = named('b', 'Ben');
    const edges = infer(
      [a, b],
      [
        empAff('a', 'Stripe', { isCurrent: true, startDate: '2020-01-01' }),
        empAff('b', 'Stripe', { isCurrent: true }),
      ],
    );
    expect(edges.some((e) => e.type === 'co_tenure')).toBe(false);
    const same = edges.filter((e) => e.type === 'same_current_company');
    expect(same.length).toBe(1);
    const text = describePairHop(a, b, same);
    expect(text).toBe('Ana and Ben both work at Stripe now');
    expect(text).not.toMatch(/since|together/);
    // a past stint with a start but no end date: we cannot say when they overlapped
    const open = infer(
      [a, b],
      [
        empAff('a', 'Ramp', { startDate: '2018-01-01' }),
        empAff('b', 'Ramp', { startDate: '2020-01-01', endDate: '2021-06-01' }),
      ],
    ).find((e) => e.type === 'co_tenure')!;
    expect(open.evidence.datesUnknown).toBe(true);
    expect(open.evidence.fromYear).toBeUndefined();
  });
  it('groups "Stripe", "Stripe, Inc." and an org-linked Stripe together', () => {
    const people = [person('a', 'Stripe'), person('b', 'Stripe, Inc.'), person('c', 'STRIPE')];
    people[0]!.currentOrganizationId = 'o1';
    const orgs = [
      { id: 'o1', name: 'Stripe', nameNormalized: 'stripe', domains: [] } as unknown as Organization,
    ];
    const edges = infer(people, [], orgs).filter((e) => e.type === 'same_current_company');
    expect(edges.length).toBe(3);
  });
});

const named = (id: string, firstName: string): Person =>
  person(id, '', { firstName, displayName: `${firstName} ${id.toUpperCase()}` });

describe('hop explanations (GRL-08, GRL-11)', () => {
  const priya = named('p', 'Priya');
  const mei = named('m', 'Mei');
  const edge = (type: Edge['type'], weight: number, evidence: Edge['evidence']): Edge => ({
    id: type,
    userId: 'u',
    personAId: 'm',
    personBId: 'p',
    type,
    weight,
    evidence,
  });
  it('names both people, the company and the years', () => {
    const [e] = infer(
      [priya, mei],
      [
        empAff('p', 'Stripe', { startDate: '2021-03-01', endDate: '2023-08-01' }),
        empAff('m', 'Stripe', { startDate: '2022-01-01', endDate: '2024-01-01' }),
      ],
    ).filter((x) => x.type === 'co_tenure');
    expect(describePairHop(priya, mei, [e!])).toBe('Priya and Mei both worked at Stripe from 2022 to 2023');
    expect(describePairHop(mei, priya, [e!])).toBe('Mei and Priya both worked at Stripe from 2022 to 2023');
    expect(
      describePairHop(priya, mei, [
        edge('same_current_company', 0.35, { orgName: 'Figma', current: ['p', 'm'] }),
      ]),
    ).toBe('Priya and Mei both work at Figma now');
  });
  it('adds one supporting reason', () => {
    const text = describePairHop(priya, mei, [
      edge('same_current_company', 0.35, { orgName: 'Figma' }),
      edge('same_school_cohort', 0.12, { school: 'Cornell' }),
    ]);
    expect(text).toBe('Priya and Mei both work at Figma now, and they both went to Cornell');
  });
  it('says who used to work where when dates are unknown', () => {
    const text = describePairHop(priya, mei, [
      edge('co_tenure', 0.1, { orgName: 'Ramp', datesUnknown: true, current: ['p'] }),
    ]);
    expect(text).toBe('Mei used to work at Ramp, where Priya works now');
  });
  it('describes the student tie truthfully', () => {
    const linkedinOnly = person('x', 'Figma', {
      firstName: 'Ana',
      strength: 0.041,
      interactionCount: 1,
      linkedinConnectedOn: '2026-01-05',
      strengthBreakdown: { raw: 0.06, recency: 0.1, counts: { linkedin_connected: 1 } },
    });
    expect(describeUserTie(linkedinOnly, NOW)).toBe("You're connected with Ana on LinkedIn (since Jan 2026)");
    const cold = person('y', 'Figma', {
      firstName: 'Ben',
      strengthBreakdown: { raw: 0.3, recency: 1, counts: { email_out: 2 } },
    });
    expect(describeUserTie(cold, NOW)).toBe("You've emailed Ben twice and haven't heard back yet");
    const warm = person('z', 'Figma', {
      firstName: 'Cleo',
      lastInteractionAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      strengthBreakdown: {
        raw: 2,
        recency: 1,
        counts: { email_in: 2, email_out: 1, meeting: 1, email_cc: 9 },
        lastConversationAt: new Date(NOW.getTime() - 15 * 86_400_000).toISOString(),
      },
    });
    expect(describeUserTie(warm, NOW)).toBe(
      "You've had 3 emails and a meeting with Cleo; the last one was 2 weeks ago",
    );
  });
  it('"the last one" is the last email or meeting, never a CC or a LinkedIn connection', () => {
    const { breakdown } = computeStrength(
      [
        at('email_in', 20, 0.7),
        at('email_out', 19, 0.6),
        at('email_cc', 30, 0.1, 1),
        at('email_cc', 10, 0.1, 2),
        at('email_cc', 1, 0.1, 3),
        at('linkedin_connected', 0, 0.2),
      ],
      NOW,
    );
    expect(breakdown.lastInteractionAt).toBe(NOW.toISOString());
    const ana = person('a', 'Figma', {
      firstName: 'Ana',
      lastInteractionAt: breakdown.lastInteractionAt,
      strengthBreakdown: breakdown,
    });
    expect(describeUserTie(ana, NOW)).toBe("You've had 2 emails with Ana; the last one was 2 weeks ago");
  });
  it('never uses dashes or internal codes', () => {
    const texts = [
      describePairHop(priya, mei, [
        edge('email_cothread', 0.5, { threads: 3, lastAt: '2026-03-02T00:00:00Z' }),
      ]),
      describePairHop(priya, mei, [edge('meeting_coattendee', 0.6, { events: 1 })]),
      describePairHop(priya, mei, [edge('same_school_cohort', 0.3, { school: 'Cornell', year: 2012 })]),
    ];
    expect(texts).toEqual([
      'Priya and Mei were on 3 email threads with you (last in Mar 2026)',
      'Priya and Mei were in a meeting with you',
      'Priya and Mei were both at Cornell around 2012',
    ]);
    for (const t of texts) expect(t).not.toMatch(/[–—_!]/);
  });
});

function zipfPeople(n: number, seed = 1): Person[] {
  const r = rng(seed);
  const companies = Math.max(5, Math.round(n / 3));
  return Array.from({ length: n }, (_, i) => {
    const c = Math.floor(companies * r() ** 2.5);
    const u = r();
    const strength = u < 0.05 ? 0.6 + r() * 0.4 : u < 0.2 ? 0.3 + r() * 0.3 : r() * 0.29;
    return person(`p${i}`, `Company ${c}`, { strength });
  });
}

describe('orbitLayout at scale (GRL-05, GRL-07)', () => {
  for (const n of [90, 300, 1000, 2000]) {
    it(`has no overlapping dots and accounts for everyone at ${n} people`, () => {
      const people = zipfPeople(n);
      const t0 = performance.now();
      const l = orbitLayout(people, new Map());
      expect(performance.now() - t0).toBeLessThan(400);
      expect(countOverlaps(l.nodes)).toBe(0);
      const shown = l.nodes.reduce((s, x) => s + (x.cluster ? x.cluster.count : 1), 0);
      expect(shown).toBe(n);
      expect(new Set(l.nodes.map((x) => x.id)).size).toBe(l.nodes.length);
      const total = l.groups.reduce((s, g) => s + (g.endAngle - g.startAngle), 0);
      expect(total).toBeCloseTo(Math.PI * 2, 5);
      // everything fits inside the outer band, labels go just outside
      expect(l.extent).toBeLessThanOrEqual(520);
      // strong ties stay individual dots (up to ~100 of them, far more than most students have)
      const strong = people.filter((p) => p.strength >= 0.6).length;
      expect(strong).toBeLessThanOrEqual(100);
      expect(l.nodes.filter((x) => x.ring === 0 && x.person).length).toBe(strong);
      // aggregate dots stand for real groups, not "+1"
      const clusters = l.nodes.filter((x) => x.cluster);
      expect(clusters.filter((x) => x.cluster!.count < 3).length).toBeLessThanOrEqual(
        Math.max(3, clusters.length * 0.1),
      );
      if (n <= 300) expect(l.aggregated).toBe(0);
      else expect(l.nodes.length).toBeLessThan(800);
    });
  }
  it('keeps every dot inside its own company wedge at any size', () => {
    for (const seed of [1, 2, 3])
      for (const n of [90, 150, 300, 1000, 2000]) {
        const l = orbitLayout(zipfPeople(n, seed), new Map());
        expect(countOutsideWedges(l), `seed ${seed}, ${n} people`).toBe(0);
        expect(countOverlaps(l.nodes), `seed ${seed}, ${n} people`).toBe(0);
        // the counter itself notices a dot pushed into a neighbour's wedge
        if (n === 150 && seed === 1) {
          const moved = { ...l, nodes: l.nodes.map((x, i) => (i ? x : { ...x, angle: x.angle + Math.PI })) };
          expect(countOutsideWedges(moved)).toBe(1);
        }
        // every wedge holds at least one dot, so no label floats over an empty slice
        const used = new Set(l.nodes.map((x) => x.groupKey));
        expect(l.groups.filter((g) => !used.has(g.key))).toEqual([]);
      }
  });
  it('groups spellings of one company into one wedge', () => {
    const people = [
      person('a', 'Stripe'),
      person('b', 'Stripe, Inc.'),
      person('c', 'STRIPE'),
      person('d', 'Figma'),
    ];
    expect(orbitLayout(people, new Map()).groups.length).toBe(2);
  });
  it('keys wedges by organization or normalised name, and labels a dangling org id by the raw name (GRL-18)', () => {
    const orgs = new Map<string, Organization>([
      ['o1', { id: 'o1', name: 'Stripe', nameNormalized: 'stripe', domains: [] } as unknown as Organization],
    ]);
    const people = [
      { ...person('a', 'Stripe'), currentOrganizationId: 'o1' },
      person('b', 'Stripe'),
      person('c', 'Stripe, Inc.'),
      { ...person('d', 'Figma'), currentOrganizationId: 'missing' },
    ];
    const groups = orbitLayout(people, orgs).groups;
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.label).sort()).toEqual(['Figma', 'Stripe']);
  });
  it('rotates every ring together so wedges stay aligned', () => {
    for (const t of [0, 10_000, 60_000, 400_000])
      expect(new Set([0, 1, 2].map((r) => ringRotation(r as 0 | 1 | 2, t))).size).toBe(1);
  });
});

describe('demo seed: the upcoming chat is always inside the prep window', () => {
  it('at any hour of the day the demo has a chat to prep for, on the next business day at the latest', () => {
    for (const hour of [0, 1, 5, 7, 9, 12, 18, 23]) {
      const now = new Date(2026, 9, 7, hour, 22);
      const ev = buildDemoDataset({ now }).events.find((e) => e.id === 'ev_next')!;
      const hours = (new Date(ev.startAt).getTime() - now.getTime()) / 3_600_000;
      expect(hours, `loaded at ${hour}:22`).toBeGreaterThan(0);
      expect(new Date(ev.startAt).getTime(), `loaded at ${hour}:22`).toBeLessThanOrEqual(
        endOfNextBusinessDay(now),
      );
    }
  });
  it('the replies from days ago name the day of the chat instead of saying "tomorrow"', () => {
    const now = new Date(2026, 9, 7, 9, 0);
    const data = buildDemoDataset({ now });
    const ev = data.events.find((e) => e.id === 'ev_next')!;
    const day = new Date(ev.startAt).toLocaleDateString('en-US', { weekday: 'long' });
    const chat = data.chats.find((c) => c.scheduledEventId === ev.id)!;
    const replies = data.messages.filter((m) => m.threadId === chat.threadId && m.direction === 'inbound');
    for (const r of replies) expect(r.bodyText).not.toMatch(/tomorrow/i);
    expect(replies.at(-1)!.bodyText).toContain(`${day} at 11:30`);
  });
});
