/**
 * Plan 44 §5: a search is a job, not one long request.
 *
 *   startSearch  filter, rank, list the top 60 as to be read, answer at once with what is already read. Three full
 *                searches a day per student; after that the stored results, with a note. A change of wants only
 *                (places, kinds, chips, eligibility) is not a full search: it re-filters and re-ranks, and rows read
 *                against the same evidence are scored again in code, with no model call.
 *   more         reads the next 15 closely (three model calls of five, side by side) and returns them
 *   list         what is stored, free: the matches, or Saved
 *   scoreOne     one posting by link or pasted text, scored now
 *   act          save, dismiss with a reason, applied, interviewing; watch a company
 *   topup        the nightly job: at most 20 new roles read for one student's current profile
 *
 * When the model is off or a limit is reached, rows come back with the parts Orbit can read without it and the note
 * "Not read closely yet", never a number.
 */

import type {
  DismissReason,
  JobListing,
  MatchStatus,
  RoleMatch,
  RolesActResponse,
  RolesCoverage,
  RolesListResponse,
  RolesScoreRequest,
  RolesScoreResponse,
  RolesSearchResponse,
} from '../../../../packages/core/src/roles/types.ts';
import { normalizeCompany } from '../../../../packages/core/src/text/normalize.ts';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { badRequest, HttpError } from '../http.ts';
import type { Services } from '../services.ts';
import {
  filterRoles,
  jobOf,
  jobsById,
  LIST_SIZE,
  linkedinAccess,
  linkedinRoles,
  listMatches,
  netOf,
  rankJobs,
  warmCompanies,
} from './candidates.ts';
import { loadProfile, plain, type StoredProfile } from './profile.ts';
import {
  claimRows,
  LIMIT_NOTE,
  MATCH_COLUMNS,
  type MatchRow,
  matchOf,
  NOT_READ_NOTE,
  READS_PER_DAY,
  type RolesDeps,
  readRows,
  readsToday,
  refit,
} from './score.ts';

export const SEARCHES_PER_DAY = 3;
export const MORE_SIZE = 15;
export const TOPUP_SIZE = 20;
export const SEARCHES_USED_NOTE =
  'You have run three searches today. These are your latest results, and more are read tonight.';
export const PROFILE_CHANGED_NOTE = 'Your profile changed. Run the search again to read roles against it.';
export const NO_PROFILE = 'Read your resume or LinkedIn profile first, so Orbit has something to match.';

type SearchRow = {
  id: string;
  evidence_hash: string;
  wants_hash: string;
  status: 'reading' | 'done' | 'failed' | 'dropped';
  listed: number;
  read: number;
  sources: { full?: boolean; linkedin?: boolean };
  created_at: Date | string;
};

const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

async function needProfile(db: Db, userId: string): Promise<StoredProfile> {
  const p = await loadProfile(db, userId);
  if (!p) throw new HttpError(409, 'no_profile', NO_PROFILE);
  return p;
}

async function latestSearch(db: Db, userId: string): Promise<SearchRow | undefined> {
  const [r] = await db.sql<SearchRow>`
    select id::text as id, evidence_hash, wants_hash, status, listed, read, sources, created_at
      from orbit.role_searches where user_id = ${userId}::uuid order by created_at desc, id desc limit 1`;
  return r;
}

export async function coverageOf(db: Db, linkedin: boolean): Promise<RolesCoverage> {
  const [r] = await db.sql<{ boards: number; roles: number; simplify: boolean }>`
    select (select count(*)::int from orbit_private.job_boards where status = 'active') as boards,
           (select count(*)::int from orbit_private.jobs where closed_at is null and dupe_of is null
                                                          and source <> 'linkedin') as roles,
           exists (select 1 from orbit_private.jobs where source = 'simplify' and closed_at is null) as simplify`;
  return { boards: r?.boards ?? 0, roles: r?.roles ?? 0, linkedin, simplify: !!r?.simplify };
}

