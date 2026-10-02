# 02. Architecture, stack and conventions

Status: build specification, foundation document. Every other document under `docs/orbit/` uses the package names, event names, environment names, roles and conventions defined here. If a later document contradicts this one on a *name*, this one wins.

---

## 1. Shape of the system

Orbit is one Next.js application (UI + API routes + webhook receivers) backed by one Postgres database (Supabase), with all asynchronous work run as Inngest functions served from the same application. There is no separate worker service in v1; the Inngest functions live in their own package and are mounted at `/api/inngest`. Third-party systems are reached only through adapters in `packages/integrations`. The AI layer (`packages/ai`) is the only code that calls the Claude API or the embeddings API. Pure domain logic (entity resolution, scoring, graph algorithms, the stage state machine) is in `packages/core` and has no I/O, so it is unit-tested exhaustively.

```
                 ┌────────────────────────────────────────────────────────────┐
  browser ──────▶│ apps/web (Next.js 15, App Router)                          │
                 │  • pages + server components + server actions              │
                 │  • /api/webhooks/* (Gmail Pub/Sub, Resend inbound, Granola,│
                 │    Unipile, Google OAuth callback)                          │
                 │  • /api/inngest (serves packages/jobs functions)           │
                 └───────┬───────────────┬───────────────────┬────────────────┘
                         │               │                   │
                 packages/core    packages/ai         packages/integrations
                 (pure logic)     (Claude, Voyage,    (gmail, gcal, google-oauth,
                                   prompts, evals)     linkedin-csv, pdl, coresignal,
                                                       unipile, granola, resend, storage)
                         │               │                   │
                 ┌───────▼───────────────▼───────────────────▼────────────────┐
                 │ packages/db (Drizzle schema + SQL migrations)              │
                 │ Supabase Postgres (+pgvector, pg_trgm, citext, pgcrypto)   │
                 │ Supabase Auth · Storage · Realtime                          │
                 └────────────────────────────────────────────────────────────┘
   Inngest Cloud ──(HTTP step calls)──▶ /api/inngest
   Google Pub/Sub ──(push)──▶ /api/webhooks/gmail
   Resend ──(email.received)──▶ /api/webhooks/resend
   Granola ──(note.generated)──▶ /api/webhooks/granola
```

Why this shape [DECIDED]: one deployable, one database, one job system, and the LLM-heavy fan-out (per-user sync, per-thread classification, per-suggestion drafting) maps directly onto Inngest's event-driven steps with per-user concurrency keys. Alternatives rejected: a Python ML service (second language, second deploy, nothing in v1 needs Python), Neo4j (ego networks are under 5k nodes; Postgres plus in-memory graph algorithms suffice), Trigger.dev (fine, but worker-based compute is only needed if single jobs run for many minutes; backfills are chunked into steps instead).

---

## 2. Stack (fixed)

| Layer | Choice | Version / notes |
|---|---|---|
| Language | TypeScript, `strict: true`, ESM | TS 5.x, Node 22 LTS |
| Monorepo | pnpm workspaces + Turborepo | `pnpm` 9 |
| Web | Next.js 15 (App Router, React 19, Server Actions, Route Handlers) | deployed on Vercel, Fluid compute, Pro plan (needed for `maxDuration` up to 300 s on route handlers) [DEFAULT] |
| UI | Tailwind CSS 4, shadcn/ui (Radix primitives), lucide icons, Inter via `next/font` | design tokens in `apps/web/src/styles/tokens.css` |
| Client state | TanStack Query 5 for server data; Zustand for map UI state only | |
| Forms / validation | react-hook-form + Zod 3 | Zod schemas shared from `packages/core/src/schemas` |
| Graph rendering | `react-force-graph-2d` (Canvas) with custom orbit layout from `packages/core/src/graph/layout.ts`; `d3-force` for the Reach view | see `06` section 7 |
| Database | Supabase Postgres (15+) with extensions `vector`, `pg_trgm`, `citext`, `pgcrypto`, `unaccent` | pgvector HNSW indexes [RESEARCHED] |
| ORM / migrations | Drizzle ORM + `drizzle-kit generate` SQL migrations in `packages/db/migrations` | migrations are hand-reviewed SQL; RLS policies and functions live in migration files, not in Drizzle schema |
| Auth | Supabase Auth, Google provider, scopes `openid email profile` only | Supabase does not persist provider refresh tokens, so Gmail/Calendar use a separate OAuth flow [RESEARCHED] |
| Jobs | Inngest (Cloud) functions in `packages/jobs`, served at `/api/inngest` | free tier 50k executions/month; Pro $99/month [RESEARCHED] |
| LLM | Anthropic TypeScript SDK `@anthropic-ai/sdk`; model `claude-opus-5-5` for every task; structured outputs via `client.messages.parse` + `zodOutputFormat`; prompt caching; Message Batches for backfill | pricing $4 / $20 per MTok, cache reads $0.20 [RESEARCHED]; see `05` |
| Embeddings | Voyage AI `voyage-4`, 1024 dimensions | $0.06 per 1M tokens, first 200M free [RESEARCHED] |
| Email out | Resend (transactional: brief, notifications, recap) | Pro $20/month at 50k emails [RESEARCHED] |
| Email in | Resend Receiving on subdomain `in.<domain>`; `email.received` webhook then Received Emails API | counts against the sending quota [RESEARCHED] |
| Enrichment | People Data Labs (primary), Coresignal (secondary) behind one provider interface | see `04` section 3 |
| LinkedIn messaging | Unipile hosted auth, behind flag `linkedin_messaging`, v1.5 | see `04` section 3.4 |
| Meeting notes | Granola public API + webhooks (Business plan), share-by-email ingest, Fathom webhooks (free), manual | see `04` section 5 |
| Observability | Sentry (errors, traces), PostHog (product analytics, feature flags are *not* used; see 7), Langfuse (LLM traces, prompt versions, cost) | |
| Testing | Vitest (unit, integration), Playwright (e2e), eval harness in `packages/ai/evals` | see `11` |
| Lint / format | Biome | one config at repo root |

