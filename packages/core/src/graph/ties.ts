import { normalizeCompany, normalizeEmail } from '../text/normalize';
import type { Edge, EdgeType, EmailMessage } from '../types';
import { type EdgeInput, inferEdges } from './edges';
import { knownSizeBucket } from './orgSize';

/**
 * Ties between two of the student's contacts (plan 16 §4.1): each kind of evidence carries a weight (how well it
 * suggests they know each other) and a confidence (how sure Orbit is the evidence is real and about them). The
 * student's own ties are tie scores, not rows here. Pure, so the browser and the server jobs share it.
 */

export type TieKind = EdgeType;

export const TIE_KINDS: readonly TieKind[] = [
  'email_exchange',
  'email_cc',
  'email_cothread',
  'meeting_coattendee',
  'introduced_by',
  'linkedin_mutual',
  'village_path',
  'co_tenure',
  'same_school_cohort',
  'same_current_company',
];

/** Kinds that record an interaction: their weight halves every two years without new evidence. */
export const INTERACTION_TIE_KINDS: ReadonlySet<TieKind> = new Set([
  'email_exchange',
  'email_cc',
  'email_cothread',
  'meeting_coattendee',
  'introduced_by',
]);

/** Kinds strong enough to route through whatever the combined confidence (§4.1). */
export const ROUTABLE_TIE_KINDS: ReadonlySet<TieKind> = new Set([
  'email_exchange',
  'email_cc',
  'meeting_coattendee',
  'introduced_by',
  'linkedin_mutual',
]);

/** Confidence of kinds whose confidence does not depend on the evidence (§4.1). */
export const TIE_CONFIDENCE: Record<TieKind, number> = {
  email_exchange: 0.95,
  email_cc: 0.85,
  email_cothread: 0.5,
  meeting_coattendee: 0.8,
  introduced_by: 0.95,
  linkedin_mutual: 0.95,
  village_path: 0.7,
  // the affiliation kinds depend on the overlap and the employer's size; these are their typical values, used for
  // edges stored before confidences existed
  co_tenure: 0.5,
  same_school_cohort: 0.25,
  same_current_company: 0.35,
};

export interface Tie {
  /** `${aId}|${bId}|${kind}` */
  id: string;
  userId: string;
  /** aId < bId */
  aId: string;
  bId: string;
  kind: TieKind;
  /** w, before decay */
  weight: number;
  /** c */
  confidence: number;
  evidence: Record<string, unknown> & { text?: string };
  firstSeenAt?: string;
  /** the newest evidence (decay runs from here) */
  lastSeenAt?: string;
}

export interface TieInput extends EdgeInput {
  /** messages of the threads, for who wrote to whom (email_exchange, email_cc); without them threads give co-threads */
  messages?: EmailMessage[];
  /** LinkedIn mutual connections: `bId` appeared in Unipile's connections_of search for `aId` */
  mutuals?: { aId: string; bId: string; seenAt?: string }[];
  /** Village introducers: `introducerId` can introduce the student to `targetId` with this warmth (0–1) */
  villagePaths?: { introducerId: string; targetId: string; warmth: number; seenAt?: string }[];
}

const YEAR = 365.25 * 86_400_000;
const GROUP_MAX = 8;
const BIG_ORG = new Set(['5001-10000', '10001+']);

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function minIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Infer every tie kind the records support. Affiliation kinds come from `inferEdges` (unchanged) with a confidence
 * per §4.1; the thread kinds are split by who wrote (both wrote: exchange; one wrote to the other: cc; both only
 * received: co-thread); meetings drop declined attendees; mutuals and Village paths come from the caller.
 */
