import { TIE_BAND_LABELS, tieBand } from '../scoring/tieScore';
import type { GoalKind } from '../types';
import { addEdge, kShortestPaths, makeGraph, type WeightedGraph } from './paths';
import { personalizedPageRank } from './ppr';
import { decayedTieWeight, isRoutable, type Tie, type TieKind, type TiePair } from './ties';

/**
 * Warm path ranking v2 (plan 16 §4.2): routes are ranked by the chance the introduction actually happens. The first
 * hop is "will the student ask, and will A agree" (p_ask, from A's tie score), every other hop "do these two know
 * each other" (p_know, from the ties of §4.1), the last hop is scaled by how receptive the target is, and longer or
 * older routes are discounted. Yen's k-shortest paths (paths.ts) runs over −ln p. Pure and deterministic.
 */

export const USER_NODE = 'user';

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const DAY = 86_400_000;

export interface AskFeatures {
  /** A's tie score, 0–100 */
  score: number;
  /** A's reciprocity with the student (f5), 0–1 */
  reciprocity?: number;
  /** A introduced the student to someone before */
  introducedUserBefore?: boolean;
  /** A works at an organization one of the student's active goals targets */
  sharesGoalTargetOrg?: boolean;
  /** the student asked A for an introduction in the last 30 days */
  askedRecently?: boolean;
  /** the student owes A a reply */
  owesReply?: boolean;
}

/** Probability that asking A for this introduction works out (§4.2). */
export function pAsk(f: AskFeatures): number {
  return sigmoid(
    -2.0 +
      (4.0 * Math.max(0, Math.min(100, f.score))) / 100 +
      0.8 * Math.max(0, Math.min(1, f.reciprocity ?? 0)) +
      (f.introducedUserBefore ? 0.6 : 0) +
      (f.sharesGoalTargetOrg ? 0.3 : 0) -
      (f.askedRecently ? 0.7 : 0) -
      (f.owesReply ? 0.5 : 0),
  );
}

/**
 * Probability that two of the student's contacts know each other well enough for one to introduce the other. §4.2
 * writes it as w_pair · c_pair, but w_pair is already the noisy-OR of w_k · c_k, and the plan's own examples (a
 * mutual-only pair is 0.3 × 0.95, a Village edge warmth × 0.7) are w_pair alone, so the confidence is not counted
 * twice: p_know = w_pair.
 */
export function pKnow(pair: Pick<TiePair, 'weight'>): number {
  return Math.max(0, Math.min(1, pair.weight));
}

const C_LEVEL =
  /\b(ceo|cfo|coo|cto|cmo|cpo|cio|ciso|chief|president|partner|managing director|founder|co-founder|cofounder)\b/i;
const SENIOR = /\b(director|vp|vice president|head of|principal|general manager|svp|evp)\b/i;
const JUNIOR_OR_MANAGER =
  /\b(intern|analyst|associate|engineer|developer|designer|scientist|researcher|manager|coordinator|specialist|consultant|representative|recruiter|assistant|lead|student|fellow)\b/i;

export interface TargetInfo {
  id: string;
  name?: string;
  /** an alum of the student's school */
  isAlum?: boolean;
  title?: string;
  /** chance they answer the student directly (the existing responsePrior), for a direct route */
  pReply?: number;
}

/** How receptive the target is to an introduction (§4.2), from school and title keywords, in [0.7, 1.3]. */
export function targetReceptivity(t: Pick<TargetInfo, 'isAlum' | 'title'>): number {
  const title = t.title ?? '';
  const cLevel = C_LEVEL.test(title);
  const atMostManager = !cLevel && !SENIOR.test(title) && JUNIOR_OR_MANAGER.test(title);
  const r = 1 + (t.isAlum ? 0.15 : 0) + (atMostManager ? 0.1 : 0) - (cLevel ? 0.15 : 0);
  return Math.max(0.7, Math.min(1.3, r));
}

/**
 * Lowest tie score a first hop may have, by goal (§4.2): asking a weak tie to vouch to an investor does more harm
 * than good; for recruiting and advice a light tie is enough. Goals the plan does not name use no floor.
 */
