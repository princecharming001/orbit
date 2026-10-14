/**
 * Semantic Scholar Graph API (https://api.semanticscholar.org/api-docs/graph, swagger at
 * https://api.semanticscholar.org/graph/v1/swagger.json): `GET /graph/v1/paper/search` (PaperRelevanceSearchBatch:
 * total, offset, next, data[]) and `GET /graph/v1/author/{id}` (authorId, name, affiliations, homepage, paperCount,
 * hIndex). An `x-api-key` raises the rate limit; without one the API still answers on the shared pool, so this
 * adapter counts as configured with a key or with `anonymous: true`.
 */
import {
  type ProviderOptions,
  type ProviderResult,
  query,
  requestJson,
  trimBase,
  unconfigured,
} from './request';
import { z } from './zod';

export const S2_BASE = 'https://api.semanticscholar.org';

export const s2AuthorRefSchema = z.looseObject({
  authorId: z.string().nullish(),
  name: z.string().nullish(),
});

export const s2PaperSchema = z.looseObject({
  paperId: z.string(),
  title: z.string().nullish(),
  year: z.number().nullish(),
  venue: z.string().nullish(),
  authors: z.array(s2AuthorRefSchema).nullish(),
});
export type S2Paper = z.infer<typeof s2PaperSchema>;

export const s2PaperSearchSchema = z.looseObject({
  total: z.number().nullish(),
  offset: z.number().nullish(),
  next: z.number().nullish(),
  data: z.array(s2PaperSchema).default([]),
});

export const s2AuthorSchema = z.looseObject({
  authorId: z.string(),
  name: z.string().nullish(),
  url: z.string().nullish(),
  affiliations: z.array(z.string()).nullish(),
  homepage: z.string().nullish(),
  paperCount: z.number().nullish(),
  citationCount: z.number().nullish(),
  hIndex: z.number().nullish(),
});
export type S2Author = z.infer<typeof s2AuthorSchema>;

export interface SemanticScholar {
  readonly configured: boolean;
  searchPapers(
    q: string,
    opts?: { limit?: number; fields?: string[] },
  ): Promise<ProviderResult<z.infer<typeof s2PaperSearchSchema>>>;
  author(id: string, opts?: { fields?: string[] }): Promise<ProviderResult<S2Author>>;
}

export function createSemanticScholar(opts: ProviderOptions & { anonymous?: boolean }): SemanticScholar {
  const base = trimBase(opts.baseUrl ?? S2_BASE);
  const configured = !!opts.apiKey || opts.anonymous === true;
  const headers = (): Record<string, string> => (opts.apiKey ? { 'x-api-key': opts.apiKey } : {});
  return {
    configured,
    async searchPapers(q, o = {}) {
      if (!configured) return unconfigured('semantic_scholar');
      const fields = (o.fields ?? ['title', 'year', 'authors', 'venue']).join(',');
      return requestJson(opts, {
        provider: 'semantic_scholar',
        url: `${base}/graph/v1/paper/search${query({ query: q, fields, limit: o.limit ?? 50 })}`,
        headers: headers(),
        schema: s2PaperSearchSchema,
      });
    },
    async author(id, o = {}) {
      if (!configured) return unconfigured('semantic_scholar');
      const fields = (o.fields ?? ['name', 'affiliations', 'homepage', 'paperCount', 'hIndex']).join(',');
      return requestJson(opts, {
        provider: 'semantic_scholar',
        url: `${base}/graph/v1/author/${encodeURIComponent(id)}${query({ fields })}`,
        headers: headers(),
        schema: s2AuthorSchema,
      });
    },
  };
}
