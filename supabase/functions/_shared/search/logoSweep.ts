/**
 * logos.sweep (plan 35 B4): once a week, the companies 3 or more people work at across all students, looked up on
 * LinkedIn once and kept in the shared orbit_private.linkedin_companies list with their logos in Orbit's storage. Every
 * browser then answers those tiles from the shared list without a LinkedIn read, and no browser sweeps its whole
 * network any more (apps/web engine/logoQueue.ts asks only for the tiles a screen showed).
 *
 * Reads come from the connected students' LinkedIn accounts in turn, each up to SWEEP_SHARE of its daily company
 * ledger (the same counters orbit-connectors and search_reading take from). A name LinkedIn cannot pin down is kept as
 * such and not looked up again for a month (COMPANY_RETRY_MS). One run works for SWEEP_JOB_MS; the handler queues the
 * next part while names are left, up to SWEEP_MAX_PARTS a week.
 */
import { looksLikeSchool } from '@orbit/core/resume/schools';
import type { Db } from '../db.ts';
import {
  COMPANY_RETRY_MS,
  type CompanyCache,
  type CompanyRow,
  companyNameKey,
  lookupCompany,
} from '../providers/linkedinCompanies.ts';
import { spendShare } from './reading.ts';

/** People across all students a company needs before the sweep looks it up. */
export const SWEEP_MIN_PEOPLE = 3;
/** The share of each account's daily company ledger the sweep may take (connectors' logos may take all of it). */
export const SWEEP_SHARE = 0.3;
/** Wall clock one part works before it stops and leaves the rest to the next part. */
export const SWEEP_JOB_MS = 45_000;
/** Parts a week at most: the sweep never runs all week on a big backlog. */
export const SWEEP_MAX_PARTS = 12;
/** The most companies considered a run, most people first. */
export const SWEEP_CANDIDATES = 2000;

export interface SweepDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  /** keeps a logo in the company-logos bucket; answers where it is served from */
  storeLogo: CompanyCache['storeLogo'];
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  clock: () => number;
}

export interface SweepResult {
  candidates: number;
  /** companies still to look up after this part */
  remaining: number;
  looked: number;
  found: number;
  accounts: number;
  stopped?: 'no_accounts' | 'limit' | 'time';
}

/** companyNameKey's legal suffixes, for grouping in SQL (the key is computed again in code). */
const SUFFIX_RE =
  '\\m(the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag|bv|lp|llp)\\M';

/** Companies with SWEEP_MIN_PEOPLE or more people across all students, most people first, by shared-list key. */
export async function sweepCandidates(db: Db): Promise<{ key: string; name: string; n: number }[]> {
  const rows = await db.sql<{ name: string; n: number }>`
    with named as (
      select coalesce(o.name, p.org_raw) as name
        from orbit.people p
        join orbit.users u on u.id = p.user_id and u.deleted_at is null
        left join orbit.organizations o on o.id = p.org_id
       where p.deleted_at is null and p.merged_into is null and not p.is_self and p.hidden_at is null
         and coalesce(o.name, p.org_raw) is not null
    )
    select mode() within group (order by name) as name, count(*)::int as n
      from named
     group by trim(regexp_replace(regexp_replace(regexp_replace(replace(lower(name), '&', ' and '),
              '[^a-z0-9]+', ' ', 'g'), ${SUFFIX_RE}, ' ', 'g'), ' +', ' ', 'g'))
    having count(*) >= ${SWEEP_MIN_PEOPLE}
     order by count(*) desc
     limit ${SWEEP_CANDIDATES}`;
  const byKey = new Map<string, { key: string; name: string; n: number }>();
  for (const r of rows) {
    const key = companyNameKey(r.name);
    if (!key || looksLikeSchool(r.name)) continue;
    const had = byKey.get(key);
    if (had) had.n += r.n;
    else byKey.set(key, { key, name: r.name.trim(), n: r.n });
  }
  return [...byKey.values()].sort((a, b) => b.n - a.n);
}

