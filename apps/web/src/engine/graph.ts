import type {
  Affiliation,
  CoffeeChat,
  Edge,
  ExternalCandidate,
  Organization,
  Person,
  ReachHop,
  ReachPath,
  RoutePerson,
  TargetCompany,
  Tie,
  TiePair,
  User,
  WarmPath,
} from '@orbit/core';
import {
  addEdge,
  bestPathsFrom,
  combinedPairWeights,
  contactedStage,
  DIRECT_TIE_SCORE,
  describePairHop,
  describeUserTie,
  functionOf,
  HOP_WEIGHTS,
  hasHistoryWith,
  hopBand,
  inferEdges,
  kShortestPaths,
  MEDIUM_TIE,
  MUTUAL_MIN_SCORE,
  makeGraph,
  mergeTies,
  normalizeCompany,
  type PathTable,
  pAsk,
  pairEvidenceTies,
  pairKeyOf,
  pairPhrase,
  pairsFromEdges,
  pKnowDirected,
  rankCompanyTargets,
  rankWarmPaths,
  responsePrior,
  seniorityClass,
  toReachPath,
  USER_NODE,
  type WeightedGraph,
} from '@orbit/core';
import { db } from '../db/schema';
import { storedEvidence } from './hopEvidence';
import { pairNotesFor } from './pairNotes';

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

/**
 * Edges for a few people only (someone just added from a LinkedIn search, or given a LinkedIn member id): the
 * inference runs over everyone (it is pure, and a person's company and school edges need the whole group), but only
 * the edges touching these people are rewritten, so the rest of the stored graph is left as it was.
 */
export async function updateEdgesFor(userId: string, personIds: string[]): Promise<number> {
  const ids = new Set(personIds);
  if (!ids.size) return 0;
  const [people, affiliations, orgs, threads, events] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.affiliations.where('userId').equals(userId).toArray(),
    db.organizations.toArray(),
    db.threads.where('userId').equals(userId).toArray(),
    db.events.where('userId').equals(userId).toArray(),
  ]);
  const touches = (e: Pick<Edge, 'personAId' | 'personBId'>) => ids.has(e.personAId) || ids.has(e.personBId);
  const edges = inferEdges({
    userId,
    people,
    affiliations,
    organizations: new Map(orgs.map((o) => [o.id, o])),
    threads,
    events,
  }).filter(touches);
  await db.transaction('rw', db.edges, async () => {
    await db.edges.where('userId').equals(userId).filter(touches).delete();
    await db.edges.bulkPut(edges.map((e) => ({ ...e, id: `${userId}:${e.id}` })));
  });
  return edges.length;
}

export async function buildReachGraph(
  userId: string,
  now: Date = new Date(),
): Promise<{ g: WeightedGraph; people: Map<string, Person>; edges: Edge[] }> {
  const [people, edges, user, chats, asks] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.edges.where('userId').equals(userId).toArray(),
    db.users.get(userId),
    db.chats.where('userId').equals(userId).toArray(),
    db.outbound
      .where('userId')
      .equals(userId)
      .filter((o) => o.kind === 'intro_request')
      .toArray(),
  ]);
  return reachGraphFrom(people, edges, now, {
    user,
    chats,
    introAsks: asks,
    evidence: await evidenceTies(userId, people, now),
  });
}

/** Plan 21's pair evidence for the reach graph: stored LinkedIn activity and what the student said about pairs. */
async function evidenceTies(
  userId: string,
  people: Person[],
  now: Date,
): Promise<{ ties: Tie[]; blocked: ReadonlySet<string> }> {
  const [evidence, notes] = await Promise.all([storedEvidence(userId, people, now), pairNotesFor(userId)]);
  const ids = new Set(people.filter((p) => p.isHuman && !p.hiddenAt).map((p) => p.id));
  return {
    ties: pairEvidenceTies({ userId, people: ids, now, ...evidence, studentSays: notes.close }),
    blocked: notes.blocked,
  };
}

/** Lowest weight for a LinkedIn connection with no other history: accepted, so not a stranger, but no more. */
export const LINKEDIN_ONLY_WEIGHT = 0.12;

