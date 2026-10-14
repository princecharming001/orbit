/**
 * orbit-worker entry: called every minute by pg_cron (orbit.cron_call_worker) with the x-orbit-cron header.
 * Bundled into dist/index.js by scripts/build-functions.mjs. Deploy with verify_jwt off.
 */
import { makeClaude } from '../_shared/claude.ts';
import { connectDb } from '../_shared/db.ts';
import { googleTokenSource } from '../_shared/google.ts';
import { makeLogger } from '../_shared/http.ts';
import { resolveSecret } from '../_shared/secrets.ts';
import { sqlVault } from '../_shared/vault.ts';
import type { HandlerDeps } from './handlers/deps.ts';
import { DEFAULT_BUDGET_MS, defaultHandlers, makeWorkerHandler, runTick } from './worker.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const dbUrl = env('SUPABASE_DB_URL');
const budget = Number(env('ORBIT_WORKER_BUDGET_MS'));
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');
const log = makeLogger(salt);
const runtime = typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : undefined;
const db = dbUrl ? connectDb(dbUrl, 2) : undefined;
const cronSecret = await resolveSecret(env, db, 'ORBIT_CRON_SECRET', 'orbit_cron_secret');

// the ingestion handlers: a provider whose secrets are missing ends its jobs as skipped
const googleId = env('ORBIT_GOOGLE_CLIENT_ID');
const googleSecret = env('ORBIT_GOOGLE_CLIENT_SECRET');
const handlerDeps: HandlerDeps = {
  google:
    db && googleId && googleSecret
      ? googleTokenSource(
          { clientId: googleId, clientSecret: googleSecret, redirectUri: '' },
          { db, vault: sqlVault(db) },
        )
      : undefined,
  gmailTopic: env('GMAIL_PUBSUB_TOPIC'),
  unipile: { apiKey: env('UNIPILE_API_KEY'), baseUrl: env('UNIPILE_BASE_URL') },
  claude: makeClaude({ apiKey: env('ORBIT_ANTHROPIC_API_KEY'), db }),
};
const handlers = defaultHandlers(handlerDeps);

Deno.serve(
  makeWorkerHandler({
    cronSecret,
    db,
    tick: (db) =>
      runTick({
        db,
        log,
        handlers,
        budgetMs: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_MS,
      }),
    waitUntil: runtime ? (p) => runtime.waitUntil(p) : undefined,
    log,
  }),
);
