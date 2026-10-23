/**
 * Company logos from LinkedIn (the student's rule 2): the company of someone's current position, as LinkedIn names
 * it (its id, its public name and its logo), is kept on the organisation, and CompanyLogo shows that logo before any
 * guessed web-address icon. LinkedIn's image links expire, so an expired logo is fetched again from the company's page.
 */
import type { Organization } from '@orbit/core';
import { db } from '../../db/schema';
import type { LinkedInCompany } from '../../integrations/enrichmentProxy';
import { isLinkedInPhoto, linkedInImageExpired } from '../photos';

/** What a LinkedIn position or company page says about a company. */
export interface CompanyFacts {
  companyId?: string;
  companySlug?: string;
  logoUrl?: string;
}

/**
 * Keep LinkedIn's id, public name and logo on the organisation. A logo replaces none, an expired one, or an older
 * LinkedIn link for the same company; it never replaces a logo from elsewhere, and a different LinkedIn company that
 * happens to share the name never takes over the organisation.
 */
export async function adoptCompany(
  org: Organization,
  facts: CompanyFacts,
  now = new Date(),
): Promise<Partial<Organization> | undefined> {
  const patch: Partial<Organization> = {};
  const sameCompany = !org.linkedinCompanyId || !facts.companyId || org.linkedinCompanyId === facts.companyId;
  if (!sameCompany) return undefined;
  if (facts.companyId && !org.linkedinCompanyId) patch.linkedinCompanyId = facts.companyId;
  if (facts.companySlug && !org.linkedinSlug) patch.linkedinSlug = facts.companySlug;
  if (
    facts.logoUrl &&
    facts.logoUrl !== org.logoUrl &&
    (!org.logoUrl || isLinkedInPhoto(org.logoUrl) || linkedInImageExpired(org.logoUrl, now))
  )
    patch.logoUrl = facts.logoUrl;
  if (!Object.keys(patch).length) return undefined;
  await db.organizations.update(org.id, patch);
  Object.assign(org, patch);
  return patch;
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
  for (const id of orgIds) {
    if (calls >= opts.limit) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const org = await db.organizations.get(id);
    if (!org || !logoDue(org, now)) continue;
    if (now.getTime() - Date.parse(tried[id] ?? '1970-01-01') < RETRY_MS) continue;
    tried[id] = now.toISOString();
    calls++;
    await opts.onCall?.();
    const r = await fetchCompany(org.linkedinCompanyId ?? org.linkedinSlug!);
    if (!r.ok) continue;
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
  return fixed;
}

const TRIED_KEY = 'enrich:logos:tried';
const RETRY_MS = 7 * 86_400_000;