export function userTieWeight(p: Person): number {
  return Math.max(p.strength > 0.02 ? p.strength : 0, p.linkedinConnectedOn ? LINKEDIN_ONLY_WEIGHT : 0);
}

/** What the v2 route ranking (plan 16 §4.2) needs beyond the graph: the people as routing sees them, and the pairs. */
interface ReachContext {
  people: Map<string, Person>;
  routePeople: Map<string, RoutePerson>;
  pairs: Map<string, TiePair>;
  /** pairs the student said do not really know each other (plan 21 §3.5) */
  blocked: ReadonlySet<string>;
  user?: Pick<User, 'school' | 'majors' | 'graduationYear'>;
  now: Date;
}

const contexts = new WeakMap<WeightedGraph, ReachContext>();

const DAY = 86_400_000;

function routePeopleFrom(
  map: Map<string, Person>,
  edges: Edge[],
  now: Date,
  extra: { chats?: CoffeeChat[]; introAsks?: { personId: string; createdAt: string }[] },
): Map<string, RoutePerson> {
  // someone who introduced the student before is likelier to do it again (§4.2)
  const introducers = new Set(
    edges
      .filter((e) => e.type === 'introduced_by' && typeof e.evidence.introducerId === 'string')
      .map((e) => e.evidence.introducerId as string),
  );
  // the student owes a reply where the other person wrote last; an intro asked in the last 30 days is not asked again
  const owes = new Set(
    (extra.chats ?? [])
      .filter(
        (c) => !c.archivedAt && c.lastInboundAt && (!c.lastOutboundAt || c.lastInboundAt > c.lastOutboundAt),
      )
      .map((c) => c.personId),
  );
  const asked = new Set(
    (extra.introAsks ?? [])
      .filter((o) => now.getTime() - new Date(o.createdAt).getTime() < 30 * DAY)
      .map((o) => o.personId),
  );
  const out = new Map<string, RoutePerson>();
  for (const p of map.values())
    out.set(p.id, {
      id: p.id,
      name: p.firstName || p.displayName,
      score: Math.round(userTieWeight(p) * 100),
      reciprocity: p.strengthBreakdown?.tieScore?.features.reciprocity,
      introducedUserBefore: introducers.has(p.id),
      owesReply: owes.has(p.id),
      askedRecently: asked.has(p.id),
      lastContactAt: p.strengthBreakdown?.lastConversationAt,
    });
  return out;
}

