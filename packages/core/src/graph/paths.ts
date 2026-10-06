import type { ReachHop, ReachPath } from '../types';

export interface WeightedGraph {
  nodes: Set<string>;
  // adjacency: from -> to -> {weight, type, text}
  adj: Map<string, Map<string, { weight: number; type: ReachHop['type']; text: string }>>;
}

export function makeGraph(): WeightedGraph {
  return { nodes: new Set(), adj: new Map() };
}

export function addEdge(
  g: WeightedGraph,
  a: string,
  b: string,
  weight: number,
  type: ReachHop['type'],
  text: string,
  directed = false,
): void {
  if (weight <= 0) return;
  g.nodes.add(a);
  g.nodes.add(b);
  const set = (x: string, y: string) => {
    const m = g.adj.get(x) ?? new Map();
    const cur = m.get(y);
    if (!cur || cur.weight < weight) m.set(y, { weight, type, text });
    g.adj.set(x, m);
  };
  set(a, b);
  if (!directed) set(b, a);
}

/** Edge cost for "most likely chain" search. Clamped so every hop costs something and shortest walks stay simple. */
function edgeCost(weight: number): number {
  return -Math.log(Math.min(weight, 0.999_999));
}

/** Binary min-heap keyed by a number. */
class MinHeap<T> {
  private keys: number[] = [];
  private vals: T[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: T): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[parent]! <= key) break;
      k[i] = k[parent]!;
      v[i] = v[parent]!;
      i = parent;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, T] | undefined {
    const k = this.keys;
    const v = this.vals;
    if (!k.length) return undefined;
    const topK = k[0]!;
    const topV = v[0]!;
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r]! < k[l]! ? r : l;
        if (k[c]! >= lastK) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

interface SearchState {
  node: string;
  hops: number;
}

interface BoundedSearch {
  /** cheapest cost (any hop count within the limit) per settled node */
  best: Map<string, { cost: number; hops: number }>;
  /** predecessor of (node, hops) */
  prev: Map<string, (string | undefined)[]>;
}

/**
 * Hop-bounded Dijkstra over (node, hops) states with a binary heap: O(H (V + E) log(H V)) for hop limit H.
 * A node reached cheaply over many hops is still explored again over fewer hops, so a valid short route is
 * never discarded because a longer, cheaper one got there first. A state is skipped only when the same node
 * was already settled at a lower cost with no more hops (it cannot lead anywhere the earlier one could not).
 */
function boundedSearch(
  g: WeightedGraph,
  source: string,
  maxHops: number,
  target?: string,
  removedEdges?: Set<string>,
  removedNodes?: Set<string>,
): BoundedSearch {
  const dist = new Map<string, number[]>();
  const prev = new Map<string, (string | undefined)[]>();
  const minSettledHops = new Map<string, number>();
  const best = new Map<string, { cost: number; hops: number }>();
  const heap = new MinHeap<SearchState>();
  const setDist = (node: string, hops: number, d: number, from: string | undefined) => {
    let arr = dist.get(node);
    if (!arr) {
      arr = new Array<number>(maxHops + 1).fill(Number.POSITIVE_INFINITY);
      dist.set(node, arr);
      prev.set(node, new Array<string | undefined>(maxHops + 1));
    }
    arr[hops] = d;
    prev.get(node)![hops] = from;
  };
  setDist(source, 0, 0, undefined);
  heap.push(0, { node: source, hops: 0 });
  while (heap.size) {
    const [d, { node, hops }] = heap.pop()!;
    if (d > dist.get(node)![hops]!) continue; // stale entry
    const settled = minSettledHops.get(node);
    if (settled !== undefined && settled <= hops) continue; // dominated: cheaper with no more hops
    minSettledHops.set(node, hops);
    if (!best.has(node)) best.set(node, { cost: d, hops });
    if (node === target) break;
    if (hops >= maxHops) continue;
    for (const [v, e] of g.adj.get(node) ?? []) {
      if (v === source || removedNodes?.has(v) || removedEdges?.has(`${node}>${v}`)) continue;
      const s = minSettledHops.get(v);
      if (s !== undefined && s <= hops + 1) continue;
      const nd = d + edgeCost(e.weight);
      const cur = dist.get(v)?.[hops + 1] ?? Number.POSITIVE_INFINITY;
      if (nd < cur) {
        setDist(v, hops + 1, nd, node);
        heap.push(nd, { node: v, hops: hops + 1 });
      }
    }
  }
  return { best, prev };
}

