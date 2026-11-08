/**
 * Web sourcing (plan 31): people from the public pages where they are listed. For an ask that names a place (a school
 * or an organization) and a subject (a topic, a role, keywords), Orbit searches for that place's faculty or team pages
 * and the subject's lab or group pages, reads the best few, and has Haiku list the people each page names: title,
 * email exactly as the page writes it, what they work on, a lab page when linked. Each becomes a Candidate with
 * `email`, `url` and `evidence`, the lines a first message is written from.
 *
 * An ask that names no place is not searched for the whole world: for advice and collaboration the student's own
 * school stands in (its people share the student's background), and only when every other source found nobody
 * does a last pass search by the subject alone (search.ts relaxes `place`).
 *
 * Who searches is the same chain as deep research (research/web.ts): Exa when its key is set, Claude's own web search
 * and fetch otherwise, both through the shared 7-day cache. Nothing here guesses an email: a person the page lists
 * without one comes back without one.
 */

import { z } from '../providers/zod';
import type { BudgetDep, ClaudeDep, Clock } from '../research/deps';
import { isBlockedSource } from '../research/guards';
import { decodeEntities, fetchPage } from '../research/pageText';
import {
  type GatherPlan,
  gatherFrom,
  type SearchHit,
  type WebPage,
  type WebQuery,
  type WebSource,
} from '../research/web';
import type { Candidate, SourcingGoal } from './search';
import { isSchoolOrg } from './warmth';

export const WEB_PROMPT_VERSION = 'sourcing-web-v1.0';
/** pages read at most in one run */
export const WEB_MAX_PAGES = 6;
/** characters of a page the reader sees */
export const WEB_PAGE_CHARS = 9000;
/** people kept from one page at most */
export const WEB_PEOPLE_PER_PAGE = 25;
/** what one run may spend on searching and reading, before the fit call */
export const WEB_BUDGET_USD = 0.25;
export const WEB_TIMEOUT_MS = 45_000;
/** profile pages followed from the directories, for the people still missing an email or what they work on */
export const WEB_PROFILE_PAGES = 16;
export const PROFILE_FETCH_MS = 7000;
const UA = 'Mozilla/5.0 (compatible; OrbitBot/1.0; +https://tryorbit.today)';

/** The place and subject of an ask: "UC Berkeley" and "biomedical research", with the role sought when said. */
export interface WebAsk {
  place: string;
  subject: string;
  role?: string;
  /** no place was named: the student's own school stood in, so the people found share their background */
  assumedPlace?: boolean;
  /** no place at all: the subject alone drives the searches, the last pass when nothing else found anyone */
  broad?: boolean;
}

/** How a place may be filled in when the ask names none. */
export interface WebAskOptions {
  /** stands in for a missing place (the student's school) */
  fallbackPlace?: string;
  /** allow an ask with no place at all */
  broad?: boolean;
}

const ROLE_WORDS =
  /\b(professors?|faculty|pis?|principal investigators?|postdocs?|phd students?|researchers?|scientists?|engineers?|recruiters?|founders?|product managers?|pms?|designers?|analysts?)\b/i;

/**
 * The ask from the goal: the school or first organization as the place, the topic or keywords as the subject. When
 * neither filter named a place, the query is read for "… at <place>" or "<place> <subject>" ("berkeley biomed
 * professors"); undefined when no place can be told, so the web is not searched for the whole world.
 */
