/**
 * An address for someone found outside the student's inbox, from the first source that has one:
 *   linkedin  a 1st-degree connection's contact email, the one they chose to show (Unipile profile, contact_info);
 *             tested on 20 real connections, 17 showed one
 *   finder    the cheaper finder whose key is set (plan 35 E6): Enrow (ENROW_API_KEY) first, else Icypeas
 *             (ICYPEAS_API_KEY); by name and company domain, with the LinkedIn URL when there is one
 *   hunter    Hunter's Email Finder by LinkedIn handle, else by name and company domain (1 credit when found), the
 *             fallback when the finder has nothing or no key is set. An answer whose LinkedIn profile is someone
 *             else's is dropped: at a big domain a name alone finds namesakes (tested at Berkeley, one professor's
 *             name returned a staff member's address)
 *   apollo    Apollo People Match by LinkedIn URL, else by name and company domain (1 credit)
 * Lookups run on demand (plan 35 C3, ondemand.ts): when the student adds the person or asks to email them, or for the
 * best three when a search asked for emails; never for a whole search. A company's pattern from Hunter's domain search
 * (1 credit per domain, cached) is used then too, and a search itself reads only the cached patterns (free).
 * The verifier (Reoon with REOON_API_KEY, else Hunter's) checks a built or guessed address before a send, never before.
 * Each paid answer, found or not, is kept 30 days in the shared research cache so a person is looked up once for
 * everyone (a LinkedIn contact email never is: only the student's connections may see it). Only an answer is kept:
 * a source that timed out, was over a cap, had no credits left or was switched off has not said "no address", so
 * nothing is cached and the caller is told the person could not be checked (`LookupNote.unchecked`);
 * every call goes through the per-user daily caps (budget.ts: 10 Hunter, Enrow or Icypeas credits, 10 Apollo matches,
 * 25 Reoon checks, 40 profile views) and Hunter's 40 credits a month for everyone. A credit call reserves its credit
 * before it goes out and settles after, so lookups running in parallel cannot pass a cap together; a miss is kept at
 * 0 credits as `<operation>:attempt`, so the ledger shows every call a provider saw (plan 34 A4). Nothing here sends
 * anything.
 */
import type { Apollo } from '../providers/apollo';
import type { Enrow } from '../providers/enrow';
import { deliverability, type Hunter } from '../providers/hunter';
import type { Icypeas } from '../providers/icypeas';
import { type Reoon, reoonDeliverability } from '../providers/reoon';
import { cleanLinkedInUrl, linkedInSlugOf, type UnipileResearch } from '../providers/unipileResearch';
import type { BudgetDep, BudgetProvider } from '../research/deps';
import type { SharedCache } from '../research/web';
import {
  type DomainTemplate,
  domainNamesOrg,
  type EmailLookup,
  isRoleAddress,
  isUniversity,
  type LookedUp,
  nameParts,
  type Verify,
} from './email';
import type { Candidate } from './search';
import { orgsOf, siteDomain } from './warmth';

export const LOOKUP_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * Dollars a credit, for the ledger: Enrow $17 and Icypeas $19 per 1,000 finds, Reoon $0.0012 a check (plan 35 E6).
 * Hunter and Apollo are plan credits, kept at $0 as before.
 */
export const CREDIT_USD = { enrow: 0.017, icypeas: 0.019, reoon: 0.0012 } as const;

export interface LookupDeps {
  userId: string;
  unipile?: UnipileResearch;
  unipileAccountId?: string;
  apollo?: Apollo;
  hunter?: Hunter;
  /** the cheaper finders tried before Hunter (plan 35 E6), whichever has a key: Enrow first */
  enrow?: Enrow;
  icypeas?: Icypeas;
  /** the verifier checked before a send, Hunter's without it */
  reoon?: Reoon;
  budget?: BudgetDep;
  cache: SharedCache;
  /** the domain a candidate's org is known by, for a match by name when they have no LinkedIn URL */
  domainOf?: (c: Candidate) => string | undefined;
}

type Cached = LookedUp | { none: true };

/** What the sources of one lookup ran into: `failed` when one could not be asked or did not answer. */
interface Trace {
  failed: boolean;
}

/** A credit reserved for one call; `settle` writes what it cost (0 for a miss, kept as an attempt). */
interface Slot {
  settle(units: number): Promise<void>;
}

