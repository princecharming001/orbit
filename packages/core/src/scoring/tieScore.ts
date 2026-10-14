import { isAtsSender } from '../text/email';
import { normalizeCompany } from '../text/normalize';
import type { Affiliation, CalendarEvent, EmailMessage, EmailThread, Person, Touchpoint } from '../types';

/**
 * Relationship strength 0–100 (plan 16 §3): a logistic model over fourteen features of the history between the
 * student and one person, with an explanation built from the raw counts and an optional per-user calibration.
 * Pure: the browser (local mode) and the server jobs (account mode) run the same code.
 */

export const TIE_MODEL_VERSION = 'tie-v1';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const YEAR_DAYS = 365;

export interface TieMessage {
  at: string;
  direction: 'in' | 'out';
  channel: 'email' | 'linkedin';
  /** everyone on the thread, the student included (a 1:1 thread has 2) */
  threadParticipants: number;
  threadId: string;
  /** machine mail, mailing lists (List-Unsubscribe, Precedence bulk|list) and ATS senders: never counted */
  automated: boolean;
  /** on an inbound message that answers the student: hours since the student's message it answers */
  isReplyLatencyHours?: number;
}

export interface TieMeeting {
  at: string;
  /** everyone invited and not declined, the student included (a 1:1 has 2) */
  attendees: number;
}

export interface TieShared {
  sameSchool: boolean;
  overlappingEmployer: boolean;
  sameCity: boolean;
  school?: string;
  employer?: string;
  /** "2021–2023", for the explanation */
  overlapYears?: string;
  city?: string;
}

export interface TieHistory {
  /** first name, for the explanation */
  name?: string;
  messages: TieMessage[];
  meetings: TieMeeting[];
  /** introductions between them and the student, either direction */
  intros: number;
  /** who introduced whom, for the explanation sentence */
  introRole?: 'they_introduced_you' | 'you_introduced_them' | 'introduced_to_you';
  shared: TieShared;
  linkedinConnected: boolean;
  connectedAt?: string;
  /** warmth of each note extraction about them, each in [-1, 1] */
  noteWarmth: number[];
  /** tie scores (0–100, previous run) of contacts they and the student share */
  mutualScores: number[];
  /** names of those contacts, in the same order as `mutualScores` */
  mutualNames?: string[];
  /** the student's own closeness rating (1–5) and when it was given */
  label?: { closeness: number; at: string };
}

export const TIE_FEATURES = [
  'log_days_last',
  'log_days_first',
  'log_out',
  'log_in',
  'reciprocity',
  'log_meetings',
  'log_threads',
  'latency',
  'intros',
  'shared',
  'structural',
  'linkedin',
  'warmth',
  'never',
] as const;
export type TieFeature = (typeof TIE_FEATURES)[number];
export type TieFeatures = Record<TieFeature, number>;
export type TieWeights = TieFeatures & { bias: number };

/**
 * Frozen weights, fitted with `fitTieWeights` (tieFit.ts) on the anchors of §3.7: least squares on the logit of each
 * anchor range's midpoint (A1–A5, A7, A8; A6 only tests the cap), a ridge of 0.1 toward the plan's starting weights,
 * and ten times the cost for leaving the range shrunk by one point. intros, structural and warmth vary in no anchor
 * and keep their starting values. Bounds keep the model sensible: days-since-first ≥ 0.2 with days-since-last at
 * least as negative (silence never raises a score, A9), sent ≥ 0.1, received ≥ 0.2, meetings ≥ 0.6, threads ≥ 0,
 * latency ≤ 1.6, reciprocity ≤ 2, LinkedIn ≤ 1.2, never ≤ −0.1. The anchors need a first reply to move a score a
 * lot (A2 → A3) while 26 weeks more mail moves it less (A3 → A4) and two dormant years hold a big history near 45
 * (A5): the fit puts the weight on "did they answer, and how fast" (reciprocity, latency) and little on log counts.
 * Reproduced in __tests__/tie-score.test.ts, which fails if these constants drift from the fit.
 *
 * Residuals (fitted − midpoint, score points, rounded weights): A1 −0.1, A2 +1.4, A3 −6.6, A4 +0.3, A5 +1.5,
 * A7 +0.1, A8 −0.4. Scores: A1 11, A2 8, A3 31, A4 90, A5 46, A6 17, A7 53, A8 20.
 */
