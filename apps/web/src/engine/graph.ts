import type { Affiliation, Edge, Organization, Person, ReachPath, TargetCompany } from '@orbit/core';
import {
  addEdge,
  bestPathsFrom,
  combinedPairWeights,
  describePairHop,
  describeUserTie,
  inferEdges,
  kShortestPaths,
  makeGraph,
  normalizeCompany,
  type PathTable,
  toReachPath,
  type WeightedGraph,
} from '@orbit/core';
import { db } from '../db/schema';

/** The normalised company key for a person: their organization's normalised name, else their raw company. */
function companyKey(
  orgId: string | undefined,
  raw: string | undefined,
  orgs: Map<string, Organization>,
): string {
  const org = orgId ? orgs.get(orgId) : undefined;
  return org?.nameNormalized || normalizeCompany(org?.name || raw);
}

/**
 * Builds the map's "Target companies" filter. A person matches a target company by organization id, or by
 * normalised name on both sides, so "Stripe, Inc." in an import matches the target "Stripe".
 */
export function targetCompanyMatcher(
  targets: Pick<TargetCompany, 'organizationId' | 'nameRaw'>[],
  orgs: Map<string, Organization>,
): (p: Pick<Person, 'currentOrganizationId' | 'currentOrganizationRaw'>) => boolean {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const t of targets) {
    if (t.organizationId) ids.add(t.organizationId);
    for (const n of [normalizeCompany(t.nameRaw), companyKey(t.organizationId, undefined, orgs)])
      if (n) names.add(n);
  }
  return (p) => {
    if (p.currentOrganizationId && ids.has(p.currentOrganizationId)) return true;
    const key = companyKey(p.currentOrganizationId, p.currentOrganizationRaw, orgs);
    if (key && names.has(key)) return true;
    // an org record may be named differently from what the person's profile says
    const raw = normalizeCompany(p.currentOrganizationRaw);
    return !!raw && names.has(raw);
  };
}

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
  return reachGraphFrom(people, edges);
}

/** Lowest weight for a LinkedIn connection with no other history: accepted, so not a stranger, but no more. */
export const LINKEDIN_ONLY_WEIGHT = 0.12;

export function userTieWeight(p: Person): number {
  return Math.max(p.strength > 0.02 ? p.strength : 0, p.linkedinConnectedOn ? LINKEDIN_ONLY_WEIGHT : 0);
}

export function reachGraphFrom(
  people: Person[],
  edges: Edge[],
  now: Date = new Date(),
): { g: WeightedGraph; people: Map<string, Person>; edges: Edge[] } {
  const g = makeGraph();
  const map = new Map<string, Person>();
  for (const p of people) {
    if (!p.isHuman || p.hiddenAt) continue;
    map.set(p.id, p);
    const w = userTieWeight(p);
    if (w > 0) addEdge(g, 'user', p.id, w, 'strength', describeUserTie(p, now), true);
  }
  for (const [key, c] of combinedPairWeights(edges)) {
    const [a, b] = key.split('|') as [string, string];
    const pa = map.get(a);
    const pb = map.get(b);
    if (!pa || !pb) continue;
    const type = [...c.edges].sort((x, y) => y.weight - x.weight)[0]!.type;
    // one text per direction so each hop names its own people in order
    addEdge(g, a, b, c.weight, type, describePairHop(pa, pb, c.edges), true);
    addEdge(g, b, a, c.weight, type, describePairHop(pb, pa, c.edges), true);
  }
  return { g, people: map, edges };
}

const tables = new WeakMap<WeightedGraph, PathTable>();

/** Best route strength from the student to a person. One search per graph, then O(path) lookups. */
export function bestPathStrength(g: WeightedGraph, personId: string): number {
  let t = tables.get(g);
  if (!t) {
    t = bestPathsFrom(g, 'user', 3);
    tables.set(g, t);
  }
  return t.score(personId);
}

export async function reachPerson(userId: string, targetPersonId: string, k = 3): Promise<ReachPath[]> {
  const { g } = await buildReachGraph(userId);
  return reachPersonIn(g, targetPersonId, k);
}

