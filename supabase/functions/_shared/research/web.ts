/**
 * Where deep research reads the public web (docs/plan/20 §3): Exa when its key is set (search with highlights, then
 * the text of the pages that are surely the person), and Claude's own server tools otherwise (web_search_20260209 and
 * web_fetch_20260209 in one call: the searches as written, then the pages most likely about the person). Exa failing
 * falls back to Claude. Blocked sites (guards.ts) never reach either.
 *
 * Both answers are cached for 7 days in one store shared by every student: public search results and the public text
 * of the pages they point to, keyed by the query or the page address, never by who asked. A retry after a timeout, or
 * Go deeper after the quick brief, reads them back for nothing.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { costUsd, type Usage } from '../prices.ts';
import {
  EXA_PAGE_USD,
  type Exa,
  type ExaSearchRequest,
  estimateExaSearchUsd,
  exaCostUsd,
} from '../providers/exa';
import { cacheKey } from '../providers/request';
import { BLOCKED_SOURCE_DOMAINS, isBlockedSource, LINKEDIN_COPY_DOMAINS } from './guards';

export const WEB_CACHE_MS = 7 * 86_400_000;
/** Claude's web search: $10 per 1,000 searches; fetching adds only the page's tokens. */
export const CLAUDE_SEARCH_USD = 0.01;
/**
 * The model that runs the searches and fetches. It only calls the tools (every search at once, then every page at
 * once) and writes nothing, so the fast model does it for a fraction of a cent; the writing model writes the brief
 * from the fetched text. ORBIT_RESEARCH_GATHER_MODEL changes it.
 */
export const GATHER_MODEL = 'claude-haiku-5-5';
/** How much of a fetched page reaches the model, in tokens (the writer reads at most 6,000 characters of it). */
export const FETCH_MAX_TOKENS = 2500;
/** Characters of a page the writer reads. */
export const PAGE_CHARS = 6000;

export interface WebQuery {
  /** short label for the log: about, news, talks, company_news, hiring, more, papers */
  id: string;
  query: string;
  category?: 'people' | 'news' | 'company' | 'publication';
  /** ISO date: only pages published since then (news) */
  since?: string;
}

export interface SearchHit {
  url: string;
  title?: string;
  published?: string | null;
  /** what the search said about the page (Exa's highlights); Claude's results carry no readable text */
  snippet?: string;
  query: string;
}

export interface WebPage {
  url: string;
  title?: string;
  published?: string | null;
  text: string;
}

export interface GatherPlan {
  queries: WebQuery[];
  /** who the pages should be about, for choosing what to read: "Dana Liu, Senior PM at Stripe, Stanford" */
  focus: string;
  /** pages to read at most */
  maxPages: number;
  /** pages already read: never read again */
  skip?: string[];
}

export interface GatherStep {
  step: string;
  provider: string;
  costUsd: number;
  ms: number;
  n?: number;
  cached?: boolean;
  error?: string;
  /** tokens in and out, and searches run (Claude's web tools) */
  tokensIn?: number;
  tokensOut?: number;
  searches?: number;
}

export interface GatherResult {
  hits: SearchHit[];
  pages: WebPage[];
  costUsd: number;
  notes: string[];
  steps: GatherStep[];
}

export interface GatherContext {
  /** dollars this call may still spend */
  budgetUsd: number;
  /** milliseconds it may still take */
  timeoutMs: number;
  /**
   * Of the search hits, the pages worth reading (identity scoring happens in the caller). Exa reads only these; Claude
   * picks its own pages from the same instructions, and the caller scores what it read.
   */
  select: (hits: SearchHit[]) => string[];
}

export interface WebSource {
  readonly name: 'exa' | 'claude';
  /** a cost estimate for the plan, before any call */
  estimateUsd(plan: GatherPlan): number;
  gather(plan: GatherPlan, ctx: GatherContext): Promise<GatherResult>;
}

/** The 7-day store shared by all students (public.orbit_research_cache). */
export interface SharedCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, kind: string, value: unknown, ttlMs: number): Promise<void>;
}