/** Reserves `units` of a credit provider for one call; undefined when a cap says no. */
async function take(
  d: Pick<LookupDeps, 'userId' | 'budget'>,
  provider: BudgetProvider,
  operation: string,
  units: number,
  usdPerUnit = 0,
): Promise<Slot | undefined> {
  const b = d.budget;
  if (!b) return { settle: async () => undefined };
  const op = (u: number) => (u > 0 ? operation : `${operation}:attempt`);
  if (b.reserve) {
    const r = await b.reserve(d.userId, { provider, operation, units, costUsd: units * usdPerUnit });
    if (!r.ok) return undefined;
    return {
      settle: (u) => r.settle({ units: u, operation: op(u), costUsd: u * usdPerUnit }).catch(() => undefined),
    };
  }
  if (!(await b.check(d.userId, provider, units)).ok) return undefined;
  return {
    settle: (u) =>
      b
        .record(d.userId, { provider, operation: op(u), units: u, costUsd: u * usdPerUnit })
        .catch(() => undefined),
  };
}

/** The lookup, one candidate at a time; undefined when nothing verified could be found or nothing identifies them. */
export function emailLookup(d: LookupDeps): EmailLookup {
  return async (c, note) => {
    const slug = linkedInSlugOf(cleanLinkedInUrl(c.linkedinUrl));
    const n = c.lastNameObfuscated ? undefined : nameParts(c.name, c.firstName, c.lastName);
    const domain = d.domainOf?.(c);
    // a 1st-degree connection's own contact email is shown to their connections only: never cached for anyone else
    const li: Trace = { failed: false };
    const mine = await fromLinkedIn(d, c, slug, li);
    if (mine) return mine;
    const miss = (failed: boolean) => {
      if (note && (failed || li.failed)) note.unchecked = true;
      return undefined;
    };
    // the paid sources' answers are the same for everyone; the key names which were asked, so a key added later
    // asks again instead of reading an old miss
    const finder = d.enrow?.configured ? 'e' : d.icypeas?.configured ? 'i' : '';
    const asked = `${finder}${d.hunter?.configured ? 'h' : ''}${d.apollo?.configured ? 'a' : ''}`;
    if (!asked) return miss(false);
    const who = slug
      ? `li:${slug}`
      : c.memberId
        ? `mid:${c.memberId}`
        : n && domain
          ? `nd:${n.f}.${n.l}@${domain}`
          : n && orgsOf(c)[0]
            ? `nc:${n.f}.${n.l}@${orgsOf(c)[0]!.toLowerCase()}`
            : undefined;
    if (!who) return miss(false);
    const key = `email:${asked}:${who}`;
    const hit = (await d.cache.get(key).catch(() => undefined)) as Cached | undefined;
    // an answer kept before shared inboxes were refused is a miss too
    if (hit) return 'none' in hit || isRoleAddress(hit.email) ? miss(false) : hit;
    const paid: Trace = { failed: false };
    const found =
      (await fromFinder(d, c, n, domain, paid)) ??
      (await fromHunter(d, c, slug, n, domain, paid)) ??
      (await fromApollo(d, c, domain, paid));
    // "nobody found" is kept only when every source asked really answered: a miss cached after a timeout or a cap
    // would hide the person's address from everyone for 30 days
    if (found || !paid.failed)
      await d.cache.put(key, 'email_lookup', found ?? { none: true }, LOOKUP_TTL_MS).catch(() => undefined);
    return found ?? miss(paid.failed);
  };
}

/**
 * A 1st-degree connection's contact email on its own, for a caller that wants it before anything it would build
 * (ondemand.ts): the address the person chose to show beats a pattern or a guess.
 */
export function linkedInEmail(d: LookupDeps): EmailLookup {
  return async (c, note) => {
    const t: Trace = { failed: false };
    const mine = await fromLinkedIn(d, c, linkedInSlugOf(cleanLinkedInUrl(c.linkedinUrl)), t);
    if (!mine && t.failed && note) note.unchecked = true;
    return mine;
  };
}

/** A 1st-degree connection's contact email, as LinkedIn shows it to the student. */
async function fromLinkedIn(
  d: LookupDeps,
  c: Candidate,
  slug: string | undefined,
  t: Trace,
): Promise<LookedUp | undefined> {
  if (c.networkDistance !== 1 || !d.unipile?.configured || !d.unipileAccountId) return undefined;
  const id = c.memberId ?? slug;
  if (!id) return undefined;
  const fail = () => {
    t.failed = true;
    return undefined;
  };
  if (d.budget && !(await d.budget.check(d.userId, 'unipile_profile', 1)).ok) return fail();
  const r = await d.unipile.profile(d.unipileAccountId, id, { sections: [] });
  if (!r.ok) return fail();
  await d.budget?.record(d.userId, {
    provider: 'unipile_profile',
    operation: 'profile_view',
    units: 1,
    costUsd: 0,
  });
  // their own address, not a shared inbox a founder lists beside it
  const email = r.value.contact_info?.emails?.find(
    (e) => typeof e === 'string' && e.includes('@') && !isRoleAddress(e),
  );
  return email ? { email: email.trim().toLowerCase(), source: 'linkedin', status: 'verified' } : undefined;
}

