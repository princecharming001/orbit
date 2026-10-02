# 12. Roadmap and execution plan

Status: build plan. Phases, tasks in order, acceptance criteria, what must be true to start each phase, the launch checklist, cost summary, and the runbook. Execute phases in order; inside a phase, tasks are ordered by dependency.

Team assumption: one engineer (with Claude Code) full time, the founder on product, pilots and vendor accounts. Durations are working days.

---

## 0. Before writing code (founder tasks, week 1, in parallel with Phase 0)

| # | Task | Output |
|---|---|---|
| F1 | Buy the domain; create Vercel, Supabase, Inngest, Resend, Anthropic, Voyage, People Data Labs, Sentry, PostHog, Langfuse accounts; GCP project | credentials in a password manager; `.env.example` filled |
| F2 | Google OAuth consent screen + brand verification; privacy policy and terms pages (static, on the domain); demo video once onboarding exists (end of Phase 1); submit restricted-scope verification; engage a CASA Tier 2 lab | verification in progress by week 4 (04 section 2.2) |
| F3 | Resend: verify `mail.<domain>`, enable Receiving on `in.<domain>` | DNS done |
| F4 | Pilot roster: up to 100 students at one school, with emails for the Google test-user list; 10 "design partners" who agree to share redacted inbox samples for evals | roster + consents |
| F5 | Obtain one real LinkedIn data export (own account) and one real Wispr Flow export; a Granola Business trial and a Fathom free account | fixtures for Phase 1/5 [GAP closers] |
| F6 | Decide the product name and replace "Orbit" by search-and-replace in `docs/orbit` and code | name |

---

## 1. Phase 0 — Foundations (5 days)

Tasks:

1. Create the monorepo per `02` section 3 (pnpm, Turborepo, Biome, TS strict, Vitest, Playwright skeleton, Next.js 15 app with the app shell and sign-in).
2. Supabase project + local stack; migrations `0000`–`0012` from `03`; Drizzle schema; `pnpm db:migrate`, `pnpm db:seed` (schools, organizations); RLS tests.
3. `packages/core` scaffolding with `schemas/` for every jsonb schema named in `03`.
4. Inngest client, `/api/inngest`, one hello function, local dev script with tunnel.
5. Sentry, PostHog, Langfuse wired; `runTask()` skeleton with cost accounting and a smoke eval (`pnpm eval smoke`).
6. CI: lint, typecheck, unit, integration (local Supabase), `drizzle-kit check`, preview deploy.
7. Demo seed (`pnpm seed:demo`): a fictional student with 300 people, 40 chats, 2k touchpoints, 20 notes, built from fixtures.

Acceptance: `pnpm dev` boots everything; sign-in works; the demo user sees empty-but-rendering Today, Pipeline, People, Map, Discover, Inbox, Settings pages; CI green.

---

## 2. Phase 1 — Onboarding, Google sync, people (10 days)

Tasks:

1. Onboarding steps 1–5 and 8 (01 section 4) with `saveOnboardingStep`.
2. Google OAuth flow, token encryption, `integration_accounts`, reconnect flow and the Testing-status weekly reminder.
3. Gmail adapter (list, get, history, watch, send stub), MIME parsing, quote/signature stripping, prefilter, bulk-domain list.
4. Calendar adapter (list, watch), coffee-chat detection.
5. Entity resolution (05 section 4) with unit tests on 1,000 synthetic pairs; organisation normalisation; `merge_people`/`undo_merge`.
6. Backfill functions (fast + full), push handler, watch renew, token check, sync status UI (progress bar).
7. T3 `email_triage` and T4 `message_signal` with datasets v0 (founder inbox, 200 threads), batch mode for backfill.
8. Touchpoints and strength (06 sections 2–3) with the nightly recompute.
9. Resume upload + T1 + facet review UI; T2 goals.
10. People list and profile page (header, timeline, facts from T4 only, chats placeholder).

Acceptance: founder's real Gmail connected; fast path produces people with correct strengths and the networking threads of the last 90 days are correctly flagged (spot check 50 threads ≥ 90 percent); full backfill of a 20k mailbox completes under 45 minutes within quota; profile pages show timelines; merge suggestions appear for known duplicates; evals T3/T4 at threshold on v0 datasets.

---

## 3. Phase 2 — Pipeline and stage inference (6 days)

1. `coffee_chats`, stage machine, `apply_stage_transition`, proposed-transition cards.
2. Thread → chat linking, calendar → `scheduled`/`completed`, completed sweep.
3. Pipeline board and table, chat drawer, companies roll-up; tracker import (step 9).
4. Today page v1: needs-you cards (confirm stage, merge), upcoming, progress; welcome brief with detected chats only.
5. Stage-inference replay eval (150 histories) and the correction feedback loop.

Acceptance: the founder's last-90-day chats appear in the right stages with ≤ 10 percent corrections; drag-to-stage works; the companies roll-up matches the people list; e2e for pipeline passes.

---

## 4. Phase 3 — Drafting, sending, approvals (8 days)

