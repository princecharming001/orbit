import { jaroWinkler, tokenJaccard } from '../text/jaro';
import {
  canonicalFirstName,
  emailDomain,
  emailLocalPart,
  firstNameRelation,
  linkedInSlug,
  type NameParts,
  nameFromParts,
  normalizeCompany,
  normalizeEmail,
  parseName,
  stripDiacritics,
} from '../text/normalize';
import type { Affiliation, Person, PersonSource } from '../types';

export interface IncomingIdentity {
  email?: string;
  linkedinUrl?: string;
  displayName?: string;
  /** Separate name fields when the source has them (LinkedIn CSV); they win over `displayName`. */
  firstName?: string;
  lastName?: string;
  companyRaw?: string;
  title?: string;
  school?: string;
  source: PersonSource;
}

export interface ResolveFeatures {
  name_sim: number;
  last_sim: number;
  org_match: number;
  title_sim: number;
  email_name_sim: number;
  domain_org_match: number;
  school_match: number;
}

export const RESOLVE_WEIGHTS: Record<keyof ResolveFeatures, number> & { bias: number } = {
  name_sim: 3.0,
  last_sim: 1.5,
  org_match: 2.0,
  title_sim: 0.5,
  email_name_sim: 1.5,
  domain_org_match: 1.5,
  school_match: 0.5,
  bias: -3.5,
};

export const AUTO_MERGE_THRESHOLD = 0.92;
export const SUGGEST_THRESHOLD = 0.6;

export type ResolveDecision =
  | { kind: 'match'; personId: string; via: 'email' | 'linkedin' | 'name_org' }
  | { kind: 'probable'; personId: string; score: number; features: ResolveFeatures }
  | { kind: 'suggest'; personId: string; score: number; features: ResolveFeatures }
  | { kind: 'new' };