export function webAsk(goal: SourcingGoal, opts: WebAskOptions = {}): WebAsk | undefined {
  const text = [goal.topic, goal.title, ...(goal.keywords ?? [])].filter(Boolean).join(' ').trim();
  const role = text.match(ROLE_WORDS)?.[1]?.toLowerCase();
  let place = (goal.school ?? goal.orgs?.[0] ?? '').trim();
  let subject = (goal.topic ?? goal.keywords?.join(' ') ?? '').trim();
  if (!place) {
    const at = text.match(
      /\b(?:at|@|from)\s+((?:the\s+)?[\w.&'-]+(?:\s+[\w.&'-]+){0,4}?)(?=\s+(?:for|about|on|who|doing|working|in|studying|researching)\b|[,.;]|$)/i,
    );
    if (at?.[1]) place = at[1].replace(/^the\s+/i, '').trim();
  }
  let assumedPlace = false;
  if (!place && opts.fallbackPlace?.trim()) {
    place = opts.fallbackPlace.trim();
    assumedPlace = true;
  }
  if (!place && !opts.broad) return undefined;
  // the subject is the ask without the place and the role words
  subject = (
    place
      ? subject
          .replace(new RegExp(`\\b(?:at|@|from)\\s+${escapeRe(place)}\\b`, 'i'), ' ')
          .replace(new RegExp(`\\b${escapeRe(place)}\\b`, 'i'), ' ')
      : subject
  )
    .replace(ROLE_WORDS, ' ')
    .replace(
      /\b(?:i can|i could|i should|reach out to|write to|talk to|to|contact|email|cold email|source|find|some|a few|new|me|who)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:for|about|on|in|into|doing|working on|studying|researching)\s+/i, '')
    .replace(/\s+(?:for|about|on|in|at)$/i, '')
    .trim();
  if (!subject) subject = goal.roles?.[0] ?? role ?? 'people';
  // "people" and no place is the whole world, not a search
  if (!place && subject === 'people') return undefined;
  return {
    place,
    subject,
    role,
    ...(assumedPlace ? { assumedPlace: true } : {}),
    ...(place ? {} : { broad: true }),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ACADEMIC_ROLE = /professor|faculty|pi\b|investigator|postdoc|phd|researcher|scientist/;

/** Whether the ask is for academics: a faculty-like role, or a school as the place. */
export function isAcademic(ask: WebAsk): boolean {
  if (ask.role && ACADEMIC_ROLE.test(ask.role)) return true;
  if (ask.broad) return false;
  return !!ask.assumedPlace || isSchoolOrg(ask.place);
}

/**
 * Three or four searches with the place and the subject: for a school the directory, the labs, the people page and the
 * department; for a company its team and about pages and the people who write for it; with no place, the pages that
 * list people in the subject.
 */
export function webQueries(ask: WebAsk): WebQuery[] {
  const faculty = !!ask.role && ACADEMIC_ROLE.test(ask.role);
  const who = faculty ? 'faculty' : (ask.role ?? 'team');
  const qs: WebQuery[] = ask.broad
    ? [
        { id: 'directory', query: `${ask.subject} ${who} directory email` },
        { id: 'people', query: `${ask.subject} ${who} list contact` },
        faculty || !ask.role
          ? { id: 'labs', query: `${ask.subject} lab research group people` }
          : { id: 'team', query: `${ask.subject} companies team page ${who}` },
      ]
    : isAcademic(ask)
      ? [
          { id: 'directory', query: `${ask.place} ${ask.subject} ${who}` },
          { id: 'labs', query: `${ask.place} ${ask.subject} lab research group` },
          { id: 'people', query: `${ask.place} ${ask.subject} people directory email` },
          { id: 'department', query: `${ask.place} department of ${ask.subject} ${who} profiles` },
        ]
      : [
          { id: 'team', query: `${ask.place} ${ask.subject} ${who}` },
          { id: 'about', query: `${ask.place} team about us ${ask.subject}` },
          { id: 'blog', query: `${ask.place} ${ask.subject} blog authors` },
          { id: 'people', query: `${ask.place} ${ask.subject} people email` },
        ];
  const seen = new Set<string>();
  return qs.filter((q) => {
    const k = q.query.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const DIRECTORY_WORDS =
  /faculty|people|directory|our-team|team|staff|members|lab|group|researchers|profiles?/i;
const SKIP_URL =
  /\.(pdf|docx?|pptx?|xlsx?)(\?|$)|wikipedia\.org|linkedin\.com|facebook\.com|x\.com|twitter\.com|instagram\.com|youtube\.com|ratemyprofessors/i;

/** The pages worth reading, best first: the place's own site, then anything that reads like a directory or a lab. */
export function selectPages(hits: SearchHit[], ask: WebAsk, max = WEB_MAX_PAGES): string[] {
  const placeTokens = ask.place
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) => w.length >= 3 && !['the', 'university', 'college', 'school', 'institute', 'of'].includes(w),
    );
  const academic = isAcademic(ask);
  const scored = hits
    .filter((h) => h.url && !SKIP_URL.test(h.url) && !isBlockedSource(h.url))
    .map((h) => {
      let host = '';
      try {
        host = new URL(h.url).hostname.toLowerCase();
      } catch {
        return { url: h.url, score: -10 };
      }
      const text = `${h.url} ${h.title ?? ''}`.toLowerCase();
      let score = 0;
      if (academic && /\.edu(\.|$)|\.ac\.[a-z]{2}$/.test(host)) score += 3;
      if (placeTokens.some((t) => host.includes(t))) score += 3;
      if (DIRECTORY_WORDS.test(text)) score += 2;
      if (
        ask.subject
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length >= 4 && text.includes(w))
      )
        score += 1;
      if (/news|event|admission|apply|course|syllabus|calendar/.test(text)) score -= 2;
      return { url: h.url, score };
    })
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    const k = s.url
      .replace(/[#?].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.url);
    if (out.length >= max) break;
  }
  return out;
}

export const webPeopleSchema = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      title: z.string().nullable(),
      department: z.string().nullable(),
      email: z.string().nullable(),
      works_on: z.array(z.string()),
      lab_url: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});