1. T12 style card from sent mail; Settings → Writing style.
2. Context pack, T8 `draft_message` for all kinds, validator, `needs_review` path.
3. `outbound_messages`, `bind_approval`, `check_send_allowed`, approve/edit/undo flow, Gmail send with threading and the correlation header; sent-message detection by push.
4. Approvals centre (`/inbox`), draft editor, keyboard shortcuts, undo toast.
5. Suggestion rules for `follow_up_bump`, `thank_you`, `schedule_propose`, `schedule_confirm`, `action_item_reminder` (⚡ and nightly), scoring, dedupe, carry-over.
6. `brief-tick`, `brief-generate`, `brief-deliver`, Resend templates (daily, welcome), notification preferences, unsubscribe topics.
7. Evals: T8 dataset v0 (100 packs) with judge; T12.

Acceptance: a daily brief arrives at 07:00 local with correct cards; approve → sent from Gmail in the right thread; undo works; caps and cooldowns block as specified (integration tests); validator pass ≥ 0.98; founder approves ≥ 40 percent of drafts without edits over one week of use.

---

## 5. Phase 4 — LinkedIn, enrichment, map and Reach (9 days)

1. LinkedIn export upload, parser pinned to the real export (F5), import job, step 6 UI with the guide and the email reminder.
2. Enrichment provider interface, PDL adapter, cache, budget rules, refresh cron, job-change detection; `congratulate` rule.
3. Edge inference (06 section 4), graph recompute, connections panel on profiles.
4. Orbit map: layout, canvas rendering, filters, tooltips, drawer, rotation, performance test at 1,500 nodes.
5. Reach: target resolution (network, PDL search), Yen's k-paths, explanations, panel, "Ask for intro" → `intro_request`.
6. Discover v1: candidate generation (own network + adjacent + PDL search with budget), scoring, diversity, T14 explanations, `new_outreach` suggestions, `copy and open` LinkedIn channel.

Acceptance: founder's 800-connection export imports in under 2 minutes; 100 enrichments produce affiliations and ≥ 200 edges; map renders at 60 fps; Reach returns sensible paths for 10 hand-checked targets (founder judgement: ≥ 7 of 10 best paths are the ones they would have picked); Discover's weekly 10 includes ≥ 3 alumni; PDL spend under $30 for the founder's account.

---

## 6. Phase 5 — Meeting notes and memory (6 days)

