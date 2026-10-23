import { jaroWinkler, tokenJaccard } from '../text/jaro';
import {
  canonicalFirstName,
  emailDomain,
  emailLocalPart,
  linkedInSlug,
  type NameParts,
  nameFromParts,
  normalizeCompany,
  normalizeEmail,
  parseName,
} from '../text/normalize';
import type { Affiliation, Person, PersonSource } from '../types';
import {
  compareNames,
  type FoldedName,
  foldName,
  givenNamesRelated,
  type NameComparison,
  nameAgreement,
  nameBlockKeys,
} from './names';
import { nameVariants } from './nicknames';
import { transliterate } from './translit';

export interface IncomingIdentity {
  email?: string;
  linkedinUrl?: string;
  displayName?: string;
  /** Separate name fields when the source has them (LinkedIn CSV); they win over `displayName`. */
  firstName?: string;
  lastName?: string;
  /**
   * Phone numbers in E.164 (+15551234567; entity/phone.ts `toE164` writes them). A number is one person's: a shared
   * one is a match, like a shared address.
   */
  phones?: string[];
  /**
   * The numbers come from the student's Contacts, so they are this person's numbers: someone else in Orbit whose own
   * numbers are all different is someone else (a hard negative), however alike the names.
   */
  phonesVerified?: boolean;
  /** LinkedIn's member id (a live sync or a search result): one profile, so one person, like the profile URL */
  linkedinMemberId?: string;
  companyRaw?: string;
  title?: string;
  school?: string;
  source: PersonSource;
  /**
   * The person this identity already belongs to, when it is being re-resolved (a merge pass, an identity seen
   * again): pairs the student marked "not the same" with it are never matched.
   */
  personId?: string;
}

export interface ResolveFeatures {
  name_sim: number;
  last_sim: number;
  org_match: number;
  title_sim: number;
  email_name_sim: number;
  domain_org_match: number;
  school_match: number;
  /**
   * 1 when the first names differ in writing but one is a nickname of the other (Liz/Elizabeth, Bill/William), from
   * the built-in table or carltonnorthern/nicknames (plan 16 §2.1); 0 otherwise.
   */
  firstNameVariant: number;
}

export const RESOLVE_WEIGHTS: Record<keyof ResolveFeatures, number> & { bias: number } = {
  name_sim: 3.0,
  last_sim: 1.5,
  org_match: 2.0,
  title_sim: 0.5,
  email_name_sim: 1.5,
  domain_org_match: 1.5,
  school_match: 0.5,
  // a nickname is real evidence that two spellings are one name, but never enough on its own: auto-merging a
  // nickname still needs an address or a school (see corroborated)
  firstNameVariant: 0.5,
  bias: -3.5,
};

/**
 * §2.5: two people with the same name at the same company are never merged on name and employer alone; without a
 * work address that fits or a school, the score stops at 0.85 (a suggestion the student confirms).
 */
export const NAME_ORG_ONLY_CAP = 0.85;

export const AUTO_MERGE_THRESHOLD = 0.92;
export const SUGGEST_THRESHOLD = 0.6;

export type ResolveDecision =
  | {
      kind: 'match';
      personId: string;
      /** the evidence: a shared address, LinkedIn profile (URL or member id) or phone number */
      via: 'email' | 'linkedin' | 'phone';
      /**
       * Other people this identity proves to be the same person: the address belongs to `personId` and arrives under
       * the exact full name of someone known only from LinkedIn whose first name is a nickname of the owner's (Liz
       * Chen's address in an invite as "Elizabeth Chen"). The caller merges them into `personId`.
       */
      mergeWith?: string[];
    }
  | { kind: 'probable'; personId: string; score: number; features: ResolveFeatures }
  | { kind: 'suggest'; personId: string; score: number; features: ResolveFeatures }
  /** a shared or role inbox (§2.5: info@, careers@, noreply@ ...): never a person */
  | { kind: 'role' }
  | { kind: 'new' };

export interface ResolveContext {
  people: Person[];
  affiliationsByPerson?: Map<string, Affiliation[]>;
  orgDomains?: Map<string, string[]>; // organizationId -> domains
  /** pairs the student said are not the same person (`doNotMergeKey`); never merged or suggested again */
  doNotMerge?: ReadonlySet<string>;
}

/** Key of an unordered pair of person ids, for `ResolveContext.doNotMerge`. */
export function doNotMergeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function rejected(ctx: Pick<ResolveContext, 'doNotMerge'>, a: string | undefined, b: string): boolean {
  return !!a && !!ctx.doNotMerge?.has(doNotMergeKey(a, b));
}

