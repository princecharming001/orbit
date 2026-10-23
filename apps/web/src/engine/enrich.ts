/**
 * Filling in people the student knows from LinkedIn. Someone found in Gmail is a name and an address; with LinkedIn
 * connected live, Orbit looks them up by name and keeps the profile only when it is surely them: the exact name, and
 * either a direct connection or their company (from their record or their work address) in the LinkedIn headline. A
 * wrong match would be worse than none, so anything less certain is left alone.
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
  normalizeLinkedInUrl,
  PERSONAL_EMAIL_DOMAINS,
  roleFromHeadline,
  stripDiacritics,
} from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { type LinkedInFound, searchLinkedIn, unipileConfigured } from '../integrations/unipile';
import { liveLinkedInAccount } from './linkedinLive';
import { freshPhoto } from './photos';

/** Lookups a day, from the student's LinkedIn. */
export const ENRICH_PER_DAY = 8;
const RETRY_AFTER_MS = 30 * 86_400_000;

const norm = (s: string) =>
  stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "corgi.com" → "corgi", "mail.stripe.com" → "stripe": the name a work address points at. */
export function companyFromEmail(email: string | undefined): string | undefined {
  const d = email ? emailDomain(email) : undefined;
  if (!d || PERSONAL_EMAIL_DOMAINS.has(d) || d.endsWith('.edu')) return undefined;
  const parts = d.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/**
 * The one search result that is surely this person, or nothing: the same first and last name, and a direct LinkedIn
 * connection or a headline naming their company.
 */
export function pickMatch(
  p: Pick<Person, 'firstName' | 'lastName' | 'currentOrganizationRaw' | 'primaryEmail' | 'emails'>,
  results: LinkedInFound[],
): LinkedInFound | undefined {
  const want = norm(`${p.firstName} ${p.lastName}`);
  const companies = [p.currentOrganizationRaw, ...[p.primaryEmail, ...(p.emails ?? [])].map(companyFromEmail)]
    .filter((c): c is string => !!c && c.trim().length >= 3)
    .map(norm);
  const sure = results.filter((r) => {
    if (norm(r.name) !== want) return false;
    if (r.distance === 1) return true;
    const head = norm(r.headline ?? '');
    return companies.some((c) => c && head.includes(c));
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
