/**
 * An address for someone found outside the student's inbox, from the first source that has one:
 *   linkedin  a 1st-degree connection's contact email, the one they chose to show (Unipile profile, contact_info);
 *             tested on 20 real connections, 17 showed one
 *   hunter    Hunter's Email Finder by LinkedIn handle, else by name and company domain (1 credit when found). An
 *             answer whose LinkedIn profile is someone else's is dropped: at a big domain a name alone finds
 *             namesakes (tested at Berkeley, one professor's name returned a staff member's address)
 *   apollo    Apollo People Match by LinkedIn URL, else by name and company domain (1 credit)
 * Also what fillEmails uses for everyone past the lookups: a company's pattern from Hunter's domain search (1 credit
 * per domain, cached) and the verifier for the addresses it builds (half a credit).
 * Each paid answer, found or not, is kept 30 days in the shared research cache so a person is looked up once for
 * everyone (a LinkedIn contact email never is: only the student's connections may see it);
 * every call goes through the per-user daily caps (budget.ts: 10 Hunter credits, 10 Apollo matches, 40 profile
 * views). Nothing here sends anything.
 */
import type { Apollo } from '../providers/apollo';
import { deliverability, type Hunter } from '../providers/hunter';
import { cleanLinkedInUrl, linkedInSlugOf, type UnipileResearch } from '../providers/unipileResearch';
import type { BudgetDep } from '../research/deps';
import type { SharedCache } from '../research/web';
import {
  type DomainTemplate,
  type EmailLookup,
  isUniversity,
  type LookedUp,
  nameParts,
  type Verify,
} from './email';
import type { Candidate } from './search';

export const LOOKUP_TTL_MS = 30 * 24 * 3600 * 1000;

