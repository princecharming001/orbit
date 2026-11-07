/**
 * What network search reads besides the student's own people (plan 32 §6): company facts (YC batch, status, stage,
 * size, industries), what LinkedIn listed about their people (the server's census and lookups), the school list and
 * the places table. Each is loaded once per tab and refreshed in the background:
 *   - company facts: from orbit-api for an account (incrementally, `since`), else straight from yc-oss; kept in
 *     Dexie for a day so a search never waits on the network twice;
 *   - facets: from orbit-api for an account, every 10 minutes at most;
 *   - schools and places: bundled, imported on first use.
 */
import type { CompanyFactWire, FacetWire, SearchFacetsResponse } from '@orbit/core';
import type { CompanyFact, FactsIndex, PlaceIndex, SchoolIndex } from '@orbit/core/search';
import {
  buildFactsIndex,
  buildPlaceIndex,
  buildSchoolIndex,
  YC_OSS_URL,
  ycOssFact,
} from '@orbit/core/search';
import { loadSchools } from '../../data/schools';
import { db, type FacetRow } from '../../db/schema';
import { callApi, isServerUser } from '../../integrations/orbitApi';
import { keepScans } from './lookup';

const FACTS_KEY = 'companyFacts';
const FACTS_FRESH_MS = 24 * 3_600_000;
const FACETS_FRESH_MS = 10 * 60_000;

interface FactsCache {
  facts: CompanyFact[];
  /** the server's `at`, for the next incremental pull; undefined when the facts came from yc-oss */
  at?: string;
  fetchedAt: number;
}

let factsMem: { cache: FactsCache; index: FactsIndex } | undefined;
let factsLoading: Promise<FactsIndex> | undefined;

function fromWire(f: CompanyFactWire): CompanyFact {
  return { ...f };
}

async function pullFacts(userId: string, prev: FactsCache | undefined): Promise<FactsCache | undefined> {
  if (isServerUser(userId)) {
    const r = await callApi('/companies/facts', prev?.at ? { since: prev.at } : {});
    if (!r.ok) return undefined;
    const got = r.value.facts.map(fromWire);
    if (!prev?.at) return { facts: got, at: r.value.at, fetchedAt: Date.now() };
    // merge the changed ones over what was kept (a renamed company keeps its key only when the name normalises alike)
    const byKey = new Map(prev.facts.map((f) => [`${f.key}|${f.name}`, f]));
    for (const f of got) byKey.set(`${f.key}|${f.name}`, f);
    return { facts: [...byKey.values()], at: r.value.at, fetchedAt: Date.now() };
  }
  try {
    const res = await fetch(YC_OSS_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list) || list.length < 3000) return undefined;
    const asOf = new Date().toISOString().slice(0, 10);
    const facts = list.map((c) => ycOssFact(c, asOf)).filter((f): f is CompanyFact => !!f);
    return { facts, fetchedAt: Date.now() };
  } catch {
    return undefined;
  }
}

/** The company facts index; an empty one when nothing could be loaded (YC checks then rest on headlines alone). */
export async function companyFacts(userId: string): Promise<FactsIndex> {
  if (factsMem && Date.now() - factsMem.cache.fetchedAt < FACTS_FRESH_MS) return factsMem.index;
  factsLoading ??= (async () => {
    try {
      const row = await db.searchCache.get(FACTS_KEY);
      let cache = row?.value as FactsCache | undefined;
      if (!cache || Date.now() - cache.fetchedAt >= FACTS_FRESH_MS) {
        const pulled = await pullFacts(userId, cache);
        if (pulled) {
          cache = pulled;
          await db.searchCache.put({
            key: FACTS_KEY,
            userId: '',
            at: new Date().toISOString(),
            value: pulled,
          });
        }
      }
      const index = buildFactsIndex(cache?.facts ?? []);
      if (cache) factsMem = { cache, index };
      return index;
    } finally {
      factsLoading = undefined;
    }
  })();
  return factsLoading;
}

const facetsPulledAt = new Map<string, number>();

const facetId = (f: Pick<FacetWire, 'personId' | 'kind' | 'value' | 'source'>) =>
  `${f.personId}|${f.kind}|${f.value}|${f.source}`;

/** Pulls what the server learned about the student's people since the last pull (accounts only). */
export async function refreshFacets(userId: string, force = false): Promise<SearchFacetsResponse['census']> {
  if (!isServerUser(userId)) return null;
  if (!force && Date.now() - (facetsPulledAt.get(userId) ?? 0) < FACETS_FRESH_MS) return null;
  facetsPulledAt.set(userId, Date.now());
  const posKey = `facetsAt:${userId}`;
  let since = ((await db.searchCache.get(posKey))?.value as string | undefined) ?? undefined;
  let census: SearchFacetsResponse['census'] = null;
  for (let page = 0; page < 10; page++) {
    const r = await callApi('/search/facets', since ? { since } : {});
    if (!r.ok || !('facets' in r.value)) break;
    const v = r.value as SearchFacetsResponse;
    census = v.census;
    // the server's complete scans of the last 30 days, whole each time
    if (v.scans && page === 0) await keepScans(userId, v.scans);
    const rows: FacetRow[] = v.facets.map((f) => ({ id: facetId(f), userId, ...f }));
    if (rows.length) await db.facetAssertions.bulkPut(rows);
    since = v.at;
    await db.searchCache.put({ key: posKey, userId, at: new Date().toISOString(), value: since });
    if (!v.more) break;
  }
  return census;
}

/** Every facet kept for the student's people, by person. */
export async function facetsByPerson(userId: string): Promise<Map<string, FacetRow[]>> {
  const rows = await db.facetAssertions.where('userId').equals(userId).toArray();
  const out = new Map<string, FacetRow[]>();
  for (const r of rows) {
    const list = out.get(r.personId);
    if (list) list.push(r);
    else out.set(r.personId, [r]);
  }
  return out;
}

/** Facets found while the student waited (a LinkedIn lookup from this browser), kept here and on the server. */
export async function keepFacets(
  userId: string,
  facets: { personId: string; kind: FacetRow['kind']; value: string; positive: boolean }[],
  opts: { local?: boolean } = {},
): Promise<void> {
  if (!facets.length) return;
  const at = new Date().toISOString();
  await db.facetAssertions.bulkPut(
    facets.map((f) => ({
      id: facetId({ ...f, source: 'facet_search' }),
      userId,
      ...f,
      source: 'facet_search',
      at,
    })),
  );
  if (isServerUser(userId) && !opts.local) await callApi('/search/facets', { facets }).catch(() => undefined);
}

let schoolsMem: Promise<SchoolIndex> | undefined;
export function schoolIndex(): Promise<SchoolIndex> {
  schoolsMem ??= loadSchools().then((rows) =>
    buildSchoolIndex(rows.map((r) => ({ name: r.name, domain: r.domain, aliases: r.aliases, kind: r.kind }))),
  );
  return schoolsMem;
}

let placesMem: Promise<PlaceIndex> | undefined;
export function placeIndex(): Promise<PlaceIndex> {
  placesMem ??= import('@orbit/core/search-places').then((m) => buildPlaceIndex(m.PLACES_DATA));
  return placesMem;
}

/** Test hook: forget what this tab loaded. */
export function resetSearchDataForTests(): void {
  factsMem = undefined;
  factsLoading = undefined;
  facetsPulledAt.clear();
  schoolsMem = undefined;
  placesMem = undefined;
}
