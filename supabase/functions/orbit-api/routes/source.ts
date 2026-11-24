/**
 * Sourcing (§6):
 *   POST /source/search {goalId?, purpose, query?, homeCity?, filters?, limit?}  → {batchId, results, unconfigured, relaxed}
 *   POST /source/add {recommendationIds}                              → {people: [{id, displayName, chatId}]}
 *   POST /source/connect {recommendationId} | {personId}              → {person: {id, displayName, chatId}, sent, code?, reason?}
 *        saves them as /source/add does, then one LinkedIn connection request with no note from the student's own
 *        LinkedIn, once per person; whatever stops the request, they are saved and `reason` says why (connect.ts)
 *   POST /source/email {recommendationId} | {personId}                → {email?, emailConfidence?, emailStatus}
 *        one person's address looked up on demand (plan 35 C3): a search no longer pays for everyone's. Answers
 *        within EMAIL_LOOKUP_DEADLINE_MS, under the browser's own wait: 'could not check' when the providers are slow
 */
import type { SourceSearchRequest } from '@orbit/core/server/api';
import { badRequest, json } from '../../_shared/http.ts';
import { connectSourced } from '../../_shared/sourcing/connect.ts';
import {
  lookupPersonEmail,
  lookupRecommendationEmail,
  lookupWithin,
} from '../../_shared/sourcing/ondemand.ts';
import { addSourced, runSourcing } from '../../_shared/sourcing/run.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid } from './body.ts';

const list = (v: unknown, key: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 25 || !v.every((x) => typeof x === 'string' && x.length <= 200))
    throw badRequest(`filters.${key} must be a list of short strings`);
  return v as string[];
};

/** Which filters of a people search only rank: each is must or nice, anything else is a bad request. */
export function needsOf(v: unknown): NonNullable<SourceSearchRequest['filters']>['needs'] {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('filters.needs must be an object');
  const o = v as Record<string, unknown>;
  const out: Record<string, 'must' | 'nice'> = {};
  for (const k of ['role', 'locations', 'everOrganizations', 'keywords'] as const) {
    if (o[k] === undefined) continue;
    if (o[k] !== 'must' && o[k] !== 'nice') throw badRequest(`filters.needs.${k} is must or nice`);
    out[k] = o[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/** The checks a search asks of each person: up to 6 short sentences, each a must-have unless said otherwise. */
export function criteriaOf(v: unknown): SourceSearchRequest['criteria'] {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 6) throw badRequest('criteria must be a list of at most 6');
  const out: NonNullable<SourceSearchRequest['criteria']> = [];
  for (const x of v) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.text !== 'string' || o.text.length > 200)
      throw badRequest('each criterion needs a short text');
    const text = o.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (o.need !== undefined && o.need !== 'must' && o.need !== 'nice')
      throw badRequest('criterion need is must or nice');
    out.push({ text, need: o.need === 'nice' ? 'nice' : 'must' });
  }
  return out.length ? out : undefined;
}

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
    homeCity: typeof b.homeCity === 'string' && b.homeCity.length <= 80 ? b.homeCity : undefined,
    filters: {
      organizations: list(f.organizations, 'organizations'),
      titles: list(f.titles, 'titles'),
      locations: list(f.locations, 'locations'),
      schools: list(f.schools, 'schools'),
      seniority: list(f.seniority, 'seniority'),
      keywords: list(f.keywords, 'keywords'),
      currentOrganizations: list(f.currentOrganizations, 'currentOrganizations'),
      everOrganizations: list(f.everOrganizations, 'everOrganizations'),
      needs: needsOf(f.needs),
    },
    limit: typeof b.limit === 'number' ? b.limit : undefined,
    withEmails: b.withEmails === true ? true : undefined,
    criteria: criteriaOf(b.criteria),
    peopleOnly: b.peopleOnly === true ? true : undefined,
  };
  return json(200, await runSourcing(ctx.services(), ctx.userId!, req));
}

async function add(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return json(200, await addSourced(ctx.services(), ctx.userId!, b.recommendationIds));
}

async function connect(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const recommendationId = optUuid(b, 'recommendationId');
  const personId = optUuid(b, 'personId');
  if (!recommendationId === !personId) throw badRequest('send one of recommendationId or personId');
  return json(200, await connectSourced(ctx.services(), ctx.userId!, { recommendationId, personId }));
}

async function email(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const recommendationId = optUuid(b, 'recommendationId');
  const personId = optUuid(b, 'personId');
  if (!recommendationId === !personId) throw badRequest('send one of recommendationId or personId');
  const s = ctx.services();
  return json(
    200,
    await lookupWithin(
      recommendationId
        ? lookupRecommendationEmail(s, ctx.userId!, recommendationId)
        : lookupPersonEmail(s, ctx.userId!, personId!),
    ),
  );
}

export const sourceRoutes: Record<string, Route> = {
  '/source/search': { method: 'POST', auth: true, run: search },
  '/source/add': { method: 'POST', auth: true, run: add },
  '/source/connect': { method: 'POST', auth: true, run: connect },
  '/source/email': { method: 'POST', auth: true, run: email },
};