export function inferTies(input: TieInput): Tie[] {
  const now = input.now ?? new Date();
  const people = input.people.filter((p) => p.isHuman && !p.hiddenAt);
  const ids = new Set(people.map((p) => p.id));
  const byEmail = new Map<string, string>();
  for (const p of people)
    for (const e of [p.primaryEmail, ...p.emails]) if (e) byEmail.set(normalizeEmail(e), p.id);
  const ties = new Map<string, Tie>();
  const put = (
    a: string,
    b: string,
    kind: TieKind,
    weight: number,
    confidence: number,
    evidence: Tie['evidence'],
    firstSeenAt?: string,
    lastSeenAt?: string,
  ) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const [x, y] = pairKey(a, b);
    const id = `${x}|${y}|${kind}`;
    const cur = ties.get(id);
    if (cur && cur.weight * cur.confidence >= weight * confidence) return;
    ties.set(id, {
      id,
      userId: input.userId,
      aId: x,
      bId: y,
      kind,
      weight: Math.min(1, Math.max(0, weight)),
      confidence: Math.min(1, Math.max(0, confidence)),
      evidence,
      firstSeenAt,
      lastSeenAt,
    });
  };

  // affiliations (and nothing else) from the v1 inference
  const orgByName = new Map<string, string | undefined>();
  for (const o of input.organizations.values())
    orgByName.set(o.nameNormalized || normalizeCompany(o.name), o.sizeBucket);
  const big = (orgName: unknown) => {
    const name = typeof orgName === 'string' ? orgName : '';
    const bucket = orgByName.get(normalizeCompany(name)) ?? knownSizeBucket(name);
    return !!bucket && BIG_ORG.has(bucket);
  };
  for (const e of inferEdges({ ...input, threads: [], events: [] })) {
    const ev = e.evidence as Record<string, unknown>;
    if (e.type === 'co_tenure') {
      const months = typeof ev.overlapMonths === 'number' ? ev.overlapMonths : 0;
      let c = Math.min(0.8, 0.3 + 0.05 * months);
      if (big(ev.orgName)) c *= 0.5;
      if (typeof ev.toYear === 'number' && ev.toYear < now.getUTCFullYear() - 10) c *= 0.6;
      put(e.personAId, e.personBId, 'co_tenure', e.weight, c, ev);
    } else if (e.type === 'same_school_cohort') {
      const c = typeof ev.year === 'number' ? 0.4 : ev.withinTwoYears ? 0.25 : 0.1;
      put(e.personAId, e.personBId, 'same_school_cohort', e.weight, c, ev);
    } else if (e.type === 'same_current_company') {
      put(e.personAId, e.personBId, 'same_current_company', e.weight, big(ev.orgName) ? 0.175 : 0.35, ev);
    }
  }

  // threads
  const msgsByThread = new Map<string, EmailMessage[]>();
  for (const m of input.messages ?? []) {
    if (m.isAutomated) continue;
    const arr = msgsByThread.get(m.threadId) ?? [];
    arr.push(m);
    msgsByThread.set(m.threadId, arr);
  }
  type Count = { n: number; first?: string; last?: string; threads?: Set<string> };
  const bump = (map: Map<string, Count>, a: string, b: string, at: string | undefined, thread?: string) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const [x, y] = pairKey(a, b);
    const k = `${x}|${y}`;
    const c = map.get(k) ?? { n: 0, threads: new Set() };
    if (thread) {
      if (c.threads!.has(thread)) {
        c.last = maxIso(c.last, at);
        return;
      }
      c.threads!.add(thread);
    }
    c.n++;
    c.first = minIso(c.first, at);
    c.last = maxIso(c.last, at);
    map.set(k, c);
  };
  const exchange = new Map<string, Count>();
  const cc = new Map<string, Count>();
  const cothread = new Map<string, Count>();
  for (const t of input.threads) {
    const parts = [...new Set(t.participantPersonIds.filter((id) => ids.has(id)))];
    if (parts.length > GROUP_MAX) continue;
    const msgs = msgsByThread.get(t.id);
    if (!msgs?.length) {
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++)
          bump(cothread, parts[i]!, parts[j]!, t.lastMessageAt, t.id);
      continue;
    }
    const senders = new Set<string>();
    for (const m of msgs) {
      if (m.direction !== 'inbound') continue;
      const from = m.fromPersonId ?? byEmail.get(normalizeEmail(m.fromEmail));
      if (!from || !ids.has(from)) continue;
      senders.add(from);
      const recipients = [...m.toEmails, ...m.ccEmails];
      if (recipients.length > GROUP_MAX) continue;
      for (const r of recipients) {
        const to = byEmail.get(normalizeEmail(r));
        if (to) bump(cc, from, to, m.sentAt);
      }
    }
    const lastAt = msgs.reduce<string | undefined>((a, m) => maxIso(a, m.sentAt), t.lastMessageAt);
    const s = [...senders];
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) bump(exchange, s[i]!, s[j]!, lastAt, t.id);
    const receivers = parts.filter((p) => !senders.has(p));
    for (let i = 0; i < receivers.length; i++)
      for (let j = i + 1; j < receivers.length; j++)
        bump(cothread, receivers[i]!, receivers[j]!, lastAt, t.id);
  }
  for (const [k, c] of exchange) {
    const [x, y] = k.split('|') as [string, string];
    put(
      x,
      y,
      'email_exchange',
      Math.min(0.9, 0.6 + 0.1 * (c.n - 1)),
      TIE_CONFIDENCE.email_exchange,
      {
        threads: c.n,
        lastAt: c.last,
        text:
          c.n === 1
            ? 'Both wrote on an email thread with you'
            : `Both wrote on ${c.n} email threads with you`,
      },
      c.first,
      c.last,
    );
  }
  for (const [k, c] of cc) {
    const [x, y] = k.split('|') as [string, string];
    put(
      x,
      y,
      'email_cc',
      Math.min(0.7, 0.45 + 0.05 * (c.n - 1)),
      TIE_CONFIDENCE.email_cc,
      {
        messages: c.n,
        lastAt: c.last,
        text: c.n === 1 ? 'Copied on an email to you' : `Copied on ${c.n} emails to you`,
      },
      c.first,
      c.last,
    );
  }
  for (const [k, c] of cothread) {
    const [x, y] = k.split('|') as [string, string];
    put(
      x,
      y,
      'email_cothread',
      Math.min(0.5, 0.3 + 0.1 * (c.n - 1)),
      TIE_CONFIDENCE.email_cothread,
      {
        threads: c.n,
        lastAt: c.last,
        text: c.n === 1 ? 'On the same email thread with you' : `On ${c.n} email threads with you`,
      },
      c.first,
      c.last,
    );
  }

  // introductions: the introducer vouched for the student to the person
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const t of input.threads) {
    const intro = t.introduction;
    if (!intro) continue;
    const from = byId.get(intro.introducerId);
    if (!from) continue;
    for (const id of intro.introducedIds) {
      const to = byId.get(id);
      if (!to) continue;
      put(
        from.id,
        to.id,
        'introduced_by',
        0.85,
        TIE_CONFIDENCE.introduced_by,
        {
          introducerId: from.id,
          at: intro.at,
          lastAt: intro.at,
          text: `${from.firstName} introduced you to ${to.firstName}`,
        },
        intro.at,
        intro.at,
      );
    }
  }

  // meetings: small events, cancelled ones and attendees who declined left out
  const meetings = new Map<string, Count>();
  for (const e of input.events) {
    if (e.status === 'cancelled') continue;
    const size = e.attendees.length || e.attendeePersonIds.length;
    if (size > GROUP_MAX) continue;
    const declined = new Set(
      e.attendees
        .filter((a) => a.responseStatus === 'declined')
        .map((a) => byEmail.get(normalizeEmail(a.email)))
        .filter((x): x is string => !!x),
    );
    const att = [...new Set(e.attendeePersonIds.filter((id) => ids.has(id) && !declined.has(id)))];
    for (let i = 0; i < att.length; i++)
      for (let j = i + 1; j < att.length; j++) bump(meetings, att[i]!, att[j]!, e.startAt, e.id);
  }
  for (const [k, c] of meetings) {
    const [x, y] = k.split('|') as [string, string];
    put(
      x,
      y,
      'meeting_coattendee',
      Math.min(0.9, 0.6 + 0.1 * (c.n - 1)),
      TIE_CONFIDENCE.meeting_coattendee,
      {
        events: c.n,
        lastAt: c.last,
        text: c.n === 1 ? 'In a meeting with you together' : `In ${c.n} meetings with you together`,
      },
      c.first,
      c.last,
    );
  }

  for (const m of input.mutuals ?? [])
    put(
      m.aId,
      m.bId,
      'linkedin_mutual',
      0.3,
      TIE_CONFIDENCE.linkedin_mutual,
      {
        source: 'unipile',
        text: 'Connected on LinkedIn',
      },
      m.seenAt,
      m.seenAt,
    );
  for (const v of input.villagePaths ?? [])
    put(
      v.introducerId,
      v.targetId,
      'village_path',
      Math.min(1, Math.max(0, v.warmth)),
      TIE_CONFIDENCE.village_path,
      {
        source: 'village',
        introducerId: v.introducerId,
        warmth: v.warmth,
        text: 'Know each other (via Village)',
      },
      v.seenAt,
      v.seenAt,
    );

  return [...ties.values()];
}