export interface ResolveContext {
  people: Person[];
  affiliationsByPerson?: Map<string, Affiliation[]>;
  orgDomains?: Map<string, string[]>; // organizationId -> domains
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

/** The incoming name, from separate first/last fields when present, otherwise the display name. */
export function incomingName(inc: IncomingIdentity): NameParts {
  return inc.firstName || inc.lastName
    ? nameFromParts(inc.firstName, inc.lastName)
    : parseName(inc.displayName);
}

const fold = (s: string) => stripDiacritics(s).toLowerCase();

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
    const forms = new Set<string>();
    for (const f of [first, canon]) {
      forms.add(`${f}${last}`);
      forms.add(`${f[0] ?? ''}${last}`);
      forms.add(`${last}${f}`);
      forms.add(`${f}${last[0] ?? ''}`);
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

export function computeFeatures(inc: IncomingIdentity, cand: Person, ctx: ResolveContext): ResolveFeatures {
  const incName = incomingName(inc);
  const candName = parseName(cand.displayName);
  const candPlaceholder = isPlaceholderName(cand);
  // Jaro-Winkler is generous (two different names often score 0.7); rescale so only near-identical names count.
  const rescale = (jw: number) => Math.max(0, (jw - 0.75) / 0.25);
  const rel = firstNameRelation(incName.first, candName.first);
  let nameSim = 0;
  let lastSim = 0;
  if (incName.full && candName.full && !candPlaceholder) {
    const a = rel === 'nickname' ? canonicalFirstName(incName.first) : fold(incName.first);
    const b = rel === 'nickname' ? canonicalFirstName(candName.first) : fold(candName.first);
    nameSim = rescale(jaroWinkler(`${a} ${fold(incName.last)}`, `${b} ${fold(candName.last)}`));
    lastSim =
      incName.last && candName.last ? rescale(jaroWinkler(fold(incName.last), fold(candName.last))) : 0;
    // a shared short form (Alex: Alexander or Alexandra) is a weaker match than a real nickname
    if (rel === 'ambiguous') nameSim = Math.min(0.8, Math.max(nameSim, lastSim === 1 ? 0.8 : 0));
    // "P. Patel" and "Priya Patel": a matching initial with the same surname is a partial name match
    if (lastSim === 1 && initialMatches(incName.first, candName.first)) nameSim = Math.max(nameSim, 0.6);
  }
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
    else orgMatch = nameSim === 1 && lastSim === 1 && rel === 'same' ? -0.25 : -0.5;
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
    w.school_match * f.school_match;
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

/**
 * Evidence that does not come from the name itself. Auto-merging always needs some; when the first names
 * differ in writing (Bill/William, Alex/Alexandra) it must come from the address or the school, because a
 * shared employer is not enough to tell two colleagues apart.
 */
function corroborated(
  f: ResolveFeatures,
  rel: ReturnType<typeof firstNameRelation>,
  incomingAddressFitsName: number,
): boolean {
  // Only the incoming address can say something new: the stored person's own address fitting the incoming
  // name repeats the name match, so it never corroborates on its own.
  const independent = incomingAddressFitsName >= 0.7 || f.domain_org_match > 0 || f.school_match > 0;
  if (rel !== 'same') return independent;
  // only the very same employer counts: "Bain" and "Bain Capital" look alike but are different firms
  return independent || f.org_match >= 1;
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

export function scorePair(
  inc: IncomingIdentity,
  cand: Person,
  ctx: ResolveContext,
): { score: number; features: ResolveFeatures } {
  const f = computeFeatures(inc, cand, ctx);
  const incName = incomingName(inc);
  if (!incName.full || isPlaceholderName(cand)) return { score: addressOnlyScore(f), features: f };
  // an address at the employer both already list is the employer again, not a second piece of evidence:
  // colleagues share it
  const scored = f.org_match > 0 && f.domain_org_match > 0 ? { ...f, domain_org_match: 0 } : f;
  let score = scoreFeatures(scored);
  // the names have to agree before anything else counts (Priya Patel and Arjun Patel at Figma are two people)
  if (f.name_sim < 0.5) score = Math.min(score, SUGGEST_THRESHOLD - 0.01);
  const candName = parseName(cand.displayName);
  const rel = firstNameRelation(incName.first, candName.first);
  const incomingAddressFitsName = inc.email ? emailEvidence(inc.email, candName, '', [], true).nameSim : 0;
  if (
    score >= AUTO_MERGE_THRESHOLD &&
    // a bare initial fits many colleagues (Priya and Pooja Patel), and a look-alike employer is another firm
    (!corroborated(f, rel, incomingAddressFitsName) ||
      initialMatches(incName.first, candName.first) ||
      employerConflict(inc, cand, ctx, f))
  )
    score = AUTO_MERGE_THRESHOLD - 0.01;
  return { score, features: f };
}

export function resolveIdentity(inc: IncomingIdentity, ctx: ResolveContext): ResolveDecision {
  const email = inc.email ? normalizeEmail(inc.email) : undefined;
  const slug = linkedInSlug(inc.linkedinUrl);
  // deterministic
  for (const p of ctx.people) {
    if (email && (p.primaryEmail === email || p.emails.includes(email)))
      return { kind: 'match', personId: p.id, via: 'email' };
  }
  if (slug)
    for (const p of ctx.people)
      if (p.linkedinSlug === slug) return { kind: 'match', personId: p.id, via: 'linkedin' };
  const incName = incomingName(inc);
  const incOrg = normalizeCompany(inc.companyRaw);
  if (incName.normalized && incOrg) {
    for (const p of ctx.people) {
      if (isPlaceholderName(p)) continue;
      if (
        parseName(p.displayName).normalized === incName.normalized &&
        normalizeCompany(p.currentOrganizationRaw) === incOrg
      )
        return { kind: 'match', personId: p.id, via: 'name_org' };
    }
  }
  if (!incName.full && !email) return { kind: 'new' };
  // blocking: only score people who could plausibly be the same
  const lastFold = fold(incName.last);
  const incDomain = email ? emailDomain(email) : undefined;
  const candidates = ctx.people.filter((p) => {
    const placeholder = isPlaceholderName(p);
    const pDomains = [...new Set([p.primaryEmail, ...p.emails].filter(Boolean).map((e) => emailDomain(e!)))];
    if (!incName.full || placeholder) {
      // address-only on one side: same domain, or an address that fits the other side's name
      if (incDomain && pDomains.includes(incDomain)) return true;
      if (incDomain && !PERSONAL_EMAIL_DOMAINS.has(incDomain)) return true;
      return placeholder && !!incName.full && pDomains.length > 0;
    }
    const pn = parseName(p.displayName);
    if (lastFold && fold(pn.last) === lastFold) return true;
    const rel = firstNameRelation(incName.first, pn.first);
    if (rel !== 'different' && (incOrg ? normalizeCompany(p.currentOrganizationRaw) === incOrg : true))
      return true;
    if (incDomain && pDomains.includes(incDomain) && rel !== 'different') return true;
    return jaroWinkler(pn.normalized, incName.normalized) >= 0.85;
  });
  let best: { p: Person; score: number; f: ResolveFeatures } | undefined;
  for (const p of candidates) {
    const { score, features } = scorePair(inc, p, ctx);
    if (!best || score > best.score) best = { p, score, f: features };
  }
  if (!best) return { kind: 'new' };
  if (best.score >= AUTO_MERGE_THRESHOLD)
    return { kind: 'probable', personId: best.p.id, score: best.score, features: best.f };
  if (best.score >= SUGGEST_THRESHOLD)
    return { kind: 'suggest', personId: best.p.id, score: best.score, features: best.f };
  return { kind: 'new' };
}

/**
 * Pairwise duplicate detection across an existing people list (run after imports). Only pairs whose names
 * agree (or that share an address or profile) are scored, so colleagues who share a surname and an employer
 * are not mistaken for one person; each pair is scored in both directions and the stronger reading wins.
 */
export function findDuplicatePairs(
  people: Person[],
  ctx: Omit<ResolveContext, 'people'> = {},
): { a: Person; b: Person; score: number; features: ResolveFeatures }[] {
  const out: { a: Person; b: Person; score: number; features: ResolveFeatures }[] = [];
  // blocking: same folded surname, or a shared address
  const blocks = new Map<string, Person[]>();
  const add = (key: string, p: Person) => {
    const arr = blocks.get(key) ?? [];
    if (!arr.includes(p)) arr.push(p);
    blocks.set(key, arr);
  };
  for (const p of people) {
    if (!p.isHuman) continue;
    const l = fold(parseName(p.displayName).last);
    if (l && !isPlaceholderName(p)) add(`last:${l}`, p);
    for (const e of new Set([p.primaryEmail, ...p.emails].filter(Boolean)))
      add(`email:${normalizeEmail(e!)}`, p);
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
        if (seen.has(key)) continue;
        seen.add(key);
        const emailsA = new Set([a.primaryEmail, ...a.emails].filter(Boolean).map((e) => normalizeEmail(e!)));
        const sharedAddress = [b.primaryEmail, ...b.emails].some((e) => e && emailsA.has(normalizeEmail(e)));
        const sharedProfile = !!a.linkedinSlug && a.linkedinSlug === b.linkedinSlug;
        if (sharedAddress || sharedProfile) {
          out.push({ a, b, score: 1, features: computeFeatures(asIncoming(a), b, full) });
          continue;
        }
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
