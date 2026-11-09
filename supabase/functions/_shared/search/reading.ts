/**
 * search_reading (plan 33): LinkedIn About sections, job histories and company pages, read slowly for each student
 * with LinkedIn, and what Claude understood from them.
 *
 * A step does three things, each inside its own share of the account's LinkedIn ledgers (the counters orbit-connectors
 * keeps, public.orbit_proxy_counters), so a student's own reads always have the rest:
 *   1. company pages: companies their people work at now, most people first, by LinkedIn company id (from the census
 *      and from profiles already read). A company page is not a profile view and tells nobody; it has its own ledger.
 *      Pages are shared by every student (orbit_private.company_pages) and projected into company_facts.
 *   2. profiles: a few people at a time, founders, investors and close ties first, with `notify=false`. Their About
 *      fills people.summary where Orbit had none; their jobs land in orbit.profile_reads.
 *   3. reading: Claude (Haiku) reads what was fetched and writes stated stage, team size, focus and signals. Every
 *      fact must quote the text (core reading.ts); without Claude, plain patterns fill what they can.
 * The ask-time path (POST /search/read) runs the same code for named people with larger shares and no sleeps between
 * reads beyond a short jitter.
 */
import { orgKey } from '@orbit/core/search/companies';
import {
  ABOUT_CHARS,
  COMPANY_ABOUT_CHARS,
  COMPANY_ABOUT_KEEP,
  COMPANY_READING_SYSTEM,
  companyReadingText,
  JOB_CHARS,
  PERSON_READING_SYSTEM,
  personReadingText,
  type RawCompanyReading,
  type RawPersonReading,
  readByPattern,
  settleCompanyReading,
  settlePersonReading,
  withPatterns,
} from '@orbit/core/search/reading';
import type { ProfileExperienceWire, ProfileReadingWire } from '@orbit/core/server/api';
import { z } from 'zod/v4';
import type { Claude, ClaudeResult } from '../claude.ts';
import type { Db } from '../db.ts';

/** orbit-connectors DEFAULT_LEDGER: profile reads and company pages per account per day. */
export const LEDGER_TOTAL = { profile: 100, company: 150 } as const;
/** orbit-connectors LEDGER_CEILINGS.profile.reading / reading_ask and company.reading / reading_ask */
export const SHARES = {
  background: { profile: 0.3, company: 0.6 },
  ask: { profile: 0.6, company: 0.8 },
} as const;
export const READING_JOB_MS = 50_000;
export const PROFILES_PER_STEP = 6;
export const COMPANIES_PER_STEP = 15;
export const ASK_MAX = 6;
export const REREAD_DAYS = 180;
export const COMPANY_REREAD_DAYS = 90;
const READ_BATCH = 8;

export type Mode = 'background' | 'ask';
type LedgerKind = keyof typeof LEDGER_TOTAL;

export interface ReadingDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  claude?: Claude;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  clock: () => number;
}

export interface ReadingStep {
  companies: number;
  profiles: number;
  readPeople: number;
  readCompanies: number;
  stopped?: 'ledger' | 'time' | 'refused' | 'throttled';
  /** the people this step read or found fresh (the ask-time answer) */
  readIds: string[];
}

// ---- ledgers ----------------------------------------------------------------------------------------------------------

