/**
 * roles.tick (plan 44 §4.6, every 10 minutes): the source side's background work, each part inside its share of the
 * tick so the whole stays inside the worker's time and CPU allowance.
 *
 * 1. Upkeep, no requests: SimplifyJobs and LinkedIn roles not seen for 3 days are closed; closed roles nobody saved
 *    are deleted after 60 days.
 * 2. Once a night (from 06:00 UTC): a `roles.topup` job for each student who searched roles in the last 14 days.
 * 3. Once a day: the SimplifyJobs lists, one list a tick, kept in parts (a cursor for the day), and the boards their
 *    links name.
 * 4. The boards that are due, until their share of the tick (time and bytes) is spent.
 * 5. The text of a few new roles from boards that list without it, students' levels first.
 * 6. Looking for more companies' boards with what is left.
 */
import type { Db } from '../db.ts';
import type { Queue } from '../queue.ts';
import { readDueBoards } from './boards.ts';
import { discoverSome, harvestBoards } from './discover.ts';
import { keepListings } from './intake.ts';
import type { ReaderNet } from './readers/http.ts';
import { readSimplify, type SimplifyList } from './readers/simplify.ts';
import { text } from './sources.ts';
import { count, counted, dayOf, setMark } from './usage.ts';

const DAY = 86_400_000;
/** Wall clock a tick may use, all parts together. */
export const TICK_MS = 40_000;
/** Bytes a tick may parse (roughly its share of the isolate's CPU allowance). */
export const TICK_MAX_BYTES = 16_000_000;
/** List and LinkedIn roles not seen for this long are closed. */
export const LIST_UNSEEN_MS = 3 * DAY;
/** A closed role with no saved match is deleted after this long. */
export const CLOSED_KEEP_MS = 60 * DAY;
/** The hour (UTC) from which the nightly top-up is queued. */
export const TOPUP_HOUR = 6;
/** A student who searched roles this recently gets the nightly top-up. */
export const TOPUP_ACTIVE_MS = 14 * DAY;
/** SimplifyJobs listings kept per part, so the time share is checked between parts. */
export const SIMPLIFY_PART = 500;
/**
 * SimplifyJobs listings kept per tick at most: intake costs about 0.13 ms of CPU a listing (measured on 2026-11-24),
 * so 2,000 is about a quarter of a worker run's 2 s; the internship list (5,000 active) takes three ticks.
 */
export const SIMPLIFY_PER_TICK = 2000;
export const TEXTS_PER_TICK = 15;
export const DISCOVERY_PER_TICK = 8;

export interface RolesTickDeps {
  net: ReaderNet;
  queue: Queue;
  /** wall clock in ms (tests drive it) */
  clock: () => number;
  budgetMs?: number;
  maxBytes?: number;
  discoveryPerTick?: number;
  textsPerTick?: number;
}

export interface RolesTickSummary {
  closedLists: number;
  deleted: number;
  topups: number | null;
  simplify?: { list: SimplifyList; kept: number; done: boolean; harvested: number; error?: string };
  boards: {
    read: number;
    failed: number;
    tooLarge: number;
    added: number;
    closed: number;
    stoppedBy?: string;
  };
  texts: number;
  discovery: { looked: number; found: number; refused: number; stoppedBy?: string };
  ms: number;
}

/** Step 1: lists' roles not seen lately close; old closed roles nobody saved go. */
export async function upkeep(db: Db, now: Date): Promise<{ closed: number; deleted: number }> {
  const closed = await db.sql`
    update orbit_private.jobs set closed_at = ${now}::timestamptz
     where source in ('simplify', 'linkedin') and closed_at is null
       and last_seen_at < ${new Date(now.getTime() - LIST_UNSEEN_MS)}::timestamptz
     returning id`;
  const deleted = await db.sql`
    delete from orbit_private.jobs j
     where j.id in (
       select id from orbit_private.jobs
        where closed_at is not null and closed_at < ${new Date(now.getTime() - CLOSED_KEEP_MS)}::timestamptz
          and not exists (select 1 from orbit.role_matches m
                           where m.job_id = orbit_private.jobs.id and m.status in ('saved', 'applied', 'interviewing'))
        limit 2000)
     returning id`;
  await count(db, now, 'roles_closed', closed.length);
  await count(db, now, 'roles_deleted', deleted.length);
  return { closed: closed.length, deleted: deleted.length };
}

/** Step 2: the nightly top-up, once a day from TOPUP_HOUR, for students who searched in the last 14 days. */
export async function queueTopups(db: Db, queue: Queue, now: Date): Promise<number | null> {
  if (now.getUTCHours() < TOPUP_HOUR) return null;
  if (await counted(db, now, 'topup_queued')) return null;
  const users = await db.sql<{ user_id: string }>`
    select distinct s.user_id from orbit.role_searches s
      join orbit.users u on u.id = s.user_id and u.deleted_at is null
     where s.created_at > ${new Date(now.getTime() - TOPUP_ACTIVE_MS)}::timestamptz`;
  const day = dayOf(now);
  for (const u of users)
    await queue.enqueue({
      kind: 'roles.topup',
      userId: u.user_id,
      payload: {},
      dedupeKey: `roles.topup:${u.user_id}:${day}`,
    });
  await setMark(db, now, 'topup_queued', users.length + 1);
  return users.length;
}