/**
 * The cheaper finder whose key is set (plan 35 E6): Enrow, else Icypeas. Both search by name and company; an answer
 * they call valid (Enrow) or 99% sure (Icypeas) is verified, Icypeas's 95% "probable" a guess; anything less is
 * nothing, and Hunter is asked next.
 */
async function fromFinder(
  d: LookupDeps,
  c: Candidate,
  n: { f: string; l: string } | undefined,
  domain: string | undefined,
  t: Trace,
): Promise<LookedUp | undefined> {
  if (!n || !domain) return undefined;
  const fail = () => {
    t.failed = true;
    return undefined;
  };
  if (d.enrow?.configured) {
    const slot = await take(d, 'enrow', 'find', 1, CREDIT_USD.enrow);
    if (!slot) return fail();
    const r = await d.enrow.findEmail({
      fullname: `${n.f} ${n.l}`,
      domain,
      linkedinUrl: cleanLinkedInUrl(c.linkedinUrl) ?? undefined,
    });
    const email = r.ok ? r.value.email?.trim().toLowerCase() : undefined;
    const valid = r.ok && (r.value.qualification ?? '').toLowerCase() === 'valid';
    // one credit per address found; none for a miss
    await slot.settle(email?.includes('@') ? Math.max(1, r.ok ? (r.value.credits_used ?? 1) : 1) : 0);
    if (!r.ok) return fail();
    if (email?.includes('@') && valid && email.endsWith(`@${domain}`) && !isRoleAddress(email))
      return { email, source: 'enrow', status: 'verified' };
    return undefined;
  }
  if (d.icypeas?.configured) {
    const slot = await take(d, 'icypeas', 'find', 1, CREDIT_USD.icypeas);
    if (!slot) return fail();
    const r = await d.icypeas.findEmail({ firstname: n.f, lastname: n.l, domainOrCompany: domain });
    await slot.settle(r.ok && r.value.debited ? 1 : 0);
    if (!r.ok) return fail();
    if (!r.value.email?.includes('@') || isRoleAddress(r.value.email)) return undefined;
    const sure = /^(ultra_sure|very_sure)$/i.test(r.value.certainty ?? '');
    return { email: r.value.email, source: 'icypeas', status: sure ? 'verified' : 'guess' };
  }
  return undefined;
}