function bucket(kind: LedgerKind, accountId: string, now: Date, share: number) {
  const day = now.toISOString().slice(0, 10);
  const end = new Date(`${day}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    key: `connectors:li:${kind}:${day}:${accountId}`,
    limit: Math.round(LEDGER_TOTAL[kind] * share),
    expires: end.toISOString(),
  };
}

/** Takes one read from a ledger when the caller's share has room; peeks first so a refusal adds nothing. */
export async function spendRead(
  db: Db,
  kind: LedgerKind,
  accountId: string,
  now: Date,
  mode: Mode,
): Promise<boolean> {
  return spendShare(db, kind, accountId, now, SHARES[mode][kind]);
}

/** The same, for a caller with its own share of the day's ledger (orbit-worker logos.sweep, plan 35 B4). */
export async function spendShare(
  db: Db,
  kind: LedgerKind,
  accountId: string,
  now: Date,
  share: number,
): Promise<boolean> {
  const b = bucket(kind, accountId, now, share);
  const [used] = await db.sql<{ count: number }>`
    select count from public.orbit_proxy_counters where bucket = ${b.key} and expires_at >= now()`;
  if ((used?.count ?? 0) + 1 > b.limit) return false;
  const [row] = await db.sql<{ allowed: boolean }>`
    select allowed from public.orbit_proxy_take(${[b.key]}::text[], ${[b.limit]}::int[], ${[b.expires]}::timestamptz[])`;
  return !!row?.allowed;
}

// ---- shapes ---------------------------------------------------------------------------------------------------------

const txt = (v: unknown, n = 200) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : typeof v === 'number' ? String(v) : undefined;

/** Unipile's dates: "1/1/2025" (month/day/year), ISO, or {year, month}; as "YYYY-MM". */
export function dateOf(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const y = Number(o.year);
    if (!y) return undefined;
    const m = Number(o.month) || 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const y = /^(\d{4})$/.exec(s);
  return y ? `${y[1]}-01` : undefined;
}

/** A profile's jobs, newest first as LinkedIn lists them. A job with no end date is current. */
export function experienceOf(raw: unknown): ProfileExperienceWire[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileExperienceWire[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    const title = txt(e.position, 160);
    const company = txt(e.company, 160);
    if (!title && !company) continue;
    const end = dateOf(e.end);
    const job: ProfileExperienceWire = {
      current: typeof e.current === 'boolean' ? e.current : !end,
    };
    if (title) job.title = title;
    if (company) job.company = company;
    const cid = txt(e.company_id, 60);
    if (cid && /^\d+$/.test(cid)) job.companyId = cid;
    const start = dateOf(e.start);
    if (start) job.start = start;
    if (end) job.end = end;
    const desc = txt(e.description, JOB_CHARS);
    if (desc) job.description = desc;
    out.push(job);
    if (out.length >= 12) break;
  }
  return out;
}

export interface CompanyPage {
  linkedinId: string;
  publicIdentifier?: string;
  name: string;
  website?: string;
  industries: string[];
  tagline?: string;
  description?: string;
  employeeCount?: number;
  employeeRange?: string;
  growth6m?: number;
  growth12m?: number;
  growth24m?: number;
  foundedYear?: number;
  hq?: string;
}

/** `GET /linkedin/company/{id}` as Orbit keeps it (checked live 2026-11-07 on Ramp's page). */
export function pageOf(id: string, raw: Record<string, unknown>): CompanyPage | undefined {
  const name = txt(raw.name, 160);
  if (!name) return undefined;
  const ins = (raw.insights as Record<string, unknown> | undefined)?.employeesCount as
    | Record<string, unknown>
    | undefined;
  const growth = Array.isArray(ins?.growthGraph) ? (ins.growthGraph as Record<string, unknown>[]) : [];
  const g = (months: number) => {
    const v = growth.find((x) => Number(x.monthRange) === months)?.growthPercentage;
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
  };
  const range = raw.employee_count_range as { from?: number; to?: number } | undefined;
  const count =
    typeof raw.employee_count === 'number' ? raw.employee_count : Number(ins?.totalCount) || undefined;
  const founded = /(\d{4})/.exec(String(raw.foundation_date ?? ''))?.[1];
  const loc = Array.isArray(raw.locations)
    ? ((raw.locations as Record<string, unknown>[]).find((l) => l.is_headquarter) ??
      (raw.locations as Record<string, unknown>[])[0])
    : undefined;
  const industries = (Array.isArray(raw.industry) ? raw.industry : [raw.industry])
    .map((x) => txt(x, 80))
    .filter((x): x is string => !!x)
    .slice(0, 4);
  return {
    linkedinId: id,
    publicIdentifier: txt(raw.public_identifier, 160),
    name,
    website: txt(raw.website, 300),
    industries,
    tagline: txt(raw.tagline, 300),
    description: txt(raw.description, COMPANY_ABOUT_CHARS),
    employeeCount: count && count > 0 ? Math.round(count) : undefined,
    employeeRange: range?.from ? `${range.from}-${range.to ?? ''}` : undefined,
    growth6m: g(6),
    growth12m: g(12),
    growth24m: g(24),
    foundedYear: founded ? Number(founded) : undefined,
    hq: loc
      ? [txt(loc.city, 80), txt(loc.area, 80), txt(loc.country, 40)].filter(Boolean).join(', ')
      : undefined,
  };
}

// ---- fetching ---------------------------------------------------------------------------------------------------------

type Got<T> = { ok: true; value: T } | { ok: false; status: 'not_found' | 'refused' | 'throttled' };

async function getJson(deps: ReadingDeps, path: string): Promise<Got<Record<string, unknown>>> {
  const res = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}${path}`, {
    headers: { 'X-API-KEY': deps.apiKey, accept: 'application/json' },
  });
  if (res.status === 404 || res.status === 422) return { ok: false, status: 'not_found' };
  if (res.status === 429) return { ok: false, status: 'throttled' };
  if (res.status >= 400 && res.status < 500) return { ok: false, status: 'refused' };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  return { ok: true, value: (await res.json()) as Record<string, unknown> };
}

function profilePath(accountId: string, identifier: string): string {
  const q = new URLSearchParams({ account_id: accountId, notify: 'false' });
  // one parameter per section (a comma-joined list is refused)
  q.append('linkedin_sections', 'about');
  q.append('linkedin_sections', 'experience');
  return `/api/v1/users/${encodeURIComponent(identifier)}?${q}`;
}

// ---- storing ----------------------------------------------------------------------------------------------------------

