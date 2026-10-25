import { normalizeCompany, normalizeEmail } from '../text/normalize';
import type { Edge, EdgeType, EmailMessage } from '../types';
import { type EdgeInput, inferEdges, sizeClass } from './edges';
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
  'linkedin_recommendation',
  'linkedin_engagement',
  'linkedin_mention',
  'common_contacts',
  'student_says_close',
];

/**
 * Every hand-set number of plan 21 in one place, so a fit on intro outcomes (plan 21 §8) can replace them without
 * touching the callers.
 */
export const HOP_WEIGHTS = {
  /** a LinkedIn connection with nothing more known (plan 16 §4.2) */
  mutual: 0.3,
  recommendation: 0.85,
  /** divided by (people tagged − 1) beyond two */
  mention: 0.6,
  studentSaysClose: 0.8,
  engagement: {
    /** kind weights in E */
    comment: 1,
    reply: 1.5,
    repost: 1,
    reaction: 0.1,
    /** w = scale · (1 − e^(−E/saturation)), then capped */
    scale: 0.75,
    saturation: 3,
    oneWayCap: 0.25,
    reciprocalCap: 0.5,
    /** reactions alone add at most this much E */
    reactionCap: 1,
    /** below this audience, no popularity discount */
    audience: 2000,
    /** popularity when the post author's followers are not known yet */
    unknownPopularity: 0.25,
    /** a reactions page this full marks a serial liker, whose reactions count this much */
    serialLiker: 60,
    serialLikerFactor: 0.5,
    /** recency of an item: within 12 months, within 24, older or undated */
    recent: 1,
    lastYear: 0.6,
    old: 0.35,
  },
  /** w = scale · (1 − e^(−S/saturation)), S = Σ the weaker tie of each common contact */
  commonContacts: { scale: 0.5, saturation: 2 },
  /** a pair is "fading" when its newest evidence is older than this many times its usual gap (and 90 days) */
  fadingGaps: 8,
} as const;

/** Kinds that record an interaction: their weight halves every two years without new evidence. */
export const INTERACTION_TIE_KINDS: ReadonlySet<TieKind> = new Set([
  'email_exchange',
  'email_cc',
  'email_cothread',
  'meeting_coattendee',
  'introduced_by',
]);

/** Half-life in years of each kind that fades without new evidence (the rest do not decay). */
export const TIE_HALF_LIFE_YEARS: Partial<Record<TieKind, number>> = {
  email_exchange: 2,
  email_cc: 2,
  email_cothread: 2,
  meeting_coattendee: 2,
  introduced_by: 2,
  linkedin_recommendation: 5,
  linkedin_mention: 2,
};

/** Kinds strong enough to route through whatever the combined confidence (§4.1). */
export const ROUTABLE_TIE_KINDS: ReadonlySet<TieKind> = new Set([
  'email_exchange',
  'email_cc',
  'meeting_coattendee',
  'introduced_by',
  'linkedin_mutual',
  'linkedin_recommendation',
  'student_says_close',
]);

/**
 * Kinds that only strengthen a pair already routable on other grounds (plan 21 §3.2): public engagement mostly
 * measures fandom, and common contacts say two people move in the same circles, not that one would vouch for the
 * other. They never count towards `isRoutable`.
 */
