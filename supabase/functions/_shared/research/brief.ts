/**
 * Deep research on one person for the live site (docs/plan/20): a quick brief in one call, under a 90-second deadline,
 * and an optional "Go deeper" call that upgrades it. Unlike the account-mode dossier (dossier.ts) nothing here reads
 * Orbit's database: the browser sends the person, the LinkedIn profile and posts it already fetched, and a short
 * digest of the student's history with them, and keeps the brief. The server keeps only the public-web cache and the
 * cost log.
 *
 *   1. identity card from the profile; no LinkedIn and no employer → stop before spending ("needs_anchor")
 *   2. the searches: quick = about them, news, talks/podcasts/writing; deeper = more about them when quick found a
 *      strong page beyond LinkedIn, otherwise their company's news and hiring (no wrong-person risk)
 *   3. every page scored against the card (identity.ts); only strong pages are read and cited; two or more people
 *      sharing the name with no anchor to tell them apart → "which one?"
 *   4. The writing model writes from the page text (dossier.ts writeBrief: the first paid answer is kept when a retry would
 *      cost too much), then finish() strips what is never written
 *   5. the support check (support.ts): unsupported claims removed, partly supported ones kept out of openers
 *   6. the honest default: with nothing beyond LinkedIn the brief says so
 *
 * Money: everything paid counts toward the brief's cap ($0.30 quick; $0.50 for quick and deeper together); a step
 * that would cross it is skipped and the brief is marked partial, with a note saying what was skipped and why.
 */

import type { SearchEngine } from '../providers/webSearch';
import type { ClaudeDep } from './deps';
import {
  type CandidatePage,
  type DisambiguationCandidate,
  type DossierSource,
  finish,
  pickIdentity,
  writeBrief,
  writeEstimateUsd,
} from './dossier';
import { appearsMinor } from './guards';
import { aboutCompany, type IdentityCard, identityCard, scorePage } from './identity';
import { type FoundPage, investigate } from './investigate';
import { type DossierContent, dossierSystem, dossierUser, PROMPT_VERSION } from './prompts';
import { supportCheck } from './support';
import {
  type GatherPlan,
  type GatherStep,
  gatherFrom,
  normalizeUrl,
  type SharedCache,
  type WebPage,
  type WebSource,
} from './web';

export const QUICK_CAP_USD = 0.3;
export const BOTH_CAP_USD = 0.5;
export const QUICK_DEADLINE_MS = 85_000;
export const DEEPER_DEADLINE_MS = 120_000;
/** the brief is written from compact sources on the mid model (claude.ts research_brief) */
export const BRIEF_MODEL = 'claude-sonnet-5-5';
/** pages the investigator loop may hand the writer: facts, not page text, so more fit */
export const INVESTIGATE_PAGES = 20;
/** pages read for the quick brief, and added by Go deeper */
export const QUICK_PAGES = 8;
/** search hits read (fetched) per round: a few more than are kept, since titles alone cannot tell namesakes apart */
export const READ_PAGES = 10;
export const DEEPER_PAGES = 8;
/** the writer needs about this long; with less left the brief is assembled from LinkedIn alone */
const WRITE_MIN_MS = 25_000;

export type GoalKind =
  | 'recruiting'
  | 'fundraising'
  | 'sales'
  | 'hiring'
  | 'advice'
  | 'cofounder'
  | 'collaboration'
  | 'community';

/** The LinkedIn profile as the browser holds it (integrations/enrichmentProxy.ts LinkedInProfile). */
export interface BrowserProfile {
  headline?: string;
  location?: string;
  about?: string;
  publicIdentifier?: string;
  experience?: { title?: string; company?: string; current?: boolean; start?: string; end?: string }[];
  education?: { school?: string; degree?: string; field?: string; start?: string; end?: string }[];
}

export interface BriefRequest {
  kind: 'quick' | 'deeper';
  person: {
    name: string;
    firstName?: string;
    lastName?: string;
    title?: string;
    org?: string;
    location?: string;
    school?: string;
    linkedinUrl?: string;
    emails?: string[];
  };
  profile?: BrowserProfile | null;
  posts?: { text: string; date?: string; url?: string }[];
  /** the student's last few messages and notes with them, already short; used for "in common", never stored */
  history?: string;
  student: { firstName: string; context: string; goalSentence: string; goalKind?: GoalKind };
  /** the person the student picked from "which one?" */
  chosen?: { org?: string; url?: string };
}