---

## 3. Repository layout

```
orbit/                       (new repo, or this repo's root once the product starts; see 12 section 1)
  apps/
    web/
      src/app/               Next.js routes (see 09 section 2)
      src/components/
      src/lib/               server helpers (auth, scope, db client, resend)
      src/styles/
      public/
  packages/
    core/                    pure domain logic, no I/O
      src/schemas/           Zod schemas shared everywhere (Person, Chat, Suggestion, ...)
      src/entity-resolution/
      src/scoring/           strength, fit, priority
      src/graph/             edges, paths, orbit layout
      src/pipeline/          stage state machine
      src/text/              normalisers (names, emails, companies, LinkedIn URLs)
    ai/
      src/client.ts          Anthropic + Voyage clients, retry, cost accounting
      src/tasks/<task>/      prompt.ts, schema.ts, run.ts per task (see 05)
      src/prompts/           versioned prompt files (markdown) + registry
      evals/                 datasets (JSONL) + runners
    integrations/
      src/google/            oauth, gmail, gcal, pubsub
      src/linkedin-csv/
      src/enrichment/        provider interface, pdl, coresignal, cache
      src/unipile/
      src/granola/
      src/fathom/
      src/resend/
      src/storage/           Supabase Storage helpers
    jobs/
      src/client.ts          Inngest client + event schemas
      src/functions/<domain>/*.ts
    db/
      src/schema/*.ts        Drizzle tables (one file per domain)
      src/index.ts           db client factory (service connection)
      migrations/            SQL, numbered 0000_...
      seeds/                 schools, organizations seed, enums
  supabase/
    config.toml              local dev
  docs/orbit/                this plan
  biome.json  turbo.json  pnpm-workspace.yaml  package.json  .env.example
```

---

## 4. Environments

| Name | Web | Database | Jobs | Secrets |
|---|---|---|---|---|
| `local` | `next dev` on :3000 | `supabase start` (Docker) with migrations applied by `pnpm db:migrate` | `npx inngest-cli dev` on :8288 | `.env.local` from `.env.example` |
| `preview` | Vercel preview per PR | Supabase branch per PR (Supabase Branching) | Inngest branch environment (auto from Vercel integration) | Vercel env (preview) |
| `prod` | Vercel production | Supabase production project | Inngest production | Vercel env (production) |

Google OAuth, Resend, Granola and Unipile webhooks point at `prod` and at one stable staging URL (`staging.<domain>`, a Vercel production-like deployment of `main`) only; previews use recorded fixtures.

Environment variables (complete list; every one must be present in `.env.example` with a comment):

```
DATABASE_URL                      # Supabase pooler, transaction mode, service role user
DATABASE_DIRECT_URL               # direct connection for migrations
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_APP_URL
TOKEN_ENCRYPTION_KEY              # 32 bytes base64; AES-256-GCM for OAuth tokens and API keys
TOKEN_ENCRYPTION_KEY_PREVIOUS     # optional, for rotation
GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_PUBSUB_TOPIC               # projects/<p>/topics/gmail-push
GOOGLE_PUBSUB_PUSH_AUDIENCE       # OIDC audience for push auth
ANTHROPIC_API_KEY
VOYAGE_API_KEY
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY
RESEND_API_KEY, RESEND_WEBHOOK_SECRET, RESEND_FROM_DOMAIN, RESEND_INBOUND_DOMAIN
PDL_API_KEY
CORESIGNAL_API_KEY                # optional
UNIPILE_DSN, UNIPILE_API_KEY, UNIPILE_WEBHOOK_SECRET   # optional, flag linkedin_messaging
GRANOLA_WEBHOOK_SECRET            # per-user secrets are stored in integration_accounts; this is unused unless Granola offers app-level webhooks
SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
FEATURE_FLAGS_OVERRIDE            # JSON, optional, e.g. {"linkedin_messaging":true}
```

