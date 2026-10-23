/**
 * Is this LinkedIn profile the Gmail or iMessage person Orbit already knows? (plan 17 E, step 3; the student's rule 3)
 * Only a confident match joins them: the same name, and either an email or phone number the profile itself shares
 * (deterministic), or the same company, school or place. Two people with the same name and nothing else in common
 * are never joined, and when two profiles fit equally well neither is.
 */
import type { Affiliation, Person } from '@orbit/core';
import {
  emailDomain,
  isFirstNameVariant,
  normalizeCompany,
  normalizeEmail,
  parseName,
  sameSchool,
  stripDiacritics,
} from '@orbit/core';
import type { LinkedInProfile } from '../../integrations/enrichmentProxy';
import type { LinkedInFound } from '../../integrations/unipile';
import { companyFromEmail } from '../enrich';
import type { SchoolAlias } from './education';

/** What Orbit already knows about someone that a LinkedIn profile can agree with (step 0 of the waterfall). */
export interface Hints {
  /** companies, normalised: their current one, past ones on record, and the one a work address names */
  companies: string[];
  schools: string[];
  /** cities, folded ("san francisco") */
  places: string[];
  emails: string[];
  phones: string[];
}

export type EvidenceKind = 'email' | 'phone' | 'company' | 'school' | 'place';

export interface Evidence {
  kind: EvidenceKind;
  detail: string;
}

/** How much each kind of agreement says, on top of the same name. */
const WEIGHT: Record<EvidenceKind, number> = { email: 1, phone: 1, company: 0.9, school: 0.85, place: 0.75 };
/** Joining needs at least this: a place alone is just enough, a bare name never. */
export const JOIN_AT = 0.75;

