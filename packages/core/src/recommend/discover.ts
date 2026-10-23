/**
 * Discover's sourcing and scoring (plan 17 D): which LinkedIn searches find people worth meeting, and how well each
 * person fits and how easy they are to reach, as continuous scores so two cards rarely read the same.
 *
 * What it reads about the student: their goals (roles, functions, industries, places, target companies by priority),
 * their resume (where they worked), who they actually wrote to (titles and companies; people who replied count
 * double) and what they turned down on Discover (a company or a role that was wrong). Every reason it gives is one
 * the data proves: a role match is read from the person's title, never from a headline that only hopes for the role,
 * and a school is claimed only with education evidence.
 */
import { functionPhrase } from '../labels';
import { normalizeCompany, stripDiacritics } from '../text/normalize';
import type { RecruitingGoals, ResumeFacet, TargetCompany } from '../types';
import {
  FUNCTION_SEARCH_TITLE,
  LEVEL_ANSWERS,
  LEVEL_FIT,
  LEVEL_RANK,
  searchTitleFor,
  type TitleLevel,
  type TitleStatus,
  titleFunctions,
  titleLevel,
  titleSimilarity,
  titleStatus,
} from './title';

/** Someone the student wrote to (or started writing to): what kind of person they reach out to. */
export interface OutreachExample {
  /** first name, for a reason that names them ("like Maya, who replied") */
  name?: string;
  title?: string;
  company?: string;
  replied: boolean;
}

/** A card the student turned down on Discover, with the reason they picked. */
export interface DismissSignal {
  reason: string;
  title?: string;
  company?: string;
}

export interface DiscoverProfile {
  school?: string;
  /** titles of the roles the student targets, as people in them write them ("Software Engineer") */
  targetTitles: string[];
  targetFunctions: string[];
  industries: string[];
  /** places the student wants to work (Remote left out: it is not a place to search) */
  locations: string[];
  /** where the student lives now or comes from: a weaker pull than a target place */
  homeLocations: string[];
  targetCompanies: { name: string; key: string; priority: 1 | 2 | 3 }[];
  /** organisations on the student's resume; `current` only when the resume says "present" */
  pastOrgs: { name: string; key: string; title?: string; current: boolean }[];
  outreach: OutreachExample[];
  dismissed: DismissSignal[];
}