export interface BriefDeps {
  /** in order of preference: Exa when configured, then Claude's web search */
  web: WebSource[];
  /**
   * The investigator loop's search engines (Parallel, Serper): with one configured, research runs the loop
   * (investigate.ts) instead of the searches below; `cache` keeps its searches, pages and readings.
   */
  engines?: SearchEngine[];
  cache?: SharedCache;
  fetch?: typeof fetch;
  claude: ClaudeDep;
  clock: () => number;
}

export interface BriefLimits {
  /** dollars this call may spend */
  capUsd: number;
  /** when it must have answered, as a clock time */
  deadline: number;
}

export interface BriefStep extends Partial<GatherStep> {
  step: string;
  costUsd: number;
  ms: number;
}

export type BriefOutcome =
  | {
      status: 'ready' | 'partial';
      content: DossierContent;
      sources: DossierSource[];
      costUsd: number;
      model: string | null;
      promptVersion: string;
      notes: string[];
      steps: BriefStep[];
      /** web pages surely about them (not LinkedIn), so Go deeper knows where to spend */
      strongPages: number;
      provider?: 'exa' | 'claude' | 'investigate';
      checked: boolean;
      /** what the support check took out, for the live check only: never logged or sent on (it names the person) */
      debug?: { dropped: string[] };
    }
  | {
      status: 'needs_disambiguation';
      candidates: DisambiguationCandidate[];
      costUsd: number;
      notes: string[];
      steps: BriefStep[];
    }
  | { status: 'needs_anchor'; costUsd: 0; notes: string[]; steps: BriefStep[] }
  | { status: 'failed'; error: 'minor'; costUsd: number; notes: string[]; steps: BriefStep[] };

function monthsAgo(now: number, months: number): string {
  const d = new Date(now);
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() - months;
  return new Date(Date.UTC(Math.floor(m / 12), m % 12, 1)).toISOString().slice(0, 10);
}

const q = (...parts: (string | undefined)[]) =>
  parts
    .filter((p) => p?.trim())
    .join(' ')
    .replace(/\s+/g, ' ');

