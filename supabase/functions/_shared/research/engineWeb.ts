/**
 * The public web through a plain search engine (Serper, Parallel) and plain page fetches (plan 34 B5): a search costs
 * $0.001 here against Claude web search's $0.01 plus tokens, and reading a page costs nothing. Searches are kept 7 days
 * in the shared research cache by engine and query, pages by URL, like the other sources. Throws WebUnavailable when
 * every search failed, so the caller falls through to the next source (Claude's own search).
 */
import { cacheKey } from '../providers/request';
import type { SearchEngine } from '../providers/webSearch';
import { isBlockedSource } from './guards';
import { fetchPage } from './pageText';
import {
  type GatherResult,
  normalizeUrl,
  PAGE_CHARS,
  type SearchHit,
  type SharedCache,
  WEB_CACHE_MS,
  type WebPage,
  type WebSource,
  WebUnavailable,
} from './web';

const PAGE_FETCH_MS = 6000;

export function engineWeb(engine: SearchEngine, cache: SharedCache, doFetch?: typeof fetch): WebSource {
  return {
    name: engine.name,
    estimateUsd(plan) {
      return Math.ceil(plan.queries.length / engine.queriesPerCall) * engine.usdPerCall;
    },
    async gather(plan, ctx) {
      const out: GatherResult = { hits: [], pages: [], costUsd: 0, notes: [], steps: [] };
      let failures = 0;
      await Promise.all(
        plan.queries.map(async (q) => {
          const key = await cacheKey(`${engine.name}:search`, { q: q.query });
          const t0 = Date.now();
          const hit = (await cache.get(key).catch(() => undefined)) as SearchHit[] | undefined;
          if (hit) {
            out.hits.push(...hit);
            out.steps.push({
              step: `search:${q.id}`,
              provider: engine.name,
              costUsd: 0,
              ms: 0,
              n: hit.length,
              cached: true,
            });
            return;
          }
          if (out.costUsd + engine.usdPerCall > ctx.budgetUsd) {
            out.notes.push(`search ${q.id} skipped: cost cap`);
            return;
          }
          out.costUsd += engine.usdPerCall;
          const r = await engine.search([q.query], plan.focus);
          if (!r.ok) {
            failures++;
            out.costUsd -= engine.usdPerCall;
            out.notes.push(`${engine.name} search failed (${r.message})`);
            out.steps.push({
              step: `search:${q.id}`,
              provider: engine.name,
              costUsd: 0,
              ms: Date.now() - t0,
              error: r.message,
            });
            return;
          }
          const hits: SearchHit[] = r.value
            .filter((x) => !isBlockedSource(x.url))
            .map((x) => ({
              url: x.url,
              title: x.title,
              published: x.published ?? null,
              snippet: x.snippet,
              query: q.query,
            }));
          out.hits.push(...hits);
          out.steps.push({
            step: `search:${q.id}`,
            provider: engine.name,
            costUsd: engine.usdPerCall,
            ms: Date.now() - t0,
            n: hits.length,
            searches: 1,
          });
          await cache.put(key, `${engine.name}:search`, hits, WEB_CACHE_MS).catch(() => undefined);
        }),
      );
      if (plan.queries.length && failures === plan.queries.length)
        throw new WebUnavailable(`${engine.name} is not answering`);
      const seen = new Set<string>();
      out.hits = out.hits.filter((h) => {
        const k = normalizeUrl(h.url);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const skip = new Set((plan.skip ?? []).map(normalizeUrl));
      const want = ctx
        .select(out.hits)
        .filter((u) => !skip.has(normalizeUrl(u)))
        .slice(0, plan.maxPages);
      const t0 = Date.now();
      const pages = await Promise.all(
        want.map(async (url): Promise<WebPage | undefined> => {
          const key = await cacheKey('page', { url: normalizeUrl(url) });
          const kept = (await cache.get(key).catch(() => undefined)) as WebPage | undefined;
          if (kept?.text) return kept;
          const p = await fetchPage(url, { fetch: doFetch, timeoutMs: PAGE_FETCH_MS });
          if (!p?.text) return undefined;
          const page: WebPage = {
            url: p.url,
            title: p.title,
            published: p.published ?? null,
            text: p.text.slice(0, PAGE_CHARS),
          };
          if (!isBlockedSource(page.url))
            await cache.put(key, 'page', page, WEB_CACHE_MS).catch(() => undefined);
          return page;
        }),
      );
      for (const [i, url] of want.entries()) {
        const p = pages[i];
        if (p) out.pages.push(p);
        else {
          // a page that would not load still has what the engine quoted from it
          const h = out.hits.find((x) => normalizeUrl(x.url) === normalizeUrl(url));
          if (h?.snippet)
            out.pages.push({ url: h.url, title: h.title, published: h.published, text: h.snippet });
        }
      }
      out.steps.push({
        step: 'read',
        provider: 'fetch',
        costUsd: 0,
        ms: Date.now() - t0,
        n: out.pages.length,
      });
      return out;
    },
  };
}

/** A source that steps aside (WebUnavailable, so the next source runs) while any of its switches is off. */
export function gatedWeb(source: WebSource, gates: ((() => Promise<boolean>) | undefined)[]): WebSource {
  return {
    name: source.name,
    estimateUsd: (plan) => source.estimateUsd(plan),
    async gather(plan, ctx) {
      for (const g of gates)
        if (g && !(await g().catch(() => true))) throw new WebUnavailable(`${source.name} is switched off`);
      return source.gather(plan, ctx);
    },
  };
}
