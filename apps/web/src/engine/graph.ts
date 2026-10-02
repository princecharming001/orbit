import type { Edge, Organization, Person, ReachPath } from '@orbit/core';
import {
  addEdge,
  combinedPairWeights,
  inferEdges,
  kShortestPaths,
  makeGraph,
  normalizeCompany,
  toReachPath,
  type WeightedGraph,
} from '@orbit/core';
import { db } from '../db/schema';

export async function recomputeEdges(userId: string): Promise<number> {
  const [people, affiliations, orgs, threads, events] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.affiliations.where('userId').equals(userId).toArray(),
    db.organizations.toArray(),
    db.threads.where('userId').equals(userId).toArray(),
    db.events.where('userId').equals(userId).toArray(),
  ]);
  const edges = inferEdges({
    userId,
    people,
    affiliations,
    organizations: new Map(orgs.map((o) => [o.id, o])),
    threads,
    events,
  });
  await db.transaction('rw', db.edges, async () => {
    await db.edges.where('userId').equals(userId).delete();
    await db.edges.bulkAdd(edges.map((e) => ({ ...e, id: `${userId}:${e.id}` })));
  });
  return edges.length;
}

export async function buildReachGraph(
  userId: string,
): Promise<{ g: WeightedGraph; people: Map<string, Person>; edges: Edge[] }> {
  const [people, edges] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.edges.where('userId').equals(userId).toArray(),
  ]);
  const g = makeGraph();
  const map = new Map<string, Person>();
  for (const p of people) {
    if (!p.isHuman || p.hiddenAt) continue;
    map.set(p.id, p);
    if (p.strength > 0.02) {
      const n = p.interactionCount;
      addEdge(
        g,
        'user',
        p.id,
        p.strength,
        'strength',
        n
          ? `You've had ${n} interaction${n === 1 ? '' : 's'} with ${p.firstName}`
          : `You're connected with ${p.firstName}`,
        true,
      );
    } else if (p.linkedinConnectedOn)
      addEdge(g, 'user', p.id, 0.12, 'strength', `You're connected with ${p.firstName} on LinkedIn`, true);
  }
  for (const [key, c] of combinedPairWeights(edges)) {
    const [a, b] = key.split('|') as [string, string];
    if (!map.has(a) || !map.has(b)) continue;
    const text = c.edges.sort((x, y) => y.weight - x.weight)[0]!.evidence.text ?? c.edges[0]!.type;
    addEdge(g, a, b, c.weight, c.edges[0]!.type, text);
  }
  return { g, people: map, edges };
}

export function bestPathStrength(g: WeightedGraph, personId: string): number {
  const paths = kShortestPaths(g, 'user', personId, 1, 3);
  return paths.length ? toReachPath(g, paths[0]!).score : 0;
}

export async function reachPerson(userId: string, targetPersonId: string, k = 3): Promise<ReachPath[]> {
  const { g } = await buildReachGraph(userId);
  const paths = kShortestPaths(g, 'user', targetPersonId, k + 2, 3).map((p) => toReachPath(g, p));
  // dedupe by first hop unless the second hop differs
  const seen = new Set<string>();
  const out: ReachPath[] = [];
  for (const p of paths) {
    const key = p.hops
      .slice(0, 2)
      .map((h) => h.toId)
      .join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= k) break;
  }
  return out;
}

export interface CompanyReach {
  org?: Organization;
  direct: { person: Person; strength: number }[];
  former: { person: Person; strength: number; endedAt?: string }[];
  alumni: { person: Person; strength: number }[];
  twoHop: { target: Person; path: ReachPath }[];
}

export async function reachCompany(userId: string, orgQuery: string): Promise<CompanyReach> {
  const norm = normalizeCompany(orgQuery);
  const orgs = await db.organizations.toArray();
  const org =
    orgs.find((o) => o.nameNormalized === norm) ??
    orgs.find((o) => o.nameNormalized.includes(norm) || norm.includes(o.nameNormalized));
  const { g, people } = await buildReachGraph(userId);
  const affs = await db.affiliations.where('userId').equals(userId).toArray();
  const direct: CompanyReach['direct'] = [];
  const former: CompanyReach['former'] = [];
  const alumni: CompanyReach['alumni'] = [];
  for (const p of people.values()) {
    const here =
      (org && p.currentOrganizationId === org.id) || normalizeCompany(p.currentOrganizationRaw) === norm;
    if (here) {
      direct.push({ person: p, strength: p.strength });
      if (p.isAlumni) alumni.push({ person: p, strength: p.strength });
      continue;
    }
    const past = affs.find(
      (a) =>
        a.personId === p.id &&
        a.kind === 'employment' &&
        !a.isCurrent &&
        ((org && a.organizationId === org.id) || normalizeCompany(a.nameRaw) === norm),
    );
    if (past) former.push({ person: p, strength: p.strength * 0.6, endedAt: past.endDate });
  }
  direct.sort((a, b) => b.strength - a.strength);
  former.sort((a, b) => b.strength - a.strength);
  const twoHop: CompanyReach['twoHop'] = [];
  for (const d of direct.filter((x) => x.strength < 0.3).slice(0, 15)) {
    const paths = kShortestPaths(g, 'user', d.person.id, 1, 3);
    if (paths.length && paths[0]!.length > 2)
      twoHop.push({ target: d.person, path: toReachPath(g, paths[0]!) });
  }
  twoHop.sort((a, b) => b.path.score - a.path.score);
  return { org, direct, former, alumni, twoHop: twoHop.slice(0, 3) };
}
