/**
 * Personalized PageRank from one node (plan 16 §4.2): where a random walk that restarts at the student with
 * probability α spends its time, following edges in proportion to their weight. Used to choose whom to aim at in a
 * company when the student names no one. O(iterations × edges).
 */

export interface PprOptions {
  /** restart probability */
  alpha?: number;
  iterations?: number;
}

export const PPR_ALPHA = 0.15;
export const PPR_ITERATIONS = 30;

/**
 * `adj` maps a node to its out-neighbours and their (positive) weights; the walk from a node picks a neighbour with
 * probability proportional to the weight. Mass that reaches a node without out-edges restarts at the source, so the
 * result always sums to 1.
 */
export function personalizedPageRank(
  adj: ReadonlyMap<string, ReadonlyMap<string, number>>,
  source: string,
  opts: PprOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? PPR_ALPHA;
  const iterations = opts.iterations ?? PPR_ITERATIONS;
  const out = new Map<string, { to: string; p: number }[]>();
  const nodes = new Set<string>([source]);
  for (const [u, nbrs] of adj) {
    nodes.add(u);
    let total = 0;
    for (const [v, w] of nbrs) {
      if (w > 0 && Number.isFinite(w)) total += w;
      nodes.add(v);
    }
    if (total <= 0) continue;
    const list: { to: string; p: number }[] = [];
    for (const [v, w] of nbrs) if (w > 0 && Number.isFinite(w)) list.push({ to: v, p: w / total });
    out.set(u, list);
  }
  let rank = new Map<string, number>([[source, 1]]);
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    let restart = alpha;
    for (const [u, r] of rank) {
      if (r === 0) continue;
      const list = out.get(u);
      if (!list) {
        restart += (1 - alpha) * r;
        continue;
      }
      for (const { to, p } of list) next.set(to, (next.get(to) ?? 0) + (1 - alpha) * r * p);
    }
    next.set(source, (next.get(source) ?? 0) + restart);
    rank = next;
  }
  for (const n of nodes) if (!rank.has(n)) rank.set(n, 0);
  return rank;
}
