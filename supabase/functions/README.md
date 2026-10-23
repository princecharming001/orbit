# Orbit's Edge Functions

Plan: `docs/plan/16-network-agent-infrastructure.md` (§9, §11–§13, §16, §21), and `docs/plan/20-deep-research.md` for
`orbit-research`. Six functions live here.

| Function | What it is | Source → deployed entry | `verify_jwt` |
|---|---|---|---|
| `orbit-claude` | Shared Claude proxy for local mode | `index.ts` + `proxy.ts`, deployed from source | off (origin + per-IP limits) |
| `orbit-connectors` | Unipile / Village proxy for local mode | `main.ts` + `connectors.ts`, bundled (it imports the shared Village v2 adapter) | off (origin + per-IP limits) |
| `orbit-research` | Deep research on a person for local mode (quick brief, Go deeper, allowance, remove-me) | `main.ts` + `research.ts` → `dist/index.js` ← `index.ts` | off (origin, the LinkedIn account token orbit-connectors issues, counters) |
| `orbit-api` | Account mode: Google sign-in, Orbit sessions, `/sync/*`, `/account/*` | `main.ts` → `dist/index.js` ← `index.ts` | **off**: Orbit sessions are not Supabase JWTs; the function verifies its own HS256 tokens |
| `orbit-worker` | Drains the pgmq queues every minute (pg_cron) | `main.ts` → `dist/index.js` ← `index.ts` | **off**: requires `x-orbit-cron` = `ORBIT_CRON_SECRET` |
| `orbit-webhooks` | Gmail Pub/Sub push, Unipile webhooks | `main.ts` → `dist/index.js` ← `index.ts` | **off**: each route checks its own shared secret |

## Layout and bundling

- `_shared/` holds the pure modules every account-mode function uses: `db.ts` (postgres.js over `SUPABASE_DB_URL`,
  `prepare: false`, behind a small `Db` interface; a PGlite adapter for tests), `http.ts` (CORS, JSON errors, request
  ids, the one-line JSON log of §16 with hashed user ids), `session.ts`, `google.ts`, `vault.ts`, `queue.ts`,
  `budget.ts`, `claude.ts`, `ratelimit.ts`, `crypto.ts`, `origins.ts` (the allowed-origin rule `orbit-claude` and
  `orbit-connectors` also import).
- Each account-mode function has `main.ts` (reads `Deno.env` and calls `Deno.serve`; no logic) and pure modules
  that take their dependencies (db, fetch, clock, env) as arguments.
- `pnpm build:functions` (`scripts/build-functions.mjs`) bundles `main.ts` with esbuild into `dist/index.js`,
  resolving `@orbit/core` (and `@orbit/core/<path>`) to `packages/core/src`, and rewriting npm imports to `npm:`
  specifiers pinned in that function's `deno.json` (the versions must match the root `package.json`, which the tests
  run on). `index.ts`, the entry Supabase deploys, is the generated two-line file that imports the bundle. The bundles
  are committed; CI rebuilds them and fails if `git diff` shows a stale one. **After any change under `_shared/`,
  `orbit-api/`, `orbit-worker/`, `orbit-webhooks/` or the parts of `packages/core` they import, run
  `pnpm build:functions` and commit the result.**
- Tests: `supabase/tests` (workspace package `@orbit/supabase-tests`, run by `pnpm -r test`) applies every migration
  to PGlite over `supabase/tests/stubs.sql` (stand-ins for pgmq, vault, pg_cron, pg_net and the API roles) and tests
  every module with fakes for Google, Unipile and the Anthropic API. `functions/bundles.test.ts` loads each committed
  bundle and checks it answers `unconfigured` with no secrets. The proxy tests for `orbit-claude` and
  `orbit-connectors` stay in `apps/web`.

## Deploy

Run from the repository root, with the Supabase CLI linked to the project (`supabase link --project-ref <ref>`):

```sh
pnpm build:functions                                   # only if the bundles are not current
supabase db push                                       # or apply the two 20261014 migrations (see below)
supabase functions deploy orbit-api --no-verify-jwt
supabase functions deploy orbit-worker --no-verify-jwt
supabase functions deploy orbit-webhooks --no-verify-jwt
```

`orbit-claude` deploys as before (`supabase functions deploy orbit-claude --no-verify-jwt`); it imports `../_shared/origins.ts`, which the CLI bundles with it. `orbit-connectors` is bundled like the account-mode functions (run `pnpm build:functions` first) and deploys with `--no-verify-jwt`. `orbit-research` is bundled the same way and deploys with `supabase functions deploy orbit-research --no-verify-jwt`, after the migration `20261023_orbit_research.sql` is applied.

## Secrets (function environment)

