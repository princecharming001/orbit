/**
 * Plan 44 §4.6: reading a company's board end to end, once a day. List its roles (without text where the service
 * allows), keep them (intake.ts), and close the roles of that board this read did not see. Then the board's own
 * bookkeeping: its size, its failures, and when it is next read.
 *
 * - Each board is read at its own minute of the day (from its id), so reads are spread over the day.
 * - A board is claimed for the day before it is read (`last_read_at` before today's start), so two ticks never read
 *   it twice in one day, whatever its `next_read_at` says.
 * - A failure is tried again the next day; three failures in a row make a board `gone` (404) or `refused` (403).
 * - A 429 is not a failure of the board: it is asked once more later the same day, then daily, and only
 *   RATE_LIMIT_DAYS_TO_STOP days in a row that end on a 429 set it aside as `refused`. After a Workday 429 no Workday
 *   site is asked for WORKDAY_PAUSE_MIN minutes (Workday answers 429 to a reader that asks several sites in a row).
 * - Ashby boards are read whole up to ASHBY_MAX_BYTES (12 MB). A board over LARGE_BOARD_BYTES is a tick's whole
 *   share of boards: one known to be large is started only when nothing else was read this tick, and nothing is
 *   read after it. One over the limit is marked with its size and tried weekly.
 * - A read that stopped at its page cap (a very large Workday site) is incomplete: its unseen roles are closed only
 *   when not seen for a week.
 */
import type { BoardService } from '../../../../packages/core/src/roles/types.ts';
import type { Db } from '../db.ts';
import { keepListings } from './intake.ts';
import { ASHBY_MAX_BYTES, readAshby } from './readers/ashby.ts';
import { readGreenhouse } from './readers/greenhouse.ts';
import type { BoardRead, FailReason, ReaderNet } from './readers/http.ts';
import { readLever } from './readers/lever.ts';
import { readRecruitee } from './readers/recruitee.ts';
import { readSmartRecruiters } from './readers/smartrecruiters.ts';
import { readWorkable } from './readers/workable.ts';
import { readWorkday } from './readers/workday.ts';
import { count, counted, setMark } from './usage.ts';

export type BoardRow = {
  id: string;
  service: BoardService;
  token: string;
  company_key: string | null;
  company_name: string | null;
  company_domain: string | null;
  status: 'active' | 'empty' | 'gone' | 'refused';
  failures: number;
  /** the size of its last answer, when one was read (or was too large) */
  last_size_bytes?: number | null;
  /** when it first answered 429 on its latest day of doing so */
  rate_limited_at?: Date | string | null;
  /** days in a row that ended on a 429 */
  rate_limited_days?: number;
};

/** The columns every read of a board needs. */
export const BOARD_COLUMNS =
  'id, service, token, company_key, company_name, company_domain, status, failures, last_size_bytes, rate_limited_at, rate_limited_days';

export interface BoardOutcome {
  boardId: string;
  service: BoardService;
  token: string;
  ok: boolean;
  roles: number;
  added: number;
  updated: number;
  closed: number;
  bytes: number;
  requests: number;
  complete?: boolean;
  error?: FailReason;
}

const DAY = 86_400_000;
/** Failures in a row before a board is set aside as gone or refused. */
export const FAILURES_TO_STOP = 3;
/** A board that answers 429 is asked once more this long after, when that is still the same day. */
export const RATE_LIMIT_RETRY_MS = 3 * 3_600_000;
/** Days in a row ending on a 429 before a board is set aside as refused (a month). */
export const RATE_LIMIT_DAYS_TO_STOP = 5;
/** After a Workday site answers 429, no Workday site is asked for this many minutes. */
export const WORKDAY_PAUSE_MIN = 60;
/** A board whose answer is larger than this is a tick's whole share of boards. */
export const LARGE_BOARD_BYTES = 2_000_000;
/** The bytes of boards one tick may parse: one board of the largest size read (tick.ts halves it on a list's day). */
export const BOARD_BYTES_PER_TICK = ASHBY_MAX_BYTES;
/** An incomplete read closes roles not seen for this long. */
export const UNSEEN_CLOSE_MS = 7 * DAY;
/** Workday sites read in one tick at most. */
export const WORKDAY_PER_TICK = 2;
/** Roughly how long a read of each service takes, so a tick never starts one it cannot finish. */
export const READ_MS: Record<BoardService, number> = {
  greenhouse: 4_000,
  lever: 15_000,
  ashby: 4_000,
  workday: 30_000,
  smartrecruiters: 8_000,
  workable: 6_000,
  recruitee: 4_000,
};