const uniqBy = <T>(xs: T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const placeName = (s: string | undefined) => (s ?? '').split(',')[0]!.trim();

export function buildDiscoverProfile(inp: {
  user: { school?: string; currentCity?: string; homeCity?: string };
  goals?: Partial<
    Pick<RecruitingGoals, 'targetRoles' | 'targetFunctions' | 'targetIndustries' | 'targetLocations'>
  >;
  targetCompanies: Pick<TargetCompany, 'nameRaw' | 'priority' | 'status'>[];
  resumeFacets: Pick<
    ResumeFacet,
    'kind' | 'organizationName' | 'title' | 'startDate' | 'endDate' | 'excluded'
  >[];
  outreach?: OutreachExample[];
  dismissed?: DismissSignal[];
}): DiscoverProfile {
  const g = inp.goals ?? {};
  const titles = uniqBy(
    [
      ...(g.targetRoles ?? []).map(searchTitleFor),
      ...(g.targetFunctions ?? []).map((f) => FUNCTION_SEARCH_TITLE[f] ?? f),
    ].filter((t) => t.trim().length > 1),
    (t) => t.toLowerCase(),
  ).slice(0, 6);
  return {
    school: inp.user.school?.trim() || undefined,
    targetTitles: titles,
    targetFunctions: g.targetFunctions ?? [],
    industries: (g.targetIndustries ?? []).map((i) => i.trim()).filter(Boolean),
    locations: (g.targetLocations ?? []).map(placeName).filter((l) => l && !/^remote$/i.test(l)),
    homeLocations: [inp.user.currentCity, inp.user.homeCity].map(placeName).filter(Boolean),
    targetCompanies: uniqBy(
      inp.targetCompanies
        .filter((t) => t.status !== 'closed')
        .map((t) => ({ name: t.nameRaw, key: normalizeCompany(t.nameRaw), priority: t.priority }))
        .sort((a, b) => a.priority - b.priority),
      (t) => t.key,
    ),
    pastOrgs: uniqBy(
      inp.resumeFacets
        .filter((f) => f.kind === 'experience' && !f.excluded && f.organizationName)
        .map((f) => ({
          name: f.organizationName!,
          key: normalizeCompany(f.organizationName),
          title: f.title,
          current: !!f.startDate && !f.endDate,
        })),
      (o) => o.key,
    ),
    outreach: inp.outreach ?? [],
    dismissed: inp.dismissed ?? [],
  };
}

// ---- sourcing ----------------------------------------------------------------------------------------------------

export type DiscoverQueryKind =
  | 'alumni_at_target'
  | 'role_at_target'
  | 'alumni_in_role'
  | 'like_replied'
  | 'like_reached'
  | 'replied_company'
  | 'past_org'
  | 'role_in_place'
  | 'industry_role'
  | 'alumni';

/** One LinkedIn people search: filters as the proxy's /search takes them, a weight, and why it finds good people. */
export interface DiscoverQuery {
  /** stable across days, so its cursor is kept and the next page continues where the last one stopped */
  key: string;
  kind: DiscoverQueryKind;
  title?: string;
  company?: string;
  school?: string;
  location?: string;
  keywords?: string;
  weight: number;
  why: string;
}

function queryKey(q: Omit<DiscoverQuery, 'key' | 'weight' | 'why' | 'kind'>): string {
  return ['title', 'company', 'school', 'location', 'keywords']
    .map((k) => `${k}=${(q[k as keyof typeof q] ?? '').toString().toLowerCase().trim()}`)
    .join('&');
}

/** The roles the student turned down twice are not searched again, once halves the search. */
function roleBlock(profile: DiscoverProfile, title: string | undefined): number {
  if (!title) return 0;
  return profile.dismissed.filter(
    (d) => d.reason === 'wrong_role' && d.title && titleSimilarity(d.title, title) >= 0.75,
  ).length;
}

function companyBlocked(profile: DiscoverProfile, company: string | undefined): boolean {
  if (!company) return false;
  const k = normalizeCompany(company);
  return profile.dismissed.some(
    (d) => d.reason === 'wrong_company' && !!d.company && normalizeCompany(d.company) === k,
  );
}

/** Clusters of what the student's messages went to: titles and companies, people who replied weighing double. */
function outreachClusters(profile: DiscoverProfile) {
  const titles: { title: string; w: number; replied: boolean }[] = [];
  const companies = new Map<string, { name: string; w: number; replied: boolean }>();
  for (const ex of profile.outreach) {
    const w = ex.replied ? 2 : 1;
    if (ex.title && titleStatus(ex.title) === 'working') {
      const c = titles.find((t) => titleSimilarity(t.title, ex.title) >= 0.8);
      if (c) {
        c.w += w;
        c.replied ||= ex.replied;
      } else titles.push({ title: ex.title, w, replied: ex.replied });
    }
    const k = normalizeCompany(ex.company);
    if (k) {
      const c = companies.get(k) ?? { name: ex.company!, w: 0, replied: false };
      c.w += w;
      c.replied ||= ex.replied;
      companies.set(k, c);
    }
  }
  return {
    titles: titles.sort((a, b) => b.w - a.w),
    companies: [...companies.values()].sort((a, b) => b.w - a.w),
  };
}

/**
 * The searches that find people worth meeting, best first: alumni at the target companies, people in the target
 * roles there, alumni in those roles, people like the ones who replied, then the student's past organisations, their
 * places and industries. Companies and roles the student turned down are left out.
 */
export function discoverQueries(profile: DiscoverProfile, max = 24): DiscoverQuery[] {
  const out: DiscoverQuery[] = [];
  const add = (q: Omit<DiscoverQuery, 'key'>) => {
    if (companyBlocked(profile, q.company)) return;
    const block = roleBlock(profile, q.title);
    if (block >= 2) return;
    const key = queryKey(q);
    if (out.some((x) => x.key === key)) return;
    out.push({ ...q, key, weight: q.weight * (block ? 0.5 : 1) });
  };
  const school = profile.school;
  const roles = profile.targetTitles.slice(0, 3);
  for (const tc of profile.targetCompanies.slice(0, 8)) {
    const p = (tc.priority - 1) * 0.1;
    if (school)
      add({
        kind: 'alumni_at_target',
        company: tc.name,
        school,
        weight: 1 - p,
        why: `${school} alumni at ${tc.name}`,
      });
    for (const [i, title] of roles.slice(0, 2).entries())
      add({
        kind: 'role_at_target',
        company: tc.name,
        title,
        weight: 0.9 - p - i * 0.05,
        why: `${title} at ${tc.name}`,
      });
  }
  for (const title of roles) {
    if (school)
      add({
        kind: 'alumni_in_role',
        title,
        school,
        weight: 0.8,
        why: `${school} alumni working as ${title}`,
      });
    for (const location of profile.locations.slice(0, 2))
      add({
        kind: 'role_in_place',
        title,
        location,
        weight: 0.5,
        why: `${title} in ${location}`,
      });
  }
  const { titles, companies } = outreachClusters(profile);
  for (const t of titles.slice(0, 2))
    add({
      kind: t.replied ? 'like_replied' : 'like_reached',
      title: t.title,
      school: t.replied ? undefined : school,
      weight: t.replied ? 0.75 : 0.55,
      why: t.replied ? 'People like those who replied to you' : 'People like those you have written to',
    });
  for (const c of companies.filter((c) => c.replied).slice(0, 2))
    add({
      kind: 'replied_company',
      company: c.name,
      title: roles[0],
      weight: 0.6,
      why: `At ${c.name}, where people replied to you`,
    });
  for (const o of profile.pastOrgs.slice(0, 3))
    add({
      kind: 'past_org',
      company: o.name,
      weight: 0.45,
      why: `At ${o.name}, where you worked`,
    });
  for (const industry of profile.industries.slice(0, 2))
    add({
      kind: 'industry_role',
      keywords: industry,
      title: roles[0],
      weight: 0.4,
      why: roles[0] ? `${roles[0]} in ${industry}` : industry,
    });
  if (!out.length && school) add({ kind: 'alumni', school, weight: 0.5, why: `${school} alumni` });
  return out.sort((a, b) => b.weight - a.weight).slice(0, max);
}

/**
 * The next search to run: the heaviest one not used up, each page already fetched counting against it, so the first
 * pages of several searches come before the third page of one.
 */
export function nextDiscoverQuery(
  queries: DiscoverQuery[],
  progress: Record<string, { pages: number; done?: boolean } | undefined>,
): DiscoverQuery | undefined {
  let best: DiscoverQuery | undefined;
  let bestW = -1;
  for (const q of queries) {
    const p = progress[q.key];
    if (p?.done) continue;
    const w = q.weight * 0.55 ** (p?.pages ?? 0);
    if (w > bestW) {
      best = q;
      bestW = w;
    }
  }
  return best;
}

// ---- scoring -----------------------------------------------------------------------------------------------------

export interface DiscoverCandidate {
  name: string;
  /** the role as their title says it (a headline's first part when there is no title) */
  title?: string;
  company?: string;
  headline?: string;
  location?: string;
  /** LinkedIn degree: 1 a connection, 2 a friend of a friend, 3 further out */
  distance?: number;
  /** mutual connections, when LinkedIn says how many */
  mutualCount?: number;
  /** they went to the student's school, from education evidence (LinkedIn's school filter, their education) */
  schoolEvidence?: boolean;
  /** someone already in Orbit: their closeness and best route */
  known?: { strength: number; pathStrength: number; linkedinConnected?: boolean };
  /** someone the student knows well (Warm or closer) who works at their company now */
  colleague?: { firstName: string; strength: number };
  /** the target list's priority when the caller matched the company by id */
  targetPriority?: 1 | 2 | 3;
  /** a response prior from elsewhere (recommendPeople's responsePrior), instead of the level's */
  prior?: number;
  /** the search that found them, as a last-resort reason */
  why?: string;
}

export interface DiscoverReason {
  code: string;
  text: string;
}

export interface DiscoverScore {
  fit: number;
  reach: number;
  prior: number;
  score: number;
  /** strongest first: the first is the card's one line */
  reasons: DiscoverReason[];
  parts: {
    role: number;
    like: number;
    level: number;
    company: number;
    place: number;
    school: number;
    penalty: number;
  };
  seniority?: TitleLevel;
  status: TitleStatus;
}

const ALIASES: [RegExp, string][] = [
  [/\bnyc\b|\bnew york city\b|\bmanhattan\b|\bbrooklyn\b/g, 'new york'],
  [/\bsf\b|\bbay area\b|\bsilicon valley\b|\bpalo alto\b|\bmenlo park\b|\bmountain view\b/g, 'san francisco'],
  [/\bla\b/g, 'los angeles'],
  [/\bdc\b/g, 'washington'],
];

function placeKey(s: string | undefined): string {
  let t = ` ${stripDiacritics(s ?? '').toLowerCase()} `;
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  return t
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function placeMatch(candidate: string | undefined, places: string[]): string | undefined {
  const c = placeKey(candidate);
  if (!c) return undefined;
  return places.find((p) => {
    const k = placeKey(p);
    return !!k && (c.includes(k) || k.includes(c));
  });
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 1000) / 1000;
const noisyOr = (...ps: number[]) => 1 - ps.reduce((acc, p) => acc * (1 - clamp01(p)), 1);

/** How strongly a dismissed role or company argues against this person: a multiplier, 1 when nothing does. */
export function dismissPenalty(
  c: Pick<DiscoverCandidate, 'title' | 'company'>,
  dismissed: DismissSignal[],
): number {
  let m = 1;
  const k = normalizeCompany(c.company);
  if (k && dismissed.some((d) => d.reason === 'wrong_company' && normalizeCompany(d.company) === k))
    m *= 0.25;
  let worst = 0;
  for (const d of dismissed)
    if (d.reason === 'wrong_role' && d.title && c.title)
      worst = Math.max(worst, titleSimilarity(d.title, c.title));
  if (worst >= 0.5) m *= 1 - 0.65 * worst;
  return m;
}

/** The student's own organisation, worded by whether the resume says they are there now. */
function sharedOrgReason(org: DiscoverProfile['pastOrgs'][number], company: string): DiscoverReason {
  return org.current
    ? { code: 'shared_org_now', text: `You're both at ${company}` }
    : {
        code: 'shared_org',
        text: `Works at ${company}, where you ${/\bintern/i.test(org.title ?? '') ? 'interned' : 'worked'}`,
      };
}

/**
 * Fit, reach and the reasons for one person. Fit: how alike their title is to the roles the student targets and to
 * the people they wrote to, how good their level is for a student, how much the student wants their company, their
 * place and school; less for what the student turned down. Reach: for someone new, mutual connections (second
 * degree) above a shared school above third degree; for someone known, their closeness and best route. Both are
 * continuous, so cards differ.
 */
export function scoreDiscoverCandidate(c: DiscoverCandidate, profile: DiscoverProfile): DiscoverScore {
  const status = titleStatus(c.title ?? c.headline);
  const inRole = status === 'working';
  // ---- fit ----
  let role = 0;
  for (const t of profile.targetTitles) role = Math.max(role, titleSimilarity(c.title, t));
  if (!inRole) role *= status === 'incoming' ? 0.6 : 0.3;
  const key = normalizeCompany(c.company);
  let like = 0;
  let likeEx: OutreachExample | undefined;
  for (const ex of profile.outreach) {
    if (!ex.title || !c.title) continue;
    const same = !!key && normalizeCompany(ex.company) === key;
    const s = clamp01(titleSimilarity(c.title, ex.title) * (ex.replied ? 1 : 0.8) + (same ? 0.1 : 0));
    if (s > like || (s === like && ex.replied && !likeEx?.replied)) {
      like = s;
      likeEx = ex;
    }
  }
  if (!inRole) like *= 0.3;
  const seniority = inRole || status === 'incoming' ? titleLevel(c.title) : 'student';
  let level = seniority ? LEVEL_FIT[seniority] : 0.5;
  const replierRanks = profile.outreach
    .filter((ex) => ex.replied && ex.title)
    .map((ex) => titleLevel(ex.title))
    .filter((s): s is TitleLevel => !!s)
    .map((s) => LEVEL_RANK[s]);
  if (seniority && replierRanks.length) {
    const mean = replierRanks.reduce((a, b) => a + b, 0) / replierRanks.length;
    level = 0.75 * level + 0.25 * (1 - Math.min(1, Math.abs(LEVEL_RANK[seniority] - mean) / 4));
  }
  const tc = key ? profile.targetCompanies.find((t) => t.key === key) : undefined;
  const priority = c.targetPriority ?? tc?.priority;
  const PRIORITY_FIT = { 1: 1, 2: 0.85, 3: 0.7 } as const;
  const repliedHere =
    !!key && profile.outreach.some((ex) => ex.replied && normalizeCompany(ex.company) === key);
  const wroteHere = !!key && profile.outreach.some((ex) => normalizeCompany(ex.company) === key);
  const pastOrg = key ? profile.pastOrgs.find((o) => o.key === key) : undefined;
  const text = `${c.headline ?? ''} ${c.company ?? ''} ${c.title ?? ''}`.toLowerCase();
  const industry = profile.industries.find((i) => i.length > 1 && text.includes(i.toLowerCase()));
  const company = Math.max(
    priority ? PRIORITY_FIT[priority] : 0,
    repliedHere ? 0.6 : wroteHere ? 0.45 : 0,
    pastOrg ? 0.65 : 0,
    industry ? 0.35 : 0,
  );
  const targetPlace = placeMatch(c.location, profile.locations);
  const place = targetPlace ? 1 : placeMatch(c.location, profile.homeLocations) ? 0.5 : 0;
  const school = c.schoolEvidence && profile.school ? 1 : 0;
  const penalty = dismissPenalty(c, profile.dismissed);
  const fit = clamp01(
    (0.34 * role + 0.14 * like + 0.14 * level + 0.22 * company + 0.06 * place + 0.1 * school) * penalty,
  );
  // ---- reach ----
  const answers = seniority ? LEVEL_ANSWERS[seniority] : 0.7;
  let reach: number;
  if (c.known) {
    reach = noisyOr(
      c.known.pathStrength,
      c.known.strength,
      school ? 0.3 : 0,
      c.known.linkedinConnected ? 0.12 : 0,
    );
  } else {
    const m = c.mutualCount ?? 0;
    const degree =
      c.distance === 1
        ? 0.75
        : c.distance === 2
          ? c.mutualCount !== undefined
            ? 0.36 + 0.34 * (1 - Math.exp(-m / 6))
            : 0.4
          : c.distance === 3
            ? 0.12
            : 0.15;
    reach = noisyOr(degree, school ? 0.28 : 0, c.colleague ? 0.5 * c.colleague.strength : 0);
  }
  reach = clamp01(Math.max(0.05, reach) * (0.8 + 0.2 * answers));
  const prior = clamp01(c.prior ?? answers + (school ? 0.05 : 0));
  const score = Math.max(fit, 0.02) ** 0.55 * reach ** 0.3 * Math.max(prior, 0.05) ** 0.15;

  // ---- reasons, strongest first; each one the data proves ----
  const reasons: DiscoverReason[] = [];
  const say = (code: string, t: string | undefined) => {
    if (t && !reasons.some((r) => r.code === code)) reasons.push({ code, text: t });
  };
  if (c.colleague && c.company)
    say('colleague', `${c.colleague.firstName}, whom you know, works at ${c.company} too`);
  if (school && priority && c.company)
    say('alumni_target', `${profile.school} alum at ${c.company}, on your target list`);
  if (!c.known && c.mutualCount && c.mutualCount > 0)
    say('mutuals', `${c.mutualCount} mutual connection${c.mutualCount === 1 ? '' : 's'} on LinkedIn`);
  if (pastOrg && c.company) {
    const r = sharedOrgReason(pastOrg, c.company);
    say(r.code, r.text);
  }
  if (likeEx?.replied && likeEx.name && like >= 0.75)
    say('like_replied', `Same kind of role as ${likeEx.name}, who replied to you`);
  if (school) say('alumni', `Went to ${profile.school}, like you`);
  if (priority && c.company) say('target_company', `Works at ${c.company}, on your target list`);
  if (inRole && c.title && role >= 0.6) {
    const fn = [...titleFunctions(c.title)].find((f) => profile.targetFunctions.includes(f));
    say(
      'function_match',
      fn ? `Works in ${functionPhrase(fn)} (${c.title})` : `${c.title}, a role you are targeting`,
    );
  }
  if (like >= 0.75 && !likeEx?.replied) say('like_reached', 'In a role like people you have written to');
  if (targetPlace) say('location', `Based in ${targetPlace}, where you want to work`);
  if (industry && c.company) say('industry', `Works in ${industry}`);
  if (!c.known && c.distance === 2 && !c.mutualCount)
    say('second_degree', 'Second degree connection on LinkedIn');
  if (c.why) say('search', c.why);
  return {
    fit: round(fit),
    reach: round(reach),
    prior: round(prior),
    score: round(score),
    reasons,
    parts: {
      role: round(role),
      like: round(like),
      level: round(level),
      company: round(company),
      place,
      school,
      penalty: round(penalty),
    },
    seniority,
    status,
  };
}

/** Which reason a card shows when it has one line, strongest first (codes from recommendPeople and Discover). */
const REASON_ORDER = [
  'referred',
  'path',
  'colleague',
  'shared_org_now',
  'alumni_target',
  'mutuals',
  'shared_org',
  'like_replied',
  'warm',
  'target_company',
  'function_match',
  'alumni',
  'like_reached',
  'resume_overlap',
  'location',
  'industry',
  'second_degree',
  'search',
];

/** The one line a card shows: the strongest reason it has. */
export function cardReason<T extends { code: string; text: string }>(reasons: T[]): T | undefined {
  const rank = (r: T) => {
    const i = REASON_ORDER.indexOf(r.code);
    return i < 0 ? REASON_ORDER.length : i;
  };
  return [...reasons].sort((a, b) => rank(a) - rank(b))[0];
}
