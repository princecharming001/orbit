/**
 * orbit-worker (§9.1): drains Orbit's pgmq queues once per pg_cron tick.
 *
 * For each queue in priority order it reads up to 10 messages (visibility 120 s), runs each message's handler by
 * `kind`, and starts again from the top after every batch, until the queues are empty or the time budget (110 s by
 * default) is spent. A message whose dedupeKey ran successfully in the last 24 hours is dropped. Success deletes the
 * message; failure hides it for 30·2^(read_ct−1) s (30 s, 1, 2, 4, 8 min); a sixth failed read (read_ct > 5) archives
 * it and copies it to orbit.dead_letters. Kinds that later phases implement throw NotImplemented, and a handler whose
 * provider is not configured or connected throws JobSkipped: those messages are dropped as `skipped`, never retried.
 * Every run is a row in orbit.job_runs.
 */

import { isUuid, timingSafeEqual } from '../_shared/crypto.ts';
import type { Db } from '../_shared/db.ts';
import { HttpError, json, type Logger, silentLogger, unconfigured } from '../_shared/http.ts';
import { isPaidError } from '../_shared/paid.ts';
import { QUEUES, type Queue, type QueueName, sqlQueue } from '../_shared/queue.ts';
import type { AgentConfig } from '../_shared/services.ts';
import { agentHandlers } from './handlers/agents.ts';
import { calendarHandlers } from './handlers/calendar.ts';
import { classifyHandlers } from './handlers/classify.ts';
import { contactsHandlers } from './handlers/contacts.ts';
import { costHandlers } from './handlers/cost.ts';
import { type HandlerDeps, JobSkipped } from './handlers/deps.ts';
import { friendHandlers } from './handlers/friends.ts';
import { gmailHandlers } from './handlers/gmail.ts';
import { linkedinHandlers } from './handlers/linkedin.ts';
import { scoreHandlers } from './handlers/score.ts';
import { searchHandlers } from './handlers/search.ts';
import { socialHandlers } from './handlers/social.ts';
import { sourceHandlers } from './handlers/sources.ts';
import { unipileHandlers } from './handlers/unipile.ts';
import { xHandlers } from './handlers/x.ts';

export class NotImplemented extends Error {
  constructor(kind: string) {
    super(`${kind} is not implemented yet`);
    this.name = 'NotImplemented';
  }
}

