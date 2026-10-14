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
import { QUEUES, type Queue, type QueueName, sqlQueue } from '../_shared/queue.ts';
import type { AgentConfig } from '../_shared/services.ts';
import { agentHandlers } from './handlers/agents.ts';
import { calendarHandlers } from './handlers/calendar.ts';
import { classifyHandlers } from './handlers/classify.ts';
import { contactsHandlers } from './handlers/contacts.ts';
import { type HandlerDeps, JobSkipped } from './handlers/deps.ts';
import { gmailHandlers } from './handlers/gmail.ts';
import { linkedinHandlers } from './handlers/linkedin.ts';
import { scoreHandlers } from './handlers/score.ts';

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
    'env' in opts ? { fetch: opts.fetch, sleep: opts.sleep, random: opts.random } : opts;
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
    ...classifyHandlers(deps, agents),
    ...agentHandlers(agents),
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
export const DEFAULT_BUDGET_MS = 110_000;

export const backoffSec = (readCt: number) => 30 * 2 ** Math.max(0, readCt - 1);

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
  stoppedBy: 'empty' | 'budget';
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

  outer: while (clock() < deadline) {
    for (const q of QUEUES) {
      const batch = await queue.read(q, VT_SEC, BATCH);
      if (!batch.length) continue;
      for (let i = 0; i < batch.length; i++) {
        const msg = batch[i]!;
        if (clock() >= deadline) {
          // out of time: hand the rest back right away instead of waiting out their visibility timeout
          for (const rest of batch.slice(i)) await queue.setVt(q, rest.msgId, 0);
          s.stoppedBy = 'budget';
          break outer;
        }
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
      const err = short(e);
      await finish(runId, 'error', started, err);
      s.failed++;
      if (readCt > MAX_READS) await deadLetter(q, msgId, message, err);
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