export function firstHopFloor(goal: GoalKind | undefined): number {
  if (goal === 'fundraising') return 40;
  if (goal === 'recruiting' || goal === 'advice') return 20;
  return 0;
}

export const HOP_PENALTY = 0.85;
export const OLD_EVIDENCE_YEARS = 3;
export const OLD_EVIDENCE_FACTOR = 0.7;
export const DIRECT_TIE_SCORE = 40;
export const MIN_PATH_P = 0.05;

export interface RoutePerson {
  id: string;
  /** first name, for the reason text */
  name: string;
  /** tie score with the student, 0–100 (0 when they have no tie) */
  score: number;
  reciprocity?: number;
  introducedUserBefore?: boolean;
  sharesGoalTargetOrg?: boolean;
  askedRecently?: boolean;
  owesReply?: boolean;
  /** the student's last real contact with them, for the old-evidence discount on the first hop */
  lastContactAt?: string;
  /** hidden by the student: never an intermediary */
  hidden?: boolean;
  /** they declined an intro request: not used as an intermediary for 90 days */
  declinedIntroAt?: string;
}

/** A route offered from outside the local graph: a LinkedIn mutual or a Village introducer (§4.2 steps 3–4). */
export interface ExternalCandidate {
  /** the first hop, resolved to a local person */
  introducerId: string;
  kind: 'linkedin_mutual' | 'village_path';
  /** Village warmth, 0–1 */
  warmth?: number;
  seenAt?: string;
}

export interface WarmPathInput {
  targetId: string;
  target?: Omit<TargetInfo, 'id'>;
  goal?: GoalKind;
  people: ReadonlyMap<string, RoutePerson>;
  /** pairs between contacts, keyed `${a}|${b}` with a < b (combineTies / pairsFromEdges) */
  pairs: ReadonlyMap<string, TiePair>;
  candidates?: ExternalCandidate[];
  now?: Date;
  /** Yen's k */
  k?: number;
  maxHops?: number;
  limit?: number;
}

export interface WarmHop {
  fromId: string;
  toId: string;
  p: number;
  /** the strongest evidence on this hop; 'strength' for the student's own tie */
  kind: TieKind | 'strength';
}

export interface WarmPath {
  /** USER_NODE first, the target last */
  nodes: string[];
  hops: WarmHop[];
  /** chance the introduction happens */
  p: number;
  band: 'high' | 'medium' | 'low';
  firstHopId: string;
  /** routes into the target through other first hops */
  otherWays: number;
  reasonText: string;
}

export interface WarmPathResult {
  paths: WarmPath[];
  fallback?: 'cold';
  /** the target is already a direct tie (score ≥ 40): write to them; no routing */
  direct?: { score: number; band: string; text: string };
}

export function pathBand(p: number): WarmPath['band'] {
  if (p >= 0.35) return 'high';
  if (p >= 0.15) return 'medium';
  return 'low';
}

const pk = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function withExternal(
  pairs: ReadonlyMap<string, TiePair>,
  targetId: string,
  candidates: ExternalCandidate[],
): ReadonlyMap<string, TiePair> {
  if (!candidates.length) return pairs;
  const out = new Map(pairs);
  for (const c of candidates) {
    if (c.introducerId === targetId) continue;
    const key = pk(c.introducerId, targetId);
    const [a, b] = key.split('|') as [string, string];
    const w = c.kind === 'linkedin_mutual' ? 0.3 : Math.max(0, Math.min(1, c.warmth ?? 0));
    const conf = c.kind === 'linkedin_mutual' ? 0.95 : 0.7;
    const tie: Tie = {
      id: `${key}|${c.kind}`,
      userId: '',
      aId: a,
      bId: b,
      kind: c.kind,
      weight: w,
      confidence: conf,
      evidence: { source: c.kind === 'linkedin_mutual' ? 'unipile' : 'village' },
      lastSeenAt: c.seenAt,
    };
    const cur = out.get(key);
    if (cur?.kinds.includes(c.kind)) continue;
    out.set(key, {
      aId: a,
      bId: b,
      weight: 1 - (1 - (cur?.weight ?? 0)) * (1 - w * conf),
      confidence: 1 - (1 - (cur?.confidence ?? 0)) * (1 - conf),
      kinds: [...(cur?.kinds ?? []), c.kind],
      ties: [...(cur?.ties ?? []), tie],
      lastSeenAt: cur?.lastSeenAt,
    });
  }
  return out;
}

