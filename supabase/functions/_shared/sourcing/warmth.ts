/**
 * Who is warmest among people found outside the student's network, in five tiers, warmest first:
 *   1. in your world      they are already someone Orbit knows the student has talked to (Gmail, LinkedIn, texts,
 *                         a meeting)
 *   2. one hop away       someone the student is warm with works at their company or school: ask for an intro
 *   3. shared identity    same school, a company the student worked at, the student's hometown
 *   4. open door          their page says students can write to them (office hours, "email me", mentoring), or
 *                         they finished school recently
 *   5. cold, relevant     nothing shared, but what they work on is on the student's résumé (the reason to write)
 * A tier moves a candidate up the list; inside a tier the fit to the ask still decides. Everything here is pure:
 * run.ts loads the student's context and their warm contacts once per search.
 */
import { norm, normOrg } from '../research/guards';
import type { Candidate } from './search';

export type WarmthTier = 1 | 2 | 3 | 4 | 5;

export interface Warmth {
  tier: WarmthTier;
  /** one short reason the student can read, in plain words */
  why?: string;
  /** the warm contact to ask for an intro (tier 2) */
  bridge?: { personId: string; name: string };
}

/** What Orbit knows about the student, from their profile and résumé. */
export interface StudentContext {
  school?: string;
  /** every company and school on the résumé, as written */
  orgs: string[];
  homeCity?: string;
  /** topics from the résumé (skills, projects, keywords) */
  interests: string[];
  /** the student's own graduation year, to tell a recent graduate */
  gradYear?: number;
}

/** A warm contact: someone the student is close enough to ask. */
export interface WarmContact {
  personId: string;
  name: string;
  score: number;
  org?: string;
  email?: string;
}

/** The student's contacts with a 40+ tie score count as warm (tieScore.ts: 40 is "warm"). */
export const WARM_SCORE = 40;
/** A known person this close or closer is "in your world"; below it they are a name Orbit has seen. */
export const KNOWN_SCORE = 20;

/** How far a tier lifts a candidate, scaled by fit so a warm stranger to the ask does not top the list. */
export const TIER_BONUS: Record<WarmthTier, number> = { 1: 0.6, 2: 0.45, 3: 0.3, 4: 0.15, 5: 0 };

/** Plain labels for the card. */
export const TIER_LABELS: Record<WarmthTier, string> = {
  1: 'You know them',
  2: 'Intro possible',
  3: 'Shared background',
  4: 'Open to students',
  5: 'Cold',
};

const PUBLIC_MAIL =
  /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|mac|aol|proton|protonmail|msn|comcast|ymail|gmx|hey)\./i;

/** The work domain of an address, or undefined for a public mailbox. */
export function workDomain(email: string | undefined): string | undefined {
  const d = norm(email?.split('@')[1]);
  return d && !PUBLIC_MAIL.test(d) ? d : undefined;
}

/** The site's domain without www, when it is not a profile or social site. */
export function siteDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (/linkedin|twitter|x\.com|github|facebook|instagram|medium|substack|google|youtube|wikipedia/.test(h))
      return undefined;
    return registrable(h);
  } catch {
    return undefined;
  }
}

/** "team.beta.io" → "beta.io", "eecs.berkeley.edu" → "berkeley.edu", "www.beta.co.uk" → "beta.co.uk". */
export function registrable(host: string): string {
  const parts = host.split('.').filter(Boolean);
  const keep =
    parts.length >= 3 && /^(co|com|ac|org|net|gov|edu)$/.test(parts.at(-2)!) && parts.at(-1)!.length === 2
      ? 3
      : 2;
  return parts.slice(-keep).join('.');
}

const words = (s: string) =>
  norm(s)
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'university',
  'college',
  'school',
  'inc',
  'llc',
  'company',
  'team',
  'group',
  'lab',
  'labs',
  'new',
  'work',
  'working',
  'skills',
  'business',
  'product',
]);

/** Two org names are the same place: equal once normalized, or one is the other plus a qualifier. */
export function sameOrg(a: string | undefined, b: string | undefined): boolean {
  const x = normOrg(a);
  const y = normOrg(b);
  if (!x || !y || x.length < 2 || y.length < 2) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3 || !long.startsWith(`${short} `)) return false;
  // "Google Cloud", "Stripe Labs": the rest is a qualifier, not a different company ("Apple Hospitality REIT")
  return long
    .slice(short.length)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .every((w) => ORG_QUALIFIERS.has(w));
}