/** How long a read of this board takes, roughly: a second more for each megabyte its last answer had. */
export function readMsOf(b: Pick<BoardRow, 'service' | 'last_size_bytes'>): number {
  return READ_MS[b.service] + Math.floor(Number(b.last_size_bytes ?? 0) / 1_000_000) * 1_000;
}

/** A board's own minute of the day, from its id, so a thousand boards are not all read at midnight. */
export function minuteOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 1440;
}

export const startOfDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The next day, at the board's minute. */
export function nextReadAt(id: string, now: Date, days = 1): Date {
  return new Date(startOfDay(now).getTime() + days * DAY + minuteOf(id) * 60_000);
}

/** A readable company name from a board token, when nothing better is known ("acme-robotics" as "Acme Robotics"). */
export function nameFromToken(token: string): string {
  const last = token.replace(/^eu:/, '').split('/').pop() ?? token;
  return last
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** One board's roles from its service. */
export function readBoardListings(net: ReaderNet, b: BoardRow): Promise<BoardRead> {
  const name = b.company_name ?? nameFromToken(b.token);
  switch (b.service) {
    case 'greenhouse':
      return readGreenhouse(net, b.token, b.company_name ?? undefined);
    case 'lever':
      return readLever(net, b.token, name);
    case 'ashby':
      return readAshby(net, b.token, name);
    case 'workday':
      return readWorkday(net, b.token, name);
    case 'smartrecruiters':
      return readSmartRecruiters(net, b.token, b.company_name ?? undefined);
    case 'workable':
      return readWorkable(net, b.token, name);
    case 'recruitee':
      return readRecruitee(net, b.token);
  }
}

/**
 * Claim a board for today: false when it was already read (or tried) today. A board that answered 429 today and
 * has not been asked since may be claimed once more (its retry later the same day).
 */
export async function claimBoard(db: Db, id: string, now: Date): Promise<boolean> {
  const today = startOfDay(now);
  const rows = await db.sql`
    update orbit_private.job_boards set last_read_at = ${now}::timestamptz
     where id = ${id}::uuid
       and (last_read_at is null or last_read_at < ${today}::timestamptz
            or (rate_limited_at >= ${today}::timestamptz and rate_limited_at >= last_read_at
                and last_read_at < ${now}::timestamptz))
     returning id`;
  return rows.length > 0;
}

const minuteOfDay = (now: Date) => now.getUTCHours() * 60 + now.getUTCMinutes();

/** Whether Workday asked to slow down within the last WORKDAY_PAUSE_MIN minutes of today. */
export async function workdayPaused(db: Db, now: Date): Promise<boolean> {
  return minuteOfDay(now) < (await counted(db, now, 'workday_pause_until'));
}

/** Roles of a board this read did not see are closed; a closed role's repeats elect a new one to show. */
async function closeUnseen(db: Db, boardId: string, now: Date, complete: boolean): Promise<number> {
  const before = complete ? now : new Date(now.getTime() - UNSEEN_CLOSE_MS);
  const closed = await db.sql`
    update orbit_private.jobs set closed_at = ${now}::timestamptz
     where board_id = ${boardId}::uuid and closed_at is null and last_seen_at < ${before}::timestamptz
     returning id`;
  if (closed.length)
    await db.sql`
      with orphans as (
        select d.id, d.dupe_of, d.first_seen_at from orbit_private.jobs d
          join orbit_private.jobs p on p.id = d.dupe_of
         where d.board_id = ${boardId}::uuid and d.closed_at is null and p.closed_at is not null),
      heads as (select distinct on (dupe_of) dupe_of, id from orphans order by dupe_of, first_seen_at, id)
      update orbit_private.jobs j set dupe_of = case when j.id = h.id then null else h.id end
        from orphans o join heads h on h.dupe_of = o.dupe_of
       where j.id = o.id`;
  return closed.length;
}

/** Read one board (already claimed) and keep what it lists. Never throws for the board's own failures. */
export async function readBoard(db: Db, net: ReaderNet, b: BoardRow, now: Date): Promise<BoardOutcome> {
  const out: BoardOutcome = {
    boardId: b.id,
    service: b.service,
    token: b.token,
    ok: false,
    roles: 0,
    added: 0,
    updated: 0,
    closed: 0,
    bytes: 0,
    requests: 0,
  };
  const read = await readBoardListings(net, b);
  out.requests = read.requests ?? 0;
  if (!read.ok) {
    out.error = read.reason;
    out.bytes = read.bytes ?? 0;
    if (read.reason === 'too_large') {
      // not a failure of the board: too large for the worker; measured again in a week
      await db.sql`
        update orbit_private.job_boards
           set last_size_bytes = ${read.bytes ?? null}::int, last_error = ${`too_large: ${read.bytes ?? '?'} bytes`},
               next_read_at = ${nextReadAt(b.id, now, 7)}::timestamptz
         where id = ${b.id}::uuid`;
      await count(db, now, 'boards_too_large');
      return out;
    }
    if (read.reason === 'rate_limited') {
      // asked to slow down: not a failure of the board. Once more later today; a day that ends on a 429 counts one
      // toward setting it aside, however many times it was asked that day.
      const today = startOfDay(now);
      const firstToday = !b.rate_limited_at || new Date(b.rate_limited_at).getTime() < today.getTime();
      const retryAt = new Date(now.getTime() + RATE_LIMIT_RETRY_MS);
      const error = `${read.reason}: ${read.message}`.slice(0, 300);
      if (b.service === 'workday')
        await setMark(db, now, 'workday_pause_until', minuteOfDay(now) + WORKDAY_PAUSE_MIN);
      await count(db, now, 'boards_rate_limited');
      if (firstToday && retryAt.getTime() < today.getTime() + DAY) {
        await db.sql`
          update orbit_private.job_boards
             set rate_limited_at = ${now}::timestamptz, last_error = ${error}, next_read_at = ${retryAt}::timestamptz
           where id = ${b.id}::uuid`;
        return out;
      }
      const days = (b.rate_limited_days ?? 0) + 1;
      const status = days >= RATE_LIMIT_DAYS_TO_STOP ? 'refused' : b.status;
      await db.sql`
        update orbit_private.job_boards
           set rate_limited_at = case when ${firstToday}::boolean then ${now}::timestamptz else rate_limited_at end,
               rate_limited_days = ${days}::int, last_error = ${error}, status = ${status},
               next_read_at = ${nextReadAt(b.id, now, status === 'refused' ? 30 : 1)}::timestamptz
         where id = ${b.id}::uuid`;
      await count(db, now, 'boards_failed');
      return out;
    }
    const failures = b.failures + 1;
    const status =
      failures >= FAILURES_TO_STOP && read.reason === 'not_found'
        ? 'gone'
        : failures >= FAILURES_TO_STOP && read.reason === 'refused'
          ? 'refused'
          : b.status;
    await db.sql`
      update orbit_private.job_boards
         set failures = ${failures}::int, last_error = ${`${read.reason}: ${read.message}`.slice(0, 300)},
             status = ${status}, next_read_at = ${nextReadAt(b.id, now, status === 'refused' ? 30 : 1)}::timestamptz
       where id = ${b.id}::uuid`;
    await count(db, now, 'boards_failed');
    return out;
  }
  const kept = await keepListings(db, read.listings, { boardId: b.id, now });
  const closed = await closeUnseen(db, b.id, now, read.complete);
  const [open] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit_private.jobs
     where board_id = ${b.id}::uuid and closed_at is null and dupe_of is null`;
  const roles = Number(open?.n ?? 0);
  await db.sql`
    update orbit_private.job_boards
       set status = ${roles ? 'active' : 'empty'}, roles_open = ${roles}::int, last_size_bytes = ${read.bytes}::int,
           failures = 0, last_error = null, next_read_at = ${nextReadAt(b.id, now)}::timestamptz,
           rate_limited_at = null, rate_limited_days = 0,
           company_name = coalesce(company_name, ${read.companyName ?? null})
     where id = ${b.id}::uuid`;
  await count(db, now, 'boards_read');
  await count(db, now, 'roles_added', kept.added);
  await count(db, now, 'roles_updated', kept.updated);
  await count(db, now, 'roles_closed', closed);
  return {
    ...out,
    ok: true,
    roles,
    added: kept.added,
    updated: kept.updated,
    closed,
    bytes: read.bytes,
    complete: read.complete,
  };
}

export interface DueRun {
  /** wall clock in ms, and when this share of the tick ends */
  clock: () => number;
  deadline: number;
  /** bytes parsed this share may take (the worker's CPU allowance, roughly); BOARD_BYTES_PER_TICK in a full tick */
  maxBytes: number;
  maxBoards?: number;
}

export interface DueSummary {
  read: number;
  failed: number;
  tooLarge: number;
  added: number;
  closed: number;
  bytes: number;
  stoppedBy?: 'time' | 'bytes' | 'boards';
  /** boards known to be large that waited for a tick of their own */
  waiting?: number;
  outcomes: BoardOutcome[];
}

/** Boards due now, read one after another until this share of the tick is spent. */
export async function readDueBoards(db: Db, net: ReaderNet, now: Date, run: DueRun): Promise<DueSummary> {
  const s: DueSummary = { read: 0, failed: 0, tooLarge: 0, added: 0, closed: 0, bytes: 0, outcomes: [] };
  // a board set aside as refused is tried again once its month is over
  await db.sql`
    update orbit_private.job_boards
       set status = 'active',
           failures = case when rate_limited_days >= ${RATE_LIMIT_DAYS_TO_STOP}::int then failures
                           else ${FAILURES_TO_STOP - 1}::int end,
           rate_limited_days = least(rate_limited_days, ${RATE_LIMIT_DAYS_TO_STOP - 1}::int)
     where status = 'refused' and next_read_at <= ${now}::timestamptz`;
  const due = await db.query<BoardRow>(
    `select ${BOARD_COLUMNS} from orbit_private.job_boards
      where status in ('active', 'empty') and next_read_at <= $1::timestamptz
      order by next_read_at
      limit $2::int`,
    [now, run.maxBoards ?? 50],
  );
  let workday = 0;
  // Workday answers 429 to a reader that asks several sites in a row (50 of 60 on 2026-11-24): a few a tick, none
  // after one says to slow down, and none for an hour after that
  let workdaySlow = due.some((b) => b.service === 'workday') && (await workdayPaused(db, now));
  for (const b of due) {
    const left = run.deadline - run.clock();
    if (left <= readMsOf(b)) {
      s.stoppedBy = 'time';
      // a board too long for what is left of this tick waits for the next; a short one may still fit
      if (left <= READ_MS.greenhouse) break;
      continue;
    }
    if (s.bytes >= run.maxBytes) {
      s.stoppedBy = 'bytes';
      break;
    }
    // a board known to be large is a tick's whole share: it starts only when nothing was read yet this tick, and
    // only in a tick whose share holds it (a tick that also read a SimplifyJobs list has half)
    const size = Number(b.last_size_bytes ?? 0);
    if (size > LARGE_BOARD_BYTES && (s.bytes > 0 || size > run.maxBytes)) {
      s.waiting = (s.waiting ?? 0) + 1;
      continue;
    }
    if (b.service === 'workday' && (workday >= WORKDAY_PER_TICK || workdaySlow)) continue;
    if (!(await claimBoard(db, b.id, now))) continue;
    if (b.service === 'workday') workday++;
    const o = await readBoard(db, net, b, now);
    if (b.service === 'workday' && o.error === 'rate_limited') workdaySlow = true;
    s.outcomes.push(o);
    s.bytes += o.bytes;
    if (o.ok) {
      s.read++;
      s.added += o.added;
      s.closed += o.closed;
    } else if (o.error === 'too_large') s.tooLarge++;
    else s.failed++;
    // a large board was this tick's whole share, whatever is left of the bytes
    if (o.ok && o.bytes > LARGE_BOARD_BYTES) {
      s.stoppedBy = 'bytes';
      break;
    }
  }
  if (!s.stoppedBy && due.length >= (run.maxBoards ?? 50)) s.stoppedBy = 'boards';
  return s;
}

/** A board found (from a careers page, a SimplifyJobs link, its name): kept once per service and token. */
export async function upsertBoard(
  db: Db,
  b: {
    service: BoardService;
    token: string;
    companyKey?: string;
    companyName?: string;
    companyDomain?: string;
    foundVia: 'careers_page' | 'simplify' | 'posting' | 'name' | 'seed' | 'owner';
    foundUrl?: string;
  },
): Promise<{ id: string; created: boolean }> {
  const [row] = await db.sql<{ id: string; created: boolean }>`
    insert into orbit_private.job_boards (service, token, company_key, company_name, company_domain, found_via, found_url)
    values (${b.service}, ${b.token}, ${b.companyKey ?? null}, ${b.companyName ?? null}, ${b.companyDomain ?? null},
            ${b.foundVia}, ${b.foundUrl ?? null})
    on conflict (service, token) do update set
      company_key = coalesce(orbit_private.job_boards.company_key, excluded.company_key),
      company_name = coalesce(orbit_private.job_boards.company_name, excluded.company_name),
      company_domain = coalesce(orbit_private.job_boards.company_domain, excluded.company_domain)
    returning id, (xmax = 0) as created`;
  return { id: row!.id, created: !!row!.created };
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
Object.setPrototypeOf(READ_MS, null);