export interface Job {
  queue: QueueName;
  msgId: number;
  readCt: number;
  kind: string;
  userId: string | null;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

export interface JobContext {
  db: Db;
  queue: Queue;
  now: () => Date;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

/** Kinds with no handler yet; every planned kind is implemented, so the list is empty. */
export const PLACEHOLDER_KINDS: readonly string[] = [];

/**
 * The ingestion handlers take HandlerDeps; the agent handlers (research, sourcing, sending, cadence) take an
 * AgentConfig, which always carries `env`. Either can be passed alone, or the ingestion deps with `agents`.
 * classify.message takes both: the classifier runs on the ingestion deps, the reply it leads to on the AgentConfig.
 */
export function defaultHandlers(
  opts: (HandlerDeps & { agents?: AgentConfig }) | AgentConfig = {},
): Record<string, JobHandler> {
  const agents: AgentConfig | undefined = 'env' in opts ? opts : opts.agents;
  const deps: HandlerDeps =
    'env' in opts
      ? { fetch: opts.fetch, sleep: opts.sleep, random: opts.random, embed: opts.embed }
      : { ...opts, embed: opts.embed ?? opts.agents?.embed };
  // plan 43 §3.1: the owner's list reaches every handler, whichever way it was passed in
  deps.offered ??= agents?.env.extraSources ?? [];
  const handlers: Record<string, JobHandler> = {
    noop: async () => {},
    'health.snapshot': async (_job, ctx) => {
      await ctx.db.sql`select orbit.health_snapshot()`;
    },
    ...gmailHandlers(deps),
    ...calendarHandlers(deps),
    ...contactsHandlers(deps),
    ...linkedinHandlers(deps),
    ...scoreHandlers(deps),
    ...friendHandlers(deps),
    ...sourceHandlers(deps),
    ...searchHandlers(deps),
    ...costHandlers(deps.cost),
    ...unipileHandlers(deps),
    ...socialHandlers(deps),
    ...classifyHandlers(deps, agents),
    ...agentHandlers(agents),
    ...xHandlers(deps),
  };
  for (const kind of PLACEHOLDER_KINDS)
    handlers[kind] = async () => {
      throw new NotImplemented(kind);
    };
  return handlers;
}

export const VT_SEC = 120;
export const BATCH = 10;
export const MAX_READS = 5;
/**
 * A message read this many times never reached a clean finish: its runs keep dying with the isolate (a time or
 * memory limit), which skips the dead-letter path in runOne. It is set aside before it runs again. Above MAX_READS,
 * since a batch's unrun tail is handed back and read again without failing.
 */
export const MAX_READS_UNFINISHED = MAX_READS + 5;
export const DEFAULT_BUDGET_MS = 110_000;
/**
 * Kinds whose work is JavaScript CPU (tie scoring) rather than waiting on a provider. The isolate's CPU allowance is
 * shared by every job a tick runs, so a tick runs a few of these and only while it is fresh; the rest wait for the
 * next tick, a minute away, in a new isolate.
 */
export const HEAVY_KINDS: ReadonlySet<string> = new Set([
  'score.user',
  'score.ties',
  'score.page',
  'score.person',
  'sources.switch',
]);
/**
 * One a tick (plan 34 A7): with three, score.page runs shared one isolate's 2 s CPU allowance and 38 of them died
 * with the isolate on 2026-11-08.
 */
export const HEAVY_PER_TICK = 1;
/** Kinds that run once a worker run, alone in their CPU budget (the LinkedIn sync files pages, which is CPU). */
export const ONCE_PER_TICK: ReadonlySet<string> = new Set(['sync.linkedin']);
/** a heavy job is not started once the tick has already run this many jobs of any kind */
export const HEAVY_AFTER_JOBS = 6;
/** wall clock a kind needs to finish cleanly: it is not started with less than this left in the budget */
export const RESERVE_MS: Readonly<Record<string, number>> = {
  'sync.linkedin': 65_000,
  'sync.gmail.backfill': 58_000,
  'score.user': 20_000,
  'score.page': 20_000,
  'score.ties': 20_000,
  'sources.switch': 20_000,
  search_census: 58_000,
  search_reading: 58_000,
  company_facts_sync: 30_000,
  'logos.sweep': 50_000,
  'logos.user': 50_000,
  'claude.batch.poll': 40_000,
  // deep research: the investigator loop (up to 55 s) and the brief's writer (about 40 s)
  'enrich.dossier': 100_000,
};
export const DEFAULT_RESERVE_MS = 8_000;

export const backoffSec = (readCt: number) => 30 * 2 ** Math.max(0, readCt - 1);

/**
 * Plan 34 A6: a handler that threw after a paid call (Claude, Hunter, Exa) marks its error `paid: true`. Such a job
 * is run again at most this many times after a paid failure, then dead-lettered, so one answer is not bought five
 * times over.
 */
export const ATTEMPTS_AFTER_SPEND = 1;
/** the prefix a paid failure's error carries in orbit.job_runs, so later reads can count them */
export const PAID_ERROR_PREFIX = '[paid] ';
export { isPaidError };

export interface WorkerDeps {
  db: Db;
  queue?: Queue;
  handlers?: Record<string, JobHandler>;
  budgetMs?: number;
  /** wall clock in ms, for the budget (tests drive it) */
  clock?: () => number;
  now?: () => Date;
  log?: Logger;
}

export interface TickSummary {
  processed: number;
  ok: number;
  failed: number;
  skipped: number;
  deadLettered: number;
  byQueue: Partial<Record<QueueName, number>>;
  /** `cpu`: a heavy job was left for the next tick's fresh isolate */
  stoppedBy: 'empty' | 'budget' | 'cpu';
  /** runs of earlier ticks found still 'running' and closed as died with the isolate */
  swept?: number;
}

function parse(message: unknown): Omit<Job, 'queue' | 'msgId' | 'readCt'> | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const m = message as Record<string, unknown>;
  if (typeof m.kind !== 'string' || !m.kind) return undefined;
  // a userId that is not a uuid would fail every query below, so the message is malformed
  if (m.userId != null && !isUuid(m.userId)) return undefined;
  const userId = (m.userId as string | undefined) ?? null;
  const payload = m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload) ? m.payload : {};
  return {
    kind: m.kind,
    userId,
    payload: payload as Record<string, unknown>,
    dedupeKey: typeof m.dedupeKey === 'string' ? m.dedupeKey : undefined,
  };
}

const short = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);

