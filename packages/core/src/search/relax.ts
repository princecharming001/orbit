/**
 * Widening an empty answer (plan 32 §6.5, §18.4). Only when the checks said no: an answer empty because Orbit does
 * not know (no location on file) is reported as unchecked and sent to LinkedIn's own search, never widened. Named
 * companies, schools and YC batches are never relaxed; dates Orbit does not have are never "widened".
 */
import type { RunResult } from './run';
import type { QuerySpec } from './spec';
import { SENIORITIES, SENIORITY_RANK } from './titles';

export interface RelaxStep {
  spec: QuerySpec;
  /** said on the card as a chip: "widened: class year ±1" */
  label: string;
}

export function shouldRelax(r: RunResult): boolean {
  const c = r.counts;
  return c.strong + c.likely === 0 && c.uncheckedListed === 0 && c.no > 0;
}

/** The next widenings to try, in order. */
export function relaxSteps(spec: QuerySpec): RelaxStep[] {
  const steps: RelaxStep[] = [];
  const clone = () => structuredClone(spec);
  if (spec.schools?.some((s) => s.gradFrom !== undefined || s.gradTo !== undefined)) {
    const s = clone();
    for (const x of s.schools ?? []) {
      if (x.gradFrom !== undefined) x.gradFrom -= 1;
      if (x.gradTo !== undefined) x.gradTo += 1;
    }
    steps.push({ spec: s, label: 'class year ±1' });
  }
  const rel = spec.relationship;
  if (rel && (rel.talkedWithinDays || rel.connectedWithinDays || rel.touched?.some((t) => t.withinDays))) {
    const s = clone();
    const r = s.relationship!;
    if (r.talkedWithinDays) r.talkedWithinDays *= 3;
    if (r.connectedWithinDays) r.connectedWithinDays *= 3;
    for (const t of r.touched ?? []) if (t.withinDays) t.withinDays *= 3;
    steps.push({ spec: s, label: 'time window ×3' });
  }
  if (spec.positions?.some((p) => p.role?.seniority?.length || p.role?.seniorityAtLeast)) {
    const s = clone();
    for (const p of s.positions ?? []) {
      if (p.role?.seniorityAtLeast) {
        const rank = SENIORITY_RANK[p.role.seniorityAtLeast];
        p.role.seniorityAtLeast =
          SENIORITIES.filter((x) => SENIORITY_RANK[x] === rank - 1 && x !== 'student')[0] ??
          p.role.seniorityAtLeast;
      }
      if (p.role?.seniority?.length) {
        const ranks = new Set(p.role.seniority.map((x) => SENIORITY_RANK[x]));
        p.role.seniority = SENIORITIES.filter(
          (x) => [...ranks].some((r) => Math.abs(SENIORITY_RANK[x] - r) <= 1) && x !== 'student',
        );
      }
    }
    steps.push({ spec: s, label: 'one level up or down' });
  }
  if (
    spec.positions?.some(
      (p) => (p.when ?? 'current') === 'current' && (p.company?.names?.length || p.company?.kinds?.length),
    )
  ) {
    const s = clone();
    for (const p of s.positions ?? []) if ((p.when ?? 'current') === 'current') p.when = 'ever';
    steps.push({ spec: s, label: 'past jobs too' });
  }
  if (spec.positions?.some((p) => p.role?.titles?.length && p.role.families?.length)) {
    const s = clone();
    for (const p of s.positions ?? [])
      if (p.role?.titles?.length && p.role.families?.length) delete p.role.titles;
    steps.push({ spec: s, label: 'any title in the same field' });
  }
  return steps;
}