export function reachPersonIn(g: WeightedGraph, targetPersonId: string, k = 3): ReachPath[] {
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
  /** people there now, strongest first, then alumni of the student's school, then newest connections */
  direct: { person: Person; strength: number }[];
  /** left the company within the last five years; weighted down the longer ago they left */
  former: { person: Person; strength: number; endedAt?: string }[];
  /** alumni among `direct` (same people; the map shows them as a badge rather than a second list) */
  alumni: { person: Person; strength: number }[];
  twoHop: { target: Person; path: ReachPath }[];
}

const YEAR = 365 * 86_400_000;

export interface ReachCandidate {
  kind: 'person' | 'company';
  id: string;
  label: string;
  sub?: string;
  score: number;
}

function matchScore(hay: string, q: string): number {
  if (!hay || !q) return 0;
  if (hay === q) return 100;
  if (hay.startsWith(q)) return 80;
  if (hay.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (q.length >= 3 && hay.includes(q)) return 40;
  return 0;
}

/**
 * Ranked matches for the Reach box. Company names are compared in normalized form ("Stripe, Inc." = "stripe"),
 * exact beats prefix beats word-prefix beats substring, and ties go to whoever is bigger in the student's network.
 */
export function rankReachTargets(
  query: string,
  people: Person[],
  orgs: Organization[],
  limit = 6,
): ReachCandidate[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const qOrg = normalizeCompany(query);
  if (!q) return [];
  const members = new Map<string, number>();
  for (const p of people) {
    const key = p.currentOrganizationId ?? `n:${normalizeCompany(p.currentOrganizationRaw)}`;
    members.set(key, (members.get(key) ?? 0) + 1);
  }
  const out: (ReachCandidate & { tie: number })[] = [];
  for (const p of people) {
    if (!p.isHuman || p.hiddenAt) continue;
    const s = matchScore(p.displayName.toLowerCase(), q);
    if (s)
      out.push({
        kind: 'person',
        id: p.id,
        label: p.displayName,
        sub: [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') || undefined,
        score: s,
        tie: p.strength,
      });
  }
  const seenOrg = new Set<string>();
  for (const o of orgs) {
    if (seenOrg.has(o.nameNormalized)) continue;
    seenOrg.add(o.nameNormalized);
    const s = Math.max(matchScore(o.nameNormalized, qOrg), matchScore(o.name.toLowerCase(), q));
    if (!s) continue;
    const n = (members.get(o.id) ?? 0) + (members.get(`n:${o.nameNormalized}`) ?? 0);
    out.push({
      kind: 'company',
      id: o.id,
      label: o.name,
      sub: n ? `${n} ${n === 1 ? 'person' : 'people'} in your network` : 'No one in your network yet',
      score: s,
      tie: n,
    });
  }
  // companies people list that have no organization row yet (typed by hand, imported from a CSV)
  const raw = new Map<string, { label: string; n: number }>();
  for (const p of people) {
    if (!p.isHuman || p.hiddenAt || p.currentOrganizationId) continue;
    const norm = normalizeCompany(p.currentOrganizationRaw);
    if (!norm || seenOrg.has(norm)) continue;
    const cur = raw.get(norm) ?? { label: p.currentOrganizationRaw!, n: 0 };
    cur.n++;
    raw.set(norm, cur);
  }
  for (const [norm, { label, n }] of raw) {
    const s = Math.max(matchScore(norm, qOrg), matchScore(label.toLowerCase(), q));
    if (!s) continue;
    out.push({
      kind: 'company',
      id: label,
      label,
      sub: `${n} ${n === 1 ? 'person' : 'people'} in your network`,
      score: s,
      tie: n,
    });
  }
  out.sort((a, b) => b.score - a.score || b.tie - a.tie || a.label.localeCompare(b.label));
  return out.slice(0, limit).map(({ tie: _tie, ...c }) => c);
}

/** True when the top candidate is clearly what was meant (an exact hit, or the only hit). */
export function isUnambiguous(cands: ReachCandidate[]): boolean {
  if (cands.length === 1) return true;
  if (cands.length === 0) return false;
  return cands[0]!.score === 100 && cands[1]!.score < 100;
}

function resolveOrg(orgs: Organization[], query: string): Organization | undefined {
  const byId = orgs.find((o) => o.id === query);
  if (byId) return byId;
  const norm = normalizeCompany(query);
  if (!norm) return undefined;
  const exact = orgs.find((o) => o.nameNormalized === norm);
  if (exact) return exact;
  const ranked = orgs
    .map((o) => ({ o, s: matchScore(o.nameNormalized, norm) }))
    .filter((x) => x.s >= 60)
    .sort((a, b) => b.s - a.s || a.o.name.length - b.o.name.length);
  return ranked[0]?.o;
}

export async function reachCompany(
  userId: string,
  orgQuery: string,
  now = new Date(),
): Promise<CompanyReach> {
  const orgs = await db.organizations.toArray();
  const org = resolveOrg(orgs, orgQuery);
  const norm = org?.nameNormalized ?? normalizeCompany(orgQuery);
  const { g, people } = await buildReachGraph(userId);
  const affs = await db.affiliations.where('userId').equals(userId).toArray();
  const affsByPerson = new Map<string, Affiliation[]>();
  for (const a of affs) {
    if (a.kind !== 'employment' || a.isCurrent) continue;
    const arr = affsByPerson.get(a.personId) ?? [];
    arr.push(a);
    affsByPerson.set(a.personId, arr);
  }
  const direct: CompanyReach['direct'] = [];
  const former: CompanyReach['former'] = [];
  for (const p of people.values()) {
    const here =
      (org && p.currentOrganizationId === org.id) ||
      (!!norm && normalizeCompany(p.currentOrganizationRaw) === norm);
    if (here) {
      direct.push({ person: p, strength: p.strength });
      continue;
    }
    const past = (affsByPerson.get(p.id) ?? []).filter(
      (a) => (org && a.organizationId === org.id) || (!!norm && normalizeCompany(a.nameRaw) === norm),
    );
    if (!past.length) continue;
    const ends = past.map((a) => (a.endDate ? new Date(a.endDate).getTime() : Number.NaN));
    const known = ends.filter((t) => !Number.isNaN(t));
    const end = known.length ? Math.max(...known) : undefined;
    let factor = 0.4; // left at an unknown time
    if (end !== undefined) {
      const yearsAgo = Math.max(0, (now.getTime() - end) / YEAR);
      if (yearsAgo > 5) continue; // their inside knowledge is out of date
      factor = 0.6 * (1 - yearsAgo / 10);
    }
    const endedAt = end !== undefined ? new Date(end).toISOString().slice(0, 10) : undefined;
    former.push({ person: p, strength: p.strength * factor, endedAt });
  }
  const connected = (p: Person) =>
    p.linkedinConnectedOn ? new Date(p.linkedinConnectedOn).getTime() || 0 : 0;
  direct.sort(
    (a, b) =>
      b.strength - a.strength ||
      Number(!!b.person.isAlumni) - Number(!!a.person.isAlumni) ||
      connected(b.person) - connected(a.person) ||
      a.person.displayName.localeCompare(b.person.displayName),
  );
  former.sort((a, b) => b.strength - a.strength || a.person.displayName.localeCompare(b.person.displayName));
  const table = bestPathsFrom(g, 'user', 3);
  const twoHop: CompanyReach['twoHop'] = [];
  for (const d of direct) {
    if (d.strength >= 0.3) continue;
    const path = table.path(d.person.id);
    if (path && path.length > 2) twoHop.push({ target: d.person, path: toReachPath(g, path) });
  }
  twoHop.sort((a, b) => b.path.score - a.path.score);
  const alumni = direct.filter((d) => d.person.isAlumni);
  return { org, direct, former, alumni, twoHop: twoHop.slice(0, 3) };
}
