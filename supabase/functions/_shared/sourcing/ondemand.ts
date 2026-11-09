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
  isUniversity,
  type KnownAddress,
  nameParts,
  PATTERNS,
} from './email';
import { cachedTemplate, domainTemplate, emailLookup, emailVerifier } from './lookup';
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
    mx: dnsMx(s.fetch),
  };
}

/**
 * The company domains to try for a candidate when the search's own map is gone: what the search kept on the
 * candidate, their work address, the domain most of the student's contacts at the company use, the company facts
 * Orbit holds, and their page.
 */
export async function domainsFor(db: Db, userId: string, c: Candidate): Promise<string[]> {
  const out: string[] = [];
  const add = (d: string | undefined | null) => {
    const k = d?.toLowerCase();
    if (k && !out.includes(k)) out.push(k);
  };
  for (const d of c.domains ?? []) add(d);
  add(workDomain(c.email));
  const orgs = orgsOf(c);
  if (orgs.length) {
    const names = orgs.map((o) => norm(o));
    const rows = await db.sql<{ email: string }>`
      select primary_email as email from orbit.people
       where user_id = ${userId}::uuid and primary_email is not null and deleted_at is null and not is_self
         and lower(org_raw) = any(${orgs.map((o) => o.toLowerCase())}::text[])
       limit 200`;
    const tally = new Map<string, number>();
    for (const r of rows) {
      const d = workDomain(r.email);
      if (d) tally.set(d, (tally.get(d) ?? 0) + 1);
    }
    for (const [d] of [...tally].sort((a, b) => b[1] - a[1])) add(d);
    const keys = [...new Set([...names, ...orgs.map((o) => normOrg(o))])].filter((k) => k.length >= 2);
    const facts = await db.sql<{ website: string }>`
      select website from orbit_private.company_facts
       where website is not null and not coalesce(ambiguous_name, false) and key = any(${keys}::text[])
       order by (source = 'linkedin') desc limit 3`;
    for (const f of facts) add(siteDomain(f.website));
  }
  add(siteDomain(c.url));
  return out.slice(0, 4);
}

/** The student's people with an address at one of these domains: what their own mail teaches about the pattern. */
async function knownAt(db: Db, userId: string, domains: string[]): Promise<KnownAddress[]> {
  if (!domains.length) return [];
  const rows = await db.sql<{ name: string; email: string }>`
    select display_name as name, primary_email as email from orbit.people
     where user_id = ${userId}::uuid and primary_email is not null and deleted_at is null and not is_self
       and lower(split_part(primary_email, '@', 2)) = any(${domains}::text[])
     limit 500`;
  return rows;
}

/**
 * An address for one candidate, cheapest first: one they already have; the pattern the student's mail teaches or a
 * cached company pattern (free); then, unless `freeOnly`, the paid lookup and Hunter's domain search. Undefined when
 * nothing was found. Never verifies.
 */
export async function findEmailFor(
  s: Services,
  userId: string,
  c: Candidate,
  opts: { tools?: ReturnType<typeof emailToolsFor>; domains?: string[]; freeOnly?: boolean } = {},
): Promise<FoundEmail | undefined> {
  if (c.email) return { email: c.email, confidence: c.emailConfidence ?? 'page' };
  if (c.entity !== 'person') return undefined;
  const tools = opts.tools ?? emailToolsFor(s, userId);
  const domains = opts.domains ?? (await domainsFor(s.db, userId, c));
  const n = c.lastNameObfuscated ? undefined : nameParts(c.name, c.firstName, c.lastName);
  if (n) {
    const known = await knownAt(s.db, userId, domains);
    for (const d of domains) {
      const p = domainPattern(known, d);
      if (p)
        return { email: `${PATTERNS[p.pattern]!(n.f, n.l)}@${d}`, confidence: p.sure ? 'pattern' : 'guess' };
      if (isUniversity(d)) continue;
      const t = await tools.cached(d).catch(() => undefined);
      const local = t ? fromTemplate(t, n.f, n.l) : undefined;
      if (local) return { email: `${local}@${d}`, confidence: 'pattern' };
    }
  }
  if (opts.freeOnly) return undefined;
  const looked = await tools
    .lookup(() => domains[0])(c)
    .catch(() => undefined);
  if (looked) return { email: looked.email, confidence: looked.status === 'verified' ? 'verified' : 'guess' };
  if (!n || !tools.template) return undefined;
  for (const d of domains) {
    if (isUniversity(d) || !(await tools.mx(d))) continue;
    const t = await tools.template(d).catch(() => undefined);
    const local = t ? fromTemplate(t, n.f, n.l) : undefined;
    if (local) return { email: `${local}@${d}`, confidence: 'pattern' };
  }
  return undefined;
}

/**
 * Keeps an address on the person when they have none, with how it was found (send.ts checks a built one first).
 * `fresh`: the person was made from this candidate just now, so the address they were made with is this one.
 */
export async function keepEmail(
  db: Db,
  userId: string,
  personId: string,
  found: FoundEmail,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const email = normalizeEmail(found.email);
  await db.sql`
    update orbit.people set primary_email = coalesce(primary_email, ${email}), email_confidence = ${found.confidence}
     where id = ${personId}::uuid and user_id = ${userId}::uuid
       and (primary_email is null
            or (${opts.fresh === true}::boolean and lower(primary_email) = ${email} and email_confidence is null))`;
}

export interface EmailLookupResponse {
  email?: string;
  emailConfidence?: EmailConfidence;
  /** found now or before, or looked up and not found */
  emailStatus: 'found' | 'not found';
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
  const found = await findEmailFor(s, userId, c, {
    tools: emailToolsFor(s, userId, await linkedinAccount(db, userId)),
  });
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
    do_not_contact: boolean | null;
  }>`
    select display_name, first_name, last_name, primary_email, email_confidence, org_raw, title, headline,
           linkedin_slug, linkedin_member_id, do_not_contact
      from orbit.people
     where id = ${personId}::uuid and user_id = ${userId}::uuid and deleted_at is null and not is_self`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
  if (p.primary_email)
    return {
      email: p.primary_email,
      ...(p.email_confidence && p.email_confidence !== 'invalid'
        ? { emailConfidence: p.email_confidence as EmailConfidence }
        : {}),
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
    sources: [],
    externalIds: {},
  };
  const found = await findEmailFor(s, userId, c, {
    tools: emailToolsFor(s, userId, await linkedinAccount(db, userId)),
  });
  if (!found) return { emailStatus: 'not found' };
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
 * verified; a server that takes any address, or no verifier at all, lets it go as before (the student was told it is
 * unconfirmed when the person was added). An address that already failed holds every message to it.
 */
export async function checkBuiltAddress(
  s: Services,
  userId: string,
  person: { id: string; email: string; confidence: string | null; checkedAt: Date | string | null },
): Promise<'ok' | 'invalid'> {
  if (person.confidence === 'invalid') return 'invalid';
  if (!person.confidence || !UNCHECKED.has(person.confidence) || person.checkedAt) return 'ok';
  const verify = emailToolsFor(s, userId).verify;
  const v = verify ? await verify(person.email).catch(() => undefined) : undefined;
  if (!v) return 'ok';
  const next = v === 'valid' ? 'verified' : v === 'invalid' ? 'invalid' : person.confidence;
  await s.db.sql`
    update orbit.people set email_confidence = ${next}, email_checked_at = ${s.now()}::timestamptz
     where id = ${person.id}::uuid and user_id = ${userId}::uuid`;
  return v === 'invalid' ? 'invalid' : 'ok';
}
