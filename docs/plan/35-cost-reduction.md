# 35. Cost reduction: do less work, then do it cheaper

Status: audit done 2026-11-09 (UTC), nothing in §6 shipped yet. Follows 34 (cost audit, phases A to E shipped 2026-11-09 04:05
UTC) and reads from the per-request usage table that 34 C1 created. Written for an Opus 5.5 session to execute top to bottom,
in the order of §6. Every number in §1 to §4 is measured in production or read from the code at main `0a1a35a`; estimates
say so.

The rule this plan applies, in order, to every paid or metered thing Orbit does:

1. **Do not do it.** Skip work whose result nobody will read; run on demand instead of on a timer; compute once and share
   it across students; push instead of poll.
2. **Do it once.** Dedupe the same work inside a run, across tabs and across students.
3. **Do less of it.** Smaller prompts, smaller results, fewer rows, fewer pages.
4. **Do it cheaper.** Cache, batch, lower effort, a smaller model. Only after 1 to 3, and only with the bench.

## 0. Rules for the executor

Same as 34 §0: work in `/Users/home/orbit-search`, commit as Orbit with no trailers, gate with biome + typecheck +
`TZ=UTC pnpm -r --no-bail test` (the web `proxy.test.ts` and `__local__/real.test.ts` fail on this Mac's Node 24 and pass on
CI's Node 22), rebuild `dist` when `_shared` changes, deploy through the Supabase MCP at a pushed sha, migrations additive
only, secrets only in `orbit_private.secrets`, no em dashes or exclamation marks in UI or plan text. Anything marked
DECISION or ANISH waits for a yes. Every item names its metric; write before and after into §7 in the same commit.

Two standing rules from the cost-optimization guide that 34 did not state:

- A tradeoff lever (effort, model) is never applied without the bench. Chat: `scripts/chat-baseline.sh` and
  `scripts/chat-eval.mjs --gate` (plan 28; no dimension under 2.5, shape check green, two runs). Drafts:
  `supabase/tests/functions/draft-bench-live.test.ts` (plan 30; 19 of 27 or better on two runs). Both spend real money, so
  each run is approved as a budget (§8).
- Measure cache behaviour from `usage`, never from code review: after every change to prompt assembly, check
  `orbit_private.claude_usage` (§9.1) shows `cache_read` above 85% of input on turns after the first.

## 1. Where the money goes (measured 2026-11-09)

### 1.1 One chat request

From `orbit_private.claude_usage`, 51 requests on 2026-11-09 04:10 to 04:15 UTC (the owner's session and a bench run). The
owner's warm requests cost $0.016 to $0.041, mean $0.023; 2026-11-08's 76 owner requests averaged $0.0235. A message is about
1.8 requests, so about $0.045 a message.

| Part of a warm request | Tokens | Rate (Opus 5.5) | Cost | Share |
|---|---|---|---|---|
| Cache read: tools + fixed prompt + playbook + history | 63,000 to 68,000 | $0.20 / MTok | $0.013 | 55% |
| Cache write: the new tail (last answer, user turn, tool results) | 100 to 4,000, median ~800 | $5 / MTok | $0.004 | 17% |
| Output (answer plus adaptive thinking) | 2 to 410, mean 270 | $20 / MTok | $0.0054 | 23% |
| Uncached input | 2 to 8 | $4 / MTok | ~$0 | 0% |
| Web search | 0.14 a request | $10 / 1,000 | $0.0014 | 5% |

The first request of a session wrote 63,395 tokens to the cache: $0.32 for one request, ten times a warm one. That is the
whole fixed prefix going cold after a 5-minute gap. With one student it happens at every return to the app; at 100 students
the shared part stays warm all day and only the per-student playbook goes cold.

What the 63k cached tokens are (chars measured from the real request built in memory, tokens as the API billed them; the
API tokenizes JSON schemas at about 2.7 characters a token, so chars/4 undercounts):

| Prefix block | Chars | Tokens (billed) | Shared by | File |
|---|---|---|---|---|
| 113 client tools + web_search: 46k chars of descriptions, 60k of input schemas (29k of it parameter descriptions), 14k of keys and flags | 120,300 | about 44,000 | everyone | `apps/web/src/chat/agent/loop.ts:210-248`, `chat/capabilities.ts` |
| Fixed system block: autopilot 8.2k, voice 7.2k (1.4k of example dialogue), research 4.5k, product 3.9k, conversation 3.3k, knowledge rules 2.6k, privacy 2.1k | 38,250 | about 14,000 | everyone | `chat/agent/system.ts:259` |
| Playbook block (etiquette + goal sections) | 5,400 to 11,800 | 2,000 to 4,300 | per student | `system.ts:261`, `packages/core/src/knowledge/index.ts:181` |
| Untrusted-text rule with the per-conversation nonce | 400 | 150 | per conversation | `system.ts:263` |
| Tool-use preamble the API adds | | 286 | | |

The tool list is **about 70% of every request's cached read and of every cold write**. Of 113 tools, the model needs a
few in any one conversation; ten are admin or legacy (load_demo, leave_demo, delete_all_data, export_data, set_claude_key,
set_llm_feature, disconnect_google, disconnect_linkedin, process_outbox, set_autonomy). The largest schemas:
search_network 11,011 chars, update_settings 4,380, set_goal 3,039, find_people 2,987, update_goal 2,929, create_draft 2,913.

Other request facts: `max_tokens` 8,000, effort `medium` (`low` in Quick), at most 8 requests a turn, a parse failure re-issues
up to 3 requests and the counter resets after each good stream (`loop.ts:571`, so chains are unbounded), `speakUp` sends
`tool_choice: none` (`loop.ts:711`), which changes the request shape and rewrites the whole history cache. Tool results are
replayed verbatim until server compaction; `list_inbox` wraps 90 fields in `<untrusted_…nonce>` tags (about 1,700 tokens of
tags alone), `get_person` can return 3k tokens, a note 3,000 chars. After each turn two Haiku calls run on the server
(`/memory/extract` when worth remembering; `/goals/infer` whenever `PLAN_WORDS` matches, which in a recruiting app is most
turns).

### 1.2 Server Claude calls

From `orbit.usage_ledger` since 10-30 and the code (`_shared/claude.ts` task table):

| Task | Model, effort | Measured | What drives it |
|---|---|---|---|
| compose / reply (drafts) | Opus 5.5 medium, 4,000 tokens (8,000 on retry) | 2 reply drafts $0.062, $0.031 each | 2,000 to 7,000 input tokens (user context up to 4,800 chars, 8 thread messages × 1,500, 3 example mails × 1,200, dossier) and about 900 output tokens of which 500 to 650 are thinking. Output is about 60% of the cost. The system block is 400 to 925 tokens, often under the 512 cache minimum, and carries per-student values, so caching does little |
| intro ask | compose ×2, sequential | | two full Opus calls on the same inputs (`orbit-api/routes/paths.ts:60-61`) |
| funnel confirmation | reply on Opus | | an 8-message thread sent to Opus to write "confirming Tuesday 3pm", which `replyTemplate` with `confirms` already writes (`compose.ts:791`, `funnel.ts:166`) |
| voice_distill | **Opus** low, nightly | | re-reads the last 30 edit pairs every night (up to 90k chars) for each student with one new edit |
| dossier / research_brief | Opus / Sonnet, 8,000 (16,000) | $0.116 a quick brief | brief runs at default effort with no `effort` set; orbit-research passes `userId: null`, so no per-user cap applies |
| classify, rapport | Haiku low | 1,882 calls $0.124 ($0.00007 each) | classify is heuristic-first (model only under 0.75 confidence); rapport has no gate and runs on every reply of 20+ chars |
| reading, fit, sourcing page reads | Haiku low | cents | fine; sourcing reads are misfiled as `fit` |
| web gather (`research/web.ts:535`) | Haiku + Claude web search | $0.049 a sourcing run (5 searches) | $0.01 a search where Serper is free and Parallel is $1 per 1,000 |
| postings (`_shared/postings.ts:450`) | Haiku, raw fetch | unrecorded | no ledger row, no budget check |

Accounting gaps found: `recordUsage` stores `units = input + output` and drops the input/output/cache split; rapport logs as
`classify`; `prices.ts:12` prices Sonnet cache reads at $0.20 (Anthropic's page: $0.10 since 10-07); the proxy header
comment still says 5 resumes a day.

### 1.3 Worker, database, polling

From `orbit.job_runs`, the edge logs for 2026-11-08 10:00 to 11-09 10:00 UTC, and the code:

| What | Measured | Why it is waste |
|---|---|---|
| Nightly `score.page` | 89 runs, 24,707 s of worker time, 37 isolate deaths on 11-08 (now pages of 100, so about 77 jobs a night) | each page calls `refreshTies` with `allKinds`, which **reloads all 7,721 people, identities, affiliations and organizations, runs `inferTies` and `sameCityTies` over the whole network, then keeps the 100 people on the page** (`_shared/ingest/ties.ts:86-104, 192-247`). One night does the full inference 77 times |
| `touch_updated_at` trigger | fires on every update, changed or not (`migrations/20261014_orbit_core.sql:436-462`) | every score run rewrites 7.7k `tie_scores` with features, contributions and explanation JSON, 7.7k `people.strength`, 13.5k `ties` with evidence, so the next `/sync/pull` re-downloads them: roughly 15 to 25 MB of JSON per student per night (estimate from row shapes) |
| `/sync/status` | 77 calls a day for one tab; 60 s poll, 3 s during setup | 9 `count(*)` queries including all ties and messages plus a scan of every pgmq queue by `message->>'userId'` (`orbit-api/sync.ts:34-63`), to decide whether to pull |
| `/autopilot/status` | 47 a day; 30 s poll on Inbox and Settings | 5 to 15 KB each, JSON subqueries over drafts and audit_log |
| `/linkedin/status` | **175 a day**, the most-called route; 30 s poll with no hidden-tab check (`ConnectorCards.tsx:33-40`) | answers 300 bytes that `/sync/status` already carries |
| orbit-connectors `/companies` | 27 a day at 6 s each | the browser logo queue sweeps the **whole network's** companies, 60 names a call every 20 to 40 s, 8 new lookups a call; a 2,000-company network is about 250 invocations; a student sees perhaps 50 logos |
| `orbit-incremental` every 10 min | 32 gmail + 32 calendar + 20 linkedin jobs on 11-09 | Google jobs are queued for every active account even when the user was not seen for weeks; the LinkedIn poll stays at 10 minutes although the Unipile webhooks were registered on 11-09 |
| `orbit-cadence` hourly | 11 to 24 runs a day | the "has an unarchived chat" clause matches nearly every user, so the 14-day filter does nothing |
| `search_reading` every 6 h | 3 runs, 83 s | reads profiles of people nobody asked about |
| `search_census` every 6 h | 3 runs, 104 s | a 2-week walk of 6,500 people for search recall |
| `loadGraph` per Map search | 18 `/paths/find` a day, 3.4 s avg (CPU fix shipped 0a1a35a) | loads all people with `tie_scores.features` (only `reciprocity` used), every tie with its `evidence` jsonb, twice per person search when external ties were found |
| Client bundle | entry 2.7 MB, pdf worker 1.4 MB, schools 0.86 MB | the landing page loads the whole app; GitHub Pages, so load time not Supabase egress |

The Supabase project is shared: Orbit was 700 of 2,700 edge invocations in that day (vs-api's cron alone was 1,330).

### 1.4 Unipile (checked live 2026-11-09 through pg_net, key never left the database)

The Unipile account holds **11 connected accounts**, one over the 10 the $55 plan includes, so it bills an extra
account today. Seven are LinkedIn: Orbit's live one (`G3aey69B…`, 2026-10-30), **four orphaned Orbit reconnects from
2026-10-22** (`TZ5yAhLz…`, `SMnvVlAe…`, `ojNFyma6…`, `aCgWtgR-…`, all status OK, none in `orbit.integration_accounts`),
and two from July 2026 that are Osmo's, as are the three Instagram and one WhatsApp accounts. Plan 26 fixed the reconnect
flow after these were created; nothing reconciles the list.

### 1.5 Cost per student today and after this plan

Per-use prices measured above; usage levels assumed (average student: 27 chats of 4 messages, 60 drafts, 4 briefs, 40
email lookups a month; the $10 monthly Claude allowance caps the AI line).

| Line | Today | After §6 free wins (phases A to C) | After the bench-gated tradeoffs too (phase D) |
|---|---|---|---|
| Chat, 108 messages | $4.90 | $2.60 | $1.30 |
| Drafts, 60 | $1.50 | $0.90 (batch for unattended, templates where fixed) | $0.50 |
| Research, sourcing, background Haiku | $0.90 | $0.55 | $0.45 |
| Email finding | $0.98 at Hunter Starter prices | $0.40 (on demand only) | $0.15 (Enrow or Icypeas, E6) |
| Unipile account | $5.50 | $5.00 at 51+ accounts | $2.20 with idle links parked (E5), $0 with a browser-side reader |
| Supabase share at 100 students | $0.85 | $0.60 | $0.60 |
| Card fees on $49 | $1.72 | $1.72 | $1.72 |
| **Total** | **$16.35** | **$11.77** | **$6.92** |

Chat and drafts fall by about half without touching quality. After that the LinkedIn line dominates, and the last column
assumes E5 (park idle links) and E6 (cheaper email finder), which are DECISIONS; without them phase D ends near $10.

## 2. The "do not do it" findings, ranked by what they remove

Ranked by savings ceiling, not application order (§6 decides sequence).

| # | Finding | Today | Removes | Phase |
|---|---|---|---|---|
| 1 | Nightly scoring infers the whole network 77 times | 77 jobs, ~7 h of worker time, 37 deaths a night per student | 76 of 77 inferences, ~98% of scoring CPU | B1 |
| 2 | Every score run rewrites 28k unchanged rows and every browser re-downloads them | 15 to 25 MB a student a night | the rewrite and the download | B2 |
| 3 | 113 tools sent on every chat request | ~44k of 63k cached tokens, $0.32 cold | ~35k tokens a request, 75% of the cold write | A1 |
| 4 | Three status polls (60 s, 30 s, 30 s) ask questions whose answer is "nothing changed" | ~300 orbit-api calls a day per open tab | ~90% of them | B3 |
| 5 | Logo queue fetches logos for 2,000 companies the student never looks at | ~250 connector calls per new student | all but the ~50 on screen | B4 |
| 6 | Google and LinkedIn polled every 10 minutes for users not around, LinkedIn polled although webhooks now push | up to 432 jobs a student a day | ~85% | B5 |
| 7 | Email lookups run for every sourced candidate, not the ones the student will write to | 5 lookups + 5 verifies a run | ~70% of Hunter credits | C3 |
| 8 | Haiku readings of profiles nobody asked about, every 6 h | 4 reads a day per student | all but on-demand reads | B6 |
| 9 | Two Opus calls for one intro ask; Opus writing a fixed confirmation; voice distill re-reading 30 old edits nightly | per use | one call, zero calls, 1 edit instead of 30 | C1 |
| 10 | goals/infer runs on most turns; rapport runs on every reply with no gate | 2 Haiku calls a turn | half of them | A4 |

## 3. The "do it once" and "do less of it" findings

| # | Finding | Fix | Phase |
|---|---|---|---|
| 11 | Fixed prompt restates tool descriptions (find_people, offer_choices ×4, search_network, list_friends, autopilot_status ×3, create_draft) and contradicts itself (`system.ts:65` vs `:190`; word caps stated 7 ways) | one home per rule, ~4.5k chars | A2 |
| 12 | Autopilot answer formatting (2,000 chars) sits in every request though it matters only when autopilot is asked about | move into `autopilot_status` and `list_replies` results as `howToAnswer` | A2 |
| 13 | `strictSchema()` runs on all 113 tools, moving enums into description text (+1,878 chars) and dropping enum enforcement on 94 tools | apply only to the 20 strict tools (`loop.ts:231`); send_draft, schedule_sends, update_limits, undo_send are not strict because `strictToolNames` takes the first 20 risky tools alphabetically (`loop.ts:201-208`) | A1 |
| 14 | set_goal and update_goal spread the same `goalFields` (2.5k chars each) | one tool with optional `goalId` | A1 |
| 15 | Every tool result field is wrapped in its own `<untrusted_…>` tag with a 16-char nonce: list_inbox 90 wrappers | wrap one block per result | A3 |
| 16 | get_person 12 × 800-char messages + 30-entry timeline; list_inbox 30 rows; note 3,000 chars; search_network 15 rows | 6 × 400, 15 rows, 1,200 chars, paging | A3 |
| 17 | `speakUp` changes `tool_choice`, rewriting the whole history cache | same `tool_choice`, `max_iterations: 1` and the nudge text | A3 |
| 18 | parse retries chain without a per-turn cap | count per turn, no reset | A3 |
| 19 | reply compose sends 8 × 1,500-char thread messages and 3 × 1,200-char example mails | 4 × 800 and 2 × 800 | C1 |
| 20 | `loadGraph` loads `features` whole, `evidence` whole, everyone, twice | two-ring SQL around the target, `features->'reciprocity'`, evidence only for the winning paths, patch the graph instead of a second load | B7 |
| 21 | Three Google jobs per user per interval, two status routes per poll | one `sync.google` job; `/sync/status` carries linkedin and autopilot freshness | B3, B5 |
| 22 | Classify and rapport are two Haiku calls per reply | one call, one schema | A4 |

## 4. The "do it cheaper" findings (tradeoffs, bench-gated)

| # | Lever | Published expectation (Anthropic, optimizing-for-cost-and-intelligence, read 2026-11-09) | Orbit's gate |
|---|---|---|---|
| 23 | Chat effort `medium` to `low` for turns the router marks simple, later for all | research and knowledge work: `low` gave up a few points for a third to a half off cost a task; `medium` matched `high` | plan 28 bench, 2.5 |
| 24 | Chat on Sonnet 5.5 (every rate half of Opus; cache reads $0.10) | on SWE-bench Pro, Opus 5.5 at `low` matched Sonnet 5.5 default for 7% more a task; the page says start with Opus 5.5 at `medium` and sweep effort first | plan 28 bench, two runs; try 23 first |
| 25 | Drafts: Opus `low`, then Sonnet 5.5 | output is 60% of a draft's cost and most of it thinking | plan 30 bench, 19 of 27 twice |
| 26 | Batch API for drafts no one waits for (cadence, autopilot first touches, auto-replies), voice distill, search_reading | 50% off every token including cache reads and writes; 24 h window | none needed (same model, same prompt) |
| 27 | 1-hour cache on the static prefix | cheaper only when more than about 1 turn in 20 to 30 follows a pause over 5 minutes; at 100 students the static prefix is always warm, so no | decide from §9.3's gap walk after A1 lands |
| 28 | research_brief at effort `medium` (today unset, so `high`) | DeepResearch Bench II: `medium` scored 60.5 vs 63.0 at `high` for 21% less | one-line change; spot-check 3 briefs |

## 5. The fixed line: LinkedIn through Unipile

Today $55 a month covers 10 accounts and each further one is $5.50 a month. Orbit holds 1 live and 4 orphaned slots, and
shares the plan with Osmo's 6. At 100 LinkedIn-connected students the line is $550 a month, 5.5 times the Supabase bill and
the largest cost per student after this plan.

Three paths, cheapest first:

1. **Reconcile accounts (A5).** Delete the four orphans (DECISION, destructive) and add a nightly reconciler that lists
   Unipile accounts and reports any LinkedIn account that is not in `orbit.integration_accounts` in the cost digest; never
   auto-delete. Saves the extra account billed today and prevents the next orphan.
2. **Ask Unipile for volume pricing** at 50 and 100 accounts before the second cohort connects (ANISH; the public page lists
   only the $5.50 step). The research results in §5.1 list the alternatives and their prices.
3. **A browser-side reader for reads.** The student's own LinkedIn session, through a small extension or the existing
   local mode, does profile views, relations and inbox reads at $0, and the server keeps Unipile only for students who turn
   on sending from Orbit. This is an architecture decision with LinkedIn-risk tradeoffs; §5.1 records what the market
   offers and what each option costs per account.

### 5.1 Providers and prices (vendor pages read 2026-11-09)

**Unipile's real tiers** (unipile.com/pricing-api): $55 minimum covers 1 to 10 accounts, then $5.50 an account for 11 to 50,
$5.00 for 51 to 200, $4.50 for 201 to 1,000; the tier rate applies to the whole count; billing is on the **peak number of
accounts linked at the same time in each 30-day period**; no per-call fees. So 100 students cost $500 a month, not $550.

That billing rule is the cheapest lever in this section: **an account that is not linked costs nothing.** E5 (below) parks
the Unipile link of a student who has not opened Orbit for 21 days and has no send scheduled, and relinks on their next
visit (a hosted-auth reconnect, which plan 26 made one click). If 40% of students are active in a month, 100 students
cost about $220 instead of $500.

| LinkedIn option | $ an account a month at 10 / 100 / 1,000 | Sends and reads | Note |
|---|---|---|---|
| Unipile (today) | $5.50 ($55 min) / $5.00 / $4.50 | yes, webhooks | unofficial; the cheapest hosted option with full send and read |
| Lix (per call, $49 for 500 calls) | ~$2.90 at 30 calls / same / contact | reads; send endpoints need checking | student hands over the session cookie |
| Linked API | $70 / $70 / contact | yes | cloud browser per account |
| HeyReach, Salesflow, Dripify, lemlist, La Growth Machine | $25 to $138 | yes | outreach suites, 5 to 25 times Unipile |
| Linked Helper (desktop) | $13.50 / $9 / $7.50 | yes | runs on the student's machine, no server API |
| Proxycurl | | | shut down 2025-07-04 after LinkedIn's lawsuit |
| Own browser extension (`sneg55/pingcrm` pattern: the extension calls LinkedIn with the student's session and posts parsed results, the cookie never leaves the device) | $0 | yes, while the browser is open | student's own IP and fingerprint, lowest ban exposure; we maintain it when LinkedIn changes endpoints |

Free LinkedIn accounts get about 5 invitations with a note a month whichever API sends them, which caps what any vendor
buys a student.

**Email finders** (all charge only when an address is found; 60% find rate assumed):

| Vendor | Entry plan | $ a found address at 1,000 / 10,000 lookups a month | Note |
|---|---|---|---|
| Hunter (today) | Starter $49 for 2,000 credits | $0.082 / $0.025 (Growth $149) | free 50 a month kept as fallback |
| Enrow | $17 for 1,000, never expire | $0.028 / $0.0145 | catch-all check included |
| Icypeas | $19 for 1,000, never expire | $0.032 / $0.0148 | verifier 0.1 credit |
| Datagma | free 100 a month, $49 for 3,000 | $0.082 / $0.0165 | credits roll over 12 months |
| Prospeo, Anymailfinder, Snov.io, Apollo | $39 to $49 | $0.065 to $0.082 / $0.018 to $0.033 | Apollo's terms forbid use inside another product without an agreement |

**Verification only:** Reoon $11.90 for 10,000 ($0.0012 each, 20 a day free, unknowns refunded), MillionVerifier $0.0039,
Bouncer $0.006, Hunter's verifier about $0.011. Open-source SMTP checkers (`reacherhq/check-if-email-exists`) need outbound
port 25, which Supabase Edge Functions block; not worth a VPS at Orbit's scale.

**Search APIs:** Serper $1 per 1,000 (2,500 free, Google results so `site:linkedin.com/in` works), DataForSEO $0.60 per 1,000
async, Google Custom Search 100 a day free then $5, Parallel $1 to $5, Exa $4 to $12, Brave $5 (the free plan is gone),
Bing retired 2025-08-11. Anthropic web search is $10 per 1,000 plus result tokens; web fetch has no surcharge.

**Anthropic facts that bound the caching levers:** cache TTLs are 5 minutes and 1 hour only (no 24-hour TTL); minimum
cacheable prefix on Opus 5.5, Sonnet 5.5 and Haiku 5.5 is 512 tokens; Batch is 50% off and stacks with caching, but cache
hits inside a batch are best effort (30 to 98%); a Haiku 5.5 request over 100k prompt tokens pays 5 times on every
category, so keep Haiku prompts under 100k.

**Supabase:** Pro $25 with $10 of compute credit (one Micro); 2M edge invocations then $2 per million; 250 GB egress then
$0.09/GB; 2 s CPU per request, 400 s wall clock on paid plans; pg_cron and pgmq cost nothing beyond the database. Orbit is
far under every included quota, so Supabase savings are about CPU deaths and latency, not the bill, until Orbit moves to
its own project (34 E4).

## 6. The plan

Phases are independent of each other; items inside a phase are independent unless the text says otherwise. "Test" names
the file to add to. Metrics come from §9.

### Phase A: the chat request (free wins, no quality change)

**A1. Tools: send the few, defer the rest.** In `apps/web/src/chat/agent/loop.ts:210-248`:
(a) drop the ten admin and legacy tools from `buildRunnerTools` (the router and chips still call them through `execute()`);
(b) mark every tool except a core set of about 20 (the read tools the router does not cover, create_draft, send_draft,
find_people, search_network, find_routes, offer_choices, open_page, add_person, set_goal, list_pipeline, autopilot_status)
with `defer_loading: true` and add `{type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25'}`; the proxy
`orbit-claude/proxy.ts:230` must allow that tool type and the deferred flag; (c) apply `strictSchema()` only to strict
tools and make the strict set all 34 risky tools, not the first 20 by name; (d) merge set_goal and update_goal into one tool
with an optional `goalId`; (e) flatten search_network's input to `ask` plus a few filters (`chat/tools/search.ts:400`);
(f) trim parameter descriptions over 200 chars to one clause. Bump `STABLE_SYSTEM_VERSION`. Test:
`chat/__tests__/context-budget.test.ts` (asserts the serialized tool list under 30k chars and the deferred count),
the loop tests (a deferred tool is still callable after the search tool returns it), `proxy.test.ts` (tool search allowed,
other server tools still refused). Risk: a turn that needs a deferred tool spends one search step; the bench's shape check
catches a drop. Metric: `cache_read` per request on a fresh conversation from 63k to under 25k; cold write under $0.13.

**A2. The fixed prompt.** `apps/web/src/chat/agent/system.ts`: one home per rule (findings 11, 12); keep 3 of the 10 voice
examples and move the fixture into the lint test; drop ENVELOPE_RULES to one sentence on `error` and `href`; remove
"Output only the requested structure" from the chat copy of the untrusted-text rule (`integrations/anthropic.ts:453`);
shorten the playbook header to the section list (`packages/core/src/knowledge/index.ts:181`). Test: `system.test.ts` frozen
bytes, `voice lint` with the moved fixture; bench once after A1 and A2 together. Metric: fixed block under 24k chars.

**A3. The tail.** `chat/tools/_shared.ts:78` wrap one block per result instead of each field; defaults 6 messages × 400 chars,
15 inbox rows, 1,200-char notes, 10 search rows with paging (`read.ts:765-823`, `inbox.ts:76,145-172`, `read.ts:1603`,
`search.ts:384`); `speakUp` keeps `tool_choice` (`loop.ts:711`); parse retries counted per turn (`loop.ts:571`). Test: the
tool tests for the new sizes; a loop test that speakUp's request differs from the last only in the appended nudge. Metric:
median `cache_write` per request from ~800 to under 500 tokens; no request with `cache_read` under 90% of the previous one
in the same turn.

**A4. After-turn calls.** `chat/agent/afterTurn.ts:35`: `/goals/infer` only when `worthRemembering`-style statement detection
also fires, and once per conversation per 10 minutes. Server: `_shared/ingest/rapport.ts:93` gate on the classify confidence
like classify does, or fold rapport into the classify schema so one Haiku call answers both; log it as `rapport`. Metric:
`/goals/infer` invocations per chat turn under 0.3; `classify` + `rapport` ledger rows per inbound reply at 1.

**A5. Accounting fixes (so the rest can be measured).** `_shared/claude.ts:188-194` store input, cache_read, cache_write
and output in `usage_ledger` (new nullable columns, migration `20261118_orbit_usage_tokens.sql`); `postings.ts:450` through
`structured()` or at least `recordUsage` + `checkBudget`; `prices.ts:12` Sonnet cache read $0.10; sourcing reads logged as
`sourcing_read`; orbit-research passes the account's user id to the cap. Test: `claude.test.ts` (ledger row has the split).

### Phase B: the worker and the browser (do not do it)

**B1. Infer ties once a night.** `orbit-worker/handlers/score.ts:47-80` and `_shared/ingest/ties.ts:86-247`: `score.user`
runs `inferTies` + `sameCityTies` once for the user and writes ties; `score.page` becomes scoring-only over its 100 people
(tie scores and strength from the stored ties). If one inference does not fit the 2 s CPU budget for a 7.7k network, page
the inference by tie kind (same_current_company, co_tenure, same_city) instead of by person. Also: skip `score.user`
entirely for people without a new touchpoint, tie or affiliation since the last score (delta scoring: a `people.scored_at`
compared with `max(updated_at)` of their touchpoints and ties). Test: `score.test.ts` (one inference call per run; a page
makes none; unchanged people are not rescored). Metric: `score.page` wall time a night from ~24,000 s to under 600 s;
isolate deaths 0; worker invocations a night under 15.

**B2. Stop rewriting unchanged rows.** Migration `20261119_orbit_touch_if_changed.sql`: `touch_updated_at` returns early when
`to_jsonb(NEW) - 'updated_at' = to_jsonb(OLD) - 'updated_at'`; the tie, score and strength upserts add
`where (…) is distinct from (excluded.…)`. Drop `contributions` and `explanation` from the `/sync/pull` map of `tie_scores`
if the browser only needs them on the person page (check `apps/web/src/engine/serverSync.ts` consumers; if used, fetch per
person through `/scores/explain`, which exists). Test: `pull-shapes.test.ts` (a no-op upsert does not bump `updated_at`).
Metric: rows returned by the first `/sync/pull` after a nightly run, from ~28k to under 500.

**B3. One poll, and only when something changed.** Migration adds `orbit.user_marks(user_id, changed_at, linkedin_at,
autopilot_at)` kept by triggers on people, ties, tie_scores, drafts, messages, threads, integration_accounts. `/sync/status`
(`orbit-api/sync.ts:34-63`) reads that one row plus the setup-time queue depth, and carries the linkedin and autopilot marks.
Browser: `serverSync.ts:974-975` poll every 5 minutes when idle, 3 s only during setup, and immediately on return to the
tab; `useAutopilotStatus.ts:13` refetches only when the autopilot mark moved; `ConnectorCards.tsx:33-40` reads the linkedin
mark from the status and polls nothing of its own. Later, when there are more than a handful of students, replace the 5-minute
poll with a Realtime subscription on `user_marks` (included in Pro). Test: `serverSync` tests (no pull when the mark is
unchanged; a pull when it moves), `ConnectorCards` test (no `/linkedin/status` timer). Metric: orbit-api invocations per open
tab per day from ~300 to under 40.

**B4. Logos and photos for what is on screen.** `engine/logoQueue.ts` and `photoQueue.ts`: enqueue only organizations and
people rendered in the last session (Map, People page, Pipeline, Discover rows report what they show through a
`seen(orgId | personId)` call); keep the daily caps; the whole-network sweep moves to a weekly server job over the shared
`orbit_private.linkedin_companies` list that fetches logos only for companies with 3 or more people across all students.
Metric: orbit-connectors `/companies` + `/photo` calls a day per student from ~50 to under 10 after the first week.

**B5. Crons that follow the student.** Migration `20261120_orbit_cron_follow.sql`: `orbit-incremental` queues one
`sync.google` job (gmail incremental + calendar in one handler, contacts on Sundays) only for users with
`last_seen_at > now() - interval '14 days'` or a pending draft or reply; skips Gmail when `watch_expires_at > now()` (push
active); LinkedIn poll hourly now that the Unipile webhooks are registered (the 10-minute poll stays only as a fallback when
the account-status webhook reports a problem); calendar every 30 minutes while seen today, hourly otherwise.
`enqueue_cadence` drops the "unarchived chat" clause and requires a draft or stage timer due within the hour.
`orbit-search-reading` daily and demand-driven (B6). Test: `cron-filters.test.ts` on PGlite. Metric: `orbit.job_runs` a day
for one student from ~110 to under 40.

**B6. Readings on demand.** `search_reading` reads only profiles that a network search, a Map target or an open person page
asked for in the last 7 days (a `profile_reads.requested_at` set by those paths), plus the top 50 by tie score once. Census
stays bounded but runs weekly after the first pass. Metric: `reading` ledger rows per student per week under 20.

**B7. `loadGraph` loads the neighbourhood.** `_shared/paths/find.ts:72-185`: a recursive CTE from the target two hops out
(the hop limit is 3 with the student as the first hop), `features->'reciprocity'` only, no `evidence` column (fetch for the
chosen paths in `namesOf`/`decorate`), and after `upsertTies` patch the in-memory graph instead of a second `loadGraph`.
Test: `agents-paths.test.ts` (same routes as before on the fixture; one people query per search). Metric: `/paths/find` avg
under 1.5 s and under 1 MB of rows read per search.

### Phase C: server Claude calls

**C1. No call where the answer is fixed; one call where there were two.** `funnel.ts:166` uses `replyTemplate` with
`confirms`; `orbit-api/routes/paths.ts:60-61` one compose with a two-message schema; `voice/voice.ts:346` distills only edits
since `voice_relearned_at` plus the kept notes, on Sonnet 5.5 (DECISION 34 C5c, carried here); compose reply thread 4 × 800
and examples 2 × 800 (`prompts.ts:122`). Metric: `compose` ledger rows per intro ask 1; `voice_distill` input tokens per night
under 3,000.

**C2. Batch the unattended.** `_shared/claude.ts` gains `structuredBatch()` on Message Batches with a `claude.batch.poll`
worker job every 5 minutes; cadence drafts, autopilot first touches and auto-replies (they all wait for a review window
anyway), voice distill and search_reading go through it; the draft route and chat-triggered composes stay synchronous.
Metric: `<task>:batch` rows cost half of their synchronous twins per token.

**C3. Email lookups on demand.** `_shared/sourcing/email.ts`: a sourcing run returns candidates with `emailStatus:
'not looked up'`; the lookup runs when the student adds the person or asks to email them, or for the top 3 by fit when the
ask was explicitly "with emails"; pattern-guess first when `pattern:` for the domain is cached (free), verify only before a
send. Keep the 40-a-month global cap. Metric: Hunter credits per sourced person under 0.3.

### Phase D: tradeoffs, each behind its bench (DECISIONS)

**D1. Chat effort.** `loop.ts:271`: `low` for turns the local router marks simple (lookups, opens, lists), `medium` for the
rest; then, if the bench holds, `low` for all. Bench: two `chat-baseline.sh` runs each (about $8 a run). Metric: cost a
message down 10% or more at the same scorecard.

**D2. Chat model.** Only if D1 leaves a gap to the margin target: Sonnet 5.5 for chat (`proxy.ts:37` allow, `loop.ts:245`
model), gated by two bench runs at 2.5. Separate cache namespace, so switch between conversations, never inside one.

**D3. Drafts.** `_shared/claude.ts:62-63` compose at `low`, then Sonnet 5.5, each gated by `draft-bench-live` at 19 of 27 on
two runs after the bench learns the model from an env var and sums cost from `usage_ledger` (34 found the gaps). Expected:
$0.031 to about $0.016 (Sonnet) or $0.010 (Sonnet low) per reply draft.

**D4. research_brief effort `medium`** (`claude.ts` task table), resume parse to Sonnet (34 C5b). Spot-check 3 outputs each.

### Phase E: the LinkedIn line

**E1. Unipile reconciler.** Worker job `unipile.reconcile` nightly (pg_net is not needed; the worker has the key): list
accounts, flag any LinkedIn account not in `integration_accounts` in the cost digest with its id and created date; count in
`health()`. Never deletes. **E2 (DECISION, destructive):** delete the four orphan accounts `TZ5yAhLzT2eE7s-T9IaQYg`,
`SMnvVlAeQb-fpU2MxOxdMg`, `ojNFyma6ReeZrn_RDArgHw`, `aCgWtgR-RzOWZQKU1-2VQg` through `DELETE /api/v1/accounts/{id}` from
SQL (pg_net), one at a time, after Anish confirms they are not Osmo's (Osmo's are the July ones). **E3 (ANISH):** ask Unipile
for 50- and 100-account pricing. **E4 (DECISION):** the browser-side reader, scoped as its own plan if chosen.

**E5. Park idle LinkedIn links (DECISION, changes the student's experience).** Unipile bills the peak of simultaneously
linked accounts. A nightly job marks students with no visit in 21 days, no scheduled send and no open reply thread; it
disconnects their Unipile account (keeps `integration_accounts` with `status = 'parked'` and every synced row), and the app
shows "Reconnect LinkedIn" on their next visit, which runs the existing hosted-auth flow and resumes sync from the stored
cursor. Never parks a student with autopilot on. Test: `connectors.test.ts` (parked accounts skip polls; reconnect reuses
the row). Metric: linked Unipile accounts divided by students active in the last 30 days, near 1.

**E6. Email providers.** Behind C3 (on demand), swap the finder to Enrow or Icypeas ($17 to $19 per 1,000, never expire)
with Hunter's free 50 as the fallback, and verify through Reoon ($0.0012) only before a send. `_shared/sourcing/email.ts`
already has a provider seam for Hunter; add the two as providers chosen by which key is in `orbit_private.secrets`. ANISH:
signups and keys. Metric: email $ per found address under $0.03.

**E7. Search provider.** 34 B5 already routes people sourcing through Serper or Parallel when the keys exist; the Serper
signup is free (2,500 searches). Until then every sourcing run pays Claude web search at $0.01 a search.

## 7. Before and after

| Metric (query) | Before, 2026-11-09 | After A | After B | After C | After D |
|---|---|---|---|---|---|
| Chat $ a request, owner, warm (§9.1) | $0.023 | | | | |
| Cache read tokens, first request of a fresh conversation (§9.1) | 63,395 | | | | |
| Cold write $ (§9.1) | $0.32 | | | | |
| Median cache write a request (§9.1) | ~800 | | | | |
| Requests a message (§9.1) | 1.8 | | | | |
| `/goals/infer` per turn (§9.2) | ~0.8 (estimate) | | | | |
| `score.page` wall s a night (§9.4) | 24,707 (11-08) | | | | |
| Rows in the first pull after a score run (§9.5) | ~28,000 (estimate) | | | | |
| orbit-api calls a day, one tab (§9.2) | ~300 | | ~35 (B3 estimate, to measure after deploy) | | |
| `/linkedin/status` a day (§9.2) | 175 | | 1 to 3 (B3 estimate: card opens and LinkedIn mark moves) | | |
| Job runs a day, one student (§9.4) | 110 | | | | |
| Hunter credits per sourced person | 1 to 2 | | | | |
| Reply draft $ (§9.3) | $0.031 | | | | |
| Unipile accounts (§9.6) | 11 (10 included) | | | | 7 on the key, 1 Orbit, 0 orphans (E1 first run 11-09; E2 done) |
| Tool chars loaded in the cached prefix (offline, `context-budget.test.ts`) | 120,300 (114 tools, all loaded) | 29,444 (20 core, tool search, web_search; 82 deferred, sent but not loaded) | | | |
| Fixed system block chars (`system.test.ts`) | 38,250 | 23,880 | | | |
| Playbook block chars, IB recruiting student (header is now the section list) | 10,240 | 9,681 | | | |
| Cached prefix chars before the conversation (loaded tools + fixed block + playbook; tokens wait for the bench) | 168,800 | 63,000 | | | |

### 7.1 Shipped 2026-11-09

- Live: migrations 20261118 to 20261122 applied in order; orbit-worker, orbit-api, orbit-webhooks, orbit-connectors,
  orbit-research and orbit-claude deployed from 806dd91 (pushed first as `cost-35`); main pushed at 806dd91, which ships
  the web side (tool search with the 400 fallback, one change mark instead of three polls, Find email on demand).
- Phases A, B, C and E built and deployed. E2 done (four orphans deleted after checking each one). E5 on at the default
  21 days (`ORBIT_LINKEDIN_PARK_DAYS` unset). E6 and E7 wait on the Enrow, Icypeas, Reoon and Serper keys.
- Phase D not shipped: none of D1 to D4 ran its bench.
- Chat check, old against new code, 14 scenarios through the local CLI shim (`docs/qa/chat-runs/cost35`, not committed):
  scorecard 4.00 before, 3.93 after, 0 unsafe and 0 invented in both, 3 below the bar in both. The repeated reply and
  repeated button row appear in both arms, so they predate this plan. The shim cannot price tool search or the caller's
  cache breakpoints (it defers every tool and skips caching), so the dollar columns above wait for real traffic.
- First checks after deploy: every job run ok, no dead letters, no orphaned runs; `orbit.user_marks` moved on the first
  calendar sync; LinkedIn polls hourly. The remaining after numbers come from §9 once a day of traffic has run.

## 8. Decisions and approvals for Anish

1. Delete the four orphan Unipile accounts listed in E2 (saves the extra account billed now).
2. Bench budgets: chat about $8 a run, two runs per lever (D1, D2); drafts about $3 a run, two runs per lever (D3). Each
   needs the Orbit Anthropic key funded.
3. D1 to D4 as listed, each after its bench.
4. Ask Unipile for volume pricing; whether to scope the browser-side reader (E3, E4).
5. Park idle LinkedIn links (E5): students reconnect after 21 days away, for about 55% off the LinkedIn line.
6. Email providers (E6): Enrow or Icypeas plus Reoon instead of a Hunter plan; signups are yours.
7. Still open from 34: the Orbit workspace key, Serper signup (free), GCP Pub/Sub for Gmail push.

## 9. Queries

```sql
-- 9.1 chat shape per request and per day
select (at at time zone 'utc')::date d, count(*) requests,
       round(avg(usd)::numeric,4) usd_req, percentile_cont(0.5) within group (order by cache_write) med_write,
       round(100.0*sum(cache_read)/nullif(sum(cache_read+cache_write+input),0),1) cache_pct,
       sum(web_searches) searches, max(cache_write) biggest_write
  from orbit_private.claude_usage where subject like 'user:%' group by 1 order by 1 desc;

-- 9.2 edge invocations by path (Supabase MCP query_logs)
-- select log_attributes['request.pathname'] path, count(*) n from logs where source='function_edge_logs'
--   and log_attributes['function_id']='71591932-e5a3-4570-a1a8-96b975934cbf' group by path order by n desc

-- 9.3 server spend by task
select operation, count(*), round(sum(cost_usd)::numeric,4) usd, round(avg(cost_usd)::numeric,5) each
  from orbit.usage_ledger where provider='anthropic' and created_at > now()-interval '14 days' group by 1 order by 3 desc;

-- 9.4 jobs per kind per day, deaths
select (started_at at time zone 'utc')::date d, kind, count(*) runs, round(sum(duration_ms)/1000.0) s,
       count(*) filter (where error='died with the isolate') deaths
  from orbit.job_runs where started_at > now()-interval '7 days' group by 1,2 order by 1 desc, 4 desc;

-- 9.5 rows a pull would return now (tie_scores + ties + people updated in the last 24 h)
select (select count(*) from orbit.tie_scores where updated_at > now()-interval '24 hours')
     + (select count(*) from orbit.ties where updated_at > now()-interval '24 hours')
     + (select count(*) from orbit.people where updated_at > now()-interval '24 hours') rows_24h;

-- 9.6 Unipile accounts (pg_net; the key never leaves the database)
select net.http_get(url := public.orbit_secret('UNIPILE_BASE_URL')||'/api/v1/accounts',
       headers := jsonb_build_object('X-API-KEY', public.orbit_secret('UNIPILE_API_KEY'),'accept','application/json'));
-- then: select jsonb_array_length(content::jsonb->'items') from net._http_response where id = <request_id>;

-- 9.3b cache gap walk for the 1-hour decision (item 27): share of owner requests that follow a gap over 5 minutes
with r as (select at, lag(at) over (order by at) prev from orbit_private.claude_usage where subject like 'user:%')
select count(*) filter (where at - prev > interval '5 minutes') cold, count(*) total from r;
```
