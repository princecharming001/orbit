/**
 * The investigator loop (docs/plan/20, "investigator" section): how deep research reaches past LinkedIn to the niche
 * public record of a person (the club they ran, the award a school published, the talk, the side project) cheaply.
 *
 *   1. Wide: 12 to 16 searches from every anchor LinkedIn gives (each employer, each school including high school,
 *      their city) and from the kinds of pages niche facts live on (awards, officer roles, teams, hackathons, talks,
 *      their own accounts). Plain queries go to Parallel (fast mode, five per request); queries with operators
 *      (site:, OR) to Serper, which is Google. Either does all of them when the other is not set up.
 *   2. Read: each page that names them is fetched straight from its site (pageText.ts), for nothing; a page that
 *      cannot be fetched keeps the search engine's excerpt.
 *   3. Extract and judge: the fast model reads each page against who they are (timeline, places, field) and answers
 *      whether it is them (yes, likely, no), what the page says they did (each fact with a short quote), and leads
 *      worth searching next (an organization, a team, an award, a project). A page that only matches the name can be
 *      "likely" them when everything on it fits; a page that contradicts them is dropped.
 *   4. Follow-ups: the leads become new searches with their name, round after round (GPT Researcher's recursive
 *      step), until the rounds run out, nothing new turns up, or the time or money does.
 *   5. Their accounts: usernames they published on their own pages, and a distinctive LinkedIn address, are checked
 *      on the sites in handles.ts (from Maigret's database); an account found is read and judged like any page.
 *
 * Searches, pages and each page's reading are kept in the shared 7-day cache, so Go deeper (more rounds) and a retry
 * pay only for what is new. Nothing here writes the brief: the caller writes it from the facts.
 */
import type { ProviderResult } from '../providers/request';
import { cacheKey } from '../providers/request';
import type { SearchEngine, WebHit } from '../providers/webSearch';
import { z } from '../providers/zod';
import type { ClaudeDep } from './deps';
import { isBlockedSource, isLinkedInCopy, sensitiveCategory } from './guards';
import { distinctiveSlug, findAccounts } from './handles';
import { type IdentityCard, scorePage } from './identity';
import { type FetchedPage, fetchPage, profileHandle } from './pageText';
import { normalizeUrl, type SharedCache, WEB_CACHE_MS } from './web';

export const EXTRACT_VERSION = 'extract-v1';
/** pages read in the first round, and in each follow-up */
export const WIDE_PAGES = 18;
export const FOLLOW_PAGES = 10;
/** new searches a round of leads may add */
export const LEADS_PER_ROUND = 6;
/** extraction calls at once */
const EXTRACT_CONCURRENCY = 8;
/** what one extraction costs at most before the model says (a 9,000-character page on the fast model) */
export const EXTRACT_ESTIMATE_USD = 0.0012;

export interface InvestigateDeps {
  /** in order of preference; the first configured one takes plain queries, Serper takes operator queries */
  engines: SearchEngine[];
  claude: ClaudeDep;
  cache: SharedCache;
  fetch?: typeof fetch;
  clock: () => number;
}

export interface InvestigateInput {
  card: IdentityCard;
  /** who they are, for the judge: the LinkedIn profile as text (roles and schools with their dates) */
  profile: string;
  /** their current title, for the objective */
  title?: string;
}

export interface InvestigateOptions {
  /** follow-up rounds after the wide one */
  rounds: number;
  budgetUsd: number;
  /** the clock time the loop must be done by (the writer needs the rest) */
  deadline: number;
}

export interface FoundPage {
  url: string;
  title?: string;
  published?: string | null;
  /** yes: surely them; likely: their name and everything fits, nothing ties it to them for certain */
  match: 'yes' | 'likely';
  facts: { text: string; date?: string; quote?: string }[];
  /** the facts as a source's text, for the writer and the support check */
  text: string;
}

export interface InvestigateStep {
  step: string;
  provider: string;
  costUsd: number;
  ms: number;
  n?: number;
  error?: string;
}