/** One line saying who the pages should be about, for the gatherer. */
export function focusLine(card: IdentityCard, title?: string): string {
  const now = card.employers.find((e) => e.current) ?? card.employers[0];
  const before = card.employers.filter((e) => e !== now).map((e) => e.name);
  return [
    card.fullName,
    now ? `${title ? `${title} at ` : ''}${now.name}` : title,
    before.length ? `previously ${before.join(', ')}` : undefined,
    card.schools[0]?.name,
    card.city,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Quick: about them, news in the last 18 months, and talks, podcasts or writing (papers for research goals). */
export function quickPlan(req: BriefRequest, card: IdentityCard, now: number): GatherPlan {
  const name = `"${card.fullName}"`;
  const org = card.employers.find((e) => e.current)?.name ?? card.employers[0]?.name;
  const third =
    req.student.goalKind === 'collaboration' || req.student.goalKind === 'advice'
      ? { id: 'papers', query: q(name, org ?? card.schools[0]?.name, 'paper OR talk OR interview OR blog') }
      : { id: 'talks', query: q(name, org, 'podcast OR talk OR interview OR blog') };
  return {
    queries: [
      { id: 'about', query: q(name, org, req.person.title), category: 'people' },
      { id: 'news', query: q(name, org), category: 'news', since: monthsAgo(now, 18) },
      third,
    ],
    focus: focusLine(card, req.person.title),
    maxPages: READ_PAGES,
  };
}

/**
 * Go deeper, spending where it can pay off: more about them only when the quick brief found at least one strong
 * page beyond LinkedIn; otherwise their company's recent news and hiring, which carry no wrong-person risk and are
 * what most students need. GitHub only when their profile links one.
 */
export function deeperPlan(
  req: BriefRequest,
  card: IdentityCard,
  now: number,
  strongPages: number,
  read: string[],
): GatherPlan & { mode: 'person' | 'company' } {
  const name = `"${card.fullName}"`;
  const org = card.employers.find((e) => e.current)?.name ?? card.employers[0]?.name;
  const before = card.employers.filter((e) => e.name !== org)[0]?.name;
  const github = /github\.com\/[\w-]+/i.exec(`${req.profile?.about ?? ''}`)?.[0];
  if (strongPages > 0) {
    return {
      mode: 'person',
      queries: [
        {
          id: 'more',
          query: q(name, before ?? card.schools[0]?.name ?? org, 'interview OR article OR profile'),
        },
        { id: 'work', query: q(name, org, 'launched OR built OR announced OR wrote') },
        ...(github ? [{ id: 'github', query: q(github) }] : []),
        ...(org
          ? [
              {
                id: 'company_news',
                query: q(org, 'news'),
                category: 'news' as const,
                since: monthsAgo(now, 6),
              },
            ]
          : []),
      ],
      focus: focusLine(card, req.person.title),
      maxPages: DEEPER_PAGES,
      skip: read,
    };
  }
  const goal = req.student.goalKind ?? 'recruiting';
  const hiring =
    goal === 'recruiting'
      ? 'hiring OR internship OR "new grad" OR careers'
      : goal === 'sales'
        ? 'customers OR partners'
        : 'team OR announces';
  return {
    mode: 'company',
    queries: [
      ...(org
        ? [
            {
              id: 'company_news',
              query: q(org, 'news'),
              category: 'news' as const,
              since: monthsAgo(now, 6),
            },
            { id: 'company_team', query: q(org, hiring) },
          ]
        : []),
      ...(github ? [{ id: 'github', query: q(github) }] : []),
    ],
    focus: org ? `${org} (the company ${card.fullName} works at)` : focusLine(card, req.person.title),
    maxPages: Math.min(DEEPER_PAGES, 6),
    skip: read,
  };
}

/** The LinkedIn profile as a source's text. */
export function profileText(p: BrowserProfile, name: string): string {
  const lines = [
    name,
    p.headline ?? '',
    p.location ? `Location: ${p.location}` : '',
    p.about ? `About: ${p.about.slice(0, 1500)}` : '',
  ];
  for (const w of p.experience ?? [])
    lines.push(
      `Experience: ${w.title ?? ''} at ${w.company ?? ''} (${w.start ?? ''}–${w.current ? 'present' : (w.end ?? '')})`,
    );
  for (const e of p.education ?? [])
    lines.push(
      `Education: ${e.school ?? ''}${e.degree ? `, ${e.degree}` : ''}${e.field ? ` in ${e.field}` : ''} (${e.start ?? ''}–${e.end ?? ''})`,
    );
  return lines.filter(Boolean).join('\n');
}

/** The brief when the writer cannot run (out of time, money or service): LinkedIn and the history only. */
export function linkedInOnlyBrief(
  req: BriefRequest,
  card: IdentityCard,
  hasProfile: boolean,
  webFound = false,
): DossierContent {
  const p = req.profile;
  const cur = p?.experience?.find((e) => e.current) ?? p?.experience?.[0];
  const role = cur?.title ?? req.person.title ?? '';
  const org = cur?.company ?? req.person.org ?? '';
  const first = req.person.firstName || card.fullName.split(' ')[0];
  const where = role && org ? `${role} at ${org}` : role || org;
  const ids = hasProfile ? ['S1'] : [];
  return {
    who: `${card.fullName}${where ? `, ${where}` : ''}.${webFound ? '' : ` Not much is public about ${first} beyond LinkedIn.`}`,
    now: { role, org, since: cur?.start ?? null, source_ids: ids },
    recently: [],
    in_common: [],
    history: { first_contact: null, last_contact: null, summary: null },
    openers: [],
    careful: [],
    confidence: 'low',
    career: hasProfile
      ? (p?.experience ?? []).slice(0, 12).map((e) => ({
          role: e.title ?? '',
          org: e.company ?? '',
          start: e.start ?? null,
          end: e.current ? null : (e.end ?? null),
          source_ids: ['S1'],
        }))
      : [],
    education: hasProfile
      ? (p?.education ?? []).slice(0, 6).map((e) => ({
          school: e.school ?? '',
          degree: e.degree ?? null,
          years: [e.start, e.end].filter(Boolean).join('–') || null,
          source_ids: ['S1'],
        }))
      : [],
    profiles: req.person.linkedinUrl ? [{ kind: 'linkedin', url: req.person.linkedinUrl }] : [],
    highlights: [],
    topics: [],
    company: [],
  };
}

/** "Not much is public about Dana beyond LinkedIn": said plainly when the web added nothing. */
export function honestWho(who: string, firstName: string): string {
  if (/beyond (their |her |his )?linkedin|not much (is )?public/i.test(who)) return who;
  return `${who.replace(/\s+$/, '')} Not much is public about ${firstName} beyond LinkedIn.`.trim();
}

const historyOf = { messages: [], notes: [], facts: [], events: [] };

/** Run a quick brief or Go deeper. */
export async function runBrief(
  deps: BriefDeps,
  req: BriefRequest,
  limits: BriefLimits,
): Promise<BriefOutcome> {
  const t0 = deps.clock();
  const notes: string[] = [];
  const steps: BriefStep[] = [];
  let spent = 0;
  const left = () => limits.deadline - deps.clock();
  const person = {
    ...req.person,
    org: req.chosen?.org?.trim() || req.person.org,
    linkedinUrl:
      req.person.linkedinUrl ||
      (req.chosen?.url && /linkedin\.com\/in\//i.test(req.chosen.url) ? req.chosen.url : undefined),
  };
  const card = identityCard({
    name: person.name,
    firstName: person.firstName,
    lastName: person.lastName,
    org: person.org,
    title: person.title,
    school: person.school,
    location: person.location,
    linkedinUrl: person.linkedinUrl,
    emails: person.emails,
    profile: req.profile
      ? {
          headline: req.profile.headline,
          location: req.profile.location,
          publicIdentifier: req.profile.publicIdentifier,
          experience: req.profile.experience,
          education: req.profile.education,
        }
      : null,
  });

  // 1. no LinkedIn and no employer: there is no telling namesakes apart, so nothing is spent
  if (!card.anchored && card.domains.length === 0) {
    notes.push('no LinkedIn profile or company to anchor the search');
    return { status: 'needs_anchor', costUsd: 0, notes, steps };
  }
  if (
    appearsMinor({
      title: person.title,
      headline: req.profile?.headline,
      education: req.profile?.education?.map((e) => ({ school: e.school, end: e.end })),
      year: new Date(t0).getUTCFullYear(),
    })
  )
    return { status: 'failed', error: 'minor', costUsd: 0, notes, steps };

  // 2–3. the web: the investigator loop when a search engine is set up, else the quick round always (free from the
  // cache on Go deeper), then the deeper round
  const strong: WebPage[] = [];
  let found: FoundPage[] | undefined;
  const company: WebPage[] = [];
  const allHits: CandidatePage[] = [];
  const scoreInto = (pages: WebPage[], companyRound: boolean) => {
    for (const p of pages) {
      if (strong.some((x) => normalizeUrl(x.url) === normalizeUrl(p.url))) continue;
      if (company.some((x) => normalizeUrl(x.url) === normalizeUrl(p.url))) continue;
      const s = scorePage(p, card);
      if (s.strength === 'strong') strong.push(p);
      else if (companyRound && person.org && aboutCompany(p, person.org)) company.push(p);
    }
  };
  // which search hits are worth reading: Exa's highlights are enough to tell a strong match; a company round also
  // reads pages about their company. Every page read is scored again on its full text before it is used.
  const selectFor = (companyRound: boolean) => (hits: { url: string; title?: string; snippet?: string }[]) =>
    hits
      .map((h) => ({ h, s: scorePage({ url: h.url, title: h.title, text: h.snippet }, card) }))
      .filter(
        ({ h, s }) =>
          s.strength === 'strong' ||
          (!h.snippet && !s.blocked && !s.linkedinCopy) ||
          (companyRound &&
            !!person.org &&
            aboutCompany({ url: h.url, title: h.title, text: h.snippet }, person.org)),
      )
      .sort((a, b) => b.s.signals.length - a.s.signals.length)
      .map(({ h }) => h.url);
  const select = selectFor(false);
  let provider: 'exa' | 'claude' | 'investigate' | undefined;
  let deeperMode: 'person' | 'company' | undefined;
  const engines = (deps.engines ?? []).filter((e) => e.configured);
  if (engines.length && deps.cache) {
    const inv = await investigate(
      { engines, claude: deps.claude, cache: deps.cache, fetch: deps.fetch, clock: deps.clock },
      {
        card,
        profile: req.profile ? profileText(req.profile, card.fullName) : focusLine(card, person.title),
        title: person.title,
      },
      {
        // Go deeper runs more follow-up rounds; the first rounds come back from the cache for nothing
        rounds: req.kind === 'quick' ? 1 : 3,
        budgetUsd: limits.capUsd * 0.5,
        deadline: limits.deadline - WRITE_MIN_MS - 12_000,
      },
    );
    spent += inv.costUsd;
    provider = 'investigate';
    notes.push(...inv.notes);
    steps.push(...inv.steps.map((s) => ({ ...s, step: `investigate:${s.step}` })));
    found = inv.pages.slice(0, INVESTIGATE_PAGES);
    if (req.kind === 'deeper') deeperMode = 'person';
  } else {
    const quick = quickPlan({ ...req, person }, card, t0);
    const quickBudget = req.kind === 'quick' ? limits.capUsd : limits.capUsd * 0.4;
    const gatherMs = () => Math.max(0, Math.min(45_000, left() - WRITE_MIN_MS - 8_000));
    const g1 = await gatherFrom(deps.web, quick, { budgetUsd: quickBudget, timeoutMs: gatherMs(), select });
    spent += g1.costUsd;
    provider = g1.provider;
    notes.push(...g1.notes);
    steps.push(...g1.steps.map((s) => ({ ...s, step: `quick:${s.step}` })));
    allHits.push(...g1.hits, ...g1.pages);
    scoreInto(g1.pages, false);

    // "which one?": only when nothing ties the pages to the person the student means
    const who = pickIdentity(card, allHits);
    if (who.kind === 'ambiguous' && strong.length === 0 && !req.chosen) {
      return {
        status: 'needs_disambiguation',
        candidates: who.candidates,
        costUsd: round4(spent),
        notes,
        steps,
      };
    }

    if (req.kind === 'deeper') {
      const plan = deeperPlan({ ...req, person }, card, t0, strong.length, [...strong.map((p) => p.url)]);
      deeperMode = plan.mode;
      if (plan.queries.length === 0) notes.push('Go deeper had nothing more to search: no company on record');
      else {
        const companyRound = plan.mode === 'company' || plan.queries.some((x) => x.id.startsWith('company'));
        const g2 = await gatherFrom(deps.web, plan, {
          budgetUsd: limits.capUsd - spent - writeEstimateUsd(30_000),
          timeoutMs: gatherMs(),
          select: selectFor(companyRound),
        });
        spent += g2.costUsd;
        provider = provider ?? g2.provider;
        notes.push(...g2.notes);
        steps.push(...g2.steps.map((s) => ({ ...s, step: `deeper:${s.step}` })));
        scoreInto(g2.pages, companyRound);
      }
    }
  }
  const personPages: WebPage[] = found
    ? found.map((p) => ({
        url: p.url,
        // the writer may use a likely page only as likely (prompts.ts)
        title: `${p.match === 'likely' ? '[likely them] ' : ''}${p.title ?? ''}`.trim(),
        published: p.published ?? null,
        text: p.text,
      }))
    : strong.slice(0, req.kind === 'quick' ? QUICK_PAGES : QUICK_PAGES + DEEPER_PAGES);
  const companyPages = company.slice(0, 6);

  // 4. numbered sources: the LinkedIn profile first, their posts, the web pages about them, then company pages
  const sources: (DossierSource & { text: string })[] = [];
  let n = 0;
  const nextId = () => `S${++n}`;
  const linkedinLines: string[] = [];
  const hasProfile = !!req.profile;
  if (req.profile) {
    const id = nextId();
    const url =
      person.linkedinUrl ??
      (req.profile.publicIdentifier ? `https://www.linkedin.com/in/${req.profile.publicIdentifier}` : '');
    const text = profileText(req.profile, card.fullName);
    sources.push({ id, kind: 'linkedin_profile', url, title: 'LinkedIn profile', text });
    linkedinLines.push(`[${id}] profile\n${text}`);
  }
  for (const p of (req.posts ?? []).slice(0, 10)) {
    if (!p.text?.trim()) continue;
    const id = nextId();
    const text = p.text.slice(0, 1500);
    sources.push({
      id,
      kind: 'linkedin_post',
      url: p.url ?? '',
      title: 'LinkedIn post',
      published: p.date ?? null,
      text,
    });
    linkedinLines.push(`[${id}] post ${p.date ?? ''}\n${text}`);
  }
  for (const p of personPages)
    sources.push({
      id: nextId(),
      kind: 'web',
      url: p.url,
      title: p.title,
      published: p.published ?? null,
      text: p.text,
    });
  const firstCompany = n + 1;
  for (const p of companyPages)
    sources.push({
      id: nextId(),
      kind: 'web',
      url: p.url,
      title: p.title,
      published: p.published ?? null,
      text: p.text,
    });
  const allowed = sources.map((s) => s.id);
  const webCount = personPages.length;

  const prompt = {
    system: dossierSystem(req.student.firstName, req.student.goalSentence),
    user: dossierUser({
      userContext: req.student.context,
      person: {
        name: card.fullName,
        title: person.title,
        org: person.org,
        location: person.location,
        identities: { linkedin: person.linkedinUrl },
      },
      internalHistory: req.history?.trim().slice(0, 4000) || '(none)',
      linkedin: linkedinLines.join('\n\n') || '(no LinkedIn profile)',
      sources: sources.filter((s) => s.kind === 'web' && Number(s.id.slice(1)) < firstCompany),
      companySources: sources.filter((s) => Number(s.id.slice(1)) >= firstCompany),
    }),
  };

  let content: DossierContent | null = null;
  let model: string | null = BRIEF_MODEL;
  let partial = notes.some((x) => /cost cap|failed|cut short|out of time|not configured/.test(x));
  if (left() < WRITE_MIN_MS) notes.push('writing skipped: out of time');
  else {
    const budget = { spent, cap: limits.capUsd, notes };
    const tw = deps.clock();
    const w = await writeBrief(
      { parse: (task, schema, p) => deps.claude.parse(task, schema, { ...p, timeoutMs: left() - 6_000 }) },
      prompt,
      allowed,
      budget,
      'brief',
    );
    steps.push({
      step: 'write',
      provider: BRIEF_MODEL,
      costUsd: round4(budget.spent - spent),
      ms: deps.clock() - tw,
    });
    spent = budget.spent;
    content = w.content;
    if (w.partial) partial = true;
  }
  if (!content) {
    content = linkedInOnlyBrief({ ...req, person }, card, hasProfile, webCount > 0);
    model = null;
    partial = true;
  }
  content = finish(content, historyOf, webCount === 0 && !hasProfile);
  // the honest default: nothing on the web beyond LinkedIn is said plainly, never padded
  if (webCount === 0)
    content = { ...content, who: honestWho(content.who, person.firstName || card.fullName.split(' ')[0]!) };

  // 5. the support check
  const fallbackWho = linkedInOnlyBrief({ ...req, person }, card, hasProfile, webCount > 0).who;
  let checked = false;
  let dropped: string[] = [];
  if (model) {
    const ts = deps.clock();
    const sc = await supportCheck(deps.claude, content, sources, {
      budgetUsd: limits.capUsd - spent,
      timeoutMs: Math.min(20_000, left() - 1_500),
      fallbackWho,
    });
    spent += sc.costUsd;
    checked = sc.checked;
    content = sc.content;
    dropped = sc.dropped ?? [];
    steps.push({
      step: 'support',
      provider: 'claude-haiku-5-5',
      costUsd: round4(sc.costUsd),
      ms: deps.clock() - ts,
      n: sc.removed,
    });
    if (!sc.checked)
      notes.push('support check skipped; nothing from this brief becomes a fact or a draft line');
    else if (sc.removed) notes.push(`${sc.removed} unsupported claim${sc.removed === 1 ? '' : 's'} removed`);
  }
  // linked-in-only and fallback briefs restate the profile: their claims are the profile's own words
  if (!model) content = markProfileOnly(content);

  const storedSources: DossierSource[] = sources.map(({ text: _t, ...s }) => s);
  return {
    status: partial ? 'partial' : 'ready',
    content: { ...content, ...(deeperMode ? { deeper: deeperMode } : {}) } as DossierContent,
    sources: storedSources,
    costUsd: round4(spent),
    model,
    promptVersion: PROMPT_VERSION,
    notes,
    steps,
    strongPages: webCount,
    provider,
    checked,
    debug: { dropped },
  };
}

/** A brief assembled from the profile alone: every line is the profile's own, so it counts as supported. */
function markProfileOnly(d: DossierContent): DossierContent {
  const m = <T extends object>(xs: T[] | undefined) => (xs ?? []).map((x) => ({ ...x, support: 'full' }));
  return {
    ...d,
    now: { ...d.now, support: 'full' } as DossierContent['now'],
    career: m(d.career) as DossierContent['career'],
    education: m(d.education) as DossierContent['education'],
  };
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
