import { describe, expect, it } from 'vitest';
import { inferEdges } from '../graph/edges';
import { orbitLayout } from '../graph/layout';
import { addEdge, kShortestPaths, makeGraph, toReachPath } from '../graph/paths';
import { computeStrength, strengthTier } from '../scoring/strength';
import type { Affiliation, Person, Touchpoint } from '../types';

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
    expect(co!.weight).toBeGreaterThanOrEqual(0.5);
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
