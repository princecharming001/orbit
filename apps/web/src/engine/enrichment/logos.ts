/**
 * Company logos from LinkedIn (the student's rule 2): the company of someone's current position, as LinkedIn names
 * it (its id, its public name and its logo), is kept on the organisation, and CompanyLogo shows that logo before any
 * guessed web-address icon. LinkedIn's image links expire, so an expired logo is fetched again from the company's page.
 */
import { normalizeCompany, type Organization } from '@orbit/core';
import { db } from '../../db/schema';
import type { LinkedInCompany } from '../../integrations/enrichmentProxy';
import { isLinkedInPhoto, linkedInImageExpired } from '../photos';

/** What a LinkedIn position or company page says about a company. */
export interface CompanyFacts {
  companyId?: string;
  companySlug?: string;
  logoUrl?: string;
  /**
   * settled exactly: a LinkedIn position named this company, or the student picked it. It overrides a company found
   * by searching the name; a company found by searching never overrides an exact one.
   */
  exact?: boolean;
}

/**
 * Keep LinkedIn's id, public name and logo on the organisation. A logo replaces none, an expired one, or an older
 * LinkedIn link for the same company; it never replaces a logo from elsewhere. A different LinkedIn company takes over
 * an organisation whose company came from a name search (a position says "Triumph" here is Triumph Labs; the shared
 * list found NASA's own page where it once took a fan page), never one settled exactly.
 */
export async function adoptCompany(
  org: Organization,
  facts: CompanyFacts,
  now = new Date(),
): Promise<Partial<Organization> | undefined> {
  const patch: Partial<Organization> = {};
  const other = !!org.linkedinCompanyId && !!facts.companyId && org.linkedinCompanyId !== facts.companyId;
  // settled exactly (the student's pick, or a position): nothing changes it
  if (other && org.linkedinCompanyExact) return undefined;
  if (other) {
    // another company after all (a position says so, or the shared list corrected what it found by name): nothing of
    // the one found by name stays
    patch.linkedinCompanyId = facts.companyId;
    patch.linkedinSlug = facts.companySlug;
    patch.logoUrl = facts.logoUrl;
    patch.linkedinCompanyExact = !!facts.exact;
  } else {
    if (facts.companyId && !org.linkedinCompanyId) patch.linkedinCompanyId = facts.companyId;
    if (facts.companySlug && !org.linkedinSlug) patch.linkedinSlug = facts.companySlug;
    if (facts.exact && facts.companyId && !org.linkedinCompanyExact) patch.linkedinCompanyExact = true;
    if (
      facts.logoUrl &&
      facts.logoUrl !== org.logoUrl &&
      (!org.logoUrl || isLinkedInPhoto(org.logoUrl) || linkedInImageExpired(org.logoUrl, now))
    )
      patch.logoUrl = facts.logoUrl;
  }
  if (!Object.keys(patch).length) return undefined;
  await db.organizations.update(org.id, patch);
  Object.assign(org, patch);
  return patch;
}

/**
 * LinkedIn no longer stands by the company a name search gave this organisation (the name turned out to be shared by
 * several companies): its id and logo go, so no other company's logo shows for it. Exact ones are never dropped.
 */
export async function dropNameMatch(org: Organization): Promise<boolean> {
  if (org.linkedinCompanyExact || !org.linkedinCompanyId) return false;
  const patch: Partial<Organization> = {
    linkedinCompanyId: undefined,
    linkedinSlug: undefined,
    logoUrl: undefined,
  };
  await db.organizations.update(org.id, patch);
  Object.assign(org, patch);
  return true;
}

/** An organisation whose LinkedIn logo is missing or has expired, and that LinkedIn can be asked about. */
export function logoDue(org: Organization, now = new Date()): boolean {
  if (!org.linkedinCompanyId && !org.linkedinSlug) return false;
  if (!org.logoUrl) return !!org.linkedinCompanyId;
  return isLinkedInPhoto(org.logoUrl) && linkedInImageExpired(org.logoUrl, now);
}

/**
 * Fetch a fresh logo for the student's people's current companies whose LinkedIn logo is missing or expired, most
 * important first. `fetchCompany` is the live or mock LinkedIn; at most `limit` lookups.
 */
export async function refreshLogos(
  orgIds: string[],
  fetchCompany: (identifier: string) => Promise<{ ok: true; value: LinkedInCompany } | { ok: false }>,
  opts: { now?: Date; limit: number; onCall?: () => Promise<void> },
): Promise<number> {
  const now = opts.now ?? new Date();
  let fixed = 0;
  let calls = 0;
  const seen = new Set<string>();
  // a company page that had no logo is asked again only after a week
  const tried = ((await db.kv.get(TRIED_KEY))?.value as Record<string, string> | undefined) ?? {};
  const asked = await logosAskedAt();
  const answered: string[] = [];
  for (const id of orgIds) {
    if (calls >= opts.limit) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const org = await db.organizations.get(id);
    if (!org || !logoDue(org, now)) continue;
    if (now.getTime() - Date.parse(tried[id] ?? '1970-01-01') < RETRY_MS) continue;
    const name = org.nameNormalized || normalizeCompany(org.name);
    // the logo queue asked LinkedIn about this company by name this week and it had no logo then
    if (!org.logoUrl && name && now.getTime() - Date.parse(asked[name] ?? '1970-01-01') < RETRY_MS) continue;
    tried[id] = now.toISOString();
    calls++;
    await opts.onCall?.();
    const r = await fetchCompany(org.linkedinCompanyId ?? org.linkedinSlug!);
    if (!r.ok) continue;
    if (name) answered.push(name);
    const c = r.value;
    const patch = await adoptCompany(
      // the page answered for this organisation's own id: its logo is the one to keep
      { ...org, logoUrl: org.logoUrl && !linkedInImageExpired(org.logoUrl, now) ? org.logoUrl : undefined },
      { companyId: c.id, companySlug: c.publicIdentifier, logoUrl: c.logoUrl },
      now,
    );
    if (patch?.logoUrl) fixed++;
  }
  if (calls) await db.kv.put({ key: TRIED_KEY, value: tried });
  await markLogosAsked(answered, now);
  return fixed;
}

const TRIED_KEY = 'enrich:logos:tried';

/**
 * One record of when LinkedIn last answered for a company, by its normalised name, shared by the logo queue (asks by
 * name) and the logo refresh (asks by id), so a company LinkedIn found without a logo is not asked again by the other
 * (plan 34 B6).
 */
const ASKED_KEY = 'logos:asked';

export async function logosAskedAt(): Promise<Record<string, string>> {
  return ((await db.kv.get(ASKED_KEY))?.value as Record<string, string> | undefined) ?? {};
}

export async function markLogosAsked(keys: string[], now: Date): Promise<void> {
  if (!keys.length) return;
  const asked = await logosAskedAt();
  for (const k of keys) if (k) asked[k] = now.toISOString();
  await db.kv.put({ key: ASKED_KEY, value: asked });
}
const RETRY_MS = 7 * 86_400_000;