export const SUPPORT_ONLY_TIE_KINDS: ReadonlySet<TieKind> = new Set([
  'linkedin_engagement',
  'linkedin_mention',
  'common_contacts',
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
  linkedin_recommendation: 0.95,
  linkedin_engagement: 0.9,
  linkedin_mention: 0.9,
  common_contacts: 0.6,
  student_says_close: 0.9,
};

/**
 * Confidence of an affiliation tie from its evidence (plan 16 §4.1, sharpened by plan 21 §3.6): how long the two
 * overlapped, how big the employer is, how long ago it ended, whether they were peers and in the same function.
 * `bigOrg` overrides the size read from the evidence (the server knows its organisations by name). Kinds other than
 * the affiliations keep their fixed confidence.
 */
export function affiliationConfidence(
  kind: TieKind,
  ev: Record<string, unknown>,
  now: Date = new Date(),
  bigOrg?: boolean,
): number {
  const bucket = typeof ev.sizeBucket === 'string' ? ev.sizeBucket : undefined;
  const size = sizeClass(bucket);
  const big = bigOrg ?? (!!bucket && BIG_ORG.has(bucket));
  if (kind === 'co_tenure') {
    const months = typeof ev.overlapMonths === 'number' ? ev.overlapMonths : 0;
    let c = Math.min(0.8, 0.3 + 0.05 * months);
    if (big) c *= 0.5;
    if (bucket === '10001+') c *= 0.7;
    if (size === 'small') c *= 1.3;
    else if (bucket === '51-200') c *= 1.1;
    if (typeof ev.toYear === 'number' && ev.toYear < now.getUTCFullYear() - 10) c *= 0.6;
    if (ev.peers === 'same') c *= 1.15;
    else if (ev.peers === 'gap') c *= 0.8;
    if (ev.sameFunction === true) c *= 1.1;
    return Math.min(0.9, c);
  }
  if (kind === 'same_current_company') {
    if (size === 'small') return 0.8;
    if (size === 'mid') return 0.45;
    return big ? 0.175 : 0.35;
  }
  if (kind === 'same_school_cohort')
    return typeof ev.year === 'number' ? 0.4 : ev.withinTwoYears ? 0.25 : 0.1;
  return TIE_CONFIDENCE[kind];
}

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
  /** plan 21: LinkedIn engagement, recommendations, mentions and the student's word between two contacts */
  evidence?: Omit<PairEvidenceInput, 'userId' | 'people' | 'now'>;
}

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
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
    if (e.type === 'co_tenure' || e.type === 'same_current_company') {
      // the evidence's own size bucket wins; otherwise the organisation the server knows by name
      const isBig = typeof ev.sizeBucket === 'string' ? undefined : big(ev.orgName);
      put(e.personAId, e.personBId, e.type, e.weight, affiliationConfidence(e.type, ev, now, isBig), ev);
    } else if (e.type === 'same_school_cohort') {
      put(
        e.personAId,
        e.personBId,
        'same_school_cohort',
        e.weight,
        affiliationConfidence(e.type, ev, now),
        ev,
      );
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
      HOP_WEIGHTS.mutual,
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

  if (input.evidence)
    for (const t of pairEvidenceTies({ ...input.evidence, userId: input.userId, people: ids, now }))
      put(t.aId, t.bId, t.kind, t.weight, t.confidence, t.evidence, t.firstSeenAt, t.lastSeenAt);

  return [...ties.values()];
}

/**
 * w for routing: kinds that record something that happened fade without new evidence (interactions: half every two
 * years; a LinkedIn recommendation: every five; a mention: every two). Engagement carries its own recency (§3.3).
 */
export function decayedTieWeight(
  t: Pick<Tie, 'kind' | 'weight' | 'lastSeenAt'>,
  now: Date = new Date(),
): number {
  const halfLife = TIE_HALF_LIFE_YEARS[t.kind];
  if (!halfLife || !t.lastSeenAt) return t.weight;
  const at = new Date(t.lastSeenAt).getTime();
  if (Number.isNaN(at)) return t.weight;
  const years = Math.max(0, now.getTime() - at) / YEAR;
  return t.weight * 0.5 ** (years / halfLife);
}

/** One act on LinkedIn between two of the student's contacts (plan 21 §3.3), as person ids. */
export interface EngagementItem {
  /** who acted */
  actorId: string;
  /** whom the act was toward */
  otherId: string;
  /** reply: the post's author answering the other's comment on their own post */
  kind: 'comment' | 'reply' | 'repost' | 'reaction';
  /** whose post it was on (the popularity discount reads their followers) */
  postAuthorId: string;
  /** the post (de-duplication: one reaction or repost per actor per post; comments by their own id) */
  postId: string;
  /** the comment's id, for comments and replies */
  commentId?: string;
  /** the comment's date, or the post's for a reaction or repost; undefined when unknown */
  at?: string;
}