/** Rows of the student's, with their roles, in the order asked. */
async function matchesWhere(
  db: Db,
  userId: string,
  where: {
    searchId?: string;
    read?: boolean;
    statuses?: MatchStatus[];
    evidenceHash?: string;
    open?: boolean;
  },
): Promise<{ row: MatchRow; closed: boolean }[]> {
  const rows = await db.query<MatchRow & { closed: boolean }>(
    `select ${MATCH_COLUMNS}, j.closed_at is not null as closed
       from orbit.role_matches m join orbit_private.jobs j on j.id = m.job_id
      where m.user_id = $1::uuid
        and ($2::uuid is null or m.search_id = $2::uuid)
        and (not $3::boolean or (m.state = 'read' and m.evidence_hash = $4))
        and (cardinality($5::text[]) = 0 or m.status = any($5::text[]))
        and (cardinality($5::text[]) > 0 or m.status <> 'dismissed')
        and (not $6::boolean or j.closed_at is null)
      order by m.fit desc nulls last, m.rank desc, m.id
      limit 500`,
    [
      userId,
      where.searchId ?? null,
      where.read ?? false,
      where.evidenceHash ?? '',
      where.statuses ?? [],
      where.open ?? false,
    ],
  );
  return rows.map((row) => ({ row, closed: row.closed }));
}

async function withJobs(
  db: Db,
  rows: { row: MatchRow }[],
  current: { evidenceHash: string; profile?: StoredProfile['profile'] },
): Promise<RoleMatch[]> {
  const jobs = new Map(
    (
      await jobsById(
        db,
        rows.map((r) => r.row.job_id),
      )
    ).map((j) => [j.id, jobOf(j)]),
  );
  return rows.flatMap(({ row }) => {
    const job = jobs.get(row.job_id);
    return job ? [matchOf(row, job, current)] : [];
  });
}

async function counts(db: Db, searchId: string, evidenceHash: string) {
  const [c] = await db.sql<{ listed: number; read: number; left: number }>`
    select count(*)::int as listed,
           count(*) filter (where state = 'read' and evidence_hash = ${evidenceHash})::int as read,
           count(*) filter (where state = 'to_read' and status <> 'dismissed')::int as left
      from orbit.role_matches where search_id = ${searchId}::uuid`;
  return c ?? { listed: 0, read: 0, left: 0 };
}

async function respond(
  s: Services,
  userId: string,
  search: SearchRow,
  stored: StoredProfile,
  extra: { matches?: RoleMatch[]; note?: string } = {},
): Promise<RolesSearchResponse> {
  const c = await counts(s.db, search.id, stored.evidenceHash);
  const done = c.left === 0;
  if (done && search.status === 'reading')
    await s.db.sql`update orbit.role_searches set status = 'done', read = ${c.read}::int
                    where id = ${search.id}::uuid and status = 'reading'`;
  else await s.db.sql`update orbit.role_searches set read = ${c.read}::int where id = ${search.id}::uuid`;
  let matches = extra.matches;
  let note = extra.note;
  if (!matches) {
    matches = await withJobs(
      s.db,
      await matchesWhere(s.db, userId, {
        searchId: search.id,
        read: true,
        evidenceHash: stored.evidenceHash,
        open: true,
      }),
      { evidenceHash: stored.evidenceHash },
    );
    // the model is off: every listed role with the parts Orbit can read without it
    if (!s.claude.configured && !done) {
      const rough = await withJobs(
        s.db,
        (await matchesWhere(s.db, userId, { searchId: search.id, open: true })).filter(
          (r) => r.row.state === 'to_read',
        ),
        { evidenceHash: stored.evidenceHash, profile: stored.profile },
      );
      matches = [...matches, ...rough];
      note ??= NOT_READ_NOTE;
    }
  }
  return {
    searchId: search.id,
    matches,
    listed: c.listed,
    read: c.read,
    done: done || !s.claude.configured,
    coverage: await coverageOf(s.db, !!search.sources?.linkedin),
    ...(note ? { note } : {}),
  };
}

