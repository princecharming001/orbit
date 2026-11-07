/**
 * Network search (plan 32 §6): what the browser's search engine reads from the server and the labels it writes back.
 *   GET /companies/facts?since=   → {facts, at}: public company facts (YC batch, status, stage, size, industries),
 *                                   all of them, or those changed after `since` (the `at` of an earlier answer)
 *   GET /search/facets?since=     → {facets, at, census}: what LinkedIn listed about the student's people (place,
 *                                   school, company), and how far the background census has got
 *   POST /search/facets {facets}  → {written}: assertions from a lookup the browser made while the student waited
 *                                   (a LinkedIn people search with a place, school or company filter)
 *   POST /search/lookup {kind, value} → {ok, personIds, complete, reason?}: one LinkedIn search of the student's
 *                                   connections with one filter (company, school or place) from the server-held
 *                                   account, while the student waits; complete = every match was listed
 *   POST /search/labels {personId, askHash, ask, verdict}
 *                                 → {ok}: the student said a row is, or is not, a match
 */

import { isUuid } from '../../_shared/crypto.ts';
import { badRequest, json } from '../../_shared/http.ts';
import { loadAccount } from '../../_shared/ingest/util.ts';
import { loadCompanyFacts } from '../../_shared/search/companyFacts.ts';
import { type LookupKind, runFacetLookup } from '../../_shared/search/lookup.ts';
import type { Ctx, Route } from '../api.ts';
import { body } from './body.ts';

const KINDS = new Set(['place', 'school', 'company', 'past_company']);
const MAX_FACETS = 400;

/** `since` from the query string, or from the body of a POST (the browser posts every call). */
function since(ctx: Ctx, b?: Record<string, unknown>): string | undefined {
  const raw = ctx.url.searchParams.get('since') ?? b?.since;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw)))
    throw badRequest('since is a time from an earlier answer');
  return raw;
}

async function companyFacts(ctx: Ctx): Promise<Response> {
  const b = ctx.req.method === 'POST' ? await body(ctx, true) : undefined;
  return json(200, await loadCompanyFacts(ctx.db, since(ctx, b)));
}

async function facets(ctx: Ctx): Promise<Response> {
  // a POST carrying facets writes them; any other call reads
  const b = ctx.req.method === 'POST' ? await body(ctx, true) : undefined;
  if (b && 'facets' in b) return writeFacets(ctx, b);
  const s = since(ctx, b);
  const rows = await ctx.db.sql<{
    person_id: string;
    kind: string;
    value: string;
    positive: boolean;
    source: string;
    at: string;
  }>`
    select person_id, kind, value, positive, source, at::text as at from orbit.facet_assertions
     where user_id = ${ctx.userId!}::uuid and (${s ?? null}::timestamptz is null or at >= ${s ?? null}::timestamptz)
     order by at
     limit 20000`;
  const [census] = await ctx.db.sql<{
    seen: number;
    matched: number;
    pass_done_at: string | null;
    cursor: string | null;
  }>`
    select seen, matched, pass_done_at::text as pass_done_at, cursor from orbit.search_census
     where user_id = ${ctx.userId!}::uuid`;
  const scans = await ctx.db.sql<{ kind: string; value: string; complete: boolean; at: string }>`
    select kind, value, complete, at::text as at from orbit.facet_scans
     where user_id = ${ctx.userId!}::uuid and complete and at > now() - interval '30 days'`;
  let at = s ?? new Date(0).toISOString();
  for (const r of rows) if (r.at > at) at = r.at;
  return json(200, {
    facets: rows.map((r) => ({
      personId: r.person_id,
      kind: r.kind,
      value: r.value,
      positive: r.positive,
      source: r.source,
      at: r.at,
    })),
    at,
    // more pages may wait when the answer was cut at the limit
    more: rows.length === 20000,
    scans: scans.map((x) => ({ kind: x.kind, value: x.value, at: x.at })),
    census: census
      ? { seen: census.seen, matched: census.matched, doneAt: census.pass_done_at, running: !!census.cursor }
      : null,
  });
}

