/**
 * Plan 44 §5: a search is a job, not one long request.
 *
 *   startSearch  filter, rank, list the top 60 as to be read, answer at once with what is already read. Three full
 *                searches a day per student; after that the stored results, with a note. A change of wants only
 *                (places, kinds, chips, eligibility) is not a full search: it re-filters and re-ranks, and rows read
 *                against the same evidence are scored again in code, with no model call.
 *   more         reads the next 10 closely (five model calls of two, side by side) and returns them. With
 *                `deps.background` (production) it answers at once and reads after the answer: each call returns every
 *                row read so far, `done: false` until none is left. A search that was replaced (a newer one, or the
 *                profile's evidence changed) answers 404 `search_replaced`, an id that never was 404 `not_found`: the
 *                browser then asks /roles/search once, which gives the search to follow.
 *   list         what is stored, free: the matches (with `rest`, also the roles not read closely yet), or Saved,
 *                which keeps roles that have since closed (`job.closedAt`)
 *   scoreOne     one posting by link or pasted text, scored now; `{problem}` when there is no profile yet
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
import { confirmedProfile, plain, type StoredProfile } from './profile.ts';
import {
  BACKGROUND_TIMEOUTS,
  CLAIM_MS,
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
  roughFitOf,
} from './score.ts';

export const SEARCHES_PER_DAY = 3;
export const MORE_SIZE = 10;
export const TOPUP_SIZE = 20;
export const SEARCHES_USED_NOTE =
  'You have run three searches today. These are your latest results, and more are read tonight.';
/** What /roles/more says of a search that a newer one replaced; the browser asks /roles/search once and follows it. */
export const SEARCH_REPLACED = 'That search was replaced by a newer one.';
export const NO_PROFILE = 'Read your resume or LinkedIn profile first, so Orbit has something to match.';

type SearchRow = {
  id: string;
  evidence_hash: string;
  wants_hash: string;
  status: 'reading' | 'done' | 'failed' | 'dropped';
  listed: number;
  read: number;
  sources: { full?: boolean; linkedin?: boolean };
  /** set when a background read could read nothing: the browser stops asking until the next search */
  error?: string | null;
  created_at: Date | string;
};

const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

async function needProfile(db: Db, userId: string): Promise<StoredProfile> {
  const p = await confirmedProfile(db, userId);
  if (!p) throw new HttpError(409, 'no_profile', NO_PROFILE);
  return p;
}

async function latestSearch(db: Db, userId: string): Promise<SearchRow | undefined> {
  const [r] = await db.sql<SearchRow>`
    select id::text as id, evidence_hash, wants_hash, status, listed, read, sources, error, created_at
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
    /** with searchId: also the rows of no search (a posting scored on its own) */
    loose?: boolean;
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
        and ($2::uuid is null or m.search_id = $2::uuid or ($7::boolean and m.search_id is null))
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
      where.loose ?? false,
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

/**
 * The roles of a search not read closely (still to be read, or the model left them out twice), each with the parts
 * Orbit can read without it (`roughFit`): what the table marks "Not read closely yet".
 */
async function restOf(db: Db, userId: string, searchId: string, stored: StoredProfile): Promise<RoleMatch[]> {
  const rows = (await matchesWhere(db, userId, { searchId, open: true })).filter(
    (r) => r.row.state === 'to_read' || r.row.state === 'failed',
  );
  if (!rows.length) return [];
  // skills by word are read from the posting's text where Orbit already keeps it (nothing is fetched for this)
  const texts = new Map(
    (
      await db.sql<{ id: string; text: string | null }>`
        select id::text as id, text from orbit_private.jobs
         where id = any(${rows.map((r) => r.row.job_id)}::uuid[])`
    ).map((r) => [r.id, r.text]),
  );
  const matches = await withJobs(db, rows, { evidenceHash: stored.evidenceHash, profile: stored.profile });
  return matches.map((m) =>
    m.fit ? m : { ...m, roughFit: roughFitOf(m.job, stored.profile, texts.get(m.job.id) ?? undefined) },
  );
}

async function counts(db: Db, searchId: string, evidenceHash: string) {
  // the open roles of the search: one taken down since it was listed has left the table, so it is neither listed,
  // read nor left to read (it is never claimed)
  const [c] = await db.sql<{ listed: number; read: number; left: number }>`
    select count(*)::int as listed,
           count(*) filter (where m.state = 'read' and m.evidence_hash = ${evidenceHash})::int as read,
           count(*) filter (where m.state = 'to_read' and m.status <> 'dismissed')::int as left
      from orbit.role_matches m join orbit_private.jobs j on j.id = m.job_id
     where m.search_id = ${searchId}::uuid and j.closed_at is null`;
  return c ?? { listed: 0, read: 0, left: 0 };
}

async function respond(
  s: Services,
  userId: string,
  search: SearchRow,
  stored: StoredProfile,
  extra: {
    matches?: RoleMatch[];
    note?: string;
    /** stop here: answer `done`, with the roles not read closely as rough rows */
    over?: boolean;
  } = {},
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
    // the search is over for now (nothing left to read, or the model is off): the roles not read closely come too,
    // with the parts Orbit can read without it
    if (done || !s.claude.configured || extra.over) {
      const rough = await restOf(s.db, userId, search.id, stored);
      matches = [...matches, ...rough];
      if (rough.length && (!s.claude.configured || extra.over)) note ??= NOT_READ_NOTE;
    }
  }
  return {
    searchId: search.id,
    matches,
    listed: c.listed,
    read: c.read,
    done: done || !s.claude.configured || !!extra.over,
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
      return respond(s, userId, latest, stored, {
        note: SEARCHES_USED_NOTE,
        // the latest search is for other evidence (the profile changed after today's third): nothing of it can be
        // read against this profile, so the browser is told to stop and not to ask for more
        ...(latest.evidence_hash !== stored.evidenceHash || latest.status === 'dropped'
          ? { over: true }
          : {}),
      });
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
    returning id::text as id, evidence_hash, wants_hash, status, listed, read, sources, error, created_at`;
  await listMatches(s.db, userId, search!.id, ranked, stored.evidenceHash);
  return respond(s, userId, search!, stored);
}