export async function saveCompanyPage(db: Db, page: CompanyPage, now: Date): Promise<void> {
  await db.sql`
    insert into orbit_private.company_pages (linkedin_id, public_identifier, name, website, industries, tagline,
      description, employee_count, employee_range, growth_6m, growth_12m, growth_24m, founded_year, hq, status, read_at,
      reading, reading_at)
    values (${page.linkedinId}, ${page.publicIdentifier ?? null}, ${page.name}, ${page.website ?? null},
      ${page.industries}::text[], ${page.tagline ?? null}, ${page.description ?? null}, ${page.employeeCount ?? null},
      ${page.employeeRange ?? null}, ${page.growth6m ?? null}, ${page.growth12m ?? null}, ${page.growth24m ?? null},
      ${page.foundedYear ?? null}, ${page.hq ?? null}, 'ok', ${now.toISOString()}::timestamptz, null, null)
    on conflict (linkedin_id) do update set public_identifier = excluded.public_identifier, name = excluded.name,
      website = excluded.website, industries = excluded.industries, tagline = excluded.tagline,
      description = excluded.description, employee_count = excluded.employee_count,
      employee_range = excluded.employee_range, growth_6m = excluded.growth_6m, growth_12m = excluded.growth_12m,
      growth_24m = excluded.growth_24m, founded_year = excluded.founded_year, hq = excluded.hq, status = 'ok',
      read_at = excluded.read_at,
      -- a changed About is read again
      reading = case when company_pages.description is distinct from excluded.description then null else company_pages.reading end,
      reading_at = case when company_pages.description is distinct from excluded.description then null else company_pages.reading_at end`;
  await projectFact(db, page, undefined, now);
}

async function markCompany(db: Db, id: string, status: 'not_found' | 'refused', now: Date) {
  await db.sql`
    insert into orbit_private.company_pages (linkedin_id, name, status, read_at)
    values (${id}, ${id}, ${status}, ${now.toISOString()}::timestamptz)
    on conflict (linkedin_id) do update set status = excluded.status, read_at = excluded.read_at`;
}

/** The page as a 'linkedin' company fact, so every browser's facts include it. */
async function projectFact(
  db: Db,
  page: CompanyPage,
  reading: { stage?: string; stageEvidence?: string; kind?: string; what?: string } | undefined,
  now: Date,
): Promise<void> {
  const key = orgKey(page.name);
  if (!key) return;
  await db.sql`
    insert into orbit_private.company_facts (source, source_id, key, name, website, linkedin_handle, team_size,
      industries, one_liner, linkedin_id, founded_year, growth_12m, about, as_of, updated_at)
    values ('linkedin', ${page.linkedinId}, ${key}, ${page.name}, ${page.website ?? null},
      ${page.publicIdentifier ?? null}, ${page.employeeCount ?? null}, ${page.industries}::text[],
      ${reading?.what ?? page.tagline?.slice(0, 200) ?? null}, ${page.linkedinId}, ${page.foundedYear ?? null},
      ${page.growth12m ?? null}, ${page.description?.slice(0, COMPANY_ABOUT_KEEP) ?? null},
      ${now.toISOString().slice(0, 10)}::date, now())
    on conflict (source, source_id) do update set key = excluded.key, name = excluded.name, website = excluded.website,
      linkedin_handle = excluded.linkedin_handle, team_size = excluded.team_size, industries = excluded.industries,
      one_liner = coalesce(excluded.one_liner, company_facts.one_liner), linkedin_id = excluded.linkedin_id,
      founded_year = excluded.founded_year, growth_12m = excluded.growth_12m, about = excluded.about,
      as_of = excluded.as_of, updated_at = now()`;
  if (reading)
    await db.sql`
      update orbit_private.company_facts set stage = ${reading.stage ?? null},
        stage_evidence = ${reading.stageEvidence ?? null}, kind = ${reading.kind ?? null},
        one_liner = coalesce(${reading.what ?? null}, one_liner), updated_at = now()
       where source = 'linkedin' and source_id = ${page.linkedinId}`;
}

export async function saveProfile(
  db: Db,
  userId: string,
  personId: string,
  memberId: string,
  raw: Record<string, unknown>,
  mode: Mode,
  now: Date,
): Promise<void> {
  const about = txt(raw.summary, ABOUT_CHARS) ?? null;
  const experience = experienceOf(raw.work_experience);
  await db.sql`
    insert into orbit.profile_reads (user_id, person_id, member_id, about, experience, status, read_by, read_at,
      reading, reading_at, updated_at)
    values (${userId}::uuid, ${personId}::uuid, ${memberId}, ${about}, ${JSON.stringify(experience)}::jsonb, 'ok',
      ${mode}, ${now.toISOString()}::timestamptz, null, null, now())
    on conflict (user_id, person_id) do update set member_id = excluded.member_id, about = excluded.about,
      experience = excluded.experience, status = 'ok', read_by = excluded.read_by, read_at = excluded.read_at,
      reading = case when (profile_reads.about, profile_reads.experience) is distinct from (excluded.about, excluded.experience)
                     then null else profile_reads.reading end,
      reading_at = case when (profile_reads.about, profile_reads.experience) is distinct from (excluded.about, excluded.experience)
                        then null else profile_reads.reading_at end,
      updated_at = now()`;
  // the public text once for every student who has this person (plan 34 B1); a changed text drops the old reading
  await db.sql`
    insert into orbit_private.profile_pages (member_id, about, experience, status, read_at)
    values (${memberId}, ${about}, ${JSON.stringify(experience)}::jsonb, 'ok', ${now.toISOString()}::timestamptz)
    on conflict (member_id) do update set about = excluded.about, experience = excluded.experience, status = 'ok',
      read_at = excluded.read_at,
      reading = case when (profile_pages.about, profile_pages.experience) is distinct from (excluded.about, excluded.experience)
                     then null else profile_pages.reading end,
      reading_model = case when (profile_pages.about, profile_pages.experience) is distinct from (excluded.about, excluded.experience)
                     then null else profile_pages.reading_model end,
      reading_at = case when (profile_pages.about, profile_pages.experience) is distinct from (excluded.about, excluded.experience)
                        then null else profile_pages.reading_at end`;
  await fillSummary(db, userId, personId, about);
}