export interface EngagementContext {
  /** LinkedIn followers by person id; a person missing here has an unknown audience */
  followers?: ReadonlyMap<string, number>;
  /** how many items each person's LinkedIn reactions page held when read (a serial liker's likes count less) */
  reactionVolume?: ReadonlyMap<string, number>;
  now?: Date;
}

export interface EngagementCounts {
  comments: number;
  replies: number;
  reposts: number;
  reactions: number;
}

export interface EngagementScore {
  /** the evidence total of §3.3 */
  E: number;
  /** w before the noisy-OR, capped one-way, reciprocal, or by an unknown audience */
  w: number;
  /** both wrote something (a comment, a reply or a repost) on the other's posts */
  reciprocal: boolean;
  /** every post author's audience was known */
  popularityKnown: boolean;
  /** per actor, what they did toward the other */
  counts: Record<string, EngagementCounts>;
  /** the newest dated item */
  newestAt?: string;
  firstAt?: string;
  /** dated items, for the fading check */
  dated: number;
}

const zeroCounts = (): EngagementCounts => ({ comments: 0, replies: 0, reposts: 0, reactions: 0 });

/**
 * How much a pair's public LinkedIn engagement says about them knowing each other (plan 21 §3.3). A comment is a
 * deliberate act; a like among thousands is noise; recent counts more; a serial liker's likes count less; and one-way
 * engagement, however much, never reaches what reciprocity does, because one-way engagement is mostly fandom.
 */
export function engagementScore(items: EngagementItem[], ctx: EngagementContext = {}): EngagementScore {
  const W = HOP_WEIGHTS.engagement;
  const now = (ctx.now ?? new Date()).getTime();
  const seen = new Set<string>();
  const counts: Record<string, EngagementCounts> = {};
  let reactionsE = 0;
  let otherE = 0;
  let popularityKnown = true;
  let newestAt: string | undefined;
  let firstAt: string | undefined;
  let dated = 0;
  const writers = new Set<string>();
  for (const it of items) {
    const ref = `${it.actorId}|${it.kind}|${it.commentId ?? it.postId}`;
    if (seen.has(ref) || it.actorId === it.otherId) continue;
    seen.add(ref);
    const followers = ctx.followers?.get(it.postAuthorId);
    if (followers === undefined) popularityKnown = false;
    const share =
      followers === undefined ? W.unknownPopularity : W.audience / Math.max(W.audience, followers);
    const t = it.at ? Date.parse(it.at) : Number.NaN;
    const months = Number.isFinite(t) ? (now - t) / (30.44 * DAY) : Number.POSITIVE_INFINITY;
    const recency = months <= 12 ? W.recent : months <= 24 ? W.lastYear : W.old;
    if (Number.isFinite(t)) {
      dated++;
      const iso = new Date(t).toISOString();
      newestAt = maxIso(newestAt, iso);
      firstAt = minIso(firstAt, iso);
    }
    const c = (counts[it.actorId] ??= zeroCounts());
    if (it.kind === 'reaction') {
      c.reactions++;
      const volume = ctx.reactionVolume?.get(it.actorId) ?? 0;
      const liker = volume >= W.serialLiker ? W.serialLikerFactor : 1;
      reactionsE += W.reaction * share * recency * liker;
      continue;
    }
    if (it.kind === 'comment') c.comments++;
    else if (it.kind === 'reply') c.replies++;
    else c.reposts++;
    writers.add(it.actorId);
    otherE += W[it.kind] * Math.sqrt(share) * recency;
  }
  const E = otherE + Math.min(W.reactionCap, reactionsE);
  const reciprocal = writers.size >= 2;
  const cap = !popularityKnown ? W.oneWayCap : reciprocal ? W.reciprocalCap : W.oneWayCap;
  const w = Math.min(cap, W.scale * (1 - Math.exp(-E / W.saturation)));
  return { E, w, reciprocal, popularityKnown, counts, newestAt, firstAt, dated };
}

