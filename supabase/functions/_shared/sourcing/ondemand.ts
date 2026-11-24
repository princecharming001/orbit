/**
 * Email lookups on demand (plan 35 C3). A search reads only what is free: an address written on a page, the pattern the
 * student's own mail teaches for the company, and a company pattern already in the shared cache. Everyone else comes
 * back with `emailStatus: 'not looked up'`, and the paid lookup (lookup.ts: LinkedIn contact email, then Enrow or
 * Icypeas, then Hunter, then Apollo, then a company pattern from Hunter's domain search) runs only:
 *   - when the student adds the person (addSourced in run.ts), for up to ADD_LOOKUPS of them at once
 *   - when the student asks to email someone Orbit has no address for (POST /source/email, and POST /drafts/compose
 *     for an email to a person with none)
 *   - for the best three by fit when the ask itself wanted emails ("with emails", or `withEmails: true`)
 * An address Orbit built or guessed is not checked here: the verifier runs once, before the first message goes to it
 * (sending/send.ts `checkBuiltAddress`). Nothing here sends anything.
 * A lookup that could not ask a source (a timeout, a cap, no credits) answers 'could not check', never 'not found',
 * and is not remembered as a miss. An address Orbit built or guessed, or one that failed the verifier, gives way to
 * a better one whenever it arrives (`keepEmail`, `keepRealEmail`).
 */
import { normalizeEmail } from '@orbit/core/text/normalize';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { cleanLinkedInUrl } from '../providers/unipileResearch';
import { sqlBudget } from '../research/bind.ts';
import { norm, normOrg } from '../research/guards';
import { sqlSharedCache } from '../research/web';
import type { Services } from '../services.ts';
import {
  dnsMx,
  domainPattern,
  type EmailConfidence,
  fromTemplate,
  isCompanyDomain,
  isRoleAddress,
  isUniversity,
  type KnownAddress,
  type LookupNote,
  nameParts,
  ownSiteDomain,
  PATTERNS,
} from './email';
import { cachedTemplate, domainTemplate, emailLookup, emailVerifier, linkedInEmail } from './lookup';
import type { Candidate } from './search';
import { orgsOf, siteDomain, workDomain } from './warmth';

/** People one add looks up at once; the rest can be looked up from their page later. */
export const ADD_LOOKUPS = 10;
/** The best-fitting people a search that asked for emails looks up. */
export const ASKED_LOOKUPS = 3;

/** An ask that wants addresses: "with emails", "and their email", "including contact info". */
const WITH_EMAILS =
  /\b(?:with|and|plus|including|incl\.?|get|find|need|want)\s+(?:their\s+|the\s+|work\s+)?(?:e-?mails?|e-?mail addresses|contact (?:info|details))\b/i;

export function asksForEmails(req: { withEmails?: boolean; query?: string }): boolean {
  return req.withEmails === true || WITH_EMAILS.test(req.query ?? '');
}

export interface FoundEmail {
  email: string;
  confidence: EmailConfidence;
}

/** The lookup pieces for one student, built from the services: paid lookup, paid and cached patterns, verifier. */
export function emailToolsFor(s: Services, userId: string, unipileAccountId?: string) {
  const budget = sqlBudget(s.db, s.now);
  const cache = sqlSharedCache(s.db, () => s.now().getTime());
  const deps = {
    userId,
    unipile: s.unipile,
    unipileAccountId,
    hunter: s.hunter,
    enrow: s.enrow,
    icypeas: s.icypeas,
    reoon: s.reoon,
    apollo: s.apollo,
    budget,
    cache,
  };
  return {
    cache,
    cached: cachedTemplate(cache),
    template: domainTemplate(deps),
    verify: emailVerifier(deps),
    lookup: (domainOf: (c: Candidate) => string | undefined) => emailLookup({ ...deps, domainOf }),
    linkedin: linkedInEmail(deps),
    mx: dnsMx(s.fetch),
  };
}