export interface LookupDeps {
  userId: string;
  unipile?: UnipileResearch;
  unipileAccountId?: string;
  apollo?: Apollo;
  hunter?: Hunter;
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
    // a 1st-degree connection's own contact email is shown to their connections only: never cached for anyone else
    const mine = await fromLinkedIn(d, c, slug);
    if (mine) return mine;
    // the paid sources' answers are the same for everyone; the key names which were asked, so a key added later
    // asks again instead of reading an old miss
    const asked = `${d.hunter?.configured ? 'h' : ''}${d.apollo?.configured ? 'a' : ''}`;
    if (!asked) return undefined;
    const who = slug
      ? `li:${slug}`
      : c.memberId
        ? `mid:${c.memberId}`
        : n && domain
          ? `nd:${n.f}.${n.l}@${domain}`
          : undefined;
    if (!who) return undefined;
    const key = `email:${asked}:${who}`;
    const hit = (await d.cache.get(key).catch(() => undefined)) as Cached | undefined;
    if (hit) return 'none' in hit ? undefined : hit;
    const found = (await fromHunter(d, c, slug, n, domain)) ?? (await fromApollo(d, c, domain));
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

/** Hunter's Email Finder: by LinkedIn handle (the person themself), else by name and company domain. */
async function fromHunter(
  d: LookupDeps,
  c: Candidate,
  slug: string | undefined,
  n: { f: string; l: string } | undefined,
  domain: string | undefined,
): Promise<LookedUp | undefined> {
  if (!d.hunter?.configured) return undefined;
  const asks: { by: 'handle' | 'name'; params: Parameters<Hunter['findEmail']>[0] }[] = [];
  if (slug) asks.push({ by: 'handle', params: { linkedin_handle: slug } });
  if (n && domain) asks.push({ by: 'name', params: { first_name: n.f, last_name: n.l, domain } });
  for (const ask of asks) {
    if (d.budget && !(await d.budget.check(d.userId, 'hunter', 1)).ok) return undefined;
    const r = await d.hunter.findEmail(ask.params);
    if (!r.ok) return undefined;
    const h = r.value.data;
    const email = h?.email?.trim().toLowerCase();
    if (!h || !email?.includes('@')) continue;
    // charged only when it finds one
    await d.budget?.record(d.userId, { provider: 'hunter', operation: 'find', units: 1, costUsd: 0 });
    // their LinkedIn profile is someone else's: a namesake
    const theirs = linkedInSlugOf(cleanLinkedInUrl(h.linkedin_url));
    if (slug && theirs && theirs !== slug) continue;
    const v = deliverability(h.verification?.status);
    if (v === 'invalid') continue;
    const atUniversity = isUniversity(email.split('@')[1] ?? '');
    // a professor's name matched to staff with the same name (seen live: "Event Specialist" for a professor)
    if (ask.by === 'name' && atUniversity && notTheirRole(c, h.position)) continue;
    const onPage = (h.sources ?? []).some((x) => x.still_on_page);
    // at a server that takes any address and with no page showing it, "valid" proves nothing (seen live: Hunter
    // answered first.last for someone whose address is their first name)
    const proven = onPage || (v === 'valid' && !h.accept_all);
    // by name at a university, only a matching LinkedIn profile shows it is the same person
    const samePerson = ask.by === 'handle' || (!!slug && theirs === slug) || !atUniversity;
    if (samePerson && proven) return { email, source: 'hunter', status: 'verified' };
    if ((h.score ?? 0) >= 70) return { email, source: 'hunter', status: 'guess' };
  }
  return undefined;
}

const ACADEMIC = /\b(prof|professor|faculty|lecturer|instructor|chair|dean|postdoc)/i;
const ACADEMIC_ROLE =
  /prof|faculty|lectur|research|scien|chair|dean|director|postdoc|ph\.?d|fellow|instruct|teach|assistant|associate|advis|emerit|engineer|head/i;

/** The candidate teaches and the address belongs to someone in a job that is not teaching or research. */
function notTheirRole(c: Candidate, position: string | null | undefined): boolean {
  if (!position) return false;
  if (!ACADEMIC.test([c.title, c.headline].filter(Boolean).join(' '))) return false;
  return !ACADEMIC_ROLE.test(position);
}

/** The pattern a company uses, from Hunter's domain search; cached 30 days for everyone, misses too. */
export function domainTemplate(
  d: Pick<LookupDeps, 'userId' | 'hunter' | 'budget' | 'cache'>,
): DomainTemplate | undefined {
  const hunter = d.hunter;
  if (!hunter?.configured) return undefined;
  return async (domain) => {
    const key = `pattern:${domain.toLowerCase()}`;
    const hit = (await d.cache.get(key).catch(() => undefined)) as { t?: string; none?: true } | undefined;
    if (hit) return hit.t;
    if (d.budget && !(await d.budget.check(d.userId, 'hunter', 1)).ok) return undefined;
    const r = await hunter.domainPattern(domain);
    if (!r.ok) return undefined;
    const t = r.value.data?.pattern ?? undefined;
    if (t)
      await d.budget?.record(d.userId, { provider: 'hunter', operation: 'domain', units: 1, costUsd: 0 });
    await d.cache.put(key, 'email_pattern', t ? { t } : { none: true }, LOOKUP_TTL_MS).catch(() => undefined);
    return t;
  };
}

/** Whether an address Orbit built is deliverable, by Hunter's verifier; cached 30 days for everyone. */
export function emailVerifier(
  d: Pick<LookupDeps, 'userId' | 'hunter' | 'budget' | 'cache'>,
): Verify | undefined {
  const hunter = d.hunter;
  if (!hunter?.configured) return undefined;
  return async (email) => {
    const key = `verify:${email.toLowerCase()}`;
    const hit = (await d.cache.get(key).catch(() => undefined)) as
      | { v: 'valid' | 'invalid' | 'risky' }
      | undefined;
    if (hit?.v) return hit.v;
    if (d.budget && !(await d.budget.check(d.userId, 'hunter', 0.5)).ok) return undefined;
    const r = await hunter.verifyEmail(email);
    if (!r.ok) return undefined;
    await d.budget?.record(d.userId, { provider: 'hunter', operation: 'verify', units: 0.5, costUsd: 0 });
    const v = deliverability(r.value.data?.status);
    await d.cache.put(key, 'email_verify', { v }, LOOKUP_TTL_MS).catch(() => undefined);
    return v;
  };
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
