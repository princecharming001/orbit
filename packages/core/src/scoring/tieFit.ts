import {
  linearTie,
  TIE_FEATURES,
  TIE_START_WEIGHTS,
  type TieFeature,
  type TieFeatures,
  type TieWeights,
} from './tieScore';

/**
 * Fitting TIE_WEIGHTS (plan 16 §3.3): least squares on logit targets with a ridge toward the plan's starting weights,
 * under bounds that keep the model sensible. Deterministic (projected gradient descent from the prior with a fixed
 * step and iteration count), so the frozen constants can be re-derived in a test, and reusable for the global refit
 * on users' labels (§15).
 *
 * Parameters: the bias; `time`, the shared magnitude of days-since-first (+) and days-since-last (−), tied as in
 * Gilbert & Karahalios (β −0.76 / +0.755); `recency`, extra weight on days-since-last only (≥ 0, so silence never
 * raises a score: A9); and each other feature not listed in `fixed`.
 */

export interface TieFitRow {
  features: TieFeatures;
  /** the target score, 0–100 (an anchor's midpoint or a label's band midpoint) */
  target: number;
  /** when given, leaving this score range costs `rangePenalty` times more than missing the target */
  range?: [number, number];
}

export type TieFitParam =
  | 'bias'
  | 'time'
  | 'recency'
  | Exclude<TieFeature, 'log_days_last' | 'log_days_first'>;

export interface TieFitOptions {
  prior?: TieWeights;
  ridge?: number;
  rangePenalty?: number;
  /** [min, max] per parameter; parameters without bounds are free */
  bounds?: Partial<Record<TieFitParam, [number, number]>>;
  /** features held at their prior value (the anchors carry no information about them) */
  fixed?: TieFeature[];
  iterations?: number;
  step?: number;
}

const logit = (p: number) => Math.log(p / (1 - p));
const clampP = (s: number) => Math.min(0.999, Math.max(0.001, s / 100));

export function fitTieWeights(rows: TieFitRow[], opts: TieFitOptions = {}): TieWeights {
  const prior = opts.prior ?? TIE_START_WEIGHTS;
  const ridge = opts.ridge ?? 0.1;
  const penalty = opts.rangePenalty ?? 0;
  const fixed = new Set(opts.fixed ?? []);
  const iterations = opts.iterations ?? 100_000;
  const step = opts.step ?? 0.0005;
  interface Param {
    name: TieFitParam;
    prior: number;
    col: (f: TieFeatures) => number;
  }
  const params: Param[] = [
    { name: 'bias', prior: prior.bias, col: () => 1 },
    { name: 'time', prior: prior.log_days_first, col: (f) => f.log_days_first - f.log_days_last },
    {
      name: 'recency',
      prior: Math.max(0, -prior.log_days_last - prior.log_days_first),
      col: (f) => -f.log_days_last,
    },
  ];
  for (const k of TIE_FEATURES) {
    if (k === 'log_days_last' || k === 'log_days_first' || fixed.has(k)) continue;
    params.push({ name: k, prior: prior[k], col: (f) => f[k] });
  }
  const fixedPart = (f: TieFeatures) => {
    let z = 0;
    for (const k of fixed) z += prior[k] * f[k];
    return z;
  };
  const X = rows.map((r) => params.map((p) => p.col(r.features)));
  const base = rows.map((r) => fixedPart(r.features));
  const y = rows.map((r) => logit(clampP(r.target)));
  const lims = rows.map((r) =>
    r.range ? [logit(clampP(r.range[0])), logit(clampP(r.range[1]))] : undefined,
  );
  const lo = params.map((p) => opts.bounds?.[p.name]?.[0] ?? Number.NEGATIVE_INFINITY);
  const hi = params.map((p) => opts.bounds?.[p.name]?.[1] ?? Number.POSITIVE_INFINITY);
  const th = params.map((p, i) => Math.min(hi[i]!, Math.max(lo[i]!, p.prior)));
  const g = new Array<number>(th.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < th.length; i++) g[i] = 2 * ridge * (th[i]! - params[i]!.prior);
    for (let r = 0; r < rows.length; r++) {
      const x = X[r]!;
      let z = base[r]!;
      for (let i = 0; i < th.length; i++) z += x[i]! * th[i]!;
      let e = 2 * (z - y[r]!);
      const lim = lims[r];
      if (lim && penalty) e += 2 * penalty * (z < lim[0]! ? z - lim[0]! : z > lim[1]! ? z - lim[1]! : 0);
      for (let i = 0; i < th.length; i++) g[i] = g[i]! + e * x[i]!;
    }
    for (let i = 0; i < th.length; i++) th[i] = Math.min(hi[i]!, Math.max(lo[i]!, th[i]! - step * g[i]!));
  }
  const w: TieWeights = { ...prior };
  params.forEach((p, i) => {
    const v = th[i]!;
    if (p.name === 'bias') w.bias = v;
    else if (p.name === 'time') w.log_days_first = v;
    else if (p.name === 'recency') return;
    else w[p.name] = v;
  });
  const recency = th[params.findIndex((p) => p.name === 'recency')]!;
  w.log_days_last = -(w.log_days_first + recency);
  return w;
}

/** Fitted score minus target, in score points, per row. */
export function fitResiduals(rows: TieFitRow[], weights: TieWeights): number[] {
  return rows.map((r) => 100 / (1 + Math.exp(-linearTie(r.features, weights))) - r.target);
}