/** Their About where Orbit had none (an About the student or another source wrote is never replaced). */
async function fillSummary(db: Db, userId: string, personId: string, about: string | null): Promise<void> {
  if (about)
    await db.sql`
      update orbit.people set summary = ${about}, updated_at = now()
       where id = ${personId}::uuid and user_id = ${userId}::uuid and (summary is null or summary = '')`;
}

/**
 * The profile as another student's read left it, when that read is under REREAD_DAYS old: copied into this student's
 * profile_reads with its reading, and no LinkedIn request. False when there is no such read.
 */
export async function copySharedProfile(
  db: Db,
  userId: string,
  personId: string,
  memberId: string,
  mode: Mode,
  now: Date,
): Promise<boolean> {
  const [page] = await db.sql<{
    about: string | null;
    experience: ProfileExperienceWire[];
    read_at: string;
    reading: ProfileReadingWire | null;
    reading_model: string | null;
    reading_at: string | null;
  }>`
    select about, experience, read_at::text as read_at, reading, reading_model, reading_at::text as reading_at
      from orbit_private.profile_pages
     where member_id = ${memberId} and status = 'ok'
       and read_at > ${now.toISOString()}::timestamptz - make_interval(days => ${REREAD_DAYS})`;
  if (!page) return false;
  await db.sql`
    insert into orbit.profile_reads (user_id, person_id, member_id, about, experience, status, read_by, read_at,
      reading, reading_model, reading_at, updated_at)
    values (${userId}::uuid, ${personId}::uuid, ${memberId}, ${page.about}, ${JSON.stringify(page.experience ?? [])}::jsonb,
      'ok', ${mode}, ${page.read_at}::timestamptz,
      ${page.reading === null ? null : JSON.stringify(page.reading)}::jsonb, ${page.reading_model},
      ${page.reading_at}::timestamptz, now())
    on conflict (user_id, person_id) do update set member_id = excluded.member_id, about = excluded.about,
      experience = excluded.experience, status = 'ok', read_by = excluded.read_by, read_at = excluded.read_at,
      reading = excluded.reading, reading_model = excluded.reading_model, reading_at = excluded.reading_at,
      updated_at = now()`;
  await fillSummary(db, userId, personId, page.about);
  return true;
}

async function markProfile(
  db: Db,
  userId: string,
  personId: string,
  memberId: string,
  status: 'not_found' | 'refused',
  mode: Mode,
  now: Date,
) {
  await db.sql`
    insert into orbit.profile_reads (user_id, person_id, member_id, status, read_by, read_at, reading_at, updated_at)
    values (${userId}::uuid, ${personId}::uuid, ${memberId}, ${status}, ${mode}, ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz, now())
    on conflict (user_id, person_id) do update set status = excluded.status, read_at = excluded.read_at,
      updated_at = now()`;
}

// ---- choosing -----------------------------------------------------------------------------------------------------

/** How long a request keeps a profile on the background reading's list (orbit.reading_candidates). */
export const REQUEST_DAYS = 7;

/**
 * Mark profiles as wanted (plan 35 B6): a network search's read or labels, a Map target, an opened person page. The
 * background reading takes only these (and the 50 closest once). Best effort: a failure here never fails the caller.
 */
export async function requestReads(db: Db, userId: string, personIds: readonly string[]): Promise<void> {
  const ids = [...new Set(personIds.filter(Boolean))].slice(0, 200);
  if (!ids.length) return;
  try {
    await db.sql`
      insert into orbit.profile_requests (user_id, person_id, requested_at)
      select ${userId}::uuid, p.id, now() from orbit.people p
       where p.user_id = ${userId}::uuid and p.id = any(${ids}::uuid[])
      on conflict (user_id, person_id) do update set requested_at = excluded.requested_at`;
  } catch (e) {
    console.log(
      JSON.stringify({ fn: 'requestReads', error: String((e as Error)?.message ?? e).slice(0, 200) }),
    );
  }
}

export type Candidate = {
  id: string;
  member: string;
  name: string;
  headline: string | null;
};

/**
 * Who to read next (plan 35 B6): only people someone asked about in the last 7 days (orbit.profile_requests) and, once,
 * the 50 closest never read (orbit.reading_candidates, the same set the cron checks before queueing a step). Among
 * them founders, investors and leaders first, then the closest ties, then the most recent.
 */
export async function pickPeople(db: Db, userId: string, n: number): Promise<Candidate[]> {
  return db.sql<Candidate>`
    select p.id, coalesce(p.linkedin_member_id, p.linkedin_slug) as member, p.display_name as name, p.headline
      from orbit.reading_candidates(${userId}::uuid) c
      join orbit.people p on p.id = c.person_id
     order by (coalesce(p.headline, '') ~* '(founder|ceo|cto|coo|building|stealth|partner|investor|\\mvc\\M|angel|principal|head of|director|\\mvp\\M)')::int desc,
              coalesce(p.strength, 0) desc, p.last_interaction_at desc nulls last
     limit ${n}`;
}