export const TIE_WEIGHTS: TieWeights = {
  bias: -2.33,
  log_days_last: -0.28,
  log_days_first: 0.2,
  log_out: 0.1,
  log_in: 0.22,
  reciprocity: 1.02,
  log_meetings: 0.6,
  log_threads: 0,
  latency: 1.56,
  intros: 0.5,
  shared: 0.66,
  structural: 0.8,
  linkedin: 0.84,
  warmth: 0.5,
  never: -0.1,
};

/** The plan's starting weights (§3.3): the prior the fit shrinks toward. */
export const TIE_START_WEIGHTS: TieWeights = {
  bias: -2.4,
  log_days_last: -0.4,
  log_days_first: 0.4,
  log_out: 0.35,
  log_in: 0.75,
  reciprocity: 0.6,
  log_meetings: 1.0,
  log_threads: 0.5,
  latency: 0.4,
  intros: 0.5,
  shared: 0.45,
  structural: 0.8,
  linkedin: 0.55,
  warmth: 0.5,
  never: -0.3,
};

/**
 * Population mean of each feature, the reference point contributions are measured from (a feature at its mean
 * explains nothing). The mean over the 90 people of the demo network (a junior's mail, calendar and LinkedIn: most
 * contacts are connections with little or no mail) on 2026-10-14, rounded to two decimals.
 */
export const TIE_BASELINE: TieFeatures = {
  log_days_last: 5.27,
  log_days_first: 5.52,
  log_out: 0.31,
  log_in: 0.25,
  reciprocity: 0.18,
  log_meetings: 0.12,
  log_threads: 0.16,
  latency: 0.03,
  intros: 0,
  shared: 0.4,
  structural: 0,
  linkedin: 0.88,
  warmth: 0,
  never: 0.74,
};

/** Unreciprocated cap (Kossinets & Watts): someone who never wrote back, met or was introduced stays Faint/Light. */
export const UNRECIPROCATED_SCORE_CAP = 20;

export type TieBand = 'faint' | 'light' | 'warm' | 'strong' | 'close';
export const TIE_BAND_LABELS: Record<TieBand, string> = {
  faint: 'Faint',
  light: 'Light',
  warm: 'Warm',
  strong: 'Strong',
  close: 'Close',
};
/** The score each band stands for when the student labels someone (§3.5): the band's midpoint. */
export const TIE_LABEL_MIDPOINTS: Record<number, number> = { 1: 10, 2: 30, 3: 50, 4: 70, 5: 90 };

export function tieBand(score: number): TieBand {
  if (score >= 80) return 'close';
  if (score >= 60) return 'strong';
  if (score >= 40) return 'warm';
  if (score >= 20) return 'light';
  return 'faint';
}

/** The v1 map's three rings (§3.3): Close/Strong → strong, Warm → medium, else weak. */
export function tieBandTier(band: TieBand): 'strong' | 'medium' | 'weak' {
  if (band === 'close' || band === 'strong') return 'strong';
  if (band === 'warm') return 'medium';
  return 'weak';
}

export interface TieCalibration {
  a: number;
  c: number;
}

/** Raw counts behind the features: what the explanation sentences quote. */
export interface TieFacts {
  name?: string;
  /** days since the last two-way exchange, else the last contact of any kind; undefined when never in touch */
  daysLast?: number;
  lastWasTwoWay: boolean;
  daysFirst?: number;
  /** non-automated messages, all time */
  inCount: number;
  outCount: number;
  /** meetings of 8 or fewer in the last two years */
  meetings: number;
  twoWayThreads: number;
  medianLatencyHours?: number;
  intros: number;
  introRole?: TieHistory['introRole'];
  shared: TieShared;
  mutualNames: string[];
  linkedin: boolean;
  never: boolean;
  /** mean note warmth, 0 without notes */
  warmth: number;
}