export interface InvestigateResult {
  pages: FoundPage[];
  costUsd: number;
  notes: string[];
  steps: InvestigateStep[];
  /** every search run, for the log */
  queries: string[];
  rounds: number;
  accounts: string[];
}

const quote = (s: string) => `"${s}"`;
const hasOperator = (q: string) => /\bsite:|\sOR\s/.test(q);

/** The first round's searches, from every anchor the profile gives. */
export function widePlan(card: IdentityCard, title?: string): string[] {
  const name = quote(card.fullName);
  const now = card.employers.find((e) => e.current) ?? card.employers[0];
  const before = card.employers.filter((e) => e !== now).slice(0, 2);
  const qs = [
    name,
    now ? `${name} ${now.name}` : undefined,
    ...before.map((e) => `${name} ${e.name}`),
    ...card.schools.slice(0, 4).map((s) => `${name} ${s.name}`),
    card.city ? `${name} ${card.city}` : undefined,
    `${name} award OR officer OR president OR captain OR team`,
    `${name} hackathon OR project OR founder OR built`,
    `${name} podcast OR interview OR talk OR speaker`,
    card.schools[0] ? `${name} ${card.schools[0].name} club OR society OR chapter` : undefined,
    `${name} site:instagram.com`,
    `${name} site:youtube.com OR site:tiktok.com`,
    `${name} site:github.com OR site:devpost.com`,
    `${name} site:medium.com OR site:substack.com`,
    title && now ? `${name} ${title}` : undefined,
  ];
  return [...new Set(qs.filter((q): q is string => !!q?.trim()))].slice(0, 16);
}

/** Lead phrases into new searches with their name: never one already run, never the name alone. */
export function followUps(card: IdentityCard, leads: string[], ran: Set<string>): string[] {
  const name = quote(card.fullName);
  const out: string[] = [];
  for (const lead of leads) {
    const l = lead.replace(/["“”]/g, '').trim();
    if (l.length < 3 || l.length > 60) continue;
    if (card.names.some((n) => l.toLowerCase().includes(n))) continue;
    const q = `${name} ${l}`;
    const k = q.toLowerCase();
    if (ran.has(k) || out.some((x) => x.toLowerCase() === k)) continue;
    out.push(q);
  }
  return out.slice(0, LEADS_PER_ROUND);
}

// ---- reading each page against who they are ------------------------------------------------------------------

export const extractSchema = z.object({
  match: z.enum(['yes', 'likely', 'no']),
  why: z.string(),
  facts: z.array(z.object({ text: z.string(), date: z.string(), quote: z.string() })),
  leads: z.array(z.string()),
});
export type Extracted = z.output<typeof extractSchema>;

export function extractSystem(): string {
  return [
    'You read one web page for a research tool and report what it says about one specific person, described in <person>.',
    'match: "yes" when the page is clearly about this person: their name and something that ties it to them (a school, employer, team, city or link of theirs). "likely" when it names someone with their name and everything on it fits their timeline, places and field, but nothing ties it to them for certain. "no" when it is about someone else, contradicts their timeline, places or field, or does not mention them. why: one short sentence saying what decided it.',
    'facts: up to 8 things the page says this person did, made, won, led, joined, wrote or said, each one sentence in plain words, with the date or year the page gives ("" when none) and a quote of at most 25 words copied exactly from the page that supports it. Only what the page itself states about this person; nothing about anyone else.',
    'Never include, even when the page says it: age or birthday, ethnicity, religion, health, family members or relationships, sexuality, politics or donations, where they live (a city is the finest), phone numbers, email addresses, money or pay, grades, legal matters or immigration.',
    'Anything from when they were under 18: keep only achievements an organization published about them (an award, an officer role, a team they were on, a competition result), nothing personal, and nothing from their own social accounts from that time.',
    'leads: up to 5 short phrases (2 to 6 words) worth searching next together with their name: organizations, clubs, teams, programs, awards, competitions, projects, events or publications this page connects them to (for example "DECA", "National Society of High School Scholars"). Not their name, not generic words.',
    'With match "no", leave facts and leads empty.',
  ].join('\n');
}

export function extractUser(
  input: InvestigateInput,
  page: { url: string; title?: string; text: string },
): string {
  return [
    `<person>\nName: ${input.card.fullName}\n${input.profile}\n</person>`,
    `<page>\nurl: ${page.url}\n${page.title ? `title: ${page.title}\n` : ''}${page.text}\n</page>`,
  ].join('\n');
}

/** The facts of a page as a source's text: what the writer writes from and the support check checks against. */
export function factsText(facts: FoundPage['facts']): string {
  return [
    'What this page says about them:',
    ...facts.map((f) => `- ${f.text}${f.date ? ` (${f.date})` : ''}${f.quote ? ` Quote: "${f.quote}"` : ''}`),
  ].join('\n');
}

/** Run promises a few at a time, keeping their order. */
async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await f(xs[k]!);
      }
    }),
  );
  return out;
}