export function memorySharedCache(clock: () => number = Date.now): SharedCache & {
  rows: Map<string, { kind: string; value: unknown; expires: number }>;
} {
  const rows = new Map<string, { kind: string; value: unknown; expires: number }>();
  return {
    rows,
    async get(key) {
      const r = rows.get(key);
      if (!r || r.expires <= clock()) return undefined;
      return structuredClone(r.value);
    },
    async put(key, kind, value, ttlMs) {
      rows.set(key, { kind, value: structuredClone(value), expires: clock() + ttlMs });
    },
  };
}

/** The shared cache over PostgREST with the service role key. A cache that cannot be reached is a miss, never an error. */
export function postgrestSharedCache(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
  clock: () => number = Date.now,
): SharedCache {
  const headers = {
    'content-type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  return {
    async get(key) {
      try {
        const now = new Date(clock()).toISOString();
        const r = await doFetch(
          `${url}/rest/v1/orbit_research_cache?key=eq.${encodeURIComponent(key)}&expires_at=gt.${encodeURIComponent(now)}&select=value`,
          { headers },
        );
        if (!r.ok) return undefined;
        const rows = (await r.json()) as { value?: unknown }[];
        return rows[0]?.value;
      } catch {
        return undefined;
      }
    },
    async put(key, kind, value, ttlMs) {
      try {
        await doFetch(`${url}/rest/v1/orbit_research_cache?on_conflict=key`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            key,
            kind,
            value,
            created_at: new Date(clock()).toISOString(),
            expires_at: new Date(clock() + ttlMs).toISOString(),
          }),
        });
      } catch {
        // a cache that cannot be written only means the next retry pays again
      }
    },
  };
}

const pageKey = (url: string) => cacheKey('page', { url: normalizeUrl(url) });