/** The shared list over SQL (the worker's own connection), with logos kept through `storeLogo`. */
export function sqlCompanyCache(db: Db, storeLogo: CompanyCache['storeLogo']): CompanyCache {
  return {
    getMany: async (keys) => {
      if (!keys.length) return {};
      const rows = await db.sql<{
        key: string;
        status: CompanyRow['status'];
        company_id: string | null;
        public_identifier: string | null;
        name: string | null;
        logo_url: string | null;
        checked_at: string;
      }>`
        select key, status, company_id, public_identifier, name, logo_url, checked_at::text as checked_at
          from orbit_private.linkedin_companies where key = any(${keys}::text[])`;
      return Object.fromEntries(
        rows.map((r) => [
          r.key,
          {
            key: r.key,
            status: r.status,
            companyId: r.company_id ?? undefined,
            publicIdentifier: r.public_identifier ?? undefined,
            name: r.name ?? undefined,
            logoUrl: r.logo_url ?? undefined,
            checkedAt: new Date(r.checked_at).toISOString(),
          },
        ]),
      );
    },
    put: async (row) => {
      await db.sql`
        select public.orbit_linkedin_companies_put(${row.key}, ${row.status}, ${row.companyId ?? null},
          ${row.publicIdentifier ?? null}, ${row.name ?? null}, ${row.logoUrl ?? null})`;
    },
    storeLogo,
  };
}

/** Names the shared list does not answer yet: never looked up, or not pinned down over a month ago. */
export function missing(
  candidates: { key: string; name: string }[],
  rows: Record<string, CompanyRow>,
  now: Date,
): { key: string; name: string }[] {
  return candidates.filter((c) => {
    const r = rows[c.key];
    if (!r) return true;
    // found with a logo kept, or found and kept by a browser: done; not pinned down: again after a month
    if (r.status === 'found') return false;
    return now.getTime() - Date.parse(r.checkedAt) >= COMPANY_RETRY_MS;
  });
}

/** One part of the weekly sweep. */
export async function runLogoSweep(db: Db, deps: SweepDeps, now: Date): Promise<SweepResult> {
  const deadline = deps.clock() + SWEEP_JOB_MS;
  const candidates = await sweepCandidates(db);
  const cache = sqlCompanyCache(db, deps.storeLogo);
  const rows = await cache.getMany(candidates.map((c) => c.key));
  const todo = missing(candidates, rows, now);
  const accounts = (
    await db.sql<{ id: string }>`
      select distinct a.external_account_id as id
        from orbit.integration_accounts a
        join orbit.users u on u.id = a.user_id and u.deleted_at is null
       where a.provider = 'linkedin' and a.status = 'active' and a.external_account_id is not null`
  ).map((r) => r.id);
  const result: SweepResult = {
    candidates: candidates.length,
    remaining: todo.length,
    looked: 0,
    found: 0,
    accounts: accounts.length,
  };
  if (!todo.length) return result;
  if (!accounts.length) return { ...result, stopped: 'no_accounts' };
  const u = { base: deps.baseUrl.replace(/\/+$/, ''), key: deps.apiKey };
  // accounts take turns; one whose share is spent, or that LinkedIn asked to slow down, leaves the rotation and the
  // name it could not finish goes to the next account
  const live = [...accounts];
  const queue = [...todo];
  let turn = 0;
  let settled = 0;
  while (queue.length) {
    if (deps.clock() >= deadline) {
      result.stopped = 'time';
      break;
    }
    if (!live.length) {
      result.stopped = 'limit';
      break;
    }
    const c = queue[0]!;
    const accountId = live[turn++ % live.length]!;
    if (result.looked > 0) await deps.sleep(800 + Math.floor(deps.random() * 1200));
    const r = await lookupCompany(u, {
      accountId,
      key: c.key,
      name: c.name,
      cache,
      doFetch: deps.fetch,
      now,
      spend: () => spendShare(db, 'company', accountId, now, SWEEP_SHARE),
    }).catch(() => ({ looked: true, answer: undefined, stopped: undefined }));
    if (r.looked) result.looked++;
    if (r.answer?.status === 'found' && r.answer.logoUrl) result.found++;
    if (r.stopped) live.splice(live.indexOf(accountId), 1);
    // answered (found, or kept as not pinned down), or refused for good: done for this week
    if (r.answer || (r.looked && !r.stopped)) {
      queue.shift();
      settled++;
    }
  }
  result.remaining = todo.length - settled;
  return result;
}
