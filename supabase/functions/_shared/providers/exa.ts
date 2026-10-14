/**
 * Exa (https://exa.ai/docs/reference/search, https://exa.ai/docs/reference/get-contents): web search with a
 * `people` / `company` / `news` / `publication` category, and page contents. Auth is the `x-api-key` header.
 * Responses are parsed loosely: only the fields Orbit reads are typed, everything else passes through.
 */
import { type ProviderOptions, type ProviderResult, requestJson, trimBase, unconfigured } from './request';
import { z } from './zod';

export const EXA_BASE = 'https://api.exa.ai';
/** list prices used when Exa's own `costDollars` is absent: $7 / 1k searches, $1 / 1k pages of contents */
export const EXA_SEARCH_USD = 0.007;
export const EXA_PAGE_USD = 0.001;

export type ExaCategory =
  | 'people'
  | 'company'
  | 'news'
  | 'publication'
  | 'personal site'
  | 'financial report';

export interface ExaContentsOptions {
  text?: boolean | { maxCharacters?: number };
  highlights?: boolean | { query?: string; maxCharacters?: number };
  maxAgeHours?: number;
}

export interface ExaSearchRequest {
  query: string;
  type?: 'auto' | 'fast' | 'instant' | 'deep' | 'deep-lite' | 'deep-reasoning';
  category?: ExaCategory;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  contents?: ExaContentsOptions;
}

export interface ExaContentsRequest extends ExaContentsOptions {
  urls: string[];
}

const costSchema = z.looseObject({ total: z.number().nullish() }).nullish();

export const exaResultSchema = z.looseObject({
  id: z.string().nullish(),
  url: z.string(),
  title: z.string().nullish(),
  publishedDate: z.string().nullish(),
  author: z.string().nullish(),
  text: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
  highlightScores: z.array(z.number()).nullish(),
});
export type ExaResult = z.infer<typeof exaResultSchema>;

export const exaSearchResponseSchema = z.looseObject({
  requestId: z.string().nullish(),
  results: z.array(exaResultSchema).default([]),
  costDollars: costSchema,
});
export type ExaSearchResponse = z.infer<typeof exaSearchResponseSchema>;

export const exaContentsResponseSchema = z.looseObject({
  requestId: z.string().nullish(),
  results: z.array(exaResultSchema).default([]),
  statuses: z.array(z.looseObject({ id: z.string().nullish(), status: z.string().nullish() })).nullish(),
  costDollars: costSchema,
});
export type ExaContentsResponse = z.infer<typeof exaContentsResponseSchema>;

export interface Exa {
  readonly configured: boolean;
  search(req: ExaSearchRequest): Promise<ProviderResult<ExaSearchResponse>>;
  contents(req: ExaContentsRequest): Promise<ProviderResult<ExaContentsResponse>>;
}

/** What a search will cost before Exa says: one search plus, with contents, one page per result. */
export function estimateExaSearchUsd(req: ExaSearchRequest): number {
  const pages = req.contents ? (req.numResults ?? 10) : 0;
  return EXA_SEARCH_USD + pages * EXA_PAGE_USD;
}

export function exaCostUsd(
  resp: { costDollars?: { total?: number | null } | null },
  fallback: number,
): number {
  const t = resp.costDollars?.total;
  return typeof t === 'number' && Number.isFinite(t) ? t : fallback;
}

export function createExa(opts: ProviderOptions): Exa {
  const base = trimBase(opts.baseUrl ?? EXA_BASE);
  const headers = () => ({ 'x-api-key': opts.apiKey ?? '' });
  return {
    configured: !!opts.apiKey,
    async search(req) {
      if (!opts.apiKey) return unconfigured('exa');
      return requestJson(opts, {
        provider: 'exa',
        url: `${base}/search`,
        method: 'POST',
        headers: headers(),
        body: req,
        schema: exaSearchResponseSchema,
      });
    },
    async contents(req) {
      if (!opts.apiKey) return unconfigured('exa');
      return requestJson(opts, {
        provider: 'exa',
        url: `${base}/contents`,
        method: 'POST',
        headers: headers(),
        body: req,
        schema: exaContentsResponseSchema,
      });
    },
  };
}