1. Resend inbound, ingest addresses, Granola-share detection, Fathom adapter; Granola API adapter behind `granola_api` (test with the Business trial).
2. Capture box everywhere, post-chat nudge, upload, Wispr export import (parser pinned to F5's real export).
3. Note matching, T6 extraction, facts with dedupe/supersession, action items, `confirm_note_match` cards, fact deletion tombstones.
4. T7 person summaries and talking points; T10 prep briefs and the `prep_brief` card; `/people/[id]/prep`.
5. `nurture_checkin`, `reconnect`, `ask_referral` rules with hooks.
6. Evals T6/T7/T10 datasets v0.

Acceptance: a Granola note shared by email lands on the right chat within 2 minutes, facts appear on the profile, the next brief carries a thank-you referencing two specifics; prep brief for a scheduled chat is rated useful by the founder; fact precision ≥ 0.9 on 30 hand-rated notes.

---

## 7. Phase 6 — Hardening, pilot launch (7 days)

1. Security pass (10): token rotation job, webhook signature tests, RLS tests, export and deletion flows, kill switches, privacy page.
2. Load test (11 section 1), performance budgets, Gmail quota throttles verified against a 30k mailbox.
3. Observability: alerts, dashboards, cost per user report.
4. Google verification: demo video, submission follow-ups; CASA scan evidence to the lab.
5. Pilot onboarding kit: guide to the LinkedIn export, Granola/Fathom setup, what the weekly reconnect means while in Testing.
6. Launch 25 pilots (week 1), 100 (week 3), all at one school.

Acceptance: 01 section 14 metrics instrumented and visible; zero cross-tenant findings in tests; p95 budgets met; pilots onboarded with activation ≥ 70 percent.

---

## 8. Phase 7 — Learning loop and v1.5 (ongoing after pilot)

- Fit entity-resolution weights and the recommendation ranker from feedback (05 sections 4.3, 8.3).
- Measure cost levers (05 section 12) and apply those that pass evals.
- Unipile LinkedIn messaging behind `linkedin_messaging` for opted-in pilots; Coresignal behind `enrichment_coresignal`; web push; Wispr MCP experiment.
- Pooled campus graph design review (06 section 9) → build only if pilots ask for intros through peers.

---

## 9. Decision log (do not reopen without the founder)

| # | Decision | Where |
|---|---|---|
| D1 | No autonomous sends; approval binds bytes; cadence caps in code | 01 §3.2, 07 §5 |
| D2 | Web app + email; no mobile app in v1 | 01 §2.3 |
| D3 | Supabase + Next.js + Inngest + Drizzle, one deployable | 02 |
| D4 | `claude-opus-5-5` for all tasks, effort-tuned; structured outputs; batch for backfill | 05 |
| D5 | Voyage `voyage-4` 1024-d embeddings in pgvector | 02, 05 §11 |
| D6 | Own Google OAuth app; restricted-scope verification + CASA from week 1; pilot in Testing status | 04 §2 |
| D7 | LinkedIn: export upload + OIDC only; PDL enrichment for history; no scraping; Unipile only behind a flag with explicit consent | 04 §3 |
| D8 | Granola via API (Business) and share-by-email (all); Fathom as the free notetaker; Wispr Flow via capture box and export import | 04 §5–7 |
| D9 | Stages inferred with confidence gates and confirmation cards | 01 §5.2, 05 §6 |
| D10 | Strength model: decayed additive touchpoints, saturating transform | 06 §3 |
| D11 | Orbit layout is deterministic (no physics) on the default map; force layout only in Reach | 06 §6 |
| D12 | Brief: max 7 cards, nightly, email + in-app, 60 s undo | 01 §6, 07 |
| D13 | Enrichment budget 100/user/month, priority order fixed | 04 §3.3 |
| D14 | One product name placeholder "Orbit"; this plan lives beside the unrelated Rooster spec | README |
| D15 | LinkedIn warm-up is manual via deep links, tracked by Orbit; never automated | 13 |
| D16 | v1 ships as a browser-only static app on GitHub Pages with the same domain model; hosted services follow | 14 |

---

## 10. Open gaps (research before the phase that needs them)

| Gap | Needed by | How to close |
|---|---|---|
| Exact headers of LinkedIn `messages.csv` / `Invitations.csv` | Phase 4 | real export (F5) |
| Wispr Flow export ZIP format | Phase 5 | real export (F5) |
| Granola `calendar_event_id` equals Google event id? | Phase 5 | inspect a note from the Business trial |
| Wispr remote MCP OAuth client registration | Phase 7 | try `@modelcontextprotocol/sdk` client against it |
| PDL plan and per-match price at our volume; Coresignal trial | Phase 4 | sales/pricing pages, trial |
| Anthropic data retention terms for API traffic (zero-retention eligibility) | Phase 6 | current platform docs |
| Minimum cacheable prefix length for `claude-opus-5-5` | Phase 1 | SDK reference `shared/prompt-caching.md` at build time |
| Gmail per-user per-second burst limit still enforced alongside the per-minute quota | Phase 1 | observe 429s during the first backfills; the throttle is conservative either way |
| Unipile relations-of-relations availability | Phase 7 | docs/trial |

---

## 11. Cost summary (pilot of 100 users, per month)

| Item | Cost |
|---|---|
| Vercel Pro | $20 |
| Supabase Pro | $25 (+ compute add-on if needed, ~$50) |
| Inngest | free tier at pilot scale; Pro $99 beyond ~50k executions/month |
| Resend Pro | $20 |
| Anthropic API | ≈ $8 × 100 = $800 (first month +$1,000 for backfills) |
| Voyage | ≈ $0 (free tier) |
| People Data Labs | ≈ $15 × 100 = $1,500 at the cap; expected $600 with the priority order |
| Sentry / PostHog / Langfuse | free tiers |
| CASA lab | ≈ $800 one-time, annual |
| Granola Business (founder test), Fathom | $14, $0 |
| **Total** | **≈ $2,000–3,500 / month at 100 pilots**, dominated by enrichment and LLM; both have the levers in 05 §12 |

---

## 12. Launch checklist

- [ ] Google verification submitted; Testing-status reminder flow live
- [ ] Privacy page and terms live; Limited Use language matches 10 §2
- [ ] Kill switches tested in staging
- [ ] Backups: Supabase PITR enabled; restore drill done once
- [ ] Alerts routed to the founder's phone (Sentry) for: send failures > 5/hour, sync failures > 10/hour, LLM spend anomaly
- [ ] Pilot kit sent; 10 design partners onboarded in person
- [ ] Eval thresholds met on v0 datasets; results archived
- [ ] Load test report archived
- [ ] `docs/orbit` updated to match what shipped

---

## 13. Runbook (minimum)

| Symptom | Check | Action |
|---|---|---|
| Briefs not delivered | `briefs` rows for the date; Inngest `brief-tick` runs; Resend logs | re-emit `brief.generate` for affected users; if Resend down, in-app only and a status note |
| Gmail pushes stopped | `sync_state.watchExpiration`; Pub/Sub subscription errors | run `gmail-watch-renew` manually; check OIDC audience |
| 429 from Gmail | `sync_runs.stats.errors` | lower the `gmail.messages.process` throttle flag; backfills resume automatically |
| Token revoked for many users | Google console incidents; app verification status | notification + reconnect; if verification lapsed, pause syncs (`syncs_enabled`) |
| LLM parse errors spike | Langfuse by task; prompt version | roll back the prompt version (registry keeps the previous file); file an eval case |
| Duplicate people appear | `merge_suggestions` pending count; entity-resolution logs | run the nightly merge job manually; tune thresholds with the feedback data |
| A user reports a message they did not approve | `audit_log`, `outbound_messages` for the id and hash | this must be impossible; if it happened, `sends_enabled = false`, investigate, notify |
