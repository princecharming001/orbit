/**
 * Filling in people the student knows from LinkedIn. Someone found in Gmail is a name and an address; with LinkedIn
 * connected live, Orbit looks them up by name and keeps the profile only when it is surely them: the same name (by the
 * shared name matcher: accents, scripts, nicknames and middle names forgiven; core entity/names.ts), and something
 * that is not the name: their company (from their record or their work address) or their school in the LinkedIn
 * headline, or, for a direct connection, the same city. A direct connection with the same name and nothing else is
 * not enough: the student can know two Michael Chens. A wrong match would be worse than none, so anything less
 * certain is left alone.
 *
 * A few lookups a day (LinkedIn throttles heavy searching), closest people first, each person at most once a month.
 * The demo student is never looked up.
 */
import type { Person, User } from '@orbit/core';
import {
  emailDomain,
  hasRealName,
  isKnownContact,
  linkedInSlug,
  nameAgreement,
  newId,
  normalizeCompany,
  normalizeLinkedInUrl,
  PERSONAL_EMAIL_DOMAINS,
  roleFromHeadline,
  transliterate,
} from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { type LinkedInFound, searchLinkedIn, unipileConfigured } from '../integrations/unipile';
import { liveLinkedInAccount } from './linkedinLive';
import { freshPhoto } from './photos';

/** Lookups a day, from the student's LinkedIn. */
export const ENRICH_PER_DAY = 8;
const RETRY_AFTER_MS = 30 * 86_400_000;

