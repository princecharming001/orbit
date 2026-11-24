/**
 * Plan 44 §5 steps 1 and 2: from every open role to the student's list. The filter is SQL over
 * orbit_private.jobs (open, listed once, at the levels the profile searches or not said, in the families of the kinds
 * ticked or sharing their title words, in the student's places or remote, sponsorship as they said, the companies they
 * named, nothing they dismissed). The rank is `rankRoles` in core, in code, over what the filter kept. The top 60 go
 * into orbit.role_matches as to be read, keeping each row's status; a row read against other evidence goes back to be
 * read again.
 *
 * Roles from the student's own LinkedIn job search (§4.4) join the candidates: one search per ticked kind, at most
 * three, through their own active account, each query run at most once a day (orbit.role_source_reads). A LinkedIn
 * role is the searching student's: other students never see it in their filter.
 */

import { levelsFor } from '../../../../packages/core/src/roles/profileLevel.ts';
import { kindFamilies, rankRoles, roleTitleWords } from '../../../../packages/core/src/roles/rank.ts';
import type { Job, JobLevel, ProfileLevel, RoleProfile } from '../../../../packages/core/src/roles/types.ts';
import { normalizeCompany } from '../../../../packages/core/src/text/normalize.ts';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { iso } from '../rows.ts';
import type { Services } from '../services.ts';
import type { LinkedinJobAccess, LinkedinJobQuery, RoleNet, RoleSources } from './contracts.ts';

/** How many roles a search lists for reading (§5). */
export const LIST_SIZE = 60;
/** LinkedIn searches per profile, one per ticked kind. */
export const LINKEDIN_KINDS = 3;
/** The filter's row limit before ranking: newest first. */
export const FILTER_LIMIT = 2000;

/** A role as the filter reads it. */
export type JobRow = {
  id: string;
  source: Job['source'];
  external_id: string;
  company_key: string;
  company_name: string;
  company_domain: string | null;
  company_logo_url: string | null;
  title: string;
  title_key: string;
  team: string | null;
  family: string | null;
  level: JobLevel | null;
  employment: Job['employment'] | null;
  places: string[];
  countries: string[];
  remote: Job['remote'] | null;
  term: string | null;
  pay: Job['pay'] | null;
  sponsorship: Job['sponsorship'] | null;
  degrees: string[];
  url: string;
  apply_url: string | null;
  posted_at: Date | string | null;
  first_seen_at: Date | string;
  closed_at: Date | string | null;
};

export const JOB_COLUMNS = `j.id::text as id, j.source, j.external_id, j.company_key, j.company_name, j.company_domain,
  j.company_logo_url, j.title, j.title_key, j.team, j.family, j.level, j.employment, j.places, j.countries, j.remote,
  j.term, j.pay, j.sponsorship, j.degrees, j.url, j.apply_url, j.posted_at, j.first_seen_at, j.closed_at`;

/** A stored role in the shape every part shares. */
export function jobOf(r: JobRow): Job {
  const job: Job = {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    companyKey: r.company_key,
    companyName: r.company_name,
    title: r.title,
    places: r.places ?? [],
    countries: r.countries ?? [],
    degrees: r.degrees ?? [],
    url: r.url,
    firstSeenAt: iso(r.first_seen_at)!,
  };
  if (r.company_domain) job.companyDomain = r.company_domain;
  if (r.company_logo_url) job.companyLogoUrl = r.company_logo_url;
  if (r.team) job.team = r.team;
  if (r.family) job.family = r.family as Job['family'];
  if (r.level) job.level = r.level;
  if (r.employment) job.employment = r.employment;
  if (r.remote) job.remote = r.remote;
  if (r.term) job.term = r.term;
  if (r.pay) job.pay = r.pay;
  if (r.sponsorship) job.sponsorship = r.sponsorship;
  if (r.apply_url) job.applyUrl = r.apply_url;
  if (r.posted_at) job.postedAt = iso(r.posted_at)!;
  if (r.closed_at) job.closedAt = iso(r.closed_at)!;
  return job;
}

/** The levels a profile searches: the student's own choice, else what its level follows (§14). */
export function searchLevels(p: Pick<RoleProfile, 'level' | 'wants'>): JobLevel[] {
  return p.wants.levels.length ? [...p.wants.levels] : levelsFor(p.level);
}

/** LinkedIn's experience levels for a profile level. */
export function linkedinSeniority(level: ProfileLevel): NonNullable<LinkedinJobQuery['seniority']> {
  switch (level) {
    case 'student':
      return ['intern'];
    case 'new_grad':
      return ['entry'];
    case 'early':
      return ['entry', 'associate'];
    case 'mid':
      return ['associate', 'mid_senior'];
    case 'senior':
      return ['mid_senior', 'director'];
  }
}

const ticked = (p: RoleProfile) => {
  const on = p.kinds.filter((k) => k.on);
  return on.length ? on : [];
};

export interface FilterOptions {
  /** roles to keep whatever the family and title filters say (the student's fresh LinkedIn results) */
  include?: string[];
  /** only roles the student has no match row for yet (the nightly top-up) */
  onlyNew?: boolean;
  limit?: number;
}