export async function runTick(deps: WorkerDeps): Promise<TickSummary> {
  const db = deps.db;
  const queue = deps.queue ?? sqlQueue(db);
  const handlers = deps.handlers ?? defaultHandlers();
  const clock = deps.clock ?? Date.now;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const deadline = clock() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const s: TickSummary = {
    processed: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    byQueue: {},
    stoppedBy: 'empty',
  };

  // runs an earlier tick never finished (the isolate died under them: a CPU or memory limit) are closed, so the log
  // is honest and health() counts them
  const swept = await db.sql<{ id: number }>`
    update orbit.job_runs
       set status = 'error', error = 'died with the isolate', finished_at = ${now()}::timestamptz,
           duration_ms = (extract(epoch from (${now()}::timestamptz - started_at)) * 1000)::int
     where status = 'running' and started_at < ${now()}::timestamptz - interval '10 minutes'
     returning id`;
  if (swept.length) s.swept = swept.length;

  let heavy = 0;
  const once = new Set<string>();
  const closed = new Set<QueueName>();
  outer: while (clock() < deadline) {
    for (const q of QUEUES) {
      if (closed.has(q)) continue;
      const batch = await queue.read(q, VT_SEC, BATCH);
      if (!batch.length) continue;
      const readAt = clock();
      // hand messages back right away instead of waiting out their visibility timeout
      const handBack = async (rest: typeof batch) => {
        for (const r of rest) await queue.setVt(q, r.msgId, 0);
      };
      for (let i = 0; i < batch.length; i++) {
        const msg = batch[i]!;
        const kind = parse(msg.message)?.kind;
        // out of time for this kind: it is not started with less than it needs, so it never dies at the wall clock
        const need = (kind ? RESERVE_MS[kind] : undefined) ?? DEFAULT_RESERVE_MS;
        if (clock() + need > deadline) {
          await handBack(batch.slice(i));
          s.stoppedBy = 'budget';
          break outer;
        }
        if (kind && ONCE_PER_TICK.has(kind)) {
          if (once.has(kind)) {
            await handBack(batch.slice(i));
            closed.add(q);
            s.stoppedBy = 'cpu';
            continue outer;
          }
          once.add(kind);
        }
        if (kind && HEAVY_KINDS.has(kind)) {
          if (heavy >= HEAVY_PER_TICK || s.processed >= HEAVY_AFTER_JOBS) {
            // CPU-heavy work waits for a fresh isolate: the rest of this queue is left for the next tick
            await handBack(batch.slice(i));
            closed.add(q);
            s.stoppedBy = 'cpu';
            continue outer;
          }
          heavy++;
        }
        // a message waiting behind slow ones is hidden again before it runs, so the next tick cannot pick it up
        // too and run it twice
        if (clock() - readAt > (VT_SEC * 1000) / 2) await queue.setVt(q, msg.msgId, VT_SEC);
        await runOne(q, msg.msgId, msg.readCt, msg.message);
        s.processed++;
        s.byQueue[q] = (s.byQueue[q] ?? 0) + 1;
      }
      continue outer;
    }
    return s;
  }
  if (clock() >= deadline) s.stoppedBy = 'budget';
  return s;

  async function deadLetter(q: QueueName, msgId: number, message: unknown, error: string) {
    await queue.archive(q, msgId);
    await db.sql`insert into orbit.dead_letters (queue, msg_id, message, error)
      values (${q}, ${msgId}::bigint, ${JSON.stringify(message ?? null)}::jsonb, ${error})`;
    s.deadLettered++;
  }

  async function finish(runId: number, status: 'ok' | 'error' | 'skipped', started: number, error?: string) {
    await db.sql`update orbit.job_runs set status = ${status}, error = ${error ?? null},
      duration_ms = ${Math.round(clock() - started)}::int, finished_at = ${now()}::timestamptz
      where id = ${runId}::bigint`;
  }

  async function runOne(q: QueueName, msgId: number, readCt: number, message: unknown) {
    const started = clock();
    const m = parse(message);
    if (!m) {
      await db.sql`insert into orbit.job_runs (queue, msg_id, kind, status, attempt, error, finished_at, duration_ms)
        values (${q}, ${msgId}::bigint, 'invalid', 'error', ${readCt}::int, 'malformed message', ${now()}::timestamptz, 0)`;
      await deadLetter(q, msgId, message, 'malformed message');
      s.failed++;
      return;
    }
    const job: Job = { ...m, queue: q, msgId, readCt };
    if (readCt > MAX_READS_UNFINISHED) {
      await record('error', 'never finished');
      await deadLetter(q, msgId, message, `read ${readCt} times without finishing`);
      s.failed++;
      return;
    }

    if (m.dedupeKey) {
      const dup =
        await db.sql`select 1 from orbit.job_runs where dedupe_key = ${m.dedupeKey} and status = 'ok'
        and finished_at > ${now()}::timestamptz - interval '24 hours' limit 1`;
      if (dup.length) {
        await queue.delete(q, msgId);
        await record('skipped', 'duplicate');
        s.skipped++;
        return;
      }
    }
    if (m.userId) {
      const live =
        await db.sql`select 1 from orbit.users where id = ${m.userId}::uuid and deleted_at is null`;
      if (!live.length) {
        await queue.delete(q, msgId);
        await record('skipped', 'user_gone');
        s.skipped++;
        return;
      }
    }
    const handler = handlers[m.kind];
    if (!handler) {
      await record('error', 'unknown kind');
      await deadLetter(q, msgId, message, `unknown kind ${m.kind}`);
      s.failed++;
      return;
    }

    const [run] = await db.sql<{ id: number | string }>`
      insert into orbit.job_runs (queue, msg_id, user_id, kind, dedupe_key, status, attempt, started_at)
      values (${q}, ${msgId}::bigint, ${m.userId}::uuid, ${m.kind}, ${m.dedupeKey ?? null}, 'running', ${readCt}::int,
              ${now()}::timestamptz)
      returning id`;
    const runId = Number(run!.id);
    try {
      await handler(job, { db, queue, now });
      await queue.delete(q, msgId);
      await finish(runId, 'ok', started);
      s.ok++;
      await log.log({
        fn: 'orbit-worker',
        kind: m.kind,
        status: 'ok',
        duration_ms: clock() - started,
        userId: m.userId,
      });
    } catch (e) {
      if (e instanceof NotImplemented || e instanceof JobSkipped) {
        await queue.delete(q, msgId);
        await finish(runId, 'skipped', started, e instanceof JobSkipped ? e.reason : 'not_implemented');
        s.skipped++;
        await log.log({
          fn: 'orbit-worker',
          kind: m.kind,
          status: 'skipped',
          duration_ms: 0,
          userId: m.userId,
        });
        return;
      }
      const paid = isPaidError(e);
      const err = short(e);
      await finish(runId, 'error', started, paid ? `${PAID_ERROR_PREFIX}${err}`.slice(0, 500) : err);
      s.failed++;
      // paid failures of this message so far, this one included
      const paidFailures = paid
        ? Number(
            (
              await db.sql<{ n: number | string }>`
                select count(*)::int as n from orbit.job_runs
                 where queue = ${q} and msg_id = ${msgId}::bigint and status = 'error'
                   and error like ${`${PAID_ERROR_PREFIX}%`}`
            )[0]?.n ?? 0,
          )
        : 0;
      if (readCt > MAX_READS || paidFailures > ATTEMPTS_AFTER_SPEND) await deadLetter(q, msgId, message, err);
      else await queue.setVt(q, msgId, backoffSec(readCt));
      await log.log({
        fn: 'orbit-worker',
        kind: m.kind,
        status: 'error',
        duration_ms: clock() - started,
        userId: m.userId,
        error: e instanceof Error ? e.name : 'error',
      });
    }

    async function record(status: 'skipped' | 'error', error: string) {
      await db.sql`insert into orbit.job_runs (queue, msg_id, user_id, kind, dedupe_key, status, attempt, error,
          finished_at, duration_ms)
        values (${q}, ${msgId}::bigint, ${m!.userId}::uuid, ${m!.kind}, ${m!.dedupeKey ?? null}, ${status},
                ${readCt}::int, ${error}, ${now()}::timestamptz, 0)`;
    }
  }
}