export function normalizeUrl(u: string): string {
  return u
    .trim()
    .replace(/#.*$/, '')
    .replace(/[?&](utm_[^=&]+|ref|fbclid|gclid)=[^&]*/g, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Read the pages already in the shared cache; the rest are returned as missing. */
async function cachedPages(cache: SharedCache, urls: string[]): Promise<{ hit: WebPage[]; miss: string[] }> {
  const hit: WebPage[] = [];
  const miss: string[] = [];
  for (const url of urls) {
    const v = (await cache.get(await pageKey(url))) as WebPage | undefined;
    if (v?.text) hit.push(v);
    else miss.push(url);
  }
  return { hit, miss };
}

/** One page's text from the shared cache, if it is there (the live check's grader reads it). */
export async function cachedPage(cache: SharedCache, url: string): Promise<WebPage | undefined> {
  return (await cache.get(await pageKey(url))) as WebPage | undefined;
}

async function keepPages(cache: SharedCache, pages: WebPage[]): Promise<void> {
  for (const p of pages)
    if (p.text && !isBlockedSource(p.url)) await cache.put(await pageKey(p.url), 'page', p, WEB_CACHE_MS);
}

const dedupe = <T extends { url: string }>(xs: T[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = normalizeUrl(x.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// ---- Exa ------------------------------------------------------------------------------------------------------

function exaRequest(q: WebQuery, highlightQuestion: string): ExaSearchRequest {
  return {
    query: q.query,
    type: 'auto',
    numResults: 5,
    ...(q.category ? { category: q.category } : {}),
    ...(q.since ? { startPublishedDate: q.since } : {}),
    excludeDomains: [...BLOCKED_SOURCE_DOMAINS],
    contents: { highlights: { query: highlightQuestion, maxCharacters: 1200 } },
  };
}

/** Exa: the searches in parallel (cached by request), then the text of the pages the caller selects (cached by page). */
export function exaWeb(exa: Exa, cache: SharedCache): WebSource {
  return {
    name: 'exa',
    estimateUsd(plan) {
      return (
        plan.queries.reduce((s, q) => s + estimateExaSearchUsd(exaRequest(q, plan.focus)), 0) +
        plan.maxPages * EXA_PAGE_USD
      );
    },
    async gather(plan, ctx) {
      const out: GatherResult = { hits: [], pages: [], costUsd: 0, notes: [], steps: [] };
      const question = `What has ${plan.focus} worked on, said or published?`;
      let failures = 0;
      await Promise.all(
        plan.queries.map(async (q) => {
          const req = exaRequest(q, question);
          const key = await cacheKey('exa:search', req);
          const t0 = Date.now();
          const hit = (await cache.get(key)) as SearchHit[] | undefined;
          if (hit) {
            out.hits.push(...hit);
            out.steps.push({
              step: `search:${q.id}`,
              provider: 'exa',
              costUsd: 0,
              ms: 0,
              n: hit.length,
              cached: true,
            });
            return;
          }
          const est = estimateExaSearchUsd(req);
          if (out.costUsd + est > ctx.budgetUsd) {
            out.notes.push(`search ${q.id} skipped: cost cap`);
            return;
          }
          out.costUsd += est;
          const r = await exa.search(req);
          out.costUsd -= est;
          if (!r.ok) {
            failures++;
            out.notes.push(`Exa search failed (${r.message})`);
            out.steps.push({
              step: `search:${q.id}`,
              provider: 'exa',
              costUsd: 0,
              ms: Date.now() - t0,
              error: r.message,
            });
            return;
          }
          const cost = exaCostUsd(r.value, est);
          out.costUsd += cost;
          const hits: SearchHit[] = r.value.results
            .filter((x) => !isBlockedSource(x.url))
            .map((x) => ({
              url: x.url,
              title: x.title ?? undefined,
              published: x.publishedDate ?? null,
              snippet:
                [x.text, ...(x.highlights ?? [])].filter(Boolean).join(' … ').slice(0, 2400) || undefined,
              query: q.query,
            }));
          out.hits.push(...hits);
          out.steps.push({
            step: `search:${q.id}`,
            provider: 'exa',
            costUsd: cost,
            ms: Date.now() - t0,
            n: hits.length,
          });
          await cache.put(key, 'exa:search', hits, WEB_CACHE_MS);
        }),
      );
      if (failures === plan.queries.length) throw new WebUnavailable('Exa is not answering');
      out.hits = dedupe(out.hits);
      const skip = new Set((plan.skip ?? []).map(normalizeUrl));
      const want = ctx
        .select(out.hits)
        .filter((u) => !skip.has(normalizeUrl(u)))
        .slice(0, plan.maxPages);
      const { hit, miss } = await cachedPages(cache, want);
      out.pages.push(...hit);
      if (miss.length) {
        const est = miss.length * EXA_PAGE_USD;
        if (out.costUsd + est > ctx.budgetUsd) out.notes.push('page text skipped: cost cap');
        else {
          const t0 = Date.now();
          const r = await exa.contents({ urls: miss, text: { maxCharacters: PAGE_CHARS }, maxAgeHours: 720 });
          if (!r.ok) {
            out.notes.push(`Exa contents failed (${r.message})`);
            out.steps.push({
              step: 'read',
              provider: 'exa',
              costUsd: 0,
              ms: Date.now() - t0,
              error: r.message,
            });
          } else {
            const cost = exaCostUsd(r.value, est);
            out.costUsd += cost;
            const pages = r.value.results
              .filter((x) => x.text && !isBlockedSource(x.url))
              .map((x) => ({
                url: x.url,
                title: x.title ?? undefined,
                published: x.publishedDate ?? null,
                text: x.text!.slice(0, PAGE_CHARS),
              }));
            out.pages.push(...pages);
            out.steps.push({
              step: 'read',
              provider: 'exa',
              costUsd: cost,
              ms: Date.now() - t0,
              n: pages.length,
            });
            await keepPages(cache, pages);
          }
        }
      }
      // a hit Exa gave highlights for but no page text still has its highlights to go on
      for (const url of want)
        if (!out.pages.some((p) => normalizeUrl(p.url) === normalizeUrl(url))) {
          const h = out.hits.find((x) => normalizeUrl(x.url) === normalizeUrl(url));
          if (h?.snippet)
            out.pages.push({ url: h.url, title: h.title, published: h.published, text: h.snippet });
        }
      return out;
    },
  };
}

// ---- Claude's own web search and fetch --------------------------------------------------------------------------

/** The provider is down or not configured: the caller tries the next one. */
export class WebUnavailable extends Error {}

/** The tool definitions for the search step and the read step (exported for the tests). */
export function claudeWebTools(n: number, step: 'search' | 'fetch') {
  const blocked = [...new Set([...BLOCKED_SOURCE_DOMAINS, 'linkedin.com'])];
  if (step === 'search')
    return [
      {
        type: 'web_search_20260209' as const,
        name: 'web_search' as const,
        max_uses: n,
        // the results come back to Orbit as they are, so identity scoring sees every page the model saw
        allowed_callers: ['direct' as const],
        blocked_domains: blocked,
      },
    ];
  return [
    {
      type: 'web_fetch_20260209' as const,
      name: 'web_fetch' as const,
      max_uses: n,
      max_content_tokens: FETCH_MAX_TOKENS,
      allowed_callers: ['direct' as const],
      blocked_domains: [...new Set([...blocked, ...LINKEDIN_COPY_DOMAINS])],
    },
  ];
}

const GATHER_SYSTEM =
  'You run web searches and fetch pages for a research tool, exactly as asked: every call at once, in parallel, in a single step. You never write anything else. When the results are back, reply with the single word: done.';

export function searchPrompt(plan: GatherPlan): string {
  return [
    'Run these web searches, exactly as written, all at once in parallel:',
    ...plan.queries.map((q, i) => `${i + 1}. ${q.query}`),
  ].join('\n');
}

export function fetchPrompt(urls: string[]): string {
  return ['Fetch these pages, all at once in parallel:', ...urls].join('\n');
}

/** Estimated dollars for the two calls on the gather model. */
export function claudeGatherEstimateUsd(plan: GatherPlan, model = GATHER_MODEL): number {
  const search =
    plan.queries.length * CLAUDE_SEARCH_USD +
    costUsd(model, { input_tokens: 4000 + plan.queries.length * 11_000, output_tokens: 600 });
  const read = costUsd(model, {
    input_tokens: 3000 + plan.maxPages * (FETCH_MAX_TOKENS + 500),
    output_tokens: 600,
  });
  return search + read;
}

type Block = { type: string; [k: string]: unknown };

/** Search hits and fetched pages out of a response's content blocks. */
export function readGatherBlocks(content: Block[]): {
  hits: SearchHit[];
  pages: WebPage[];
  searches: number;
} {
  const hits: SearchHit[] = [];
  const pages: WebPage[] = [];
  const queries = new Map<string, string>();
  let searches = 0;
  for (const b of content) {
    if (b.type === 'server_tool_use' && b.name === 'web_search') {
      searches++;
      queries.set(String(b.id), String((b.input as { query?: unknown })?.query ?? ''));
    }
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      const q = queries.get(String(b.tool_use_id)) ?? '';
      for (const r of b.content as {
        type?: string;
        url?: string;
        title?: string;
        page_age?: string | null;
      }[])
        if (r.type === 'web_search_result' && r.url && !isBlockedSource(r.url))
          hits.push({ url: r.url, title: r.title, published: r.page_age ?? null, query: q });
    }
    if (b.type === 'web_fetch_tool_result') {
      const c = b.content as {
        type?: string;
        url?: string;
        content?: { title?: string | null; source?: { type?: string; data?: string } };
      };
      if (c?.type !== 'web_fetch_result' || !c.url || isBlockedSource(c.url)) continue;
      const src = c.content?.source;
      if (src?.type !== 'text' || !src.data) continue;
      pages.push({
        url: c.url,
        title: c.content?.title ?? undefined,
        published: null,
        text: src.data.slice(0, PAGE_CHARS),
      });
    }
  }
  return { hits: dedupe(hits), pages: dedupe(pages), searches };
}

interface CallUse {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  searches: number;
  fetches: number;
}

/** One gathering call, resumed when the server pauses it; what it returned, and what it cost. */
async function gatherCall(
  client: Anthropic,
  model: string,
  user: string,
  tools: unknown[],
  timeoutMs: number,
  maxContinuations: number,
): Promise<{ blocks: Block[]; use: CallUse; error?: string }> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  const blocks: Block[] = [];
  const use: CallUse = { costUsd: 0, tokensIn: 0, tokensOut: 0, searches: 0, fetches: 0 };
  const deadline = Date.now() + timeoutMs;
  try {
    for (let i = 0; i <= maxContinuations; i++) {
      const left = deadline - Date.now();
      if (left < 2000) return { blocks, use, error: 'out of time' };
      const msg = await client.messages.create(
        {
          model,
          max_tokens: 1024,
          system: GATHER_SYSTEM,
          messages,
          tools: tools as Anthropic.ToolUnion[],
        },
        { timeout: left, maxRetries: 0 },
      );
      const usage = msg.usage as Usage & {
        server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
      };
      use.searches += usage.server_tool_use?.web_search_requests ?? 0;
      use.fetches += usage.server_tool_use?.web_fetch_requests ?? 0;
      use.tokensIn +=
        usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      use.tokensOut += usage.output_tokens;
      use.costUsd += costUsd(model, usage);
      blocks.push(...(msg.content as unknown as Block[]));
      if (msg.stop_reason !== 'pause_turn') break;
      // resume where the server paused: the same user turn and everything the assistant did so far, nothing added
      messages.splice(1, messages.length - 1, {
        role: 'assistant',
        content: blocks as unknown as Anthropic.ContentBlockParam[],
      });
    }
  } catch (e) {
    return { blocks, use, error: e instanceof Error ? e.message.slice(0, 160) : 'error' };
  } finally {
    use.costUsd += use.searches * CLAUDE_SEARCH_USD;
  }
  return { blocks, use };
}

/**
 * Claude's server tools in two small calls on a fast model: every search at once, then the pages the caller selects
 * from the results (identity scoring on their titles and addresses), all fetched at once. Each search result list is
 * cached by its query, each page by its address. The brief itself is written by the writing model from the fetched text.
 */
export function claudeWeb(
  client: Anthropic,
  cache: SharedCache,
  opts: { model?: string; maxContinuations?: number } = {},
): WebSource {
  const model = opts.model ?? GATHER_MODEL;
  const cont = opts.maxContinuations ?? 1;
  return {
    name: 'claude',
    estimateUsd: (plan) => claudeGatherEstimateUsd(plan, model),
    async gather(plan, ctx) {
      const out: GatherResult = { hits: [], pages: [], costUsd: 0, notes: [], steps: [] };
      const deadline = Date.now() + ctx.timeoutMs;
      // 1. the searches: from the cache when someone ran the same ones this week
      const missing: WebQuery[] = [];
      for (const q of plan.queries) {
        const hit = (await cache.get(await cacheKey('claude:search', { q: q.query }))) as
          | SearchHit[]
          | undefined;
        if (hit) {
          out.hits.push(...hit);
          out.steps.push({
            step: `search:${q.id}`,
            provider: 'claude',
            costUsd: 0,
            ms: 0,
            n: hit.length,
            cached: true,
          });
        } else missing.push(q);
      }
      if (missing.length) {
        const est = claudeGatherEstimateUsd({ ...plan, queries: missing, maxPages: 0 }, model);
        if (est > ctx.budgetUsd) out.notes.push('web search skipped: cost cap');
        else {
          const t0 = Date.now();
          const r = await gatherCall(
            client,
            model,
            searchPrompt({ ...plan, queries: missing }),
            claudeWebTools(missing.length, 'search'),
            Math.max(0, Math.min(deadline - Date.now(), 25_000)),
            cont,
          );
          out.costUsd += r.use.costUsd;
          const read = readGatherBlocks(r.blocks);
          out.steps.push({
            step: 'search',
            provider: 'claude',
            costUsd: r.use.costUsd,
            ms: Date.now() - t0,
            n: read.hits.length,
            tokensIn: r.use.tokensIn,
            tokensOut: r.use.tokensOut,
            searches: r.use.searches,
            ...(r.error ? { error: r.error } : {}),
          });
          if (r.error && read.hits.length === 0)
            throw new WebUnavailable(`Claude web search failed (${r.error})`);
          if (r.error) out.notes.push(`web search cut short (${r.error})`);
          out.hits.push(...read.hits);
          // each query's results on their own, so a later plan sharing a query reads it back; a query that found
          // nothing is kept too (when the call finished), so a retry does not pay for it again
          for (const q of missing) {
            const mine = read.hits.filter((h) => h.query.trim() === q.query.trim());
            if (mine.length || !r.error)
              await cache.put(
                await cacheKey('claude:search', { q: q.query }),
                'claude:search',
                mine,
                WEB_CACHE_MS,
              );
          }
        }
      }
      out.hits = dedupe(out.hits);
      // 2. the pages worth reading, from the cache first
      const skip = new Set((plan.skip ?? []).map(normalizeUrl));
      const want = ctx
        .select(out.hits)
        .filter((u) => !skip.has(normalizeUrl(u)))
        .slice(0, plan.maxPages);
      const { hit, miss } = await cachedPages(cache, want);
      out.pages.push(...hit);
      if (miss.length) {
        const est = costUsd(model, {
          input_tokens: 3000 + miss.length * (FETCH_MAX_TOKENS + 500),
          output_tokens: 600,
        });
        if (out.costUsd + est > ctx.budgetUsd) out.notes.push('page text skipped: cost cap');
        else if (deadline - Date.now() < 4000) out.notes.push('page text skipped: out of time');
        else {
          const t0 = Date.now();
          const r = await gatherCall(
            client,
            model,
            fetchPrompt(miss),
            claudeWebTools(miss.length, 'fetch'),
            Math.max(0, deadline - Date.now()),
            cont,
          );
          out.costUsd += r.use.costUsd;
          const read = readGatherBlocks(r.blocks);
          out.steps.push({
            step: 'read',
            provider: 'claude',
            costUsd: r.use.costUsd,
            ms: Date.now() - t0,
            n: read.pages.length,
            tokensIn: r.use.tokensIn,
            tokensOut: r.use.tokensOut,
            ...(r.error ? { error: r.error } : {}),
          });
          if (r.error) out.notes.push(`page reading cut short (${r.error})`);
          out.pages.push(...read.pages);
          await keepPages(cache, read.pages);
        }
      }
      // a page that came back under another address (a redirect) keeps the search's title when it had none
      for (const p of out.pages)
        if (!p.title) p.title = out.hits.find((h) => normalizeUrl(h.url) === normalizeUrl(p.url))?.title;
      out.pages = dedupe(out.pages);
      return out;
    },
  };
}

/**
 * Gather with the first source that answers: Exa when configured, Claude when Exa is missing or down. What a failed
 * source already spent still counts.
 */
export async function gatherFrom(
  sources: WebSource[],
  plan: GatherPlan,
  ctx: GatherContext,
): Promise<GatherResult & { provider?: 'exa' | 'claude' }> {
  const notes: string[] = [];
  for (const s of sources) {
    try {
      const r = await s.gather(plan, ctx);
      return { ...r, notes: [...notes, ...r.notes], provider: s.name };
    } catch (e) {
      notes.push(e instanceof Error ? e.message : `${s.name} unavailable`);
    }
  }
  if (sources.length === 0) notes.push('no web search is configured');
  return { hits: [], pages: [], costUsd: 0, notes, steps: [] };
}
