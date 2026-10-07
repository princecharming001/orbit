import type { StrengthBreakdown, Touchpoint, TouchpointKind } from '../types';

export const TOUCHPOINT_WEIGHTS: Record<TouchpointKind, number> = {
  meeting: 1.0,
  email_out: 0.6,
  email_in: 0.7,
  email_cc: 0.1,
  linkedin_in: 0.6,
  linkedin_out: 0.5,
  linkedin_connected: 0.2,
  linkedin_engaged: 0.15,
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
  'manual_log',
  'intro_observed',
]);
/** Sharing a CC line, a mailing list or a LinkedIn connection is not an interaction. */
const AMBIENT: ReadonlySet<TouchpointKind> = new Set(['email_cc', 'linkedin_connected']);

/** Touches the student would call a conversation: what "the last one was ..." may refer to. */
const CONVERSATION: ReadonlySet<TouchpointKind> = new Set([
  'meeting',
  'manual_log',
  'email_in',
  'email_out',
  'linkedin_in',
  'linkedin_out',
]);

/** Decayed raw evidence that outbound-only touches (cold emails, bumps, likes) can add before any reply. */
export const ONE_WAY_RAW_CAP = 0.35;
/** Decayed raw evidence that CC and group-thread touches can ever add. CC can nudge a tie, never create one. */
export const CC_RAW_CAP = 0.3;
/** Without a reply, a meeting or a logged conversation a person stays in the weak tier. */
export const UNRECIPROCATED_CEILING = 0.29;

export function computeStrength(
  touchpoints: Touchpoint[],
  now: Date = new Date(),
): { strength: number; breakdown: StrengthBreakdown } {
  let twoWay = 0;
  let oneWay = 0;
  let cc = 0;
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
    if (TWO_WAY.has(tp.kind)) twoWay += decayed;
    else if (tp.kind === 'email_cc') cc += decayed;
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
  const raw =
    twoWay + (reciprocal ? oneWay : Math.min(oneWay, ONE_WAY_RAW_CAP)) + Math.min(cc, CC_RAW_CAP) + connected;
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

/** Number of real interactions: CCs, mailing lists and the LinkedIn connection itself do not count. */
export function interactionCount(counts: Partial<Record<TouchpointKind, number>> | undefined): number {
  if (!counts) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(counts) as [TouchpointKind, number | undefined][])
    if (!AMBIENT.has(k)) n += v ?? 0;
  return n;
}

/** True once the person has written back, met the student, or been introduced to them. */
export function isReciprocal(counts: Partial<Record<TouchpointKind, number>> | undefined): boolean {
  if (!counts) return false;
  for (const k of TWO_WAY) if ((counts[k] ?? 0) > 0) return true;
  return false;
}

/** Tier thresholds (inner ring, middle ring); the product spec's defaults. */
export const STRONG_TIE = 0.6;
export const MEDIUM_TIE = 0.3;

export function strengthTier(strength: number): 'strong' | 'medium' | 'weak' {
  if (strength >= STRONG_TIE) return 'strong';
  if (strength >= MEDIUM_TIE) return 'medium';
  return 'weak';
}
