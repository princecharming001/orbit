import type { StrengthBreakdown, Touchpoint, TouchpointKind } from '../types';

export const TOUCHPOINT_WEIGHTS: Record<TouchpointKind, number> = {
  meeting: 1.0,
  email_out: 0.6,
  email_in: 0.7,
  email_cc: 0.1,
  // a LinkedIn direct message is a message like an email (plan 17 B)
  linkedin_in: 0.7,
  linkedin_out: 0.6,
  // a day of texting each way: people who text are close, but a day of texts is lighter than an email thread
  text_in: 0.6,
  text_out: 0.45,
  linkedin_connected: 0.2,
  linkedin_engaged: 0.15,
  // comments and reactions on posts show attention, not a relationship: light, and capped together below
  linkedin_comment_in: 0.15,
  linkedin_comment_out: 0.1,
  linkedin_reaction_in: 0.03,
  note: 0.3,
  manual_log: 1.0,
  intro_observed: 0.8,
};

export const HALF_LIFE_DAYS = 90;
export const RECENCY_HALF_LIFE_DAYS = 45;
/**
 * Raw evidence at which the saturating curve reaches 63%. Chosen so the canonical cases land where a student
 * would put them: two meetings in the last month is a strong tie (inner ring), one coffee chat yesterday is
 * medium, and the same two meetings six weeks or more ago drift back to medium.
 */
export const SATURATION_RAW = 1.6;
const LN2 = Math.LN2;
const DAY = 86_400_000;

/** Evidence that the other person engaged back: they wrote, met the student, or were introduced. */
const TWO_WAY: ReadonlySet<TouchpointKind> = new Set([
  'meeting',
  'email_in',
  'linkedin_in',
  'text_in',
  'manual_log',
  'intro_observed',
]);
/** Messages from them: only an exchange once the student has written too (a cold email or a newsletter is not). */
const FROM_THEM: ReadonlySet<TouchpointKind> = new Set(['email_in', 'linkedin_in', 'text_in']);
const FROM_STUDENT: ReadonlySet<TouchpointKind> = new Set(['email_out', 'linkedin_out', 'text_out']);
/** Comments and reactions on LinkedIn posts: attention, not a conversation. */
export const ENGAGEMENT: ReadonlySet<TouchpointKind> = new Set([
  'linkedin_comment_in',
  'linkedin_comment_out',
  'linkedin_reaction_in',
]);
/** Sharing a CC line, a mailing list or a LinkedIn connection is not an interaction, and neither is a like. */
const AMBIENT: ReadonlySet<TouchpointKind> = new Set(['email_cc', 'linkedin_connected', ...ENGAGEMENT]);

/** Touches the student would call a conversation: what "the last one was ..." may refer to. */
const CONVERSATION: ReadonlySet<TouchpointKind> = new Set([
  'meeting',
  'manual_log',
  'email_in',
  'email_out',
  'linkedin_in',
  'linkedin_out',
  'text_in',
  'text_out',
]);

/** Decayed raw evidence that outbound-only touches (cold emails, bumps, likes) can add before any reply. */
export const ONE_WAY_RAW_CAP = 0.35;
/** Decayed raw evidence that CC and group-thread touches can ever add. CC can nudge a tie, never create one. */
export const CC_RAW_CAP = 0.3;
/** Decayed raw evidence that comments and reactions on LinkedIn posts can ever add: a nudge, never a tie. */
export const ENGAGEMENT_RAW_CAP = 0.2;
/** Without a reply, a meeting or a logged conversation a person stays in the weak tier. */
export const UNRECIPROCATED_CEILING = 0.29;