/**
 * The company domains to try for a candidate when the search's own map is gone: what the search kept on the
 * candidate, their work address, the domain the student's contacts at the company use (when it is the company's:
 * `isCompanyDomain`), the company facts Orbit holds, and their page when it is their company's own site.
 */
export async function domainsFor(db: Db, userId: string, c: Candidate): Promise<string[]> {
  const out: string[] = [];
  const add = (d: string | undefined | null) => {
    const k = d?.toLowerCase();
    if (k && !out.includes(k)) out.push(k);
  };
  // the page they were found on is their company's own site only when its address names the company (a product or
  // news page about them is someone else's site: guessing their address there finds a stranger's). A row a search
  // stored before that rule may still carry the page's domain: it is left out here
  const page = siteDomain(c.url);
  const own = ownSiteDomain(c);
  for (const d of c.domains ?? []) if (d.toLowerCase() !== page || own) add(d);
  add(workDomain(c.email));
  const orgs = orgsOf(c);
  if (orgs.length) {
    const names = orgs.map((o) => norm(o));
    const keys = [...new Set([...names, ...orgs.map((o) => normOrg(o))])].filter((k) => k.length >= 2);
    const [rows, facts] = await Promise.all([
      // only addresses that are evidence: one Orbit built at a domain says nothing about whose domain it is
      db.sql<{ email: string }>`
        select primary_email as email from orbit.people
         where user_id = ${userId}::uuid and primary_email is not null and deleted_at is null and not is_self
           and (email_confidence is null or email_confidence in ('verified', 'page'))
           and lower(org_raw) = any(${orgs.map((o) => o.toLowerCase())}::text[])
         limit 200`,
      db.sql<{ website: string }>`
        select website from orbit_private.company_facts
         where website is not null and not coalesce(ambiguous_name, false) and key = any(${keys}::text[])
         order by (source = 'linkedin') desc limit 3`,
    ]);
    const known = new Set(facts.map((f) => siteDomain(f.website)).filter((d): d is string => !!d));
    const tally = new Map<string, number>();
    for (const r of rows) {
      const d = workDomain(r.email);
      if (d) tally.set(d, (tally.get(d) ?? 0) + 1);
    }
    // a contact's own domain (a personal site, their university) is not their employer's
    for (const [d, count] of [...tally].sort((a, b) => b[1] - a[1]))
      if (orgs.some((o) => isCompanyDomain(d, o, { count, facts: known }))) add(d);
    for (const d of known) add(d);
  }
  add(own);
  return out.slice(0, 4);
}

/**
 * The student's people with an address at one of these domains: what their own mail teaches about the pattern. Only
 * addresses from their mail and contacts, verified ones and ones written on a page count; an address Orbit built or
 * guessed earlier would otherwise confirm the pattern it was built from.
 */
async function knownAt(db: Db, userId: string, domains: string[]): Promise<KnownAddress[]> {
  if (!domains.length) return [];
  const rows = await db.sql<{ name: string; email: string }>`
    select display_name as name, primary_email as email from orbit.people
     where user_id = ${userId}::uuid and primary_email is not null and deleted_at is null and not is_self
       and (email_confidence is null or email_confidence in ('verified', 'page'))
       and lower(split_part(primary_email, '@', 2)) = any(${domains}::text[])
     limit 500`;
  return rows;
}

/**
 * An address for one candidate, best and cheapest first: one they already have; unless `freeOnly`, a 1st-degree
 * connection's own contact email on LinkedIn (the address they chose to show beats anything built); the pattern the
 * student's mail teaches or a cached company pattern (free); then, unless `freeOnly`, the paid lookup and Hunter's
 * domain search. Undefined when nothing was found; `note.unchecked` is then set when a source could not be asked,
 * so the caller can say "could not check" instead of "not found". `avoid` is an address already known to be wrong
 * for them: it is never returned again. Never verifies.
 */
