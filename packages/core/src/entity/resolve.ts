import { jaroWinkler, tokenJaccard } from '../text/jaro';
import {
  canonicalFirstName,
  emailDomain,
  emailLocalPart,
  linkedInSlug,
  normalizeCompany,
  normalizeEmail,
  parseName,
} from '../text/normalize';
import type { Affiliation, Person, PersonSource } from '../types';

export interface IncomingIdentity {
  email?: string;
  linkedinUrl?: string;
  displayName?: string;
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

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function computeFeatures(inc: IncomingIdentity, cand: Person, ctx: ResolveContext): ResolveFeatures {
  const incName = parseName(inc.displayName);
  const candName = parseName(cand.displayName);
  const incFirst = canonicalFirstName(incName.first);
  const candFirst = canonicalFirstName(candName.first);
  // Jaro-Winkler is generous (two different names often score 0.7); rescale so only near-identical names count.
  const rescale = (jw: number) => Math.max(0, (jw - 0.75) / 0.25);
  const nameSim =
    incName.full && candName.full
      ? rescale(
          jaroWinkler(
            `${incFirst} ${incName.last}`.toLowerCase(),
            `${candFirst} ${candName.last}`.toLowerCase(),
          ),
        )
      : 0;
  const lastSim =
    incName.last && candName.last
      ? rescale(jaroWinkler(incName.last.toLowerCase(), candName.last.toLowerCase()))
      : 0;
  const incOrg = normalizeCompany(inc.companyRaw);
  const candOrg = normalizeCompany(cand.currentOrganizationRaw);
  let orgMatch = 0;
  if (incOrg && candOrg) {
    if (incOrg === candOrg) orgMatch = 1;
    else if (jaroWinkler(incOrg, candOrg) >= 0.9) orgMatch = 0.5;
    else orgMatch = -0.5;
  }
  const titleSim = inc.title && cand.currentTitle ? tokenJaccard(inc.title, cand.currentTitle) : 0;
  let emailNameSim = 0;
  let domainOrgMatch = 0;
  const email = inc.email ? normalizeEmail(inc.email) : undefined;
  if (email) {
    const local = emailLocalPart(email)
      .replace(/[\d._-]+/g, ' ')
      .trim();
    if (candName.full) {
      const fl = `${candFirst}${candName.last}`.toLowerCase();
      const fil = `${candFirst[0] ?? ''}${candName.last}`.toLowerCase();
      const compact = local.replace(/\s+/g, '');
      if (
        compact &&
        (compact === fl || compact === fil || compact === `${candName.last}${candFirst}`.toLowerCase())
      )
        emailNameSim = 1;
      else if (compact && compact.includes(candName.last.toLowerCase()) && candName.last.length >= 4)
        emailNameSim = 0.7;
      else emailNameSim = Math.max(jaroWinkler(compact, fl), jaroWinkler(compact, fil)) * 0.6;
    }
    const dom = emailDomain(email);
    const candDomains = cand.currentOrganizationId
      ? (ctx.orgDomains?.get(cand.currentOrganizationId) ?? [])
      : [];
    if (candDomains.includes(dom)) domainOrgMatch = 1;
    else if (candOrg && dom.split('.')[0] && candOrg.replace(/\s+/g, '').includes(dom.split('.')[0]!))
      domainOrgMatch = 0.8;
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
  const incName = parseName(inc.displayName);
  const incOrg = normalizeCompany(inc.companyRaw);
  if (incName.normalized && incOrg) {
    for (const p of ctx.people) {
      if (p.nameNormalized === incName.normalized && normalizeCompany(p.currentOrganizationRaw) === incOrg)
        return { kind: 'match', personId: p.id, via: 'name_org' };
    }
  }
  if (!incName.full) return { kind: 'new' };
  // blocking
  const lastLower = incName.last.toLowerCase();
  const firstCanon = canonicalFirstName(incName.first);
  const candidates = ctx.people.filter((p) => {
    const pn = parseName(p.displayName);
    if (lastLower && pn.last.toLowerCase() === lastLower) return true;
    if (
      firstCanon &&
      canonicalFirstName(pn.first) === firstCanon &&
      (incOrg ? normalizeCompany(p.currentOrganizationRaw) === incOrg : true)
    )
      return true;
    if (
      email &&
      p.primaryEmail &&
      emailDomain(p.primaryEmail) === emailDomain(email) &&
      canonicalFirstName(pn.first) === firstCanon
    )
      return true;
    return jaroWinkler(pn.normalized, incName.normalized) >= 0.85;
  });
  let best: { p: Person; score: number; f: ResolveFeatures } | undefined;
  for (const p of candidates) {
    const f = computeFeatures(inc, p, ctx);
    const score = scoreFeatures(f);
    if (!best || score > best.score) best = { p, score, f };
  }
  if (!best) return { kind: 'new' };
  if (best.score >= AUTO_MERGE_THRESHOLD)
    return { kind: 'probable', personId: best.p.id, score: best.score, features: best.f };
  if (best.score >= SUGGEST_THRESHOLD)
    return { kind: 'suggest', personId: best.p.id, score: best.score, features: best.f };
  return { kind: 'new' };
}

/** Pairwise duplicate detection across an existing people list (used after imports). */
export function findDuplicatePairs(
  people: Person[],
  ctx: Omit<ResolveContext, 'people'> = {},
): { a: Person; b: Person; score: number; features: ResolveFeatures }[] {
  const out: { a: Person; b: Person; score: number; features: ResolveFeatures }[] = [];
  const byLast = new Map<string, Person[]>();
  for (const p of people) {
    const l = parseName(p.displayName).last.toLowerCase();
    if (!l) continue;
    const arr = byLast.get(l) ?? [];
    arr.push(p);
    byLast.set(l, arr);
  }
  for (const group of byLast.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const f = computeFeatures(
          {
            displayName: a.displayName,
            email: a.primaryEmail,
            companyRaw: a.currentOrganizationRaw,
            title: a.currentTitle,
            school: a.school,
            source: 'manual',
          },
          b,
          { people, ...ctx },
        );
        const score = scoreFeatures(f);
        if (score >= SUGGEST_THRESHOLD) out.push({ a, b, score, features: f });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