export function webReadSystem(): string {
  return [
    'You read one public web page for a networking tool and list the people it names, for a student deciding whom to write to.',
    'Rules:',
    '- List only people the page itself names. Never add anyone from memory.',
    '- email: only when it is written on the page, exactly as written; turn " [at] " or " (at) " into "@" and " [dot] " into ".". When the page gives several, the institutional one (.edu, .org, the organization\u2019s domain). Otherwise null.',
    '- title: as the page gives it ("Professor of Bioengineering", "Staff Engineer"); null when the page gives none.',
    '- department: the department, lab or team the page puts them in, when it says; else null.',
    '- works_on: two to four short phrases from the page about what they research or build. Empty when the page says nothing.',
    '- lab_url: a link on the page to their lab or group, when the text shows one; else null.',
    '- note: one short fact a first message could use (a recent paper, a course, a role), only from the page; else null.',
    `- At most ${WEB_PEOPLE_PER_PAGE} people; when the page lists more, the ${WEB_PEOPLE_PER_PAGE} whose field or title is closest to the ask. Skip people who do not match the ask (an administrator when faculty are asked for; a student when professors are).`,
    'Answer with the JSON only.',
  ].join('\n');
}

export function webReadUser(ask: WebAsk, page: WebPage): string {
  return [
    `<ask>${JSON.stringify(ask)}</ask>`,
    `<page url="${page.url}" title="${(page.title ?? '').replace(/"/g, "'")}">`,
    page.text.slice(0, WEB_PAGE_CHARS),
    '</page>',
  ].join('\n');
}

export interface WebSourcingOptions {
  ask: WebAsk;
  sources: WebSource[];
  claude?: ClaudeDep;
  budget?: BudgetDep;
  userId: string;
  nextKey: () => string;
  clock: Clock;
  maxPages?: number;
  timeoutMs?: number;
  /** plain page fetches for the profile pass (tests hand in a fake) */
  fetch?: typeof fetch;
  maxProfiles?: number;
}

export interface WebSourcingResult {
  candidates: Candidate[];
  costUsd: number;
  pagesRead: number;
  /** profile pages followed from the directories and read */
  profilesRead: number;
  notes: string[];
}
type Listed = z.infer<typeof webPeopleSchema>['people'][number];
interface Found {
  person: Listed;
  page: WebPage;
  profile?: string;
}

/** The anchors of a page: where each links, and the words the link shows. */
export function pageAnchors(html: string, base: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let n = 0; n < 3000; n++) {
    const m = re.exec(html);
    if (!m) break;
    const text = decodeEntities(m[2]!.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    let href = decodeEntities(m[1]!.trim());
    if (/^javascript:/i.test(href)) continue;
    if (!/^mailto:/i.test(href)) {
      try {
        href = new URL(href, base).href;
      } catch {
        continue;
      }
    }
    out.push({ href, text });
  }
  return out;
}

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !['dr', 'prof', 'professor', 'phd', 'md'].includes(w));