function usable(p: RoutePerson | undefined, now: Date): boolean {
  if (!p || p.hidden) return false;
  if (p.declinedIntroAt) {
    const t = new Date(p.declinedIntroAt).getTime();
    if (!Number.isNaN(t) && now.getTime() - t < 90 * DAY) return false;
  }
  return true;
}

function strongestTie(pair: TiePair, now: Date): Tie | undefined {
  return [...pair.ties].sort(
    (x, y) => decayedTieWeight(y, now) * y.confidence - decayedTieWeight(x, now) * x.confidence,
  )[0];
}

function pairIsOld(pair: TiePair, now: Date): boolean {
  const cutoff = now.getTime() - OLD_EVIDENCE_YEARS * 365.25 * DAY;
  let newest = pair.lastSeenAt ? new Date(pair.lastSeenAt).getTime() : Number.NaN;
  for (const t of pair.ties) {
    const ev = t.evidence as Record<string, unknown>;
    if (ev.ongoing || (Array.isArray(ev.current) && ev.current.length === 2)) return false;
    if (typeof ev.toYear === 'number') {
      const end = Date.UTC(ev.toYear, 11, 31);
      newest = Number.isNaN(newest) ? end : Math.max(newest, end);
    }
  }
  return !Number.isNaN(newest) && newest < cutoff;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthYear(iso: unknown): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The evidence phrase for a hop A → B (§4.2), from the strongest tie kind on it. */
export function hopEvidence(fromId: string, tie: Tie | undefined, toName: string): string {
  if (!tie) return `knows ${toName}`;
  const ev = tie.evidence as Record<string, unknown>;
  const org = typeof ev.orgName === 'string' ? ev.orgName : undefined;
  switch (tie.kind) {
    case 'email_exchange':
      return `emails with ${toName}`;
    case 'email_cc':
      return `is on email with ${toName}`;
    case 'email_cothread':
      return `was on an email thread with ${toName}`;
    case 'meeting_coattendee': {
      const when = monthYear(ev.lastAt ?? tie.lastSeenAt);
      return `met ${toName}${when ? ` (${when})` : ''}`;
    }
    case 'introduced_by':
      return ev.introducerId === fromId
        ? `introduced you to ${toName}`
        : `was introduced to you by ${toName}`;
    case 'linkedin_mutual':
      return `is connected to ${toName} on LinkedIn`;
    case 'village_path':
      return `knows ${toName} (via Village)`;
    case 'co_tenure': {
      const from = typeof ev.fromYear === 'number' ? ev.fromYear : undefined;
      const to = typeof ev.toYear === 'number' ? ev.toYear : undefined;
      const years =
        from === undefined
          ? ''
          : ev.ongoing
            ? ` (since ${from})`
            : to && to !== from
              ? ` (${from}–${to})`
              : ` (${from})`;
      return `worked with ${toName}${org ? ` at ${org}` : ''}${years}`;
    }
    case 'same_school_cohort':
      return `went to ${typeof ev.school === 'string' ? ev.school : 'school'} with ${toName}`;
    case 'same_current_company':
      return `works with ${toName}${org ? ` at ${org}` : ''}`;
    default:
      return `knows ${toName}`;
  }
}

function routingGraph(
  input: WarmPathInput,
  pairs: ReadonlyMap<string, TiePair>,
  now: Date,
): { g: WeightedGraph; ask: Map<string, number> } {
  const g = makeGraph();
  const ask = new Map<string, number>();
  const floor = firstHopFloor(input.goal);
  for (const p of input.people.values()) {
    if (p.id === input.targetId || !usable(p, now) || p.score <= 0 || p.score < floor) continue;
    const a = pAsk(p);
    ask.set(p.id, a);
    addEdge(g, USER_NODE, p.id, a, 'strength', '', true);
  }
  for (const pair of pairs.values()) {
    if (!isRoutable(pair)) continue;
    const know = pKnow(pair);
    if (know <= 0) continue;
    const ends = [pair.aId, pair.bId];
    // anyone but the target must be someone the student may route through
    if (ends.some((id) => id !== input.targetId && !usable(input.people.get(id), now))) continue;
    // every A → B hop carries the 0.85 hop discount; one is given back for the route's first such hop
    const top = strongestTie(pair, now)?.kind ?? pair.kinds[0]!;
    addEdge(g, pair.aId, pair.bId, Math.min(0.999, know * HOP_PENALTY), top, '');
  }
  return { g, ask };
}

/**
 * Ranked routes to one person (§4.2): Yen's k = 12 over −ln p, mutual and Village candidates merged in as ties to
 * the target, the best route per first hop, at most two routes through one middle person, the top five, with a
 * band and a plain reason. A target the student already knows (score ≥ 40) is not routed.
 */
export function rankWarmPaths(input: WarmPathInput): WarmPathResult {
  const now = input.now ?? new Date();
  const target = input.people.get(input.targetId);
  const tName = input.target?.name ?? target?.name ?? 'them';
  if (target && target.score >= DIRECT_TIE_SCORE) {
    const band = TIE_BAND_LABELS[tieBand(target.score)];
    return {
      paths: [],
      direct: { score: target.score, band, text: `You know ${tName} (${band} · ${target.score})` },
    };
  }
  const pairs = withExternal(input.pairs, input.targetId, input.candidates ?? []);
  const { g, ask } = routingGraph(input, pairs, now);
  const rT = targetReceptivity(input.target ?? {});
  const k = input.k ?? 12;
  const maxHops = input.maxHops ?? 3;
  const found: Omit<WarmPath, 'otherWays' | 'reasonText'>[] = [];
  for (const nodes of kShortestPaths(g, USER_NODE, input.targetId, k, maxHops)) {
    if (nodes.length < 3) continue;
    const hops: WarmHop[] = [];
    let p = 1;
    let old = false;
    for (let i = 0; i < nodes.length - 1; i++) {
      const from = nodes[i]!;
      const to = nodes[i + 1]!;
      if (i === 0) {
        const a = ask.get(to)!;
        hops.push({ fromId: from, toId: to, p: a, kind: 'strength' });
        p *= a;
        const last = input.people.get(to)?.lastContactAt;
        if (last && now.getTime() - new Date(last).getTime() > OLD_EVIDENCE_YEARS * 365.25 * DAY) old = true;
        continue;
      }
      const pair = pairs.get(pk(from, to))!;
      const know = pKnow(pair);
      hops.push({ fromId: from, toId: to, p: know, kind: strongestTie(pair, now)?.kind ?? pair.kinds[0]! });
      p *= know;
      if (pairIsOld(pair, now)) old = true;
    }
    p *= rT * HOP_PENALTY ** (hops.length - 2);
    if (old) p *= OLD_EVIDENCE_FACTOR;
    p = Math.min(1, p);
    found.push({ nodes, hops, p, band: pathBand(p), firstHopId: nodes[1]! });
  }
  // a faint direct tie is one more way in: writing to them, at the chance they answer
  if (target && target.score > 0 && input.target?.pReply !== undefined) {
    const p = Math.max(0, Math.min(1, input.target.pReply));
    found.push({
      nodes: [USER_NODE, input.targetId],
      hops: [{ fromId: USER_NODE, toId: input.targetId, p, kind: 'strength' }],
      p,
      band: pathBand(p),
      firstHopId: input.targetId,
    });
  }
  found.sort(
    (a, b) =>
      b.p - a.p || a.nodes.length - b.nodes.length || a.nodes.join('>').localeCompare(b.nodes.join('>')),
  );
  const viable = found.filter((f) => f.p > MIN_PATH_P);
  if (!viable.length) return { paths: [], fallback: 'cold' };
  const firstHops = new Set(viable.map((f) => f.firstHopId));
  const otherWays = firstHops.size - 1;
  const chosen: typeof viable = [];
  const seenFirst = new Set<string>();
  const middle = new Map<string, number>();
  for (const f of viable) {
    if (chosen.length >= (input.limit ?? 5)) break;
    if (seenFirst.has(f.firstHopId)) continue;
    const mids = f.nodes.slice(2, -1);
    if (mids.some((m) => (middle.get(m) ?? 0) >= 2)) continue;
    seenFirst.add(f.firstHopId);
    for (const m of mids) middle.set(m, (middle.get(m) ?? 0) + 1);
    chosen.push(f);
  }
  return {
    paths: chosen.map((f) => ({
      ...f,
      otherWays,
      reasonText: reasonText(f, input, pairs, tName, otherWays, now),
    })),
  };
}

function reasonText(
  f: Omit<WarmPath, 'otherWays' | 'reasonText'>,
  input: WarmPathInput,
  pairs: ReadonlyMap<string, TiePair>,
  tName: string,
  otherWays: number,
  now: Date,
): string {
  const others = otherWays > 0 ? ` ${otherWays} other ${otherWays === 1 ? 'way' : 'ways'} in.` : '';
  if (f.nodes.length === 2) {
    const t = input.people.get(input.targetId);
    const band = t ? `${TIE_BAND_LABELS[tieBand(t.score)]} · ${t.score}` : '';
    return `Write to ${tName} directly${band ? ` (${band})` : ''}.${others}`;
  }
  const a = input.people.get(f.nodes[1]!)!;
  const nameOf = (id: string) => (id === input.targetId ? tName : (input.people.get(id)?.name ?? 'someone'));
  const phrases: string[] = [];
  for (let i = 1; i < f.nodes.length - 1; i++) {
    const from = f.nodes[i]!;
    const to = f.nodes[i + 1]!;
    const pair = pairs.get(pk(from, to));
    phrases.push(hopEvidence(from, pair ? strongestTie(pair, now) : undefined, nameOf(to)));
  }
  const head = `${a.name} (${TIE_BAND_LABELS[tieBand(a.score)]} · ${a.score}) ${phrases[0]}`;
  const rest = phrases
    .slice(1)
    .map((p) => `, who ${p}`)
    .join('');
  return `${head}${rest}.${others}`;
}

export interface CompanyTargetInput extends Omit<WarmPathInput, 'targetId' | 'target'> {
  /** people currently at the company, with what routing needs to know about each */
  targets: TargetInfo[];
}

/**
 * Ranked (target, route) pairs into a company (§4.2): with ten or fewer people there, every one is routed; with
 * more, personalized PageRank from the student over the routing graph (p_ask, p_know) picks the ten the student's
 * network reaches best. Returns the five best pairs, at most two per target.
 */
export function rankCompanyTargets(input: CompanyTargetInput): { target: TargetInfo; path: WarmPath }[] {
  const now = input.now ?? new Date();
  let targets = input.targets;
  if (targets.length > 10) {
    const pairs = withExternal(input.pairs, '', []);
    const { g } = routingGraph({ ...input, targetId: '' }, pairs, now);
    const adj = new Map<string, Map<string, number>>();
    for (const [u, nbrs] of g.adj) adj.set(u, new Map([...nbrs].map(([v, e]) => [v, e.weight])));
    const mass = personalizedPageRank(adj, USER_NODE);
    targets = [...targets]
      .sort((a, b) => (mass.get(b.id) ?? 0) - (mass.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, 10);
  }
  const out: { target: TargetInfo; path: WarmPath }[] = [];
  for (const t of targets) {
    const r = rankWarmPaths({ ...input, targetId: t.id, target: t, limit: 2 });
    for (const path of r.paths) out.push({ target: t, path });
  }
  out.sort((a, b) => b.path.p - a.path.p || a.target.id.localeCompare(b.target.id));
  const perTarget = new Map<string, number>();
  const chosen: typeof out = [];
  for (const x of out) {
    if (chosen.length >= (input.limit ?? 5)) break;
    const n = perTarget.get(x.target.id) ?? 0;
    if (n >= 2) continue;
    perTarget.set(x.target.id, n + 1);
    chosen.push(x);
  }
  return chosen;
}