/** Local parts of shared and role inboxes that never become people (§2.5). */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'info',
  'hello',
  'team',
  'support',
  'careers',
  'recruiting',
  'jobs',
  'noreply',
  'no-reply',
  'notifications',
  'billing',
  'admin',
  'contact',
]);

/** True for a role address (careers@stripe.com, no-reply@x.com, team+news@y.com). */
export function isRoleAddress(email: string): boolean {
  const e = normalizeEmail(email);
  if (!e.includes('@')) return false;
  const local = emailLocalPart(e).replace(/\+.*$/, '');
  return ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(local.replace(/[._]/g, '-'));
}

/**
 * The address as a matching key (§2.1): lower-case, display name and angle brackets dropped, and for gmail.com /
 * googlemail.com the dots and +tag removed (Liz.Chen+jobs@gmail.com and lizchen@gmail.com are one mailbox).
 */
export function normalizeEmailForMatch(raw: string): string {
  return normalizeEmail(raw);
}

/** Free mailbox providers: the address says nothing about the employer and a name in it is weak evidence. */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'fastmail.com',
  'hey.com',
  'qq.com',
  '163.com',
]);

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

const parsedNames = new Map<string, NameParts>();
/** parseName, remembered: resolution reads the same stored names for every incoming record of an import. */
function parsed(raw: string | undefined): NameParts {
  const key = raw ?? '';
  let n = parsedNames.get(key);
  if (!n) {
    n = parseName(raw);
    if (parsedNames.size > 50_000) parsedNames.clear();
    parsedNames.set(key, n);
  }
  return n;
}

/** The incoming name, from separate first/last fields when present, otherwise the display name. */
export function incomingName(inc: IncomingIdentity): NameParts {
  return inc.firstName || inc.lastName ? nameFromParts(inc.firstName, inc.lastName) : parsed(inc.displayName);
}

/** Lower-case Latin letters, whatever the script ("Łukasz" → "lukasz", "Иван" → "ivan"). */
const fold = (s: string) => transliterate(s).toLowerCase();

/** True when one first name is a bare initial ("P." or "P") and the other is a full name starting with it. */
export function initialMatches(a: string, b: string): boolean {
  const x = fold(a).replace(/\.$/, '');
  const y = fold(b).replace(/\.$/, '');
  if (!x || !y || x.length === y.length) return false;
  const [initial, full] = x.length < y.length ? [x, y] : [y, x];
  return initial.length === 1 && /^[a-z]$/.test(initial) && full.length > 1 && full.startsWith(initial);
}

/**
 * True when a stored person's name is only a stand-in derived from their email address ("erodriguez"),
 * so it must not count as name evidence and should be replaced by the first real name we see.
 */
export function isPlaceholderName(
  p: Pick<Person, 'displayName' | 'primaryEmail' | 'namePlaceholder'>,
): boolean {
  if (p.namePlaceholder) return true;
  if (!p.displayName || p.displayName.includes('@') || p.displayName === 'Unknown') return true;
  if (!p.primaryEmail) return false;
  // a stand-in from older records is the address's local part as typed ("erodriguez", "tom wu"); a name
  // written with capitals ("Priya Patel" for priya.patel@) is a real name that happens to fit the address
  if (p.displayName !== p.displayName.toLowerCase()) return false;
  const squash = (x: string) => fold(x).replace(/[\s._+-]/g, '');
  const local = p.primaryEmail.slice(0, p.primaryEmail.lastIndexOf('@')).replace(/\+.*$/, '');
  return squash(p.displayName) === squash(local);
}

