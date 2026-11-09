# 34. Cost audit: every paid call, what it costs, and the order to fix it

Status: audit done 2026-11-09 (UTC); phases A to E shipped 2026-11-09 except the items in §10 that wait on Anish or on
a week of C1 numbers. Extends 26 (cost and speed, 2026-10-26) with the work that
landed since: web sourcing (31), network search (32), profile reading (33), the Hunter email finder, the chat proxy's
global and anonymous caps. Written for an Opus 5.5 session to execute top to bottom. Everything in §1 to §4 is measured
or read from the code at main `b6ef0cd` (2026-11-08); nothing is estimated unless the line says so. The full call-site
inventory with line numbers is in `34-cost-audit-inventory.md` next to this file; this document quotes the rows that
matter and gives the plan.

What prompted it: on 2026-11-08 the shared Anthropic key answered "credit balance is too low" (the chat and web sourcing
went dark) and the Hunter free plan was spent in one day. §4 says what each of those actually was.

## 0. Rules for the executor

These are standing rules for this repo. Follow them for every change in §6.

- Work in `/Users/home/orbit-search` (a worktree of `/Users/home/orbit`, on main). Commit as Orbit with no trailers and
  no model names: `git -c user.name=Orbit -c user.email=orbit@users.noreply.github.com commit`.
- Gate before every push: `npx biome check .` (one pre-existing warning is fine), `corepack pnpm@10.28.0 -r typecheck`,
  `TZ=UTC corepack pnpm@10.28.0 -r --no-bail test` (`apps/web/src/__local__/real.test.ts` fails without its data dir and
  is unrelated; a handful of network-mocking web tests fail on this Mac's Node 24 and pass on CI's Node 22). CI e2e is
  the real gate: watch the deploy run after every push.
- Push over HTTPS: `R=https://github.com/princecharming001/orbit.git; H='credential.helper=!gh auth git-credential';
  git -c "$H" fetch -q $R main && git merge-base --is-ancestor FETCH_HEAD HEAD && git -c "$H" push -q $R HEAD:main`.