export function computeStrength(
  touchpoints: Touchpoint[],
  now: Date = new Date(),
): { strength: number; breakdown: StrengthBreakdown } {
  let twoWay = 0;
  let fromThem = 0;
  let oneWay = 0;
  let cc = 0;
  let engaged = 0;
  let connected = 0;
  let last: number | undefined;
  let lastActive: number | undefined;
  let lastConversation: number | undefined;
  const counts: Partial<Record<TouchpointKind, number>> = {};
  const t = now.getTime();
  for (const tp of touchpoints) {
    const at = new Date(tp.occurredAt).getTime();
    if (Number.isNaN(at) || at > t + DAY) continue;
    // a touch a few hours "in the future" (clock skew, a meeting later today) counts as happening now
    const ti = Math.min(at, t);
    const ageDays = (t - ti) / DAY;
    const decayed = tp.weight * Math.exp((-LN2 * ageDays) / HALF_LIFE_DAYS);
    if (FROM_THEM.has(tp.kind)) fromThem += decayed;
    else if (TWO_WAY.has(tp.kind)) twoWay += decayed;
    else if (tp.kind === 'email_cc') cc += decayed;
    else if (ENGAGEMENT.has(tp.kind)) engaged += decayed;
    else if (tp.kind === 'linkedin_connected') connected += decayed;
    else oneWay += decayed;
    counts[tp.kind] = (counts[tp.kind] ?? 0) + 1;
    if (last === undefined || ti > last) last = ti;
    if (!AMBIENT.has(tp.kind) && (lastActive === undefined || ti > lastActive)) lastActive = ti;
    if (CONVERSATION.has(tp.kind) && (lastConversation === undefined || ti > lastConversation))
      lastConversation = ti;
  }
  if (last === undefined) return { strength: 0, breakdown: { raw: 0, recency: 0, counts } };
  const reciprocal = isReciprocal(counts);
  // what they sent counts in full once it is an exchange; before that it is one-way, like a cold email
  if (reciprocal) twoWay += fromThem;
  else oneWay += fromThem;
  const raw =
    twoWay +
    (reciprocal ? oneWay : Math.min(oneWay, ONE_WAY_RAW_CAP)) +
    Math.min(cc, CC_RAW_CAP) +
    Math.min(engaged, ENGAGEMENT_RAW_CAP) +
    connected;
  // "We talked yesterday" only counts for real touches: a CC yesterday says nothing about the tie.
  const daysSinceLast = (t - (lastActive ?? last)) / DAY;
  const recency = Math.exp((-LN2 * daysSinceLast) / RECENCY_HALF_LIFE_DAYS);
  const saturated = 1 - Math.exp(-raw / SATURATION_RAW);
  const recencyWeight = reciprocal ? 0.15 : lastActive === undefined ? 0.05 : 0.075;
  let strength = Math.min(1, Math.max(0, recencyWeight * recency + 0.85 * saturated));
  if (!reciprocal) strength = Math.min(strength, UNRECIPROCATED_CEILING);
  return {
    strength,
    breakdown: {
      raw,
      recency,
      counts,
      lastInteractionAt: new Date(last).toISOString(),
      ...(lastConversation === undefined
        ? {}
        : { lastConversationAt: new Date(lastConversation).toISOString() }),
    },
  };
}

/** Number of real interactions: CCs, mailing lists, the LinkedIn connection itself and likes do not count. */
export function interactionCount(counts: Partial<Record<TouchpointKind, number>> | undefined): number {
  if (!counts) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(counts) as [TouchpointKind, number | undefined][])
    if (!AMBIENT.has(k)) n += v ?? 0;
  return n;
}

/**
 * True once there is a real exchange: they met the student or were introduced to them, or they wrote and the student
 * wrote too. Mail that only ever came in (a cold pitch, a founder's product update, a recruiter blast) is not one.
 */
export function isReciprocal(counts: Partial<Record<TouchpointKind, number>> | undefined): boolean {
  if (!counts) return false;
  const has = (k: TouchpointKind) => (counts[k] ?? 0) > 0;
  for (const k of TWO_WAY) if (!FROM_THEM.has(k) && has(k)) return true;
  return [...FROM_THEM].some(has) && [...FROM_STUDENT].some(has);
}

/**
 * Tier thresholds (inner ring, middle ring) on `strength` = tie score / 100 (plan 16 §3.3): Close and Strong
 * (60+) are the strong tier, Warm (40–59) the medium tier, Light and Faint the weak tier. v1 put the middle ring at
 * 0.3 on the computeStrength scale.
 */
export const STRONG_TIE = 0.6;
export const MEDIUM_TIE = 0.4;

export function strengthTier(strength: number): 'strong' | 'medium' | 'weak' {
  if (strength >= STRONG_TIE) return 'strong';
  if (strength >= MEDIUM_TIE) return 'medium';
  return 'weak';
}

/**
 * LinkedIn comments and reactions that go both ways (they engage with the student's posts and the student comments
 * on theirs), or that sit next to direct messages the other way: the only time post engagement says the student
 * knows someone. A stranger who reacts to every post is an audience, not a contact.
 */
export function engagedBothWays(counts: Partial<Record<TouchpointKind, number>> | undefined): boolean {
  if (!counts) return false;
  const has = (k: TouchpointKind) => (counts[k] ?? 0) > 0;
  const fromThem = has('linkedin_comment_in') || has('linkedin_reaction_in');
  const fromStudent = has('linkedin_comment_out');
  return (fromThem && (fromStudent || has('linkedin_out'))) || (fromStudent && has('linkedin_in'));
}
