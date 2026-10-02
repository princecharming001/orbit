# 11. Testing, evals and observability

Status: build specification. What must be true before each phase ships, how model tasks are measured, and what is instrumented.

---

## 1. Test layers

| Layer | Tool | Scope | Runs |
|---|---|---|---|
| Unit | Vitest | `packages/core` (normalisers, entity resolution features and decisions, strength, edges, paths, layout, transitions, suggestion rules, scoring, validators), `packages/ai` validators and prompt assembly, `packages/integrations` parsers (CSV, MIME, quote stripping, Granola note parsing) | every PR, < 60 s |
| Integration | Vitest + local Supabase (`supabase start`) | migrations apply cleanly; DB functions (`apply_stage_transition`, `merge_people`/`undo_merge`, `check_send_allowed`, `bind_approval`, strength trigger); repositories enforce scope; RLS denies cross-user reads | every PR, < 4 min |
| Jobs | Vitest + Inngest test harness (`@inngest/test`) with recorded fixtures | each function's steps with mocked adapters; idempotency on replay; backfill chunking; brief generation end to end on the demo user | every PR |
| E2E | Playwright (Chromium) against a preview deployment with the demo seed | onboarding (steps 2–4, 6 upload, 8), Today approve-with-undo, pipeline drag, profile, map renders and reach panel, capture box, settings disconnect | nightly and before release |
| Contract | recorded provider responses (fixtures) + a weekly live smoke against sandbox accounts (Gmail test account, PDL sandbox key, Granola test workspace) | adapter parsing stays valid | weekly |
| Load | k6 script against staging: 50 concurrent brief generations; map data query at 2k nodes; Gmail backfill of a 20k-message seeded mailbox | p95 budgets in 09 section 4 and 06 section 7 | before pilot and before each 10× user growth |

Coverage gate: `packages/core` ≥ 90 percent lines; others ≥ 70 percent.

---

## 2. LLM evals (`packages/ai/evals`)

Each task has `datasets/<task>.jsonl` (input, expected, metadata) and a runner `pnpm eval <task>` that calls the real API (Batch mode where possible) and prints metric, cost and a diff against the last run stored in `evals/results/<task>/<date>.json`. CI runs a 30-item smoke subset per task on prompt or schema changes (budget ≈ $2 per run); the full set runs nightly on `main`.

| Task | Dataset (target size) | Metric | Threshold | Judge |
|---|---|---|---|---|
| T1 resume_parse | 60 real resumes (anonymised, consented) + 40 synthetic | field-level F1 on experiences/education/skills | 0.90 | code |
| T2 goal_structuring | 100 goal forms | label accuracy | 0.90 | code |
| T3 email_triage | 500 threads (from founder/pilot inboxes with consent, redacted) | networking precision / recall | 0.92 / 0.90 | code |
| T4 message_signal | 400 messages | signal accuracy; time extraction exact match | 0.90 / 0.85 | code |
| T5 contact_extraction | 150 signatures | precision | 0.95 | code |
| T6 note_extraction | 60 notes/transcripts | fact precision (human-rated once, then judge), action-item recall | 0.90 / 0.85 | human → judge |
| T7 person_summary | 100 persons | rubric (accurate, grounded, useful) 1–5 | mean ≥ 4.0; no ungrounded claim | T15 judge |
| T8 draft_message | 200 context packs × kinds | validator pass; rubric (specific, in voice, correct ask, no fabrication) | 0.98; mean ≥ 4.0; fabrication 0 | code + T15 |
| T9/T10 | 50 each | rubric | ≥ 4.0 | T15 |
| T11 merge_judge | 200 pairs (100 same, 100 different incl. hard negatives: same name different person) | precision on `same_person` | 0.97 | code |
| T12 style_card | 20 users' sent mail, held-out 10 emails each | judge "written by the same person?" agreement | 0.80 | T15 |
| T14 fit explanation | 100 | no fabricated fact | 0.99 | T15 |
| Entity resolution (code) | 1,000 record pairs | precision / recall of merges | 0.98 / 0.90 | code |
| Stage inference (code) | 150 chat histories replayed | final stage accuracy | 0.95 | code |

Judge (T15) prompt lives in `evals/judge.md`; judge calibration: 50 items double-rated by a human each quarter, agreement ≥ 0.8 or the judge prompt is revised.

Online metrics are the real evals: approval rate, edit distance, reply rate, stage correction rate, fact deletion rate (01 section 14), reviewed weekly.

---

## 3. Golden data collection

- Founder's own inbox and pilots' inboxes with written consent, exported by the app's own export, redacted by a script (`evals/tools/redact.ts`: replaces names with consistent pseudonyms, emails, phone numbers, URLs) and reviewed by hand before entering the repo (private repo; datasets are still gitignored and stored in a private bucket, pulled by `pnpm eval:pull`).
- Synthetic augmentation (generated with Opus 5.5 from templates) only for rare classes (declines, reschedules, intro offers) and labelled as synthetic.

---

## 4. Performance budgets (measured in CI with Lighthouse and custom timers)

| Surface | Budget |
|---|---|
| Today page TTFB / LCP (cold, 2k-person user) | 400 ms / 1.5 s |
| Map first paint at 1,500 nodes | 800 ms; steady 60 fps during rotation on a 2020 MacBook Air |
| Profile page | 600 ms LCP |
| Welcome brief after Google consent | p50 5 min, p95 12 min for mailboxes ≤ 30k messages |
| Brief generation job | p95 4 min per user (7 drafts) |
| Approve → provider accepted | p95 90 s (60 s undo window + send) |

---

## 5. Product analytics (PostHog; user id = sha256(user id + salt); no names/emails)

Events: `signup`, `onboarding_step_completed {step}`, `google_connected`, `linkedin_export_uploaded {rows}`, `resume_parsed {facets}`, `welcome_brief_ready {minutes}`, `brief_delivered {cards}`, `brief_opened {channel}`, `suggestion_shown {kind, rank}`, `suggestion_decided {kind, action, edit_distance, seconds_to_decide}`, `message_sent {channel, kind}`, `reply_received {days_since_send, kind}`, `stage_changed {from, to, actor, proposed}`, `stage_corrected`, `note_ingested {source}`, `fact_deleted {type}`, `map_opened`, `reach_run {target_kind, paths, best_band}`, `intro_requested`, `recommendation_decided {action, reason}`, `integration_problem {provider}`, `export_requested`, `deletion_requested`.

Dashboards: activation funnel; daily brief engagement; suggestion quality by kind; reply rate by path band and kind; integration health; LLM cost per user per day (from `ai_calls`, not PostHog).

---

## 6. LLM observability and cost control

- Langfuse: every `runTask` call is a trace with task, prompt version, user hash, tokens, cost, latency, and the parsed output; drafts carry the validator result; a daily job computes cost per task and per user.
- Alerts (Sentry cron monitors + a Langfuse threshold): realtime task p95 latency > 20 s; refusal rate > 1 percent per task per day; parse_error rate > 2 percent; daily LLM spend > 2× the 7-day average; any user over $5/day.
- Cost levers are applied only after the eval for that task passes at the new setting (05 section 12).

---

## 7. Definition of done per feature

Code reviewed; unit and integration tests pass; e2e covers the happy path; the task's eval meets threshold (if a model task was touched); PostHog events emitted and seen in the dev project; copy reviewed against 01 section 13; Sentry shows no new error class in staging for 24 hours; the relevant `docs/orbit` section updated if behaviour changed.
