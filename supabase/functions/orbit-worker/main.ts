/**
 * orbit-worker entry: called every minute by pg_cron (orbit.cron_call_worker) with the x-orbit-cron header.
 * Bundled into dist/index.js by scripts/build-functions.mjs. Deploy with verify_jwt off.
 */
import { connectDb } from '../_shared/db.ts';
import { makeLogger } from '../_shared/http.ts';
import { DEFAULT_BUDGET_MS, makeWorkerHandler, runTick } from './worker.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const dbUrl = env('SUPABASE_DB_URL');
const budget = Number(env('ORBIT_WORKER_BUDGET_MS'));
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');
const log = makeLogger(salt);
const runtime = typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : undefined;

Deno.serve(
  makeWorkerHandler({
    cronSecret: env('ORBIT_CRON_SECRET'),
    db: dbUrl ? connectDb(dbUrl, 2) : undefined,
    tick: (db) =>
      runTick({ db, log, budgetMs: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_MS }),
    waitUntil: runtime ? (p) => runtime.waitUntil(p) : undefined,
    log,
  }),
);
