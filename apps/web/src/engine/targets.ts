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

/**
 * Split what was typed into the company box into companies: "Evercore, Lazard" is two. A legal suffix after a comma
 * ("Stripe, Inc.") stays with its company.
 */
export function splitCompanyList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const t = part.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (out.length && /^(inc|llc|ltd|co|corp|plc|lp|llp|gmbh|s\.?a)\.?$/i.test(t))
      out[out.length - 1] += `, ${t}`;
    else out.push(t);
  }
  return out;
}

/** Add every company in a typed list once; says which were already on the list. */
export async function addTargetCompanies(
  userId: string,
  raw: string,
): Promise<{ added: string[]; duplicates: string[] }> {
  const added: string[] = [];
  const duplicates: string[] = [];
  for (const name of splitCompanyList(raw)) {
    const r = await addTargetCompany(userId, name);
    if (r === 'added') added.push(name);
    if (r === 'duplicate') duplicates.push(name);
  }
  return { added, duplicates };
}