/** Run the loop. Never throws: a search engine or the model failing ends the loop with what it has. */
export async function investigate(
  deps: InvestigateDeps,
  input: InvestigateInput,
  opts: InvestigateOptions,
): Promise<InvestigateResult> {
  const { card } = input;
  const out: InvestigateResult = {
    pages: [],
    costUsd: 0,
    notes: [],
    steps: [],
    queries: [],
    rounds: 0,
    accounts: [],
  };
  const left = () => opts.deadline - deps.clock();
  const ran = new Set<string>();
  const seen = new Set<string>();
  const handles = new Set<string>();
  const slug = distinctiveSlug(card.slug);
  if (slug) handles.add(slug);
  const objective = `Pages about ${card.fullName}${input.title ? `, ${input.title}` : ''}${
    card.employers[0] ? ` at ${card.employers[0].name}` : ''
  }${card.schools[0] ? `, ${card.schools[0].name}` : ''}: what they did, won, led, made or said.`;
  const engines = deps.engines.filter((e) => e.configured);
  const plain = engines.find((e) => e.name === 'parallel') ?? engines[0];
  const operator = engines.find((e) => e.name === 'serper') ?? engines[0];
  if (!plain || !operator) {
    out.notes.push('no search engine is configured for the investigator loop');
    return out;
  }

  /** One search call through an engine, from the cache when it ran this week. */
  const searchCall = async (engine: SearchEngine, queries: string[]): Promise<WebHit[]> => {
    const key = await cacheKey(`${engine.name}:search`, {
      q: queries,
      o: engine.name === 'parallel' ? objective : '',
    });
    const cached = (await deps.cache.get(key)) as WebHit[] | undefined;
    if (cached) {
      out.steps.push({ step: 'search', provider: engine.name, costUsd: 0, ms: 0, n: cached.length });
      return cached;
    }
    if (out.costUsd + engine.usdPerCall > opts.budgetUsd) {
      out.notes.push('a search was skipped: cost cap');
      return [];
    }
    const t0 = deps.clock();
    let r: ProviderResult<WebHit[]> = await engine.search(queries, objective);
    out.costUsd += engine.usdPerCall;
    // Parallel out of credit or down: the other engine takes it, one query at a time
    if (!r.ok && engine !== operator && operator.configured) {
      out.notes.push(`${engine.name} search failed (${r.message.slice(0, 80)}); used ${operator.name}`);
      const hits: WebHit[] = [];
      for (const q of queries) {
        const s = await operator.search([q], objective);
        out.costUsd += operator.usdPerCall;
        if (s.ok) hits.push(...s.value);
      }
      r = { ok: true, value: hits };
    }
    if (!r.ok) {
      out.steps.push({
        step: 'search',
        provider: engine.name,
        costUsd: 0,
        ms: deps.clock() - t0,
        error: r.message,
      });
      out.notes.push(`${engine.name} search failed (${r.message.slice(0, 80)})`);
      return [];
    }
    const hits = r.value.filter((h) => !isBlockedSource(h.url));
    out.steps.push({
      step: 'search',
      provider: engine.name,
      costUsd: engine.usdPerCall,
      ms: deps.clock() - t0,
      n: hits.length,
    });
    await deps.cache.put(key, `${engine.name}:search`, hits, WEB_CACHE_MS);
    return hits;
  };

  /** Run a round's queries: plain ones batched on the plain engine, operator ones one by one on Serper. */
  const search = async (queries: string[]): Promise<WebHit[]> => {
    for (const q of queries) ran.add(q.toLowerCase());
    out.queries.push(...queries);
    const ops = queries.filter((q) => hasOperator(q) && operator.name === 'serper');
    const rest = queries.filter((q) => !ops.includes(q));
    const calls: Promise<WebHit[]>[] = [];
    for (let i = 0; i < rest.length; i += plain.queriesPerCall)
      calls.push(searchCall(plain, rest.slice(i, i + plain.queriesPerCall)));
    for (const q of ops) calls.push(searchCall(operator, [q]));
    return (await Promise.all(calls)).flat();
  };

  /** A page's text: from the cache, the site itself, or else the search excerpt. */
  const read = async (hit: WebHit): Promise<(FetchedPage & { fromExcerpt?: boolean }) | undefined> => {
    const key = await cacheKey('page', { url: normalizeUrl(hit.url) });
    const cached = (await deps.cache.get(key)) as FetchedPage | undefined;
    if (cached?.text) return { ...cached, profiles: cached.profiles ?? [] };
    const page = await fetchPage(hit.url, {
      fetch: deps.fetch,
      timeoutMs: Math.min(6000, Math.max(1500, left() - 2000)),
    });
    if (page) {
      await deps.cache.put(key, 'page', page, WEB_CACHE_MS);
      return page;
    }
    if (!hit.snippet) return undefined;
    return {
      url: hit.url,
      title: hit.title,
      text: hit.snippet,
      profiles: [],
      published: hit.published,
      fromExcerpt: true,
    };
  };

  /** The fast model's reading of one page, from the cache when someone researched this person this week. */
  const extract = async (page: {
    url: string;
    title?: string;
    text: string;
  }): Promise<Extracted | undefined> => {
    const key = await cacheKey('extract', {
      v: EXTRACT_VERSION,
      url: normalizeUrl(page.url),
      who: card.fullName,
      slug: card.slug ?? '',
    });
    const cached = (await deps.cache.get(key)) as Extracted | undefined;
    if (cached) return cached;
    if (out.costUsd + EXTRACT_ESTIMATE_USD > opts.budgetUsd) return undefined;
    if (left() < 4000) return undefined;
    const r = await deps.claude.parse('extract', extractSchema, {
      system: extractSystem(),
      user: extractUser(input, page),
      timeoutMs: Math.min(25_000, left() - 1000),
    });
    out.costUsd += r.costUsd ?? 0;
    if (!r.ok) return undefined;
    await deps.cache.put(key, 'extract', r.value, WEB_CACHE_MS);
    return r.value;
  };

  /** Read, judge and keep a round's pages; the leads and handles they give. */
  const take = async (hits: WebHit[], max: number): Promise<string[]> => {
    const fresh: WebHit[] = [];
    for (const h of hits) {
      const k = normalizeUrl(h.url);
      if (seen.has(k) || isLinkedInCopy(h.url) || isBlockedSource(h.url)) continue;
      // only pages whose title, address or excerpt carries their name are worth reading
      const s = scorePage({ url: h.url, title: h.title, text: h.snippet }, card);
      if (s.strength === 'none' && h.snippet) continue;
      seen.add(k);
      fresh.push(h);
    }
    const ranked = fresh
      .map((h) => ({ h, n: scorePage({ url: h.url, title: h.title, text: h.snippet }, card).signals.length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, max)
      .map((x) => x.h);
    const t0 = deps.clock();
    // a page built in the browser reads as an empty shell from the server: the search excerpt that named them stays
    const pages = (
      await Promise.all(
        ranked.map(async (h) => {
          const p = await read(h);
          if (p && h.snippet && !p.fromExcerpt && scorePage(p, card).strength === 'none')
            return { ...p, text: `${h.snippet}\n\n${p.text}` };
          return p;
        }),
      )
    ).filter((p): p is NonNullable<typeof p> => !!p);
    out.steps.push({ step: 'read', provider: 'direct', costUsd: 0, ms: deps.clock() - t0, n: pages.length });
    const named = pages.filter((p) => scorePage(p, card).strength !== 'none');
    const t1 = deps.clock();
    const spentBefore = out.costUsd;
    const readings = await mapLimit(named, EXTRACT_CONCURRENCY, extract);
    out.steps.push({
      step: 'extract',
      provider: 'claude-haiku-5-5',
      costUsd: round4(out.costUsd - spentBefore),
      ms: deps.clock() - t1,
      n: readings.filter(Boolean).length,
    });
    const leads: string[] = [];
    named.forEach((p, i) => {
      const x = readings[i];
      if (!x || x.match === 'no') return;
      const strong = scorePage(p, card).strength === 'strong';
      const match: FoundPage['match'] = strong && x.match === 'yes' ? 'yes' : 'likely';
      const facts = x.facts
        .filter((f) => f.text.trim() && !sensitiveCategory(`${f.text} ${f.quote}`))
        .map((f) => ({
          text: f.text.trim(),
          date: f.date?.trim() || undefined,
          quote: f.quote?.trim() || undefined,
        }));
      if (!facts.length) return;
      out.pages.push({
        url: p.url,
        title: p.title,
        published: p.published ?? null,
        match,
        facts,
        text: factsText(facts),
      });
      leads.push(...x.leads);
      // their own links, on a page that is surely theirs: the usernames to look for elsewhere
      if (match === 'yes')
        for (const l of p.profiles) {
          const h = profileHandle(l);
          if (h) handles.add(h);
        }
    });
    return leads;
  };

  // 1–3. the wide round
  const reserve = 3000;
  let leads = await take(await search(widePlan(card, input.title)), WIDE_PAGES);
  // 5. their accounts, once: the usernames gathered so far
  if (handles.size && left() > 20_000) {
    const t0 = deps.clock();
    const found = await findAccounts([...handles], {
      fetch: deps.fetch,
      timeoutMs: Math.min(6000, left() - 12_000),
    });
    out.accounts = found.map((a) => a.url);
    out.steps.push({
      step: 'accounts',
      provider: 'maigret-sites',
      costUsd: 0,
      ms: deps.clock() - t0,
      n: found.length,
    });
    if (found.length)
      leads.push(
        ...(await take(
          found.map((a) => ({ url: a.url, title: `${a.site}: ${a.handle}` })),
          FOLLOW_PAGES,
        )),
      );
  }
  // 4. follow-up rounds from the leads
  for (let round = 1; round <= opts.rounds; round++) {
    if (left() < 18_000 + reserve) {
      out.notes.push('follow-up searches stopped: out of time');
      break;
    }
    if (out.costUsd >= opts.budgetUsd * 0.85) {
      out.notes.push('follow-up searches stopped: cost cap');
      break;
    }
    const next = followUps(card, leads, ran);
    if (!next.length) break;
    out.rounds = round;
    leads = await take(await search(next), FOLLOW_PAGES);
  }
  out.costUsd = round4(out.costUsd);
  // surely-them pages first, then the likely ones; within each, the ones with most to say
  out.pages.sort((a, b) =>
    a.match === b.match ? b.facts.length - a.facts.length : a.match === 'yes' ? -1 : 1,
  );
  return out;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