/** w for routing: interaction kinds lose half their weight every two years since the last evidence. */
export function decayedTieWeight(
  t: Pick<Tie, 'kind' | 'weight' | 'lastSeenAt'>,
  now: Date = new Date(),
): number {
  if (!INTERACTION_TIE_KINDS.has(t.kind) || !t.lastSeenAt) return t.weight;
  const at = new Date(t.lastSeenAt).getTime();
  if (Number.isNaN(at)) return t.weight;
  const years = Math.max(0, now.getTime() - at) / YEAR;
  return t.weight * 0.5 ** (years / 2);
}

export interface TiePair {
  aId: string;
  bId: string;
  /** w_pair = 1 − Π(1 − w_k·c_k), decay applied */
  weight: number;
  /** c_pair = 1 − Π(1 − c_k) */
  confidence: number;
  kinds: TieKind[];
  ties: Tie[];
  /** the newest evidence across kinds */
  lastSeenAt?: string;
}

/** Combine every kind between a pair (noisy-OR, confidence-weighted). Keyed `${aId}|${bId}` with aId < bId. */
export function combineTies(ties: Tie[], now: Date = new Date()): Map<string, TiePair> {
  const out = new Map<string, TiePair>();
  for (const t of ties) {
    const k = `${t.aId}|${t.bId}`;
    const cur = out.get(k) ?? { aId: t.aId, bId: t.bId, weight: 0, confidence: 0, kinds: [], ties: [] };
    const wc = Math.min(1, decayedTieWeight(t, now) * t.confidence);
    cur.weight = 1 - (1 - cur.weight) * (1 - wc);
    cur.confidence = 1 - (1 - cur.confidence) * (1 - t.confidence);
    if (!cur.kinds.includes(t.kind)) cur.kinds.push(t.kind);
    cur.ties.push(t);
    cur.lastSeenAt = maxIso(cur.lastSeenAt, t.lastSeenAt);
    out.set(k, cur);
  }
  return out;
}