async function writeFacets(ctx: Ctx, b: Record<string, unknown>): Promise<Response> {
  if (!Array.isArray(b.facets) || b.facets.length > MAX_FACETS)
    throw badRequest(`facets is a list of up to ${MAX_FACETS}`);
  const rows: { person_id: string; kind: string; value: string; positive: boolean }[] = [];
  for (const f of b.facets as unknown[]) {
    if (!f || typeof f !== 'object') throw badRequest('each facet is an object');
    const x = f as Record<string, unknown>;
    if (typeof x.personId !== 'string' || !isUuid(x.personId)) throw badRequest('personId is a person id');
    if (typeof x.kind !== 'string' || !KINDS.has(x.kind))
      throw badRequest('kind is place, school, company or past_company');
    if (typeof x.value !== 'string' || !x.value.trim() || x.value.length > 160)
      throw badRequest('value names it');
    if (typeof x.positive !== 'boolean') throw badRequest('positive is true or false');
    rows.push({ person_id: x.personId, kind: x.kind, value: x.value.trim(), positive: x.positive });
  }
  if (!rows.length) return json(200, { written: 0 });
  // only the student's own people: a row naming anyone else is dropped by the join
  const written = await ctx.db.sql<{ id: string }>`
    insert into orbit.facet_assertions (user_id, person_id, kind, value, positive, source, at)
    select ${ctx.userId!}::uuid, r.person_id, r.kind, r.value, r.positive, 'facet_search', ${ctx.now().toISOString()}::timestamptz
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(person_id uuid, kind text, value text, positive boolean)
      join orbit.people p on p.id = r.person_id and p.user_id = ${ctx.userId!}::uuid
    on conflict (user_id, person_id, kind, value, source) do update set positive = excluded.positive, at = excluded.at
    returning id`;
  return json(200, { written: written.length });
}

const LOOKUP_KINDS = new Set(['place', 'school', 'company']);

async function lookup(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (typeof b.kind !== 'string' || !LOOKUP_KINDS.has(b.kind))
    throw badRequest('kind is place, school or company');
  if (typeof b.value !== 'string' || !b.value.trim() || b.value.length > 120)
    throw badRequest('value names it');
  const kind = b.kind as LookupKind;
  const value = b.value.trim();
  const off = (reason: string) =>
    json(200, { ok: false, kind, value, personIds: [], complete: false, reason });
  if (!ctx.env.unipileKey || !ctx.env.unipileBase) return off('unconfigured');
  const acct = await loadAccount(ctx.db, ctx.userId!, 'linkedin');
  if (!acct?.externalAccountId || acct.status !== 'active') return off('not_connected');
  const r = await runFacetLookup(
    ctx.db,
    { fetch: ctx.fetch, apiKey: ctx.env.unipileKey, baseUrl: ctx.env.unipileBase },
    ctx.userId!,
    acct.externalAccountId,
    kind,
    value,
    ctx.now(),
  );
  return json(200, r);
}

async function labels(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (typeof b.personId !== 'string' || !isUuid(b.personId)) throw badRequest('personId is a person id');
  if (typeof b.askHash !== 'string' || !/^[a-z0-9]{1,40}$/i.test(b.askHash))
    throw badRequest('askHash names the ask');
  if (typeof b.ask !== 'string' || !b.ask.trim() || b.ask.length > 500) throw badRequest('ask is the ask');
  if (b.verdict !== 'yes' && b.verdict !== 'no') throw badRequest('verdict is yes or no');
  const [row] = await ctx.db.sql<{ id: string }>`
    insert into orbit.search_labels (user_id, person_id, ask_hash, ask, verdict)
    select ${ctx.userId!}::uuid, p.id, ${b.askHash}, ${b.ask.trim()}, ${b.verdict}
      from orbit.people p where p.id = ${b.personId}::uuid and p.user_id = ${ctx.userId!}::uuid
    on conflict (user_id, person_id, ask_hash) do update set verdict = excluded.verdict, ask = excluded.ask,
      created_at = now()
    returning id`;
  return json(200, { ok: !!row });
}

export const searchRoutes: Record<string, Route> = {
  '/companies/facts': { method: 'GET|POST', auth: true, run: companyFacts },
  '/search/facets': { method: 'GET|POST', auth: true, run: facets },
  '/search/lookup': { method: 'POST', auth: true, run: lookup },
  '/search/labels': { method: 'POST', auth: true, run: labels },
};