function reconstruct(search: BoundedSearch, node: string): string[] | undefined {
  const b = search.best.get(node);
  if (!b) return undefined;
  const path = [node];
  let cur = node;
  for (let h = b.hops; h > 0; h--) {
    cur = search.prev.get(cur)![h]!;
    path.unshift(cur);
  }
  return path;
}

function shortestPath(
  g: WeightedGraph,
  source: string,
  target: string,
  maxHops: number,
  removedEdges: Set<string>,
  removedNodes: Set<string>,
): string[] | undefined {
  if (source === target) return [source];
  const search = boundedSearch(g, source, maxHops, target, removedEdges, removedNodes);
  return reconstruct(search, target);
}

function pathCost(g: WeightedGraph, path: string[]): number {
  let c = 0;
  for (let i = 0; i < path.length - 1; i++) c += edgeCost(g.adj.get(path[i]!)!.get(path[i + 1]!)!.weight);
  return c;
}

/** Yen's k shortest loopless paths with a hop limit, on top of the hop-bounded heap search. */
export function kShortestPaths(
  g: WeightedGraph,
  source: string,
  target: string,
  k = 3,
  maxHops = 3,
): string[][] {
  if (!g.nodes.has(source) || !g.nodes.has(target)) return source === target ? [[source]] : [];
  const first = shortestPath(g, source, target, maxHops, new Set(), new Set());
  if (!first) return [];
  const A: string[][] = [first];
  if (first.length === 1) return A;
  const B: { cost: number; path: string[]; key: string }[] = [];
  const seen = new Set<string>([first.join('>')]);
  for (let kk = 1; kk < k; kk++) {
    const last = A[kk - 1]!;
    for (let i = 0; i < last.length - 1; i++) {
      const spur = last[i]!;
      const root = last.slice(0, i + 1);
      const removedEdges = new Set<string>();
      const removedNodes = new Set<string>();
      for (const p of A) {
        if (p.length > i + 1 && root.every((n, idx) => p[idx] === n)) removedEdges.add(`${p[i]}>${p[i + 1]}`);
      }
      for (const n of root) if (n !== spur) removedNodes.add(n);
      const spurPath = shortestPath(g, spur, target, maxHops - i, removedEdges, removedNodes);
      if (!spurPath) continue;
      const total = [...root.slice(0, -1), ...spurPath];
      const key = total.join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      B.push({ cost: pathCost(g, total), path: total, key });
    }
    if (!B.length) break;
    B.sort((a, b) => a.cost - b.cost);
    A.push(B.shift()!.path);
  }
  return A;
}

export interface PathTable {
  /** best path score (product of hop weights) from the source, 0 when unreachable within the hop limit */
  score(id: string): number;
  /** the best path itself, source first */
  path(id: string): string[] | undefined;
}

/**
 * Best path from one source to every node within a hop limit, in one hop-bounded search.
 * Use this when scoring many targets (recommendations, company reach) instead of one search per target.
 */
export function bestPathsFrom(g: WeightedGraph, source: string, maxHops = 3): PathTable {
  if (!g.nodes.has(source)) return { score: () => 0, path: () => undefined };
  const search = boundedSearch(g, source, maxHops);
  const paths = new Map<string, string[] | undefined>();
  const path = (id: string): string[] | undefined => {
    if (!paths.has(id)) paths.set(id, reconstruct(search, id));
    return paths.get(id);
  };
  const score = (id: string): number => {
    if (id === source) return 1;
    const p = path(id);
    if (!p) return 0;
    let s = 1;
    for (let i = 0; i < p.length - 1; i++) s *= g.adj.get(p[i]!)!.get(p[i + 1]!)!.weight;
    return s;
  };
  return { score, path };
}

export function toReachPath(g: WeightedGraph, path: string[]): ReachPath {
  const hops: ReachHop[] = [];
  let score = 1;
  for (let i = 0; i < path.length - 1; i++) {
    const e = g.adj.get(path[i]!)!.get(path[i + 1]!)!;
    hops.push({ fromId: path[i]!, toId: path[i + 1]!, weight: e.weight, type: e.type, text: e.text });
    score *= e.weight;
  }
  return { hops, score, band: score >= 0.4 ? 'strong' : score >= 0.15 ? 'possible' : 'long_shot' };
}