/** Everything plan 21 adds about two of the student's contacts, from LinkedIn and from the student. */
export interface PairEvidenceInput {
  userId: string;
  /** the people ties may be made between (anyone else is ignored) */
  people: ReadonlySet<string>;
  engagement?: EngagementItem[];
  followers?: ReadonlyMap<string, number>;
  reactionVolume?: ReadonlyMap<string, number>;
  /** `authorId` recommended `subjectId` on LinkedIn */
  recommendations?: { authorId: string; subjectId: string; year?: number; caption?: string }[];
  /** `authorId` named `mentionedId` in a post that tagged `tagged` people */
  mentions?: { authorId: string; mentionedId: string; postId: string; at?: string; tagged: number }[];
  /** the student said these two are close */
  studentSays?: { aId: string; bId: string; at?: string }[];
  now?: Date;
}

/**
 * Ties from plan 21's evidence (§3.2): engagement (support only), recommendations, mentions (support only) and the
 * student's word. Pure; the browser merges them into its pairs, the server stores them as ties.
 */
export function pairEvidenceTies(input: PairEvidenceInput): Tie[] {
  const now = input.now ?? new Date();
  const out = new Map<string, Tie>();
  const ok = (a: string, b: string) => a !== b && input.people.has(a) && input.people.has(b);
  const put = (t: Omit<Tie, 'id' | 'userId' | 'aId' | 'bId'>, a: string, b: string) => {
    if (!ok(a, b)) return;
    const [x, y] = pairKey(a, b);
    const id = `${x}|${y}|${t.kind}`;
    const cur = out.get(id);
    if (cur && cur.weight * cur.confidence >= t.weight * t.confidence) return;
    out.set(id, { ...t, id, userId: input.userId, aId: x, bId: y });
  };

  const byPair = new Map<string, EngagementItem[]>();
  for (const it of input.engagement ?? []) {
    if (!ok(it.actorId, it.otherId)) continue;
    const [x, y] = pairKey(it.actorId, it.otherId);
    const k = `${x}|${y}`;
    const arr = byPair.get(k) ?? [];
    arr.push(it);
    byPair.set(k, arr);
  }
  for (const [k, items] of byPair) {
    const [x, y] = k.split('|') as [string, string];
    const sc = engagementScore(items, {
      followers: input.followers,
      reactionVolume: input.reactionVolume,
      now,
    });
    if (sc.w <= 0) continue;
    put(
      {
        kind: 'linkedin_engagement',
        weight: sc.w,
        confidence: TIE_CONFIDENCE.linkedin_engagement,
        evidence: {
          source: 'linkedin',
          counts: sc.counts,
          reciprocal: sc.reciprocal,
          popularityKnown: sc.popularityKnown,
          E: Math.round(sc.E * 1000) / 1000,
          items: sc.dated,
          firstAt: sc.firstAt,
          lastAt: sc.newestAt,
          text: sc.reciprocal
            ? 'Comment on each other’s LinkedIn posts'
            : 'Engage with each other on LinkedIn',
        },
        firstSeenAt: sc.firstAt,
        lastSeenAt: sc.newestAt,
      },
      x,
      y,
    );
  }

  for (const r of input.recommendations ?? []) {
    const at = r.year ? `${r.year}-07-01T00:00:00.000Z` : undefined;
    put(
      {
        kind: 'linkedin_recommendation',
        weight: HOP_WEIGHTS.recommendation,
        confidence: TIE_CONFIDENCE.linkedin_recommendation,
        evidence: {
          source: 'linkedin',
          authorId: r.authorId,
          subjectId: r.subjectId,
          ...(r.year ? { year: r.year } : {}),
          ...(r.caption ? { caption: r.caption.slice(0, 80) } : {}),
          text: 'Recommended on LinkedIn',
        },
        firstSeenAt: at,
        lastSeenAt: at,
      },
      r.authorId,
      r.subjectId,
    );
  }

  for (const m of input.mentions ?? []) {
    const tagged = Math.max(1, m.tagged);
    put(
      {
        kind: 'linkedin_mention',
        weight: HOP_WEIGHTS.mention / Math.max(1, tagged - 1),
        confidence: TIE_CONFIDENCE.linkedin_mention,
        evidence: {
          source: 'linkedin',
          authorId: m.authorId,
          mentionedId: m.mentionedId,
          postId: m.postId,
          tagged,
          lastAt: m.at,
          text: 'Mentioned in a LinkedIn post',
        },
        firstSeenAt: m.at,
        lastSeenAt: m.at,
      },
      m.authorId,
      m.mentionedId,
    );
  }

  for (const s of input.studentSays ?? [])
    put(
      {
        kind: 'student_says_close',
        weight: HOP_WEIGHTS.studentSaysClose,
        confidence: TIE_CONFIDENCE.student_says_close,
        evidence: { source: 'student', at: s.at, text: 'You said they’re close' },
        firstSeenAt: s.at,
        lastSeenAt: s.at,
      },
      s.aId,
      s.bId,
    );

  return [...out.values()];
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
  return mergeTies(new Map(), ties, now);
}