/**
 * For each listed person, the profile link and any mailto address the directory page itself gives them: the anchor
 * whose words are their name, and a mailto whose address starts or ends with their last name or is their initials.
 */
export function linksFor(
  anchors: { href: string; text: string }[],
  people: { name: string }[],
  base: string,
): Map<string, { profile?: string; email?: string }> {
  const out = new Map<string, { profile?: string; email?: string }>();
  let host = '';
  try {
    host = new URL(base).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const mailtos = anchors
    .filter((a) => /^mailto:/i.test(a.href))
    .map((a) => cleanEmail(a.href.replace(/^mailto:/i, '').split('?')[0]))
    .filter((e): e is string => !!e);
  const social = /linkedin\.com|twitter\.com|x\.com|facebook\.com|scholar\.google/i;
  for (const p of people) {
    const toks = nameTokens(p.name);
    if (toks.length < 2) continue;
    const first = toks[0]!;
    const last = toks[toks.length - 1]!;
    const lastKey = last.replace(/[^a-z]/g, '');
    const entry: { profile?: string; email?: string } = {};
    const byText = anchors.find((a) => {
      if (/^mailto:/i.test(a.href)) return false;
      const t = a.text.toLowerCase();
      return t.includes(first) && t.includes(last) && t.length <= p.name.length + 40;
    });
    if (byText) {
      if (!social.test(byText.href)) entry.profile = byText.href;
    } else {
      // some directories link the photo or a "profile" word: the first link on the same host whose path carries
      // the last name
      const byPath = anchors.find((a) => {
        if (/^mailto:/i.test(a.href) || social.test(a.href)) return false;
        try {
          const u = new URL(a.href);
          const sameHost = !host || u.hostname.replace(/^www\./, '') === host;
          return (
            sameHost &&
            lastKey.length >= 3 &&
            new RegExp(`(^|[/_-])${lastKey}([/_.-]|$)`).test(u.pathname.toLowerCase())
          );
        } catch {
          return false;
        }
      });
      if (byPath) entry.profile = byPath.href;
    }
    const mine = mailtos.find((e) => {
      const local = e.split('@')[0]!.replace(/[^a-z]/g, '');
      return (
        lastKey.length >= 3 &&
        (local.startsWith(lastKey) ||
          local.endsWith(lastKey) ||
          local === `${first[0]}${lastKey}` ||
          local === `${first}${lastKey}`)
      );
    });
    if (mine) entry.email = mine;
    if (entry.profile || entry.email) out.set(p.name, entry);
  }
  return out;
}

async function fetchHtml(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<string | undefined> {
  if (isBlockedSource(url) || !/^https?:\/\//i.test(url)) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await doFetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en' },
    });
    if (!r.ok) return undefined;
    const type = r.headers.get('content-type') ?? '';
    if (type && !/html|xml/i.test(type)) return undefined;
    return (await r.text()).slice(0, 1_500_000);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function webProfileUser(ask: WebAsk, person: { name: string }, page: WebPage): string {
  return [
    `<ask>${JSON.stringify(ask)}</ask>`,
    `<person>${person.name}</person>`,
    'This page should be about the person named above. List only that person (one entry), with their title, email as written, what they work on and a lab link when the page gives them. If the page is not about them, answer with an empty list.',
    `<page url="${page.url}" title="${(page.title ?? '').replace(/"/g, "'")}">`,
    page.text.slice(0, WEB_PAGE_CHARS),
    '</page>',
  ].join('\n');
}

/** Search, choose pages, read them, list the people: the candidates with contact and context. */
export async function sourceFromWeb(o: WebSourcingOptions): Promise<WebSourcingResult> {
  const notes: string[] = [];
  if (!o.sources.length)
    return {
      candidates: [],
      costUsd: 0,
      pagesRead: 0,
      profilesRead: 0,
      notes: ['no web search is configured'],
    };
  if (o.budget) {
    const v = await o.budget.check(o.userId, 'claude', WEB_BUDGET_USD);
    if (!v.ok)
      return { candidates: [], costUsd: 0, pagesRead: 0, profilesRead: 0, notes: ['budget_exceeded'] };
  }
  const plan: GatherPlan = {
    queries: webQueries(o.ask),
    focus: o.ask.broad
      ? `pages that list ${o.ask.role ?? 'people'} working on ${o.ask.subject}: directories, team pages, lab and group pages`
      : `the ${o.ask.role ?? 'people'} pages of ${o.ask.place} about ${o.ask.subject}: faculty or team directories, lab and group pages`,
    maxPages: o.maxPages ?? WEB_MAX_PAGES,
  };
  const gathered = await gatherFrom(o.sources, plan, {
    budgetUsd: WEB_BUDGET_USD,
    timeoutMs: o.timeoutMs ?? WEB_TIMEOUT_MS,
    select: (hits) => selectPages(hits, o.ask, plan.maxPages),
  });
  notes.push(...gathered.notes);
  if (gathered.costUsd > 0)
    await o.budget?.record(o.userId, {
      provider: 'claude',
      operation: 'sourcing_web',
      units: gathered.pages.length,
      costUsd: gathered.costUsd,
    });
  const pages = gathered.pages.filter((p) => p.text.trim().length > 200).slice(0, plan.maxPages);
  if (!pages.length)
    return {
      candidates: [],
      costUsd: gathered.costUsd,
      pagesRead: 0,
      profilesRead: 0,
      notes: [...notes, 'no readable pages'],
    };
  if (!o.claude)
    return {
      candidates: [],
      costUsd: gathered.costUsd,
      pagesRead: pages.length,
      profilesRead: 0,
      notes: [...notes, 'no reader configured'],
    };

  const read = await Promise.all(
    pages.map(async (page) => {
      const r = await o.claude!.parse('extract', webPeopleSchema, {
        system: webReadSystem(),
        user: webReadUser(o.ask, page),
        timeoutMs: 30_000,
      });
      return r.ok ? { page, people: r.value.people.slice(0, WEB_PEOPLE_PER_PAGE) } : { page, people: [] };
    }),
  );
  notes.push(`searched ${gathered.hits.length} hits, read ${pages.length} pages`);

  // the people, one entry each (the same person on two pages keeps the first, filled in from the second)
  const found = new Map<string, Found>();
  const keyOf = (name: string, email?: string, dept?: string | null) =>
    email ? `em:${email}` : `nm:${name.toLowerCase()}|${(dept ?? o.ask.place).toLowerCase()}`;
  const cleanName = (n: string) =>
    n
      .replace(/\s+/g, ' ')
      .replace(/^(?:dr|prof|professor)\.?\s+/i, '')
      .replace(/,.*$/, '')
      .trim();
  for (const { page, people } of read)
    for (const p of people) {
      const name = cleanName(p.name);
      if (!name || name.split(' ').length < 2) continue;
      const email = cleanEmail(p.email);
      const k = keyOf(name, email, p.department);
      const prev = found.get(k);
      if (prev) {
        fill(prev.person, { ...p, email: email ?? null });
        continue;
      }
      found.set(k, { person: { ...p, name, email: email ?? null }, page });
    }

  // 2. the directory pages' own links: a mailto for a person, and their profile page, read for the email and the
  //    research the listing left out (plain fetches, one small read each)
  const doFetch = o.fetch;
  let profilesRead = 0;
  if (doFetch && found.size) {
    const byPage = new Map<string, Found[]>();
    for (const e of found.values()) byPage.set(e.page.url, [...(byPage.get(e.page.url) ?? []), e]);
    await Promise.all(
      [...byPage.entries()].map(async ([url, entries]) => {
        const html = await fetchHtml(url, doFetch, PROFILE_FETCH_MS);
        if (!html) return;
        const links = linksFor(
          pageAnchors(html, url),
          entries.map((e) => e.person),
          url,
        );
        for (const e of entries) {
          const l = links.get(e.person.name);
          if (!l) continue;
          if (l.email && !e.person.email) e.person.email = l.email;
          if (l.profile) e.profile = l.profile;
        }
      }),
    );
    // the profiles worth a read first: the people whose title or department already sounds like the subject
    const subjectWords = o.ask.subject
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4);
    const closeness = (e: Found) => {
      const t = `${e.person.title ?? ''} ${e.person.department ?? ''}`.toLowerCase();
      return subjectWords.filter((w) => t.includes(w.slice(0, Math.min(w.length, 6)))).length;
    };
    const want = [...found.values()]
      .filter((e) => e.profile && (!e.person.email || !e.person.works_on.length))
      .sort((a, b) => closeness(b) - closeness(a))
      .slice(0, o.maxProfiles ?? WEB_PROFILE_PAGES);
    await Promise.all(
      want.map(async (e) => {
        const page = await fetchPage(e.profile!, { fetch: doFetch, timeoutMs: PROFILE_FETCH_MS });
        if (!page || page.text.trim().length < 120) return;
        const web: WebPage = { url: page.url, title: page.title, text: page.text, published: page.published };
        const r = await o.claude!.parse('extract', webPeopleSchema, {
          system: webReadSystem(),
          user: webProfileUser(o.ask, e.person, web),
          timeoutMs: 30_000,
        });
        if (!r.ok) return;
        profilesRead++;
        const mine = nameTokens(e.person.name);
        const p = r.value.people.find((x) => {
          const t = nameTokens(x.name);
          return t.length > 0 && mine.length > 0 && t[t.length - 1] === mine[mine.length - 1];
        });
        if (!p) return;
        fill(e.person, { ...p, email: cleanEmail(p.email) ?? null });
        e.page = { ...web, title: web.title ?? e.page.title };
      }),
    );
    notes.push(`read ${profilesRead} profile pages`);
  }

  const out: Candidate[] = [];
  for (const { person: p, page } of found.values()) {
    let host = '';
    try {
      host = new URL(page.url).hostname.replace(/^www\./, '');
    } catch {
      host = page.url;
    }
    const name = p.name;
    const worksOn = p.works_on
      .map((w) => w.trim())
      .filter(Boolean)
      .slice(0, 4);
    const evidence = [
      worksOn.length ? `Works on ${worksOn.join(', ')}` : undefined,
      p.note?.trim() || undefined,
      p.lab_url ? `Lab page: ${p.lab_url}` : undefined,
      `Listed on ${page.title?.trim() || host} (${page.url})`,
    ].filter((x): x is string => !!x);
    const [firstName, ...rest] = name.split(' ');
    out.push({
      key: o.nextKey(),
      entity: 'person',
      name,
      firstName,
      lastName: rest.join(' '),
      title: p.title?.trim() || (o.ask.role ? titleCase(o.ask.role.replace(/s$/, '')) : undefined),
      org: p.department
        ? o.ask.broad
          ? p.department.trim()
          : `${p.department.trim()}, ${o.ask.place}`
        : o.ask.broad
          ? undefined
          : o.ask.place,
      headline: worksOn.join(', ') || undefined,
      email: p.email ?? undefined,
      url: page.url,
      evidence,
      sources: ['web'],
      externalIds: { web: `${page.url}#${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
    });
  }
  return { candidates: out, costUsd: gathered.costUsd, pagesRead: pages.length, profilesRead, notes };
}

/** What a later page adds to a person already listed: only the fields still empty. */
function fill(into: Listed, from: Listed): void {
  if (!into.email && from.email) into.email = from.email;
  if (!into.works_on.length && from.works_on.length) into.works_on = from.works_on;
  if (!into.title && from.title) into.title = from.title;
  if (!into.lab_url && from.lab_url) into.lab_url = from.lab_url;
  if (!into.note && from.note) into.note = from.note;
}

function cleanEmail(e: string | null | undefined): string | undefined {
  if (!e) return undefined;
  const s = e
    .trim()
    .replace(/\s*[[(]\s*at\s*[\])]\s*/i, '@')
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.')
    .replace(/^mailto:/i, '')
    .toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : undefined;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