export function reachGraphFrom(
  people: Person[],
  edges: Edge[],
  now: Date = new Date(),
  extra: {
    user?: Pick<User, 'school' | 'majors' | 'graduationYear'>;
    chats?: CoffeeChat[];
    introAsks?: { personId: string; createdAt: string }[];
    /** plan 21: LinkedIn activity, recommendations and the student's word between contacts, and blocked pairs */
    evidence?: { ties: Tie[]; blocked: ReadonlySet<string> };
  } = {},
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
  const known = edges.filter((e) => map.has(e.personAId) && map.has(e.personBId));
  contexts.set(g, {
    people: map,
    routePeople: routePeopleFrom(map, known, now, extra),
    pairs: mergeTies(pairsFromEdges(known, now), extra.evidence?.ties ?? [], now),
    blocked: extra.evidence?.blocked ?? new Set(),
    user: extra.user,
    now,
  });
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

/** A route as the Reach panels read it, with what the v2 ranking (plan 16 §4.2) says about it. */
export interface WarmReachPath extends ReachPath {
  /** core's plain reason, e.g. "Through Mia, a faint tie (12): Mia is connected to Kenji on LinkedIn." */
  reason?: string;
  /** kept only because its first hop is a LinkedIn mutual of the target: a weaker route, but a real connection */
  weak?: boolean;
  /** where the last hop's evidence came from, when it is from outside Orbit's own records */
  via?: 'linkedin_mutual' | 'village_path';
}

/**
 * Routes to one person, with the ways in Orbit's own records do not show: the target's LinkedIn mutuals (the
 * student's first-degree connections LinkedIn says know them) and Village's introducers, matched to people Orbit has
 * (engine/externalRoutes.ts). The Map and the chat's find_routes read this. `external: false` is the graph alone.
 */
export async function reachPerson(
  userId: string,
  targetPersonId: string,
  k = 3,
  opts: { external?: boolean; signal?: AbortSignal } = {},
): Promise<WarmReachPath[]> {
  const [{ g }, candidates] = await Promise.all([
    buildReachGraph(userId),
    opts.external === false ? [] : reachCandidates(userId, targetPersonId, opts),
  ]);
  return reachPersonIn(g, targetPersonId, k, candidates);
}

/**
 * LinkedIn mutuals and Village introducers for one target, as route candidates. Never throws: anything that fails
 * (LinkedIn not connected, Village not set up, a timeout) leaves Orbit's own routes standing alone.
 */
export async function reachCandidates(
  userId: string,
  targetPersonId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExternalCandidate[]> {
  try {
    const [user, target] = await Promise.all([db.users.get(userId), db.people.get(targetPersonId)]);
    if (!user || !target || target.userId !== userId) return [];
    // loaded when first needed: it reaches the LinkedIn and Village connectors, which import this file
    const { externalCandidates } = await import('./externalRoutes');
    return await externalCandidates(user, target, opts);
  } catch {
    return [];
  }
}

/** How a LinkedIn mutual stands as a way to the target (plan 21 §3.7): both halves, and the product they sort by. */
export interface MutualStanding {
  /** the chance the student's ask to them works out */
  ask: number;
  /** how well they know the target */
  know: number;
  band: ReturnType<typeof hopBand>;
  /** what the evidence between them and the target says, after their first name */
  phrase: string;
  /** the student said they do not really know the target */
  blocked: boolean;
}

/**
 * For "People who know {target}": each mutual's standing, from the same pairs and the same numbers the routes use, so
 * the list and the routes never disagree. A mutual is a LinkedIn connection of the target's, so its pair with the
 * target carries the connection whatever else is known.
 */
export function mutualStandings(
  g: WeightedGraph,
  targetId: string,
  personIds: string[],
): Map<string, MutualStanding> {
  const out = new Map<string, MutualStanding>();
  const ctx = contexts.get(g);
  if (!ctx) return out;
  const tName = ctx.people.get(targetId)?.firstName || ctx.people.get(targetId)?.displayName || 'them';
  for (const id of personIds) {
    if (id === targetId) continue;
    const key = pairKeyOf(id, targetId);
    const [a, b] = key.split('|') as [string, string];
    const base = ctx.pairs.get(key);
    const pair = base?.kinds.includes('linkedin_mutual')
      ? base
      : mergeTies(
          base ? new Map([[key, base]]) : new Map(),
          [
            {
              id: `${key}|linkedin_mutual`,
              userId: '',
              aId: a,
              bId: b,
              kind: 'linkedin_mutual',
              weight: HOP_WEIGHTS.mutual,
              confidence: 0.95,
              evidence: { source: 'unipile' },
            },
          ],
          ctx.now,
        ).get(key)!;
    const rp = ctx.routePeople.get(id);
    // how well the target knows them: the target's own engagement counts, theirs toward the target does not
    const know = pKnowDirected(pair, id, targetId);
    out.set(id, {
      ask: pAsk({ ...(rp ?? { score: 0 }), score: Math.max(rp?.score ?? 0, MUTUAL_MIN_SCORE) }),
      know,
      band: hopBand(know),
      phrase: pairPhrase(id, pair, tName, ctx.now),
      blocked: ctx.blocked.has(key),
    });
  }
  return out;
}

/** v2 bands in the v1 words: high is a strong route, medium possible, low a long shot. */
const BAND: Record<WarmPath['band'], ReachPath['band']> = {
  high: 'strong',
  medium: 'possible',
  low: 'long_shot',
};

const EXTERNAL = new Set(['linkedin_mutual', 'village_path']);

/**
 * A v2 route (§4.2) in the shape the Reach panels read, with the v1 hop texts. A hop the graph has no edge for came
 * from LinkedIn or Village, and says so; a first hop to someone Orbit has no history with is the LinkedIn connection
 * a mutual is.
 */
function toV2ReachPath(g: WeightedGraph, w: WarmPath, ctx?: ReachContext): WarmReachPath {
  if (w.nodes.length === 2) {
    const direct = toReachPath(g, [USER_NODE, w.nodes[1]!]);
    // writing straight to someone the student is tied to is never a long shot
    return { hops: direct.hops, score: w.p, band: w.band === 'low' ? 'possible' : BAND[w.band] };
  }
  const first = (id: string) => {
    const p = ctx?.people.get(id);
    return p?.firstName || p?.displayName || 'them';
  };
  const lastKind = w.hops[w.hops.length - 1]?.kind;
  const hops: ReachHop[] = w.hops.map((h, i) => {
    const e = g.adj.get(h.fromId)?.get(h.toId);
    let text = e?.text ?? '';
    // plan 21: past the student's own tie, a hop says what the evidence on it says, and how well the two know each other
    if (i > 0 && h.phrase)
      return {
        fromId: h.fromId,
        toId: h.toId,
        weight: h.p,
        type: h.kind === 'strength' ? 'strength' : h.kind,
        text: `${first(h.fromId)} ${h.phrase}`,
        ...(h.band ? { band: h.band } : {}),
        ...(h.fading ? { fading: true } : {}),
      };
    if (EXTERNAL.has(h.kind))
      text =
        h.kind === 'linkedin_mutual'
          ? `${first(h.fromId)} is connected to ${first(h.toId)} on LinkedIn`
          : `${first(h.fromId)} knows ${first(h.toId)} (via Village)`;
    else if (!text && i === 0) {
      const p = ctx?.people.get(h.toId);
      text =
        p && (p.linkedinConnectedOn || lastKind !== 'linkedin_mutual')
          ? describeUserTie(p, ctx?.now)
          : `You're connected with ${first(h.toId)} on LinkedIn`;
    }
    return {
      fromId: h.fromId,
      toId: h.toId,
      weight: h.p,
      type: h.kind === 'strength' ? 'strength' : h.kind,
      text,
    };
  });
  return {
    hops,
    score: w.p,
    band: BAND[w.band],
    reason: w.reasonText,
    ...(w.weak ? { weak: true } : {}),
    ...(lastKind && EXTERNAL.has(lastKind) ? { via: lastKind as WarmReachPath['via'] } : {}),
  };
}

/**
 * Routes to one person. A graph built from the student's records (reachGraphFrom) is ranked by plan 16 §4.2: the
 * chance the introduction happens and the best route per first hop. Two placements keep the Reach panels' v1
 * contract instead of §4.2's: someone the student knows well (a Warm tie or closer) is written to first, with the
 * other ways in after it (§4.2 would skip routing), and a fainter tie comes after the warmer routes (the panels say
 * why it is not the first suggestion), scored at the chance they answer; with no route it comes first. A bare graph
 * keeps the v1 ranking (product of hop weights).
 */
export function reachPersonIn(
  g: WeightedGraph,
  targetPersonId: string,
  k = 3,
  candidates: ExternalCandidate[] = [],
): WarmReachPath[] {
  const ctx = contexts.get(g);
  if (!ctx) return reachPersonV1(g, targetPersonId, k);
  const tie = g.adj.get(USER_NODE)?.get(targetPersonId);
  const target = ctx.people.get(targetPersonId);
  const known = !!target && !!tie && Math.round(tie.weight * 100) >= DIRECT_TIE_SCORE;
  // the core ranking does not route to someone the student knows; the panel still lists the other ways in
  const people = known
    ? new Map(ctx.routePeople).set(targetPersonId, { ...ctx.routePeople.get(targetPersonId)!, score: 0 })
    : ctx.routePeople;
  const r = rankWarmPaths({
    targetId: targetPersonId,
    target: target
      ? { name: target.firstName || target.displayName, isAlum: target.isAlumni, title: target.currentTitle }
      : undefined,
    people,
    pairs: ctx.pairs,
    candidates,
    blockedPairs: ctx.blocked,
    now: ctx.now,
    limit: Math.max(k, 5),
  });
  const routes = r.paths.map((w) => toV2ReachPath(g, w, ctx));
  // the student asked for a way in: warm routes first, writing to them directly after (they know them, so it is
  // offered, never the only answer)
  if (known) return [...routes.slice(0, k), toReachPath(g, [USER_NODE, targetPersonId])];
  if (!tie || !target) return routes.slice(0, k);
  const pReply = responsePrior(target, {
    school: ctx.user?.school ?? '',
    majors: ctx.user?.majors ?? [],
    gradYear: ctx.user?.graduationYear,
  });
  const direct = toV2ReachPath(g, {
    nodes: [USER_NODE, targetPersonId],
    hops: [],
    p: pReply,
    band: pReply >= 0.35 ? 'high' : pReply >= 0.15 ? 'medium' : 'low',
    firstHopId: targetPersonId,
    otherWays: 0,
    reasonText: '',
  });
  return [...routes.slice(0, k), direct];
}

function reachPersonV1(g: WeightedGraph, targetPersonId: string, k = 3): ReachPath[] {
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
  // Someone the student is already tied to, however faintly (a LinkedIn connection, an email that went unanswered),
  // can always be written to directly. Someone they know well is written to first, never asked for through others.
  // A faint tie that warmer routes outrank comes last, so the panel can offer it and say why it is not the first
  // suggestion, instead of leaving the student to wonder why they need two people to reach someone they know.
  const tie = g.adj.get('user')?.get(targetPersonId);
  if (!tie) return out;
  const direct = out.find((p) => p.hops.length === 1) ?? toReachPath(g, ['user', targetPersonId]);
  const others = out.filter((p) => p !== direct);
  return tie.weight >= MEDIUM_TIE || out[0] === direct ? [direct, ...others] : [...others, direct];
}

/** Why the panels suggest routes through other people to someone the student already has on their map. */
export const WARMER_ROUTES_WHY =
  'You know these people only slightly, so a word from someone who knows them is likelier to get a reply than a note from you alone.';

/** True when a route is the student writing straight to someone they barely know: a cold note. */
export function isColdDirect(p: ReachPath): boolean {
  return p.hops.length === 1 && p.hops[0]!.weight < MEDIUM_TIE;
}

export interface CompanyReach {
  org?: Organization;
  /** people there now the student knows, strongest first, then alumni of the student's school, then newest connections */
  direct: { person: Person; strength: number }[];
  /** people there now saved to contact (added by hand or from a LinkedIn search) with no history yet: not "known" */
  saved: { person: Person; strength: number }[];
  /** left the company within the last five years; weighted down the longer ago they left */
  former: { person: Person; strength: number; endedAt?: string }[];
  /** alumni among `direct` (same people; the map shows them as a badge rather than a second list) */
  alumni: { person: Person; strength: number }[];
  twoHop: { target: Person; path: ReachPath }[];
  /**
   * Plan 23 §4.2: everyone there now in one list, each with their team, whether they are an alum, and the way in as
   * the Map shows it (a direct tie's score, the best warm route, or cold), sorted by team and then by route score.
   */
  people: CompanyPerson[];
}

/** The teams a company page groups people by: a function from the title, Leadership for C-level, Other for the rest. */
export type CompanyTeam =
  | 'engineering'
  | 'product'
  | 'design'
  | 'data'
  | 'research'
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'operations'
  | 'recruiting'
  | 'legal'
  | 'consulting'
  | 'leadership'
  | 'other';

export const COMPANY_TEAM_LABELS: Record<CompanyTeam, string> = {
  engineering: 'Engineering',
  product: 'Product',
  design: 'Design',
  data: 'Data',
  research: 'Research',
  sales: 'Sales',
  marketing: 'Marketing',
  finance: 'Finance',
  operations: 'Operations',
  recruiting: 'Recruiting',
  legal: 'Legal',
  consulting: 'Consulting',
  leadership: 'Leadership',
  other: 'Other',
};

/** Recruiters are named first: "Technical Recruiter, Engineering" is recruiting, whatever team it serves. */
const RECRUITING = /\b(recruit\w*|talent acquisition|talent partner|university relations|campus)\b/i;

/** Which team a title puts someone on (plan 23 §4.2). */
export function teamOf(title: string | undefined): CompanyTeam {
  if (seniorityClass(title) === 2) return 'leadership';
  if (RECRUITING.test(title ?? '')) return 'recruiting';
  return (functionOf(title) as CompanyTeam | undefined) ?? 'other';
}

/** The team a title names after its comma: "Product Manager, Payments" is on Payments. */
export function teamNameOf(title: string | undefined): string | undefined {
  const [, ...rest] = (title ?? '').split(/\s*,\s*/);
  const t = rest.join(', ').trim();
  return t && t.length <= 40 ? t : undefined;
}

export interface CompanyRoute {
  /** direct: the student knows them (or has a faint tie and no warmer way); warm: through someone; cold: no way yet */
  kind: 'direct' | 'warm' | 'cold';
  path?: WarmReachPath;
  /** 0..1, as the Map's badge shows it out of 100; 0 when cold */
  score: number;
  band?: ReachPath['band'];
  /** the route in the Map's words: "via Kenji (your tie · 52)", "You know Dana directly · your tie · 68" */
  line: string;
  /** the first person on a warm route, who is asked for the intro */
  via?: { id: string; name: string };
}

export interface CompanyPerson {
  person: Person;
  team: CompanyTeam;
  /** what their title says after the comma, when it names a team */
  teamName?: string;
  seniority?: ReturnType<typeof seniorityClass>;
  alum: boolean;
  route: CompanyRoute;
  /** the one button on the row: Write to (direct), Ask {first hop} (warm), Warm up (cold, on LinkedIn), Save (cold) */
  action: 'write' | 'ask' | 'warm_up' | 'save';
}

/** How many people past the ones the student knows get a full route; the rest are ranked by the quick estimate. */
export const COMPANY_ROUTED = 30;

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
  const { g, people } = await buildReachGraph(userId, now);
  const affs = await db.affiliations.where('userId').equals(userId).toArray();
  const affsByPerson = new Map<string, Affiliation[]>();
  for (const a of affs) {
    if (a.kind !== 'employment' || a.isCurrent) continue;
    const arr = affsByPerson.get(a.personId) ?? [];
    arr.push(a);
    affsByPerson.set(a.personId, arr);
  }
  // a chat past "to contact" is history; one still waiting to be written is not
  const contacted = new Set(
    (await db.chats.where('userId').equals(userId).toArray())
      .filter((c) => contactedStage(c.stage))
      .map((c) => c.personId),
  );
  const direct: CompanyReach['direct'] = [];
  const saved: CompanyReach['saved'] = [];
  const former: CompanyReach['former'] = [];
  for (const p of people.values()) {
    const here =
      (org && p.currentOrganizationId === org.id) ||
      (!!norm && normalizeCompany(p.currentOrganizationRaw) === norm);
    if (here) {
      // someone the student only saved to contact is there, but is not someone they know
      (hasHistoryWith(p, { contacted: contacted.has(p.id) }) ? direct : saved).push({
        person: p,
        strength: p.strength,
      });
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
  saved.sort((a, b) => a.person.displayName.localeCompare(b.person.displayName));
  // routes to the people there the student does not know well (the ones only saved to contact first of all): every
  // one of them at a small company; at a big one, the ones personalized PageRank (plan 16 §4.2) says the student's
  // network reaches best; the route shown is the one Reach shows for that person
  let reachable = [...saved, ...direct.filter((d) => d.strength < MEDIUM_TIE)];
  const ctx = contexts.get(g);
  if (ctx && reachable.length > 10) {
    const ranked = rankCompanyTargets({
      people: ctx.routePeople,
      pairs: ctx.pairs,
      targets: reachable.map((d) => ({
        id: d.person.id,
        name: d.person.firstName,
        title: d.person.currentTitle,
      })),
      now: ctx.now,
      limit: 10,
    });
    const chosen = new Set(ranked.map((x) => x.target.id));
    reachable = reachable.filter((d) => chosen.has(d.person.id));
  }
  const twoHop: CompanyReach['twoHop'] = [];
  for (const d of reachable) {
    const first = reachPersonIn(g, d.person.id, 1)[0];
    if (first && first.hops.length > 1) twoHop.push({ target: d.person, path: first });
  }
  twoHop.sort((a, b) => b.path.score - a.path.score);
  const alumni = direct.filter((d) => d.person.isAlumni);
  return {
    org,
    direct,
    saved,
    former,
    alumni,
    twoHop: twoHop.slice(0, 3),
    people: companyPeople(
      g,
      [...direct, ...saved].map((d) => d.person),
    ),
  };
}

/** The tie words the Map's route card uses for the student's own tie: "warm tie · 48". */
function tieWordsOf(p: Person): string {
  const s = Math.round(userTieWeight(p) * 100);
  return `${s >= DIRECT_TIE_SCORE ? 'your' : 'a faint'} tie · ${s}`;
}

/**
 * Everyone at a company with the way in, as the Map would show it for each: someone the student knows gets the
 * direct route and its score; anyone else the best route Reach finds through people the student knows (the
 * COMPANY_ROUTED most reachable of them, at a big company); with none, cold. Sorted by team (Other last), then route
 * score, alumni first within a tie.
 */
export function companyPeople(g: WeightedGraph, here: Person[]): CompanyPerson[] {
  const tieOf = (p: Person) => Math.round((g.adj.get(USER_NODE)?.get(p.id)?.weight ?? 0) * 100);
  const known = here.filter((p) => tieOf(p) >= DIRECT_TIE_SCORE);
  const knownIds = new Set(known.map((p) => p.id));
  const rest = here.filter((p) => !knownIds.has(p.id));
  // a big company: full routes for the ones the network reaches best by the quick estimate (one search for all)
  const routed = new Set(
    (rest.length > COMPANY_ROUTED
      ? [...rest]
          .sort((a, b) => bestPathStrength(g, b.id) - bestPathStrength(g, a.id))
          .slice(0, COMPANY_ROUTED)
      : rest
    ).map((p) => p.id),
  );
  const first = (id: string) => {
    const p = contexts.get(g)?.people.get(id);
    return p?.firstName || p?.displayName || 'someone';
  };
  const out: CompanyPerson[] = here.map((person) => {
    const title = person.currentTitle;
    let route: CompanyRoute;
    if (knownIds.has(person.id)) {
      const direct = toReachPath(g, [USER_NODE, person.id]) as WarmReachPath;
      route = {
        kind: 'direct',
        path: direct,
        score: direct.score,
        band: direct.band,
        line: `You know ${person.firstName || person.displayName} directly · ${tieWordsOf(person)}`,
      };
    } else {
      const best = routed.has(person.id) ? reachPersonIn(g, person.id, 1)[0] : undefined;
      if (best && best.hops.length > 1) {
        const via = best.hops[0]!.toId;
        const viaPerson = contexts.get(g)?.people.get(via);
        route = {
          kind: 'warm',
          path: best,
          score: best.score,
          band: best.band,
          via: { id: via, name: first(via) },
          line: `via ${first(via)}${viaPerson ? ` (${tieWordsOf(viaPerson)})` : ''}${
            best.hops.length > 2
              ? `, then ${best.hops
                  .slice(1, -1)
                  .map((h) => first(h.toId))
                  .join(', then ')}`
              : ''
          }`,
        };
      } else if (best) {
        route = {
          kind: 'direct',
          path: best,
          score: best.score,
          band: best.band,
          line: `You know ${person.firstName || person.displayName} only slightly · ${tieWordsOf(person)}`,
        };
      } else route = { kind: 'cold', score: 0, line: 'No one you know knows them yet' };
    }
    const action: CompanyPerson['action'] =
      route.kind === 'warm'
        ? 'ask'
        : route.kind === 'direct'
          ? 'write'
          : person.linkedinSlug
            ? 'warm_up'
            : 'save';
    return {
      person,
      team: teamOf(title),
      teamName: teamNameOf(title),
      seniority: seniorityClass(title),
      alum: !!person.isAlumni,
      route,
      action,
    };
  });
  const order = Object.keys(COMPANY_TEAM_LABELS) as CompanyTeam[];
  const rank = (t: CompanyTeam) => (t === 'other' ? 99 : order.indexOf(t));
  return out.sort(
    (a, b) =>
      rank(a.team) - rank(b.team) ||
      b.route.score - a.route.score ||
      Number(b.alum) - Number(a.alum) ||
      a.person.displayName.localeCompare(b.person.displayName),
  );
}