/** Named people (the ask-time path), skipping any read in the last REREAD_DAYS. */
async function namedPeople(
  db: Db,
  userId: string,
  ids: string[],
): Promise<{ todo: Candidate[]; fresh: string[] }> {
  const rows = await db.sql<Candidate & { read_at: string | null }>`
    select p.id, coalesce(p.linkedin_member_id, p.linkedin_slug) as member, p.display_name as name, p.headline,
           r.read_at::text as read_at
      from orbit.people p
      left join orbit.profile_reads r on r.user_id = p.user_id and r.person_id = p.id
     where p.user_id = ${userId}::uuid and p.id = any(${ids}::uuid[]) and p.deleted_at is null
       and coalesce(p.linkedin_member_id, p.linkedin_slug) is not null`;
  const cutoff = Date.now() - REREAD_DAYS * 86_400_000;
  const fresh = rows.filter((r) => r.read_at && Date.parse(r.read_at) > cutoff).map((r) => r.id);
  return { todo: rows.filter((r) => !fresh.includes(r.id)), fresh };
}

/** Company pages wanted: where the student's people work now, most people first, unread or stale. */
export async function wantedCompanies(
  db: Db,
  userId: string,
  n: number,
  personIds?: string[],
): Promise<string[]> {
  const rows = await db.sql<{ id: string }>`
    with refs as (
      select f.ref as id, count(*) as n from orbit.facet_assertions f
       where f.user_id = ${userId}::uuid and f.kind = 'company' and f.positive and f.ref is not null
         and (${personIds ?? null}::uuid[] is null or f.person_id = any(${personIds ?? null}::uuid[]))
       group by 1
      union all
      select e->>'companyId' as id, count(*) as n from orbit.profile_reads r, jsonb_array_elements(r.experience) e
       where r.user_id = ${userId}::uuid and (e->>'current')::boolean and e->>'companyId' is not null
         and (${personIds ?? null}::uuid[] is null or r.person_id = any(${personIds ?? null}::uuid[]))
       group by 1
    )
    select r.id from refs r
      left join orbit_private.company_pages c on c.linkedin_id = r.id
     where c.linkedin_id is null or c.read_at < now() - make_interval(days => ${COMPANY_REREAD_DAYS})
     group by r.id order by sum(r.n) desc, r.id
     limit ${n}`;
  return rows.map((r) => r.id);
}

// ---- reading ------------------------------------------------------------------------------------------------------

const personSchema = z.object({
  people: z.array(
    z.object({
      person: z.string(),
      facts: z.array(
        z.object({
          kind: z.enum(['stage', 'team_size', 'focus', 'signal']),
          value: z.string(),
          company: z.string(),
          quote: z.string(),
        }),
      ),
    }),
  ),
});

const companySchema = z.object({
  companies: z.array(
    z.object({
      company: z.string(),
      stage: z.string(),
      quote: z.string(),
      kind: z.string(),
      what: z.string(),
    }),
  ),
});

const block = (tag: string, id: string, text: string) =>
  `<${tag} id="${id}">\n${text.replace(new RegExp(`</?${tag}[^>]*>`, 'gi'), '')}\n</${tag}>`;

function rawOf(facts: z.infer<typeof personSchema>['people'][number]['facts']): RawPersonReading {
  const raw: RawPersonReading = { focus: [], signals: [] };
  for (const f of facts) {
    const company = f.company.trim() || null;
    if (f.kind === 'stage' && !raw.stage) raw.stage = { value: f.value, company, quote: f.quote };
    else if (f.kind === 'team_size' && !raw.team_size) {
      const n = Number(f.value.replace(/[^\d]/g, ''));
      if (n) raw.team_size = { value: n, company, quote: f.quote };
    } else if (f.kind === 'focus') raw.focus!.push({ value: f.value, quote: f.quote });
    else if (f.kind === 'signal') raw.signals!.push({ value: f.value.trim().toLowerCase(), quote: f.quote });
  }
  return raw;
}

type Unread = {
  person_id: string;
  member_id: string | null;
  name: string;
  headline: string | null;
  about: string | null;
  experience: ProfileExperienceWire[];
};

/** How a reading pass asks Claude: now, or through Message Batches when it can (the background step; plan 35 C2). */
export interface ReadOpts {
  batch?: boolean;
}

/** The ids of a batch's part as a dedupe key: the same people are never in two waiting requests. */
const partKey = (kind: string, owner: string | null, ids: string[]) =>
  `${kind}:${owner ?? 'all'}:${[...ids].sort().join(',')}`;

const peopleRequest = (userId: string, texts: string[], worth: boolean[]) => ({
  task: 'reading' as const,
  system: PERSON_READING_SYSTEM,
  user: texts
    .map((t, k) => (worth[k] ? block('person', `P${k + 1}`, t) : ''))
    .filter(Boolean)
    .join('\n\n'),
  schema: personSchema,
  userId,
});