export interface TieScore {
  score: number;
  band: TieBand;
  /** the linear predictor before the sigmoid (what calibration fits on) */
  z: number;
  features: TieFeatures;
  contributions: TieFeatures;
  explanation: string[];
  modelVersion: typeof TIE_MODEL_VERSION;
  /** the unreciprocated cap lowered the score */
  capped: boolean;
  /** the score is the student's own label (§3.5), not the model's */
  labelled: boolean;
  facts: TieFacts;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Meeting weight in f6: a 1:1 or a small group counts fully, a larger meeting a little, a big one not at all. */
export function meetingWeight(attendees: number): number {
  if (attendees <= 4) return 1;
  if (attendees <= 8) return 0.3;
  return 0;
}

/**
 * The fourteen features (§3.2) and the raw counts behind them. Events more than a day in the future are ignored;
 * anything a few hours ahead (clock skew, a meeting later today) counts as now.
 */
export function computeTieFeatures(
  h: TieHistory,
  now: Date = new Date(),
): { features: TieFeatures; facts: TieFacts } {
  const t = now.getTime();
  const when = (iso: string): number | undefined => {
    const x = ms(iso);
    if (x === undefined || x > t + DAY) return undefined;
    return Math.min(x, t);
  };
  // automated mail, mailing lists and big threads say nothing about the relationship
  const messages = h.messages
    .filter((m) => !m.automated && m.threadParticipants <= 8)
    .map((m) => ({ ...m, t: when(m.at) }))
    .filter((m): m is TieMessage & { t: number } => m.t !== undefined);
  const meetings = h.meetings
    .filter((m) => m.attendees <= 8)
    .map((m) => ({ ...m, t: when(m.at) }))
    .filter((m): m is TieMeeting & { t: number } => m.t !== undefined);
  const connectedAt = h.linkedinConnected && h.connectedAt ? when(h.connectedAt) : undefined;

  const directions = new Map<string, Set<'in' | 'out'>>();
  for (const m of messages) {
    const s = directions.get(m.threadId) ?? new Set();
    s.add(m.direction);
    directions.set(m.threadId, s);
  }
  const twoWay = (threadId: string) => (directions.get(threadId)?.size ?? 0) === 2;

  let lastTwoWay: number | undefined;
  let lastAny: number | undefined;
  let firstAny: number | undefined;
  const seen = (x: number) => {
    if (lastAny === undefined || x > lastAny) lastAny = x;
    if (firstAny === undefined || x < firstAny) firstAny = x;
  };
  for (const m of messages) {
    seen(m.t);
    if (twoWay(m.threadId) && (lastTwoWay === undefined || m.t > lastTwoWay)) lastTwoWay = m.t;
  }
  for (const m of meetings) {
    seen(m.t);
    if (lastTwoWay === undefined || m.t > lastTwoWay) lastTwoWay = m.t;
  }
  if (connectedAt !== undefined) seen(connectedAt);

  const never = messages.length === 0 && meetings.length === 0;
  const lastRef = lastTwoWay ?? lastAny;
  const daysLast = lastRef === undefined ? undefined : (t - lastRef) / DAY;
  const daysFirst = firstAny === undefined ? undefined : (t - firstAny) / DAY;

  // 365-day half-life
  const decay = (x: number) => 0.5 ** ((t - x) / DAY / YEAR_DAYS);
  let outD = 0;
  let inD = 0;
  let outCount = 0;
  let inCount = 0;
  for (const m of messages) {
    if (m.direction === 'out') {
      outD += decay(m.t);
      outCount++;
    } else {
      inD += decay(m.t);
      inCount++;
    }
  }
  // A meeting is a conversation: it counts as one exchange each way in f3–f5 (weighted like f6), so someone the
  // student met but never emailed is not scored as if nothing had passed between them.
  for (const m of meetings) {
    const w = meetingWeight(m.attendees) * decay(m.t);
    outD += w;
    inD += w;
  }
  // Reciprocity is the share of the student's messages that were answered, min(1, in/out), over the decayed counts.
  // §3.2 says min(in, out)/max(in, out) over undecayed two-year counts; both choices keep A9 exact: with min/max an
  // extra reply to someone who already writes more than the student would lower the score, and a message leaving a
  // two-year window could raise it, while decayed counts all shrink by the same factor in silence.
  const reciprocity = inD > 0 && outD > 0 ? Math.min(1, inD / outD) : 0;

  let meetingSum = 0;
  let meetingCount = 0;
  for (const m of meetings) {
    if (t - m.t > 2 * YEAR_DAYS * DAY) continue;
    meetingSum += meetingWeight(m.attendees);
    meetingCount++;
  }

  const smallTwoWay = new Set<string>();
  for (const m of messages) if (m.threadParticipants <= 3 && twoWay(m.threadId)) smallTwoWay.add(m.threadId);

  const latencies = messages
    .filter((m) => m.direction === 'in' && m.isReplyLatencyHours !== undefined && m.isReplyLatencyHours >= 0)
    .map((m) => m.isReplyLatencyHours!);
  const med = median(latencies);
  const latency = med === undefined ? 0 : 1 - Math.min(1, Math.log(1 + med) / Math.log(169));

  const sh = h.shared;
  const shared = Math.min(
    2,
    (sh.sameSchool ? 1 : 0) + (sh.overlappingEmployer ? 1 : 0) + (sh.sameCity ? 0.5 : 0),
  );
  const top = h.mutualScores
    .map((s, i) => ({ s: Math.max(0, Math.min(100, s)), name: h.mutualNames?.[i] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  const structural = top.length ? top.reduce((a, b) => a + b.s, 0) / top.length / 100 : 0;
  const warmthVals = h.noteWarmth.filter((w) => Number.isFinite(w)).map((w) => Math.max(-1, Math.min(1, w)));
  const warmth = warmthVals.length ? warmthVals.reduce((a, b) => a + b, 0) / warmthVals.length : 0;

  const features: TieFeatures = {
    log_days_last: daysLast === undefined ? 0 : Math.log(1 + daysLast),
    log_days_first: daysFirst === undefined ? 0 : Math.log(1 + daysFirst),
    log_out: Math.log(1 + outD),
    log_in: Math.log(1 + inD),
    reciprocity,
    log_meetings: Math.log(1 + meetingSum),
    log_threads: Math.log(1 + smallTwoWay.size),
    latency,
    intros: Math.min(2, Math.max(0, h.intros)),
    shared,
    structural,
    linkedin: h.linkedinConnected ? 1 : 0,
    warmth,
    never: never ? 1 : 0,
  };
  const facts: TieFacts = {
    name: h.name,
    daysLast,
    lastWasTwoWay: lastTwoWay !== undefined,
    daysFirst,
    inCount,
    outCount,
    meetings: meetingCount,
    twoWayThreads: smallTwoWay.size,
    medianLatencyHours: med,
    intros: features.intros,
    introRole: h.introRole,
    shared: sh,
    mutualNames: top.filter((x) => x.name && x.s > 0).map((x) => x.name!),
    linkedin: h.linkedinConnected,
    never,
    warmth,
  };
  return { features, facts };
}

export function linearTie(features: TieFeatures, weights: TieWeights = TIE_WEIGHTS): number {
  let z = weights.bias;
  for (const k of TIE_FEATURES) z += weights[k] * features[k];
  return z;
}

/** Score in [0, 100] from the linear predictor, through the student's calibration when there is one. */
export function scoreFromZ(z: number, calibration?: TieCalibration): number {
  const zz = calibration ? calibration.a * z + calibration.c : z;
  return Math.round(100 * sigmoid(zz));
}

/**
 * Score one person. `calibration` is the student's own Platt fit (§3.5); a person they labelled shows the label's
 * band midpoint until any new message or meeting arrives after the label.
 */
export function scoreTie(
  history: TieHistory,
  now: Date = new Date(),
  weights: TieWeights = TIE_WEIGHTS,
  calibration?: TieCalibration,
): TieScore {
  const { features, facts } = computeTieFeatures(history, now);
  const z = linearTie(features, weights);
  let score = scoreFromZ(z, calibration);
  let capped = false;
  // a meeting or an introduction is the other side engaging too: only a history of unanswered messages is capped
  if (
    facts.inCount === 0 &&
    facts.outCount > 0 &&
    facts.meetings === 0 &&
    !anyMeeting(history, now) &&
    !history.intros
  ) {
    if (score > UNRECIPROCATED_SCORE_CAP) {
      score = UNRECIPROCATED_SCORE_CAP;
      capped = true;
    }
  }
  let labelled = false;
  const label = history.label;
  if (label && TIE_LABEL_MIDPOINTS[label.closeness] !== undefined) {
    const at = ms(label.at) ?? 0;
    const newer =
      history.messages.some((m) => !m.automated && (ms(m.at) ?? 0) > at) ||
      history.meetings.some((m) => (ms(m.at) ?? 0) > at);
    if (!newer) {
      score = TIE_LABEL_MIDPOINTS[label.closeness]!;
      labelled = true;
    }
  }
  const { contributions, explanation } = explainTie(features, facts, weights);
  return {
    score,
    band: tieBand(score),
    z,
    features,
    contributions,
    explanation,
    modelVersion: TIE_MODEL_VERSION,
    capped,
    labelled,
    facts,
  };
}

function anyMeeting(h: TieHistory, now: Date): boolean {
  const t = now.getTime() + DAY;
  return h.meetings.some((m) => m.attendees <= 8 && (ms(m.at) ?? Number.POSITIVE_INFINITY) <= t);
}

// ---------------------------------------------------------------------------------------------------------------
// explanation

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(days: number): string {
  if (days < 1.5) return 'a day';
  if (days < 45) return `${Math.round(days)} days`;
  const months = Math.round(days / 30.4);
  if (months < 18) return plural(months, 'month');
  return plural(Math.round(days / 365), 'year');
}

interface Topic {
  value: number;
  positive?: string;
  negative?: string;
  /** shown only as the negative line, whatever the sign (the LinkedIn-but-never-talked case) */
  negativeOnly?: boolean;
}

/**
 * Contributions c_i = w_i · (f_i − TIE_BASELINE_i), then the three strongest positive reasons and the strongest
 * negative one as sentences built from the raw counts (§3.4). Features that say the same thing share a sentence
 * (sent, received, reciprocity and threads are all "the messages between you").
 */
export function explainTie(
  features: TieFeatures,
  facts: TieFacts,
  weights: TieWeights = TIE_WEIGHTS,
): { contributions: TieFeatures; explanation: string[] } {
  const c = {} as TieFeatures;
  for (const k of TIE_FEATURES) c[k] = weights[k] * (features[k] - TIE_BASELINE[k]);
  const name = facts.name || 'They';
  const topics: Topic[] = [];
  const total = facts.inCount + facts.outCount;

  if (facts.daysLast !== undefined && !facts.never)
    topics.push({
      value: c.log_days_last,
      negative: facts.lastWasTwoWay
        ? `Last real exchange was ${ago(facts.daysLast)} ago`
        : `No real back-and-forth yet; last contact ${ago(facts.daysLast)} ago`,
    });
  if (facts.daysFirst !== undefined && facts.daysFirst >= 60 && !facts.never)
    topics.push({ value: c.log_days_first, positive: `You've been in touch for ${ago(facts.daysFirst)}` });
  if (total > 0) {
    const oneWay = facts.outCount > 0 && facts.inCount * 2 < facts.outCount;
    topics.push({
      value: c.log_out + c.log_in + c.reciprocity + c.log_threads,
      positive:
        facts.inCount > 0
          ? `${plural(total, 'message')} between you (${facts.inCount} from them)`
          : undefined,
      negative: oneWay ? `Mostly one-way: ${facts.outCount} sent, ${facts.inCount} back` : undefined,
    });
  }
  if (facts.meetings > 0)
    topics.push({
      value: c.log_meetings,
      positive: `${plural(facts.meetings, 'meeting')} in the last 2 years`,
    });
  if (facts.intros > 0)
    topics.push({
      value: c.intros,
      positive:
        facts.introRole === 'you_introduced_them'
          ? 'You introduced them to someone'
          : facts.introRole === 'introduced_to_you'
            ? 'Someone you know introduced you'
            : `${name} introduced you to someone`,
    });
  const sh = facts.shared;
  if (sh.overlappingEmployer || sh.sameSchool || sh.sameCity)
    topics.push({
      value: c.shared,
      positive: sh.overlappingEmployer
        ? `You overlapped at ${sh.employer ?? 'the same company'}${sh.overlapYears ? ` (${sh.overlapYears})` : ''}`
        : sh.sameSchool
          ? `You both went to ${sh.school ?? 'the same school'}`
          : `You both live in ${sh.city ?? 'the same city'}`,
    });
  if (facts.mutualNames.length)
    topics.push({
      value: c.structural,
      positive: `Close with people you're close to (${facts.mutualNames.slice(0, 3).join(', ')})`,
    });
  if (facts.linkedin && facts.never)
    topics.push({
      value: Math.min(c.linkedin + c.never, -1e-6),
      negative: 'Connected on LinkedIn, never talked',
      negativeOnly: true,
    });
  else if (facts.linkedin) topics.push({ value: c.linkedin, positive: 'Connected on LinkedIn' });
  else if (facts.never) topics.push({ value: c.never, negative: "You haven't talked yet" });
  if (facts.medianLatencyHours !== undefined) {
    const h = facts.medianLatencyHours;
    topics.push({
      value: c.latency,
      positive: h <= 48 ? `Usually replies within ${Math.max(1, Math.round(h))} hours` : undefined,
      negative: h > 48 ? `Takes about ${Math.round(h / 24)} days to reply` : undefined,
    });
  }
  if (facts.warmth !== 0)
    topics.push({
      value: c.warmth,
      positive: facts.warmth > 0 ? 'Your notes about them are warm' : undefined,
      negative: facts.warmth < 0 ? 'Your notes about them sound cool' : undefined,
    });

  const positives = topics
    .filter((x) => !x.negativeOnly && x.positive && x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((x) => x.positive!);
  const negative = topics
    .filter((x) => x.negative && (x.value < 0 || x.negativeOnly))
    .sort((a, b) => a.value - b.value)[0]?.negative;
  const explanation = [...positives, ...(negative ? [negative] : [])];
  if (!explanation.length)
    explanation.push(facts.never ? "You haven't been in touch yet" : 'A light history so far');
  return { contributions: c, explanation };
}

// ---------------------------------------------------------------------------------------------------------------
// calibration (§3.5)

export interface TieLabel {
  /** the model's linear predictor for the person (TieScore.z) */
  z: number;
  /** the student's rating, 1 ("barely know") … 5 ("very close") */
  closeness: number;
}

export const CALIBRATION_MIN_LABELS = 8;
const CALIBRATION_STEPS = 200;
/**
 * §3.5 writes the ridge as 0.5·((a − 1)² + c²). With eight labels that ridge outweighs the labels: eight "very
 * close" ratings on people scoring 40 would only lift them to 69, and A10 asks for more than 75. 0.1 lifts them to
 * about 84 and still keeps a user with few or noisy labels near the global model.
 */
const CALIBRATION_RIDGE = 0.1;

/**
 * Per-user Platt parameters (a, c) minimizing Σ(σ(a·z + c) − (label − 1)/4)² + 0.1·((a − 1)² + c²), the ridge
 * pulling toward the global model (a = 1, c = 0). 200 steps of plain gradient descent from (1, 0); the step size
 * is 1 / (a bound on the loss's curvature), so the descent is stable and deterministic for any label set.
 * Undefined with fewer than 8 labels.
 */
export function fitCalibration(labels: TieLabel[]): TieCalibration | undefined {
  const pts = labels.filter((l) => Number.isFinite(l.z) && l.closeness >= 1 && l.closeness <= 5);
  if (pts.length < CALIBRATION_MIN_LABELS) return undefined;
  // d²/du² (σ(u) − y)² = 2(σ'² + (σ − y)σ'') ≤ 2(1/16 + 0.0963) < 0.32 with u = a·z + c, so a point adds at most
  // 0.32·(z² + 1) to the curvature; the ridge adds twice its coefficient
  const curvature = 2 * CALIBRATION_RIDGE + pts.reduce((s, p) => s + 0.32 * (p.z * p.z + 1), 0);
  const lr = 1 / curvature;
  let a = 1;
  let c = 0;
  for (let step = 0; step < CALIBRATION_STEPS; step++) {
    let ga = 2 * CALIBRATION_RIDGE * (a - 1);
    let gc = 2 * CALIBRATION_RIDGE * c;
    for (const p of pts) {
      const s = sigmoid(a * p.z + c);
      const y = (p.closeness - 1) / 4;
      const g = 2 * (s - y) * s * (1 - s);
      ga += g * p.z;
      gc += g;
    }
    a -= lr * ga;
    c -= lr * gc;
  }
  return { a, c };
}

// ---------------------------------------------------------------------------------------------------------------
// building a history from the browser's records

/** Gap that ends a conversation when thread ids are unknown: messages closer than this are one exchange. */
export const EPISODE_GAP_DAYS = 21;

export interface TieHistoryInput {
  person: Person;
  touchpoints: Touchpoint[];
  /** messages by id: their thread, sender and automated flag replace the touchpoint's guesses when known */
  messages?: Map<string, EmailMessage>;
  /** threads by id: participant counts, and introductions this person made */
  threads?: Map<string, EmailThread>;
  /** calendar events by id: attendee counts for meetings */
  events?: Map<string, CalendarEvent>;
  /** the student, for the shared school and city */
  user?: { school?: string; currentCity?: string };
  /** where the student has worked (resume), for the overlapping-employer flag */
  userEmployers?: { name: string; startDate?: string; endDate?: string }[];
  /** the person's affiliations */
  affiliations?: Affiliation[];
  noteWarmth?: number[];
  mutualScores?: number[];
  mutualNames?: string[];
  label?: TieHistory['label'];
}

const yearOf = (iso?: string) => (iso ? Number(iso.slice(0, 4)) || undefined : undefined);

/** The three shared-context flags of f10 from the student's and the person's records. */
export function sharedContext(
  input: Pick<TieHistoryInput, 'person' | 'user' | 'userEmployers' | 'affiliations'>,
): TieShared {
  const { person, user } = input;
  const school = user?.school ? normalizeCompany(user.school) : '';
  const schools = [
    person.school,
    ...(input.affiliations ?? []).filter((a) => a.kind === 'education').map((a) => a.nameRaw),
  ]
    .filter((s): s is string => !!s)
    .map((s) => ({ raw: s, norm: normalizeCompany(s) }));
  const schoolHit = school ? schools.find((s) => s.norm === school) : undefined;
  const sameSchool = !!person.isAlumni || !!schoolHit;
  let employer: string | undefined;
  let overlapYears: string | undefined;
  for (const u of input.userEmployers ?? []) {
    const norm = normalizeCompany(u.name);
    if (!norm) continue;
    for (const a of input.affiliations ?? []) {
      if (a.kind !== 'employment' || normalizeCompany(a.nameRaw) !== norm) continue;
      const us = ms(u.startDate) ?? Number.NEGATIVE_INFINITY;
      const ue = ms(u.endDate) ?? Number.POSITIVE_INFINITY;
      const as = ms(a.startDate) ?? Number.NEGATIVE_INFINITY;
      const ae = a.isCurrent ? Number.POSITIVE_INFINITY : (ms(a.endDate) ?? Number.POSITIVE_INFINITY);
      if (Math.max(us, as) > Math.min(ue, ae)) continue;
      employer = a.nameRaw;
      const from = Math.max(yearOf(u.startDate) ?? 0, yearOf(a.startDate) ?? 0) || undefined;
      const to = Math.min(yearOf(u.endDate) ?? 9999, a.isCurrent ? 9999 : (yearOf(a.endDate) ?? 9999));
      overlapYears = from
        ? to === 9999
          ? `since ${from}`
          : to === from
            ? `${from}`
            : `${from}–${to}`
        : undefined;
      break;
    }
    if (employer) break;
  }
  const city = (s?: string) => (s ?? '').toLowerCase().split(',')[0]!.trim();
  const sameCity =
    !!user?.currentCity && !!person.location && city(user.currentCity) === city(person.location);
  return {
    sameSchool,
    overlappingEmployer: !!employer,
    sameCity,
    school: schoolHit?.raw ?? (sameSchool ? (person.school ?? user?.school) : undefined),
    employer,
    overlapYears,
    city: sameCity ? person.location!.split(',')[0]!.trim() : undefined,
  };
}

/**
 * TieHistory from the records the browser keeps. Touchpoints are the backbone: email/LinkedIn in and out become
 * messages, meetings stay meetings, an observed introduction counts as one, the LinkedIn connection sets f12. A
 * logged exchange (manual_log) counts as their reply when it carries a reply's weight (≥ 0.5, "they replied"), and
 * as the student's own message otherwise ("I already sent it"). CC lines, notes and post likes are not messages.
 * Messages Orbit cannot place in a thread (no message record) are grouped into exchanges: one per channel, ending
 * after 21 days of quiet. An ATS or no-reply address on the person makes all their mail automated (§19.1).
 */
export function buildTieHistory(input: TieHistoryInput): TieHistory {
  const { person } = input;
  const atsPerson = [person.primaryEmail, ...person.emails].some((e) => !!e && isAtsSender(e));
  const raw: (Omit<TieMessage, 'threadId' | 'threadParticipants'> & {
    threadId?: string;
    threadParticipants?: number;
  })[] = [];
  const meetings: TieMeeting[] = [];
  let intros = 0;
  let introRole: TieHistory['introRole'];
  let connectedAt: string | undefined = person.linkedinConnectedOn
    ? person.linkedinConnectedOn.length === 10
      ? `${person.linkedinConnectedOn}T12:00:00.000Z`
      : person.linkedinConnectedOn
    : undefined;
  let linkedinConnected = !!person.linkedinConnectedOn;
  const seenMeeting = new Set<string>();
  for (const tp of input.touchpoints) {
    switch (tp.kind) {
      case 'email_in':
      case 'email_out':
      case 'linkedin_in':
      case 'linkedin_out': {
        const direction = tp.kind.endsWith('_in') ? 'in' : 'out';
        const channel = tp.kind.startsWith('email') ? 'email' : 'linkedin';
        const m = tp.refTable === 'messages' ? input.messages?.get(tp.refId) : undefined;
        const th = m ? input.threads?.get(m.threadId) : undefined;
        const automated =
          (m?.isAutomated ?? false) ||
          (m && m.direction === 'inbound' ? isAtsSender(m.fromEmail) : false) ||
          (channel === 'email' && atsPerson);
        raw.push({
          at: tp.occurredAt,
          direction,
          channel,
          automated,
          threadId: m?.threadId,
          threadParticipants: th ? Math.max(2, th.participantPersonIds.length + 1) : undefined,
        });
        break;
      }
      case 'manual_log':
        raw.push({
          at: tp.occurredAt,
          direction: tp.weight >= 0.5 ? 'in' : 'out',
          channel: 'email',
          automated: false,
        });
        break;
      case 'meeting': {
        const ev = tp.refTable === 'events' ? input.events?.get(tp.refId) : undefined;
        const attendees = ev
          ? Math.max(
              2,
              ev.attendees.filter((a) => a.responseStatus !== 'declined').length ||
                ev.attendeePersonIds.length + 1,
            )
          : 2;
        // a meeting recorded from both the calendar and the notes is one meeting
        const key = tp.occurredAt.slice(0, 13);
        if (seenMeeting.has(key)) break;
        seenMeeting.add(key);
        meetings.push({ at: tp.occurredAt, attendees });
        break;
      }
      case 'intro_observed':
        intros++;
        introRole = introRole ?? 'introduced_to_you';
        break;
      case 'linkedin_connected':
        linkedinConnected = true;
        if (!connectedAt || tp.occurredAt < connectedAt) connectedAt = tp.occurredAt;
        break;
      default:
        break;
    }
  }
  for (const th of input.threads?.values() ?? []) {
    if (th.introduction?.introducerId === person.id) {
      intros++;
      introRole = 'they_introduced_you';
    }
  }
  // group messages without a known thread into exchanges per channel
  const loose = raw.filter((m) => !m.threadId).sort((a, b) => a.at.localeCompare(b.at));
  const lastByChannel = new Map<string, { at: number; id: string }>();
  let episode = 0;
  for (const m of loose) {
    const at = ms(m.at) ?? 0;
    const prev = lastByChannel.get(m.channel);
    const id = prev && at - prev.at <= EPISODE_GAP_DAYS * DAY ? prev.id : `episode:${m.channel}:${episode++}`;
    lastByChannel.set(m.channel, { at, id });
    m.threadId = id;
    m.threadParticipants = 2;
  }
  // latency: an inbound message right after the student's own message in the same thread answers it
  const byThread = new Map<string, typeof raw>();
  for (const m of raw) {
    const arr = byThread.get(m.threadId!) ?? [];
    arr.push(m);
    byThread.set(m.threadId!, arr);
  }
  for (const arr of byThread.values()) {
    arr.sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 1; i < arr.length; i++) {
      const cur = arr[i]!;
      const prev = arr[i - 1]!;
      if (cur.direction !== 'in' || prev.direction !== 'out' || cur.automated) continue;
      const hrs = ((ms(cur.at) ?? 0) - (ms(prev.at) ?? 0)) / HOUR;
      if (hrs >= 0) cur.isReplyLatencyHours = hrs;
    }
  }
  const messages: TieMessage[] = raw.map((m) => ({
    at: m.at,
    direction: m.direction,
    channel: m.channel,
    automated: m.automated,
    threadId: m.threadId!,
    threadParticipants: m.threadParticipants ?? 2,
    ...(m.isReplyLatencyHours !== undefined ? { isReplyLatencyHours: m.isReplyLatencyHours } : {}),
  }));
  return {
    name: person.firstName || undefined,
    messages,
    meetings,
    intros,
    introRole,
    shared: sharedContext(input),
    linkedinConnected,
    connectedAt,
    noteWarmth: input.noteWarmth ?? [],
    mutualScores: input.mutualScores ?? [],
    mutualNames: input.mutualNames,
    label: input.label,
  };
}

/** Note warmth label → number for f13. */
export function warmthValue(w: 'warm' | 'neutral' | 'cool' | undefined): number {
  return w === 'warm' ? 1 : w === 'cool' ? -1 : 0;
}