/**
 * Add ties to existing pairs (noisy-OR, as `combineTies`), returning new pairs; the input is left as it was. A tie
 * whose id a pair already holds is skipped, so merging the same evidence twice changes nothing.
 */
export function mergeTies(
  pairs: ReadonlyMap<string, TiePair>,
  ties: Tie[],
  now: Date = new Date(),
): Map<string, TiePair> {
  const out = new Map(pairs);
  for (const t of ties) {
    const [a, b] = pairKey(t.aId, t.bId);
    const k = `${a}|${b}`;
    const prev = out.get(k);
    if (prev?.ties.some((x) => x.id === t.id)) continue;
    const cur: TiePair = prev
      ? { ...prev, kinds: [...prev.kinds], ties: [...prev.ties] }
      : { aId: a, bId: b, weight: 0, confidence: 0, kinds: [], ties: [] };
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

/**
 * Common contacts (plan 21 §3.6): for every routable pair, the people with a real tie (a routable kind) to both,
 * each counted at the weaker of their two ties, added as a support-only `common_contacts` tie. The student is not in
 * the pairs, so never counted. Returns new pairs; pairs that already carry the kind are left as they are.
 */
export function withCommonContacts(
  pairs: ReadonlyMap<string, TiePair>,
  now: Date = new Date(),
): ReadonlyMap<string, TiePair> {
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number) => {
    let m = adj.get(a);
    if (!m) adj.set(a, (m = new Map()));
    m.set(b, w);
  };
  for (const p of pairs.values()) {
    const real = p.ties.filter((t) => ROUTABLE_TIE_KINDS.has(t.kind));
    if (!real.length) continue;
    const w =
      1 - real.reduce((acc, t) => acc * (1 - Math.min(1, decayedTieWeight(t, now) * t.confidence)), 1);
    link(p.aId, p.bId, w);
    link(p.bId, p.aId, w);
  }
  const C = HOP_WEIGHTS.commonContacts;
  const add: Tie[] = [];
  for (const p of pairs.values()) {
    if (p.kinds.includes('common_contacts') || !isRoutable(p)) continue;
    const na = adj.get(p.aId);
    const nb = adj.get(p.bId);
    if (!na || !nb) continue;
    const [small, big] = na.size <= nb.size ? [na, nb] : [nb, na];
    const common: { id: string; w: number }[] = [];
    for (const [c, wa] of small) {
      if (c === p.aId || c === p.bId) continue;
      const wb = big.get(c);
      if (wb !== undefined) common.push({ id: c, w: Math.min(wa, wb) });
    }
    if (!common.length) continue;
    const S = common.reduce((acc, c) => acc + c.w, 0);
    common.sort((x, y) => y.w - x.w || x.id.localeCompare(y.id));
    add.push({
      id: `${p.aId}|${p.bId}|common_contacts`,
      userId: p.ties[0]?.userId ?? '',
      aId: p.aId,
      bId: p.bId,
      kind: 'common_contacts',
      weight: C.scale * (1 - Math.exp(-S / C.saturation)),
      confidence: TIE_CONFIDENCE.common_contacts,
      evidence: {
        n: common.length,
        ids: common.slice(0, 5).map((c) => c.id),
        S: Math.round(S * 1000) / 1000,
        text: common.length === 1 ? 'One contact in common' : `${common.length} contacts in common`,
      },
    });
  }
  return add.length ? mergeTies(pairs, add, now) : pairs;
}

/**
 * The pair's evidence has gone quiet (plan 21, from the tie-decay literature): its newest dated evidence is older than
 * eight times its usual gap, and more than 90 days old. Needs at least three dated events on one kind.
 */
export function pairFading(pair: Pick<TiePair, 'ties'>, now: Date = new Date()): boolean {
  let fading = false;
  for (const t of pair.ties) {
    if (!TIE_HALF_LIFE_YEARS[t.kind] && t.kind !== 'linkedin_engagement') continue;
    const ev = t.evidence as Record<string, unknown>;
    const n = [ev.threads, ev.events, ev.messages, ev.items].find((x): x is number => typeof x === 'number');
    const first = Date.parse(t.firstSeenAt ?? (typeof ev.firstAt === 'string' ? ev.firstAt : ''));
    const last = Date.parse(t.lastSeenAt ?? (typeof ev.lastAt === 'string' ? ev.lastAt : ''));
    if (!n || n < 3 || !Number.isFinite(first) || !Number.isFinite(last) || last <= first) continue;
    const gap = (last - first) / (n - 1);
    const quiet = now.getTime() - last;
    // any kind still active means the pair is not fading
    if (quiet <= Math.max(90 * DAY, HOP_WEIGHTS.fadingGaps * gap)) return false;
    fading = true;
  }
  return fading;
}

/**
 * Evidence that two people actually know each other (they wrote to each other, met, were introduced, or are
 * connected on LinkedIn), not just that they could (same employer or school). The structural tie feature (f11)
 * counts only these as mutual contacts.
 */
export function knowEachOther(pair: Pick<TiePair, 'kinds'>): boolean {
  return pair.kinds.some((k) => ROUTABLE_TIE_KINDS.has(k));
}

/**
 * A pair routes only with evidence of a real interaction, a LinkedIn connection or recommendation, or the student's
 * word, or with confidence ≥ 0.5 from the other kinds. Support-only kinds (engagement, mentions, common contacts)
 * never count: they strengthen a route, they do not create one (plan 21 §3.2).
 */
export function isRoutable(pair: Pick<TiePair, 'confidence' | 'kinds'> & { ties?: Tie[] }): boolean {
  if (pair.kinds.some((k) => ROUTABLE_TIE_KINDS.has(k))) return true;
  if (!pair.kinds.some((k) => SUPPORT_ONLY_TIE_KINDS.has(k))) return pair.confidence >= 0.5;
  if (!pair.ties) return false;
  const c = pair.ties
    .filter((t) => !SUPPORT_ONLY_TIE_KINDS.has(t.kind))
    .reduce((acc, t) => acc * (1 - t.confidence), 1);
  return 1 - c >= 0.5;
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
export function pairsFromEdges(edges: Edge[], now: Date = new Date()): Map<string, TiePair> {
  const out = new Map<string, TiePair>();
  for (const e of edges) {
    const [a, b] = pairKey(e.personAId, e.personBId);
    const k = `${a}|${b}`;
    const cur = out.get(k) ?? { aId: a, bId: b, weight: 0, confidence: 0, kinds: [], ties: [] };
    // a v1 affiliation edge's confidence comes from its evidence (overlap, employer size, peers), as on the server
    const c = e.confidence ?? affiliationConfidence(e.type, e.evidence as Record<string, unknown>, now);
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