const fold = (s: string | undefined) =>
  stripDiacritics(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "+1 (415) 555-0100" -> "+14155550100": digits with a country code, as Contacts stores them. */
export function phoneKey(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7) return undefined;
  if (t.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** The city part of a place: "San Francisco, CA" -> "san francisco"; "Greater Boston Area" -> "boston". */
function city(place: string | undefined): string | undefined {
  const first = fold((place ?? '').split(',')[0]);
  const c = first
    .replace(/^greater /, '')
    .replace(/ (bay )?area$/, '')
    .replace(/ metropolitan$/, '')
    .trim();
  return c.length >= 3 ? c : undefined;
}

/** What Orbit knows about a person that a profile can agree with. */
export function hintsFor(
  person: Pick<
    Person,
    | 'currentOrganizationRaw'
    | 'primaryEmail'
    | 'primaryEmailAsWritten'
    | 'emails'
    | 'phones'
    | 'school'
    | 'location'
  >,
  affiliations: Pick<Affiliation, 'kind' | 'nameRaw'>[] = [],
  opts: { schoolByDomain?: (domain: string) => string | undefined } = {},
): Hints {
  const emails = [
    ...new Set(
      [person.primaryEmailAsWritten, person.primaryEmail, ...(person.emails ?? [])]
        .filter((e): e is string => !!e)
        .map((e) => normalizeEmail(e)),
    ),
  ];
  const companies = [
    person.currentOrganizationRaw,
    ...affiliations.filter((a) => a.kind === 'employment').map((a) => a.nameRaw),
  ]
    .map((c) => normalizeCompany(c))
    .filter((c) => c.length >= 3);
  // a work address names the company ("brooke@corgi.com" -> "corgi")
  for (const e of emails) {
    const c = companyFromEmail(e);
    if (c && c.length >= 3) companies.push(normalizeCompany(c));
  }
  const schools = [person.school, ...affiliations.filter((a) => a.kind === 'education').map((a) => a.nameRaw)]
    .filter((s): s is string => !!s?.trim())
    .map((s) => s.trim());
  for (const e of emails) {
    const d = emailDomain(e);
    if (d?.endsWith('.edu')) {
      const s = opts.schoolByDomain?.(d.split('.').slice(-2).join('.'));
      if (s) schools.push(s);
    }
  }
  return {
    companies: [...new Set(companies)],
    schools: [...new Set(schools)],
    places: [city(person.location)].filter((c): c is string => !!c),
    emails,
    phones: [...new Set((person.phones ?? []).map(phoneKey).filter((p): p is string => !!p))],
  };
}

/** The same person's name: the same last name, and the same first name or a nickname of it (Liz / Elizabeth). */
export function sameName(person: Pick<Person, 'firstName' | 'lastName'>, name: string): boolean {
  const a = parseName(`${person.firstName} ${person.lastName}`);
  const b = parseName(name);
  if (!a.last || !b.last || !a.first || !b.first) return false;
  const lastA = fold(a.last).split(' ').at(-1);
  const lastB = fold(b.last).split(' ').at(-1);
  if (!lastA || lastA !== lastB) return false;
  const fa = fold(a.first);
  const fb = fold(b.first);
  return fa === fb || isFirstNameVariant(fa, fb);
}

/** `needle` written as whole words inside `hay`. */
const hasWords = (hay: string, needle: string) => !!needle && ` ${hay} `.includes(` ${needle} `);

/** What a search result's headline and place agree with. */
export function evidenceFromHit(hints: Hints, hit: Pick<LinkedInFound, 'headline' | 'location'>): Evidence[] {
  const out: Evidence[] = [];
  const head = fold(hit.headline);
  const company = hints.companies.find((c) => hasWords(head, fold(c)));
  if (company) out.push({ kind: 'company', detail: company });
  const school = hints.schools.find((s) => hasWords(head, fold(s)));
  if (school) out.push({ kind: 'school', detail: school });
  const place = city(hit.location);
  if (place && hints.places.some((p) => hasWords(place, p) || hasWords(p, place)))
    out.push({ kind: 'place', detail: place });
  return out;
}

/** What a full profile agrees with: an address or number it shares, a company or school on it, its place. */
export function evidenceFromProfile(hints: Hints, profile: LinkedInProfile, alias?: SchoolAlias): Evidence[] {
  const out: Evidence[] = [];
  const emails = new Set((profile.contact?.emails ?? []).map((e) => normalizeEmail(e)));
  const email = hints.emails.find((e) => emails.has(e));
  if (email) out.push({ kind: 'email', detail: email });
  const phones = new Set((profile.contact?.phones ?? []).map(phoneKey).filter(Boolean));
  const phone = hints.phones.find((p) => phones.has(p));
  if (phone) out.push({ kind: 'phone', detail: phone });
  const companies = profile.experience.map((x) => normalizeCompany(x.company)).filter(Boolean);
  const company = hints.companies.find((c) =>
    companies.some((x) => x === c || hasWords(x, c) || hasWords(c, x)),
  );
  if (company) out.push({ kind: 'company', detail: company });
  else {
    const head = evidenceFromHit(hints, { headline: profile.headline }).find((e) => e.kind === 'company');
    if (head) out.push(head);
  }
  const school = hints.schools.find((s) => profile.education.some((e) => sameSchool(e.school, s, alias)));
  if (school) out.push({ kind: 'school', detail: school });
  const place = city(profile.location);
  if (place && hints.places.some((p) => hasWords(place, p) || hasWords(p, place)))
    out.push({ kind: 'place', detail: place });
  return out;
}

/** How sure the evidence makes Orbit, 0–1: the strongest agreement, a little more for a second kind. */
export function confidenceOf(evidence: Evidence[]): number {
  if (!evidence.length) return 0;
  const ws = [...new Set(evidence.map((e) => e.kind))].map((k) => WEIGHT[k]).sort((a, b) => b - a);
  return Math.min(1, ws[0]! + (ws.length > 1 ? 0.05 : 0));
}

/**
 * The one result that is surely them, or none: among results with their name, the only one whose evidence reaches
 * JOIN_AT (two that do are two namesakes Orbit cannot tell apart).
 */
export function pickConfident<T>(
  scored: { item: T; evidence: Evidence[] }[],
): { item: T; evidence: Evidence[]; confidence: number } | 'ambiguous' | undefined {
  const sure = scored
    .map((s) => ({ ...s, confidence: confidenceOf(s.evidence) }))
    .filter((s) => s.confidence >= JOIN_AT);
  if (!sure.length) return undefined;
  if (sure.length === 1) return sure[0];
  // an address or number the profile shares beats any agreement by company or school
  const exact = sure.filter((s) => s.evidence.some((e) => e.kind === 'email' || e.kind === 'phone'));
  return exact.length === 1 ? exact[0] : 'ambiguous';
}
