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
const LN2 = Math.LN2;
const DAY = 86_400_000;

export function computeStrength(
  touchpoints: Touchpoint[],
  now: Date = new Date(),
): { strength: number; breakdown: StrengthBreakdown } {
  let raw = 0;
  let last: number | undefined;
  const counts: Partial<Record<TouchpointKind, number>> = {};
  const t = now.getTime();
  for (const tp of touchpoints) {
    const ti = new Date(tp.occurredAt).getTime();
    if (Number.isNaN(ti) || ti > t + DAY) continue;
    const ageDays = Math.max(0, (t - ti) / DAY);
    raw += tp.weight * Math.exp((-LN2 * ageDays) / HALF_LIFE_DAYS);
    counts[tp.kind] = (counts[tp.kind] ?? 0) + 1;
    if (last === undefined || ti > last) last = ti;
  }
  if (last === undefined) return { strength: 0, breakdown: { raw: 0, recency: 0, counts } };
  const daysSinceLast = (t - last) / DAY;
  const recency = Math.exp((-LN2 * daysSinceLast) / RECENCY_HALF_LIFE_DAYS);
  const saturated = 1 - Math.exp(-raw / 2);
  const strength = Math.min(1, Math.max(0, 0.15 * recency + 0.85 * saturated));
  return { strength, breakdown: { raw, recency, counts, lastInteractionAt: new Date(last).toISOString() } };
}

export function strengthTier(strength: number): 'strong' | 'medium' | 'weak' {
  if (strength >= 0.6) return 'strong';
  if (strength >= 0.3) return 'medium';
  return 'weak';
}
