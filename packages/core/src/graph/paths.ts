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

interface DijkstraResult {
  cost: number;
  path: string[];
}

function dijkstra(
  g: WeightedGraph,
  source: string,
  target: string,
  maxHops: number,
  removedEdges: Set<string>,
  removedNodes: Set<string>,
): DijkstraResult | undefined {
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const hops = new Map<string, number>();
  const visited = new Set<string>();
  dist.set(source, 0);
  hops.set(source, 0);
  while (true) {
    let u: string | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const [n, d] of dist) {
      if (!visited.has(n) && d < best) {
        best = d;
        u = n;
      }
    }
    if (u === undefined) return undefined;
    if (u === target) break;
    visited.add(u);
    const h = hops.get(u)!;
    if (h >= maxHops) continue;
    for (const [v, e] of g.adj.get(u) ?? []) {
      if (removedNodes.has(v) || removedEdges.has(`${u}>${v}`) || visited.has(v)) continue;
      const nd = best + -Math.log(e.weight);
      if (nd < (dist.get(v) ?? Number.POSITIVE_INFINITY)) {
        dist.set(v, nd);
        prev.set(v, u);
        hops.set(v, h + 1);
      }
    }
  }
  const path = [target];
  let cur = target;
  while (cur !== source) {
    cur = prev.get(cur)!;
    path.unshift(cur);
  }
  return { cost: dist.get(target)!, path };
}

function pathCost(g: WeightedGraph, path: string[]): number {
  let c = 0;
  for (let i = 0; i < path.length - 1; i++) c += -Math.log(g.adj.get(path[i]!)!.get(path[i + 1]!)!.weight);
  return c;
}

/** Yen's k shortest loopless paths with a hop limit. */
export function kShortestPaths(
  g: WeightedGraph,
  source: string,
  target: string,
  k = 3,
  maxHops = 3,
): string[][] {
  if (!g.nodes.has(source) || !g.nodes.has(target)) return [];
  const first = dijkstra(g, source, target, maxHops, new Set(), new Set());
  if (!first) return [];
  const A: string[][] = [first.path];
  const B: { cost: number; path: string[] }[] = [];
  for (let kk = 1; kk < k; kk++) {
    const last = A[kk - 1]!;
    for (let i = 0; i < last.length - 1; i++) {
      const spur = last[i]!;
      const root = last.slice(0, i + 1);
      const removedEdges = new Set<string>();
      const removedNodes = new Set<string>();
      for (const p of A) {
        if (p.length > i && root.every((n, idx) => p[idx] === n)) removedEdges.add(`${p[i]}>${p[i + 1]}`);
      }
      for (const n of root) if (n !== spur) removedNodes.add(n);
      const spurPath = dijkstra(g, spur, target, maxHops - i, removedEdges, removedNodes);
      if (!spurPath) continue;
      const total = [...root.slice(0, -1), ...spurPath.path];
      if (
        A.some((p) => p.join('>') === total.join('>')) ||
        B.some((b) => b.path.join('>') === total.join('>'))
      )
        continue;
      B.push({ cost: pathCost(g, total), path: total });
    }
    if (!B.length) break;
    B.sort((a, b) => a.cost - b.cost);
    A.push(B.shift()!.path);
  }
  return A;
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
