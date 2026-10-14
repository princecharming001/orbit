/**
 * Sourcing (§6):
 *   POST /source/search {goalId?, purpose, query?, filters?, limit?}  → {batchId, results, unconfigured, relaxed}
 *   POST /source/add {recommendationIds}                              → {people: [{id, displayName, chatId}]}
 */
import type { SourceSearchRequest } from '@orbit/core/server/api';
import { badRequest, json } from '../../_shared/http.ts';
import { addSourced, runSourcing } from '../../_shared/sourcing/run.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid } from './body.ts';

const list = (v: unknown, key: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 25 || !v.every((x) => typeof x === 'string' && x.length <= 200))
    throw badRequest(`filters.${key} must be a list of short strings`);
  return v as string[];
};

async function search(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const f = (b.filters ?? {}) as Record<string, unknown>;
  if (typeof f !== 'object' || Array.isArray(f)) throw badRequest('filters must be an object');
  if (b.query !== undefined && (typeof b.query !== 'string' || b.query.length > 500))
    throw badRequest('query is too long');
  const req: SourceSearchRequest = {
    goalId: optUuid(b, 'goalId'),
    purpose: b.purpose as SourceSearchRequest['purpose'],
    query: typeof b.query === 'string' ? b.query : undefined,
    filters: {
      organizations: list(f.organizations, 'organizations'),
      titles: list(f.titles, 'titles'),
      locations: list(f.locations, 'locations'),
      schools: list(f.schools, 'schools'),
      seniority: list(f.seniority, 'seniority'),
      keywords: list(f.keywords, 'keywords'),
    },
    limit: typeof b.limit === 'number' ? b.limit : undefined,
  };
  return json(200, await runSourcing(ctx.services(), ctx.userId!, req));
}

async function add(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return json(200, await addSourced(ctx.services(), ctx.userId!, b.recommendationIds));
}

export const sourceRoutes: Record<string, Route> = {
  '/source/search': { method: 'POST', auth: true, run: search },
  '/source/add': { method: 'POST', auth: true, run: add },
};