/** A pair routes only with combined confidence ≥ 0.5 or evidence of a real interaction or a LinkedIn connection. */
export function isRoutable(pair: Pick<TiePair, 'confidence' | 'kinds'>): boolean {
  return pair.confidence >= 0.5 || pair.kinds.some((k) => ROUTABLE_TIE_KINDS.has(k));
}

/**
 * Ties as v1 edges, one per pair and kind: `weight` is w·c (decayed), so `combinedPairWeights` over them is
 * w_pair, and the evidence keeps the v1 fields the hop texts read.
 */
export function tiesToEdges(ties: Tie[], now: Date = new Date()): Edge[] {
  return ties.map((t) => ({
    id: t.id,
    userId: t.userId,
    personAId: t.aId,
    personBId: t.bId,
    type: t.kind,
    weight: Math.min(1, decayedTieWeight(t, now) * t.confidence),
    confidence: t.confidence,
    kinds: [t.kind],
    evidence: { ...t.evidence, ...(t.lastSeenAt ? { lastSeenAt: t.lastSeenAt } : {}) },
  }));
}

/**
 * Pairs from stored edges (the browser keeps edges, not ties). An edge without a confidence is a v1 edge: its weight
 * was w alone, so its kind's typical confidence is applied here.
 */
export function pairsFromEdges(edges: Edge[]): Map<string, TiePair> {
  const out = new Map<string, TiePair>();
  for (const e of edges) {
    const [a, b] = pairKey(e.personAId, e.personBId);
    const k = `${a}|${b}`;
    const cur = out.get(k) ?? { aId: a, bId: b, weight: 0, confidence: 0, kinds: [], ties: [] };
    const c = e.confidence ?? TIE_CONFIDENCE[e.type];
    const wc = e.confidence === undefined ? e.weight * c : e.weight;
    cur.weight = 1 - (1 - cur.weight) * (1 - Math.min(1, wc));
    cur.confidence = 1 - (1 - cur.confidence) * (1 - c);
    for (const kind of e.kinds ?? [e.type]) if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
    const ev = e.evidence as Record<string, unknown>;
    const last =
      typeof ev.lastSeenAt === 'string'
        ? ev.lastSeenAt
        : typeof ev.lastAt === 'string'
          ? ev.lastAt
          : undefined;
    cur.lastSeenAt = maxIso(cur.lastSeenAt, last);
    cur.ties.push({
      id: e.id,
      userId: e.userId,
      aId: a,
      bId: b,
      kind: e.type,
      weight: e.confidence === undefined ? e.weight : c > 0 ? e.weight / c : 0,
      confidence: c,
      evidence: e.evidence,
      lastSeenAt: last,
    });
    out.set(k, cur);
  }
  return out;
}