const peopleTexts = (part: Unread[]) => ({
  texts: part.map((r) =>
    personReadingText({
      name: r.name,
      headline: r.headline ?? undefined,
      about: r.about ?? undefined,
      experience: r.experience ?? [],
    }),
  ),
  // nothing of their own words to read: the pattern pass alone (an empty reading), no model call
  worth: part.map((r) => !!r.about || (r.experience ?? []).some((e) => e.description)),
});

/** Reads what was fetched and not read yet (Claude when it can, plain patterns when it cannot). */
export async function readPeople(
  db: Db,
  claude: Claude | undefined,
  userId: string,
  limit: number,
  personIds?: string[],
  opts: ReadOpts = {},
): Promise<number> {
  // a background pass leaves people whose reading is waiting in a batch to it; a student asking reads them now
  const rows = await db.sql<Unread>`
    select r.person_id, r.member_id, p.display_name as name, p.headline, r.about, r.experience
      from orbit.profile_reads r join orbit.people p on p.id = r.person_id
     where r.user_id = ${userId}::uuid and r.reading_at is null and r.status = 'ok'
       and (${personIds ?? null}::uuid[] is null or r.person_id = any(${personIds ?? null}::uuid[]))
       and (${!opts.batch}::boolean or not exists (select 1 from orbit.claude_batch_requests b
                        where b.user_id = r.user_id and b.handler = 'reading.people'
                          and b.status in ('queued', 'submitted') and b.payload->'personIds' ? r.person_id::text))
     order by r.read_at
     limit ${limit}`;
  let n = 0;
  for (let i = 0; i < rows.length; i += READ_BATCH) {
    const part = rows.slice(i, i + READ_BATCH);
    const { texts, worth } = peopleTexts(part);
    let res: ClaudeResult<z.infer<typeof personSchema>> | undefined;
    if (claude?.configured && worth.some(Boolean)) {
      const request = peopleRequest(userId, texts, worth);
      if (opts.batch && claude.structuredBatch && claude.batching) {
        const ids = part.map((r) => r.person_id);
        const q = await claude.structuredBatch(request, {
          handler: 'reading.people',
          payload: { personIds: ids },
          dedupeKey: partKey('reading.people', userId, ids),
        });
        if (q.queued || q.reason === 'duplicate') continue;
      }
      res = await claude.structured(request);
      // over the student's Claude budget today: leave them unread for a later step
      if (!res.ok && 'budgetExceeded' in res) return n;
    }
    n += await writePeople(
      db,
      userId,
      part.map((r, k) => ({ row: r, text: texts[k]! })),
      res,
    );
  }
  return n;
}

/**
 * A batched reading's answer (batchJobs.ts): the people of the part in the order they were asked, those still
 * unread written with the model's reading (P1 is the first asked, whoever has been read since).
 */