/** Step 1, the filter (§5). */
export async function filterRoles(
  db: Db,
  userId: string,
  p: RoleProfile,
  o: FilterOptions = {},
): Promise<JobRow[]> {
  const kinds = ticked(p);
  const families = [...new Set(kinds.flatMap(kindFamilies))];
  const words = [...new Set(kinds.flatMap((k) => [...roleTitleWords(k.title)]))].filter((w) => w.length >= 3);
  const anyKind = kinds.length === 0;
  const levels = searchLevels(p);
  const places = p.wants.places.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const notPlaces = p.wants.notPlaces.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const companies = (p.wants.companies ?? []).map((c) => normalizeCompany(c)).filter(Boolean);
  const sponsor = p.eligibility.needsSponsorship === true;
  const include = o.include ?? [];
  return db.sql<JobRow>`
    select j.id::text as id, j.source, j.external_id, j.company_key, j.company_name, j.company_domain,
           j.company_logo_url, j.title, j.title_key, j.team, j.family, j.level, j.employment, j.places, j.countries,
           j.remote, j.term, j.pay, j.sponsorship, j.degrees, j.url, j.apply_url, j.posted_at, j.first_seen_at,
           j.closed_at
      from orbit_private.jobs j
     where j.closed_at is null and j.dupe_of is null
       and (j.level is null or j.level = any(${levels}::text[]))
       and (${anyKind}::boolean or j.id = any(${include}::uuid[]) or j.family = any(${families}::text[])
            or exists (select 1 from unnest(${words}::text[]) w
                        where lower(j.title) like '%' || w || '%' or j.title_key like '%' || w || '%'))
       and ((cardinality(${places}::text[]) = 0 and not ${p.wants.remote}::boolean)
            or cardinality(j.places) = 0
            or (${p.wants.remote}::boolean and j.remote = 'remote')
            or exists (select 1 from unnest(j.places) jp, unnest(${places}::text[]) w
                        where lower(jp) like '%' || w || '%'))
       and not (cardinality(${notPlaces}::text[]) > 0 and coalesce(j.remote, '') <> 'remote'
                and cardinality(j.places) > 0
                and not exists (select 1 from unnest(j.places) jp
                                 where not exists (select 1 from unnest(${notPlaces}::text[]) w
                                                    where lower(jp) like '%' || w || '%')))
       and (not ${sponsor}::boolean or coalesce(j.sponsorship, '') <> 'none')
       and (cardinality(${companies}::text[]) = 0 or j.company_key = any(${companies}::text[]))
       and (j.source <> 'linkedin' or j.id = any(${include}::uuid[])
            or exists (select 1 from orbit.role_matches m where m.user_id = ${userId}::uuid and m.job_id = j.id))
       and not exists (select 1 from orbit.role_matches m
                        where m.user_id = ${userId}::uuid and m.job_id = j.id
                          and (m.status = 'dismissed' or ${o.onlyNew ?? false}::boolean))
       and j.company_key not in (
             select j2.company_key from orbit.role_matches m join orbit_private.jobs j2 on j2.id = m.job_id
              where m.user_id = ${userId}::uuid and m.status = 'dismissed' and m.dismiss_reason = 'company')
     order by coalesce(j.posted_at, j.first_seen_at) desc
     limit ${o.limit ?? FILTER_LIMIT}::int`;
}

/** Stored roles by id, in no order. */
export function jobsById(db: Db, ids: string[]): Promise<JobRow[]> {
  if (!ids.length) return Promise.resolve([]);
  return db.query<JobRow>(`select ${JOB_COLUMNS} from orbit_private.jobs j where j.id = any($1::uuid[])`, [
    ids,
  ]);
}

/** The companies where the student knows someone: their people's current organisations, by company key. */
export async function warmCompanies(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db.sql<{ org: string }>`
    select distinct org_raw as org from orbit.people
     where user_id = ${userId}::uuid and not is_self and deleted_at is null and hidden_at is null
       and merged_into is null and org_raw is not null
     limit 5000`;
  const out = new Set<string>();
  for (const r of rows) {
    const k = normalizeCompany(r.org);
    if (k) out.add(k);
  }
  return out;
}

/** Step 2, the free rank, best first. */
export function rankJobs(rows: JobRow[], p: RoleProfile, warm: ReadonlySet<string>, now: Date) {
  const warmKeys = new Set(warm);
  const cands = rows.map((r) => ({
    row: r,
    id: r.id,
    title: r.title,
    titleKey: r.title_key,
    ...(r.team ? { team: r.team } : {}),
    ...(r.family ? { family: r.family } : {}),
    ...(r.level ? { level: r.level } : {}),
    places: r.places ?? [],
    ...(r.remote ? { remote: r.remote } : {}),
    // the board's key, or the same key the student's people are read with
    companyKey: warmKeys.has(normalizeCompany(r.company_name))
      ? normalizeCompany(r.company_name)
      : r.company_key,
    ...(r.posted_at ? { postedAt: iso(r.posted_at)! } : {}),
    firstSeenAt: iso(r.first_seen_at)!,
  }));
  return rankRoles(cands, {
    kinds: ticked(p).map((k) => ({ title: k.title, ...(k.family ? { family: k.family } : {}) })),
    levels: searchLevels(p),
    skills: p.skills.map((s) => s.name),
    places: p.wants.places,
    remote: p.wants.remote,
    warm: warmKeys,
    now,
  });
}