/** How well an email address fits a person's name and employer. */
function emailEvidence(
  rawEmail: string,
  name: NameParts,
  org: string,
  orgDomains: string[],
  fuzzy = true,
): { nameSim: number; domainOrg: number } {
  const email = normalizeEmail(rawEmail);
  if (!email.includes('@')) return { nameSim: 0, domainOrg: 0 };
  const dom = emailDomain(email);
  const personal = PERSONAL_EMAIL_DOMAINS.has(dom);
  let nameSim = 0;
  if (name.first && name.last) {
    const local = emailLocalPart(email)
      .replace(/\+.*$/, '')
      .replace(/[\d._-]+/g, ' ')
      .trim();
    const compact = local.replace(/\s+/g, '');
    const first = fold(name.first).replace(/[^a-z]/g, '');
    const canon = canonicalFirstName(name.first).replace(/[^a-z]/g, '');
    const last = fold(name.last).replace(/[^a-z]/g, '');
    // the whole surname and each of its parts (garcia.marquez@ or garcia@ for Gabriel García Márquez), and a middle
    // name the person may go by (robert.oppenheimer@ for J. Robert Oppenheimer)
    const folded = foldName(name);
    const lasts = [
      ...new Set([last, folded.surnames.join(''), ...folded.surnames].filter((l) => l.length >= 2)),
    ];
    const middles = folded.middles.filter((m) => m.length >= 2);
    const forms = new Set<string>();
    // the address may spell a nickname of the name (lizchen@ for Elizabeth Chen): §2.1's first-name-variant key
    const variants = [...nameVariants(first)]
      .map((v) => v.replace(/[^a-z]/g, ''))
      .filter((v) => v.length >= 2);
    for (const l of lasts) {
      for (const v of variants) {
        forms.add(`${v}${l}`);
        forms.add(`${l}${v}`);
      }
      for (const f of [first, canon, ...middles]) {
        if (!f) continue;
        forms.add(`${f}${l}`);
        forms.add(`${f[0] ?? ''}${l}`);
        forms.add(`${l}${f}`);
        forms.add(`${f}${l[0] ?? ''}`);
      }
    }
    if (compact && forms.has(compact)) nameSim = 1;
    else if (compact && last.length >= 4 && compact.includes(last)) nameSim = 0.7;
    else if (compact && fuzzy)
      nameSim =
        Math.max(jaroWinkler(compact, `${first}${last}`), jaroWinkler(compact, `${first[0] ?? ''}${last}`)) *
        0.6;
    // a name inside a free mailbox address is weak, often self-chosen, and common names collide
    if (personal) nameSim *= 0.5;
  }
  let domainOrg = 0;
  if (!personal) {
    if (orgDomains.includes(dom)) domainOrg = 1;
    else {
      const root = dom.split('.').slice(-2, -1)[0] ?? dom.split('.')[0] ?? '';
      const orgCompact = org.replace(/[\s&]+/g, '');
      if (
        org &&
        root.length >= 2 &&
        (orgCompact.includes(root) || (root.length >= 4 && root.includes(orgCompact)))
      )
        domainOrg = 0.8;
    }
  }
  return { nameSim, domainOrg };
}

/** How the names compare (none when either side has no real name). */
function namesOf(inc: IncomingIdentity, cand: Person): NameComparison {
  const incName = incomingName(inc);
  const candName = parsed(cand.displayName);
  if (!incName.full || !candName.full || isPlaceholderName(cand))
    return { given: 'different', surname: 'different', swapped: false, score: 0 };
  return compareNames(incName, candName);
}

const LAST_SIM: Record<NameComparison['surname'], number> = {
  same: 1,
  phonetic: 0.85,
  partial: 0.8,
  missing: 0,
  different: 0,
};