/** Step 3: one SimplifyJobs list a tick, kept from today's cursor in parts until its share is spent. */
export async function readSimplifyPart(
  db: Db,
  net: ReaderNet,
  now: Date,
  run: { clock: () => number; deadline: number },
): Promise<RolesTickSummary['simplify']> {
  let list: SimplifyList | undefined;
  for (const l of ['intern', 'newgrad'] as const)
    if (!(await counted(db, now, `simplify_${l}_done`))) {
      list = l;
      break;
    }
  if (!list) return undefined;
  const got = await readSimplify(net, list);
  if (!got.ok) {
    // tried again next tick; a list that keeps failing is in the digest as not read
    return { list, kept: 0, done: false, harvested: 0, error: got.reason };
  }
  const listings = got.value.listings;
  let at = await counted(db, now, `simplify_${list}_at`);
  const harvested = at === 0 ? await harvestBoards(db, listings, now) : 0;
  let kept = 0;
  const stop = at + SIMPLIFY_PER_TICK;
  while (at < listings.length && at < stop && run.clock() < run.deadline) {
    const part = listings.slice(at, at + SIMPLIFY_PART);
    const r = await keepListings(db, part, { now });
    kept += r.added + r.updated;
    at += part.length;
    await setMark(db, now, `simplify_${list}_at`, at);
  }
  const done = at >= listings.length;
  if (done) {
    await setMark(db, now, `simplify_${list}_done`, 1);
    await count(db, now, 'simplify_listings', listings.length);
  }
  return { list, kept, done, harvested };
}

/** Step 5: the text of a few new open roles from boards that list without it, intern and entry roles first. */
export async function fillTexts(
  db: Db,
  net: ReaderNet,
  run: { clock: () => number; deadline: number; max: number },
): Promise<number> {
  if (run.deadline - run.clock() < 3_000) return 0;
  const rows = await db.sql<{ id: string }>`
    select id from orbit_private.jobs
     where closed_at is null and dupe_of is null and text_read_at is null
       and source in ('greenhouse', 'smartrecruiters', 'workable')
     order by case when level = 'intern' then 0 when level = 'entry' then 1 when level is null then 2 else 3 end,
              first_seen_at desc
     limit ${run.max}::int`;
  let n = 0;
  for (const r of rows) {
    if (run.deadline - run.clock() < 3_000) break;
    if (await text(db, net, r.id)) n++;
  }
  return n;
}

export async function runRolesTick(db: Db, deps: RolesTickDeps): Promise<RolesTickSummary> {
  const now = deps.net.now();
  const start = deps.clock();
  const budget = deps.budgetMs ?? TICK_MS;
  const end = start + budget;
  const s: RolesTickSummary = {
    closedLists: 0,
    deleted: 0,
    topups: null,
    boards: { read: 0, failed: 0, tooLarge: 0, added: 0, closed: 0 },
    texts: 0,
    discovery: { looked: 0, found: 0, refused: 0 },
    ms: 0,
  };
  const up = await upkeep(db, now);
  s.closedLists = up.closed;
  s.deleted = up.deleted;
  s.topups = await queueTopups(db, deps.queue, now);

  // the lists take most of a tick on the days they are read; the boards wait for the next tick
  s.simplify = await readSimplifyPart(db, deps.net, now, {
    clock: deps.clock,
    deadline: start + budget * 0.6,
  });

  const boards = await readDueBoards(db, deps.net, now, {
    clock: deps.clock,
    deadline: start + budget * 0.75,
    maxBytes: (deps.maxBytes ?? TICK_MAX_BYTES) / (s.simplify ? 2 : 1),
  });
  s.boards = {
    read: boards.read,
    failed: boards.failed,
    tooLarge: boards.tooLarge,
    added: boards.added,
    closed: boards.closed,
    stoppedBy: boards.stoppedBy,
  };
  s.texts = await fillTexts(db, deps.net, {
    clock: deps.clock,
    deadline: start + budget * 0.85,
    max: deps.textsPerTick ?? TEXTS_PER_TICK,
  });
  const d = await discoverSome(db, deps.net, now, {
    clock: deps.clock,
    deadline: end,
    maxCompanies: deps.discoveryPerTick ?? DISCOVERY_PER_TICK,
  });
  s.discovery = { looked: d.looked, found: d.found, refused: d.refused, stoppedBy: d.stoppedBy };
  s.ms = deps.clock() - start;
  return s;
}
