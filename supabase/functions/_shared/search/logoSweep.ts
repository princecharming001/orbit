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
  type CompanyCache,
  type CompanyPick,
  type CompanyRow,
  companyNameKey,
  keepProfileLogos,
  keptLogoFor,
  LOOKUP_RULES,
  lookupCompany,
  namesCompany,
  rowSettled,
  sameCompanyName,
  searchName,
} from '../providers/linkedinCompanies.ts';
import { experienceOf, profileOrgs, saveProfile, spendShare } from './reading.ts';

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
  /** where the bucket's logos are served from (a logo copied from a profile is found there by company id) */
  logosBase?: string;
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
  const schools = await schoolKeys(db);
  const byKey = new Map<string, { key: string; name: string; n: number }>();
  for (const r of rows) {
    const key = companyNameKey(r.name);
    if (!key || looksLikeSchool(r.name) || schools.has(key)) continue;
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
        rules: number;
      }>`
        select key, status, company_id, public_identifier, name, logo_url, checked_at::text as checked_at, rules
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
            rules: Number(r.rules),
          },
        ]),
      );
    },
    put: async (row) => {
      await db.sql`
        select public.orbit_linkedin_companies_put2(${row.key}, ${row.status}, ${row.companyId ?? null},
          ${row.publicIdentifier ?? null}, ${row.name ?? null}, ${row.logoUrl ?? null},
          ${row.rules ?? LOOKUP_RULES}::smallint)`;
    },
    storeLogo,
    getPicks: async (accountId, keys) => {
      if (!keys.length) return {};
      const rows = await db.sql<{
        key: string;
        company_id: string;
        public_identifier: string | null;
        name: string | null;
        logo_url: string | null;
        source: string;
        picked_at: string;
      }>`
        select key, company_id, public_identifier, name, logo_url, source, picked_at::text as picked_at
          from orbit_private.linkedin_company_picks where account_id = ${accountId} and key = any(${keys}::text[])`;
      return Object.fromEntries(
        rows.map((r) => [
          r.key,
          {
            key: r.key,
            companyId: r.company_id,
            publicIdentifier: r.public_identifier ?? undefined,
            name: r.name ?? undefined,
            logoUrl: r.logo_url ?? undefined,
            source: r.source === 'student' ? 'student' : 'position',
            pickedAt: new Date(r.picked_at).toISOString(),
          } satisfies CompanyPick,
        ]),
      );
    },
    putPick: async (accountId, p) => {
      await db.sql`
        select public.orbit_linkedin_company_picks_put(${accountId}, ${p.key}, ${p.companyId},
          ${p.publicIdentifier ?? null}, ${p.name ?? null}, ${p.logoUrl ?? null}, ${p.source})`;
    },
  };
}

/**
 * Names the shared list does not answer yet: never looked up, not pinned down over a month ago, or not pinned down
 * under older rules (LOOKUP_RULES). A name found under its cleaned form ("Deel (YC 19)" as Deel) is answered.
 */
export function missing<T extends { key: string; name: string }>(
  candidates: T[],
  rows: Record<string, CompanyRow>,
  now: Date,
): T[] {
  return candidates.filter((c) => {
    if (rowSettled(rows[c.key], now)) return false;
    const cleaned = rows[companyNameKey(searchName(c.name))];
    return !(cleaned?.status === 'found' && cleaned.logoUrl);
  });
}

/** The shared list's rows for these names, under the name as written and as cleaned. */
async function rowsFor(cache: CompanyCache, names: { key: string; name: string }[]) {
  const keys = new Set<string>();
  for (const c of names) {
    keys.add(c.key);
    const k = companyNameKey(searchName(c.name));
    if (k) keys.add(k);
  }
  return cache.getMany([...keys]);
}

/** One part of the weekly sweep. */
export async function runLogoSweep(db: Db, deps: SweepDeps, now: Date): Promise<SweepResult> {
  const deadline = deps.clock() + SWEEP_JOB_MS;
  const candidates = await sweepCandidates(db);
  const cache = sqlCompanyCache(db, deps.storeLogo);
  const rows = await rowsFor(cache, candidates);
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

// ---- one student's companies (plan 37 follow-up) ---------------------------------------------------------------------

/**
 * logos.user: every company in one student's network, and every company they target, each with its own LinkedIn logo
 * and never another company's. Their target companies come first, then their people's current companies, most people
 * first, then the companies in the work histories Orbit has read. Three ways, in this order:
 *
 * 1. Free: the profiles Orbit has already read for this student name each person's companies by LinkedIn's id. Each
 *    person's current position settles the company their row names, for this student (orbit_private.
 *    linkedin_company_picks); its logo is the copy kept when the profile was read.
 * 2. By name, from the company ledger (USER_SHARE): LinkedIn's company search, taken only when it answers plainly
 *    (linkedinCompanies chooseCompany). Rows found under older rules are checked again after the new names.
 * 3. By a person, from the profile ledger (PROFILE_SHARE): a company the name cannot settle ("Triumph", "Nova") is
 *    settled by reading the profile of one of the student's own people who works there: their position names it.
 *
 * One part works for SWEEP_JOB_MS; the handler queues the next while names are left and the day's shares are not spent.
 */
export const USER_SHARE = 0.7;
/** How far into the day's profile reads settling companies by a person may go (orbit-connectors routes go further). */
export const PROFILE_SHARE = 0.6;
/** Parts a day at most for one student (each SWEEP_JOB_MS): the shares run out well before. */
export const USER_MAX_PARTS = 24;
/** The most companies one student's run considers, most people first. */
export const USER_CANDIDATES = 4000;
/** A company settled without a logo has its LinkedIn page read for one again after this long. */
export const PICK_LOGO_RETRY_MS = 7 * 86_400_000;
/** A target company counts as this many people, so the student's targets are always looked up first. */
const TARGET_WEIGHT = 1_000_000;

export interface UserCandidate {
  key: string;
  name: string;
  /** people at it (now, or in their work history); targets count TARGET_WEIGHT */
  n: number;
  /** people at it now */
  now?: number;
  /** LinkedIn's id for it, from a read profile's position */
  companyId?: string;
  /** one of the student's target companies */
  target?: boolean;
}

/**
 * Names that are schools by how people list them: more often under education than under work, across every student
 * ("UCSC", "Rutgers", "NYU Stern" read like no school word). Kept for the weekly sweep, which leaves schools to the
 * profiles that name them.
 */
export async function schoolKeys(db: Db): Promise<Set<string>> {
  const rows = await db.sql<{ name: string; edu: number; work: number }>`
    select coalesce(o.name, a.org_raw) as name,
           count(*) filter (where a.kind = 'education')::int as edu,
           count(*) filter (where a.kind = 'employment')::int as work
      from orbit.affiliations a
      left join orbit.organizations o on o.id = a.org_id
     where coalesce(o.name, a.org_raw) is not null
     group by 1`;
  const tally = new Map<string, { edu: number; work: number }>();
  for (const r of rows) {
    const k = companyNameKey(r.name);
    if (!k) continue;
    const t = tally.get(k) ?? { edu: 0, work: 0 };
    t.edu += r.edu;
    t.work += r.work;
    tally.set(k, t);
  }
  return new Set([...tally].filter(([, t]) => t.edu > t.work).map(([k]) => k));
}

export async function userLogoCandidates(db: Db, userId: string): Promise<UserCandidate[]> {
  const rows = await db.sql<{ name: string; n: number; now: number }>`
    with named as (
      select coalesce(o.name, p.org_raw) as name, p.id as pid, true as current
        from orbit.people p
        left join orbit.organizations o on o.id = p.org_id
       where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null
         and not p.is_self and p.hidden_at is null and coalesce(o.name, p.org_raw) is not null
      union all
      select coalesce(o.name, a.org_raw), a.person_id, coalesce(a.is_current, false)
        from orbit.affiliations a
        join orbit.people p on p.id = a.person_id and p.deleted_at is null and p.merged_into is null
        left join orbit.organizations o on o.id = a.org_id
       where a.user_id = ${userId}::uuid and a.kind = 'employment' and coalesce(o.name, a.org_raw) is not null
    )
    select mode() within group (order by name) as name, count(distinct pid)::int as n,
           count(distinct pid) filter (where current)::int as now
      from named
     group by trim(regexp_replace(regexp_replace(regexp_replace(replace(lower(name), '&', ' and '),
              '[^a-z0-9]+', ' ', 'g'), ${SUFFIX_RE}, ' ', 'g'), ' +', ' ', 'g'))
     order by count(distinct pid) filter (where current) desc, count(distinct pid) desc, 1
     limit ${USER_CANDIDATES}`;
  // the companies the student targets (their goals), first of all
  const targets = await db.sql<{ name: string }>`
    select distinct trim(t.name) as name
      from orbit.goals g, jsonb_array_elements_text(coalesce(g.targets->'organizations', '[]'::jsonb)) t(name)
     where g.user_id = ${userId}::uuid and g.deleted_at is null and trim(t.name) <> ''`;
  // LinkedIn's ids for companies, from the positions of the profiles Orbit has read for this student
  const idRows = await db.sql<{ name: string; id: string }>`
    select distinct on (e->>'company') e->>'company' as name, e->>'companyId' as id
      from orbit.profile_reads r, jsonb_array_elements(case when jsonb_typeof(r.experience) = 'array'
                                                             then r.experience else '[]'::jsonb end) e
     where r.user_id = ${userId}::uuid and e->>'companyId' ~ '^[0-9]+$' and e->>'company' is not null`;
  const ids = new Map<string, string>();
  for (const r of idRows) {
    const k = companyNameKey(r.name);
    if (k && !ids.has(k)) ids.set(k, r.id);
  }
  const byKey = new Map<string, UserCandidate>();
  for (const t of targets) {
    const key = companyNameKey(t.name);
    if (key && !byKey.has(key))
      byKey.set(key, { key, name: t.name, n: TARGET_WEIGHT, now: 0, target: true, companyId: ids.get(key) });
  }
  for (const r of rows) {
    const key = companyNameKey(r.name);
    if (!key) continue;
    const had = byKey.get(key);
    if (had) {
      had.n += r.n;
      had.now = (had.now ?? 0) + r.now;
    } else byKey.set(key, { key, name: r.name.trim(), n: r.n, now: r.now, companyId: ids.get(key) });
  }
  // a company only a read profile names (not yet among their people's rows) still counts
  for (const r of idRows) {
    const key = companyNameKey(r.name);
    if (key && !byKey.has(key)) byKey.set(key, { key, name: r.name.trim(), n: 1, now: 0, companyId: r.id });
  }
  return [...byKey.values()].sort((a, b) => b.n - a.n);
}

export interface UserLogoResult extends SweepResult {
  /** the student's companies answered with a logo (their picks, or the shared list) */
  withLogo: number;
  /** companies settled for this student from profiles Orbit had read (no read spent) */
  fromReads: number;
  /** profiles read to settle a company */
  peopleRead: number;
}

/**
 * The current position on a read profile that a person's company row means: one whose company LinkedIn names the
 * same as the row does ("Deel (YC W19)" is Deel, "Nova (acquired)" is Nova). A current job at another company is
 * never taken for the row: the row may be out of date (they moved from Google to OpenAI), and OpenAI's logo must
 * never show as Google's.
 */
export function positionFor(
  experience: { company?: string; companyId?: string; current?: boolean }[],
  orgName: string,
): { company?: string; companyId: string } | undefined {
  const clean = searchName(orgName);
  return experience.find(
    (e): e is typeof e & { companyId: string } =>
      !!e.companyId &&
      !!e.current &&
      (sameCompanyName(e.company, orgName) ||
        sameCompanyName(e.company, clean) ||
        namesCompany(e.company, orgName) ||
        namesCompany(e.company, clean) ||
        namesCompany(orgName, e.company ?? '')),
  );
}

/**
 * Keep `pick` for the account. The shared list is left as it is: one student's people may sit on another page of the
 * same name (a contact's position on an old Whop page), and that is no reason to take Whop's logo from everyone.
 * A row the older rules made is checked against LinkedIn's search again anyway (phase 2).
 */
async function settle(cache: CompanyCache, accountId: string, pick: CompanyPick): Promise<void> {
  await cache.putPick?.(accountId, pick);
}

/** A logo already kept for a company id: on a shared row or a pick of it, or the copy a profile read made. */
async function logoForId(
  db: Db,
  id: string,
  deps: Pick<SweepDeps, 'fetch' | 'logosBase'>,
): Promise<string | undefined> {
  const [row] = await db.sql<{ logo_url: string }>`
    select logo_url from orbit_private.linkedin_companies where company_id = ${id} and logo_url is not null
    union all
    select logo_url from orbit_private.linkedin_company_picks where company_id = ${id} and logo_url is not null
    limit 1`;
  return row?.logo_url ?? (await keptLogoFor(id, deps.fetch, deps.logosBase));
}

/** One part of one student's pass. */
export async function runUserLogos(
  db: Db,
  userId: string,
  deps: SweepDeps,
  now: Date,
): Promise<UserLogoResult> {
  const deadline = deps.clock() + SWEEP_JOB_MS;
  const candidates = await userLogoCandidates(db, userId);
  const cache = sqlCompanyCache(db, deps.storeLogo);
  const [acct] = await db.sql<{ id: string }>`
    select a.external_account_id as id from orbit.integration_accounts a
     where a.user_id = ${userId}::uuid and a.provider = 'linkedin' and a.status = 'active'
       and a.external_account_id is not null
     limit 1`;
  const rows = await rowsFor(cache, candidates);
  const result: UserLogoResult = {
    candidates: candidates.length,
    remaining: 0,
    looked: 0,
    found: 0,
    accounts: acct ? 1 : 0,
    withLogo: 0,
    fromReads: 0,
    peopleRead: 0,
  };
  if (!acct) {
    result.withLogo = candidates.filter((c) => rows[c.key]?.logoUrl).length;
    return { ...result, remaining: missing(candidates, rows, now).length, stopped: 'no_accounts' };
  }
  const picks =
    (await cache.getPicks?.(
      acct.id,
      candidates.map((c) => c.key),
    )) ?? {};

  // 1. free: what the profiles already read say about each person's company
  const reads = await db.sql<{ name: string; experience: unknown }>`
    select coalesce(o.name, p.org_raw) as name, r.experience
      from orbit.profile_reads r
      join orbit.people p on p.id = r.person_id and p.deleted_at is null
      left join orbit.organizations o on o.id = p.org_id
     where r.user_id = ${userId}::uuid and r.status = 'ok' and coalesce(o.name, p.org_raw) is not null
       and jsonb_typeof(r.experience) = 'array'`;
  for (const r of reads) {
    const key = companyNameKey(r.name);
    if (!key || picks[key]) continue;
    const pos = positionFor(
      r.experience as { company?: string; companyId?: string; current?: boolean }[],
      r.name,
    );
    if (!pos) continue;
    const pick: CompanyPick = {
      key,
      companyId: pos.companyId,
      name: pos.company,
      logoUrl: await logoForId(db, pos.companyId, deps),
      source: 'position',
    };
    await settle(cache, acct.id, pick);
    picks[key] = pick;
    result.fromReads++;
  }

  // 1b. a company settled without a logo (the profile it came from had none to copy): its page, by id, once a week
  const u = { base: deps.baseUrl.replace(/\/+$/, ''), key: deps.apiKey };
  let companyLimit = false;
  for (const c of candidates) {
    const pk = picks[c.key];
    if (!pk || pk.logoUrl || !((c.now ?? 0) > 0 || c.target)) continue;
    if (pk.pickedAt && now.getTime() - Date.parse(pk.pickedAt) < PICK_LOGO_RETRY_MS) continue;
    if (deps.clock() >= deadline) {
      result.stopped = 'time';
      break;
    }
    if (result.looked > 0) await deps.sleep(800 + Math.floor(deps.random() * 1200));
    const r = await lookupCompany(u, {
      accountId: acct.id,
      key: c.key,
      name: c.name,
      companyId: pk.companyId,
      idOnly: true,
      cache,
      doFetch: deps.fetch,
      now,
      spend: () => spendShare(db, 'company', acct.id, now, USER_SHARE),
    }).catch(() => ({ looked: true, answer: undefined, stopped: undefined }));
    if (r.looked) result.looked++;
    // a page that did not answer: tried again after a while, like one with no logo
    if (!r.answer && r.looked) await cache.putPick?.(acct.id, pk).catch(() => undefined);
    if (r.answer?.logoUrl) {
      result.found++;
      picks[c.key] = { ...pk, logoUrl: r.answer.logoUrl };
    }
    if (r.stopped) {
      companyLimit = true;
      break;
    }
  }

  // 2. by name: new names first (targets lead), then rows found under older rules
  const fresh = missing(
    candidates.filter((c) => !picks[c.key]),
    rows,
    now,
  );
  const stale = candidates.filter((c) => {
    const r = rows[c.key];
    return !picks[c.key] && r?.status === 'found' && (r.rules ?? 1) < LOOKUP_RULES;
  });
  for (const c of companyLimit || result.stopped ? [] : [...fresh, ...stale]) {
    if (deps.clock() >= deadline) {
      result.stopped = 'time';
      break;
    }
    if (result.looked > 0) await deps.sleep(800 + Math.floor(deps.random() * 1200));
    const r = await lookupCompany(u, {
      accountId: acct.id,
      key: c.key,
      name: c.name,
      companyId: c.companyId,
      cache,
      doFetch: deps.fetch,
      now,
      spend: () => spendShare(db, 'company', acct.id, now, USER_SHARE),
      recheck: fresh.includes(c) ? undefined : rows[c.key],
    }).catch(() => ({ looked: true, answer: undefined, stopped: undefined }));
    if (r.looked) result.looked++;
    if (r.answer?.status === 'found' && r.answer.logoUrl) result.found++;
    if (r.answer) {
      if (r.answer.exact && r.answer.companyId)
        picks[c.key] = {
          key: c.key,
          companyId: r.answer.companyId,
          logoUrl: r.answer.logoUrl,
          source: 'position',
        };
      else
        rows[c.key] = {
          key: c.key,
          status: r.answer.status,
          companyId: r.answer.companyId,
          name: r.answer.name,
          logoUrl: r.answer.logoUrl,
          checkedAt: now.toISOString(),
        };
    }
    if (r.stopped) {
      companyLimit = true;
      break;
    }
  }

  // 3. by a person: a company the name could not settle, read from one of the student's own people who works there
  // (a company today's rules found without a logo has none on LinkedIn: a person's profile would not give one)
  const unsettled = candidates.filter((c) => {
    const r = rows[c.key];
    if (picks[c.key] || !(c.now ?? 0)) return false;
    if (r?.status === 'found') return !r.logoUrl && (r.rules ?? 1) < LOOKUP_RULES;
    return true;
  });
  if (result.stopped !== 'time' && unsettled.length) {
    const people = await db.sql<{ id: string; member: string; name: string }>`
      select distinct on (k) p.id, p.linkedin_member_id as member, coalesce(o.name, p.org_raw) as name,
             trim(regexp_replace(regexp_replace(regexp_replace(replace(lower(coalesce(o.name, p.org_raw)), '&', ' and '),
               '[^a-z0-9]+', ' ', 'g'), ${SUFFIX_RE}, ' ', 'g'), ' +', ' ', 'g')) as k
        from orbit.people p
        left join orbit.organizations o on o.id = p.org_id
        left join orbit.profile_reads r on r.person_id = p.id and r.user_id = p.user_id
       where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null and not p.is_self
         and p.hidden_at is null and p.linkedin_member_id is not null and coalesce(o.name, p.org_raw) is not null
         and (r.person_id is null or r.status <> 'ok')
       order by k, p.updated_at desc`;
    const byKey = new Map(people.map((p) => [companyNameKey(p.name), p] as const));
    let reads = 0;
    for (const c of unsettled) {
      if (deps.clock() >= deadline) {
        result.stopped = 'time';
        break;
      }
      const p = byKey.get(c.key);
      if (!p) continue;
      if (!(await spendShare(db, 'profile', acct.id, now, PROFILE_SHARE))) {
        result.stopped = 'limit';
        break;
      }
      if (reads++ > 0) await deps.sleep(2500 + Math.floor(deps.random() * 2500));
      const q = new URLSearchParams({ account_id: acct.id, notify: 'false' });
      q.append('linkedin_sections', 'about');
      q.append('linkedin_sections', 'experience');
      const res = await deps
        .fetch(`${u.base}/api/v1/users/${encodeURIComponent(p.member)}?${q}`, {
          headers: { 'X-API-KEY': deps.apiKey, accept: 'application/json' },
        })
        .catch(() => undefined);
      if (!res) continue;
      if (res.status === 429) {
        result.stopped = 'limit';
        break;
      }
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const raw = (await res.json()) as Record<string, unknown>;
      result.peopleRead++;
      await saveProfile(db, userId, p.id, p.member, raw, 'background', now).catch(() => undefined);
      // every company and school on the profile: copied, and this account's pick under its own name
      const orgs = profileOrgs(raw);
      await keepProfileLogos(cache, orgs, deps.fetch, now, { accountId: acct.id }).catch(() => 0);
      const pos = positionFor(experienceOf(raw.work_experience), p.name);
      if (!pos) continue;
      const pick: CompanyPick = {
        key: c.key,
        companyId: pos.companyId,
        name: pos.company,
        logoUrl:
          orgs.find((o) => o.companyId === pos.companyId)?.logoUrl ??
          (await logoForId(db, pos.companyId, deps)),
        source: 'position',
      };
      await settle(cache, acct.id, pick);
      picks[c.key] = pick;
    }
  }
  if (companyLimit && !result.stopped) result.stopped = 'limit';
  result.withLogo = candidates.filter((c) => (picks[c.key] ?? rows[c.key])?.logoUrl).length;
  result.remaining = candidates.filter((c) => {
    const r = rows[c.key];
    return !picks[c.key] && !rowSettled(r, now);
  }).length;
  return result;
}