export async function findEmailFor(
  s: Services,
  userId: string,
  c: Candidate,
  opts: {
    tools?: ReturnType<typeof emailToolsFor>;
    domains?: string[];
    freeOnly?: boolean;
    note?: LookupNote;
    avoid?: string;
  } = {},
): Promise<FoundEmail | undefined> {
  if (c.email && !isRoleAddress(c.email)) return { email: c.email, confidence: c.emailConfidence ?? 'page' };
  if (c.entity !== 'person') return undefined;
  const tools = opts.tools ?? emailToolsFor(s, userId);
  const note = opts.note ?? {};
  const avoid = opts.avoid?.trim().toLowerCase();
  const failed = () => {
    note.unchecked = true;
    return undefined;
  };
  const connection = !opts.freeOnly && c.networkDistance === 1;
  if (connection) {
    const mine = await tools.linkedin(c, note).catch(failed);
    if (mine && mine.email !== avoid) return { email: mine.email, confidence: 'verified' };
  }
  const domains = opts.domains ?? (await domainsFor(s.db, userId, c));
  const n = c.lastNameObfuscated ? undefined : nameParts(c.name, c.firstName, c.lastName);
  if (n) {
    const known = await knownAt(s.db, userId, domains);
    for (const d of domains) {
      const p = domainPattern(known, d);
      const built = p ? `${PATTERNS[p.pattern]!(n.f, n.l)}@${d}` : undefined;
      if (p && built && built !== avoid) return { email: built, confidence: p.sure ? 'pattern' : 'guess' };
      if (isUniversity(d)) continue;
      const t = await tools.cached(d).catch(() => undefined);
      const local = t ? fromTemplate(t, n.f, n.l) : undefined;
      if (local && `${local}@${d}` !== avoid) return { email: `${local}@${d}`, confidence: 'pattern' };
    }
  }
  if (opts.freeOnly) return undefined;
  // LinkedIn was asked above: the lookup goes straight to the paid sources instead of viewing the profile again
  const looked = await tools
    .lookup(() => domains[0])(connection ? { ...c, networkDistance: undefined } : c, note)
    .catch(failed);
  if (looked && looked.email !== avoid)
    return { email: looked.email, confidence: looked.status === 'verified' ? 'verified' : 'guess' };
  if (!n || !tools.template) return undefined;
  for (const d of domains) {
    if (isUniversity(d) || !(await tools.mx(d))) continue;
    const t = await tools.template(d, note).catch(failed);
    const local = t ? fromTemplate(t, n.f, n.l) : undefined;
    if (local && `${local}@${d}` !== avoid) return { email: `${local}@${d}`, confidence: 'pattern' };
  }
  return undefined;
}

/**
 * Keeps an address on the person when they have none, with how it was found (send.ts checks a built one first).
 * `fresh`: the person was made from this candidate just now, so the address they were made with is this one.
 * An address already there gives way in two cases only, so a wrong one is never a dead end: one that failed the
 * verifier is replaced by any other address, and one Orbit built or guessed by a verified one or one read on a page.
 * An address from the student's own mail or contacts (no confidence kept) is never touched.
 */
export async function keepEmail(
  db: Db,
  userId: string,
  personId: string,
  found: FoundEmail,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const email = normalizeEmail(found.email);
  const better = found.confidence === 'verified' || found.confidence === 'page';
  await db.sql`
    update orbit.people p set
           primary_email = case when p.email_confidence in ('pattern', 'guess', 'invalid') then ${email}
                                else coalesce(p.primary_email, ${email}) end,
           email_confidence = ${found.confidence},
           email_checked_at = case when lower(p.primary_email) = ${email} then p.email_checked_at end
     where p.id = ${personId}::uuid and p.user_id = ${userId}::uuid
       and (p.primary_email is null
            or (${opts.fresh === true}::boolean and lower(p.primary_email) = ${email} and p.email_confidence is null)
            or (p.email_confidence = 'invalid' and lower(p.primary_email) <> ${email})
            or (p.email_confidence in ('pattern', 'guess') and ${better}::boolean))`;
}

/**
 * An address that came from the person or the student themself (the student typed it, the person wrote from it)
 * takes the place of one Orbit built, guessed or found invalid, and nothing is left saying it is unconfirmed. It
 * fills an empty address too. An address from the student's own mail or contacts, a verified one or one read on a
 * page stays as it is. True when the person's address is now this one.
 */