export function computeFeatures(inc: IncomingIdentity, cand: Person, ctx: ResolveContext): ResolveFeatures {
  const incName = incomingName(inc);
  const candName = parsed(cand.displayName);
  const candPlaceholder = isPlaceholderName(cand);
  // one matcher for every name comparison (entity/names.ts): scripts, accents, nicknames, middle names, initials,
  // double surnames and surname-first order
  const names = namesOf(inc, cand);
  const nameSim = names.score;
  const lastSim = names.swapped ? 1 : LAST_SIM[names.surname];
  const firstNameVariant =
    !candPlaceholder &&
    incName.first &&
    candName.first &&
    (names.given === 'nickname' || names.given === 'variant' || names.given === 'ambiguous')
      ? 1
      : 0;
  const incOrg = normalizeCompany(inc.companyRaw);
  const candOrg = normalizeCompany(cand.currentOrganizationRaw);
  let orgMatch = 0;
  if (incOrg && candOrg) {
    const [short, long] = incOrg.length <= candOrg.length ? [incOrg, candOrg] : [candOrg, incOrg];
    if (incOrg === candOrg) orgMatch = 1;
    else if (short.length >= 4 && long.startsWith(`${short} `)) orgMatch = 0.8;
    else if (jaroWinkler(incOrg, candOrg) >= 0.9) orgMatch = 0.5;
    // An identical full name at another employer is most often the same person after a job change:
    // keep it in the suggestion band instead of ruling it out.
    else orgMatch = nameSim === 1 && lastSim === 1 && names.given === 'same' ? -0.25 : -0.5;
  }
  const titleSim = inc.title && cand.currentTitle ? tokenJaccard(inc.title, cand.currentTitle) : 0;
  // email evidence in both directions: incoming address vs the stored person, and stored addresses vs the incoming name
  let emailNameSim = 0;
  let domainOrgMatch = 0;
  const candDomains = cand.currentOrganizationId
    ? (ctx.orgDomains?.get(cand.currentOrganizationId) ?? [])
    : [];
  const candNameForEmail = candPlaceholder ? { first: '', last: '', full: '', normalized: '' } : candName;
  if (inc.email) {
    const e = emailEvidence(inc.email, candNameForEmail, candOrg, candDomains);
    emailNameSim = Math.max(emailNameSim, e.nameSim);
    domainOrgMatch = Math.max(domainOrgMatch, e.domainOrg);
  }
  const candEmails = new Set([...(cand.primaryEmail ? [cand.primaryEmail] : []), ...cand.emails]);
  for (const ce of candEmails) {
    // only clear address patterns count in this direction; a bare first name in the address proves little
    const e = emailEvidence(ce, incName, incOrg, [], false);
    emailNameSim = Math.max(emailNameSim, e.nameSim);
    // the stored address stands in for the employer only when the stored person has none (else org_match covers it)
    if (!candOrg) domainOrgMatch = Math.max(domainOrgMatch, e.domainOrg);
  }
  const schoolMatch =
    inc.school && cand.school && normalizeCompany(inc.school) === normalizeCompany(cand.school) ? 1 : 0;
  return {
    name_sim: nameSim,
    last_sim: lastSim,
    org_match: orgMatch,
    title_sim: titleSim,
    email_name_sim: emailNameSim,
    domain_org_match: domainOrgMatch,
    school_match: schoolMatch,
    firstNameVariant,
  };
}

export function scoreFeatures(f: ResolveFeatures, w = RESOLVE_WEIGHTS): number {
  const z =
    w.bias +
    w.name_sim * f.name_sim +
    w.last_sim * f.last_sim +
    w.org_match * f.org_match +
    w.title_sim * f.title_sim +
    w.email_name_sim * f.email_name_sim +
    w.domain_org_match * f.domain_org_match +
    w.school_match * f.school_match +
    w.firstNameVariant * f.firstNameVariant;
  return sigmoid(z);
}

/**
 * Score a pair where one side has no real name (a bare address): only the address pattern and the
 * employer can link them, so require both.
 */
function addressOnlyScore(f: ResolveFeatures): number {
  if (f.email_name_sim >= 1 && f.domain_org_match >= 0.8) return 0.93;
  if (f.email_name_sim >= 0.7 && f.domain_org_match >= 0.8) return 0.75;
  return 0;
}

/** An address with a number in its name part (michael.chen2@, mchen88@): often a namesake's. */
function numberedAddress(e: string): boolean {
  return /\d/.test(emailLocalPart(normalizeEmail(e)).replace(/\+.*$/, ''));
}

/**
 * A work address that fits the name, at the employer the other record names: the one piece of address evidence that
 * is not the name over again. Either the incoming address (jnunez@bain.com for a stored José Núñez at Bain), or, when
 * the incoming record has no address of its own (a LinkedIn CSV row), a stored address at the incoming employer
 * (dkim@stripe.com for "Daniel Kim, Stripe"). A free mailbox or a school address that spells the name is not
 * evidence: anyone can be michaelchen@gmail.com, and it does not tie them to this Michael Chen. An incoming address
 * that differs from the stored person's is not explained by a stored one either (a namesake writes from their own).
 * A numbered address (michael.chen2@google.com) says the employer has more than one of that name, so it is no
 * evidence of which one this is.
 */
function workAddressFits(inc: IncomingIdentity, cand: Person, ctx: ResolveContext): boolean {
  const incName = incomingName(inc);
  const candName = parsed(cand.displayName);
  const candOrg = normalizeCompany(cand.currentOrganizationRaw);
  const candDomains = cand.currentOrganizationId
    ? (ctx.orgDomains?.get(cand.currentOrganizationId) ?? [])
    : [];
  if (inc.email) {
    if (isPlaceholderName(cand) || numberedAddress(inc.email)) return false;
    const e = emailEvidence(inc.email, candName, candOrg, candDomains, false);
    return e.domainOrg > 0 && e.nameSim >= 0.7;
  }
  const incOrg = normalizeCompany(inc.companyRaw);
  if (!incOrg || !incName.full) return false;
  for (const ce of new Set([...(cand.primaryEmail ? [cand.primaryEmail] : []), ...cand.emails])) {
    if (numberedAddress(ce)) continue;
    const e = emailEvidence(ce, incName, incOrg, [], false);
    if (e.domainOrg > 0 && e.nameSim >= 0.7) return true;
  }
  return false;
}

