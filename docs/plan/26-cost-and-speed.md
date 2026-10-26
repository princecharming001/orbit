# 26. Cost and speed: what the audit found, ranked

Status: audit done 2026-10-26. Batch 1 (2, 3, 4, 5, 6 below) is built; 1 follows on its own because it changes
what every chat request sends and needs the cache-read numbers checked live. Grounded in the live project's logs and tables, the
code, Unipile's docs and Anthropic's pricing. Every number below is measured unless marked estimate.

## What the numbers say today

- **Chat spend is small in absolute terms but has the worst unit economics.** The founder's account: $1.99 over 96 chat
  requests in three days, $0.021 a request. Every request re-reads a 20 to 24K token prefix (95 tools and a 22 KB system
  prompt), and that prefix is re-written at about $0.12 after every five-minute pause, because the system block
  carries a per-conversation nonce (`chat/agent/system.ts` `stableSystemText(nonce)`). Memory and resume reads for
  shared-key users run on Opus (`integrations/anthropic.ts` forces `MODEL` when not own-key; the proxy allows only
  `claude-opus-5-5`). Estimate for an active student: about $20 a month now, about $8 after the fixes below.
- **The worker ticks every minute, work or not:** 1,437 edge invocations a day for 2 users. 694 job runs a day, 557 of
  them `sync.gmail.incremental` (a 10-minute poll per Google account) and 95 `sync.calendar` at 4.8 s each.
  Gmail push (the Pub/Sub webhook and `watch`) is built but no account has a watch set.
- **Village is failing:** 17 of 21 `/paths` calls in a day returned 502. Person lookups by LinkedIn URL and company
  lookups get a 401 from Village (the token exchange works, those endpoints refuse it). Every map route and company
  page still waits about 0.7 s on it.
- **LinkedIn reads:** the founder's account spent all 100 profile reads yesterday (photos and enrichment took 70 to 80
  of them before the ceilings were lowered). Unipile bills per connected account, not per read: $55 a month for 10,
  then $5.50 each. The connect flow only ever creates (`type: 'create'`): after LinkedIn signs someone out, "Sign in
  again" makes a second billed account and the old one is never deleted.
- **First load:** the main chunk is 2.3 MB (763 KB gzipped) and the landing page loads all of it: the app shell, the
  chat registry (every tool, every engine file), `@anthropic-ai/sdk`, and the demo seed.
- **After open:** the photo queue writes `db.people` every 15 s for five minutes, re-running every whole-table live
  query (Map, Drafts, People) and invalidating the reach-graph cache each time. Repairs and enrichment chains run on
  every open with no stamp. The map's perf check fails on CI (33 ms a frame at 300 people, budget 24) since photos
  went in: sprites are resampled every frame and a filter sweep rebuilds them per node.
- **CI:** about 53 machine-minutes a push (13 wall): six builds, five Playwright installs, `pnpm test` at 11 minutes.

## Ranked changes

| # | Change | Saves | Effort | Status |
|---|---|---|---|---|
| 1 | Chat prefix cached once for everyone: nonce and tag rule out of the system block, into the first turn | about $5 to $10 per active user a month; faster first token | S | batch 1 |
| 2 | Shared-key memory and resume reads on Haiku (allow it in the proxy per call type) | about $2.50 per active user a month | S | batch 1 |
| 3 | Worker tick only when the queue has depth (plus a 10-minute heartbeat) | 90% of 43K invocations a month | S | batch 1 |
| 4 | Village: a 401 pauses Village for the day on the client, and the server answers 200 with a reason instead of 502 | 0.7 s off every route and company page while Village is broken | S | batch 1 |
| 5 | Unipile reconnect instead of create when an account was signed out; delete the old account if a new one is made | one billed account per student | S | batch 1 |
| 6 | Relations in pages of 1,000 (was 200), daily first page only, full pull monthly; drop the list-all-accounts fallback from the 2-second connect poll | 5x fewer relation pages; connect poll no longer O(accounts) | S | batch 1 |
| 7 | Landing and login without the app: lazy `AppShell` and chat, dynamic SDK import, lazy demo seed | 763 KB to about 200 KB gzipped for a first visit | M | batch 2 |
| 8 | Photos written outside `people` (their own table or a kv row), so the queue never re-renders the app or busts the graph cache | no 15-second re-render loop after open | S/M | batch 2 |
| 9 | Map sprites: snap to native size within 4%, no rebuilds mid-animation, reuse the canvas | the perf check back under budget | S | batch 2 |
| 10 | Trim tool descriptions and field text (48K chars) toward a 12K-token prefix | $3 to $6 per active user a month | M | batch 2 |
| 11 | Gmail push: set the watch when `GMAIL_PUBSUB_TOPIC` is set (needs a Pub/Sub topic in Google Cloud), polling falls to hourly | replies in seconds; 500 fewer jobs a day per user | M (one GCP step) | needs the founder |
| 12 | Unipile webhooks for browser-mode accounts (messages, account status, new relations) stored by account id and read by the browser as `/events?since` | no reply polling; replies in seconds; no Settings health check | M | batch 3 |
| 13 | CI: build once and share `dist`, cache Playwright, split `pnpm test`, run the perf job only when the map changed | 13 to about 8 minutes a push; a third fewer machine-minutes | S | batch 2 |
| 14 | Proxy: merge the two PostgREST reads into one RPC; don't await the spend writes inside the stream | 50 to 100 ms off first token | S | batch 2 |
| 15 | Batch API for unattended server jobs (cadence composes, nightly classify and memory) | half of server LLM spend | M | batch 3 |
| 16 | Shared-read cache by kind: work history 14 days, engagement 1 to 3 days, photos until their link expires | fewer repeat profile reads across students | S | batch 2 |
| 17 | Logos and company ids from the profile and search payloads Orbit already has; a company ledger of its own | up to 30 profile reads a day back | S | batch 2 |
| 18 | Repairs stamped per app version; the open reply check gated on the last check (5 minutes) | less work on every open | S | batch 2 |
| 19 | Simple chat turns at low effort by the local router | 20 to 30% of output tokens on half the turns | S | batch 2 |
| 20 | Chat on Sonnet 5.5 (needs the sim eval first) | half of chat spend | M | decision |
| 21 | TTLs: `usage_ledger`, research tables, an index on `orbit_proxy_counters.expires_at`; two lifetime caps that disagree ($20 vs $30) | hygiene before scale | S | batch 2 |

## Things the docs say Orbit should not do

- Fetch relations at fixed times (app open daily) in full pages of 200: Unipile wants the first page a few times a day
  at random intervals after the initial sync. Webhooks (12) remove the sharpest pattern.
- Create a new account on reconnect (5).
- Treat 429 as a browser-only pause; the server should pause that account's ledgers for the day too.

## Not confirmed

- Exact prefix size in tokens (run `count_tokens` on the built request before and after 1 and 10).
- Whether Unipile stops billing a deleted account mid-month.
- Whether `current_positions` with logos comes back on classic search results.
- Whether the 33 ms map frames are raster- or script-bound (the perf job prints both).