export async function keepRealEmail(
  db: Db,
  userId: string,
  personId: string,
  address: string,
): Promise<boolean> {
  const email = normalizeEmail(address);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const rows = await db.sql`
    update orbit.people set primary_email = ${email}, email_confidence = null, email_checked_at = null
     where id = ${personId}::uuid and user_id = ${userId}::uuid and deleted_at is null and not is_self
       and (primary_email is null or email_confidence in ('pattern', 'guess', 'invalid'))
    returning id`;
  return rows.length > 0;
}

export interface EmailLookupResponse {
  email?: string;
  emailConfidence?: EmailConfidence;
  /**
   * found now or before; looked up and not found; or 'could not check' when a source could not be asked just now
   * (a timeout, a daily cap, no credits), which is not remembered as a miss
   */
  emailStatus: 'found' | 'not found' | 'could not check';
}

/**
 * The longest POST /source/email works before it answers: under the 25 s the browser waits for any reply
 * (apps/web orbitApi.ts REQUEST_TIMEOUT_MS), so a slow provider gives "could not check" instead of a failed request.
 */
export const EMAIL_LOOKUP_DEADLINE_MS = 20_000;

/**
 * A lookup's answer, or 'could not check' when it has not come within `ms`. The lookup itself is left to finish:
 * an address it finds late is still kept on the person, and the next ask reads it.
 */
export function lookupWithin(
  work: Promise<EmailLookupResponse>,
  ms = EMAIL_LOOKUP_DEADLINE_MS,
): Promise<EmailLookupResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<EmailLookupResponse>((resolve) => {
    timer = setTimeout(() => resolve({ emailStatus: 'could not check' }), ms);
  });
  // a failure after the deadline has nobody waiting for it
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** POST /source/email for a recommendation: the lookup for one sourced person, kept on the row (and the person). */
export async function lookupRecommendationEmail(
  s: Services,
  userId: string,
  recommendationId: string,
): Promise<EmailLookupResponse> {
  const db = s.db;
  const [rec] = await db.sql<{ id: string; person_id: string | null; candidate: Candidate }>`
    select id, person_id, candidate from orbit.recommendations
     where id = ${recommendationId}::uuid and user_id = ${userId}::uuid`;
  if (!rec) throw new HttpError(404, 'not_found', 'no such recommendation');
  const c = rec.candidate;
  const note: LookupNote = {};
  const found = await findEmailFor(s, userId, c, {
    tools: emailToolsFor(s, userId, await linkedinAccount(db, userId)),
    note,
  });
  // nothing found because a source could not be asked: the row stays "not looked up", so the next ask tries again
  if (!found && note.unchecked) return { emailStatus: 'could not check' };
  const next: Candidate = found
    ? { ...c, email: found.email, emailConfidence: found.confidence, emailLookedUp: true }
    : { ...c, emailLookedUp: true };
  await db.sql`update orbit.recommendations set candidate = ${next}::jsonb where id = ${rec.id}::uuid`;
  if (found && rec.person_id) await keepEmail(db, userId, rec.person_id, found);
  return found
    ? { email: found.email, emailConfidence: found.confidence, emailStatus: 'found' }
    : { emailStatus: 'not found' };
}

/**
 * POST /source/email for a person (and the compose route, for an email to someone with no address): the lookup from
 * what Orbit knows of them, kept on the person.
 */
