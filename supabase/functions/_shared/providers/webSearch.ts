/**
 * Plain web search for deep research's investigator loop: Parallel (https://docs.parallel.ai/api-reference/search,
 * `POST /v1/search`, `x-api-key`; fast mode is $1 per 1,000 requests and $5 of free credit a month covers 5,000) first,
 * Serper (https://serper.dev, `POST /search`, `X-API-KEY`; Google's own results at about $1 per 1,000) when Parallel is
 * missing, out of credit or down. Both return a ranked list of pages with a short excerpt; reading the pages is
 * research/pageText.ts. Responses are parsed loosely: only the fields Orbit reads are typed.
 */
import { type ProviderOptions, type ProviderResult, requestJson, trimBase, unconfigured } from './request';
import { z } from './zod';

export const PARALLEL_BASE = 'https://api.parallel.ai';
export const SERPER_BASE = 'https://google.serper.dev';
/** list prices: Parallel fast mode $1 / 1k requests (each request takes up to five queries), Serper $1 / 1k queries */
export const PARALLEL_SEARCH_USD = 0.001;
export const SERPER_SEARCH_USD = 0.001;
/** Parallel reads at most this many queries in one request */
export const PARALLEL_QUERIES_PER_REQUEST = 5;

/** One search result, whichever engine found it. */
export interface WebHit {
  url: string;
  title?: string;
  /** what the engine quoted from the page */
  snippet?: string;
  published?: string | null;
}

const parallelResponse = z.looseObject({
  results: z
    .array(
      z.looseObject({
        url: z.string(),
        title: z.string().nullish(),
        publish_date: z.string().nullish(),
        excerpts: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
});

const serperResponse = z.looseObject({
  organic: z
    .array(
      z.looseObject({
        link: z.string(),
        title: z.string().nullish(),
        snippet: z.string().nullish(),
        date: z.string().nullish(),
      }),
    )
    .default([]),
});

export interface SearchEngine {
  readonly name: 'parallel' | 'serper';
  readonly configured: boolean;
  /** dollars one call costs */
  readonly usdPerCall: number;
  /** queries one call can take */
  readonly queriesPerCall: number;
  /**
   * Run one call. `objective` says who the pages should be about (Parallel ranks by it; Serper ignores it). Serper
   * takes one query per call.
   */
  search(queries: string[], objective: string): Promise<ProviderResult<WebHit[]>>;
}

export function createParallelSearch(opts: ProviderOptions): SearchEngine {
  const base = trimBase(opts.baseUrl ?? PARALLEL_BASE);
  return {
    name: 'parallel',
    configured: !!opts.apiKey,
    usdPerCall: PARALLEL_SEARCH_USD,
    queriesPerCall: PARALLEL_QUERIES_PER_REQUEST,
    async search(queries, objective) {
      if (!opts.apiKey) return unconfigured('parallel');
      const r = await requestJson(opts, {
        provider: 'parallel',
        url: `${base}/v1/search`,
        method: 'POST',
        headers: { 'x-api-key': opts.apiKey },
        body: {
          objective,
          search_queries: queries.slice(0, PARALLEL_QUERIES_PER_REQUEST),
          mode: 'fast',
          max_chars_total: 12_000,
        },
        schema: parallelResponse,
      });
      if (!r.ok) return r;
      return {
        ok: true,
        value: r.value.results.map((x) => ({
          url: x.url,
          title: x.title ?? undefined,
          snippet: (x.excerpts ?? []).join(' … ').slice(0, 1500) || undefined,
          published: x.publish_date ?? null,
        })),
      };
    },
  };
}

export function createSerperSearch(opts: ProviderOptions): SearchEngine {
  const base = trimBase(opts.baseUrl ?? SERPER_BASE);
  return {
    name: 'serper',
    configured: !!opts.apiKey,
    usdPerCall: SERPER_SEARCH_USD,
    queriesPerCall: 1,
    async search(queries) {
      if (!opts.apiKey) return unconfigured('serper');
      const r = await requestJson(opts, {
        provider: 'serper',
        url: `${base}/search`,
        method: 'POST',
        headers: { 'X-API-KEY': opts.apiKey },
        body: { q: queries[0] ?? '', num: 10, gl: 'us', hl: 'en' },
        schema: serperResponse,
      });
      if (!r.ok) return r;
      return {
        ok: true,
        value: r.value.organic.map((x) => ({
          url: x.link,
          title: x.title ?? undefined,
          snippet: x.snippet ?? undefined,
          published: x.date ?? null,
        })),
      };
    },
  };
}
