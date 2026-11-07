/**
 * Ask-time facet lookups (plan 32 §6.5): while the student waits, up to three LinkedIn searches of their own
 * connections, one filter each (a company, a school, a place the search names), so "Berkeley alums at Stripe in SF"
 * rests on what LinkedIn lists instead of headlines alone. An account's lookups run on the server (POST /search/lookup,
 * its LinkedIn account); a browser-held LinkedIn runs them through orbit-connectors with `strict`, so a filter LinkedIn
 * has no id for is skipped rather than searched as words.
 *
 * What a lookup leaves: a positive facet for each of the student's people LinkedIn listed, and, when LinkedIn ran out
 * of results within the pages read, a complete scan. A complete scan turns "not listed" into a no for every connection
 * Orbit knows by LinkedIn id (docs.ts). Scans are kept a week; a fresh complete scan is never repeated.
 */

import type { FacetScanWire } from '@orbit/core';
import type { CompiledSpec } from '@orbit/core/search';
import { db } from '../../db/schema';
import { usesMockConnectors } from '../../integrations/connectorsMock';
import { callApi, isServerUser } from '../../integrations/orbitApi';
import { searchLinkedIn } from '../../integrations/unipile';
import { liveLinkedInAccount } from '../linkedinLive';
import { keepFacets } from './data';

export const MAX_LOOKUPS = 3;
const PAGES = 3;
const SCAN_FRESH_MS = 7 * 86_400_000;
const SCAN_KEEP_MS = 30 * 86_400_000;
const LOOKUP_BUDGET_MS = 15_000;

export interface Lookup {
  kind: FacetScanWire['kind'];
  value: string;
}

const scansKey = (userId: string) => `scans:${userId}`;

/** The complete scans kept for the student (from the server's facets answer and this browser's own lookups). */
export async function loadScans(userId: string): Promise<FacetScanWire[]> {
  const row = await db.searchCache.get(scansKey(userId));
  const list = (row?.value as FacetScanWire[] | undefined) ?? [];
  const cutoff = Date.now() - SCAN_KEEP_MS;
  return list.filter((s) => Date.parse(s.at) >= cutoff);
}

export async function keepScans(userId: string, scans: FacetScanWire[], replace = false): Promise<void> {
  const prev = replace ? [] : await loadScans(userId);
  const byKey = new Map(prev.map((s) => [`${s.kind}|${s.value}`, s]));
  for (const s of scans) byKey.set(`${s.kind}|${s.value}`, s);
  await db.searchCache.put({
    key: scansKey(userId),
    userId,
    at: new Date().toISOString(),
    value: [...byKey.values()],
  });
}

/**
 * The lookups a compiled search could use, most selective first: companies (a current job), then schools, then
 * places. Past-only companies are skipped (LinkedIn's company filter is the current employer); so are negated ones.
 */
export function lookupsFor(c: CompiledSpec): Lookup[] {
  const out: Lookup[] = [];
  const seen = new Set<string>();
  const add = (kind: Lookup['kind'], value: string | undefined) => {
    const v = value?.trim();
    if (!v || v.length > 120) return;
    const k = `${kind}|${v.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, value: v });
  };
  for (const p of c.positions)
    if (!p.spec.negate && p.spec.when !== 'past')
      for (const n of p.spec.company?.names ?? []) add('company', n);
  for (const s of c.schools) if (!s.spec.negate) add('school', [...s.names][0]);
  for (const p of c.places) if (!p.spec.negate) for (const t of p.targets) add('place', t.label);
  return out;
}

/** Runs the lookups the search needs that are not already known; true when any found something new. */
export async function runLookups(
  user: { id: string },
  lookups: Lookup[],
  signal?: AbortSignal,
): Promise<boolean> {
  const scans = await loadScans(user.id);
  const fresh = new Set(
    scans.filter((s) => Date.now() - Date.parse(s.at) < SCAN_FRESH_MS).map((s) => `${s.kind}|${s.value}`),
  );
  const todo = lookups.filter((l) => !fresh.has(`${l.kind}|${l.value}`)).slice(0, MAX_LOOKUPS);
  if (!todo.length) return false;
  const one = isServerUser(user.id) ? serverLookup : await browserLookup(user.id);
  if (!one) return false;
  const all = Promise.all(todo.map((l) => one(l, signal).catch(() => undefined)));
  const done = await Promise.race([
    all,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), LOOKUP_BUDGET_MS)),
  ]);
  if (!done) return false;
  const now = new Date().toISOString();
  const positives: { personId: string; kind: Lookup['kind']; value: string; positive: boolean }[] = [];
  const complete: FacetScanWire[] = [];
  for (const r of done) {
    if (!r) continue;
    for (const id of r.personIds)
      positives.push({ personId: id, kind: r.kind, value: r.value, positive: true });
    if (r.complete) complete.push({ kind: r.kind, value: r.value, at: now });
  }
  // the server already kept an account's; this keeps the browser's copy (and a browser-held LinkedIn's on the server)
  if (positives.length) await keepFacets(user.id, positives, { local: isServerUser(user.id) });
  if (complete.length) await keepScans(user.id, complete);
  return positives.length > 0 || complete.length > 0;
}

interface LookupAnswer extends Lookup {
  personIds: string[];
  complete: boolean;
}

async function serverLookup(l: Lookup): Promise<LookupAnswer | undefined> {
  const r = await callApi('/search/lookup', l);
  if (!r.ok || !r.value.ok) return undefined;
  return { ...l, personIds: r.value.personIds, complete: r.value.complete };
}

type OneLookup = (l: Lookup, signal?: AbortSignal) => Promise<LookupAnswer | undefined>;

async function browserLookup(userId: string): Promise<OneLookup | undefined> {
  if (usesMockConnectors(userId)) return undefined;
  const row = await liveLinkedInAccount(userId);
  if (!row?.externalAccountId || !row.accessToken || row.status === 'revoked') return undefined;
  const mine = await db.people.where('userId').equals(userId).toArray();
  const byMember = new Map(mine.filter((p) => p.linkedinMemberId).map((p) => [p.linkedinMemberId!, p.id]));
  const filterOf = (l: Lookup) =>
    l.kind === 'company'
      ? { company: l.value }
      : l.kind === 'school'
        ? { school: l.value }
        : { location: l.value };
  return async (l) => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < PAGES; page++) {
      const r = await searchLinkedIn(
        row.externalAccountId!,
        { ...filterOf(l), distance: [1], cursor, strict: true, purpose: 'facets' },
        { token: row.accessToken },
      );
      if (!r.ok) return page ? { ...l, personIds: [...ids], complete: false } : undefined;
      for (const f of r.value.people) {
        const id = byMember.get(f.memberId);
        if (id) ids.add(id);
      }
      cursor = r.value.cursor;
      if (!cursor || !r.value.people.length) return { ...l, personIds: [...ids], complete: true };
    }
    return { ...l, personIds: [...ids], complete: false };
  };
}