- When anything under `supabase/functions/_shared` changes, run `corepack pnpm@10.28.0 build:functions` and commit the
  `dist` bundles (CI's "Edge Function bundles are current" step fails otherwise).
- Deploy an edge function through the Supabase MCP `deploy_edge_function` (project `nxibeiykcgxpbmkeadth`) with
  `index.ts` as one line importing `https://cdn.jsdelivr.net/gh/princecharming001/orbit@<sha>/supabase/functions/<fn>/dist/index.js`,
  the function's `deno.json` as the import map, `verify_jwt: false`. Deploy only after the push that holds `<sha>` is on
  main and CI is green.
- Migrations are additive only, applied with `apply_migration`, committed under `supabase/migrations/` with the same
  name. Never print or commit a secret: secrets live in `orbit_private.secrets` and are read through
  `public.orbit_secret(...)`. Never commit `private/`, `docs/research/`, `apps/web/src/__local__/`, `docs/qa/chat-runs`.
- No em dashes and no exclamation marks in UI text or in plan text.
- Never push, deploy or spend money without the gate passing. Ask Anish before any change that could reduce answer
  quality for students (the ones marked DECISION in §6 and listed in §8). Everything else in §6 is yours to do.
- Each phase is shippable on its own. Measure before (the §7 queries) and after, and write both numbers into §7 of this
  file in the same commit as the change.

## 1. What the numbers say today

Production on 2026-11-09 00:45 UTC: 1 user (Anish, `390cf6d9`), 7,715 people, 6,536 with a LinkedIn member id, one Google
and one LinkedIn account, database 234 MB in a Supabase project (`general`, org `Unicorn`, Pro plan, pay as you go) that
Orbit shares with four other apps (`vs-api`, `vs-thumbs`, `reps-api`, `raisin-api`, `daily-news`). Repo public on GitHub.

### 1.1 Dollars recorded, by provider

| Provider | Where recorded | Since | Total | Last day (11-08) | Per unit |
|---|---|---|---|---|---|
| Anthropic, chat through `orbit-claude` | `public.orbit_proxy_spend` | 10-22 | $9.38 (507 requests): signed-in browser `client:` rows $6.14 over 382 requests, anonymous `ipday:` rows $3.24 over 125 requests (11-07 and 11-08 only) | $4.29 (166 requests) | $0.016 to $0.028 a request |
| Anthropic, server tasks | `orbit.usage_ledger` provider `anthropic` | 10-30 | $0.18: `classify` 1,874 calls $0.12 (the 10-30 Gmail backfill), `fit` 9 calls $0.006, `reading` 3 calls $0.003, `sourcing_web` 1 call $0.049 (5 web searches) | $0.06 | Haiku calls cost $0.00004 to $0.0008 |
| Anthropic, deep research | `public.orbit_research_runs` | 10-27 | $0.116, 1 run | 0 | $0.12 a quick brief |
| Hunter | `orbit.usage_ledger` provider `hunter` | 11-08 | 7 `find` rows (successes only) | 7 | free plan, 50 credits a month |
| Unipile | ledger rows `unipile/search` 4; LinkedIn ledgers in `public.orbit_proxy_counters` | 10-30 | subscription, $55 a month for up to 10 accounts | 11-09 so far: company 71 of 150, profile 14 of 100, search 13 of 100 | flat |
| Exa, Apollo, Parallel, Serper, Village, Resend | no keys set (`orbit_private.secrets` holds only Anthropic, Unipile, Hunter, Village ids) | | $0 | | |
| Google APIs | quota only | | $0 | | |
| Supabase | shared project, Pro $25 a month plus compute | | Orbit's share not separable | Orbit edge invocations last 24 h: orbit-api 425, orbit-worker 369, orbit-connectors 84, orbit-claude 67, orbit-notes 6, orbit-research 5 (956; the other apps 1,564) | 2M invocations a month included |
| GitHub Actions | public repo | 10-10 | 293 runs in 24 days at about 57 runner minutes each (checks 12 to 15, e2e shards 6 to 13 each, perf 2, build 1); 74 cancelled, 91 failed | | free on a public repo |

Read together: Orbit's recorded Anthropic spend is about $9.70 in 18 days, with a single-day peak of $4.35. The key that ran
out on 11-08 is shared with other work; Orbit's own 18-day total would not empty a $20 balance. §4.1 has the detail.

### 1.2 Work done, by job (from `orbit.job_runs`, 5,529 rows since 10-15)

| Kind | Runs on 11-08 | Wall time 11-08 | Errors since 10-30 | What it says |
|---|---|---|---|---|
| `sync.linkedin` | 192 | 10,701 s (3.0 h of worker time) | 64 (9 isolate deaths, read counts up to 51) | one full re-walk of 7,500 relations and two years of chats, 60 Unipile requests a job, because a sync was asked more than 20 h after the last pass |
| `score.page` | 89 | 24,707 s counted (includes orphans) | 84 of 222 runs; 38 "died with the isolate" on 11-08; 26 dead letters | pure CPU work under the 2 s CPU limit per request; a page of 300 people often does not finish |
| `sync.gmail.incremental` + `sync.calendar` | 73 + 73 | 79 s | 3 | a poll every 20 min (10-min cron, every other slot suppressed by `last_synced_at`); calendar re-lists 730 days back every night |
| `cadence.user` | 24 | 12 s | 0 | hourly for every user, loads a year of messages each time |
| `search_reading` | 15 | 92 s | 1 (unipile 502) | every 2 h, no "anything unread" filter |
| `search_census` | 8 | 102 s | 0 | 40 search pages a day; pass at 520 of about 6,500 seen after 25 h |
| `classify.message` | 32 | 76 s | 3 | fine |
| `company_facts_sync` | 6 | 15 s | 3 (regex, fixed 11-08) | free |

Other measured facts: worker invocations 367 a day (was 1,437 before plan 26's tick guard), average 2.9 s; `CPU Time
exceeded` 47 times in 24 h, all in `orbit-worker`; `cron.job_run_details` 84,811 rows, 15 MB, never purged (two
every-minute ticks, Orbit's and `vs-worker-tick`); `orbit.health_snapshot` 96 audit rows a day kept two years; the
research cache has 19 rows; `orbit.profile_reads` 26 rows, `orbit_private.company_pages` 14, `facet_assertions` 476;
`people.summary` filled for 21 of 7,715 people; 83 `people.merge` audit rows in 30 days (duplicate people are real).

### 1.3 Cost model: now, 10 students, 100 students

Assumptions for the projections (estimates, stated once): an active student sends 10 chat turns a day at the measured
$0.025 a turn; background Haiku work stays under $0.03 a student a day; each student connects LinkedIn (Unipile bills per
account) and Google; the Hunter cap stays at 10 credits a student a day and half of it is used.

| Line | Now (1 user, dev-heavy) | 10 students | 100 students | What moves it |
|---|---|---|---|---|
| Anthropic chat (Opus 5.5 through the proxy) | $15 to $30 a month | about $75 | about $750 | iterations per turn, tool list per request, cache hit rate, web searches, effort, model |
| Anthropic server tasks (Haiku, Opus compose, Sonnet brief) | under $1 | about $10 | about $100 | compose per draft on Opus, reading batches, research |
| Unipile | $55 (1 of 10 accounts used) | $55 | $550 ($55 + 90 × $5.50) | accounts, including orphaned ones after reconnects |
| Hunter | $0 (free, exhausted) | up to 1,500 credits a month: Starter $49 is 2,000 | up to 15,000: Scale $299 | per-run limits, a global monthly cap, a cheaper verifier |
| Supabase | $25 shared, Micro compute | $25 + Small compute $15 | $25 + Medium compute $60 and 8 GB disk | worker CPU, pgmq churn, polls |
| Exa, Serper, Parallel (optional keys) | $0 | $0 to $5 (free tiers) | $20 to $50 | searches per sourcing run |
| GitHub Actions | $0 (public) | $0 | $0; about $100 a month if the repo goes private at 57 min a run | shards, Playwright installs, cancelled runs |
| Total | about $95 to $110 | about $230 to $280 | about $1,900 to $2,100 | |

The variable line that matters is chat. The fixed line that matters is Unipile. Hunter is the one that goes from free to a
plan the moment a second student uses the email finder.

## 2. Inventory of paid and metered calls

The companion file has 120 rows with file and line, trigger, frequency, cap, cache, duplicate risk and retry policy for
every call site in the browser, the edge functions and the crons. This section is the condensed view the plan refers to.
Ids are the companion's (A browser Claude, U browser LinkedIn, V Village, G Google, S orbit-api routes; B server Claude,
C direct Claude, D Exa, E Hunter, F Apollo, G Unipile server, H Village server, I Semantic Scholar, J Parallel and Serper;
W worker jobs, X crons).

| Id | Call | Trigger | Bound today | Cached | Twice for one answer | Cost |
|---|---|---|---|---|---|---|
| A1 | chat turn, `apps/web/src/chat/agent/loop.ts:428`, Opus 5.5, `MAX_ITERATIONS = 12`, `MAX_TOKENS = 16_000`, effort `medium` (`low` in Quick), every registry tool plus `web_search` (`max_uses` 3) on every request | each chat message | proxy: $20 a subject a day, $10 anonymous network a day, $200 global a day (`orbit-claude/proxy.ts:79-87`); browser counts a turn as one request | prompt cache: tools + the stable system block; the per-student knowledge block and the per-conversation nonce sit outside it (`system.ts:252-259`) | `speakUp` adds a request; a tool-JSON parse failure re-issues the whole run up to 2 times (`loop.ts:50`); history replays every tool result verbatim | $0.016 to $0.028 a turn measured; web search $0.01 each |
| A4 | Claude web search inside a turn | model's choice | 3 a request, so up to 36 a turn in code; the prompt asks for 1 to 3 | none | yes | $10 per 1,000 |
| A5, A6, A7, A8 | memory extract, network-search judge, rapport refine, resume parse through the proxy (`x-orbit-call`) | after a turn, per search (batches of 10, 3 in parallel), every reply check (up to 20), per upload | proxy call-type counters: memory 3,000, resume 50, rapport 3,000, judge 5,000 a day | judge: Dexie `searchCache` 30 days by text hash; others none | resume: every upload | Haiku except resume (Opus, 8,192 tokens) |
| A9 | own-key drafts, Opus at effort `high` (`integrations/anthropic.ts:799-825`) | every new card and planned first touch, regenerate, repair loop on open | own-key daily request cap only | none | regenerate, repair | own key, student pays |
| U2, U4, U5 | LinkedIn relations, chat history, posts activity (`engine/linkedinLive.ts`, `linkedinActivity.ts`) | app open when stale (24 h, 15 min, 20 h) | page caps | integration row checkpoints | "Sync now" re-pulls | free under Unipile flat pricing; LinkedIn account risk |
| U6, U7 | LinkedIn `/inbox` for replies and for style learning | every reply check (10 min); `learnStyle` after every Gmail sync that ingested mail, re-reading 180 days | 10 calls a read | none for style | yes, U7 re-reads 180 days every time | free; account risk |
| U8, U9 | mutuals, member-id search | routes, person page, chat | 1 a target a UTC day | Dexie kv `mutuals3:` keyed by Orbit person id | duplicate person rows re-ask | profile 1 + search up to 5 ledger units |
| U10 | LinkedIn people search from Add box, Map box, Discover, `find_people` | typing (settled prefixes), scroll, asks | Discover 15 a day; the rest only the proxy's 100 a day ledger | session only | every prefix | ledger |
| U13, U14, U16 | profile reads by enrichment, hop evidence and the photo queue | background on open, Map target open, photo loop | 30 + 15, 13 a target per 30 days, 20 photos a day | three separate records (`enrich:rec`, `engagement`, `photos:tried`) | yes across the three | profile ledger |
| U17, U18 | company logos by name batch and by id | logo loop, end of enrichment | batches of 60; 20 a day | kv tried lists | yes for an org with id and no logo | company ledger (71 of 150 used in the first 43 minutes of 11-09) |
| V1 | Village paths (browser) | routes, Map recompute, chat | pref off by default | in memory 5 min | reload re-asks | 5 credits ($0.10) a lookup when a key exists |
| G1, G3 | Gmail list and Calendar list from the browser | every reply check (about 6 an hour while open) | none | Gmail checkpoint; calendar none (270-day window every time) | calendar: yes | free, quota |
| S1, S4, S5 | `/sync/status` every 60 s, `/autopilot/status` every 30 s on Inbox, `/replies/list` every check | timers | none | none | yes | edge invocations |
| S6, S7 | `/memory/search` every chat turn; `/memory/extract` and `/goals/infer` after a turn | per turn | gates on text | none | same text twice | Haiku on the server |
| S12, S9 | `/source/search` (Unipile, Apollo, Exa, Scholar, Hunter, web, fit), `/search/read` (6 profiles, 6 companies, Haiku) | `find_people`, `search_network` | per-user caps in `_shared/budget.ts` | sourcing: Exa none, Scholar none, Apollo none; emails 30 days | same ask twice | $0.05 to $0.12 a run with Claude web search; Hunter credits |
| B1 | `composeDraft`, Opus medium 4,000 (`_shared/compose/compose.ts:319`) | drafts, replies, cadence actions, autopilot first touches, intro asks (2 each) | `claude_daily_usd` $1.50 a user a day, $25 a month, $100 lifetime | none | validator retry re-sends with a note; cadence skips when a pending draft exists | about $0.01 a draft |
| B2, B3, B4 | dossier writer Opus 8,000; research brief Sonnet 8,000; support check Haiku high | research | $0.30 a dossier; research $0.30 quick, $0.50 both, $40 a day global, 15 people a month an account | dossier reused 30 days | source-id retry; a job that dies after the model call re-pays | $0.12 a quick brief measured |
| B6, B7, B12, B13 | sourcing page reads (Haiku, per page, up to 22 in parallel), fit (batches of 20), person and company reading (batches of 8) | sourcing, `search_reading` every 2 h | `claude_daily_usd`; `WEB_BUDGET_USD` 0.25 | reads persisted 180 and 90 days | isolate death between call and update re-pays a batch | cents |
| B8, B9 | classify and rapport, Haiku | per inbound message | `claude_daily_usd` | result on the message | job retry re-pays | $0.00004 a call |
| B14, B15 | voice distill Opus low; voice judge Sonnet | nightly with edits; auto-sent first messages | caps | none | relearn same day | cents |
| C1 | Claude web search gather, Haiku, server tools (`_shared/research/web.ts:534`) | research and sourcing when Exa is not set | brief cap, `WEB_BUDGET_USD` | `claude:search` and `page:` 7 days shared | different person, same query: cached | $0.01 a search plus tokens; web fetch is free of surcharge |
| D1 to D5 | Exa (not configured today) | research, sourcing | `exa_daily_usd` $0.50 | dossier and research 7 days; sourcing `exaCall` none | sourcing passes re-pay | $4 to $7 per 1,000 searches |
| E1, E2, E3 | Hunter finder (up to 2 calls a candidate), domain search, verifier (`_shared/sourcing/lookup.ts:113,162,185`) | sourcing emails, 10 lookups and 10 verifies a run, in parallel | `hunter_daily_credits` 10 a user a day, read-then-act so a parallel run can pass more than 10; no global or monthly cap; ledger rows only on success | `email:`, `pattern:`, `verify:` 30 days shared, misses too | `template(d)` has no in-run memo: several candidates at a new domain each call domain search | free plan 50 credits a month; Starter $49 for 2,000 |
| F1, F2 | Apollo people search, people match | sourcing | match 10 a day | none; match through the email row | yes | Apollo plan credits (no key today) |
| G1 to G14 | Unipile server reads: dossier profile and posts, sourcing search (3 pages), contact emails, mutuals, hop evidence (17 reads a target, 40 a day), census (40 pages a day), facet lookups (70 a day), company pages (90 background, 120 ask), profiles (30 background, 60 ask), the sync | jobs and routes | per-account ledgers in `orbit_proxy_counters` | profile reads per user (`orbit.profile_reads`), company pages shared, mutuals and hop pages 30 days per user | the same profile is read once per student who has them | flat |
| I1, I2 | Semantic Scholar paper search, then author lookup per author (10 in parallel) | collaboration sourcing | none | none | yes | free; 1 request a second with a key |
| J1 | Parallel and Serper searches (not configured) | research investigator | loop budget | 7 days shared | objective text changes the key | $1 per 1,000 |
| W | worker jobs: see §1.2; retry policy 30 s × 2^(n−1) up to 5 reads then dead letter; a message read 10 times without finishing is dead-lettered; usage is recorded before `stop_reason` is checked and a `max_tokens` stop retries once at double (`_shared/claude.ts:168-187`) | crons and events | `HEAVY_PER_TICK` 3, reserves per kind | | every retry of a handler that threw after a paid call pays again | |
| X | crons: tick every minute (post only with depth or on a 10-min heartbeat), incremental 10 min, cadence hourly, outcomes hourly, nightly 07:13, retention 08:23, health 15 min, friends and voice 07:43, company facts 07:29, census every 3 h, reading every 2 h | pg_cron | | | | |

Three accounting gaps the inventory found, each confirmed against the live tables:

1. The proxy writes spend under `client:<id>` and `client:<id>:<day>` even for the signed-in owner; there is no `user:<uuid>`
   row in `public.orbit_proxy_spend`. `_shared/budget.ts:103` looks up `user:<uuid>` for the $100 lifetime cap, and
   `public.orbit_spend_total` adds ledger spend only for subjects matching `^user:[uuid]$`. So chat spend is invisible to
   the server caps and server spend is invisible to the chat cap, and a rotated browser client id is a fresh $20 a day.
2. `orbit-research` spend never reaches `orbit.usage_ledger` (its `makeClaude` has no `db` and `userId: null`,
   `orbit-research/research.ts:573`); the connectors' `/web` (Exa) and `/paths` (Village) record nothing.
3. Hunter ledger rows are written only when an address came back, so the ledger undercounts Hunter's own credit use and
   the budget never sees attempts.

## 3. Findings, ranked by dollars a month at 10 students (then at 100)

| # | Finding | Now | At 10 | At 100 | Phase |
|---|---|---|---|---|---|
| 1 | Chat turns: up to 12 model requests a turn, every tool schema on every request, up to 36 web searches a turn in code, cache hit rate never measured, knowledge block outside the cached prefix, `max_tokens` 16,000, Opus for every turn including Quick | $15 to $30 | $75 | $750 | C |
| 2 | Spend is split across four stores and the key is shared with other apps: `orbit_proxy_spend`, `usage_ledger`, `orbit_research_runs`, nothing for connectors web and Village; no digest, no alert, no per-user view; the 11-08 outage was not visible until the chat failed | the outage | the same outage at 10x | | A, E |
| 3 | Hunter: per-user 10 a day but no global or monthly cap, successes-only ledger, parallel lookups race the cap, the live test harness hits the real API; the free plan is 50 credits a month | spent | 1,500 credits a month: a $49 plan | 15,000: $299 | A |
| 4 | Unipile accounts: $5.50 each above 10; reconnects create accounts (plan 26 item 5 fixed the flow, the dashboard count was never checked); no per-month report | $55 | $55 | $550 | A, E |
| 5 | Worker CPU: `score.page` dies 38 times a day under the 2 s CPU limit, `sync.linkedin` spent 3 h of worker time on 11-08 re-walking everything, polls run with nothing to do; this is what forces the next compute tier | Micro | Small ($15) | Medium ($60) | A, D |
| 6 | Caps let one student spend $20 a day on chat and $1.50 a day on server tasks, against a measured peak of $4.35 a day for the whole product | | | | A |
| 7 | Paid calls re-spent on retry: usage recorded before `stop_reason`, `max_tokens` doubles and retries, handler throws after a model call re-run up to 5 times, isolate deaths re-run batches | cents | $1 to $5 | $10 to $50 | A |
| 8 | Whole-network sweeps: `search_reading` every 2 h with no unread filter, nightly calendar re-list of 730 days, `cadence.user` hourly for every user loading a year of messages, census re-walk every 30 days, `sync.linkedin` full re-walk after 20 h | worker time | | | D |
| 9 | Missing caches: sourcing Exa, Apollo search, Semantic Scholar (10 author calls in parallel), Village in the browser, `/memory/search` per turn, profile reads per student not shared, mutuals keyed by Orbit person id (duplicates re-ask) | $0 (keys unset) | $5 to $20 | $50 to $200 | B |
| 10 | Web sourcing searches through Claude at $10 per 1,000 when Serper gives 2,500 free and Parallel $1 per 1,000; page reads already use plain fetch | $0.05 a run | $5 | $50 | B |
| 11 | Model and effort choices never benched for cost: own-key drafts at effort `high`, resume parse and voice distill on Opus, Quick mode still on Opus | | $5 to $15 | $50 to $150 | C (decisions) |
| 12 | Browser polling: `/sync/status` every 60 s, `/autopilot/status` every 30 s, calendar list every 10 min with no sync token, `learnStyle` re-reading 180 days of LinkedIn messages, three profile-read ledgers that do not see each other | invocations | | Supabase egress and compute | B, D |
| 13 | Housekeeping: `cron.job_run_details` 85k rows never purged, `usage_ledger` and `orbit_proxy_spend` without TTL and scanned on every Claude call, 96 health snapshots a day kept two years | 15 MB | | disk and slower cap checks | D |
| 14 | CI: 57 runner minutes a push, six installs, five Playwright installs, no shared `dist`, perf on every push, cancelled runs still spend about 50 minutes; free while public | $0 | $0 | $100 a month if private | D (optional) |

## 4. The known suspects, checked

4.1 **The shared Anthropic key ran out on 11-08.** Orbit's recorded spend on that key is $9.38 (chat) + $0.18 (server
tasks) + $0.12 (research) since 10-22, $4.35 on 11-08 itself. That does not empty a funded account. The key
(`ORBIT_ANTHROPIC_API_KEY` in `orbit_private.secrets`, set 10-12) is the same Anthropic account other projects on this
Mac draw from, so the balance was spent elsewhere or was small. Orbit cannot tell, because it has no view of the account.
Fix: a dedicated key in its own Anthropic workspace with a monthly spend limit, and the digest in Phase E (A1, E1).

4.2 **Hunter's free plan was spent in one day.** The ledger shows 7 `hunter/find` rows on 11-08. The plan is 50 credits a
month (finder 1 credit when found, verifier 0.5, failures free). The day's work was the live harness
(`apps/web/src/__local__/hunter-live.test.ts`, 25 known addresses, recorded then replayed) plus direct tests on 10 inbox
contacts and 6 verifier checks, plus the product's own runs. None of the test traffic went through `budget.ts`, and the
ledger does not count attempts. Fix: a global monthly Hunter cap below the plan, attempts in the ledger, offline replay
as the only default for the harness, 5 lookups and 5 verifies a run (A4).

4.3 **The chat loop calls the model more than once a turn.** Yes: `max_iterations: 12` (`loop.ts:45,261`), plus one
`speakUp` request when the turn ended without words, plus up to two full re-issues on a tool-JSON parse failure, so 37
requests in the worst case; every request carries every model-callable tool and the web search tool with `max_uses: 3`.
The browser counts a turn as one request against its own caps (`loop.ts:301`). The router (`router.ts`) makes no model
call; `afterTurn` makes one Haiku memory call in local mode and two server calls in account mode.

4.4 **Crons against the whole network.** `orbit-search-reading` runs every 2 h for every LinkedIn user with no "unread
left" filter (12 jobs a user a day; 15 ran on 11-08, 92 s). `orbit-search-census` is bounded to 40 pages a day and is at
520 of about 6,500 after 25 h, so a first pass takes about two weeks. `orbit-company-facts-nightly` is one free job.
`sync.linkedin` is not on a cron, but a `/linkedin/sync` or a reconnect more than 20 h after the last pass re-walks all
relations (150 pages of 50, 4 a job) and two years of chats (8 a job): 192 jobs and 3 h on 11-08.

4.5 **The research cache is missing for some providers.** Cached: Exa in research and dossiers (7 days), Claude web
searches and pages (7 days), investigate extractions (7 days), hop pages (30 days), emails and patterns and verifications
(30 days), postings (7 days), mutuals (30 days per user). Not cached: sourcing `exaCall`, Apollo people search, Semantic
Scholar, sourcing Unipile searches, the browser's Village lookups, `/memory/search`, profile reads across students.

4.6 **Retries in `request.ts` multiply failed calls.** Default 3 retries on 429 and 5xx with 1, 2, 4 s backoff for Exa,
Apollo, Unipile, Village, Scholar and Parallel/Serper; Hunter is forced to 0. Providers do not bill a 429 or 5xx, so the
dollar effect is nil; the effect on LinkedIn is real (a 429 from Unipile retried three times keeps pressing the account).
The Anthropic SDK retries 429 and 5xx twice; a 400 (the credit error) is not retried anywhere.

4.7 **Web sourcing reads pages through Claude web search.** Searches: yes, when Exa is unset the gather uses Claude's
`web_search` at $0.01 a search on Haiku (3 to 4 searches a run). Pages: the sourcing profile pass already uses plain
`fetch` (`_shared/sourcing/web.ts:555`), and Claude `web_fetch` carries no surcharge. The cheaper path is a search key:
Serper (2,500 free queries) or Parallel ($1 per 1,000, $5 free a month with a card) are already wired in
`_shared/providers/webSearch.ts` for the research investigator but not for sourcing (B5).

4.8 **Worker dead letters and retries re-spend credits.** The mechanism is real (§2 row W). The money so far is cents: the
dying jobs (`score.page`, `sync.linkedin`) spend nothing on Claude; `search_reading` had one error. The fix is to stop the
deaths (A7) and persist after each paid call (A6).

4.9 **Haiku per candidate instead of batched.** Batched already: fit (20), person and company reading (8), support (all
claims), the web gather. Per item by nature: page extraction (one page each, up to 22 in parallel), classify and rapport
(one message each), postings. Cost today is cents; no change beyond caching extractions per page.

4.10 **Model choice.** Server: Opus for compose and reply (the message a student sends), the dossier writer, voice
distill; Sonnet for the research brief and the voice judge; Haiku for everything else. Browser: Opus for chat, resume,
notes, own-key drafts (effort `high`) and voice notes; Haiku for the rest. Candidates to move down: resume parse,
voice distill, own-key draft effort, Quick-mode chat. Each is a DECISION (§8).

4.11 **Prompt caching.** The chat caches tools plus the stable system block; the knowledge block (3 to 5 KB a student) and
the nonce ride on the top-level automatic breakpoint with the messages. Every server `structured()` call sets
`cache_control` on its system block, but the blocks are 190 to 1,800 characters, under the 512-token minimum on the 5.5
models, so nothing is written or read; the dossier prompt (2,553 characters) is per user and goal. No code anywhere logs
`cache_read_input_tokens`, so the hit rate is unknown (C1 fixes that first).

4.12 **The $20 a day cap.** Measured peak for the whole product is $4.35 a day. §6 A2 sets $3 a student a day, $1 an
anonymous network a day, $25 global a day, all env-overridable.

4.13 **Duplicate people.** 83 merges in 30 days. Mutuals (`mutuals3:<user>:<personId>`), enrichment records, photo and
member-id tries are keyed by Orbit person id, so an unmerged duplicate is looked up twice; `profile_reads` is keyed by
`(user_id, person_id)`. B4 rekeys by LinkedIn member id.

## 5. Research: prices and alternatives

Prices read on the vendors' own pages on 2026-11-08 and 2026-11-09 unless marked.

| Provider | Price | Source and date | Cheaper or free path |
|---|---|---|---|
| Anthropic Opus 5.5 | $4 in, $20 out per MTok; cache write $5 (5 min) or $8 (1 h), cache read $0.20; batch $2 / $10; fast mode $8 / $40 | platform.claude.com/docs/en/about-claude/pricing, 2026-11-09 | prompt caching (0.05x on reads), Batch API 50% for unattended work, effort `low` for simple turns |
| Anthropic Sonnet 5.5 | $2 / $10; cache write $2.50 / $4, read $0.10; batch $1 / $5 | same | half of Opus for chat if the bench holds (plan 28 gate 2.5) |
| Anthropic Haiku 5.5 | $0.10 / $0.50 up to 100K-token prompts (write $0.125 / $0.20, read $0.01), $0.50 / $2.50 above; batch $0.05 / $0.25 | same | already the server default; keep prompts under 100K |
| Anthropic web search tool | $10 per 1,000 searches plus tokens; failed searches not billed; web fetch has no surcharge | same page, "Web search tool" | Serper or Parallel for searches, plain fetch for pages |
| Prompt cache minimums | 512 tokens on Opus 5.5, Sonnet 5.5, Haiku 5.5; 4 breakpoints a request; 5-minute TTL refreshed by reads | Anthropic prompt caching docs via the claude-api skill, 2026-11-09 | put the per-student knowledge block under its own breakpoint |
| Unipile | $55 a month (or 49 EUR) including 10 accounts, then $5.50 an account a month; unlimited API calls, provider limits apply; 7-day trial | unipile.com/pricing-api, 2026-11-08 | delete orphaned accounts; only LinkedIn-connected students count |
| Unipile LinkedIn guidance | about 100 profile reads an account a day; relations: first page a few times a day at random intervals, never hourly or at fixed times; other routes 100 a day an account; 429 or 500 when exceeded | developer.unipile.com/docs/provider-limits-and-restrictions, 2026-11-09 | matches the current ledgers; the sync's full re-walks and fixed-time polls do not |
| Hunter | Free 50 credits a month; Starter $49 a month ($34 yearly) 2,000 credits; Growth $149 10,000; finder 1 credit when found, verifier 0.5, failures and Unknown free | hunter.io/pricing, 2026-11-08 | keep the finder (tested 9 of 10 right, 0 wrong), replace the verifier |
| Email verification alternatives | MillionVerifier about $37 per 100,000 or $89 per 50,000 (95.8% accuracy in one 2026 comparison); NeverBounce $0.008 pay as you go; Bouncer $8 per 1,000 entry; Reacher `check-if-email-exists` MIT, self-hosted, needs outbound port 25 (blocked on most clouds, so not from Supabase) | third-party comparisons dated 2026 (bouncezero.io, dev.to benchmark), github.com/reacherhq, 2026-11-09; vendor pages not read | MillionVerifier API for verifies at 1/40 of Hunter's effective price; confirm on their pricing page before buying |
| Exa | Lite $4, Auto $7, Deep $12 per 1,000 searches, 10 results with contents included; extra contents $1 per 1,000 pages; $10 free credits a month plus $10 onboarding; education grants up to $1,000 | exa.ai/pricing, 2026-11-09 | the $10 a month free tier covers about 1,400 searches: enough for sourcing at 10 students |
| Firecrawl | Free 1,000 credits a month (10 requests a minute); Hobby $19 for 5,000; 1 credit a page, search 2 credits per 10 results, JSON +4 a page | firecrawl.dev/pricing, 2026-11-09 | not needed: pages are plain fetch already; search is dearer than Serper |
| Parallel | Search from $1 per 1,000 requests (10 results); Extract $1 per 1,000; $5 free a month with a card | parallel.ai/pricing, 2026-11-09 | already wired in `webSearch.ts` for research; wire for sourcing |
| Serper | 2,500 free queries on signup; per-1,000 tiers not read | serper.dev, 2026-11-09 | the cheapest first key to set |
| Semantic Scholar | free; 1,000 requests a second shared pool unauthenticated, 1 request a second with a key (by email) | semanticscholar.org/product/api, 2026-11-09 | get a key; cache 30 days |
| Apollo | API access on Custom plans only per the pricing page; free plan limited | apollo.io/pricing, 2026-11-09 (no numbers published) | leave unset |
| Supabase Pro | $25 a month with $10 compute credits; 8 GB disk then $0.125 a GB; 250 GB egress then $0.09 a GB (cached $0.03); 2M edge invocations then $2 a million; compute Micro $10, Small $15, Medium $60, Large $110 | supabase.com/pricing, 2026-11-09 | stay on Micro by fixing the worker; a separate project for Orbit costs $25 and makes the bill attributable |
| Supabase Edge limits | 2 s CPU a request, 400 s wall on paid plans, 150 s idle timeout, 256 MB | supabase.com/docs/guides/functions/limits, 2026-11-09 | `score.page` and the sync must fit 2 s of CPU per invocation or move to SQL |
| Google Gmail, Calendar, People | free, quota units only | | Gmail push (Pub/Sub) removes the poll |
| GitHub Actions | free on public repos; $0.006 a Linux minute beyond the plan allowance on private repos | docs.github.com billing for Actions, 2026-11-09 | keep public; share `dist`, cache Playwright anyway for wall time |

## 6. The plan

Five phases. Each is one or two commits, each with a before and after measured by the §7 queries. Within a phase the
items are independent unless the text says otherwise. "Test" names the file to add to; the server tests run under
`supabase/tests` on PGlite (`helpers/pglite.ts`), the browser tests under `apps/web` with vitest.

### Phase A: stop the bleeding

**A1. A dedicated Anthropic key with a limit (Anish, 10 minutes).** In the Anthropic Console create a workspace "Orbit"
with a monthly spend limit ($50 to start) and a key; store it with
`select orbit_private.set_secret('ORBIT_ANTHROPIC_API_KEY', ...)` or an update on `orbit_private.secrets` (never in a
file); redeploy nothing (the proxy and the worker read the secret every 5 minutes). Metric: the Console's usage page shows
Orbit alone; the proxy's daily total in `orbit_proxy_spend` matches it within 5%.

**A2. Lower the proxy caps.** `supabase/functions/orbit-claude/proxy.ts:79` `DEFAULT_CAP_USD = 20` to `3`; `:85`
`DEFAULT_ANON_IP_DAILY_USD = 10` to `1`; `:87` `DEFAULT_GLOBAL_DAILY_USD = 200` to `25`. Keep the env overrides in
`orbit-claude/index.ts:20-22`. Update the comment at `proxy.ts:11` and the two mentions in
`apps/web/src/integrations/prefs.ts:38` and `shared-claude.ts:43`. Test: `apps/web/src/chat/__tests__/proxy.test.ts`
already asserts the budget refusal; change the fixture amounts. Risk: a student who truly needs more than $3 a day hits
`x-orbit-limit: budget` until UTC midnight; the browser already explains it. Metric: no `budget` refusal in
`function_edge_logs` for a week of normal use.

**A3. One subject per student and one spend total.** Two defects. (a) `subjectOf` (`proxy.ts:321-335`) never produces
`user:` for the signed-in owner: `public.orbit_proxy_spend` holds only `client:` rows. Read the session-token check there
against what `apps/web/src/integrations/anthropic.ts:125-143` sends as `x-orbit-session` (the Orbit access token from
`orbitApi.ts`) and the signing key the proxy expects; fix whichever side is wrong so a signed-in request is charged to
`user:<uuid>:<day>`. (b) In `meter` (`proxy.ts:524-529`) add a third `orbit_spend_add` to the lifetime subject
`user:<uuid>` (no day) for signed-in users, so `_shared/budget.ts:103` and `public.orbit_spend_total` see chat spend; and
in `budget.ts` `checkBudget` add the chat day row to `claude_daily_usd` by reading `orbit_proxy_spend` for
`user:<uuid>:<day>` (one extra select). Test: `proxy.test.ts` (subject for a session header, three adds) and
`supabase/tests/functions/shared.test.ts` (chat spend counts toward the day cap). Metric: query §7.2 shows `user:` rows
and no new `client:` rows for signed-in traffic.

**A4. Hunter: a global monthly cap, attempts in the ledger, smaller runs.** In `_shared/budget.ts`:
add `scope: 'user' | 'global'` to `Cap` (default `user`), a cap
`{ id: 'hunter_monthly_credits_global', provider: 'hunter', measure: 'units', limit: 40, window: 'month', scope: 'global' }`,
and make `checkBudget` sum without the `user_id` filter for global caps. In `_shared/sourcing/lookup.ts` record
`recordUsage(... operation: 'attempt', units: 0)` before every Hunter call (`:113,162,185`) so attempts are visible, and
keep the credit rows as they are. In `_shared/sourcing/email.ts:29,47` set `MAX_LOOKUPS = 5`, `MAX_VERIFIES = 5`. Add an
in-run memo map around `domainTemplate` (`lookup.ts:152-170`) keyed by domain so one new domain is asked once per run.
Make the budget check and the record atomic for credit providers: `recordUsage` first with the expected units, then the
call, then an `update ... set units = actual` by the returned ledger id (add `returning id` to `recordUsage`); this closes
the read-then-act race for Hunter and Apollo. The private harness `apps/web/src/__local__/hunter-live.test.ts` must refuse
to run without `HUNTER_OFFLINE=1` unless `HUNTER_LIVE=1` is set explicitly (it is not committed, so change it locally and
note it in `docs/qa`). Test: `shared.test.ts` (global cap stops the 41st credit in a month across two users; attempts rows
do not count), `apps/web/src/server/__tests__/sourcing-lookup.test.ts` (one domain search for three candidates at one
domain). Metric: `select sum(units) from orbit.usage_ledger where provider='hunter' and created_at >= date_trunc('month', now())`
stays under 40; Hunter's dashboard agrees.

**A5. Kill switches per provider.** New table `orbit_private.provider_switches(provider text primary key, enabled boolean
not null default true, note text, updated_at timestamptz default now())` (migration `20261111_orbit_cost_switches.sql`,
rows for `anthropic`, `hunter`, `apollo`, `exa`, `unipile_reads`, `village`, `web_search`). `_shared/services.ts`
`agentEnvWithSecrets` reads it in the same query as the secrets (cached 5 minutes) and a disabled provider makes its
adapter answer `{ kind: 'budget_exceeded', reason: 'off' }`; the proxy reads `anthropic` and answers 503
`x-orbit-limit: unconfigured` when off. Test: `shared.test.ts` (a switched-off Hunter never calls fetch). Metric: flipping a
row takes effect within 5 minutes with no deploy.

**A6. Never pay twice for one answer.** In `_shared/claude.ts:182-188` keep the `max_tokens` retry but only when the
first response had no parseable output and the task is not in a set `NO_RETRY_TASKS = {'classify','fit','reading'}`
(cheap tasks that are better left `invalid_output`); record the retry as a separate ledger row with `operation
'<task>:retry'` so it is visible. In the worker handlers that spend per batch, persist right after each paid call before
anything else can throw: `_shared/search/reading.ts` already updates after each batch; check `_shared/ingest/rapport.ts`
backfill (write after each message) and `_shared/voice/voice.ts` distill (write before the audit row). In
`orbit-worker/worker.ts:345-349` do not re-run a job whose handler reported `paid: true` in its thrown error more than
once: add an optional `attemptsAfterSpend = 1` honoured by the retry branch (the handler wraps a thrown error with
`{ paid: true }` after a model call). Test: `supabase/tests/functions/claude.test.ts` (no retry for classify on
`max_tokens`; retry row operation), `orbit-worker.test.ts` (a paid error retries once, then dead-letters). Metric: query
§7.4 `retried_runs` for `classify.message`, `search_reading`, `voice.distill` is 0 after a week.

**A7. End the isolate deaths.** `orbit-worker/handlers/score.ts:21` `SCORE_PAGE = 300` to `100`; `worker.ts:107`
`HEAVY_PER_TICK = 3` to `1`; and move the per-person tie arithmetic that `score.page` does in TypeScript into a SQL
function `orbit.score_page(user_id, offset, limit)` when the first change alone leaves deaths above 2 a day (the
"CPU Time exceeded" count in `function_logs`). For `sync.linkedin` (`orbit-worker/handlers/linkedin.ts:41-45`):
`RELATION_PAGES_PER_JOB = 4` to `2`, `CHATS_PER_JOB = 8` to `4`, and `FRESH_FOR_MS` 20 h to 7 days so a sync inside a week
reads one relations page and chats after the saved cursor only. Test: `orbit-worker.test.ts` (one heavy job a tick),
`ingest-linkedin.test.ts` (a sync within 7 days reads one page). Metric: `died with the isolate` under 2 a day; `sync.linkedin`
under 10 runs a day outside a first connect.

**A8. Browser: stop the three re-reads.** (a) `apps/web/src/engine/style.ts:98` `learnStyle`: keep `styleLearnedAt` on
the integration row and skip the LinkedIn `/inbox` read when it is under 7 days old (relearn and the Voice page pass
`force`). (b) `apps/web/src/engine/sync.ts:160` calendar: list only when the last list is over 6 hours old unless the sync
is not quiet, and keep a `calendarListedAt` checkpoint; a sync token is a later step. (c) `engine/warmIntros.ts:59`:
persist Village answers in Dexie `kv` `village:<user>:<key>` for 7 days instead of 5 minutes in memory. Test:
`apps/web/src/engine/__tests__` next to the existing sync tests (a second sync within 7 days makes no `/inbox` call; a
quiet check within 6 h makes no calendar list). Metric: `/inbox` calls per day in `function_edge_logs` for
orbit-connectors fall by at least half; Google Calendar quota graph flat.

**A9. Unipile accounts (Anish, 5 minutes).** Open the Unipile dashboard, count connected accounts, delete any that is not
the one in `orbit.integration_accounts where provider='linkedin'`. Record the count in §7.

### Phase B: cache everything cacheable, with the right key and TTL

**B1. Shared profile text.** Migration `20261112_orbit_profile_pages.sql`: `orbit_private.profile_pages(member_id text
primary key, about text, experience jsonb, read_at timestamptz, status text)`. In `_shared/search/reading.ts`
`readProfiles` (`:686-708`) look up `profile_pages` by member id first; on a hit under 180 days copy into the user's
`orbit.profile_reads` row without a Unipile request; on a read, write both. The per-user `reading` (what Claude extracted)
stays per user because the judge cache is keyed by text and the result is identical, so also copy `reading` when the About
text matches byte for byte. Privacy: the About and job descriptions are the public profile text LinkedIn shows any viewer;
nothing from a student's messages or notes is shared (plan 29's rule). Test: `profile-reading.test.ts` (second student,
same member id: no fetch, same reading). Metric: `profile_reads` rows per Unipile profile request (query §7.8) above 1 once
a second student connects.

**B2. Sourcing and research providers.** Use the shared cache (`_shared/research/web.ts` `sharedCache`, sha256 of the
request) for: `_shared/sourcing/search.ts` `exaCall` (`:479-516`, 7 days), `apolloCall` (`:541-555`, 7 days),
`scholarCall` paper search and author lookups (`:703-720`, 30 days), `linkedInCall` `searchParameters` (`:583`, 30
days). Cache `investigate` extractions by page only (`_shared/research/investigate.ts:327-344`) when `who` is empty, and
keep the per-person key otherwise. Test: `agents-source.test.ts` (second identical ask makes no provider call). Metric:
provider calls per sourcing run (ledger rows per `source.search` job) fall for repeated asks.

**B3. Chat memory search.** `apps/web/src/engine/memory.ts:57` `searchMemories`: memoise by normalised query text for 10
minutes in the chat store; skip when the user text is under 12 characters. Metric: `/memory/search` invocations per chat
turn under 0.6.

**B4. Keys by LinkedIn member id.** `apps/web/src/engine/linkedinLive.ts:774,865-883` mutuals kv key `mutuals3:<user>:<memberId>`
(fall back to person id only when there is none); `engine/enrichment/store.ts:71` records by member id when present;
`engine/photoQueue.ts:94-104` tried-list by member id. Migrate nothing: old keys expire on their own (1 day, 45 days, 7
days). Test: the existing `engine/enrichment/proxy.test.ts` and a new case in `engine/__tests__/linkedinLive` (two person
rows, one member id, one `/mutuals` call). Metric: duplicate `/mutuals` calls for one member id in a day: 0.

**B5. Cheaper searches for sourcing.** Set `SERPER_API_KEY` (2,500 free queries; Anish signs up) and, when the free
queries run out, `PARALLEL_API_KEY` ($5 free a month). In `_shared/sourcing/run.ts:465-477` build the `WebSource` chain
the same way `orbit-research/main.ts:31-41` does: Serper or Parallel first for searches, plain fetch for pages, Claude web
search last. Record the engine used in the `sourcing_web` ledger row's operation (`sourcing_web:serper`). Test:
`agents-source.test.ts` (with a Serper stub, no Anthropic web search call). Metric: `anthropic/sourcing_web` rows with
web searches drop to 0; sourcing cost per run under $0.02.

**B6. One profile-read record in the browser.** `engine/enrichment/store.ts` becomes the single record: `hopEvidence.ts:76`
and `photoQueue.ts:146` write `profileAt` (and `photoAt`) there, and read it before asking. `engine/logoQueue.ts` and
`engine/enrichment/logos.ts` share one `logoAskedAt` per organisation. Metric: `/profile` and `/companies` calls a day
from the browser (query §7.9 by path) fall by a third.

### Phase C: right-size models, batch, cache the long prompts

**C1. Measure the chat first.** The proxy's `meter` (`proxy.ts:350-438`) already sees `cache_read_input_tokens`,
`cache_creation_input_tokens`, `input_tokens`, `output_tokens` and `web_search_requests`. Migration
`20261113_orbit_claude_usage.sql`: `orbit_private.claude_usage(id bigserial, at timestamptz, subject text, call text,
model text, input int, cache_read int, cache_write int, output int, web_searches int, iterations int, usd numeric(10,5))`,
written once per answer from `meter` through a new `orbit_claude_usage_add` function (SECURITY DEFINER, like
`orbit_spend_add`); 90-day TTL in `retention_purge`. The browser sends `x-orbit-iterations: <n>` on each request of a turn
from `loop.ts` (the runner's iteration index) so the per-turn shape is visible. Metric and baseline for everything below:
cache hit rate = `cache_read / (cache_read + cache_write + input)` per day; requests per turn; web searches per turn;
output tokens per turn. Record a week of baseline before C2 to C5.

**C2. Shape of a turn.** `apps/web/src/chat/agent/loop.ts:45` `MAX_ITERATIONS = 12` to `8`; `webSearch.ts:10-14`
`max_uses: 3` to `2` and a per-turn budget of 3 searches: count `server_tool_use.web_search_requests` across the turn's
responses in `runTurn` and, once 3 is reached, build the next request's tools with `withWebSearch` omitted; `MAX_TOKENS
= 16_000` to `8_000` (the longest real answers are under 2,000 tokens; the tool-input truncation path already handles
`max_tokens` with a `tool_use`). Keep `MAX_PARSE_RETRIES = 2` but re-issue with `max_iterations: 3`. Test:
`apps/web/src/chat/__tests__/proxy-calls.test.ts` or the loop tests under `chat/agent/__tests__` (web search tool absent
after three searches; iterations cap). Bench: run `scripts/chat-baseline.sh` on the plan 28 matrix before and after; no
dimension average may drop under 2.5 and the shape check must stay green. Metric: requests per turn p95 under 6; web
searches per turn p95 under 3; cost per turn down 20% or more.

**C3. The cached prefix.** `apps/web/src/chat/agent/system.ts:252-259`: give the knowledge block its own
`cache_control: {type:'ephemeral'}` (the third of four breakpoints; the request-level automatic one is the fourth) so a
student's prefix is cached across their turns and conversations; move the nonce rule into the first user message of the
conversation as plan 26 item 1 described, so the system blocks are identical for everyone with the same goals. Verify
with C1: `cache_read` share above 70% on turns after the first in a conversation. Server side: `_shared/research/prompts.ts`
`dossierSystem(firstName, goalSentence)` becomes a constant system text with the name and goal in the user turn (the only
server prompt over 512 tokens). The other server prompts stay as they are: under the minimum, nothing to gain.

**C4. Batch API for unattended Haiku.** Add `structuredBatch()` to `_shared/claude.ts` using Message Batches
(`client.messages.batches.create`, poll by a worker job `claude.batch.poll` every 5 minutes, results keyed by `custom_id`),
and use it for `search_reading` batches (`_shared/search/reading.ts` people and companies), `rapport.backfill`, and the
nightly `voice.distill`. Do this only when `anthropic` server spend in the ledger exceeds $5 a month; today it is $0.18 in
ten days, and the code is the cost. Metric: batch rows carry `operation '<task>:batch'` and cost half.

**C5. Model and effort (DECISIONS, see §8).** With C1's numbers in hand, put each to Anish with the measured saving:
(a) own-key drafts `effort 'high'` to `'medium'` (`integrations/anthropic.ts:819`); (b) resume parse to Sonnet 5.5
(`anthropic.ts:869-877`); (c) voice distill to Sonnet 5.5 (`_shared/claude.ts:74`); (d) Quick-mode chat on Sonnet 5.5
(`loop.ts:245` when `deps.quick`, and allow it in `proxy.ts:32`), gated by the plan 28 bench at 2.5 on the Quick
scenarios; (e) effort `low` for turns the local router classifies as simple (plan 26 item 19). Each as its own commit with
the bench result in the message.

### Phase D: crons that do only the work there is

**D1. Enqueue only when there is something to do (one migration, `20261114_orbit_cron_filters.sql`).**
`orbit.enqueue_search_reading`: add `and exists (select 1 from orbit.people p where p.user_id = a.user_id and
p.linkedin_member_id is not null and p.deleted_at is null and not exists (select 1 from orbit.profile_reads r where
r.user_id = p.user_id and r.person_id = p.id and r.read_at > now() - interval '180 days'))` and reschedule to
`41 */6 * * *`. `orbit.enqueue_search_census`: `11 */6 * * *` (the 40-page ledger share is the real bound; 4 steps a day
reach it). `orbit.enqueue_cadence`: only users with `last_seen_at > now() - interval '14 days'` or an open draft, chat
or goal. `orbit.enqueue_nightly`: drop `resync: true` from the calendar job except on Sundays; enqueue `score.user` only
when `orbit.tie_scores` is older than the newest touchpoint for that user (one `exists`). `orbit.cron_call_worker`:
heartbeat every 30 minutes (`minute % 30 = 0`). `orbit-health`: every hour. Test: `supabase/tests/functions/shared.test.ts`
or a new `cron-filters.test.ts` on PGlite calling each function with and without work. Metric: §7.3 job runs a day for
`search_reading` under 4 with nothing unread, `cadence.user` 24 only for active users, `sync.calendar` nightly resync
once a week.

**D2. Gmail push instead of the poll (Anish: one GCP step).** Create a Pub/Sub topic in project `orbit-511808`, grant
`gmail-api-push@system.gserviceaccount.com` Publisher, a push subscription to
`https://nxibeiykcgxpbmkeadth.supabase.co/functions/v1/orbit-webhooks/gmail?token=<ORBIT_PUBSUB_TOKEN>`, set
`GMAIL_PUBSUB_TOPIC` as a function secret. The code exists (`orbit-webhooks/webhooks.ts:128-144`, `renewWatch`
`handlers/gmail.ts:117-131`). Then `enqueue_incremental_syncs` runs hourly (`7 * * * *` beside cadence) as the safety net.
Metric: `sync.gmail.incremental` with `reason: 'push'` appears within a minute of a test mail; poll runs 24 a day.

**D3. Housekeeping.** Add to `orbit.retention_purge`: `delete from cron.job_run_details where end_time < now() - interval
'7 days'`; `orbit.usage_ledger` rows older than 13 months; `public.orbit_proxy_spend` day rows (`subject ~
':\d{4}-\d{2}-\d{2}$'`) older than 90 days; `orbit.audit_log` `health.snapshot` rows older than 30 days;
`orbit_private.claude_usage` older than 90 days. Add an index `usage_ledger (user_id, provider, created_at desc)` so
`checkBudget` stops scanning. Metric: `cron.job_run_details` under 25k rows; `checkBudget` under 5 ms in `explain analyze`.

**D4. CI (optional, free while public).** In `.github/workflows/deploy.yml`: build once in `checks` and upload `dist` as
an artifact the e2e shards and `perf` download; cache `~/.cache/ms-playwright` keyed by the Playwright version; run
`perf` only when `apps/web/src/components/map/**` changed (`dorny/paths-filter` or `git diff --name-only`); rebalance the
shards by timing (`--shard` with Playwright's `--last-failed` is not needed; use 5 shards). Metric: runner minutes a push
from 57 to about 35, wall from 14 to under 10 minutes.

### Phase E: see the spend every day

**E1. One cost view.** View `orbit.v_spend_daily` unioning: `orbit.usage_ledger` (provider, operation, user, units, usd),
`public.orbit_proxy_spend` day rows (provider `anthropic`, operation `chat`, subject), `public.orbit_research_runs`
(provider `anthropic`, operation `research`), and `orbit_private.claude_usage` (tokens, cache share, web searches), by
UTC day. Make the connectors' `/web` and `/paths` routes record `usage_ledger` rows (provider `exa` and `village`,
`user_id` null, `account_id` the visitor hash) so nothing is outside the view.

**E2. The digest.** Worker job `cost.digest`, cron `orbit-cost-digest` at `50 7 * * *`, one job for everyone: for
yesterday, per provider and per user: spend, units, calls; the LinkedIn ledgers' peak share; Hunter credits used this
month; isolate deaths, dead letters, job errors; the Unipile account count is a manual field (A9). Writes an
`orbit.audit_log` row `cost.digest` and, when any threshold is crossed, sends one email through the Resend mailer
(`_shared/services.ts:75`, needs `RESEND_API_KEY` set; until then, the digest is a row only) to the owner
(`orbit.users` where `id = '390cf6d9-...'`). Thresholds, env-overridable in `orbit-worker/main.ts`: Anthropic over $5 a
day, Hunter over 30 credits in the month, any LinkedIn ledger over 90% of its total, isolate deaths over 5, dead letters
over 5, a provider switched off. No em dashes, no exclamation marks in the email. Test: `orbit-worker.test.ts` (digest row
shape; threshold triggers one mail). Metric: a row every morning; the first threshold mail in staging within a minute of
seeding a $6 day.

**E3. Owner view in the app.** `orbit-api` route `GET /admin/costs` (owner only: `users.id` equals `ORBIT_OWNER_ID`
function secret), returning the last 30 digest rows; a small Settings page `apps/web/src/pages/settings/Costs.tsx`
rendering per-day provider totals, cache share, and the thresholds. Text follows the UI rules. Optional once E2 is in.

**E4. Supabase visibility (DECISION).** The project is shared, so Supabase's bill cannot be attributed to Orbit. Either
accept it, or move Orbit to its own Pro project ($25 a month, a migration day). Put the choice to Anish with the
invocation and compute numbers from §1.

## 7. Before and after

Fill the "after" column in the commit that ships each item. Queries are in §9; all are read-only.

| Metric (query) | Before, 2026-11-08 or 11-09 | After A | After B | After C | After D |
|---|---|---|---|---|---|
| Anthropic chat $ a day, max of last 7 days (§9.2) | $4.29 | | | | |
| Anthropic chat $ a turn, mean (§9.2 usd / requests) | $0.018 lifetime, $0.028 on 11-08 | | | | |
| Cache read share of input tokens (§9.6, after C1) | unknown | | | | |
| Model requests a turn, p95 (§9.6) | unknown; bound 12 | | | | |
| Web searches a turn, p95 (§9.6) | unknown; bound 36 | | | | |
| Server Anthropic $ a day (§9.1) | $0.06 | | | | |
| Hunter credits this month (§9.1) | 7 recorded, about 50 used | | | | |
| Signed-in proxy rows under `user:` (§9.2) | 0 of 3 | | | | |
| `sync.linkedin` runs a day (§9.3) | 192 | | | | |
| `died with the isolate` a day (§9.4) | 38 (`score.page`) + 9 | | | | |
| Dead letters a day (§9.4) | 22 | | | | |
| `search_reading` runs a day (§9.3) | 15 | | | | |
| `sync.calendar` full re-lists a week | 7 | | | | |
| Worker invocations a day (§9.5) | 367 | | | | |
| Browser `/inbox` calls a day (§9.5) | not separated yet | | | | |
| Unipile connected accounts (dashboard) | unknown | | | | |
| `cron.job_run_details` rows (§9.7) | 84,811 | | | | |
| CI runner minutes a push | 57 | | | | |

## 8. Decisions for Anish

Each needs a yes before it is done. None blocks the rest.

1. A1: create the Orbit workspace and key in the Anthropic Console with a monthly limit (suggest $50 now, raise with users).
2. A9: count and prune Unipile accounts in the dashboard.
3. C5 (a) to (e): own-key draft effort to medium; resume parse to Sonnet; voice distill to Sonnet; Quick chat on Sonnet
   if the bench holds; low effort for router-simple turns. Each comes with the C1 numbers and the bench scorecard.
4. B5: sign up for Serper (free) and, later, Parallel (card required for the $5 free credit).
5. D2: the Pub/Sub topic in GCP for Gmail push.
6. E4: whether Orbit gets its own Supabase project.
7. Hunter plan: stay free with the global 40-credit cap, or Starter at $49 when a second student needs the finder; use
   MillionVerifier (or another verifier under $0.002 a check) for verifies if the finder stays on Hunter.

## 9. Queries

```sql
-- 9.1 server-side spend per provider and operation per UTC day, 14 days
select (created_at at time zone 'utc')::date d, provider, operation, count(*) calls,
       round(sum(units)::numeric, 1) units, round(sum(cost_usd)::numeric, 4) usd, count(distinct user_id) users
  from orbit.usage_ledger where created_at >= now() - interval '14 days'
 group by 1, 2, 3 order by 1 desc, 6 desc;

-- 9.2 chat proxy spend: subjects by shape and day
select regexp_replace(subject, '[0-9a-f]{8,}', '<id>', 'g') shape, count(*) rows,
       round(sum(usd)::numeric, 3) usd, sum(requests) requests, min(first_at)::date first, max(updated_at)::date last
  from public.orbit_proxy_spend group by 1 order by 1;
select subject, usd, requests from public.orbit_proxy_spend
 where subject like 'global:%' or subject like 'ipday:%' or subject like 'user:%' order by subject desc limit 60;

-- 9.3 job runs per kind per day
select (started_at at time zone 'utc')::date d, kind, count(*) runs,
       sum(case when status = 'ok' then 1 else 0 end) ok, round(sum(duration_ms) / 1000.0) total_s, max(attempt) max_attempt
  from orbit.job_runs where started_at >= now() - interval '8 days'
 group by 1, 2 order by 1 desc, runs desc;

-- 9.4 deaths, retries and dead letters
select kind, count(*) filter (where attempt > 1) retried_runs, count(*) filter (where status = 'error') errors,
       count(*) filter (where error = 'died with the isolate') isolate_deaths,
       count(*) filter (where error = 'never finished') never_finished
  from orbit.job_runs where started_at >= now() - interval '7 days' group by 1 order by 2 desc;
select (created_at at time zone 'utc')::date d, queue, message->>'kind' kind, count(*), min(error)
  from orbit.dead_letters where created_at >= now() - interval '30 days' group by 1, 2, 3 order by 1 desc;

-- 9.5 edge invocations by function and path, last 24 h (Supabase MCP query_logs, ClickHouse)
-- select log_attributes['function_id'] fn, log_attributes['request.pathname'] path, count(*) n,
--        round(avg(toFloat64OrZero(log_attributes['execution_time_ms']))) avg_ms
--   from logs where source = 'function_edge_logs' group by fn, path order by n desc limit 60
-- function ids: orbit-api 71591932-e5a3-4570-a1a8-96b975934cbf, orbit-worker 8ab427e4-3567-48e9-9e40-59d81cdbbf28,
-- orbit-connectors 24383b3f-d6b3-407f-832a-2c102890c829, orbit-claude 5c5a61c6-2d05-4696-a42c-358a2698cb5b,
-- orbit-research 77eb7a05-06f8-4cd6-9897-e713710fdd46, orbit-notes 411dc55d-80e1-4dc0-b3e4-f20fdc72c681
-- CPU limit hits: select count(*) from logs where source = 'function_logs'
--   and positionCaseInsensitive(event_message, 'CPU Time exceeded') > 0

-- 9.6 chat shape (after C1)
select (at at time zone 'utc')::date d, count(*) requests, sum(web_searches) searches,
       round(100.0 * sum(cache_read) / nullif(sum(cache_read + cache_write + input), 0), 1) cache_pct,
       round(sum(usd)::numeric, 3) usd, percentile_cont(0.95) within group (order by iterations) p95_iterations
  from orbit_private.claude_usage where at >= now() - interval '14 days' group by 1 order by 1 desc;

-- 9.7 housekeeping
select count(*) from cron.job_run_details;
select relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup from pg_stat_user_tables
 where schemaname in ('orbit', 'orbit_private', 'cron', 'pgmq') order by pg_total_relation_size(relid) desc limit 15;

-- 9.8 LinkedIn ledgers today and profile reads
select bucket, count, expires_at from public.orbit_proxy_counters where bucket like 'connectors:li:%' and expires_at > now();
select (read_at at time zone 'utc')::date d, read_by, status, count(*) reads from orbit.profile_reads
 where read_at >= now() - interval '14 days' group by 1, 2, 3 order by 1 desc;

-- 9.9 crons
select jobname, schedule, active from cron.job where jobname like 'orbit-%' order by 1;
```

## 10. What shipped (2026-11-09)

Shipped in one change, each item with its tests:

- A2 caps $3 a student, $1 an anonymous network, $25 global a day. A3: the proxy read the session signing key only from
  the `ORBIT_SESSION_SECRET` environment variable, while the key lives in Vault; it never verified a session, so every
  signed-in request was charged to `client:`. It now reads the Vault copy through a service-role function (cached 5
  minutes) and charges `user:<uuid>:<day>` plus the lifetime `user:<uuid>`. Chat spend counts toward a new combined cap
  `claude_total_daily_usd` ($4.50 a day, chat and server work together), not the $1.50 server cap, so a heavy chat day
  never blocks drafting on its own.
- A4 Hunter: global 40 credits a month, attempts kept as `<op>:attempt` rows with 0 units, reserve then settle for Hunter
  and Apollo, 5 lookups and 5 verifies a run, domain search memoised per run. A5 switches:
  `orbit_private.provider_switches`, `public.orbit_provider_enabled(p)`, read by `services.ts` and the proxy, 5-minute
  cache. A6: no `max_tokens` retry for classify, reply_classify, fit and reading; a retry gets its own `<task>:retry`
  row; a job that failed after a paid call gets one more try, then a dead letter (`_shared/paid.ts`). A7: one heavy job a
  tick, score pages of 100, the LinkedIn sync at 2 relation pages and 4 chats a job, with a 7-day fresh window whose short
  pass reads one relations page and new chats only. A8: style relearn once a week, calendar list every 6 hours on a quiet
  check, Village answers kept 7 days.
- B1 shared profile text (`orbit_private.profile_pages`), B2 shared cache for sourcing Exa, Apollo, Semantic Scholar and
  LinkedIn search parameters and page-only investigate extractions, B3 memory search memo, B4 mutuals by member id, B5
  search-engine chain (Serper, Parallel, Exa, then Claude; no keys set, so behaviour today is unchanged), B6 one
  profile-read and one logo-asked record in the browser.
- C1 `orbit_private.claude_usage` with the turn iteration from `x-orbit-iterations`. C2 8 requests a turn, 8,000 output
  tokens, 2 searches a request, a parse retry capped at 3 requests. Two departures, both on purpose: once a turn has run
  3 searches, later tool results tell the model to stop searching instead of dropping the tool (a changed tool list
  misses the prompt cache for the rest of the turn); and the nonce stays in the system prompt, after the playbook's new
  breakpoint, so moving it gains nothing. C3 the playbook has its own breakpoint; the dossier system text is constant.
- D1 cron filters (reading every 6 h only with unread profiles, census every 6 h, cadence for students seen in 14 days or
  with open work, calendar resync on Sundays, `score.user` only when stale, heartbeat every 30 minutes, health hourly).
  D3 retention sweeps and the `usage_ledger` index. E1 `orbit.v_spend_daily` and connectors ledger rows. E2 `cost.digest`
  at 07:50 UTC. E3 `/admin/costs` and `/settings/costs` for the owner.

Not done, and why:

- A1 Anthropic workspace key, A9 Unipile prune, B5 Serper and Parallel signups, D2 GCP Pub/Sub, E4 Supabase project, the
  Hunter plan: these need Anish's own accounts (§8).
- `ORBIT_OWNER_ID` and `RESEND_API_KEY` are not set: until they are, `/admin/costs` answers 404 and the digest is a row
  with `mailError` and no mail.
- C4 Batch API: server Anthropic spend is under its $5 a month threshold. C5 model and effort changes: decisions that
  wait on a week of C1 numbers and the bench. D4 CI: optional while the repo is public. A7's SQL `score_page`: only if
  deaths stay above 2 a day with pages of 100.
