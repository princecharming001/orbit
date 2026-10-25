/**
 * Learning from how intros turn out (plan 21 §8). Every intro the student asks for keeps the route as it was weighed
 * then (each hop's p, kind and band); once an outcome is known — they agreed, an intro happened, or nothing came —
 * the pair is a labelled example. With enough examples (200, across students in account mode), a logistic regression
 * over the route's features says whether the hand-set weights of HOP_WEIGHTS rank routes the way outcomes do. Until
 * then nothing here changes a score: `fitHopModel` refuses, and the constants stand.
 */

/** A route as it was when the student asked for the intro. */
export interface PathSnapshot {
  score: number;
  hops: { fromId: string; toId: string; p: number; kind: string; band?: string }[];
}

export type IntroOutcome = 'agreed' | 'intro_made' | 'meeting' | 'declined' | 'no_response';

/** An outcome that counts as the route working. */
export const isSuccess = (o: IntroOutcome) => o === 'agreed' || o === 'intro_made' || o === 'meeting';

export const HOP_FEATURES = [
  'p_ask',
  'weakest_later_hop',
  'mean_later_hop',
  'hops',
  'has_engagement',
  'has_recommendation',
  'has_mutual_only',
  'has_student_word',
] as const;

/** The features a fit reads from a snapshot, in HOP_FEATURES order. */
export function hopFeatures(s: PathSnapshot): number[] {
  const first = s.hops[0]?.p ?? 0;
  const later = s.hops.slice(1);
  const ps = later.map((h) => h.p);
  const kinds = new Set(later.map((h) => h.kind));
  return [
    first,
    ps.length ? Math.min(...ps) : first,
    ps.length ? ps.reduce((a, p) => a + p, 0) / ps.length : first,
    s.hops.length,
    kinds.has('linkedin_engagement') ? 1 : 0,
    kinds.has('linkedin_recommendation') ? 1 : 0,
    later.length > 0 && later.every((h) => h.kind === 'linkedin_mutual') ? 1 : 0,
    kinds.has('student_says_close') ? 1 : 0,
  ];
}

export const MIN_OUTCOMES = 200;

export interface HopModel {
  weights: number[];
  bias: number;
  n: number;
  /** training log-loss, for comparing with the hand-set model */
  logLoss: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * A logistic regression (L2, gradient descent on standardised features) over labelled routes; undefined with fewer
 * than MIN_OUTCOMES examples or only one kind of outcome. Pure and deterministic.
 */
export function fitHopModel(
  examples: { snapshot: PathSnapshot; outcome: IntroOutcome }[],
  opts: { iterations?: number; rate?: number; l2?: number; minOutcomes?: number } = {},
): HopModel | undefined {
  const n = examples.length;
  if (n < (opts.minOutcomes ?? MIN_OUTCOMES)) return undefined;
  const X = examples.map((e) => hopFeatures(e.snapshot));
  const y = examples.map((e) => (isSuccess(e.outcome) ? 1 : 0));
  if (y.every((v) => v === y[0])) return undefined;
  const d = X[0]!.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((a, x) => a + x[j]!, 0) / n);
  const sd = Array.from(
    { length: d },
    (_, j) => Math.sqrt(X.reduce((a, x) => a + (x[j]! - mean[j]!) ** 2, 0) / n) || 1,
  );
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]!) / sd[j]!));
  const w = new Array<number>(d).fill(0);
  let b = 0;
  const rate = opts.rate ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  for (let it = 0; it < (opts.iterations ?? 2000); it++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const err = sigmoid(b + Z[i]!.reduce((a, z, j) => a + z * w[j]!, 0)) - y[i]!;
      for (let j = 0; j < d; j++) gw[j]! += err * Z[i]![j]!;
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] = w[j]! - rate * (gw[j]! / n + l2 * w[j]!);
    b -= rate * (gb / n);
  }
  // back to the raw feature scale
  const weights = w.map((wj, j) => wj / sd[j]!);
  const bias = b - w.reduce((a, wj, j) => a + (wj * mean[j]!) / sd[j]!, 0);
  let loss = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(
      1 - 1e-9,
      Math.max(1e-9, sigmoid(bias + X[i]!.reduce((a, x, j) => a + x * weights[j]!, 0))),
    );
    loss -= y[i]! * Math.log(p) + (1 - y[i]!) * Math.log(1 - p);
  }
  return { weights, bias, n, logLoss: loss / n };
}

/** The fitted chance a route works out. */
export function predictIntro(model: HopModel, s: PathSnapshot): number {
  const x = hopFeatures(s);
  return sigmoid(model.bias + x.reduce((a, v, j) => a + v * (model.weights[j] ?? 0), 0));
}