/** POST /roles/search (§5). */
export async function startSearch(
  s: Services,
  deps: RolesDeps,
  userId: string,
  req: { fresh?: boolean } = {},
): Promise<RolesSearchResponse> {
  const stored = await needProfile(s.db, userId);
  const now = s.now();
  const latest = await latestSearch(s.db, userId);
  const sameDay = latest && new Date(latest.created_at).getTime() >= dayStart(now).getTime();
  if (
    !req.fresh &&
    latest &&
    latest.status !== 'dropped' &&
    latest.evidence_hash === stored.evidenceHash &&
    latest.wants_hash === stored.wantsHash &&
    sameDay
  )
    return respond(s, userId, latest, stored);
  const full = !latest || latest.evidence_hash !== stored.evidenceHash || !!req.fresh;
  if (full) {
    const [c] = await s.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.role_searches
       where user_id = ${userId}::uuid and created_at >= ${dayStart(now)}::timestamptz
         and coalesce((sources->>'full')::boolean, false)`;
    if ((c?.n ?? 0) >= SEARCHES_PER_DAY && latest)
      return respond(s, userId, latest, stored, { note: SEARCHES_USED_NOTE });
  } else await refit(s.db, userId, stored);
  const profile = stored.profile;
  const linkedin = await linkedinRoles(s, deps.sources, userId, profile).catch(() => ({
    ids: [] as string[],
    account: false,
    searched: 0,
  }));
  const rows = await filterRoles(s.db, userId, profile, { include: linkedin.ids });
  const ranked = rankJobs(rows, profile, await warmCompanies(s.db, userId), now).slice(0, LIST_SIZE);
  // a search still being read for an older profile is dropped: its rows never appear for the new one
  await s.db.sql`update orbit.role_searches set status = 'dropped'
                  where user_id = ${userId}::uuid and status = 'reading'`;
  const [search] = await s.db.sql<SearchRow>`
    insert into orbit.role_searches (user_id, evidence_hash, wants_hash, status, listed, sources, created_at)
    values (${userId}::uuid, ${stored.evidenceHash}, ${stored.wantsHash}, 'reading', ${ranked.length}::int,
            ${{ full, linkedin: linkedin.account, linkedinSearched: linkedin.searched }}::jsonb, ${now}::timestamptz)
    returning id::text as id, evidence_hash, wants_hash, status, listed, read, sources, created_at`;
  await listMatches(s.db, userId, search!.id, ranked, stored.evidenceHash);
  return respond(s, userId, search!, stored);
}

/** POST /roles/more: the next 15 read closely. */
export async function more(
  s: Services,
  deps: RolesDeps,
  userId: string,
  searchId: string,
): Promise<RolesSearchResponse> {
  const [search] = await s.db.sql<SearchRow>`
    select id::text as id, evidence_hash, wants_hash, status, listed, read, sources, created_at
      from orbit.role_searches where id = ${searchId}::uuid and user_id = ${userId}::uuid`;
  if (!search) throw new HttpError(404, 'not_found', 'no such search');
  const stored = await needProfile(s.db, userId);
  const coverage = await coverageOf(s.db, !!search.sources?.linkedin);
  if (search.status === 'dropped' || search.evidence_hash !== stored.evidenceHash)
    return {
      searchId,
      matches: [],
      listed: search.listed,
      read: 0,
      done: true,
      coverage,
      note: PROFILE_CHANGED_NOTE,
    };
  const now = s.now();
  const used = await readsToday(s.db, userId, now);
  if (used >= READS_PER_DAY || !s.claude.configured) {
    const rough = await withJobs(
      s.db,
      (await matchesWhere(s.db, userId, { searchId, open: true })).filter((r) => r.row.state === 'to_read'),
      { evidenceHash: stored.evidenceHash, profile: stored.profile },
    );
    const c = await counts(s.db, searchId, stored.evidenceHash);
    return {
      searchId,
      matches: rough,
      listed: c.listed,
      read: c.read,
      done: true,
      coverage,
      note: used >= READS_PER_DAY ? LIMIT_NOTE : NOT_READ_NOTE,
    };
  }
  const rows = await claimRows(s.db, userId, {
    searchId,
    n: Math.min(MORE_SIZE, READS_PER_DAY - used),
    now,
  });
  const out = await readRows(s, deps, userId, stored, rows);
  const res = await respond(s, userId, search, stored, {
    matches: [...out.read, ...out.unread],
    ...(out.note ? { note: out.note } : {}),
  });
  // rows the model could not read now are left to read later: the browser stops asking until the next visit
  return out.unread.length ? { ...res, done: true } : res;
}

/** POST /roles/list: stored matches, or Saved. Free. */
export async function list(
  s: Services,
  userId: string,
  view: 'matches' | 'saved' = 'matches',
): Promise<RolesListResponse> {
  const stored = await loadProfile(s.db, userId);
  const latest = await latestSearch(s.db, userId);
  const coverage = latest ? await coverageOf(s.db, !!latest.sources?.linkedin) : undefined;
  if (!stored) return { matches: [], ...(latest ? { searchId: latest.id } : {}) };
  const rows =
    view === 'saved'
      ? await matchesWhere(s.db, userId, { statuses: ['saved', 'applied', 'interviewing'] })
      : await matchesWhere(s.db, userId, { read: true, evidenceHash: stored.evidenceHash, open: true });
  return {
    matches: await withJobs(s.db, rows, { evidenceHash: stored.evidenceHash, profile: stored.profile }),
    ...(latest ? { searchId: latest.id } : {}),
    ...(coverage ? { coverage } : {}),
    profileAt: stored.updatedAt,
  };
}

/** POST /roles/score: one posting by link or by its pasted text, scored now. */
export async function scoreOne(
  s: Services,
  deps: RolesDeps,
  userId: string,
  req: RolesScoreRequest,
): Promise<RolesScoreResponse> {
  const stored = await needProfile(s.db, userId);
  let listing: JobListing;
  const pasted = req.text?.trim();
  if (pasted) {
    const firstLine =
      pasted
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? 'A pasted posting';
    listing = {
      source: 'posting',
      externalId: `pasted:${(await sha256Hex(pasted)).slice(0, 24)}`,
      companyName: plain(req.company ?? '', 120) || 'Unknown company',
      title: plain(req.title ?? '', 160) || plain(firstLine, 160),
      locations: [],
      url: req.url?.trim() || '',
      text: pasted.slice(0, 20_000),
    };
  } else if (req.url?.trim()) {
    const access = await linkedinAccess(s, userId).catch(() => undefined);
    const read = await deps.sources.readUrl(netOf(s), req.url.trim(), access).catch(() => ({
      problem: 'Orbit cannot read this site. Paste the posting’s text.',
    }));
    if ('problem' in read) return { problem: plain(read.problem, 200) };
    listing = read;
  } else throw badRequest('url or text is required');
  const [job] = await deps.sources.keep(s.db, [listing]);
  if (!job) return { problem: 'Orbit could not keep this posting. Paste its text.' };
  await listMatches(s.db, userId, null, [{ id: job.id, rank: 0 }], stored.evidenceHash);
  const [row] = await s.db.query<MatchRow>(
    `select ${MATCH_COLUMNS} from orbit.role_matches m where m.user_id = $1::uuid and m.job_id = $2::uuid`,
    [userId, job.id],
  );
  if (!row) return { problem: 'Orbit could not keep this posting. Paste its text.' };
  if (row.state === 'read' && row.evidence_hash === stored.evidenceHash)
    return { match: matchOf(row, job, { evidenceHash: stored.evidenceHash }) };
  if (!s.claude.configured || (await readsToday(s.db, userId, s.now())) >= READS_PER_DAY)
    return { match: matchOf(row, job, { evidenceHash: stored.evidenceHash, profile: stored.profile }) };
  const out = await readRows(s, deps, userId, stored, [row]);
  return {
    match:
      out.read[0] ??
      out.unread[0] ??
      matchOf(row, job, { evidenceHash: stored.evidenceHash, profile: stored.profile }),
  };
}

const STATUSES: readonly MatchStatus[] = ['new', 'saved', 'dismissed', 'applied', 'interviewing'];
const REASONS: readonly DismissReason[] = ['kind', 'level', 'place', 'company', 'other'];

/** POST /roles/act. */
export async function act(
  s: Services,
  userId: string,
  b: Record<string, unknown>,
): Promise<RolesActResponse> {
  if (b.watch && typeof b.watch === 'object') {
    const w = b.watch as { companyName?: unknown; on?: unknown };
    const name = typeof w.companyName === 'string' ? plain(w.companyName, 120) : '';
    const key = normalizeCompany(name);
    if (!key || typeof w.on !== 'boolean') throw badRequest('watch is {companyName, on}');
    if (w.on)
      await s.db.sql`
        insert into orbit.role_watches (user_id, company_key, company_name) values (${userId}::uuid, ${key}, ${name})
        on conflict (user_id, company_key) do update set company_name = excluded.company_name`;
    else
      await s.db.sql`delete from orbit.role_watches where user_id = ${userId}::uuid and company_key = ${key}`;
    const rows = await s.db.sql<{ company_name: string }>`
      select company_name from orbit.role_watches where user_id = ${userId}::uuid order by created_at, company_key`;
    return { watching: rows.map((r) => r.company_name) };
  }
  const id = typeof b.matchId === 'string' ? b.matchId : '';
  const status = b.status as MatchStatus;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !STATUSES.includes(status))
    throw badRequest('matchId and status are required');
  const reason =
    status === 'dismissed'
      ? REASONS.includes(b.dismissReason as DismissReason)
        ? (b.dismissReason as DismissReason)
        : 'other'
      : null;
  const [row] = await s.db.query<MatchRow>(
    `update orbit.role_matches m set status = $3, dismiss_reason = $4, seen_at = coalesce(seen_at, $5::timestamptz)
      where m.id = $1::uuid and m.user_id = $2::uuid
      returning ${MATCH_COLUMNS}`,
    [id, userId, status, reason, s.now()],
  );
  if (!row) throw new HttpError(404, 'not_found', 'no such role');
  const stored = await loadProfile(s.db, userId);
  const [job] = await jobsById(s.db, [row.job_id]);
  return { match: matchOf(row, jobOf(job!), stored ? { evidenceHash: stored.evidenceHash } : undefined) };
}

/**
 * roles.topup (§5, last paragraph): at most 20 roles the student has no row for yet, for their current profile,
 * ranked as a search ranks them and read closely now.
 */
export async function topup(
  s: Services,
  deps: RolesDeps,
  userId: string,
): Promise<{ listed: number; read: number; note?: string }> {
  const stored = await loadProfile(s.db, userId);
  if (!stored) return { listed: 0, read: 0 };
  const now = s.now();
  const left = READS_PER_DAY - (await readsToday(s.db, userId, now));
  if (left <= 0) return { listed: 0, read: 0, note: LIMIT_NOTE };
  const rows = await filterRoles(s.db, userId, stored.profile, { onlyNew: true });
  const ranked = rankJobs(rows, stored.profile, await warmCompanies(s.db, userId), now).slice(
    0,
    Math.min(TOPUP_SIZE, left),
  );
  if (!ranked.length) return { listed: 0, read: 0 };
  const latest = await latestSearch(s.db, userId);
  const searchId = latest && latest.evidence_hash === stored.evidenceHash ? latest.id : null;
  await listMatches(s.db, userId, searchId, ranked, stored.evidenceHash);
  const ids = (
    await s.db.sql<{ id: string }>`
      select id::text as id from orbit.role_matches
       where user_id = ${userId}::uuid and job_id = any(${ranked.map((r) => r.id)}::uuid[])`
  ).map((r) => r.id);
  const claimed = await claimRows(s.db, userId, { ids, n: TOPUP_SIZE, now });
  if (!s.claude.configured) {
    await s.db
      .sql`update orbit.role_matches set read_at = null where id = any(${ids}::uuid[]) and state = 'to_read'`;
    return { listed: ranked.length, read: 0, note: NOT_READ_NOTE };
  }
  const out = await readRows(s, deps, userId, stored, claimed);
  return { listed: ranked.length, read: out.read.length, ...(out.note ? { note: out.note } : {}) };
}