const ORG_QUALIFIERS = new Set([
  'inc',
  'labs',
  'lab',
  'ai',
  'hq',
  'cloud',
  'research',
  'technologies',
  'technology',
  'tech',
  'group',
  'holdings',
  'corp',
  'corporation',
  'company',
  'co',
  'global',
  'us',
  'usa',
  'america',
  'americas',
  'international',
  'io',
  'app',
  'platforms',
  'platform',
  'software',
  'systems',
  'health',
  'financial',
  'capital',
  'ventures',
  'deepmind',
  'ads',
  'web services',
  'aws',
  'payments',
  'pay',
]);

/** A YC batch or a funding note in parentheses ("Corgi (YC24)", "daisy (ef-backed)") is not a company. */
const NOT_AN_ORG =
  /^(?:yc|y combinator)?\s*[wsfx]?\s*'?\d{2,4}$|^(?:yc|ycombinator)\b|backed$|^(?:jsv|ef)\b|^(?:stealth|stealth mode|self[- ]employed|freelance|home)$/i;

/**
 * The companies a messy LinkedIn org or headline names: "Stripe | TransferED Consultant | Berkeley Haas" → Stripe,
 * TransferED Consultant, Berkeley Haas; "Twitch (Amazon)" → Twitch, Amazon; "Intuit, ex-PayPal" → Intuit (an ex- is
 * where they were, not where they are); "SpaceX, Adobe" → both.
 */
export function orgNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const add = (x: string) => {
    const t = x
      .replace(/[^\p{L}\p{N}&.' -]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length < 2 || t.length > 40 || NOT_AN_ORG.test(t) || /^(ex|former|prev|previously)\b/i.test(t))
      return;
    if (
      normOrg(t)
        .split(' ')
        .every((w) => ORG_QUALIFIERS.has(w))
    )
      return;
    if (!out.some((o) => normOrg(o) === normOrg(t))) out.push(t);
  };
  for (const part of raw.split(/\s*(?:[|•·│┃]+|\/\/|\s[-–—]\s|;|,\s*(?:an?\s)?)\s*/)) {
    const inParens = [...part.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!);
    add(part.replace(/\([^)]*\)/g, ' '));
    for (const p of inParens) add(p);
  }
  return out;
}

/** The company a headline names after "@" or " at ", else a headline of a word or two with no role in it ("Stripe"). */
export function headlineOrgs(headline: string | undefined): string[] {
  const h = headline ?? '';
  if (!h.trim()) return [];
  const at = h.match(/(?:@|\bat\s)\s*([^|•·,;]+)/i)?.[1];
  if (at) return orgNames(at);
  if (
    h.trim().split(/\s+/).length <= 2 &&
    !/\b(engineer|manager|founder|student|product|designer|analyst|investor|researcher)\b/i.test(h)
  )
    return orgNames(h);
  return [];
}

/** Where a candidate works: their org, else what the headline says. */
export function orgsOf(c: Candidate): string[] {
  const fromOrg = orgNames(c.org);
  return fromOrg.length ? fromOrg : headlineOrgs(c.headline);
}

/** "University of California, Berkeley" also reads as "UC Berkeley" and "Berkeley". */
export function schoolNames(school: string | undefined): string[] {
  const s = norm(school);
  if (!s) return [];
  const out = new Set([s]);
  const uc = s.match(/^university of california,?\s+(.+)$/);
  if (uc?.[1]) {
    out.add(`uc ${uc[1]}`);
    out.add(uc[1]);
    // Berkeley's business school names the school on its own, in any spacing
    if (uc[1] === 'berkeley') for (const a of ['cal', 'haas', 'berkeleyhaas', 'berkeley haas']) out.add(a);
  }
  const of = s.match(/^(.+?) university$/);
  if (of?.[1] && of[1].length >= 4) out.add(of[1]);
  return [...out].filter((n) => n.length >= 4 || n === 'cal');
}

/** A school is too big for "they also work there" to mean an intro: UC Berkeley, UCLA, MIT, Stanford University. */
export function isSchoolOrg(o: string | undefined, studentSchool?: string): boolean {
  const n = norm(o);
  if (!n) return false;
  if (/\b(university|college|institute of technology|polytechnic|school of|community college)\b/.test(n))
    return true;
  if (
    /^uc ?[a-z]+$|^uc[a-z]{1,3}$|^(mit|caltech|cmu|nyu|usc|ucla|ucsd|uci|ucsb|ucsc|ucd|uiuc|umd|asu|sjsu|ut austin|georgia tech|stanford|harvard|yale|princeton|cornell|dartmouth|upenn|wharton|duke|northwestern|berkeley|purdue|vanderbilt|emory|oxford|cambridge|eth zurich|epfl|waterloo)$/.test(
      n,
    )
  )
    return true;
  return schoolNames(studentSchool).includes(n);
}

