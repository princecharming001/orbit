/**
 * A verified address for someone found on LinkedIn, from the two sources Orbit already pays for, in order:
 *   linkedin  a 1st-degree connection's contact email, the one they chose to show (Unipile profile, contact_info)
 *   apollo    Apollo People Match by LinkedIn URL, else by name and company domain (1 credit; its status says
 *             whether the address is verified or extrapolated)
 * Each answer, found or not, is kept 30 days in the shared research cache so a person is looked up once for everyone;
 * every call goes through the per-user daily caps (budget.ts: 10 Apollo matches, 40 profile views). Nothing here
 * sends anything.
 */
import type { Apollo } from '../providers/apollo';
import { cleanLinkedInUrl, linkedInSlugOf, type UnipileResearch } from '../providers/unipileResearch';
import type { BudgetDep } from '../research/deps';
import type { SharedCache } from '../research/web';
import { type EmailLookup, type LookedUp, nameParts } from './email';
import type { Candidate } from './search';

export const LOOKUP_TTL_MS = 30 * 24 * 3600 * 1000;

export interface LookupDeps {
  userId: string;
  unipile?: UnipileResearch;
  unipileAccountId?: string;
  apollo?: Apollo;
  budget?: BudgetDep;
  cache: SharedCache;
  /** the domain a candidate's org is known by, for a match by name when they have no LinkedIn URL */
  domainOf?: (c: Candidate) => string | undefined;
}

type Cached = LookedUp | { none: true };

/** The lookup, one candidate at a time; undefined when nothing verified could be found or nothing identifies them. */
export function emailLookup(d: LookupDeps): EmailLookup {
  return async (c) => {
    const slug = linkedInSlugOf(cleanLinkedInUrl(c.linkedinUrl));
    const n = c.lastNameObfuscated ? undefined : nameParts(c.name, c.firstName, c.lastName);
    const domain = d.domainOf?.(c);
    const key = slug
      ? `email:li:${slug}`
      : c.memberId
        ? `email:mid:${c.memberId}`
        : n && domain
          ? `email:nd:${n.f}.${n.l}@${domain}`
          : undefined;
    if (!key) return undefined;
    const hit = (await d.cache.get(key).catch(() => undefined)) as Cached | undefined;
    if (hit) return 'none' in hit ? undefined : hit;
    const found = (await fromLinkedIn(d, c, slug)) ?? (await fromApollo(d, c, domain));
    await d.cache.put(key, 'email_lookup', found ?? { none: true }, LOOKUP_TTL_MS).catch(() => undefined);
    return found;
  };
}

/** A 1st-degree connection's contact email, as LinkedIn shows it to the student. */
async function fromLinkedIn(
  d: LookupDeps,
  c: Candidate,
  slug: string | undefined,
): Promise<LookedUp | undefined> {
  if (c.networkDistance !== 1 || !d.unipile?.configured || !d.unipileAccountId) return undefined;
  const id = c.memberId ?? slug;
  if (!id) return undefined;
  if (d.budget && !(await d.budget.check(d.userId, 'unipile_profile', 1)).ok) return undefined;
  const r = await d.unipile.profile(d.unipileAccountId, id, { sections: [] });
  if (!r.ok) return undefined;
  await d.budget?.record(d.userId, {
    provider: 'unipile_profile',
    operation: 'profile_view',
    units: 1,
    costUsd: 0,
  });
  const email = r.value.contact_info?.emails?.find((e) => typeof e === 'string' && e.includes('@'));
  return email ? { email: email.trim().toLowerCase(), source: 'linkedin', status: 'verified' } : undefined;
}

/** Apollo People Match: by LinkedIn URL, else by name and company domain. */
async function fromApollo(
  d: LookupDeps,
  c: Candidate,
  domain: string | undefined,
): Promise<LookedUp | undefined> {
  if (!d.apollo?.configured) return undefined;
  const url = cleanLinkedInUrl(c.linkedinUrl);
  const [first = '', ...rest] = c.name.trim().split(/\s+/);
  const firstName = c.firstName ?? first;
  const lastName = c.lastName ?? rest.join(' ');
  const params = url
    ? { linkedin_url: url }
    : firstName && lastName && domain && !c.lastNameObfuscated
      ? { first_name: firstName, last_name: lastName, domain }
      : undefined;
  if (!params) return undefined;
  if (d.budget && !(await d.budget.check(d.userId, 'apollo_match', 1)).ok) return undefined;
  const r = await d.apollo.matchPerson({ ...params, reveal_personal_emails: false });
  if (!r.ok) return undefined;
  await d.budget?.record(d.userId, { provider: 'apollo_match', operation: 'match', units: 1, costUsd: 0 });
  const p = r.value.person;
  const email = p?.email?.trim().toLowerCase();
  if (!email?.includes('@')) return undefined;
  const status = (p?.email_status ?? '').toLowerCase();
  if (/unavailable|bounced|invalid/.test(status)) return undefined;
  return { email, source: 'apollo', status: /guess|extrapolat/.test(status) ? 'guess' : 'verified' };
}