---

## 5. Conventions

### 5.1 Database

- Table names: `snake_case`, plural. Primary key `id uuid default gen_random_uuid()`. Every user-scoped table has `user_id uuid not null references users(id) on delete cascade` as its second column and an index that starts with `user_id`.
- Timestamps are `timestamptz`; every table has `created_at` and `updated_at` (trigger `set_updated_at()`).
- Enums are Postgres enums named `<thing>_enum`; values are `snake_case`. Enum changes are additive in migrations.
- JSON columns are `jsonb`, always validated by a Zod schema in `packages/core/src/schemas` before write; the schema name is noted in a column comment.
- Soft delete only where the spec says (`archived_at`, `hidden_at`); otherwise hard delete with cascade.
- RLS is enabled on every table. Policies: `authenticated` role may `select` rows where `user_id = auth.uid()` on tables listed in `03` section 2.3 (used by Supabase Realtime and nothing else); all writes go through the server with the service connection. The service connection bypasses RLS, so every repository function takes a `scope: UserScope` and adds `where user_id = scope.userId`; a lint rule (`packages/db/src/lint-scope.test.ts`) fails the build if a query on a user-scoped table lacks it.
- Global tables (no `user_id`): `organizations`, `organization_aliases`, `schools`, `enrichment_cache`, `prompt_versions`, `feature_flags`.
- Vectors: one table `embeddings` with `vector(1024)` and HNSW (`vector_cosine_ops`); never a vector column on a domain table.

### 5.2 Identifiers in code

- Packages import each other only downward: `web → jobs → integrations/ai → core → (nothing)`; `db` is imported by `web`, `jobs`, `integrations`, `ai`. `core` never imports `db`.
- Every server entry point (route handler, server action, Inngest function) resolves a `UserScope` first and passes it down. No module-level database access.
- Money is stored in integer micro-dollars (`cost_usd_micros bigint`). Tokens are integers.

### 5.3 Events (Inngest)

Names are `orbit/<domain>.<thing>.<verb-past-or-noun>`. Every event has a Zod schema in `packages/jobs/src/events.ts` and carries `userId` unless global. Idempotency keys are set on events that can be re-emitted (webhooks). Full catalogue in `08`.

### 5.4 Feature flags

Table `feature_flags (key text primary key, enabled boolean, user_allowlist uuid[] default '{}', note text)` read once per request with a 60 s in-memory cache, overridable by `FEATURE_FLAGS_OVERRIDE`. Flags in v1: `linkedin_messaging`, `granola_api`, `fathom`, `wispr_mcp`, `pooled_graph`, `web_push`, `enrichment_coresignal`. No third-party flag service.

### 5.5 Errors and logging

- Every integration call is wrapped by `withIntegration(provider, fn)` which records latency, outcome and a sanitised error to Sentry breadcrumbs and to `sync_runs.stats` where applicable; tokens and bodies are never logged.
- LLM calls go through `runTask()` in `packages/ai`, which writes `ai_calls` rows and a Langfuse trace with the prompt version and the user id (hashed).
- User-facing errors are typed (`OrbitError` with `code` from a closed list) and mapped to copy in `apps/web/src/lib/errors.ts`.

### 5.6 Time

All scheduling is in the user's `timezone` (IANA). The hourly brief tick computes, for each user, whether `now` in their timezone falls in the hour of `brief_time_local - 60 min`. Stored timestamps are UTC.

---

## 6. Request and job flows (reference)

| Flow | Entry | Path |
|---|---|---|
| Page load | server component | `getScope()` (Supabase session) → repository reads → render |
| Mutation | server action | `getScope()` → validate (Zod) → repository write → emit event if needed → `revalidatePath` |
| Gmail push | `POST /api/webhooks/gmail` | verify Pub/Sub OIDC token → decode `{emailAddress, historyId}` → `webhook_events` insert (idempotent) → emit `orbit/gmail.push.received` → 204 |
| Resend inbound | `POST /api/webhooks/resend` | verify signature → emit `orbit/note.email.received` with the email id → 200 |
| Granola webhook | `POST /api/webhooks/granola/[accountToken]` | verify per-account secret → emit `orbit/note.granola.received` |
| OAuth callback | `GET /api/oauth/google/callback` | state check → token exchange → encrypt + store → emit `orbit/google.connected` → redirect |
| Approve & send | server action `approveSuggestion` | bind body hash → `outbound_messages.status='approved'` → emit `orbit/message.send` with `delaySeconds: 60` (undo window) |
| Nightly brief | Inngest cron hourly | fan out `orbit/brief.generate` per user in window → steps (see `08` section 4) |

---

## 7. What is deliberately not in the stack

No Redis (Inngest handles queues and rate limiting; Postgres handles everything else). No GraphQL or tRPC (server actions and typed repositories are enough for one app). No Python. No Neo4j. No LaunchDarkly. No separate design system package until a second app exists.