/**
 * Whether the incoming record names a different employer than the stored person: another or only look-alike
 * firm name ("Bain Capital" for "Bain & Company"), or a work address that is not at the stored employer
 * (jnunez@baincapital.com). An address at the stored employer's own domain settles it the other way.
 */
function employerConflict(
  inc: IncomingIdentity,
  cand: Person,
  ctx: ResolveContext,
  f: ResolveFeatures,
): boolean {
  const candOrg = normalizeCompany(cand.currentOrganizationRaw);
  if (!candOrg) return false;
  const email = inc.email ? normalizeEmail(inc.email) : '';
  const dom = email.includes('@') ? emailDomain(email) : '';
  const work = !!dom && !PERSONAL_EMAIL_DOMAINS.has(dom);
  if (work) {
    const known = cand.currentOrganizationId ? (ctx.orgDomains?.get(cand.currentOrganizationId) ?? []) : [];
    const root = dom.split('.').slice(-2, -1)[0] ?? '';
    if (known.includes(dom) || root === candOrg.replace(/[\s&]+/g, '')) return false;
  }
  if (inc.companyRaw && normalizeCompany(inc.companyRaw) && f.org_match < 1) return true;
  return work;
}

/**
 * The probability that an incoming identity is a stored person, with the evidence rules on top of the weights
 * (Fellegi-Sunter style, plan 17 §A). Only a deterministic key (a shared address, LinkedIn profile or phone number;
 * resolveIdentity) matches on its own. Otherwise:
 * - the names have to agree first (Priya Patel and Arjun Patel at Figma are two people);
 * - auto-merging (≥ AUTO_MERGE_THRESHOLD) needs evidence that is not the name: a work address that fits the name at
 *   the employer the other record names, or the same school. A shared employer alone, or a name spelled in a free
 *   mailbox address, stays a suggestion the student confirms: namesakes are common, at big employers most of all;
 * - an initial (P. Patel) never auto-merges, nor does a look-alike employer (Bain Capital for Bain & Company).
 */
export function scorePair(
  inc: IncomingIdentity,
  cand: Person,
  ctx: ResolveContext,
): { score: number; features: ResolveFeatures } {
  const f = computeFeatures(inc, cand, ctx);
  const incName = incomingName(inc);
  if (!incName.full || isPlaceholderName(cand)) {
    // a numbered address (mchen2@) at the employer may be any of its Michael Chens: asked, not merged
    const sc = addressOnlyScore(f);
    const numbered = [inc.email, cand.primaryEmail].some((e) => !!e && numberedAddress(e));
    return { score: numbered ? Math.min(sc, AUTO_MERGE_THRESHOLD - 0.01) : sc, features: f };
  }
  // an address at the employer both already list is the employer again, not a second piece of evidence:
  // colleagues share it
  const scored = f.org_match > 0 && f.domain_org_match > 0 ? { ...f, domain_org_match: 0 } : f;
  let score = scoreFeatures(scored);
  // the names have to agree before anything else counts (Priya Patel and Arjun Patel at Figma are two people)
  if (f.name_sim < 0.5) score = Math.min(score, SUGGEST_THRESHOLD - 0.01);
  const names = namesOf(inc, cand);
  const independent = workAddressFits(inc, cand, ctx) || f.school_match > 0;
  if (
    score >= AUTO_MERGE_THRESHOLD &&
    // a bare initial fits many colleagues (Priya and Pooja Patel), and a look-alike employer is another firm
    (!independent || names.given === 'initial' || employerConflict(inc, cand, ctx, f))
  )
    score = AUTO_MERGE_THRESHOLD - 0.01;
  // Name and employer alone never tell two namesakes at one company apart (§2.5)
  if (f.org_match > 0 && !independent) score = Math.min(score, NAME_ORG_ONLY_CAP);
  return { score, features: f };
}