export interface WorkerHttpDeps {
  cronSecret: string | undefined;
  db: Db | undefined;
  /** runs one tick (bound to the database and handlers) */
  tick: (db: Db) => Promise<TickSummary>;
  /** EdgeRuntime.waitUntil when available: answer at once and keep draining in the background */
  waitUntil?: (p: Promise<unknown>) => void;
  log?: Logger;
}

/** POST from pg_cron with `x-orbit-cron: <ORBIT_CRON_SECRET>`. */
export function makeWorkerHandler(deps: WorkerHttpDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? silentLogger;
  return async (req) => {
    const started = Date.now();
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');
      if (!deps.cronSecret || !deps.db)
        return unconfigured({}, [
          ...(deps.cronSecret ? [] : ['ORBIT_CRON_SECRET']),
          ...(deps.db ? [] : ['SUPABASE_DB_URL']),
        ]);
      if (!(await timingSafeEqual(req.headers.get('x-orbit-cron'), deps.cronSecret)))
        throw new HttpError(401, 'unauthorized', 'not the scheduler');
      await req.body?.cancel();
      const db = deps.db;
      const run = deps.tick(db).then(async (summary) => {
        await log.log({
          fn: 'orbit-worker',
          route: 'tick',
          status: summary.stoppedBy,
          duration_ms: Date.now() - started,
        });
        return summary;
      });
      if (deps.waitUntil) {
        deps.waitUntil(run.catch(() => undefined));
        return json(202, { started: true });
      }
      return json(200, await run);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message } });
      await log.log({
        fn: 'orbit-worker',
        route: 'tick',
        status: 'exception',
        duration_ms: Date.now() - started,
      });
      return json(500, { error: { code: 'internal', message: 'tick failed' } });
    }
  };
}