/** POST /roles/more: the next 10 read closely. */
export async function more(
  s: Services,
  deps: RolesDeps,
  userId: string,
  searchId: string,
): Promise<RolesSearchResponse> {
  const [search] = await s.db.sql<SearchRow>`
    select id::text as id, evidence_hash, wants_hash, status, listed, read, sources, error, created_at
      from orbit.role_searches where id = ${searchId}::uuid and user_id = ${userId}::uuid`;
  if (!search) throw new HttpError(404, 'not_found', 'no such search');
  const stored = await needProfile(s.db, userId);
  // a newer search took its place, or the profile it was for has other evidence now: not this search any more
  if (search.status === 'dropped' || search.evidence_hash !== stored.evidenceHash)
    throw new HttpError(404, 'search_replaced', SEARCH_REPLACED);
  const coverage = await coverageOf(s.db, !!search.sources?.linkedin);
  const now = s.now();
  const used = await readsToday(s.db, userId, now);
  if (used >= READS_PER_DAY || !s.claude.configured) {
    const rough = await restOf(s.db, userId, searchId, stored);
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
  const n = Math.min(MORE_SIZE, READS_PER_DAY - used);
  if (deps.background) {
    // read after answering: the browser asks again in a few seconds and gets what is read by then
    const [busy] = await s.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.role_matches
       where search_id = ${searchId}::uuid and state = 'to_read' and read_at > ${new Date(now.getTime() - CLAIM_MS)}::timestamptz`;
    // the last background read could read nothing: what is read, the rest with their rough parts, and why
    if (search.error && !busy?.n)
      return respond(s, userId, search, stored, { note: search.error, over: true });
    if (!busy?.n) {
      const rows = await claimRows(s.db, userId, { searchId, n, now });
      if (rows.length)
        deps.background(
          readRows(s, deps, userId, stored, rows, BACKGROUND_TIMEOUTS)
            .then(async (out) => {
              // nothing could be read: stop asking until the next search, the rows keep their rough parts
              if (!out.read.length && out.unread.length)
                await s.db.sql`update orbit.role_searches set error = ${out.note ?? NOT_READ_NOTE}
                                where id = ${searchId}::uuid`;
            })
            .catch(() => undefined),
        );
    }
    return respond(s, userId, search, stored);
  }
  const rows = await claimRows(s.db, userId, { searchId, n, now });
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
  o: {
    /** also the latest search's roles not read closely yet, each with its rough parts */ rest?: boolean;
  } = {},
): Promise<RolesListResponse> {
  const stored = await confirmedProfile(s.db, userId);
  const latest = await latestSearch(s.db, userId);
  const coverage = latest ? await coverageOf(s.db, !!latest.sources?.linkedin) : undefined;
  if (!stored) return { matches: [], ...(latest ? { searchId: latest.id } : {}) };
  const rows =
    view === 'saved'
      ? await matchesWhere(s.db, userId, { statuses: ['saved', 'applied', 'interviewing'] })
      : // the latest search's rows (what it no longer lists stays out), and postings scored on their own
        await matchesWhere(s.db, userId, {
          ...(latest ? { searchId: latest.id, loose: true } : {}),
          read: true,
          evidenceHash: stored.evidenceHash,
          open: true,
        });
  const matches = await withJobs(s.db, rows, { evidenceHash: stored.evidenceHash, profile: stored.profile });
  // only of a search for this profile's evidence: rows listed for an older profile are not this profile's roles
  if (
    view === 'matches' &&
    o.rest &&
    latest &&
    latest.status !== 'dropped' &&
    latest.evidence_hash === stored.evidenceHash
  ) {
    const have = new Set(matches.map((m) => m.id));
    for (const m of await restOf(s.db, userId, latest.id, stored)) if (!have.has(m.id)) matches.push(m);
  }
  return {
    matches,
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
  // no profile yet is not an error: the posting card says so and links to Roles
  const stored = await confirmedProfile(s.db, userId);
  if (!stored) return { problem: NO_PROFILE };
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
  const stored = await confirmedProfile(s.db, userId);
  const [job] = await jobsById(s.db, [row.job_id]);
  // a row not read closely keeps its rough parts, so it stays "Not read closely yet" after it is saved
  return {
    match: matchOf(
      row,
      jobOf(job!),
      stored ? { evidenceHash: stored.evidenceHash, profile: stored.profile } : undefined,
    ),
  };
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
  const stored = await confirmedProfile(s.db, userId);
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