/**
 * Two different LinkedIn profiles are two people, whatever their names and employers say: namesakes are common, and
 * LinkedIn gives each person one profile. Matching by name is only for joining someone's mail to their LinkedIn.
 */
export function differentLinkedInProfiles(
  a:
    | Pick<Person, 'linkedinSlug' | 'linkedinUrl' | 'linkedinMemberId'>
    | { linkedinSlug?: string; linkedinMemberId?: string },
  b: Pick<Person, 'linkedinSlug' | 'linkedinUrl' | 'linkedinMemberId'>,
): boolean {
  const slugOf = (p: { linkedinSlug?: string; linkedinUrl?: string }) =>
    p.linkedinSlug ?? linkedInSlug(p.linkedinUrl) ?? undefined;
  const sa = slugOf(a);
  const sb = slugOf(b);
  if (sa && sb) return sa !== sb;
  const ma = a.linkedinMemberId;
  const mb = b.linkedinMemberId;
  return !!ma && !!mb && ma !== mb;
}

/**
 * Two people whose phone numbers are all different, each set from the student's Contacts, are two people (plan 17
 * §A hard negatives): a Contacts card is one person, and two cards with their own numbers are two. `aVerified` says
 * whether the first side's numbers come from Contacts (a stored person's numbers always do: Orbit files a number on
 * someone only from Contacts or a number already theirs).
 */
export function differentPhones(
  a: { phones?: readonly string[] },
  b: { phones?: readonly string[] },
  aVerified = true,
): boolean {
  if (!aVerified || !a.phones?.length || !b.phones?.length) return false;
  return !a.phones.some((x) => b.phones!.includes(x));
}

/** True when two people share a phone number. */
export function sharePhone(a: { phones?: readonly string[] }, b: { phones?: readonly string[] }): boolean {
  return !!a.phones?.length && !!b.phones?.length && a.phones.some((x) => b.phones!.includes(x));
}

/**
 * A number shared by people whose names say otherwise ("Mom" and "Jane Doe" on one home line; a phone passed on):
 * the number is not enough on its own, the student is asked.
 */
function namesConflict(a: string | NameParts, b: string | NameParts): boolean {
  const c = compareNames(a, b);
  return c.score === 0 && c.given === 'different';
}