export async function lookupPersonEmail(
  s: Services,
  userId: string,
  personId: string,
): Promise<EmailLookupResponse> {
  const db = s.db;
  const [p] = await db.sql<{
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    primary_email: string | null;
    email_confidence: string | null;
    org_raw: string | null;
    title: string | null;
    headline: string | null;
    linkedin_slug: string | null;
    linkedin_member_id: string | null;
    linkedin_connected_on: Date | string | null;
    do_not_contact: boolean | null;
  }>`
    select display_name, first_name, last_name, primary_email, email_confidence, org_raw, title, headline,
           linkedin_slug, linkedin_member_id, linkedin_connected_on, do_not_contact
      from orbit.people
     where id = ${personId}::uuid and user_id = ${userId}::uuid and deleted_at is null and not is_self`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
  // an address that failed the verifier is not an answer: the lookup runs again for a different one
  const failed = p.email_confidence === 'invalid' ? p.primary_email : null;
  if (p.primary_email && !failed)
    return {
      email: p.primary_email,
      ...(p.email_confidence ? { emailConfidence: p.email_confidence as EmailConfidence } : {}),
      emailStatus: 'found',
    };
  if (p.do_not_contact) throw new HttpError(409, 'do_not_contact', 'they asked not to be contacted');
  const c: Candidate = {
    key: `person:${personId}`,
    entity: 'person',
    name: p.display_name,
    ...(p.first_name ? { firstName: p.first_name } : {}),
    ...(p.last_name ? { lastName: p.last_name } : {}),
    ...(p.org_raw ? { org: p.org_raw } : {}),
    ...(p.title ? { title: p.title } : {}),
    ...(p.headline ? { headline: p.headline } : {}),
    ...(p.linkedin_slug
      ? { linkedinUrl: cleanLinkedInUrl(`https://www.linkedin.com/in/${p.linkedin_slug}`) }
      : {}),
    ...(p.linkedin_member_id ? { memberId: p.linkedin_member_id } : {}),
    // a connection of the student's: LinkedIn shows them the contact email this person chose to share
    ...(p.linkedin_connected_on ? { networkDistance: 1 } : {}),
    sources: [],
    externalIds: {},
  };
  const note: LookupNote = {};
  const found = await findEmailFor(s, userId, c, {
    tools: emailToolsFor(s, userId, await linkedinAccount(db, userId)),
    note,
    ...(failed ? { avoid: failed } : {}),
  });
  if (!found) return { emailStatus: note.unchecked ? 'could not check' : 'not found' };
  await keepEmail(db, userId, personId, found);
  return { email: found.email, emailConfidence: found.confidence, emailStatus: 'found' };
}

async function linkedinAccount(db: Db, userId: string): Promise<string | undefined> {
  const [a] = await db.sql<{ external_account_id: string | null }>`
    select external_account_id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin' and status = 'active'`;
  return a?.external_account_id ?? undefined;
}

/** Confidences whose address Orbit built or guessed: checked with the verifier before the first message goes. */
const UNCHECKED = new Set(['pattern', 'guess']);

/**
 * Before a send to a sourced person's address (send.ts): an address Orbit built from a pattern or a finder's guess is
 * checked once with the verifier (Reoon, else Hunter; plan 35 C3 and E6). Invalid holds the message; valid marks it
 * verified. A server that takes any address, a verifier that could not say, or no verifier at all does not hold the
 * message, but the answer is 'unconfirmed', never 'ok': the address is still a guess, and the caller can say so. An
 * address that already failed holds every message to it.
 */
export async function checkBuiltAddress(
  s: Services,
  userId: string,
  person: { id: string; email: string; confidence: string | null; checkedAt: Date | string | null },
): Promise<'ok' | 'unconfirmed' | 'invalid'> {
  if (person.confidence === 'invalid') return 'invalid';
  if (!person.confidence || !UNCHECKED.has(person.confidence)) return 'ok';
  // checked before and still built or guessed: the verifier could not confirm it then either
  if (person.checkedAt) return 'unconfirmed';
  const verify = emailToolsFor(s, userId).verify;
  const v = verify ? await verify(person.email).catch(() => undefined) : undefined;
  if (!v) return 'unconfirmed';
  const next = v === 'valid' ? 'verified' : v === 'invalid' ? 'invalid' : person.confidence;
  await s.db.sql`
    update orbit.people set email_confidence = ${next}, email_checked_at = ${s.now()}::timestamptz
     where id = ${person.id}::uuid and user_id = ${userId}::uuid`;
  return v === 'valid' ? 'ok' : v === 'invalid' ? 'invalid' : 'unconfirmed';
}
