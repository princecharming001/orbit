import { newId, normalizeCompany, type TargetCompany } from '@orbit/core';
import { db } from '../db/schema';
import { wantCompanyLogo } from './logoQueue';
import { upsertOrganization } from './people';

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
  return (await addTarget(userId, raw)).status;
}

/**
 * Add a target company once, tied to its organization (made when Orbit has none, with its LinkedIn logo asked for),
 * so the company page and the map match it by id. A target already there keeps its row; what the posting adds (the
 * role, the team, the link, a deadline) fills in what it does not have yet.
 */
export async function addTarget(
  userId: string,
  raw: string,
  extra: Partial<Pick<TargetCompany, 'role' | 'team' | 'postingUrl' | 'postingSeenAt' | 'deadline'>> = {},
): Promise<{ status: 'added' | 'duplicate' | 'empty'; target?: TargetCompany }> {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { status: 'empty' };
  const existing = await db.targetCompanies.where('userId').equals(userId).toArray();
  const key = normalizeCompany(name) || name.toLowerCase();
  const had = existing.find((t) => (normalizeCompany(t.nameRaw) || t.nameRaw.trim().toLowerCase()) === key);
  const org = await upsertOrganization(name);
  if (org && !org.logoUrl) wantCompanyLogo(org.name);
  if (had) {
    const patch: Partial<TargetCompany> = {};
    if (org && !had.organizationId) patch.organizationId = org.id;
    for (const k of ['role', 'team', 'postingUrl', 'postingSeenAt', 'deadline'] as const)
      if (extra[k] && (k === 'postingSeenAt' || !had[k])) patch[k] = extra[k];
    if (Object.keys(patch).length) await db.targetCompanies.update(had.id, patch);
    return { status: 'duplicate', target: { ...had, ...patch } };
  }
  const target: TargetCompany = {
    id: newId('tc'),
    userId,
    organizationId: org?.id,
    nameRaw: name,
    priority: 2,
    status: 'researching',
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => !!v)),
  };
  await db.targetCompanies.add(target);
  return { status: 'added', target };
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