/** Words in lower-case Latin letters and digits, for finding a company or school inside a headline. */
const norm = (s: string) =>
  transliterate(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** True when `phrase` appears in `text` as whole words ("meta" is in "PM at Meta", not in "metadata"). */
const hasWords = (text: string, phrase: string) => !!phrase && ` ${text} `.includes(` ${phrase} `);

/** "corgi.com" → "corgi", "mail.stripe.com" → "stripe": the name a work address points at. */
export function companyFromEmail(email: string | undefined): string | undefined {
  const d = email ? emailDomain(email) : undefined;
  if (!d || PERSONAL_EMAIL_DOMAINS.has(d) || d.endsWith('.edu')) return undefined;
  const parts = d.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/**
 * The one search result that is surely this person, or nothing: the same name, and their company or school in the
 * headline, or a direct LinkedIn connection in the same city. A headline naming another employer than the one Orbit
 * knows rules a result out (unless the school agrees: they may have moved on).
 */
export function pickMatch(
  p: Pick<Person, 'firstName' | 'lastName' | 'currentOrganizationRaw' | 'primaryEmail' | 'emails'> &
    Partial<Pick<Person, 'displayName' | 'school' | 'location'>>,
  results: LinkedInFound[],
): LinkedInFound | undefined {
  const want = p.displayName?.trim() || `${p.firstName} ${p.lastName}`;
  const companies = [p.currentOrganizationRaw, ...[p.primaryEmail, ...(p.emails ?? [])].map(companyFromEmail)]
    .filter((c): c is string => !!c && c.trim().length >= 3)
    .flatMap((c) => [norm(c), norm(normalizeCompany(c))])
    .filter((c) => c.length >= 3);
  const school = p.school ? norm(p.school) : '';
  const city = (l: string | undefined) => norm((l ?? '').split(',')[0] ?? '');
  const sure = results.filter((r) => {
    // the shared matcher: "José"/"Jose", "Bill"/"William", "Łukasz"/"Lukasz", never two names that fold to nothing
    if (!nameAgreement(want, r.name)) return false;
    const head = norm(r.headline ?? '');
    const atCompany = companies.some((c) => hasWords(head, c));
    const atSchool = school.length >= 3 && hasWords(head, school);
    const elsewhere = !!companies.length && !atCompany && !!roleFromHeadline(r.headline).org;
    if (elsewhere && !atSchool) return false;
    if (atCompany || atSchool) return true;
    const here = city(p.location);
    return r.distance === 1 && here.length >= 3 && here === city(r.location);
  });
  return sure.length === 1 ? sure[0] : undefined;
}

/** "Product Manager at Stripe" → its title and company, when the headline's first part says it plainly. */
function titleAndCompany(headline: string | undefined): { title?: string; company?: string } {
  const { title, org } = roleFromHeadline(headline);
  return org ? { title, company: org } : {};
}

type Tried = Record<string, string>;

/** Look up today's share of the people the student knows that have no LinkedIn yet. */
export async function enrichFromLinkedIn(
  user: Pick<User, 'id'>,
  opts: { now?: Date; limit?: number; signal?: AbortSignal } = {},
): Promise<{ looked: number; matched: number }> {
  const now = opts.now ?? new Date();
  const out = { looked: 0, matched: 0 };
  if (usesMockConnectors(user.id) || !unipileConfigured()) return out;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId || !row.accessToken) return out;
  const day = now.toISOString().slice(0, 10);
  const budgetKey = `enrich:day:${user.id}`;
  const triedKey = `enrich:tried:${user.id}`;
  const budget = ((await db.kv.get(budgetKey))?.value as { day?: string; used?: number } | undefined) ?? {};
  const used = budget.day === day ? (budget.used ?? 0) : 0;
  const left = Math.min(opts.limit ?? ENRICH_PER_DAY, ENRICH_PER_DAY - used);
  if (left <= 0) return out;
  const tried = ((await db.kv.get(triedKey))?.value as Tried | undefined) ?? {};
  const chats = new Set((await db.chats.where('userId').equals(user.id).toArray()).map((c) => c.personId));
  const candidates = (await db.people.where('userId').equals(user.id).toArray())
    .filter(
      (p) =>
        !p.linkedinUrl &&
        !p.linkedinSlug &&
        hasRealName(p) &&
        isKnownContact(p, { hasChat: chats.has(p.id) }) &&
        now.getTime() - Date.parse(tried[p.id] ?? '1970-01-01') > RETRY_AFTER_MS,
    )
    .sort((a, b) => b.strength - a.strength)
    .slice(0, left);
  for (const p of candidates) {
    if (opts.signal?.aborted) break;
    const r = await searchLinkedIn(
      row.externalAccountId,
      { keywords: `${p.firstName} ${p.lastName}`, distance: [1, 2, 3] },
      { token: row.accessToken, signal: opts.signal },
    );
    out.looked++;
    tried[p.id] = now.toISOString();
    if (!r.ok) {
      // LinkedIn said no (a limit, a hiccup): stop for today and keep what is left for tomorrow
      if (r.reason !== 'error') break;
      continue;
    }
    const hit = pickMatch(p, r.value.people);
    const url = normalizeLinkedInUrl(hit?.profileUrl);
    if (!hit || !url) continue;
    // the profile is already someone in Orbit (from the LinkedIn export or the live sync): the two are probably one
    // person, which the student confirms; the profile is not copied onto a second record
    const slug = linkedInSlug(url);
    const owner = await db.people
      .where('userId')
      .equals(user.id)
      .filter(
        (o) =>
          o.id !== p.id &&
          (o.linkedinSlug === slug || (!!hit.memberId && o.linkedinMemberId === hit.memberId)),
      )
      .first();
    if (owner) {
      const asked = await db.merges
        .where('userId')
        .equals(user.id)
        .filter((m) => [m.personAId, m.personBId].sort().join('|') === [owner.id, p.id].sort().join('|'))
        .first();
      if (!asked)
        await db.merges.add({
          id: newId('mrg'),
          userId: user.id,
          personAId: owner.createdAt <= p.createdAt ? owner.id : p.id,
          personBId: owner.createdAt <= p.createdAt ? p.id : owner.id,
          score: 0.85,
          features: { name_sim: 1, linkedin_lookup: 1 },
          status: 'pending',
          createdAt: now.toISOString(),
        });
      continue;
    }
    const { title, company } = titleAndCompany(hit.headline);
    await db.people.update(p.id, {
      linkedinUrl: url,
      linkedinSlug: linkedInSlug(url),
      linkedinMemberId: p.linkedinMemberId ?? hit.memberId,
      headline: p.headline ?? hit.headline,
      currentTitle: p.currentTitle ?? title,
      currentOrganizationRaw: p.currentOrganizationRaw ?? company,
      photoUrl: freshPhoto(p.photoUrl, hit.pictureUrl),
      location: p.location ?? hit.location,
      sources: p.sources.includes('enrichment') ? p.sources : [...p.sources, 'enrichment'],
    });
    out.matched++;
  }
  await db.kv.put({ key: triedKey, value: tried });
  await db.kv.put({ key: budgetKey, value: { day, used: used + out.looked } });
  return out;
}
