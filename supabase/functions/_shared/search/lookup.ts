/**
 * Ask-time facet lookups (plan 32 §6.5): while the student waits on a network search, one LinkedIn people search of
 * their own connections (distance 1) with one filter, a company, a school or a place, by LinkedIn's id for it. Up to
 * three pages (30 people). Everyone it lists that Orbit has gets a positive assertion for the facet (and the census's
 * facts for free: their location line and current employers). When LinkedIn runs out of results within those pages
 * the scan is complete: a connection it did not list does not have the facet, which the browser reads as a no.
 *
 * A filter LinkedIn does not know is refused instead of turned into keywords: a keyword hit is not a fact.
 * Spends the shared search ledger at FACETS_SHARE (orbit-connectors LEDGER_CEILINGS.search.facets). A complete scan
 * younger than SCAN_FRESH_DAYS answers from what it stored, with no LinkedIn call.
 */
import type { Db } from '../db.ts';
import { censusPeople, filePage, spendCensus } from './census.ts';

export const FACETS_SHARE = 0.7;
export const LOOKUP_PAGES = 3;
export const SCAN_FRESH_DAYS = 7;

export type LookupKind = 'place' | 'school' | 'company';

export interface LookupDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
}

export interface LookupResult {
  ok: boolean;
  kind: LookupKind;
  value: string;
  /** Orbit's people LinkedIn listed with the facet */
  personIds: string[];
  complete: boolean;
  cached?: boolean;
  reason?: 'unknown' | 'ledger' | 'refused';
}

const PARAM_TYPE: Record<LookupKind, string> = { place: 'LOCATION', school: 'SCHOOL', company: 'COMPANY' };
const FILTER_KEY: Record<LookupKind, string> = { place: 'location', school: 'school', company: 'company' };

async function parameterId(
  deps: LookupDeps,
  accountId: string,
  kind: LookupKind,
  value: string,
): Promise<string | undefined> {
  const q = new URLSearchParams({
    account_id: accountId,
    type: PARAM_TYPE[kind],
    keywords: value,
    limit: '1',
  });
  const res = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}/api/v1/linkedin/search/parameters?${q}`, {
    headers: { 'X-API-KEY': deps.apiKey, accept: 'application/json' },
  });
  if (!res.ok) return undefined;
  const b = (await res.json()) as { items?: { id?: string | number }[] };
  const id = b.items?.[0]?.id;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

async function storedPositives(db: Db, userId: string, kind: LookupKind, value: string): Promise<string[]> {
  const rows = await db.sql<{ person_id: string }>`
    select person_id from orbit.facet_assertions
     where user_id = ${userId}::uuid and kind = ${kind} and value = ${value} and positive and source = 'facet_search'`;
  return rows.map((r) => r.person_id);
}

export async function runFacetLookup(
  db: Db,
  deps: LookupDeps,
  userId: string,
  accountId: string,
  kind: LookupKind,
  value: string,
  now: Date,
): Promise<LookupResult> {
  const [scan] = await db.sql<{ complete: boolean; at: string }>`
    select complete, at::text as at from orbit.facet_scans
     where user_id = ${userId}::uuid and kind = ${kind} and value = ${value}`;
  if (scan?.complete && now.getTime() - Date.parse(scan.at) < SCAN_FRESH_DAYS * 86_400_000)
    return {
      ok: true,
      kind,
      value,
      personIds: await storedPositives(db, userId, kind, value),
      complete: true,
      cached: true,
    };
  const fail = (reason: LookupResult['reason']): LookupResult => ({
    ok: false,
    kind,
    value,
    personIds: [],
    complete: false,
    reason,
  });
  const id = await parameterId(deps, accountId, kind, value);
  if (!id) return fail('unknown');
  const base = deps.baseUrl.replace(/\/+$/, '');
  const found = new Set<string>();
  let cursor: string | null = null;
  let complete = false;
  let pages = 0;
  while (pages < LOOKUP_PAGES) {
    if (!(await spendCensus(db, accountId, now, FACETS_SHARE))) {
      if (!pages) return fail('ledger');
      break;
    }
    const q = new URLSearchParams({ account_id: accountId, limit: '10' });
    if (cursor) q.set('cursor', cursor);
    const res = await deps.fetch(`${base}/api/v1/linkedin/search?${q}`, {
      method: 'POST',
      headers: { 'X-API-KEY': deps.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        api: 'classic',
        category: 'people',
        network_distance: [1],
        [FILTER_KEY[kind]]: [id],
      }),
    });
    if (res.status >= 400 && res.status < 500) {
      if (!pages) return fail('refused');
      break;
    }
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const body = (await res.json()) as { items?: unknown; cursor?: string | null };
    pages++;
    const people = censusPeople(body.items);
    await filePage(db, userId, people, now);
    if (people.length) {
      const known = await db.sql<{ id: string }>`
        select p.id from orbit.people p
         where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null
           and p.linkedin_member_id = any(${people.map((p) => p.memberId)}::text[])
        union
        select i.person_id from orbit.person_identities i
          join orbit.people p on p.id = i.person_id and p.deleted_at is null and p.merged_into is null
         where i.user_id = ${userId}::uuid and i.kind = 'linkedin_member'
           and i.value_norm = any(${people.map((p) => p.memberId)}::text[])`;
      for (const k of known) found.add(k.id);
    }
    cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
    if (!cursor || !people.length) {
      complete = true;
      break;
    }
  }
  const ids = [...found];
  if (ids.length)
    await db.sql`
      insert into orbit.facet_assertions (user_id, person_id, kind, value, positive, source, at)
      select ${userId}::uuid, x, ${kind}, ${value}, true, 'facet_search', ${now.toISOString()}::timestamptz
        from unnest(${ids}::uuid[]) as x
      on conflict (user_id, person_id, kind, value, source) do update set at = excluded.at, positive = true`;
  await db.sql`
    insert into orbit.facet_scans (user_id, kind, value, complete, matched, at)
    values (${userId}::uuid, ${kind}, ${value}, ${complete}, ${ids.length}, ${now.toISOString()}::timestamptz)
    on conflict (user_id, kind, value) do update
      set complete = excluded.complete, matched = excluded.matched, at = excluded.at`;
  return { ok: true, kind, value, personIds: ids, complete };
}