export function resolveIdentity(inc: IncomingIdentity, ctx: ResolveContext): ResolveDecision {
  const email = inc.email ? normalizeEmail(inc.email) : undefined;
  const slug = linkedInSlug(inc.linkedinUrl);
  const memberId = inc.linkedinMemberId || undefined;
  const phones = [...new Set((inc.phones ?? []).filter(Boolean))];
  if (email && isRoleAddress(email) && !slug && !memberId) return { kind: 'role' };
  // the student said these are not the same person: never offered again, whatever the evidence
  const people = ctx.people.filter((p) => p.id !== inc.personId && !rejected(ctx, inc.personId, p.id));
  const incName = incomingName(inc);
  const profile = { linkedinSlug: slug, linkedinMemberId: memberId };
  // deterministic: an address, a LinkedIn profile (URL or member id), a phone number
  for (const p of people) {
    if (email && (p.primaryEmail === email || p.emails.includes(email))) {
      const mergeWith = sameMailboxOtherName(p, incName, people, ctx);
      return { kind: 'match', personId: p.id, via: 'email', ...(mergeWith.length ? { mergeWith } : {}) };
    }
  }
  if (slug)
    for (const p of people)
      if (p.linkedinSlug === slug) return { kind: 'match', personId: p.id, via: 'linkedin' };
  if (memberId)
    for (const p of people)
      if (p.linkedinMemberId === memberId && !differentLinkedInProfiles(profile, p))
        return { kind: 'match', personId: p.id, via: 'linkedin' };
  if (phones.length) {
    const owners = people.filter((p) => sharePhone(p, { phones }) && !differentLinkedInProfiles(profile, p));
    // several people on one number (a family line): the one whose name agrees, if any
    const owner =
      owners.find((p) => !incName.full || isPlaceholderName(p) || !namesConflict(incName, p.displayName)) ??
      owners[0];
    if (owner) {
      if (incName.full && !isPlaceholderName(owner) && namesConflict(incName, owner.displayName))
        return {
          kind: 'suggest',
          personId: owner.id,
          score: SUGGEST_THRESHOLD + 0.1,
          features: computeFeatures(inc, owner, ctx),
        };
      return { kind: 'match', personId: owner.id, via: 'phone' };
    }
  }
  // hard negatives: someone with another LinkedIn profile, or with their own Contacts numbers, is someone else
  const others = people.filter(
    (p) => !differentLinkedInProfiles(profile, p) && !differentPhones({ phones }, p, !!inc.phonesVerified),
  );
  if (!incName.full && !email) return { kind: 'new' };
  // blocking: only score people who could plausibly be the same
  const incOrg = normalizeCompany(inc.companyRaw);
  const incDomain = email ? emailDomain(email) : undefined;
  const incKeys = incName.full ? new Set(nameBlockKeys(foldName(incName))) : new Set<string>();
  const incFolded = incName.full ? foldName(incName) : undefined;
  const foldedKey = (f: FoldedName) => [f.given, ...f.surnames].join(' ');
  const candidates = others.filter((p) => {
    const placeholder = isPlaceholderName(p);
    const pDomains = [...new Set([p.primaryEmail, ...p.emails].filter(Boolean).map((e) => emailDomain(e!)))];
    if (!incName.full || placeholder) {
      // address-only on one side: same domain, or an address that fits the other side's name
      if (incDomain && pDomains.includes(incDomain)) return true;
      if (incDomain && !PERSONAL_EMAIL_DOMAINS.has(incDomain)) return true;
      return placeholder && !!incName.full && pDomains.length > 0;
    }
    const pf = foldName(p.displayName);
    if (nameBlockKeys(pf).some((k) => incKeys.has(k))) return true;
    const related = givenNamesRelated(incFolded!, pf);
    if (related && (incOrg ? normalizeCompany(p.currentOrganizationRaw) === incOrg : true)) return true;
    if (incDomain && pDomains.includes(incDomain) && related) return true;
    return jaroWinkler(foldedKey(pf), foldedKey(incFolded!)) >= 0.85;
  });
  const scored = candidates.map((p) => ({ p, ...scorePair(inc, p, ctx) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { kind: 'new' };
  // two people fit as well as each other: which one is a question for the student (they may be one person too)
  const tied = (scored[1]?.score ?? 0) >= AUTO_MERGE_THRESHOLD;
  if (best.score >= AUTO_MERGE_THRESHOLD && !tied)
    return { kind: 'probable', personId: best.p.id, score: best.score, features: best.features };
  if (best.score >= SUGGEST_THRESHOLD)
    return {
      kind: 'suggest',
      personId: best.p.id,
      score: Math.min(best.score, AUTO_MERGE_THRESHOLD - 0.01),
      features: best.features,
    };
  return { kind: 'new' };
}

/**
 * Pairwise duplicate detection across an existing people list (run after imports). Only pairs whose names
 * agree (or that share an address, profile or phone number) are scored, so colleagues who share a surname and an
 * employer are not mistaken for one person; each pair is scored in both directions and the stronger reading wins.
 * Two LinkedIn profiles, two sets of Contacts numbers, and pairs the student rejected are never paired.
 */
export function findDuplicatePairs(
  people: Person[],
  ctx: Omit<ResolveContext, 'people'> = {},
): { a: Person; b: Person; score: number; features: ResolveFeatures }[] {
  const out: { a: Person; b: Person; score: number; features: ResolveFeatures }[] = [];
  // blocking: the name's keys (surname, its usual spellings and sound, both word orders), a shared address, phone
  // number or LinkedIn member id
  const blocks = new Map<string, Person[]>();
  const add = (key: string, p: Person) => {
    const arr = blocks.get(key) ?? [];
    if (!arr.includes(p)) arr.push(p);
    blocks.set(key, arr);
  };
  for (const p of people) {
    if (!p.isHuman) continue;
    if (!isPlaceholderName(p)) for (const k of nameBlockKeys(foldName(p.displayName))) add(`name:${k}`, p);
    for (const e of new Set([p.primaryEmail, ...p.emails].filter(Boolean)))
      add(`email:${normalizeEmail(e!)}`, p);
    for (const ph of new Set(p.phones ?? [])) add(`phone:${ph}`, p);
    if (p.linkedinMemberId) add(`member:${p.linkedinMemberId}`, p);
    if (isPlaceholderName(p) && p.primaryEmail) {
      // a bare address can only be linked through its domain
      const dom = emailDomain(normalizeEmail(p.primaryEmail));
      if (!PERSONAL_EMAIL_DOMAINS.has(dom)) add(`domain:${dom}`, p);
    }
  }
  for (const p of people) {
    if (!p.isHuman || isPlaceholderName(p)) continue;
    const doms = new Set(
      [p.primaryEmail, ...p.emails].filter(Boolean).map((e) => emailDomain(normalizeEmail(e!))),
    );
    const org = normalizeCompany(p.currentOrganizationRaw).replace(/[\s&]+/g, '');
    for (const key of blocks.keys()) {
      if (!key.startsWith('domain:')) continue;
      const d = key.slice(7);
      const root = d.split('.').slice(-2, -1)[0] ?? '';
      if (doms.has(d) || (org && root.length >= 3 && org.includes(root))) add(key, p);
    }
  }
  const seen = new Set<string>();
  const asIncoming = (p: Person): IncomingIdentity => ({
    displayName: isPlaceholderName(p) ? undefined : p.displayName,
    email: p.primaryEmail,
    linkedinUrl: p.linkedinUrl,
    linkedinMemberId: p.linkedinMemberId,
    phones: p.phones,
    phonesVerified: true,
    companyRaw: p.currentOrganizationRaw,
    title: p.currentTitle,
    school: p.school,
    source: 'manual',
  });
  const full = { people, ...ctx };
  for (const group of blocks.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(key) || rejected(ctx, a.id, b.id)) continue;
        seen.add(key);
        // two LinkedIn profiles are two people: a merge is only ever offered to join mail to a LinkedIn profile
        if (differentLinkedInProfiles(a, b)) continue;
        // two people with their own, different numbers from Contacts are two people
        if (differentPhones(a, b)) continue;
        const emailsA = new Set([a.primaryEmail, ...a.emails].filter(Boolean).map((e) => normalizeEmail(e!)));
        const sharedAddress = [b.primaryEmail, ...b.emails].some((e) => e && emailsA.has(normalizeEmail(e)));
        const sharedProfile =
          (!!a.linkedinSlug && a.linkedinSlug === b.linkedinSlug) ||
          (!!a.linkedinMemberId && a.linkedinMemberId === b.linkedinMemberId);
        const named = !isPlaceholderName(a) && !isPlaceholderName(b);
        const nameScore = named ? compareNames(foldName(a.displayName), foldName(b.displayName)).score : 1;
        if (sharedAddress || sharedProfile || sharePhone(a, b)) {
          const features = computeFeatures(asIncoming(a), b, full);
          // one number under two names that disagree (a home line): a question, not a certainty
          const conflict =
            !sharedAddress && !sharedProfile && named && namesConflict(a.displayName, b.displayName);
          out.push({ a, b, score: conflict ? SUGGEST_THRESHOLD + 0.1 : 1, features });
          continue;
        }
        // names that do not agree are never a suggestion (scorePair caps them below the bar): not scored at all
        if (nameScore < 0.5) continue;
        let best: { score: number; features: ResolveFeatures } | undefined;
        for (const [x, y] of [
          [a, b],
          [b, a],
        ] as const) {
          // scorePair requires agreeing names and counts a shared employer once
          const { score, features } = scorePair(asIncoming(x), y, full);
          if (!best || score > best.score) best = { score, features };
        }
        if (best && best.score >= SUGGEST_THRESHOLD) out.push({ a, b, ...best });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * People an address proves to be its owner under another name: the incoming name is a full name, it is the name of
 * someone known only from LinkedIn (no address of their own to disagree, no other LinkedIn profile or numbers than
 * the owner's), and the owner's own first name is that name or a nickname of it with the same surname. The same
 * mailbox writing as "Liz Chen" and as "Elizabeth Chen" is one person; a LinkedIn-only "Elizabeth Chen" is then that
 * person too.
 */
function sameMailboxOtherName(
  owner: Person,
  incName: NameParts,
  people: Person[],
  ctx: Pick<ResolveContext, 'doNotMerge'>,
): string[] {
  if (!incName.full || !incName.first || !incName.last || isPlaceholderName(owner)) return [];
  if (!nameAgreement(owner.displayName, incName)) return [];
  const out: string[] = [];
  for (const p of people) {
    if (p.id === owner.id || isPlaceholderName(p) || rejected(ctx, owner.id, p.id)) continue;
    if (p.primaryEmail || p.emails.length || !(p.linkedinSlug || p.linkedinUrl || p.linkedinMemberId))
      continue;
    if (differentLinkedInProfiles(owner, p) || differentPhones(owner, p)) continue;
    if (nameAgreement(p.displayName, incName) !== 'same') continue;
    out.push(p.id);
  }
  return out;
}