/** Interests too broad to be a reason on their own ("operations", "strategy"). */
const BROAD = new Set([
  'operations',
  'strategy',
  'management',
  'marketing',
  'leadership',
  'sales',
  'research',
  'design',
  'analytics',
  'finance',
  'communication',
  'teamwork',
]);
export function isBroad(interest: string): boolean {
  return BROAD.has(norm(interest));
}

const candidateText = (c: Candidate) =>
  norm([c.title, c.org, c.headline, c.location, ...(c.evidence ?? [])].filter(Boolean).join(' '));
/** Everything but where they live: a school or company named in a city ("Berkeley, CA") proves nothing. */
const workText = (c: Candidate) =>
  norm([c.title, c.org, c.headline, ...(c.evidence ?? [])].filter(Boolean).join(' '));

/** Words that say a school is where someone studied, not a city or a company that shares its name. */
const EDU_CONTEXT =
  /\b(alum|alumni|alumna|alumnus|graduate|grad|class of|b\.?s\.?|b\.?a\.?|m\.?s\.?|mba|ph\.?d\.?|student|studied|studying|haas|eecs|professor|faculty|lecturer|postdoc|school of|college of|department)\b|['’]\d{2}\b/;

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasPhrase = (text: string, phrase: string) =>
  !!phrase && new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`).test(text);

/** The student's school named in the text: the full name, "UC Berkeley" anywhere; "Berkeley" or "Cal" only beside a
 * word that says they studied or teach there. */
export function schoolIn(text: string, school: string | undefined): string | undefined {
  const names = schoolNames(school);
  const full = names.filter((n) => n.includes(' '));
  const hit = full.find((n) => hasPhrase(text, n));
  if (hit) return hit;
  if (!EDU_CONTEXT.test(text)) return undefined;
  return names.filter((n) => !n.includes(' ')).find((n) => hasPhrase(text, n));
}

const CLOSED_DOOR =
  /\b(?:not|no longer|isn['’]t|is not|aren['’]t|are not|don['’]t|do not|unable to)\s+(?:currently\s+|be\s+)?(?:accepting|taking|looking|hiring|available|able to (?:take|respond)|respond)/i;

const OPEN_DOOR =
  /\b(email me|e-mail me|reach out|feel free to (?:contact|email|reach)|happy to (?:chat|help|talk|connect)|office hours|open to (?:chat|coffee|connect|mentor)|(?:prospective|interested) (?:students|undergrad)|undergraduates? (?:welcome|interested)|accepting (?:students|undergrad)|looking for (?:students|undergrad|research assistants)|mentor(?:ing|ship)?\b|dms? (?:are )?open)/i;

/** A class year in the text ("class of 2024", "'24", "BS 2025") within three years of now. */
function recentGrad(text: string, year: number): boolean {
  for (const m of text.matchAll(/\b(?:class of |'|’|(?:bs|ba|ms|mba|b\.s\.|b\.a\.)\s*)(20)?(\d{2})\b/gi)) {
    const y = 2000 + Number(m[2]);
    if (y >= year - 3 && y <= year) return true;
  }
  return false;
}

export interface WarmthInput {
  student: StudentContext;
  /** the person when Orbit already knows them, with their tie score */
  known?: { personId: string; score?: number } | null;
  /** the student's warm contacts (score >= WARM_SCORE), best first */
  warm: WarmContact[];
  /** the candidate's company domains (their email, their page, the ask's domains), for contacts by email domain */
  domains?: string[];
  /** today's year (tests) */
  year: number;
}

/** The tier and the one reason, warmest first. */
export function warmthOf(c: Candidate, input: WarmthInput): Warmth {
  const { student, known, warm } = input;
  const text = candidateText(c);
  const name =
    c.firstName ??
    c.name.split(/\s+/).find((w) => !/^(dr|prof|professor|mr|ms|mrs|mx)\.?$/i.test(w)) ??
    c.name;

  // 1. already in the student's world
  if (known && (known.score ?? 0) >= KNOWN_SCORE)
    return { tier: 1, why: `You've talked with ${name} before` };

  // 2. one hop: a warm contact at the same company or school, by org name or by work email domain
  const domains = new Set((input.domains ?? []).map((d) => d.toLowerCase()));
  // a university is too big for "they also work there" to mean an intro: its people count as shared background
  const bigOrg = (o: string | undefined) => isSchoolOrg(o, student.school);
  const theirOrgs = orgsOf(c).filter((o) => !bigOrg(o));
  let where: string | undefined;
  const bridge = [...warm]
    .filter((w) => w.score >= WARM_SCORE)
    .sort((a, b) => b.score - a.score)
    .find((w) => {
      for (const mine of orgNames(w.org).filter((o) => !bigOrg(o))) {
        const hit = theirOrgs.find((o) => sameOrg(mine, o));
        if (hit) {
          where = hit;
          return true;
        }
      }
      const d = workDomain(w.email);
      return !!d && domains.has(d) && !/\.edu$/.test(d);
    });
  if (bridge) {
    const bridgeFirst = bridge.name.split(/\s+/)[0] ?? bridge.name;
    where ??= theirOrgs[0] ?? c.org ?? 'there';
    return {
      tier: 2,
      why: `${bridgeFirst} is close to you and also at ${where}, so ask for an intro`,
      bridge: { personId: bridge.personId, name: bridge.name },
    };
  }

  // 3. shared identity: the student's school, a company on their résumé, their hometown
  const work = workText(c);
  const school = schoolIn(work, student.school);
  if (school)
    return {
      tier: 3,
      why: `Also ${/\b(student|phd|candidate|professor|faculty|lecturer|postdoc)\b/.test(work) ? 'at' : 'from'} ${schoolLabel(school, student.school)}`,
    };
  const pastOrg = student.orgs.find(
    (o) =>
      !schoolNames(student.school).includes(norm(o)) &&
      (orgsOf(c).some((x) => sameOrg(o, x)) || (normOrg(o).length >= 5 && hasPhrase(work, normOrg(o)))),
  );
  if (pastOrg) return { tier: 3, why: `Also worked at ${pastOrg}` };
  const home = norm(student.homeCity).split(',')[0]!.trim();
  if (home.length >= 4 && hasPhrase(norm(c.location), home))
    return { tier: 3, why: `Based in ${student.homeCity!.split(',')[0]!.trim()}, your hometown` };

  // 4. an open door
  if (OPEN_DOOR.test(text) && !CLOSED_DOOR.test(text))
    return { tier: 4, why: 'Their page invites students to reach out' };
  if (recentGrad(text, input.year))
    return { tier: 4, why: 'Graduated recently, so likely to remember being a student' };

  // 5. cold: say what ties them to the résumé when something does
  // the interest as a phrase, so "product management" is not found in "management of product recalls"
  const hook = student.interests.find((i) => words(i).length > 0 && !isBroad(i) && hasPhrase(work, norm(i)));
  return hook ? { tier: 5, why: `Works on ${hook}, which is on your résumé` } : { tier: 5 };
}

