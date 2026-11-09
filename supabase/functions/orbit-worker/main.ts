/**
 * orbit-worker entry: called every minute by pg_cron (orbit.cron_call_worker) with the x-orbit-cron header.
 * Bundled into dist/index.js by scripts/build-functions.mjs. Deploy with verify_jwt off.
 */
import { batchFlagOn, makeClaude } from '../_shared/claude.ts';
import { connectDb } from '../_shared/db.ts';
import { googleTokenSource } from '../_shared/google.ts';
import { makeLogger } from '../_shared/http.ts';
import { providerSecret, resolveSecret } from '../_shared/secrets.ts';
import { agentEnvWithSecrets, makeMailer } from '../_shared/services.ts';
import { sqlVault } from '../_shared/vault.ts';
import { DEFAULT_COST_THRESHOLDS } from './handlers/cost.ts';
import type { HandlerDeps } from './handlers/deps.ts';
import { parkDays } from './handlers/unipile.ts';
import { DEFAULT_BUDGET_MS, defaultHandlers, makeWorkerHandler, runTick } from './worker.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const dbUrl = env('SUPABASE_DB_URL');
const budget = Number(env('ORBIT_WORKER_BUDGET_MS'));
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');
const log = makeLogger(salt);
const runtime = typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : undefined;
const db = dbUrl ? connectDb(dbUrl, 2) : undefined;
// the agent features' keys (Claude, Exa, ...): a function secret, else the copy in orbit_private.secrets
const agentEnv = await agentEnvWithSecrets(env, db);
const cronSecret = await resolveSecret(env, db, 'ORBIT_CRON_SECRET', 'orbit_cron_secret');

// Claude for the reply jobs (classify.message and its rapport reading, rapport.backfill; Haiku, low effort): the
// function secret when set, else the key Orbit's chat proxy reads from orbit_private.secrets. Only these jobs get it:
// drafting and research read theirs through agentEnv. Spend goes through the per-user ledger and caps.
// Unipile (LinkedIn sync) the same way.
// ORBIT_LINKEDIN_PARK_DAYS (plan 35 E5): days away before a student's LinkedIn link is parked; unset is 21, 0 is off.
// A function secret, else orbit_private.secrets, so it can be turned off without a redeploy.
const [claudeKey, unipileKey, unipileBase, ownerId, parkRaw] = await Promise.all([
  providerSecret(env, db, 'ORBIT_ANTHROPIC_API_KEY'),
  providerSecret(env, db, 'UNIPILE_API_KEY'),
  providerSecret(env, db, 'UNIPILE_BASE_URL'),
  providerSecret(env, db, 'ORBIT_OWNER_ID'),
  providerSecret(env, db, 'ORBIT_LINKEDIN_PARK_DAYS'),
]);

// the daily cost digest (plan 34 E2): thresholds from the environment, the owner's email through Resend when set
const limit = (name: string, fallback: number) => {
  const v = Number(env(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const costThresholds = {
  anthropicUsdDay: limit('ORBIT_COST_ANTHROPIC_USD_DAY', DEFAULT_COST_THRESHOLDS.anthropicUsdDay),
  hunterMonthCredits: limit('ORBIT_COST_HUNTER_MONTH_CREDITS', DEFAULT_COST_THRESHOLDS.hunterMonthCredits),
  linkedinShare: limit('ORBIT_COST_LINKEDIN_SHARE', DEFAULT_COST_THRESHOLDS.linkedinShare),
  isolateDeaths: limit('ORBIT_COST_ISOLATE_DEATHS', DEFAULT_COST_THRESHOLDS.isolateDeaths),
  deadLetters: limit('ORBIT_COST_DEAD_LETTERS', DEFAULT_COST_THRESHOLDS.deadLetters),
};

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
  unipile: { apiKey: unipileKey, baseUrl: unipileBase },
  storage: { url: env('SUPABASE_URL'), serviceKey: env('SUPABASE_SERVICE_ROLE_KEY') },
  // the background reading pass (search_reading) batches through it too (plan 35 C2)
  claude: makeClaude({ apiKey: claudeKey, db, batch: batchFlagOn(agentEnv.claudeBatch) }),
  cost: { mailer: makeMailer(agentEnv, fetch), ownerId, thresholds: costThresholds },
  park: { days: parkDays(parkRaw) },
};
const handlers = defaultHandlers({ ...handlerDeps, agents: { env: agentEnv } });

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
