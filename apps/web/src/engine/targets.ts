import { newId, normalizeCompany, type TargetCompany } from '@orbit/core';
import { db } from '../db/schema';

/** True when `name` names a company already on the list ("figma" vs "Figma", "Stripe, Inc." vs "Stripe"). */
export function isDuplicateTarget(name: string, existing: Pick<TargetCompany, 'nameRaw'>[]): boolean {
  const key = normalizeCompany(name) || name.trim().toLowerCase();
  return existing.some((t) => (normalizeCompany(t.nameRaw) || t.nameRaw.trim().toLowerCase()) === key);
}

/** Add a target company once. Returns what happened so the caller can tell the student. */
export async function addTargetCompany(
  userId: string,
  raw: string,
): Promise<'added' | 'duplicate' | 'empty'> {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return 'empty';
  const existing = await db.targetCompanies.where('userId').equals(userId).toArray();
  if (isDuplicateTarget(name, existing)) return 'duplicate';
  await db.targetCompanies.add({
    id: newId('tc'),
    userId,
    nameRaw: name,
    priority: 2,
    status: 'researching',
  });
  return 'added';
}