/** "UC Berkeley" for any way the school was written. */
function schoolLabel(hit: string, school: string | undefined): string {
  const uc = norm(school).match(/^university of california,?\s+(.+)$/);
  if (uc?.[1]) return `UC ${titleCase(uc[1])}`;
  return titleCase(hit === 'cal' ? norm(school) : hit);
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/** The rank with the tier's lift: base + bonus × (0.4 + 0.6 × fit). */
export function warmRank(base: number, fit: number, tier: WarmthTier): number {
  return base + TIER_BONUS[tier] * (0.4 + 0.6 * Math.max(0, Math.min(1, fit)));
}

/** Résumé facets (orbit.uploads.parsed.facets) into the student's orgs and interests. */
export function studentFromResume(
  parsed: Record<string, unknown> | null | undefined,
  base: {
    school?: string | null;
    currentOrg?: string | null;
    gradYear?: number | null;
    homeCity?: string | null;
  },
): StudentContext {
  const orgs = new Set<string>();
  const interests = new Set<string>();
  if (base.currentOrg) orgs.add(base.currentOrg);
  const facets = Array.isArray(parsed?.facets) ? (parsed!.facets as Record<string, unknown>[]) : [];
  for (const f of facets) {
    if (f.excluded === true) continue;
    const org = [f.org, f.organization, f.organizationName].find((x) => typeof x === 'string') as
      | string
      | undefined;
    if (
      org &&
      (f.kind === 'experience' || f.kind === 'education') &&
      !/^freelance|self[- ]employed$/i.test(org)
    )
      orgs.add(org.trim());
    for (const k of Array.isArray(f.keywords) ? f.keywords : [])
      if (typeof k === 'string' && k.trim().length >= 3 && k.length <= 40)
        interests.add(k.trim().toLowerCase());
    if (f.kind === 'project' && typeof f.title === 'string') interests.add(f.title.trim().toLowerCase());
  }
  return {
    school: base.school ?? undefined,
    orgs: [...orgs],
    homeCity: base.homeCity ?? undefined,
    interests: [...interests].slice(0, 60),
    gradYear: base.gradYear ?? undefined,
  };
}