`SUPABASE_URL`, `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. Set the others with
`supabase secrets set NAME=value` (values are never committed). A function whose required secrets are missing answers
503 with `x-orbit-connector: unconfigured` and a `missing` list.

| Name | Used by | Required | Notes |
|---|---|---|---|
| `ORBIT_SESSION_SECRET` | orbit-api | yes | 32 random bytes, base64 (`openssl rand -base64 32`). Signs Orbit access tokens |
| `ORBIT_GOOGLE_CLIENT_ID`, `ORBIT_GOOGLE_CLIENT_SECRET` | orbit-api, orbit-worker | for `/auth/google/*` (H2) and the Google sync jobs | Web OAuth client with redirect URI below. Without them the worker ends Gmail, Calendar and contacts jobs as `skipped` |
| `ORBIT_GOOGLE_REDIRECT_URI` | orbit-api | no | Default `<SUPABASE_URL>/functions/v1/orbit-api/auth/google/callback` |
| `ORBIT_APP_URL` | orbit-api | no | Where sign-in returns (`<app>/auth/done#code=…`). Default `https://tryorbit.today`; `http://localhost:*` is always allowed for development |
| `UNIPILE_API_KEY`, `UNIPILE_BASE_URL` | orbit-api, orbit-worker | for LinkedIn (H5) | Hosted auth (`/linkedin/connect/start`), `/linkedin/sync`, the `sync.linkedin` job and account deletion. Without them LinkedIn routes answer unconfigured and LinkedIn jobs end `skipped` |
| `GMAIL_PUBSUB_TOPIC` | orbit-worker | no (H3) | `projects/<gcp project>/topics/orbit-gmail`; without it no Gmail watch is registered and the 10-minute poll keeps mail current |
| `ORBIT_ANTHROPIC_API_KEY` | orbit-worker | no | Haiku for replies the heuristic classifier is unsure of (§8.6); without it the heuristic answer is kept |
| `ORBIT_API_IP_PER_MINUTE`, `ORBIT_API_USER_PER_MINUTE`, `ORBIT_API_USER_PER_DAY` | orbit-api | no | Defaults 120, 240, 20000 (counters in `public.orbit_proxy_take`) |
| `ORBIT_CRON_SECRET` | orbit-worker | yes | Same value as the Vault secret `orbit_cron_secret` |
| `ORBIT_WORKER_BUDGET_MS` | orbit-worker | no | Default 110000 (free plan); 300000 on a paid plan |
| `ORBIT_PUBSUB_TOKEN` | orbit-webhooks | for `/gmail` (H3) | Also in the Pub/Sub push URL `…/orbit-webhooks/gmail?token=` |
| `ORBIT_UNIPILE_WEBHOOK_SECRET` | orbit-webhooks, orbit-api | for `/unipile*` and `/linkedin/connect/start` (H5) | Header `x-orbit-webhook` on Unipile webhooks, and `?token=` on the hosted-auth `notify_url` |
| `ORBIT_LOG_SALT` | all three | no | Salt for hashed ids in logs and counters; defaults to the tail of the service key |

Later phases add `EXA_API_KEY`, `APOLLO_API_KEY`, `VILLAGE_SECRET_KEY`,
`SEMANTIC_SCHOLAR_API_KEY` and `ORBIT_ADMIN_EMAILS` (§21).

### orbit-connectors (local mode's LinkedIn and Village proxy)

Each of these is read from the function secret first, else from the project's private secrets table (the
service-role-only `orbit_secret` function), once per cold start, so a key can be stored without the dashboard. A route
whose provider is missing answers 503 with `x-orbit-connector: unconfigured`; the app then says "Village isn't set up"
(Settings, Integrations) or "Live sync is switching on soon" instead of showing empty results as if it were on.

| Name | Required | Notes |
|---|---|---|
| `UNIPILE_API_KEY`, `UNIPILE_BASE_URL` | for live LinkedIn | Connect, sync, mutual connections (warm paths), search, send |
| `VILLAGE_SECRET_KEY` | for warm intros | Village v2 app secret key (mints a token per user). `VILLAGE_API_KEY` is the old name, still read |
| `VILLAGE_USER_EMAIL` | for warm intros | The Village account whose network `/paths` searches. **Deployment-wide**: every visitor's lookups return this one person's Village network, so it is only right for a single-student deployment (or the founder's own testing). Per-student Village needs each student's own Village identity (account mode) |
| `VILLAGE_EXTERNAL_USER_ID` | no | The external user id Village provisions for that email. Default `orbit-local` |
| `VILLAGE_BASE_URL` | no | Default `https://api.village.do` |

Without `VILLAGE_SECRET_KEY` (or `VILLAGE_API_KEY`) and `VILLAGE_USER_EMAIL`, `/paths` answers unconfigured. An
empty `/paths` request (`{}`) is the health check the app's Settings row uses: unconfigured, or `{ "paths": [] }` with
no Village call and no credits spent.

## Database, cron and Vault

1. Queues: `20261014_orbit_core.sql` runs `create extension if not exists pgmq` (Supabase Queues). Enable it from the
   dashboard first if the role running migrations may not create it.
2. Apply `20261014_orbit_core.sql`, then `20261014_orbit_cron.sql` (needs `pg_cron` and `pg_net`; both migrations
   can be re-run).
3. Create the two Vault secrets the worker tick reads (SQL editor; values are not committed):

   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'orbit_functions_url');
   select vault.create_secret('<same value as ORBIT_CRON_SECRET>', 'orbit_cron_secret');
   ```

   Until both exist the `orbit-worker-tick` job does nothing.
4. Do not add the `orbit` schema to the Data API's exposed schemas. Functions reach it over `SUPABASE_DB_URL`.

Schedules (`cron.job`): `orbit-worker-tick` every minute, `orbit-incremental` `*/10`, `orbit-cadence` `7 * * * *`,
`orbit-nightly` `13 7 * * *`, `orbit-retention` `23 8 * * *`, `orbit-health` `*/15` (writes `orbit.health()` to
`orbit.audit_log`). Check them with `select jobname, schedule from cron.job where jobname like 'orbit-%'` and the
results in `cron.job_run_details`; queue state with `select * from orbit.v_queue_depth`, failures in
`orbit.dead_letters`.