/** Hunter's Email Finder: by LinkedIn handle (the person themself), else by name and company domain. */
async function fromHunter(
  d: LookupDeps,
  c: Candidate,
  slug: string | undefined,
  n: { f: string; l: string } | undefined,
  domain: string | undefined,
  t: Trace,
): Promise<LookedUp | undefined> {
  if (!d.hunter?.configured) return undefined;
  const fail = () => {
    t.failed = true;
    return undefined;
  };
  const asks: { by: 'handle' | 'name'; params: Parameters<Hunter['findEmail']>[0] }[] = [];
  if (slug) asks.push({ by: 'handle', params: { linkedin_handle: slug } });
  if (n && domain) asks.push({ by: 'name', params: { first_name: n.f, last_name: n.l, domain } });
  // no domain known for their company: Hunter finds it from the company's name (most people LinkedIn finds)
  const company = !domain ? orgsOf(c)[0] : undefined;
  if (n && company) asks.push({ by: 'name', params: { first_name: n.f, last_name: n.l, company } });
  for (const ask of asks) {
    const slot = await take(d, 'hunter', 'find', 1);
    if (!slot) return fail();
    const r = await d.hunter.findEmail(ask.params);
    if (!r.ok) {
      await slot.settle(0);
      return fail();
    }
    const h = r.value.data;
    const email = h?.email?.trim().toLowerCase();
    // charged only when it finds one
    await slot.settle(h && email?.includes('@') ? 1 : 0);
    if (!h || !email?.includes('@') || isRoleAddress(email)) continue;
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

/**
 * The pattern a company uses, from Hunter's domain search; cached 30 days for everyone, misses too. One template per
 * run: several candidates at a new domain share one domain search instead of each asking while the first is in flight.
 */
export function domainTemplate(
  d: Pick<LookupDeps, 'userId' | 'hunter' | 'budget' | 'cache'>,
): DomainTemplate | undefined {
  const hunter = d.hunter;
  if (!hunter?.configured) return undefined;
  const asked = new Map<string, Promise<string | undefined>>();
  // the domains Hunter could not be asked about in this run (a cap, a timeout): not the same as having no pattern
  const failed = new Set<string>();
  const ask = async (domain: string): Promise<string | undefined> => {
    const key = `pattern:${domain}`;
    const hit = (await d.cache.get(key).catch(() => undefined)) as { t?: string; none?: true } | undefined;
    if (hit) return hit.t;
    const slot = await take(d, 'hunter', 'domain', 1);
    if (!slot) {
      failed.add(domain);
      return undefined;
    }
    const r = await hunter.domainPattern(domain);
    if (!r.ok) {
      await slot.settle(0);
      failed.add(domain);
      return undefined;
    }
    const t = r.value.data?.pattern ?? undefined;
    await slot.settle(t ? 1 : 0);
    await d.cache.put(key, 'email_pattern', t ? { t } : { none: true }, LOOKUP_TTL_MS).catch(() => undefined);
    return t;
  };
  return async (domain, note) => {
    const k = domain.toLowerCase();
    let p = asked.get(k);
    if (!p) {
      p = ask(k);
      asked.set(k, p);
    }
    const t = await p;
    if (!t && note && failed.has(k)) note.unchecked = true;
    return t;
  };
}

/**
 * Whether an address Orbit built or guessed is deliverable: Reoon (REOON_API_KEY, plan 35 E6), else Hunter's verifier;
 * cached 30 days for everyone. Run before a send (sending/send.ts), never during a search.
 */
export function emailVerifier(
  d: Pick<LookupDeps, 'userId' | 'hunter' | 'reoon' | 'budget' | 'cache'>,
): Verify | undefined {
  const { hunter, reoon } = d;
  if (!reoon?.configured && !hunter?.configured) return undefined;
  return async (email) => {
    const key = `verify:${email.toLowerCase()}`;
    const hit = (await d.cache.get(key).catch(() => undefined)) as
      | { v: 'valid' | 'invalid' | 'risky' }
      | undefined;
    if (hit?.v) return hit.v;
    let v: 'valid' | 'invalid' | 'risky' | undefined;
    if (reoon?.configured) {
      const slot = await take(d, 'reoon', 'verify', 1, CREDIT_USD.reoon);
      if (slot) {
        const r = await reoon.verifyEmail(email, 'power');
        await slot.settle(r.ok ? 1 : 0);
        if (r.ok) v = reoonDeliverability(r.value);
      }
    }
    if (!v && hunter?.configured) {
      const slot = await take(d, 'hunter', 'verify', 0.5);
      if (!slot) return undefined;
      const r = await hunter.verifyEmail(email);
      if (!r.ok) {
        await slot.settle(0);
        return undefined;
      }
      await slot.settle(0.5);
      v = deliverability(r.value.data?.status);
    }
    if (!v) return undefined;
    await d.cache.put(key, 'email_verify', { v }, LOOKUP_TTL_MS).catch(() => undefined);
    return v;
  };
}

/** The pattern a company uses when it is already in the shared cache: free, no call (plan 35 C3). */
export function cachedTemplate(cache: SharedCache): DomainTemplate {
  return async (domain) => {
    const hit = (await cache.get(`pattern:${domain.toLowerCase()}`).catch(() => undefined)) as
      | { t?: string }
      | undefined;
    return hit?.t;
  };
}

/** Apollo shows this in place of an address its plan has not unlocked: "email_not_unlocked@domain.com". */
const APOLLO_LOCKED = /not_unlocked|^email_not|@domain\.com$/;

/**
 * Apollo People Match: by LinkedIn URL, else by name and company domain. Verified only when Apollo says exactly
 * "verified" and the address is at the person's company (the domain Orbit knows for it, one named for it, or, when
 * Orbit knows no company for them, the one Apollo gives for their current job). Anything else it returns is a guess:
 * an old employer's address, or a status Apollo did not check.
 */
async function fromApollo(
  d: LookupDeps,
  c: Candidate,
  domain: string | undefined,
  t: Trace,
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
  const slot = await take(d, 'apollo_match', 'match', 1);
  if (!slot) {
    t.failed = true;
    return undefined;
  }
  const r = await d.apollo.matchPerson({ ...params, reveal_personal_emails: false });
  await slot.settle(r.ok ? 1 : 0);
  if (!r.ok) {
    t.failed = true;
    return undefined;
  }
  const p = r.value.person;
  const email = p?.email?.trim().toLowerCase();
  if (!email?.includes('@') || APOLLO_LOCKED.test(email) || isRoleAddress(email)) return undefined;
  const status = (p?.email_status ?? '').trim().toLowerCase();
  if (/unavailable|bounced|invalid/.test(status)) return undefined;
  const at = email.split('@')[1] ?? '';
  const orgs = [...(c.org ? [c.org] : []), ...orgsOf(c)];
  const apolloDomain = (
    p?.organization?.primary_domain ?? siteDomain(p?.organization?.website_url ?? undefined)
  )?.toLowerCase();
  const theirCompany =
    at === domain?.toLowerCase() ||
    orgs.some((o) => domainNamesOrg(at, o)) ||
    (!orgs.length && !domain && !!url && at === apolloDomain);
  return { email, source: 'apollo', status: status === 'verified' && theirCompany ? 'verified' : 'guess' };
}