/**
 * Lists ranked roles as the search's to-read rows. A row already there keeps its status (saved, dismissed, applied);
 * one read against other evidence, or that failed, goes back to be read.
 */
export async function listMatches(
  db: Db,
  userId: string,
  searchId: string | null,
  ranked: { id: string; rank: number }[],
  evidenceHash: string,
): Promise<void> {
  if (!ranked.length) return;
  await db.sql`
    insert into orbit.role_matches (user_id, job_id, search_id, evidence_hash, state, rank)
    select ${userId}::uuid, x.job_id, ${searchId}::uuid, ${evidenceHash}, 'to_read', x.rank
      from unnest(${ranked.map((r) => r.id)}::uuid[], ${ranked.map((r) => r.rank)}::real[]) as x(job_id, rank)
    on conflict (user_id, job_id) do update set
      search_id = coalesce(excluded.search_id, orbit.role_matches.search_id),
      rank = excluded.rank,
      state = case when orbit.role_matches.evidence_hash <> excluded.evidence_hash
                     or orbit.role_matches.state = 'failed' then 'to_read'
                   else orbit.role_matches.state end,
      read_at = case when orbit.role_matches.evidence_hash <> excluded.evidence_hash
                       or orbit.role_matches.state = 'failed' then null
                     else orbit.role_matches.read_at end,
      evidence_hash = excluded.evidence_hash`;
}

// ---- the student's LinkedIn job search ---------------------------------------------------------------------------------

/** The student's own active LinkedIn account through Unipile, when there is one and Unipile is configured. */
export async function linkedinAccess(s: Services, userId: string): Promise<LinkedinJobAccess | undefined> {
  if (!s.env.unipileKey || !s.env.unipileBase) return undefined;
  const [acct] = await s.db.sql<{ id: string }>`
    select external_account_id as id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin' and status = 'active'
       and external_account_id is not null
     limit 1`;
  return acct ? { base: s.env.unipileBase, apiKey: s.env.unipileKey, accountId: acct.id } : undefined;
}

export const netOf = (s: Services): RoleNet => ({ fetch: s.fetch, now: s.now });

/**
 * One LinkedIn search per ticked kind (at most three) at the profile's level and place, each query once a day; the
 * results are kept through the source side's intake and returned as role ids to include in the filter.
 */
export async function linkedinRoles(
  s: Services,
  sources: RoleSources,
  userId: string,
  p: RoleProfile,
): Promise<{ ids: string[]; account: boolean; searched: number }> {
  const access = await linkedinAccess(s, userId);
  if (!access) return { ids: [], account: false, searched: 0 };
  const ids: string[] = [];
  let searched = 0;
  const day = s.now().toISOString().slice(0, 10);
  for (const k of ticked(p).slice(0, LINKEDIN_KINDS)) {
    const q: LinkedinJobQuery = {
      keywords: [k.title, p.wants.places[0]].filter(Boolean).join(' '),
      seniority: linkedinSeniority(p.level),
      ...(p.level === 'student' ? { jobType: ['internship'] as const } : {}),
      ...(p.wants.remote && !p.wants.places.length ? { presence: ['remote'] as const } : {}),
      datePosted: 30,
      limit: 25,
    } as LinkedinJobQuery;
    const queryKey = (await sha256Hex(JSON.stringify(q))).slice(0, 32);
    // once a day per query: a row from today means it was already run
    const [prev] = await s.db.sql<{ read_at: Date | string }>`
      select read_at from orbit.role_source_reads
       where user_id = ${userId}::uuid and source = 'linkedin' and query_key = ${queryKey}`;
    if (prev && iso(prev.read_at)!.slice(0, 10) === day) continue;
    // claimed before the call, so two searches at once cannot both run it
    const claimed = await s.db.sql`
      insert into orbit.role_source_reads (user_id, source, query_key, results, read_at)
      values (${userId}::uuid, 'linkedin', ${queryKey}, 0, ${s.now()}::timestamptz)
      on conflict (user_id, source, query_key) do update set read_at = excluded.read_at, results = 0
        where orbit.role_source_reads.read_at < ${`${day}T00:00:00Z`}::timestamptz
      returning 1`;
    if (!claimed.length) continue;
    searched++;
    try {
      const listings = await sources.linkedinSearch(netOf(s), access, q);
      if (!listings.length) continue;
      const kept = await sources.keep(s.db, listings);
      for (const j of kept) ids.push(j.id);
      await s.db.sql`
        update orbit.role_source_reads set results = ${kept.length}::int
         where user_id = ${userId}::uuid and source = 'linkedin' and query_key = ${queryKey}`;
    } catch {
      // a LinkedIn search that fails leaves the boards' roles; the query is tried again tomorrow
    }
  }
  return { ids, account: true, searched };
}