export async function readPeopleFromBatch(
  db: Db,
  userId: string,
  personIds: string[],
  answer: (schema: typeof personSchema) => Promise<ClaudeResult<z.infer<typeof personSchema>>>,
): Promise<number> {
  const res = await answer(personSchema);
  if (!res.ok && 'budgetExceeded' in res) return 0;
  const rows = await db.sql<Unread>`
    select r.person_id, r.member_id, p.display_name as name, p.headline, r.about, r.experience
      from orbit.profile_reads r join orbit.people p on p.id = r.person_id
     where r.user_id = ${userId}::uuid and r.reading_at is null and r.status = 'ok'
       and r.person_id = any(${personIds}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.person_id, r]));
  const slots = personIds.map((id) => byId.get(id));
  const { texts } = peopleTexts(slots.filter((r): r is Unread => !!r));
  let t = 0;
  const part = slots.map((r) => (r ? { row: r, text: texts[t++]! } : undefined));
  return writePeople(db, userId, part, res);
}

async function writePeople(
  db: Db,
  userId: string,
  part: ({ row: Unread; text: string } | undefined)[],
  res: ClaudeResult<z.infer<typeof personSchema>> | undefined,
): Promise<number> {
  let model: Map<number, RawPersonReading> | undefined;
  let modelName: string | null = null;
  if (res?.ok) {
    modelName = res.model;
    model = new Map();
    for (const p of res.data.people) {
      const k = Number(/(\d+)/.exec(p.person)?.[1] ?? 0) - 1;
      if (k >= 0 && k < part.length) model.set(k, rawOf(p.facts));
    }
  }
  let n = 0;
  for (let k = 0; k < part.length; k++) {
    const one = part[k];
    if (!one) continue;
    const { row, text } = one;
    const reading: ProfileReadingWire = withPatterns(
      settlePersonReading(model?.get(k), text),
      readByPattern(text),
    );
    await db.sql`
      update orbit.profile_reads set reading = ${JSON.stringify(reading)}::jsonb, reading_model = ${modelName},
        reading_at = now(), updated_at = now()
       where user_id = ${userId}::uuid and person_id = ${row.person_id}::uuid`;
    // the same text gives the same reading: kept on the shared page for the next student (plan 34 B1)
    if (row.member_id && modelName)
      await db.sql`
        update orbit_private.profile_pages set reading = ${JSON.stringify(reading)}::jsonb,
          reading_model = ${modelName}, reading_at = now()
         where member_id = ${row.member_id} and about is not distinct from ${row.about}
           and experience = ${JSON.stringify(row.experience ?? [])}::jsonb`;
    n++;
  }
  return n;
}

type CompanyRow = {
  linkedin_id: string;
  public_identifier: string | null;
  name: string;
  website: string | null;
  industries: string[];
  tagline: string | null;
  description: string | null;
  employee_count: number | null;
  growth_12m: number | null;
  founded_year: number | null;
};

const companyTexts = (part: CompanyRow[]) => ({
  texts: part.map((c) =>
    companyReadingText({
      name: c.name,
      tagline: c.tagline ?? undefined,
      about: c.description ?? undefined,
    }),
  ),
  worth: part.map((c) => !!c.description || !!c.tagline),
});

export async function readCompanies(
  db: Db,
  claude: Claude | undefined,
  userId: string | null,
  limit: number,
  now: Date,
  opts: ReadOpts = {},
): Promise<number> {
  const rows = await db.sql<CompanyRow>`
    select linkedin_id, public_identifier, name, website, industries, tagline, description, employee_count,
           growth_12m, founded_year
      from orbit_private.company_pages c
     where reading_at is null and status = 'ok'
       and (${!opts.batch}::boolean or not exists (select 1 from orbit.claude_batch_requests b
                        where b.handler = 'reading.companies' and b.status in ('queued', 'submitted')
                          and b.payload->'linkedinIds' ? c.linkedin_id))
     order by read_at limit ${limit}`;
  let n = 0;
  for (let i = 0; i < rows.length; i += READ_BATCH) {
    const part = rows.slice(i, i + READ_BATCH);
    const { texts, worth } = companyTexts(part);
    let res: ClaudeResult<z.infer<typeof companySchema>> | undefined;
    if (claude?.configured && worth.some(Boolean)) {
      const request = {
        task: 'reading' as const,
        system: COMPANY_READING_SYSTEM,
        user: part
          .map((_, k) => (worth[k] ? block('company', `C${k + 1}`, texts[k]!) : ''))
          .filter(Boolean)
          .join('\n\n'),
        schema: companySchema,
        userId,
      };
      if (opts.batch && claude.structuredBatch && claude.batching) {
        const ids = part.map((c) => c.linkedin_id);
        const q = await claude.structuredBatch(request, {
          handler: 'reading.companies',
          payload: { linkedinIds: ids },
          dedupeKey: partKey('reading.companies', null, ids),
        });
        if (q.queued || q.reason === 'duplicate') continue;
      }
      res = await claude.structured(request);
      if (!res.ok && 'budgetExceeded' in res) return n;
    }
    n += await writeCompanies(
      db,
      part.map((c, k) => ({ row: c, text: texts[k]! })),
      res,
      now,
    );
  }
  return n;
}

/** A batched company reading's answer (batchJobs.ts), as readPeopleFromBatch. */
export async function readCompaniesFromBatch(
  db: Db,
  linkedinIds: string[],
  answer: (schema: typeof companySchema) => Promise<ClaudeResult<z.infer<typeof companySchema>>>,
  now: Date,
): Promise<number> {
  const res = await answer(companySchema);
  if (!res.ok && 'budgetExceeded' in res) return 0;
  const rows = await db.sql<CompanyRow>`
    select linkedin_id, public_identifier, name, website, industries, tagline, description, employee_count,
           growth_12m, founded_year
      from orbit_private.company_pages
     where reading_at is null and status = 'ok' and linkedin_id = any(${linkedinIds}::text[])`;
  const byId = new Map(rows.map((r) => [r.linkedin_id, r]));
  const slots = linkedinIds.map((id) => byId.get(id));
  const { texts } = companyTexts(slots.filter((r): r is CompanyRow => !!r));
  let t = 0;
  const part = slots.map((r) => (r ? { row: r, text: texts[t++]! } : undefined));
  return writeCompanies(db, part, res, now);
}

async function writeCompanies(
  db: Db,
  part: ({ row: CompanyRow; text: string } | undefined)[],
  res: ClaudeResult<z.infer<typeof companySchema>> | undefined,
  now: Date,
): Promise<number> {
  const raw = new Map<number, RawCompanyReading>();
  if (res?.ok)
    for (const c of res.data.companies) {
      const k = Number(/(\d+)/.exec(c.company)?.[1] ?? 0) - 1;
      if (k >= 0 && k < part.length)
        raw.set(k, {
          stage: c.stage.trim() ? { value: c.stage, quote: c.quote } : null,
          kind: c.kind.trim() || null,
          what: c.what.trim() || null,
        });
    }
  let n = 0;
  for (let k = 0; k < part.length; k++) {
    const one = part[k];
    if (!one) continue;
    const c = one.row;
    const r = settleCompanyReading(raw.get(k), one.text);
    await db.sql`
      update orbit_private.company_pages set reading = ${JSON.stringify(r)}::jsonb, reading_at = now()
       where linkedin_id = ${c.linkedin_id}`;
    await projectFact(
      db,
      {
        linkedinId: c.linkedin_id,
        publicIdentifier: c.public_identifier ?? undefined,
        name: c.name,
        website: c.website ?? undefined,
        industries: c.industries ?? [],
        tagline: c.tagline ?? undefined,
        description: c.description ?? undefined,
        employeeCount: c.employee_count ?? undefined,
        growth12m: c.growth_12m ?? undefined,
        foundedYear: c.founded_year ?? undefined,
      },
      r,
      now,
    );
    n++;
  }
  return n;
}

// ---- one step -----------------------------------------------------------------------------------------------------

async function readCompanyIds(
  db: Db,
  deps: ReadingDeps,
  accountId: string,
  ids: string[],
  now: Date,
  mode: Mode,
  step: ReadingStep,
  started: number,
  budgetMs: number,
): Promise<void> {
  for (const id of ids) {
    if (deps.clock() - started > budgetMs) {
      step.stopped = 'time';
      return;
    }
    if (!(await spendRead(db, 'company', accountId, now, mode))) {
      step.stopped = 'ledger';
      return;
    }
    if (step.companies > 0)
      await deps.sleep((mode === 'ask' ? 200 : 1200) + Math.floor(deps.random() * 1500));
    const got = await getJson(
      deps,
      `/api/v1/linkedin/company/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`,
    );
    if (!got.ok) {
      if (got.status === 'throttled') {
        step.stopped = 'throttled';
        return;
      }
      await markCompany(db, id, got.status, now);
      continue;
    }
    const page = pageOf(id, got.value);
    if (page) await saveCompanyPage(db, page, now);
    else await markCompany(db, id, 'not_found', now);
    step.companies++;
  }
}

async function readProfiles(
  db: Db,
  deps: ReadingDeps,
  userId: string,
  accountId: string,
  people: Candidate[],
  now: Date,
  mode: Mode,
  step: ReadingStep,
  started: number,
  budgetMs: number,
): Promise<void> {
  let fetched = 0;
  for (const p of people) {
    if (deps.clock() - started > budgetMs) {
      step.stopped = 'time';
      return;
    }
    // another student read this profile lately: their copy, with no LinkedIn request (plan 34 B1)
    if (await copySharedProfile(db, userId, p.id, p.member, mode, now)) {
      step.profiles++;
      step.readIds.push(p.id);
      continue;
    }
    if (!(await spendRead(db, 'profile', accountId, now, mode))) {
      step.stopped = 'ledger';
      return;
    }
    if (fetched++ > 0) await deps.sleep((mode === 'ask' ? 300 : 2500) + Math.floor(deps.random() * 2500));
    const got = await getJson(deps, profilePath(accountId, p.member));
    if (!got.ok) {
      if (got.status === 'throttled') {
        step.stopped = 'throttled';
        return;
      }
      await markProfile(db, userId, p.id, p.member, got.status, mode, now);
      continue;
    }
    await saveProfile(db, userId, p.id, p.member, got.value, mode, now);
    step.profiles++;
    step.readIds.push(p.id);
  }
}

/**
 * One step. Background: company pages first (cheap, shared, they answer size and stage for everyone at a company),
 * then a few profiles, then the reading. Ask: the named people's profiles, their current companies' pages, and the
 * reading of just them.
 */
export async function runReadingStep(
  db: Db,
  deps: ReadingDeps,
  userId: string,
  accountId: string,
  now: Date,
  opts: { mode?: Mode; personIds?: string[]; budgetMs?: number } = {},
): Promise<ReadingStep> {
  const mode = opts.mode ?? 'background';
  const budgetMs = opts.budgetMs ?? READING_JOB_MS;
  const started = deps.clock();
  const step: ReadingStep = { companies: 0, profiles: 0, readPeople: 0, readCompanies: 0, readIds: [] };
  if (mode === 'ask') {
    const ids = (opts.personIds ?? []).slice(0, ASK_MAX);
    const { todo, fresh } = await namedPeople(db, userId, ids);
    step.readIds.push(...fresh);
    // most of the time for the profiles, the rest for their companies and the reading
    await readProfiles(db, deps, userId, accountId, todo, now, mode, step, started, budgetMs * 0.6);
    const companies = await wantedCompanies(db, userId, ASK_MAX, ids);
    if (step.stopped !== 'throttled')
      await readCompanyIds(db, deps, accountId, companies, now, mode, step, started, budgetMs * 0.8);
    step.readPeople = await readPeople(db, deps.claude, userId, ASK_MAX, ids);
    step.readCompanies = await readCompanies(db, deps.claude, userId, ASK_MAX, now);
    return step;
  }
  const companies = await wantedCompanies(db, userId, COMPANIES_PER_STEP);
  await readCompanyIds(db, deps, accountId, companies, now, mode, step, started, budgetMs * 0.4);
  const stoppedAtCompanies = step.stopped;
  step.stopped = undefined;
  if (stoppedAtCompanies !== 'throttled') {
    const people = await pickPeople(db, userId, PROFILES_PER_STEP);
    await readProfiles(db, deps, userId, accountId, people, now, mode, step, started, budgetMs * 0.75);
  }
  step.stopped ??= stoppedAtCompanies;
  // the background step waits on nobody: its readings go through Message Batches when they can (plan 35 C2)
  step.readPeople = await readPeople(db, deps.claude, userId, 24, undefined, { batch: true });
  step.readCompanies = await readCompanies(db, deps.claude, userId, 24, now, { batch: true });
  return step;
}
