# 16. Orbit as a networking agent: infrastructure and capability plan

Status: **decided**. Supersedes 02 (stack), 08 (jobs) and 09 (API) wherever they disagree.
Written to be implemented literally, phase by phase (§19). Every number is a decision; research behind a number is cited in §22.

How to read it: §0 is the audit and the decisions that shape everything. §1–§10 are the ten capabilities. §11–§17 cover the cross-cutting topics. §18 is the iteration log, §19–§21 the build order, dependency graph and human actions, and §22 the sources.

Sections 1–17 all use the same eight sub-headings: **n.1 Purpose · n.2 Reuse / Extend / New · n.3 Design · n.4 Data · n.5 APIs and open source · n.6 Prompts · n.7 Edge cases · n.8 Acceptance tests.**

---

## 0. Audit of the current stack, and the decisions it forces

Facts are from the code at `7d1fa4d` (`main`). File references are relative to the repo root.

### 0.1 What exists

| Area | As built | Where |
|---|---|---|
| Storage | Dexie (IndexedDB), 30 tables: users, settings, goals, targetCompanies, resumes, resumeFacets, organizations, people, affiliations, edges, touchpoints, threads, messages, events, chats, stageEvents, notes, facts, actionItems, outbound, suggestions, briefs, recommendations, feedback, notifications, audit, merges, integrations, styles, kv, chatConversations, chatMessages, chatActions | `apps/web/src/db/schema.ts:102-141`, types in `packages/core/src/types.ts` |
| Accounts | None. The user is a local row; secrets (Claude key, Google client id) live in IndexedDB `orbit-local` | `engine/account.ts:12`, `integrations/prefs.ts` |
| Google | GIS token flow in the browser; 1-hour token in `sessionStorage`; **no refresh token**; scopes `gmail.readonly`, `gmail.send`, `calendar.events.readonly`; first sync reads 90 days, ≤ 1,500 ids per query, `format=full`; no People API | `integrations/google.ts:7-19,144`, `engine/sync.ts:51-198` |
| LinkedIn | CSV/ZIP import; Unipile via `orbit-connectors` (hosted auth, relations, mutuals via `linkedin/search` + `connections_of`, disconnect) | `engine/linkedin.ts`, `integrations/unipile.ts`, `supabase/functions/orbit-connectors/connectors.ts` |
| Village | `POST {base}/v1/paths` with Bearer key. **Wrong: Village's public API is v2** (`/v2/auth/tokens`, `/v2/people/paths`, `/v2/companies/paths`) | `connectors.ts:336` |
| Strength | 0–1, 90-day half-life over weighted touches; tiers strong ≥ 0.6, medium ≥ 0.3 | `packages/core/src/scoring/strength.ts:56-135` |
| Ties between others | `inferEdges`: co_tenure, same_school_cohort, email_cothread, meeting_coattendee, introduced_by, same_current_company. **Unipile mutuals and Village paths are shown in panels but never written to the graph** | `packages/core/src/graph/edges.ts:71` |
| Paths | Hop-bounded Dijkstra, cost `−ln w`, Yen's k-shortest (≤ 3 hops); score = product of weights | `packages/core/src/graph/paths.ts:109-271` |
| Drafts | Template engine with 10 kinds, word limits, banned phrases, validator, exemplar corpus; optional Claude rewrite that must pass the validator; style card from sent mail | `packages/core/src/drafts/*`, `engine/brief.ts:958-1000` |
| Pipeline | identified → warming → outreach_sent → replied → scheduling → scheduled → completed → followed_up → nurturing (+ declined, no_response, archived); quiet after 7 days; bumps at 5/8 business days (Gmail) and 10/12 (LinkedIn) | `pipeline/transitions.ts`, `suggestions/rules.ts:85` |
| Background work | Browser timers only (`dailyMaintenance` on open, `OutboxScheduler` every 3 s) | `AppShell.tsx:120`, `OutboxScheduler.tsx` |
| Chat agent | 69 tools, system prompt v8, `claude-opus-5-5` via the user's key or the `orbit-claude` proxy, a 400–700-token snapshot per turn, **no long-term memory** | `apps/web/src/chat/*` |
| Server | `orbit-claude` (Claude proxy, per-IP limits), `orbit-connectors` (Unipile/Village proxy); one migration (rate-limit counters, `orbit_private.secrets`) | `supabase/` |
| Tests | ~660 web unit, ~459 core, ~174 e2e, a 24-scenario user-sim (student + judge) | `apps/web/src/chat/__tests__/sim/` |

**Infrastructure finding.** Supabase project `nxibeiykcgxpbmkeadth` is **shared with several other apps**: their tables in `public`, their cron jobs, and one `auth.users` with a Google provider configured for another app. Any of those apps' service-role keys can read every table in the project.

### 0.2 What is re-architected

1. **Server-side store for ingested data.** Analyzing years of mail and LinkedIn messages cannot live in IndexedDB: it cannot run while the browser is closed, the browser cannot hold a refresh token safely, and the user's phone would carry gigabytes. Postgres becomes the source of truth in *account mode*; Dexie stays as the store in *local mode* (no account, the demo, every existing e2e test) and as a cache in account mode.
2. **Identity.** Orbit accounts keyed by the Google `sub`, with Orbit-issued sessions. Supabase Auth is **not** used, because the shared project's Google provider belongs to another app and an Orbit session must not be valid against other apps' tables.
3. **Dedicated Supabase project before real mail is stored** (human action H1). Until then everything lives in schema `orbit`, reachable only by Orbit's functions with the service role, so the migration replays unchanged on the new project.
4. **Google tokens and all Gmail/Calendar calls move to the server** (refresh token in Vault).
5. **Background jobs** become `pgmq` queues drained by one `orbit-worker` Edge Function on a `pg_cron` tick. No Inngest, no Next.js, no Redis.
6. **One implementation of the domain logic.** `@orbit/core` stays pure TypeScript; Edge Functions import the same files through an esbuild bundle (§12.3).
7. **The graph becomes multi-source with evidence and confidence.** Mutuals, Village paths, CC lists and cities become ties.
8. **Strength becomes a 0–100 explainable score.** `people.strength = score / 100` keeps every v1 screen working.
9. **Drafting covers eight goal families** rather than only recruiting, and replies get classified and answered.
10. **Memory**: a server `memories` table with pgvector and chat tools to read and edit it.

### 0.3 Decisions at a glance

| Question | Decision |
|---|---|
| Front end | SPA stays on GitHub Pages |
| Server | Supabase only: Postgres 17, Edge Functions (Deno), `pgmq`, `pg_cron`, `pg_net`, Vault, `pgvector` |
| DB access from functions | `postgres.js` (`npm:postgres`) over `SUPABASE_DB_URL` with `prepare: false`; schema `orbit` is not exposed through the Data API |
| Identity | Orbit's own Google OAuth (code + PKCE) in `orbit-api`; HS256 session JWTs (1 h) + rotating refresh tokens (30 d) |
| LLM | Anthropic only. `claude-opus-5-5` for chat, compose, replies and dossiers; `claude-haiku-5-5` for classification and extraction (Batches API for backfill); `claude-sonnet-5-5` for offline judges |
| Embeddings | Supabase built-in `gte-small` (384 dims), no extra vendor |
| Web research | Exa + Unipile profile/posts + the user's own mail |
| Sourcing | Unipile LinkedIn search (warm first), Apollo People API Search, Exa people, Semantic Scholar |
| Warm intros | Yen's k-shortest over intro probabilities + Unipile mutuals + Village v2; PPR picks whom to aim at for company targets |
| Sending | Gmail `messages.send` (scope `gmail.send`); LinkedIn through Unipile, only per-message approved; never automatic invites |
| Autonomy | 0 draft only (default) · 1 send after approval · 2 auto-send only for replies in existing two-way Gmail threads within rules |

### 0.4 Reuse / extend / new by capability

| # | Capability | Reused | Extended | New |
|---|---|---|---|---|
| 1 | Identity and context graph | `resolveIdentity`, resume parser, CSV parser, note extraction, `MergeSuggestion` | nicknames, identity rows, multi-goal model | Orbit accounts, server ingestion, uploads table |
| 2 | Network map | `inferEdges`, noisy-OR, map renderer | per-kind confidence, decay | mutual / Village / CC / city ties, `orbit.ties` with evidence |
| 3 | Strength 0–100 | touchpoint kinds, sentiment/warmth extraction | — | `scoreTie` (14 features), explanations, per-user calibration |
| 4 | Warm paths | Yen's k-shortest | hop probabilities | intro-willingness, PPR, mutual/Village merge, reasons |
| 5 | Deep research | facts, `summary`, `talkingPoints` | — | Exa + Unipile dossiers with citations and cost caps |
| 6 | Sourcing | recommendations, Discover | — | four providers, ranking, flow into the pipeline |
| 7 | Outbound | templates, validator, corpus, style card, playbook (15) | 8 goal families, evidence rules | compose v2, forwardable blurb, outcome tracking and A/B |
| 8 | Replies | reply-signal classifier (95% holdout), extraction, send | 11 classes, LLM fallback | voice replies, free/busy slots, autonomy levels, Unipile sending |
| 9 | Cadence | bump/quiet/thank-you rules, stage machine | goal-family bumps, nurture | server scheduler, scheduled sends |
| 10 | Pipeline and memory | chats, stage events, notes, facts, snapshot | goal per chat | `memories` (pgvector), memory tools, retention jobs |

---

## 1. Identity and context graph

### 1.1 Purpose

One persistent model of who the user is, who they know, how they know them, and what they want. It is built from Gmail (mail, threads, contacts, calendar), LinkedIn (connections, messages, own profile) and uploads (resume, notes, transcripts), and kept current from conversation.

### 1.2 Reuse / Extend / New

- **Reuse**
  - `resolveIdentity` (`packages/core/src/entity/resolve.ts:345`): auto-merge at ≥ 0.92, suggest at ≥ 0.6.
  - The resume parser, note extraction (`NoteExtraction`), the LinkedIn CSV parser and `MergeSuggestion`.
- **Extend**
  - Resolution gains a nickname feature, Gmail address normalization, a cap on matches made only on name and org, and `do_not_merge`.
  - `RecruitingGoals` becomes multi-goal.
- **New**
  - Orbit accounts.
  - The `orbit.person_identities`, `orbit.goals` and `orbit.uploads` tables.
  - Server ingestion (§12).
  - `buildUserContext()`.

### 1.3 Design

- **The user is a person.**
  - Exactly one `orbit.people` row per user has `is_self = true`.
  - It holds the user's emails (including Gmail send-as aliases from `GET /gmail/v1/users/me/settings/sendAs`) and LinkedIn member id as identities.
  - That is how "sent by me" is decided on every provider.
- **Resolution, not duplication.**
  - Each address or profile goes through `resolveIdentity`. Candidates come from blocking keys, in this order:
    1. Exact normalized email (lower-case; for gmail.com/googlemail.com remove dots and `+tag`).
    2. Exact LinkedIn member id.
    3. Exact LinkedIn slug.
    4. `name_norm + org_id`.
    5. `first-name variant + last name + email local part`.
  - Name variants come from `carltonnorthern/nicknames`. A variant match sets the feature `firstNameVariant = 1`.
  - A name+org-only match is capped at 0.85, so it is never auto-merged without an email or member id.
  - Decisions:
    - **≥ 0.92**: merge and add the identity row.
    - **0.6–0.92**: create the person plus a `merge_suggestions` row. The chat asks: "Is Liz Chen the same as Elizabeth Chen at Stripe?"
    - **< 0.6**: new person.
  - A "not the same" answer writes `do_not_merge`, which is respected forever.
- **Uploads.**
  - **Resume (PDF/DOCX)**: text is extracted in the browser (existing pdfjs path) and sent to `/sync/push` as an `uploads` row of kind `resume`. Facets are parsed by the existing core parser. The file itself is never stored.
  - **Notes and transcripts (Granola paste, Wispr capture, typed)**: stored as `notes`. The existing extraction writes facts and person links.
- **User context.** `buildUserContext(userId)` returns ≤ 1,200 tokens and is the only way prompts read "who the user is". It contains:
  - Name, school and graduation year, current role and city.
  - Active goals with targets.
  - The top 5 resume facets.
  - The 10 most important memories (§10).
- **Goals.**
  - 0–5 active goals.
  - `kind ∈ {recruiting, fundraising, sales, hiring, advice, cofounder, community, collaboration}`.
  - Fields: `targets` (organizations, roles, geographies, people), `criteria` (sector, stage, seniority, skills, keywords), `success_metric`, `priority 1–3`, `due_at`, `status`.
  - Goals are created in onboarding, by the chat tool `set_goal`, or proposed by the agent after a conversation. An inferred goal is saved only after the user agrees.
  - Every pipeline chat and draft carries a `goal_id`.
- **Chat tools (new)**:
  - `set_goal`, `list_goals`, `update_goal`, `archive_goal`.
  - `confirm_merge` (wraps the existing `merge_people`/`reject_merge`).

### 1.4 Data

`orbit.users`, `orbit.people`, `orbit.person_identities`, `orbit.organizations`, `orbit.affiliations`, `orbit.goals`, `orbit.uploads`, `orbit.notes`, `orbit.facts`, `orbit.merge_suggestions`, `orbit.do_not_merge` (DDL in §11.4).

### 1.5 APIs and open source

**Google:**
- Gmail v1: `messages.list`, `messages.get?format=metadata`, `threads.get?format=full`, `history.list`, `watch`, `settings/sendAs` (§12).
- Calendar v3: `events.list` with `syncToken`.
- People API:
  - `GET https://people.googleapis.com/v1/otherContacts?readMask=names,emailAddresses&pageSize=1000` (scope `contacts.other.readonly`)
  - `GET https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,organizations&pageSize=1000` (scope `contacts.readonly`)
  - Both are used only to name addresses whose headers carry no display name.

**Unipile:**
- `GET /api/v1/users/me`
- `GET /api/v1/users/relations`
- `GET /api/v1/users/{id}?linkedin_sections=*`
- chats and messages (§12)

**Open source:**
- **`carltonnorthern/nicknames`** (https://github.com/carltonnorthern/nicknames, Apache-2.0).
  - Vendor `names.csv` with its notice into `packages/core/src/entity/nicknames.csv`.
  - A script generates `nicknames.data.ts`, so core never reads files at runtime.
- **`crisp-oss/email-reply-parser`** (https://github.com/crisp-oss/email-reply-parser, MIT, npm `email-reply-parser`): strips quotes and signatures before classification and voice learning.
- **`postalsys/postal-mime`** (https://github.com/postalsys/postal-mime, MIT-0): `addressParser` for raw header strings; used only if raw MIME is ever fetched (Gmail's `format=full` is already parsed).
- **Entity-resolution libraries** `moj-analytical-services/splink` and `dedupeio/dedupe` (Python) are not used. Core's Fellegi–Sunter-style scorer is already tested and runs in both the browser and Deno.

### 1.6 Prompts

**Goal inference** (Haiku 5.5, structured output). Runs after a chat turn whose user text mentions plans (keywords: raise, hire, looking for, applying, internship, job, customers, co-founder, collaborat, mentor, community).

```
System: You extract networking goals from a conversation with a student or early-career professional.
Return only goals the user states or clearly implies for themselves. Do not invent targets.
kind is one of recruiting, fundraising, sales, hiring, advice, cofounder, community, collaboration.
If nothing new is stated, return {"goals": []}.
User: <existing_goals>{json}</existing_goals>
<conversation>{last 6 turns}</conversation>
```

Schema:

```
{goals: [{kind, title (≤ 60 chars), targets: {organizations[], roles[], geographies[], people[]}, criteria: {sector?, stage?, seniority[]?, skills[]?, keywords[]?}, success_metric|null, due_at|null, is_update_of: goal_id|null, quote}]}
```

`quote` must be a substring of the user's words; otherwise the goal is dropped. The agent then asks "Want me to track this as a goal?" and calls `set_goal` only on yes.

### 1.7 Edge cases

- **Role addresses never become people.** Local parts: `info, hello, team, support, careers, recruiting, jobs, noreply, no-reply, notifications, billing, admin, contact`. Automated senders are excluded too, including applicant-tracking systems: greenhouse.io, lever.co, myworkday.com, workday.com, ashbyhq.com, icims.com, smartrecruiters.com, jobvite.com.
- **Two people with the same name at the same company** are never merged without an email or member-id match.
- **"Last, First" headers** are handled already (keep the test).
- **Job changes** append an affiliation and flip `is_current`; `people.org_id` follows the current one.
- **A shared family inbox** (two people, one address): the second name becomes a merge suggestion, never an auto-merge.
- **Uploads in other languages** are stored as-is; extraction runs with the language noted.

### 1.8 Acceptance tests

1. **One person, three identities.** A Gmail message from `Liz.Chen+jobs@gmail.com`, a LinkedIn relation "Elizabeth Chen, Stripe", and a calendar invite from `lizchen@gmail.com` resolve to one person with three identities (core fixture test).
2. **`do_not_merge` holds.** Pairs on it are never merged, even at a score ≥ 0.92.
3. **Inferred goals wait for a yes.** "I'm raising a pre-seed for my climate startup in January" yields one proposed `fundraising` goal, saved only after the user agrees (sim scenario `goal-infer`).
4. **Context budget.** `buildUserContext` stays ≤ 1,200 tokens for a fixture user with 5 goals and 50 memories (`messages.count_tokens`).
5. **Self person.** Exactly one self person per user; a send-as alias is attached to it.

---

## 2. Network map

### 2.1 Purpose

A graph of people and the ties between them, not only the user's own. It records who among the user's contacts know each other, with evidence and a confidence per tie, and is kept fresh.

### 2.2 Reuse / Extend / New

- **Reuse:**
  - `inferEdges` and `combinedPairWeights` in `packages/core/src/graph/edges.ts`.
  - The map renderer: `components/orbitScene.ts`, `OrbitMap.tsx`, `packages/core/src/graph/layout.ts`.
- **Extend:** confidence per kind, decay, and the noisy-OR weighted by confidence.
- **New:**
  - Tie kinds: `email_exchange`, `email_cc`, `linkedin_mutual`, `village_path`, `same_city`.
  - The `orbit.ties` table with evidence.
  - Incremental and nightly recompute jobs.

### 2.3 Design

**Graph schema.**
- Nodes are `orbit.people`, with the self person at the centre.
- The user's own ties are `orbit.tie_scores` (§3).
- Ties between two other people are `orbit.ties` rows: one row per (pair, kind), with `a_person_id < b_person_id`.

**Tie kinds:**

| Kind | Evidence | Weight w | Confidence c |
|---|---|---|---|
| `email_exchange` | A and B both *sent* messages in one thread (≤ 8 participants) | 0.6 + 0.1·(threads − 1), max 0.9 | 0.95 |
| `email_cc` | A sent a message with B in To/Cc (≤ 8 recipients) | 0.45 + 0.05·(messages − 1), max 0.7 | 0.85 |
| `email_cothread` | Both only *received* on one thread (≤ 8) | min(0.5, 0.3 + 0.1·(threads − 1)) | 0.5 |
| `meeting_coattendee` | Both attended an event with ≤ 8 attendees, neither declined | min(0.9, 0.6 + 0.1·(events − 1)) | 0.8 |
| `introduced_by` | A introduced B in a thread the user is on (existing intro cues; ambiguous cases go through §2.6) | 0.85 | 0.95 |
| `linkedin_mutual` | B appears in Unipile's `connections_of: [A]` search | 0.3 | 0.95 |
| `village_path` | Village returned A as an introducer to B with warmth v | v | 0.7 |
| `co_tenure` | Overlapping stints at one org | existing formula | 0.3 + 0.05·overlap months, max 0.8; × 0.5 if size ≥ 5,000; × 0.6 if the overlap ended > 10 years ago |
| `same_school_cohort` | Same school, overlapping years | existing 0.3 / 0.15 / 0.12 | 0.4 overlap / 0.25 within two years / 0.1 same school |
| `same_current_company` | Both currently at one org, dates unknown | 0.35·size factor | 0.35 (× 0.5 at ≥ 5,000 employees) |
| `same_city` | Same current city (normalized) | 0.05 | 0.1 |

**Combining kinds for a pair:**
- `w_pair = 1 − Π_k (1 − w_k·c_k)`
- `c_pair = 1 − Π_k (1 − c_k)`

**Decay.** Interaction kinds (`email_*`, `meeting_coattendee`, `introduced_by`) use `w_k × 0.5^(years since last evidence / 2)`.

**When a pair is routable.** A pair can carry a route only if:
- `c_pair ≥ 0.5`, or
- it has an `email_exchange`, `email_cc`, `meeting_coattendee`, `introduced_by` or `linkedin_mutual` row.

`same_city`, `same_school_cohort` and `same_current_company` alone are never routable. They feed the map's clustering and the "in common" lists.

**Freshness:**
- **Incremental.** Every new message or event runs `ties.upsert_from_thread` / `ties.upsert_from_event` for the pairs inside it.
- **Nightly.** `score.user` rebuilds the affiliation and city kinds and applies decay.
- **On demand.** Mutuals are fetched lazily when a route to a target is requested, then cached for 30 days (`last_seen_at`).
- **Webhooks.** A Unipile `new_relation` webhook adds the user's own tie. It queues a mutual refresh only if that person is at a target organization of an active goal.

**Map rendering:**
- The renderer reads `people.strength` (score/100) for rings and `ties` (as `Edge` with `weight = w_pair·c_pair`) for links.
- The visual restyle, chosen from https://claude.ai/artifact/MXPg8shmMnowfX5QsSzAtT, is independent of this plan.
- The map shows ties with `c_pair ≥ 0.5` by default. A "Show weak links" toggle reveals the rest.

### 2.4 Data

`orbit.ties` (kind, weight, confidence, evidence `{threadIds[], eventIds[], orgId, overlapMonths, source, count}`, first/last seen) and `orbit.intro_requests` (§4). DDL in §11.4.

### 2.5 APIs and open source

- **Unipile mutual search**: `POST {UNIPILE_BASE_URL}/api/v1/linkedin/search?account_id=` with body `{"api":"classic","category":"people","network_distance":[1],"connections_of":["<member id>"]}`.
- **Village v2**: `POST https://api.village.do/v2/people/paths` and `/v2/companies/paths` (§4.5).
- **No graph library is added.** Graphology has no k-shortest-paths, and core's implementations are tested.

### 2.6 Prompts

**Ambiguous introductions** are the existing `possibleIntroduction` cases: a person is copied and described, but no "meet" or "introduce" cue is present. In local mode they stay a question to the user. In account mode, Haiku 5.5 pre-classifies them first:

```
System: Decide whether this email introduces two people to each other. An introduction connects two people who did not know each other, on purpose, usually with a reason. Copying someone for information is not an introduction.
Return {"is_introduction": boolean, "introducer": email|null, "introduced": [email], "confidence": 0..1, "quote": string}.
User: <message>{headers + body, quotes stripped}</message>
```

- **Confidence ≥ 0.85**: write `introduced_by`.
- **0.5–0.85**: keep asking the user.
- **Below 0.5**: drop.

### 2.7 Edge cases

- **Mailing lists and large threads** (> 8 participants) create no ties.
- **Assistants scheduling for executives** (the organizer is not an attendee) create no `meeting_coattendee` between the assistant and the others.
- **Large companies** are handled by the size factor and confidence cuts.
- **Hidden people.** A person the user hid is excluded from routing but kept in ties.
- **Deleted messages** (Gmail history `messageDeleted`) keep the tie until the nightly recompute, which recounts evidence.
- **Unipile mutual search fails** (429/throttled): mark `mutuals_unavailable` on the target and do not retry for 24 h.

### 2.8 Acceptance tests

1. Core: a thread where A and B both wrote yields `email_exchange` with c = 0.95; a 12-person thread yields nothing.
2. Core: `same_city` alone is not routable; `email_cc` alone is.
3. Core: an `email_exchange` tie four years old has weight ≤ 0.25 of a fresh one.
4. Function: two mutual searches for one target within 30 days make one upstream call. Results are written as `linkedin_mutual` ties.
5. Map e2e (local mode, demo): ties render with no overlapping labels at phone and laptop widths (existing test kept green).

---

## 3. Relationship strength, 0 to 100

### 3.1 Purpose

A per-contact score that:
- explains itself in plain sentences,
- decays with time,
- can be calibrated to the user's own sense of closeness.

### 3.2 Reuse / Extend / New

- **Reuse:**
  - touchpoint kinds,
  - message `sentiment` and note `warmth` extraction.
- **Extend:** not applicable.
- **New:**
  - `packages/core/src/scoring/tieScore.ts`: features, model, explanations, calibration.
  - `orbit.tie_scores` and `orbit.tie_labels`.
  - The old `computeStrength` is replaced in both modes. `people.strength = score / 100` keeps the map, Reach, recommendations and reconnect rules working.

### 3.3 Design

**Research basis (§22 A):**
- Tie strength mixes time, emotional intensity, intimacy and reciprocal services (Granovetter 1973). Emotional closeness is the best single indicator (Marsden & Campbell 1984, via Gilbert & Karahalios).
- Gilbert & Karahalios (2009):
  - **Days since last communication (β −0.76)** and **days since first communication (β +0.755)** dominate.
  - Next come words exchanged, mutual friends' mean strength (+0.257) and intimacy.
  - Log features in a linear model reach 87% strong/weak accuracy.
  - Communicating even once moves strength a lot.
- Jones et al. (2013): a plain sum of directed interactions reaches AUC 0.90, and private messages carry no more signal than public ones.
- Email ties need reciprocity (Kossinets & Watts 2006). Outgoing mail is weighted above incoming for ranking contacts (Roth et al. 2010). For *closeness*, Orbit weights inbound above outbound, because an answer is the stronger signal and one-way outreach is common in networking.
- Weaker ties by interaction, and ties with ≤ 10 mutuals, transmitted the most jobs (Rajkumar et al. 2022). The score therefore measures closeness only. §4 uses it as one input to "will they help", not as the objective.

**Features.** All are computed per user–person pair. Automated mail, list mail and threads with more than 8 participants are excluded.

| id | Feature | Definition |
|---|---|---|
| f1 | `log_days_last` | ln(1 + days since the last *two-way* exchange; if never two-way, since the last contact of any kind); 0 if never any contact |
| f2 | `log_days_first` | ln(1 + days since the first contact); 0 if never |
| f3 | `log_out` | ln(1 + Σ messages user → them, decayed with a 365-day half-life); LinkedIn messages × 0.8 |
| f4 | `log_in` | ln(1 + Σ messages them → user, same decay); LinkedIn messages × 0.8 |
| f5 | `reciprocity` | min(in, out) / max(in, out) over 2 years; 0 if either is 0 |
| f6 | `log_meetings` | ln(1 + Σ meetings in 2 years: 1 for ≤ 4 attendees, 0.3 for 5–8, 0 above) |
| f7 | `log_threads` | ln(1 + distinct two-way threads with ≤ 3 participants) (thread *depth*) |
| f8 | `latency` | 1 − min(1, ln(1 + median hours they took to reply) / ln(169)); 0 if they never replied |
| f9 | `intros` | min(2, introductions between them and the user, either direction) |
| f10 | `shared` | min(2, same school + overlapping employer + 0.5·same current city) |
| f11 | `structural` | mean score/100 of their top 5 mutual contacts (previous nightly run; 0 on the first) |
| f12 | `linkedin` | 1 if LinkedIn-connected |
| f13 | `warmth` | mean of note `warmth` and inbound message `sentiment`, in [−1, 1]; 0 if none |
| f14 | `never` | 1 if no message or meeting ever |

The channel enters through f3/f4 (LinkedIn × 0.8), f6 (meetings) and f12 (connection). Ordering: meeting > two-way email > LinkedIn DM > LinkedIn connection.

**Model:**

```
z = b + Σ w_i · f_i
score = round(100 · σ(z))
if in == 0 and out > 0: score = min(score, 20)          # unreciprocated cap
calibrated per user when ≥ 8 labels exist (below)
```

Starting weights are given below. Fit the final values to the anchors in §3.8 by least squares on logit targets, then freeze them in `TIE_WEIGHTS` with a comment recording the fit.

| term | b | f1 | f2 | f3 | f4 | f5 | f6 | f7 | f8 | f9 | f10 | f11 | f12 | f13 | f14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| w | −2.4 | −0.40 | +0.40 | +0.35 | +0.75 | +0.60 | +1.00 | +0.50 | +0.40 | +0.50 | +0.45 | +0.80 | +0.55 | +0.50 | −0.30 |

Model version: `tie-v1`.

**Decay is built in.** f1 grows and f3/f4 decay as time passes. A dormant former close tie lands around 40, not 0, because f2, f6, f7 and f9 hold it up. That is exactly the re-engagement case in §7.

**Bands:**

| Score | Band | Map tier |
|---|---|---|
| 0–19 | Faint | weak |
| 20–39 | Light | weak |
| 40–59 | Warm | medium |
| 60–79 | Strong | strong |
| 80–100 | Close | strong |

**Explanation.** `explainTie` computes contributions `c_i = w_i·(f_i − TIE_BASELINE_i)`, then shows the top three positive and the top one negative as sentences built from raw counts:

| Feature | Positive | Negative |
|---|---|---|
| f1 | — | "Last real exchange was {n} months ago" |
| f3 + f4 | "{in + out} messages between you ({in} from them)" | "Mostly one-way: {out} sent, {in} back" |
| f6 | "{n} meetings in the last 2 years" | — |
| f9 | "{name} introduced you to someone" | — |
| f10 | "You both went to {school}" / "You overlapped at {org} ({years})" | — |
| f11 | "Close with people you're close to ({names})" | — |
| f12 | "Connected on LinkedIn" | "Connected on LinkedIn, never talked" (f14 = 1) |
| f8 | "Usually replies within {h} hours" | "Takes about {d} days to reply" |
| f13 | "Your notes say it went well" | "Your notes mention it was a bit cold" |

The person page shows `78 · Strong`, the sentences, and "Not right?". The chat tool `explain_score` returns the same object.

**Calibration:**
- **Labels.** Onboarding (optional) and "Not right?" ask for closeness 1–5, stored in `tie_labels`.
- **Fit.** With ≥ 8 labels, fit per-user `(a, c)` by minimizing Σ(σ(a·z + c) − (label − 1)/4)² + 0.5·((a − 1)² + c²), using 200 steps of gradient descent.
- **Score.** `round(100·σ(a·z + c))`.
- **Labelled people.** A labelled person shows their band's midpoint (10/30/50/70/90) until new contact happens.

**Chat tools (new):**
- `explain_score {personId}`
- `rate_closeness {personId, closeness}`

### 3.4 Data

- `orbit.tie_scores (user_id, person_id, score, band, features, contributions, explanation[], model_version, computed_at)`
- `orbit.tie_labels (user_id, person_id, closeness)`

Recomputed by `score.person` when a message lands, and nightly for everyone by `score.user`.

### 3.5 APIs and open source

None external. The model is pure TypeScript in core and runs in the browser (local mode) and the worker (account mode).

### 3.6 Prompts

None. Scores and explanations are deterministic, so they can never claim evidence that does not exist. `warmth` and `sentiment` come from the existing extraction prompts.

### 3.7 Edge cases

- **Family and partners.** If `relationship_type` is `family` or `partner`, the score is floored at 80. These ties are excluded from cadence nudges unless asked.
- **A person who only CCs the user** gets f14 = 1, so the score stays faint.
- **Job-application systems and recruiter auto-mail** are excluded as automated (§1.7). Without this, recruiter mail inflated scores; see the iteration log in §18.
- **Merged people** are re-scored from the union of histories.
- **No history at all** (manually added person) gives f14 = 1; the score is 3–6, or 8–15 if LinkedIn-connected.

### 3.8 Acceptance tests

Anchors are core unit tests on synthetic histories:

| Anchor | History | Score |
|---|---|---|
| A1 | LinkedIn-connected 300 days ago, nothing else | 8–15 |
| A2 | One cold email out 10 days ago, no reply, not connected | 3–10 |
| A3 | One two-way thread 14 days ago (2 out, 1 in) | 30–45 |
| A4 | Weekly two-way email for 6 months, 3 1:1 meetings, last contact 3 days ago | 85–95 |
| A5 | A4's history, all of it ended 2 years ago | 35–55 |
| A6 | 10 out, 0 in over 6 months | ≤ 20 |
| A7 | One 1:1 meeting 30 days ago + a thank-you exchange | 45–60 |
| A8 | Same school and cohort, LinkedIn-connected, never talked | 15–25 |
| A9 | Adding an inbound reply never lowers a score; 30 more days of silence never raises it | monotonic |
| A10 | 8 "very close" labels on people scoring ~40 move their calibrated scores above 75 | calibration |

Offline calibration is covered in §15.

---

## 4. Warm path finding

### 4.1 Purpose

Given a target person or company, return the best routes to them, ranked by the chance the introduction actually happens, each with a plain-language reason and a confidence.

### 4.2 Reuse / Extend / New

- **Reuse:** Yen's k-shortest paths and Dijkstra (`packages/core/src/graph/paths.ts`).
- **Extend:** edge costs become `−ln p`, where p is a hop probability, instead of `−ln w`.
- **New:**
  - The intro-willingness model `p_ask`.
  - Target receptivity and goal floors.
  - Personalized PageRank for company targets (`graph/ppr.ts`).
  - Merging local paths with Unipile mutuals and Village v2 introducers.
  - Reason templates.
  - `orbit.intro_requests` outcome logging.

### 4.3 Design

**Algorithm choice:**

| Candidate | Decision |
|---|---|
| Weighted Dijkstra / **Yen's k-shortest paths** over `−ln p` | **Chosen for person targets.** Exact, fast at user scale (≤ 20k nodes), already tested in core, and the product of hop probabilities is the quantity we want |
| **Personalized PageRank** from the user | **Chosen for company targets**, only to pick whom at the company to aim at; Yen's then runs per chosen person |
| Max-flow / bottleneck paths | Rejected as the ranker: it measures redundancy, not the best single intro. Kept as a feature: the count of routes with distinct first hops ("2 other ways in") |
| Learned link prediction | Phase P7 (§19), once ≥ 200 intro outcomes are logged: a logistic regression over the same hop features replaces the hand-set `p_ask` weights |

**Hop probabilities:**

- **First hop**, user → A (whether A will make the intro):
  `p_ask(A) = σ(−2.0 + 4.0·S_A/100 + 0.8·reciprocity_A + 0.6·[A introduced the user before] + 0.3·[A works at or knows an active goal's target org] − 0.7·[the user asked A for an intro in the last 30 days] − 0.5·[the user owes A a reply])`
- **Middle and last hops**, A → B:
  - `p_know(A, B) = w_pair·c_pair` (§2.3)
  - mutual-only pair: 0.3 × 0.95
  - Village pair: warmth × 0.7
- **Target receptivity:**
  `r_T = 1 + 0.15·[alum of the user's school] + 0.1·[seniority ≤ manager] − 0.15·[C-level or partner]`, clamped to [0.7, 1.3].
- **Path success:**
  `P = p_ask(A) · Π p_know · r_T · 0.85^(hops − 2)`
  - Multiply by 0.7 when any hop's newest evidence is older than 3 years.
  - A direct tie uses `P = responsePrior(T)`.
- **Goal floors** on the first hop's score:
  - fundraising ≥ 40: asking a weak tie to vouch for you to an investor backfires;
  - recruiting and advice ≥ 20;
  - other goals ≥ 30.

**Person target T:**
1. Resolve T to a local person (§1).
2. **Local candidates:** Yen's with k = 12, at most 3 hops, cost `−ln p`.
3. **Unipile mutuals** (account mode, LinkedIn connected, T's member id known): one `linkedin/search` with `connections_of: [T]` and `network_distance: [1]`, cached for 30 days. Each mutual M gives a candidate user → M → T and a `linkedin_mutual` tie.
4. **Village** (if configured):
   - token from `POST /v2/auth/tokens`, cached for 50 minutes;
   - `POST /v2/people/paths` with `{linkedin_url}` (the API takes only `linkedin_url` or `url`; a target with no LinkedIn URL skips Village);
   - each introducer becomes a candidate and a `village_path` tie;
   - cost: 5 credits ($0.10), within the per-user cap (§13.3).
5. **Merge and rank:**
   - merge candidates by first-hop person and keep the best path per first hop;
   - allow at most 2 paths through the same middle person;
   - sort by `P` and return the top 5.
6. **Bands and fallback:**
   - high `P ≥ 0.35`, medium 0.15–0.35, low < 0.15;
   - nothing above 0.05: return `{paths: [], fallback: "cold"}`, and the chat offers a cold note instead.

**Company target C:**
1. If the graph has ≤ 10 people currently at C, run the person procedure on each.
2. Otherwise:
   - run PPR from the user: α = 0.15, 30 power iterations, transitions proportional to `p_ask` / `p_know`;
   - take the 10 people at C with the most PPR mass and run the person procedure for each.
3. Village `POST /v2/companies/paths {domain}` (5 credits) adds introducers.
4. Return the 5 best (person, path) pairs, at most 2 per person.

**Reason text.** Deterministic; no LLM.

- Template: `"{A} ({band} · {score}) {A→B evidence} {B→T evidence}."`
- Evidence phrases come from the strongest kind on each hop:

| Kind | Phrase |
|---|---|
| `email_exchange` | "emails with {B}" |
| `meeting_coattendee` | "met {B} in {month year}" |
| `co_tenure` | "worked with {B} at {org} ({years})" |
| `linkedin_mutual` | "is connected to {B} on LinkedIn" |
| `village_path` | "knows {B} (via Village)" |
| `introduced_by` | "introduced you to {B}" |

- Then append "{n} other ways in" when routes with distinct first hops exist.

**Acting on a path.**
- "Ask {A} for an intro" composes an `intro_request` plus a `forwardable_blurb` (§7).
- Once the draft is sent, an `orbit.intro_requests` row is created. Its outcome is updated from replies (§8):

| Reply class | Outcome |
|---|---|
| `referral` | `agreed` |
| `decline` | `declined` |
| Detected intro email | `intro_made` |
| Booked event | `meeting` |
| 21 days of silence | `no_response` |

**Chat tools:**
- `find_routes`: extended to return v2 paths, `confidence` and `reasons`.
- `ask_for_intro {pathId}` (new): risky. It creates drafts but never sends.

### 4.4 Data

- `orbit.ties`, `orbit.tie_scores`
- `orbit.intro_requests (target, introducer, goal, path jsonb, path_score, rank, status, asked_at, outcome_at)`

### 4.5 APIs and open source

**Unipile**
- `POST /api/v1/linkedin/search` for mutuals (§2.5).

**Village v2** (https://docs.village.ai/api-reference/introduction.md)
- `POST https://api.village.do/v2/auth/tokens`: header `secret-key: sk_…`, body `{external_user_id, email}`, returns a Bearer token.
- `POST /v2/people/paths {linkedin_url}` (or `{url}`); there is no name + company form.
- `POST /v2/companies/paths {domain}` (or `{linkedin_url}`).
- Scores are 0–100; Orbit uses warmth = score / 100. A 404 means no paths.
- Credits: $0.02 each. Paths to a person: 5. Paths to a company: 5. No result: 0. (Confirmed from https://api.village.do/v2/docs/openapi.json.)
- Tokens last a year; Orbit still re-mints every 50 minutes so a revoked key fails fast.
- Rate limit: 100 requests/s per key.
- The `orbit-connectors` v1 call is replaced by these in both modes.

**Open source**
- None. Yen's, Dijkstra and PPR are in core.

### 4.6 Prompts

None. Ranking and reasons are deterministic, so a reason can never mention a connection that isn't in the graph.

### 4.7 Edge cases

- **The target is already a direct tie.** Return "You know them" with their score, and skip routing.
- **Member id unknown.** Skip mutuals and say so in the reasons.
- **Intermediaries excluded from routes:**
  - people the user hid;
  - people who declined an intro request in the last 90 days.
- **Family members and professors as the first hop.** Allowed.
- **Village and the local graph disagree on warmth.** Take the larger `P`; both evidence lines are shown.
- **The target is a minor or a student under 18.** Return nothing (§14.4).

### 4.8 Acceptance tests

1. **Evidence beats proximity.** On the demo graph, the route to "Priya Ahmed" through a mutual who exchanged email with her outranks a route through a same-company-only pair.
2. **`p_ask` behaves.** It rises with the first-hop score and falls when an intro was asked in the last 30 days.
3. **PPR is sane.** On a star graph it ranks the hub first, and mass sums to 1 ± 1e-6.
4. **External candidates are cached.** Function test with mocked Unipile and Village: mutuals and Village introducers become candidates and `ties` rows with the right kind and confidence. A second request within 30 days makes no upstream call.
5. **Fundraising floor.** A fundraising path whose first hop scores 25 is excluded; the same path for an advice goal is kept.
6. **Path accuracy** (§15): top-1 matches the route the user picks ≥ 60% of the time.

---

## 5. Deep research on a person

### 5.1 Purpose

Before outreach, produce a short, cited profile of the person, tuned to the user's goal. It covers who they are, what they work on now, what they said or did recently, what they have in common with the user, the user's history with them, three opening hooks, and anything to be careful about.

### 5.2 Reuse / Extend / New

- **Reuse:** `people.summary`, `talkingPoints` and person facts.
- **New:**
  - the `enrich.dossier` job;
  - `orbit-api /research/person` and `/research/get`;
  - `orbit.dossiers` and `orbit.research_cache`;
  - chat tools `research_person {personId, refresh?}` and `get_dossier {personId}`;
  - a dossier card on the person page.

### 5.3 Design

**Provider choice**

| Provider | Decision | Why |
|---|---|---|
| **Exa** | **Chosen** for the public web | One API covers `people`, `news`, `company` and `publication` search plus `/contents`. Cost: $7 per 1k searches, $1 per 1k pages |
| **Unipile** `GET /users/{id}` + `/users/{id}/posts` | **Chosen** for LinkedIn | Already connected; returns experience, education, about and recent posts through the user's own account. Unipile's guidance is ~100 profile views/day; Orbit caps at 40/day |
| The user's own mail and notes | **Chosen**, always first | The most specific source; free and private |
| Tavily, Perplexity Sonar, SerpAPI | Not chosen | General web search with no people category; Exa covers it |
| Apollo | Not for research | Firmographic records, not narrative; used for sourcing (§6) |
| People Data Labs, Clay | Not chosen | $0.28 per record (PDL) or a workflow tool (Clay); no unique data for this |
| Proxycurl | Unavailable | Shut down 2025-07-04 |
| Claude `web_search` server tool | Fallback | Used only when `EXA_API_KEY` is missing |

**Pipeline** (budget ≤ $0.25 per dossier):

1. **Internal** (free): the last 20 messages with them (quotes stripped), notes, facts, events and the previous dossier.
2. **LinkedIn** (if connected, the member id is known, and the cap allows):
   - `GET /api/v1/users/{member_id}?account_id=&linkedin_sections=*_preview,experience,education,about`
   - `GET /api/v1/users/{member_id}/posts?account_id=&limit=10`
   - `notify` stays false.
3. **Exa search.** Three queries in parallel, each with `type: "auto"`, `numResults: 5`, `contents.highlights` keyed to the goal question, `maxCharacters: 1200`:
   - `category: "people"`, query `"{full name}" {org} {title}`;
   - `category: "news"`, query `"{full name}" {org}`, `startPublishedDate` = 18 months ago;
   - no category, query `"{full name}" {org} podcast OR talk OR interview OR blog`. For `collaboration` goals use `category: "publication"` with `"{full name}" {field}` instead. For `hiring` goals add `includeDomains: ["github.com"]`.
4. **Identity check.** Keep a result only if its text contains the full name **and** at least one of: the org, the LinkedIn slug, or a known email domain. If two different plausible people match (different orgs), stop and return `needs_disambiguation` with both. The chat then shows choices.
5. **Contents.** `POST /contents` for the top 6 kept URLs, with `text.maxCharacters: 6000` and `maxAgeHours: 720`.
6. **Synthesis.** Claude Opus 5.5, effort `medium`, structured output (§5.6). Validate that every `source_ids` entry exists; on failure, retry once with the issue listed.
7. **Cache:**
   - the dossier for 30 days (`refresh: true` re-runs it, reusing cached URLs);
   - Exa responses by request hash for 7 days;
   - dossiers expire after 90 days.

**What the user sees** is a card with these parts:
- **Who**: one line.
- **Now**: role, team, since when.
- **Recently**: up to 3 dated items, each with a link.
- **In common with you**.
- **Your history**: first and last contact, what was said.
- **Openers**: 3 hooks, each with a source.
- **Careful**.
- Every web-derived sentence carries a numbered source link.

### 5.4 Data

- `orbit.dossiers`: `status` (pending, ready, partial, needs_disambiguation, failed), `content`, `sources`, `candidates`, `cost_usd`, `model`, `expires_at`.
- `orbit.research_cache (user_id, key, provider, response, expires_at)`.
- `orbit.usage_ledger` rows per call.

### 5.5 APIs and open source

**Exa** (https://exa.ai/docs/reference/search)

- **Auth:** header `x-api-key`.
- **Endpoints used:**
  - `POST https://api.exa.ai/search`
  - `POST https://api.exa.ai/contents`
- **Current categories:** `company`, `publication`, `news`, `personal site`, `financial report`, `people`.
  - `linkedin profile` and `research paper` have been retired.
  - Do not send date filters or `excludeDomains` together with `people` or `company`; that combination returns 400.
- **Freshness:** `livecrawl` is deprecated; use `maxAgeHours`.

**Unipile**

- `GET /api/v1/users/{identifier}`
- `GET /api/v1/users/{identifier}/posts`

**Open source patterns** (no code is copied)

- `dzhng/deep-research` (MIT, https://github.com/dzhng/deep-research): its breadth × depth query loop informs the three-query fan-out. Orbit uses breadth 3 and depth 1, because a dossier needs specificity, not exhaustiveness.
- `exa-labs/company-researcher` (MIT, https://github.com/exa-labs/company-researcher): its Exa query templates for founders, funding and news are adapted for people.
- `assafelovic/gpt-researcher` and `stanford-oval/storm`: these are Python report writers and too heavy for a 150-second Edge Function. Not used.

### 5.6 Prompts

```
System: You write a research brief about one person for {user first name}, who wants to {goal sentence}.
Use only the sources provided. Every claim needs the id of the source it came from.
If sources disagree or might be about a different person with the same name, say so in "careful" and leave the claim out.
Never guess age, ethnicity, religion, health, family, sexuality or politics, and never include them even if a source mentions them.
Openers must be specific, true, and something a thoughtful person would mention; never flattery.
User: <user_context>{buildUserContext}</user_context>
<person>{name, title, org, location, identities}</person>
<internal_history>{messages and notes, quotes stripped}</internal_history>
<linkedin>{profile + posts}</linkedin>
<sources>{id: S1…, url, title, published, text}</sources>
```

Schema:
`{who, now: {role, org, since|null, source_ids[]}, recently: [{date|null, text, source_ids[]}] (≤ 3), in_common: [{text, kind: school|employer|person|interest|place, source_ids[]}], history: {first_contact|null, last_contact|null, summary|null}, openers: [{text ≤ 25 words, source_ids[]}] (≤ 3), careful: string[], confidence: high|medium|low}`.
`PROMPT_VERSION = 'dossier-v1'`.

### 5.7 Edge cases

- **Common names:** run the identity check, then ask the user which person they mean.
- **No web presence:** build the dossier from internal sources and LinkedIn only, marked `confidence: low`. Do not pad it.
- **Paywalled pages:** use the highlights only.
- **Apparent minors** (high-school student): stop and return nothing.
- **EU subjects:** professional public data only. Keep it 90 days and never use it for automated decisions.
- **Exa or Unipile down:** return a `partial` dossier built from whatever is available.
- **Daily cap hit:** queue the job until midnight in the user's time zone, and say so in the chat.

### 5.8 Acceptance tests

1. A recorded Exa/Unipile fixture produces a schema-valid dossier. Every source id exists, and cost ≤ $0.25 is recorded in `usage_ledger`.
2. Two people with the same name return `needs_disambiguation` without making a synthesis call.
3. A second request within 30 days makes zero upstream calls.
4. An Exa key is missing: the `web_search` fallback runs, and the dossier is marked with its source.
5. Eval (§15): factual precision ≥ 95% across 30 hand-checked dossiers.

---

## 6. Sourcing

### 6.1 Purpose

Find people for a purpose (investors, candidates, customers, mentors, alumni, research collaborators), rank them, and put the chosen ones into the pipeline.

### 6.2 Reuse / Extend / New

- **Reused**: `recommendations` (moved server-side as `orbit.recommendations`), the Discover page, `responsePrior`.
- **New**:
  - `orbit-api /source/search`
  - provider adapters
  - ranking
  - chat tools `find_people {goalId?, purpose, query, filters}` and `add_sourced {recommendationIds[]}`
  - a "Find people" tab in Discover

### 6.3 Design

**Providers by purpose.** Providers run in the order listed; their results are merged and deduped.

| Purpose (goal kind) | Providers | Built from |
|---|---|---|
| recruiting / advice: alumni, people at targets | Unipile LinkedIn `classic` people search (`school`, `company`, `network_distance: [2, 3]`), then Apollo `mixed_people/api_search` | goal targets, the user's school |
| fundraising: investors | Exa `people` ("partner at a seed fund investing in {sector}"), Exa `company` for funds, Apollo search with titles Partner, Principal, General Partner, Investor and `q_keywords` | sector, stage, geography |
| sales: customers | Apollo search (titles, seniorities, employee ranges, industries, locations) | ICP fields |
| hiring: candidates | Unipile `classic` search (`keywords`, `past_company`, `school`, distance 2–3), Exa `people`, Exa with `includeDomains: ["github.com"]` for engineers | role, skills, location |
| cofounder | Exa `people` + Unipile search (distance 2) | skills, domain, city |
| collaboration: researchers | Semantic Scholar paper search, then author details; Exa `publication` | topic, keywords |
| community | Unipile search (distance 1–2, location) | topic, city |

**Rejected:**
- **Crunchbase and Harmonic**: enterprise contracts; Exa plus Apollo cover seed-stage investor discovery.
- **PDL**: cost per record.
- **Sales Navigator**: used only when the user's own account has a seat. This is detected from the `sales_navigator` field of `GET /users/me`, and then `api: "sales_navigator"` replaces `classic`.

**Ranking:** `rank = 0.45·fit + 0.35·reach + 0.20·responsiveness`

- **fit**: Haiku 5.5 scores candidates in batches of 20 against the goal criteria (§6.6). The rule fallback is the share of criteria matched by keyword.
- **reach**: the best path `P` from §4, computed for the top 30 by fit only. Otherwise 0.05 for 2nd-degree LinkedIn, else 0.
- **responsiveness**: the existing `responsePrior` (seniority, alumni, sector).
- **Dedupe**: by LinkedIn member id or URL, then email, then normalized name plus org. Candidates already in the graph, and anyone already in the pipeline for this goal, are removed.

**Flow into the pipeline:**
1. Results are written to `orbit.recommendations` with `goal_id`, `batch_id`, `source`, `rank`, `fit`, `reach` and `reasons`.
2. The chat shows the top 10, each with "Add".
3. "Add" resolves the candidate into a person, creates a pipeline chat at stage `identified` with that `goal_id`, and queues `enrich.dossier`.

**Contact details:**
- Emails are never revealed in bulk.
- Apollo `POST /api/v1/people/match` (1 credit) runs only when the user chooses to email a sourced person who has no known address.

### 6.4 Data

`orbit.recommendations`, `orbit.people` (on add), `orbit.chats`, `orbit.usage_ledger`.

### 6.5 APIs and open source

**Unipile**

`POST {UNIPILE_BASE_URL}/api/v1/linkedin/search?account_id=&limit=` with body:
`{api: "classic"|"sales_navigator", category: "people", keywords?, school?[], company?[], past_company?[], location?[], network_distance?[]}`

- Parameter ids come from Unipile's search-parameters route.
- Classic returns 10 per page, Sales Navigator up to 100.
- Orbit's own limits: ≤ 100 results per search, ≤ 10 searches per day.

**Apollo** (https://docs.apollo.io/reference/people-api-search)

- People search: `POST https://api.apollo.io/api/v1/mixed_people/api_search`
  - Params: `person_titles[]`, `person_seniorities[]`, `person_locations[]`, `q_organization_domains_list[]`, `organization_num_employees_ranges[]`, `q_keywords`, `page`, `per_page ≤ 100`.
  - Costs 0 credits; returns no emails.
  - Header `x-api-key`.
- Enrichment: `POST /api/v1/people/match`, 1 credit, only on user action.

**Exa**

`POST /search` with `category: "people" | "company" | "publication"` (§5.5).

**Semantic Scholar** (https://api.semanticscholar.org/api-docs/graph)

- `GET https://api.semanticscholar.org/graph/v1/paper/search?query=&fields=title,year,authors,venue&limit=50`
- `GET /graph/v1/author/{id}?fields=name,affiliations,homepage,paperCount,hIndex`
- Optional header `x-api-key`.

**Open source**

- `growthenginenowoslawski/coldoutboundskills` (MIT): its idea of "scoring by positive replies ÷ sent after 21 days" is adopted for the online metric in §15. Its prompts are not used.

### 6.6 Prompts

```
System: Score how well each candidate matches what {user first name} is looking for. 0 = not a match, 1 = an excellent match.
Judge only from the fields given. Do not reward fame. Give at most two short reasons.
User: <looking_for>{goal title, criteria}</looking_for>
<candidates>{id, name, title, org, location, headline, source}</candidates>
```

Schema: `{scores: [{id, fit: 0..1, reasons: string[≤2]}]}`. `PROMPT_VERSION = 'fit-v1'`.

### 6.7 Edge cases

- **Apollo's obfuscated last names**: key the candidate by its Apollo id and resolve it when the user adds them.
- **Results the user already knows**: shown with their score and labelled "You know them".
- **Empty results**: relax the search in order (drop location, then seniority, then stage) and say what was relaxed.
- **Goal without organizations** (e.g. "PM at fintech"): build the query from roles plus sector, and the chat asks once for 3 dream companies (see the iteration log in §18).
- **A provider is down or unconfigured**: listed in `unconfigured[]`; the remaining providers still return results.

### 6.8 Acceptance tests

1. A fundraising query merges Exa and Apollo results, dedupes a person who appears in both, and returns ranked results with reasons.
2. "Add" creates exactly one person and one chat with the goal id, and queues exactly one dossier job.
3. With no keys set, the search returns `{results: [], unconfigured: [...]}` without an error.
4. A collaboration query on a topic returns Semantic Scholar authors with their affiliations.

---

## 7. Human-sounding outbound

### 7.1 Purpose

Write first messages, intro requests, re-engagement notes and thank-yous that people answer, in the user's voice, for every goal.

### 7.2 Reuse / Extend / New

- **Reuse**
  - The template engine, `validateDraft`, banned phrases, the corpus and the playbook (15). These are the floor: every LLM draft must pass them, and the template is the fallback.
- **Extend**
  - New kinds and the eight goal families.
- **New**
  - `validateComposed`.
  - The compose-v2 prompt.
  - Voice exemplars retrieved with pgvector.
  - Outcome tracking and A/B testing.
  - Chat tools `compose_message {personId, kind, goalId, channel}` (a superset of `create_draft`) and `ask_for_intro` (§4).

### 7.3 Design

**Evidence and the rule that follows (§22 B)**

| Finding | Orbit rule |
|---|---|
| 50–125-word emails got the most replies (Boomerang, 40M emails); 20–39 words did best in Hunter's 34M cold emails, but the spread was small | First touch by email: 50–110 words; sales 40–90; bumps 15–50 |
| 3rd-grade reading level got +36% replies (Boomerang) | Flesch–Kincaid grade ≤ 7 |
| 1–3 questions got +50% replies (Boomerang); interest-based asks beat time-specific asks for sales (Gong) | Exactly one ask. Sales and fundraising: interest ask ("Worth a look?"). Recruiting and advice: a small concrete ask (15–20 min) with why them |
| 3–4-word subjects did best (Boomerang); 1–4 for executives (Gong) | Subject 2–6 words, ≤ 45 characters, no clickbait |
| Personalized body +32.7% (Backlinko, 12M) | Every first touch has ≥ 1 sourced hook; never fake familiarity |
| One follow-up added ~66% more replies (Backlinko); 42–59% of replies came after step 1 (Instantly, Belkins); returns fall after 4–5 steps | Advice and recruiting: 1 bump (2 in finance and consulting, as today). Sales, fundraising and hiring cold: up to 2. Never more than 3 unanswered messages |
| InMails under 400 characters +22% (LinkedIn) | LinkedIn messages ≤ 400 characters; connection notes ≤ 200 (limit 300) |
| Professors answered 67% of students' cold emails, 95% of them within 48 hours (Milkman et al.) | 48 hours of silence is a weak "no reply yet"; bump timing per §9 |
| Wednesday and Thursday best, weekends worst (Backlinko, Belkins); Friday and Saturday worse on LinkedIn | Send window Tue–Thu, 8:00–10:30 in the recipient's time zone (Mon allowed for LinkedIn), with 0–20 min jitter |
| VCs source most deals through networks and referrals; ~10% inbound (Gompers et al.) | Fundraising always looks for a warm path first; a cold investor email is offered only when no path has `P ≥ 0.15` |

**Kinds** (extending `MessageKind`):
- `first_touch` and `warm_first_touch` (names the mutual).
- `intro_request` to the intermediary.
- `forwardable_blurb`: ≤ 90 words, third person, forwardable unchanged, double opt-in.
- `bump`, `thank_you`.
- `reengage`: score ≥ 30 and no contact in ≥ 180 days. Sends a real update, with no ask unless the user wants one.
- `reply` (§8), `schedule`, `report_back`, `congratulate`, `nurture`.
- The existing `outreach` and `referral_ask`.

**Goal families:**

| Goal | Default ask | Register |
|---|---|---|
| recruiting | 15-minute call about their path or team | warm, curious, specific |
| advice | 15–20 minutes on one named question | warm, humble |
| fundraising | "Would you be open to a look?" plus one line of traction | crisp, numbers first |
| sales | "Worth a quick look?" tied to a trigger | short, concrete, no hype |
| hiring | "Open to hearing about it?" with the role's one hook | direct, respects their current job |
| cofounder | 20 minutes to compare notes on {problem} | peer-to-peer |
| community | invite to a specific event or group | friendly |
| collaboration | a specific question about their paper plus the overlap | precise, academic |

**Personalization inputs:**
- From §5: `openers`, `in_common`, `now`.
- From §1: user context and the goal.
- The thread's last inbound message, quotes stripped.
- The path (`via`) for warm touches.

**Voice model** (shared with §8):
- The existing `StyleCard`: greetings, sign-offs, sentence length, contractions, emoji, characteristic phrases.
- Plus 3 exemplars: the user's own sent messages most similar to the situation, found by cosine similarity on `messages.embedding`.
  - Only outbound messages of ≥ 25 words.
  - Not ones sent to the same recipient.
  - Recipient names replaced by `[name]`.
  - LinkedIn sent messages count too.

**Pipeline:**
1. Compose with Opus 5.5.
2. Run `validateDraft` and `validateComposed`.
3. If either fails, retry once, listing the issues.
4. If it still fails, fall back to the template and set `generated_by = template`.
5. Store the result as a draft (§8 for sending).

**Reused open-source patterns:**
- `ethanplusai/harvey` (MIT, https://github.com/ethanplusai/harvey): the deterministic pre-send gate (unrendered tags, banned phrases, length, link count) and the "every fact is a row with source and confidence" idea. These became `validateComposed` and the `hooks[].sourceId` requirement.
- `growthenginenowoslawski/coldoutboundskills` (MIT, https://github.com/growthenginenowoslawski/coldoutboundskills): its spam-word list, vendored as data into `packages/core/src/drafts/spamWords.ts` with its license notice, and checked for sales goals; and the positive-reply metric.
- `elie222/inbox-zero` (AGPL-3.0 with extra terms): patterns only, no code. Its reply-tracking idea ("awaiting your reply / theirs") informs §8.
- `kaymen99/sales-outreach-automation-langgraph` and `Cold-IQ` skills: rejected, no license.

### 7.4 Data

```ts
interface ComposedMessage {
  id: string; goalId: string | null; personId: string; kind: MessageKind;
  channel: 'gmail' | 'linkedin';
  subject: string | null;
  body: string;
  ask: { kind: 'call' | 'question' | 'interest' | 'intro' | 'none'; text: string };
  hooks: { text: string; sourceId: string }[];
  via?: { introducerId: string; pathScore: number };
  sendWindow: { notBefore: string; tz: string };
  validator: { ok: boolean; issues: string[]; words: number; grade: number };
  promptVersion: string;
  variant: string | null;
}
```

- **Storage:** `orbit.drafts`, with `ask`, `hooks`, `via`, `validator`, `prompt_version`, `variant`, `replied_at` and `reply_class`.
- **Voice exemplars:** `orbit.messages.embedding`.

### 7.5 APIs and open source

- **Anthropic Messages API** via `@anthropic-ai/sdk` (`messages.parse` with a Zod schema).
- **Supabase `gte-small`** for embeddings.
- **Open source:** listed in §7.3.

### 7.6 Prompts

**compose-v2.0**: Opus 5.5, effort `medium`, structured output = §7.4 minus the server fields.

```
System: You write one message that {user first name} will send as themselves. It must sound like them, not like a template or a salesperson.
Hard rules:
- {word range} words; one ask: {ask kind}; subject 2–6 words.
- Use at least one opener from <research> and keep it true; cite its source id in hooks.
- Never claim familiarity, shared history or a mutual connection that isn't in the inputs.
- No flattery adjectives (amazing, incredible, inspiring), no "I hope this finds you well", no "quick question", no em-dashes, no exclamation marks unless the voice card uses them.
- Plain words, short sentences (reading grade ≤ 7).
- Match <voice> for greeting, sign-off, contractions and sentence length. Borrow rhythm from <examples>, never their content.
User: <user_context/> <goal/> <recipient/> <research/> <thread/> <via/> <voice/> <examples/>
```

**Forwardable blurb** (appended to an `intro_request`):

```
Write a third-person blurb of at most 90 words that {intermediary} can forward unchanged to {target}: who {user} is, the one reason they want to talk to {target}, and the small ask. No flattery. Facts only from the inputs.
```

### 7.7 Edge cases

- **Commercial email to UK/EU recipients** (sales goal): add the user's company and a one-line opt-out ("If this isn't relevant, just say so and I won't follow up."), and honour it (§14).
- **The recipient already declined** (any goal): no new first touch for 180 days.
- **≥ 3 people at one company contacted this week**: warn before drafting a 4th.
- **Sales first touches** are capped at 30 a day on Gmail.
- **The style card has fewer than 5 sent messages**: use the tone preset instead (`warm`, `direct` or `formal`).
- **The user edits a draft**: re-validate the edit, show any issues, but never block sending the user's own text.

### 7.8 Acceptance tests

1. The core validator rejects:
   - a 130-word first touch;
   - two asks;
   - reading grade > 7;
   - a first touch with no hook;
   - a LinkedIn message > 400 characters;
   - a connection note > 200 characters.
2. Every kind × goal template passes `validateComposed` without an LLM.
3. Offline eval gate (§15): 100% of drafts pass the validator, the judge's mean score is ≥ 4.0, and no draft contains an invented fact. Results are recorded in `docs/plan/evals/compose-v2.md`.
4. Function test: when a draft names someone who is not in the inputs, the retry runs, then the template fallback is used.

---

## 8. Reply handling and continuation in the user's voice

### 8.1 Purpose

Read every reply on Gmail and LinkedIn, understand what it means, and draft the answer as the user. Steer toward a call using real availability, and keep the user in control of what is sent.

### 8.2 Reuse / Extend / New

- **Reuse:**
  - the reply-signal classifier (about 460 labelled replies, 95% holdout accuracy);
  - message extraction: proposed times, asks, offers, return dates;
  - the send pipeline and its 60-second undo.
- **Extend:** an 11-class mapping, with an LLM fallback when confidence is low.
- **New:**
  - replies drafted in the user's voice;
  - free/busy slots and event creation;
  - autonomy levels;
  - LinkedIn sending through Unipile;
  - chat tools:
    - `list_replies`
    - `draft_reply {messageId}`
    - `book_call {draftId, slot}` (risky)
    - `set_autonomy {level, goalId?}` (risky)

### 8.3 Design

**Classes:**

| Class | Existing `ReplySignal` | Next action |
|---|---|---|
| `interested` | reply_positive | offer times |
| `scheduling` | scheduling_proposal, scheduling_confirmation, reschedule | confirm a slot, create the event, or reschedule |
| `question` | question | answer; if facts are missing, ask the user in chat first |
| `objection` | new | acknowledge, one sentence of response, leave the door open; no second push |
| `referral` | referral_offer, intro_offer | thank, accept, ask for the intro or contact; create the referred person |
| `not_now` | new (timing push-back) | thank; schedule a follow-up at the stated time |
| `out_of_office` | out_of_office | hold bumps until return + 2 business days |
| `decline` | reply_decline | brief thanks; close the chat as declined |
| `unsubscribe` | new ("remove me", "stop emailing") | no reply drafted; set `do_not_contact`; close the chat |
| `thanks` | thank_you | no reply unless it contains a question |
| `other` | other, reply_neutral | draft only on request |

**Classifier:**
- `classifyReply` wraps the existing signal reader and adds keyword rules for the three new classes.
- When confidence is below 0.75, Haiku 5.5 classifies the reply instead (§8.6).
- The corpus gains ≥ 40 labelled examples each of objection, not_now and unsubscribe.

**Drafting the response:**
- Model: Opus 5.5.
- Voice inputs: the same as §7.3, but the exemplars are the user's own *replies* (sent messages that have `In-Reply-To`).
- Thread context: the full thread, quotes stripped, oldest first, at most 8 messages.
- Validated with `validateComposed` using the `reply` kind.

**Funnel to a call:**
- Availability: `POST https://www.googleapis.com/calendar/v3/freeBusy` with `{timeMin: now+18h, timeMax: now+10 business days, timeZone, items: [{id: "primary"}]}`.
- Candidate slots:
  - 30 minutes long, 9:00–17:30 in the user's time;
  - no weekends, not adjacent to another event;
  - 3 slots on 3 different days.
- Rendering:
  - shown in the recipient's time zone when known (from their signature, headers or LinkedIn location);
  - otherwise in the user's, with the zone named.
- If `settings.scheduling_link` (Cal.com or Calendly) is set, the link is added too.
- When the recipient confirms a time, Orbit creates the event after the user approves:
  - `POST /calendar/v3/calendars/primary/events?sendUpdates=all`;
  - needs scope `calendar.events`, requested incrementally the first time.

**Autonomy levels.** `users.autonomy_level`, which a goal can override with `goals.autonomy_level`.

| Level | Name | Behaviour |
|---|---|---|
| 0 | Draft only (default) | Drafts appear in Drafts and the chat; the user sends |
| 1 | Send after approval | One tap schedules the send for the next send window, with the 60-second undo |
| 2 | Auto-send within rules | See the conditions below |

Level 2 sends a reply only when **all** of these hold:
- the channel is Gmail;
- the reply is inside a thread where both sides have written;
- the class is `scheduling`, `thanks`, or a follow-up after `out_of_office`;
- the recipient's score is ≥ 40;
- the draft makes no new commitment: no money, no dates beyond the offered slots, no attachments, no links other than the scheduling link;
- the validator passes;
- the user has made ≤ 5 auto-sends today;
- it is not between 21:00 and 7:00 in the recipient's time.

Every auto-send appears in the morning brief and the audit log.

**Which channel sends what:**
- **Gmail**
  - Endpoint: `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `{raw, threadId}`.
  - Headers: `In-Reply-To`, `References`, `X-Orbit-Draft-Id`.
  - Scope: `gmail.send`.
  - Used for all email.
- **LinkedIn (Unipile)**
  - Existing chat: `POST /api/v1/chats/{chat_id}/messages` (multipart: `text`, `account_id`).
  - New chat with a 1st-degree connection: `POST /api/v1/chats` (`account_id`, `attendees_ids[]`, `text`).
  - Every LinkedIn send needs the user's tap on that message, at any autonomy level.
  - Invitations (`POST /api/v1/users/invite`) and InMail are sent only when the user presses "Send invite" or "Send InMail" on that specific item.
- **LinkedIn caps** (well under Unipile's guidance):

| Action | Cap |
|---|---|
| Messages | 25 per day |
| Invites | 15 per day, 60 per week |
| Profile views | 40 per day |
| Spacing between actions | random 20–90 s |

### 8.4 Data

- `orbit.messages`: `reply_class`, `reply_confidence`, `extraction`.
- `orbit.drafts`: kind `reply`, `in_reply_to`, `thread_external_id`, `autonomy_level`.
- `orbit.calendar_events`.
- `orbit.audit_log`.
- `orbit.users.autonomy_level`.

### 8.5 APIs and open source

- **Gmail:** `messages.send` (above).
- **Calendar:**
  - `freeBusy`
  - `events.insert`
- **Unipile:**
  - chats and messages
  - webhook `message_received` (§12)
- **Open source:** `crisp-oss/email-reply-parser` (quote stripping); `elie222/inbox-zero` (pattern only: track who is waiting on whom).

### 8.6 Prompts

**Classification**: Haiku 5.5, used only when heuristic confidence is below 0.75.

```
System: Classify the newest message in this thread as one of: interested, scheduling, question, objection, referral, not_now, out_of_office, decline, unsubscribe, thanks, other.
"unsubscribe" means they ask not to be contacted again. "referral" means they point to someone else. "not_now" means later, not never.
Extract proposed times (as written, with any time zone), a return date, referred people, and their question if any.
User: <thread>{oldest→newest, quotes stripped}</thread>
```

Schema: `{class, confidence, proposed_times[], return_date|null, referred_people[{name, email|null, org|null}], question|null}`.

**Reply drafting**: compose-v2 (§7.6), plus:

```
Answer what they said. If they proposed times, accept one that is free (given in <free_slots>) or offer those. Keep it shorter than their message unless they asked questions. If a fact is needed that is not in the inputs, write [ASK USER: …] instead of guessing.
```

A draft containing `[ASK USER:` is never sent. The chat asks the user for the missing fact.

### 8.7 Edge cases

- **Someone else replies** (forwarded or delegated): resolve the new sender, link them to the same chat, and note "Sam replied for Priya".
- **LinkedIn reply to an email outreach**: both threads join one chat.
- **Decline plus referral**: `referral` wins. The referred person is created, then the chat closes as declined.
- **The user already replied from Gmail**: incremental sync sees the outbound message, and the pending draft is cancelled with reason `replied`.
- **Legal, medical or financial content in the thread**: draft only, never auto-send.
- **Ambiguous time zone in proposed times**: ask the user before booking.

### 8.8 Acceptance tests

1. Core holdout accuracy ≥ 95% across the 11 classes, and 100% on unsubscribe and decline.
2. A `scheduling` reply produces a draft with 3 free slots. The slots don't overlap the fixture calendar and are shown in the recipient's time zone.
3. Level 2 auto-sends a confirmation inside a two-way Gmail thread. It refuses, leaving a draft only, for:
   - a cold first reply;
   - a LinkedIn thread;
   - 23:00 in the recipient's time zone.
4. `unsubscribe` sets `do_not_contact`. Any later compose to that person returns an error, which the chat explains.
5. A draft containing `[ASK USER:` cannot be approved for sending.

---

## 9. Follow-up and cadence engine

### 9.1 Purpose

Bumps, stage changes, went-quiet detection, thank-yous and regular nurture of important ties, whether the app is open or not.

### 9.2 Reuse / Extend / New

- **Reuse:** the rules in `suggestions/rules.ts` and `pipeline/transitions.ts`:
  - bump timing by channel and sector;
  - quiet after 7 days;
  - `no_response` after 14 or 21 days;
  - 3-day thank-you window;
  - out-of-office hold.
- **Extend:**
  - a second bump for some goal families;
  - nurture by tie importance;
  - a cross-channel cap of 3 unanswered messages.
- **New:**
  - `pipeline/cadence.ts`, as pure functions;
  - pgmq queues;
  - the `orbit-worker` function;
  - pg_cron schedules;
  - scheduled sends.

### 9.3 Design

**Queues** (`pgmq`), in priority order: `orbit_send`, `orbit_classify`, `orbit_sync`, `orbit_cadence`, `orbit_score`, `orbit_enrich`.

**Tick.** `pg_cron` runs `orbit-worker-tick` every minute. It calls `{functions}/orbit-worker` through `pg_net` with the header `x-orbit-cron: <vault orbit_cron_secret>`.

**Worker loop:**
- Time budget per tick: 110 s (fits the 150 s Free-plan wall clock; 300 s on a paid plan, via `ORBIT_WORKER_BUDGET_MS`).
- For each queue in priority order:
  1. `pgmq.read(queue, 120, 10)`.
  2. Dispatch each message on `message.kind`.
  3. On success: `pgmq.delete`.
  4. On failure: `pgmq.set_vt(queue, msg_id, 30·2^read_ct)`.
  5. If `read_ct > 5`: `pgmq.archive` and insert into `orbit.dead_letters`.
- Message shape: `{kind, userId, payload, dedupeKey?}`.
- A `dedupeKey` with an `ok` row in `job_runs` in the last 24 h is skipped.
- Every run writes a row to `orbit.job_runs`.

**Cron:**

| Name | Schedule | Calls |
|---|---|---|
| `orbit-worker-tick` | `* * * * *` | the worker |
| `orbit-incremental` | `*/10 * * * *` | `orbit.enqueue_incremental_syncs()` |
| `orbit-cadence` | `7 * * * *` | `orbit.enqueue_cadence()` (dedupe key `cadence:<user>:<yyyy-mm-dd-hh>`) |
| `orbit-nightly` | `13 7 * * *` | `orbit.enqueue_nightly()`: scores, Gmail watch renew, calendar resync |
| `orbit-retention` | `23 8 * * *` | `orbit.retention_purge()` |
| `orbit-health` | `*/15 * * * *` | `orbit.health()` snapshot to the audit log |

**`cadence.user` handler.** Runs for one user, in their time zone, honouring `quiet_until` and quiet days. Each step:

1. **Bumps.** Existing `bumpDue`.
   - Sales, fundraising and hiring cold: bump 2 at +7 business days after bump 1.
   - Never a 4th unanswered message across channels.
   - Creates a `bump` draft, or `approved` + `send_at` when the goal's autonomy is 1 and the user pre-approved bumps for that chat.
2. **Went quiet** (`wentQuiet`): a notification, plus a bump draft if allowed.
3. **Thank-you due.** A meeting ended less than 3 days ago with no thank-you sent: draft a `thank_you`, using the note if there is one.
4. **Stage timers**: the existing `no_response` closing.
5. **Nurture.** Who qualifies:
   - score ≥ 60, or tied to an active goal;
   - no contact in the cadence window: Close 60 days, Strong 90, goal-linked 30;
   - a reason to write exists: a new role, a post, a dossier "recently" item, or the user's own news.

   Creates a `nurture` or `reengage` suggestion. At most 3 per week.
6. **Send due.** Approved drafts with `send_at ≤ now` are enqueued to `orbit_send`.

**Send handler.** Before sending, it re-checks the thread for an inbound message newer than the draft. If there is one, it cancels with reason `replied`.

**Chat tools:**
- `pause_outreach {until}` (sets `quiet_until`)
- `list_due`

### 9.4 Data

- `orbit.drafts`: `status`, `send_at`, `cancel_reason`
- `orbit.chats`
- `orbit.stage_events`
- `orbit.job_runs`
- `orbit.dead_letters`
- `pgmq` queue tables

### 9.5 APIs and open source

- **Supabase Queues** (`pgmq/pgmq`, PostgreSQL license, https://github.com/pgmq/pgmq):
  - `pgmq.create`
  - `pgmq.send(queue, msg, delay)`
  - `pgmq.read(queue, vt, qty)`
  - `pgmq.delete`
  - `pgmq.archive`
  - `pgmq.set_vt`
- **Scheduling:**
  - `pg_cron` + `pg_net` (Supabase scheduled-functions pattern)
  - Vault for the secrets they use
- **Not used:** Inngest, BullMQ/Redis.

### 9.6 Prompts

None of its own. Drafts come from compose-v2 (§7.6) with the `bump`, `thank_you`, `nurture` or `reengage` kind. Bumps include the original message's one-line summary as context.

### 9.7 Edge cases

- **Vacation** (`quiet_until`): nothing is drafted or sent.
- **Send window falls on a holiday or weekend**: skip US federal holidays and the recipient's weekend.
- **The person replies between cadence runs**: cancel the send with reason `replied`.
- **Daylight-saving transitions**: compute send windows with the IANA time zone at send time.
- **Duplicate cron ticks**: handled by dedupe keys and queue visibility.

### 9.8 Acceptance tests

1. `orbit.enqueue_cadence()` enqueues exactly one message per active user per hour (SQL test).
2. A failing handler is retried with growing visibility timeouts and reaches `dead_letters` after 6 reads (worker test).
3. A bump is never sent when an inbound message arrived after it was drafted.
4. A person never receives more than 3 unanswered messages, across all channels.
5. Nurture produces at most 3 suggestions a week, each with a stated reason.

---

## 10. Pipeline and memory

### 10.1 Purpose

Store every person, thread, goal, note and outcome, and retrieve them so the agent has the right context each turn. Add a long-term memory the user can see and delete, plus retention rules.

### 10.2 Reuse / Extend / New

- **Reuse:**
  - chats (pipeline cards), stage events, notes, facts;
  - the snapshot;
  - compaction.
- **Extend:**
  - every chat carries `goal_id`;
  - the snapshot gains goals, "Remembered", and a focused person's score and dossier.
- **New:**
  - `orbit.memories` (pgvector);
  - chat tools `remember {text, personId?, kind}`, `recall {query, personId?}`, `forget {memoryId}`;
  - automatic memory extraction;
  - retention jobs;
  - Settings → Memory.

### 10.3 Design

**What counts as a memory:**
- A durable statement about the user: a preference, constraint, goal detail or outcome.
- A durable statement about a person, e.g. "Priya prefers LinkedIn", "Maya offered to refer me in March".
- Facts already held in structured tables are not duplicated.

**Writes:**
- The `remember` tool, shown in the chat as "Saved to memory".
- Automatic extraction after chat turns (§10.6).
- Note extraction, which writes person facts.
- Dedupe: cosine ≥ 0.92 to an existing memory updates its `last_seen_at` instead of inserting.

**Embedding:**
- Model `gte-small`, called as `new Supabase.ai.Session('gte-small').run(text, {mean_pool: true, normalize: true})`.
- 384 dimensions, computed by the function that writes the row.
- The model is English-only; non-English memories are stored without an embedding and found by keyword.

**Retrieval:**
- Runs every turn with `query` = the user's last message.
- Returns the top 8 by `0.7·cosine + 0.2·importance + 0.1·recency (30-day half-life)`.
- Filtered to the focused person when there is one.
- Goes into the snapshot as "Remembered", ≤ 300 tokens.

**Context assembly per turn:**
- Order: stable system prompt (cached) → tools (cached) → conversation (append-only, server-side compaction) → snapshot as a mid-conversation system message, sent only when it changed.
- The snapshot holds:
  - user context;
  - active goals;
  - pipeline counts;
  - brief cards;
  - the Setup line;
  - "Remembered";
  - for a focused person: score + explanation, dossier summary, last 3 messages.
- Snapshot budget: ≤ 1,500 tokens.

**Retention:**

| Data | Kept |
|---|---|
| Message metadata | until account deletion |
| Message bodies (networking threads only) | 24 months (setting: 6 / 12 / 24) |
| Non-networking mail | bodies never stored; metadata only if a participant is in the graph |
| Dossiers | 90 days |
| Research cache | 7 days |
| Memories | until the user deletes them |
| Audit log | 2 years |
| Job runs / dead letters | 30 / 90 days |

**Account deletion** (`/account/delete`):
1. Revoke the Google token (`POST https://oauth2.googleapis.com/revoke`).
2. Stop the Gmail watch (`POST /gmail/v1/users/me/stop`).
3. Remove the Unipile account (`DELETE /api/v1/accounts/{id}`).
4. Run `orbit.delete_user(uuid)`: delete every row the user owns plus their Vault secrets.

All of it completes within 24 h.

### 10.4 Data

`orbit.memories (kind, text, embedding vector(384), importance, source, quote, person_id, last_seen_at, deleted_at)` with an HNSW cosine index; plus the pipeline tables `orbit.chats`, `orbit.stage_events`, `orbit.notes`, `orbit.facts`.

### 10.5 APIs and open source

- **Supabase:**
  - `pgvector` with HNSW (`vector_cosine_ops`)
  - Edge Runtime AI `gte-small`
- **Not used:** an external vector database. Postgres holds both structured and vector data.

### 10.6 Prompts

**Memory extraction**: Haiku 5.5. Runs after a chat turn in which the user stated something.

```
System: Extract durable facts worth remembering for future conversations: preferences, constraints, details of goals, outcomes, and facts about specific people. Skip small talk and anything already in <known>. Each memory ≤ 200 characters, in third person about the user ("Prefers morning calls").
Return {"memories": [{kind, text, person_name|null, importance: 0..1, quote}]}; quote must be the user's own words.
User: <known>{top 20 memories}</known><turns>{last 2 user turns + assistant replies}</turns>
```

Drop any memory whose `quote` is not found in the user's text.

### 10.7 Edge cases

- **"Forget everything about X"**: delete that person's memories, then confirm with a count.
- **Contradictory memories**: newer wins. The old memory is soft-deleted and linked in `details`.
- **Memories naming someone who isn't in the graph**: keep them with `person_id = null`.
- **Sensitive categories volunteered by the user** (health, religion, etc.): never extracted automatically, only saved through an explicit `remember`.

### 10.8 Acceptance tests

1. `remember`, then `recall` with a paraphrase, returns that memory first.
2. A duplicate (cosine ≥ 0.92) updates the existing memory instead of inserting a new one.
3. `orbit.retention_purge()` nulls expired bodies and deletes expired dossiers and cache rows.
4. `orbit.delete_user()` leaves zero rows for the user in every `orbit` table that has a `user_id`.
5. Sim: after "I prefer morning calls", a later "draft a reply offering times" offers morning slots.

---

## 11. Data model and storage

### 11.1 Purpose

Full schemas for everything Orbit stores, and a clear split between what lives in the browser and what lives on the server.

### 11.2 Reuse / Extend / New

- **Reuse:** the core types as the client shapes. Column names follow `docs/plan/03` where they exist.
- **New:**
  - schema `orbit` (§11.4);
  - mappers from rows to core types (`packages/core/src/server/mappers.ts`);
  - the `/sync/pull` and `/sync/push` contracts.

### 11.3 Design

**Where data lives**

| Data | Local mode | Account mode |
|---|---|---|
| People, orgs, affiliations, identities | Dexie | Postgres (truth) → Dexie cache |
| Messages, threads, events | Dexie (90 days) | Postgres (2-year backfill) → Dexie (last 180 days, networking threads) |
| Ties, tie scores | Dexie | Postgres → Dexie |
| Goals, chats, stage events, notes, drafts, uploads | Dexie | Postgres, edited via `/sync/push` |
| Suggestions, briefs, notifications | Dexie (derived in the browser) | Dexie (derived from the cache) |
| Dossiers, recommendations | — | Postgres → Dexie |
| Memories | — | Postgres only (read through tools) |
| Chat conversations | Dexie | Dexie (server copy in P7) |
| Secrets | `orbit-local` IndexedDB | Vault; the browser holds only the Orbit session |

**Sessions**
- Access token: HS256 JWT `{sub, sid, aud: "orbit", iat, exp: +3600}`, signed with `ORBIT_SESSION_SECRET`.
- Refresh token: 32 random bytes, stored as SHA-256 in `orbit.sessions`, rotated on every refresh, expires after 30 days.
- In the SPA: the access token stays in memory and the refresh token in `orbit-local`. The SPA refreshes 5 minutes before expiry.

**Access rules**
- Every table has RLS enabled with **no policies**: only the service role can read or write.
- `revoke all on schema orbit from anon, authenticated`.
- The schema is not exposed through the Data API.
- Functions use `postgres.js` over `SUPABASE_DB_URL` (`prepare: false`), through one module: `supabase/functions/_shared/db.ts`.

**Sync contracts**
- `/sync/pull {cursor?, tables?, limit?}`
  - `cursor` is base64url JSON mapping each table to its last `(updated_at, id)`.
  - Returns rows already shaped as core types (camelCase), plus the ids of rows deleted since the cursor.
- `/sync/push {changes}`
  - Accepts user-authored tables only: goals, chats, stage_events, notes, uploads.
  - Drafts: only `draft → approved | discarded | cancelled`, and body edits while the status is `draft`.
  - People: only the manual fields.
  - Also: tie_labels, and deletes of memories.
  - Every push writes `audit_log`.

**Mapping to client types**

| Postgres | Core type |
|---|---|
| `people` | `Person` (`strength`, `strengthBreakdown`, `tieScore`, `tieBand`, `tieExplanation` from `tie_scores`) |
| `threads` | `EmailThread` |
| `messages` | `EmailMessage` (`direction: inbound \| outbound`) |
| `calendar_events` | `CalendarEvent` |
| `ties` | `Edge` (`weight = w·c`, `kinds`, `confidence`) |
| `chats` | `CoffeeChat` (`data` spread) |
| `drafts` | `OutboundMessage` |
| `goals` | `Goal` (the first recruiting goal also fills `RecruitingGoals`) |
| `dossiers` | `Dossier` |
| `recommendations` | `Recommendation` |

### 11.4 Data

The schema is migration `supabase/migrations/20261014_orbit_core.sql`. Every user-owned table:
- has `user_id uuid not null references orbit.users(id) on delete cascade`;
- has an index on `(user_id, updated_at)`;
- gets an `updated_at` trigger.

```sql
create schema if not exists orbit;
create extension if not exists pgmq;

create table orbit.users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique not null,
  email text not null,
  full_name text, first_name text, last_name text, avatar_url text,
  school text, school_domain text, grad_year int, degree text, majors text[] not null default '{}',
  current_title text, current_org text, current_city text,
  timezone text not null default 'America/New_York',
  autonomy_level smallint not null default 0 check (autonomy_level between 0 and 2),
  settings jsonb not null default '{}'::jsonb,
  onboarding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  last_seen_at timestamptz, deleted_at timestamptz
);
create unique index on orbit.users (lower(email));

create table orbit.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  refresh_hash text not null unique, user_agent text,
  created_at timestamptz not null default now(), last_used_at timestamptz,
  expires_at timestamptz not null, revoked_at timestamptz
);
create table orbit.oauth_states (
  state text primary key, code_verifier text not null, redirect_to text not null,
  user_id uuid references orbit.users(id) on delete cascade,      -- set for incremental consent
  scopes text[] not null, created_at timestamptz not null default now(), expires_at timestamptz not null
);
create table orbit.login_codes (
  code_hash text primary key, user_id uuid not null references orbit.users(id) on delete cascade,
  expires_at timestamptz not null, used_at timestamptz
);

create table orbit.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  provider text not null check (provider in ('google','linkedin','village')),
  external_account_id text, email text, scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active','needs_reauth','revoked','error','connecting')),
  token_secret_id uuid,                      -- vault.secrets id holding the refresh token
  sync_state jsonb not null default '{}'::jsonb,  -- {gmail:{historyId, backfill:{phase,pageToken,done,total}}, calendar:{syncToken}, contacts:{syncToken}, linkedin:{cursor}}
  watch_expires_at timestamptz, last_synced_at timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table orbit.organizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  name text not null, name_norm text not null, domains text[] not null default '{}',
  linkedin_slug text, industry text, size_bucket text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, name_norm)
);

create table orbit.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  is_self boolean not null default false,
  display_name text not null, first_name text, last_name text, name_norm text not null,
  primary_email text, headline text, title text,
  org_id uuid references orbit.organizations(id) on delete set null, org_raw text,
  location text, timezone text, school text, is_alumni boolean not null default false,
  photo_url text, linkedin_url text, linkedin_slug text, linkedin_member_id text,
  relationship_type text, sources text[] not null default '{}',
  first_seen_at timestamptz, last_interaction_at timestamptz,
  strength real not null default 0,          -- = tie score / 100, kept for the v1 UI
  summary text, tags text[] not null default '{}', notes text,
  do_not_contact boolean not null default false,
  hidden_at timestamptz, merged_into uuid references orbit.people(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index on orbit.people (user_id) where is_self;
create index on orbit.people (user_id, name_norm);
create index on orbit.people (user_id, org_id);

create table orbit.person_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('email','linkedin_member','linkedin_slug','phone','unipile_attendee')),
  value_norm text not null, value_raw text, source text not null, confidence real not null default 1,
  created_at timestamptz not null default now(),
  unique (user_id, kind, value_norm)
);

create table orbit.affiliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  org_id uuid references orbit.organizations(id) on delete set null, org_raw text,
  kind text not null check (kind in ('employment','education')),
  title text, degree text, field text, start_date date, end_date date, is_current boolean not null default false,
  source text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table orbit.merge_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_a uuid not null references orbit.people(id) on delete cascade,
  person_b uuid not null references orbit.people(id) on delete cascade,
  score real not null, features jsonb not null,
  status text not null default 'open' check (status in ('open','merged','rejected')),
  created_at timestamptz not null default now(), decided_at timestamptz, updated_at timestamptz not null default now()
);
create table orbit.do_not_merge (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_a uuid not null, person_b uuid not null, created_at timestamptz not null default now(),
  primary key (user_id, person_a, person_b)
);

create table orbit.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null check (kind in ('recruiting','fundraising','sales','hiring','advice','cofounder','community','collaboration')),
  title text not null, description text,
  targets jsonb not null default '{"organizations":[],"roles":[],"geographies":[],"people":[]}'::jsonb,
  criteria jsonb not null default '{}'::jsonb,       -- sourcing filters: sector, stage, seniority, skills, keywords
  success_metric text, priority smallint not null default 2 check (priority between 1 and 3),
  status text not null default 'active' check (status in ('active','paused','done')),
  autonomy_level smallint check (autonomy_level between 0 and 2),
  due_at date, source text not null default 'user' check (source in ('user','onboarding','inferred')),
  evidence text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);

create table orbit.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  provider text not null check (provider in ('gmail','linkedin')),
  external_id text not null, subject text,
  participant_person_ids uuid[] not null default '{}', participant_count int not null default 0,
  first_at timestamptz, last_at timestamptz, message_count int not null default 0,
  last_direction text check (last_direction in ('in','out')),
  category text, is_networking boolean not null default false, chat_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index on orbit.threads (user_id, last_at desc);

create table orbit.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  thread_id uuid not null references orbit.threads(id) on delete cascade,
  provider text not null check (provider in ('gmail','linkedin')),
  external_id text not null, rfc_message_id text, in_reply_to text,
  direction text not null check (direction in ('in','out')),
  from_person_id uuid references orbit.people(id) on delete set null,
  from_addr text, to_addrs text[] not null default '{}', cc_addrs text[] not null default '{}',
  to_person_ids uuid[] not null default '{}', cc_person_ids uuid[] not null default '{}',
  sent_at timestamptz not null, subject text, snippet text,
  body_text text,                              -- networking threads only; nulled by retention
  is_automated boolean not null default false, list_unsubscribe boolean not null default false,
  reply_class text, reply_confidence real, extraction jsonb,
  embedding vector(384),                       -- outbound messages ≥ 25 words, for voice exemplars
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index on orbit.messages (user_id, sent_at desc);
create index on orbit.messages (thread_id, sent_at);
create index on orbit.messages using hnsw (embedding vector_cosine_ops) where embedding is not null;

create table orbit.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  external_id text not null, title text, description text,
  start_at timestamptz not null, end_at timestamptz, status text,
  organizer_email text, attendees jsonb not null default '[]'::jsonb,   -- [{email, displayName, responseStatus, self}]
  attendee_person_ids uuid[] not null default '{}', attendee_count int not null default 0,
  conference_url text, is_one_on_one boolean not null default false, chat_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, external_id)
);

create table orbit.ties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  a_person_id uuid not null references orbit.people(id) on delete cascade,
  b_person_id uuid not null references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('email_exchange','email_cc','email_cothread','meeting_coattendee','introduced_by','linkedin_mutual','village_path','co_tenure','same_school_cohort','same_current_company','same_city')),
  weight real not null check (weight between 0 and 1), confidence real not null check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,   -- {threadIds[], eventIds[], orgId, overlapMonths, source, count}
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (a_person_id < b_person_id),
  unique (user_id, a_person_id, b_person_id, kind)
);
create index on orbit.ties (user_id, a_person_id);
create index on orbit.ties (user_id, b_person_id);

create table orbit.tie_scores (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  score smallint not null check (score between 0 and 100), band text not null,
  features jsonb not null, contributions jsonb not null, explanation text[] not null default '{}',
  model_version text not null, computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, person_id)
);
create table orbit.tie_labels (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  closeness smallint not null check (closeness between 1 and 5),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (user_id, person_id)
);

create table orbit.chats (           -- pipeline cards (CoffeeChat in core)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  goal_id uuid references orbit.goals(id) on delete set null,
  org_id uuid references orbit.organizations(id) on delete set null,
  stage text not null, stage_entered_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,   -- the remaining CoffeeChat fields, camelCase, as in core
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table orbit.stage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  chat_id uuid not null references orbit.chats(id) on delete cascade,
  from_stage text, to_stage text not null, status text not null, actor text not null,
  reason text, evidence jsonb, confidence real,
  created_at timestamptz not null default now(), decided_at timestamptz, updated_at timestamptz not null default now()
);

create table orbit.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  chat_id uuid references orbit.chats(id) on delete set null,
  goal_id uuid references orbit.goals(id) on delete set null,
  channel text not null check (channel in ('gmail','linkedin')),
  kind text not null, subject text, body text not null,
  ask jsonb, hooks jsonb not null default '[]'::jsonb, via jsonb,
  thread_external_id text, in_reply_to text,
  status text not null default 'draft' check (status in ('draft','approved','scheduled','sending','sent','failed','discarded','cancelled')),
  autonomy_level smallint not null default 0, send_at timestamptz, sent_at timestamptz,
  provider_message_id text, error text, cancel_reason text,
  validator jsonb, generated_by text not null default 'template', prompt_version text, variant text,
  replied_at timestamptz, reply_class text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on orbit.drafts (status, send_at) where status in ('approved','scheduled');

create table orbit.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_ids uuid[] not null default '{}', chat_id uuid references orbit.chats(id) on delete set null,
  source text not null, title text, occurred_at timestamptz not null, raw_text text not null,
  extraction jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table orbit.uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null check (kind in ('resume','note','transcript','linkedin_export')),
  filename text, text text not null, parsed jsonb, is_current boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table orbit.facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  type text not null, text text not null, source_table text, source_id uuid, occurred_at timestamptz,
  confidence real not null default 0.8, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table orbit.dossiers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  goal_id uuid references orbit.goals(id) on delete set null,
  status text not null check (status in ('pending','ready','partial','needs_disambiguation','failed')),
  content jsonb, sources jsonb not null default '[]'::jsonb, candidates jsonb,
  cost_usd numeric(8,4) not null default 0, model text, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  unique (user_id, person_id)
);
create table orbit.research_cache (
  user_id uuid not null references orbit.users(id) on delete cascade,
  key text not null, provider text not null, response jsonb not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  primary key (user_id, key)
);

create table orbit.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  goal_id uuid references orbit.goals(id) on delete cascade,
  person_id uuid references orbit.people(id) on delete cascade,
  candidate jsonb not null,                  -- provider record when not yet a person
  source text not null, external_id text,
  rank real not null, fit real, reach real, responsiveness real, reasons text[] not null default '{}',
  status text not null default 'new' check (status in ('new','added','dismissed')),
  batch_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table orbit.intro_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  target_person_id uuid references orbit.people(id) on delete set null,
  introducer_person_id uuid references orbit.people(id) on delete set null,
  goal_id uuid references orbit.goals(id) on delete set null,
  path jsonb not null, path_score real not null, rank int not null,
  status text not null default 'asked' check (status in ('asked','agreed','declined','intro_made','meeting','no_response')),
  asked_at timestamptz not null default now(), outcome_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table orbit.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('preference','constraint','goal_detail','outcome','person_fact','note')),
  text text not null, embedding vector(384), importance real not null default 0.5,
  source text not null, quote text,
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz
);
create index on orbit.memories using hnsw (embedding vector_cosine_ops);

create table orbit.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid references orbit.users(id) on delete cascade,
  provider text not null, operation text not null, units numeric not null, cost_usd numeric(10,5) not null,
  created_at timestamptz not null default now()
);
create index on orbit.usage_ledger (user_id, created_at);

create table orbit.job_runs (
  id bigint generated always as identity primary key,
  queue text not null, msg_id bigint, user_id uuid, kind text not null, dedupe_key text,
  status text not null check (status in ('running','ok','error','skipped')),
  attempt int not null default 1, error text, duration_ms int,
  started_at timestamptz not null default now(), finished_at timestamptz
);
create index on orbit.job_runs (dedupe_key, finished_at) where status = 'ok';
create table orbit.dead_letters (
  id bigint generated always as identity primary key,
  queue text not null, msg_id bigint, message jsonb not null, error text, created_at timestamptz not null default now()
);
create table orbit.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references orbit.users(id) on delete cascade,
  actor text not null check (actor in ('user','agent','system')),
  action text not null, target_table text, target_id text, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table orbit.webhook_events (      -- idempotency for inbound webhooks
  provider text not null, event_id text not null, received_at timestamptz not null default now(),
  primary key (provider, event_id)
);
```

**Functions** in the same migration. All are `security definer` with `set search_path = ''`, and `execute` is granted only to `service_role`.

| Function | Purpose |
|---|---|
| `orbit.touch_updated_at()` | trigger that sets `updated_at` |
| `orbit.enqueue(queue, msg, delay)` | add a job to a queue |
| `orbit.enqueue_incremental_syncs()` | queue incremental syncs |
| `orbit.enqueue_cadence()` | queue cadence jobs |
| `orbit.enqueue_nightly()` | queue nightly jobs |
| `orbit.retention_purge()` | apply the retention rules |
| `orbit.delete_user(uuid)` | delete all of one user's data |
| `orbit.vault_put(name, secret)` | store a secret in Vault |
| `orbit.vault_get(id)` | read a secret from Vault |
| `orbit.vault_delete(id)` | remove a secret from Vault |
| `orbit.health()` | health summary |

**Views:** `orbit.v_reply_rates`, `orbit.v_queue_depth`, `orbit.v_costs`.

**Queues:** created with `pgmq.create` for the six queues in §9.3.

### 11.5 APIs and open source

**Extensions** (all on Supabase Postgres 17):
- `pgmq`
- `pg_cron`
- `pg_net`
- `supabase_vault`
- `vector` (0.8.0)

**Libraries:**
- `postgres.js` (https://github.com/porsager/postgres, Unlicense) in the functions.
- `@electric-sql/pglite` (https://github.com/electric-sql/pglite, Apache-2.0) with its `vector` extension in the unit tests.
  - Stubs for `pgmq`, `vault`, `cron` and `net` live in `supabase/tests/stubs.sql`.

### 11.6 Prompts

None.

### 11.7 Edge cases

- **Clock skew between the browser and the server.** The cursor uses server `updated_at` only, and the client never writes `updated_at`.
- **Push conflicts.** Last write wins per field for user-authored fields. A status move that is no longer valid (the draft was already sent) is rejected, and the client is told.
- **A soft-deleted person** comes back in a pull with `deleted: true`; Dexie removes it.
- **A very large first pull.** Pull pages through tables in dependency order: organizations, then people, then threads, then messages, and so on. Each page is capped at 2,000 rows.

### 11.8 Acceptance tests

1. The migration applies cleanly on PGlite with stubs and on the live project.
2. Each mapper round-trips its type (rows → core → rows) with nothing lost.
3. After every push, a pull returns the change, and a second pull with the new cursor returns nothing.
4. An `anon` or `authenticated` role cannot select from any `orbit` table (SQL test with `set role`).

---

## 12. Sync and ingestion architecture

### 12.1 Purpose

Import years of email at scale, then stay current through push notifications and polling. This covers Calendar, contacts and LinkedIn as well, and resolves each person across providers without creating duplicates.

### 12.2 Reuse / Extend / New

- **Reused from core**:
  - automated-mail filters
  - triage
  - signals
  - participant extraction (via the `engine/ingest.ts` logic)
- **New**:
  - server OAuth
  - backfill and incremental jobs
  - Gmail push
  - Unipile webhooks
  - batch resolution
  - function bundling

### 12.3 Design

**Sign-in and consent**

1. `GET {ORBIT_API}/auth/google/start?redirect=…`
   - Creates `oauth_states`: state, PKCE verifier, 10-minute expiry.
   - Redirects (302) to `https://accounts.google.com/o/oauth2/v2/auth` with:
     - `access_type=offline`
     - `prompt=consent`
     - `include_granted_scopes=true`
     - `code_challenge_method=S256`
     - the scopes in §14.3
2. `GET /auth/google/callback`
   - Calls `POST https://oauth2.googleapis.com/token`, then verifies the `id_token` (JWKS; checks aud, iss, exp).
   - Upserts the user by `sub` and creates the self person.
   - Stores the refresh token: `vault_put('google_refresh:'||user_id, …)`.
   - Upserts the Google `integration_accounts` row.
   - Creates a login code (2-minute expiry, stored hashed).
   - Redirects (302) to `{ORBIT_APP_URL}/auth/done#code=…`.
3. The SPA calls `POST /auth/session {code}` and receives a session.
4. Google access tokens are minted from the refresh token on demand and cached in memory until 5 minutes before expiry. An `invalid_grant` error sets the integration to `needs_reauth`.

**Gmail backfill** (`sync.gmail.backfill`, as chained jobs)

1. **Phase `recent`**
   - `GET /gmail/v1/users/me/messages?q=newer_than:90d -in:chats&maxResults=500` (5 quota units).
   - For each id not already stored: `GET /messages/{id}?format=metadata` with these `metadataHeaders` (20 units):
     - From, To, Cc, Date, Subject
     - Message-ID, In-Reply-To, References
     - List-Unsubscribe, Auto-Submitted, Precedence
   - Classify each thread from its headers.
   - A thread is a **networking candidate** when the user sent in it, or it has ≤ 8 participants including a known person, and it is not automated. For these:
     - `GET /threads/{id}?format=full` (40 units).
     - Store `text/plain`, or stripped HTML when there is no plain part.
     - Strip quotes for classification and for the voice model.
2. **Phase `deep`**
   - The same steps with `q=after:<2 years ago> before:<90 days ago>`.
3. **Pacing**
   - Per-user token bucket of 90 quota units per second (Google allows 6,000 per minute per user), with 5 requests in flight.
   - Each job processes ≤ 250 messages, saves `pageToken` in `sync_state`, and re-queues itself after 5 s.
   - Typical mailbox of 10–20k messages: `recent` finishes in 3–6 minutes, `deep` in 40–80 minutes.
4. **Triage**
   - Threads the heuristics mark uncertain go to Haiku 5.5 through the Batches API, at 50% of the normal price.

**Gmail incremental**

- **Push**
  - `POST /gmail/v1/users/me/watch {topicName: GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX","SENT"], labelFilterBehavior: "include"}` at connect, and again every night (a watch lasts at most 7 days).
  - Pub/Sub pushes to `orbit-webhooks/gmail?token=ORBIT_PUBSUB_TOKEN`.
  - The webhook decodes `{emailAddress, historyId}` and enqueues `sync.gmail.incremental` with dedupe key `gmail:<user>:<historyId>`.
- **Poll fallback**
  - Every 10 minutes for users whose last sync is more than 10 minutes old.
- **Handler**
  - `GET /history?startHistoryId=…&historyTypes=messageAdded&maxResults=500` (2 units), then the same per-message path as the backfill.
  - On **404**: run a 30-day `recent` backfill and reset `historyId` from `GET /users/me/profile`.

**Calendar**

- Initial sync: `GET /calendar/v3/calendars/primary/events?singleEvents=true&timeMin=<2y ago>&timeMax=<+90d>&maxResults=2500`, paged, saving `nextSyncToken`.
- Every 10 minutes: call again with `syncToken` only. It cannot be combined with timeMin, timeMax or q.
- **410 Gone**: run a full resync.

**Contacts**

- Run `otherContacts.list` and `people.connections.list` with `requestSyncToken=true` at connect, then weekly.
- An expired sync token (410): run a full list again.

**LinkedIn through Unipile**

- **Connect**
  - `POST /api/v1/hosted/accounts/link` with:
    - `type: "create"`, `providers: ["LINKEDIN"]`, `api_url`, `expiresOn` (+1 h)
    - `name` = the Orbit user id
    - `notify_url` = `orbit-webhooks/unipile/account?token=…`
    - `success_redirect_url` = `{ORBIT_APP_URL}/settings?linkedin=connected`
- **Backfill**
  - Relations: `GET /api/v1/users/relations?account_id=&limit=1000&cursor=` until the cursor is null.
  - Chats: `GET /api/v1/chats?account_id=&limit=250&after=<2y ago>`.
  - For chats with ≤ 3 attendees: `GET /api/v1/chats/{chat_id}/messages?limit=100`.
- **Webhooks**
  - Registered once by `scripts/unipile-webhooks.ts` via `POST /api/v1/webhooks`:
    - `messaging` (`message_received`)
    - `users` (`new_relation`)
    - `account_status`
  - Each is sent to `orbit-webhooks/unipile` with header `x-orbit-webhook`.
  - Drop the user's own messages (where `account_info.user_id == sender.attendee_provider_id`).
  - Idempotency comes from `orbit.webhook_events`.
  - `new_relation` can arrive up to 8 hours late.

**Entity resolution in batches**

- Each page of new addresses and profiles is resolved together:
  1. Look up `person_identities` with `value_norm in (…)`.
  2. Then look up `people` by `name_norm`.
  3. Then run `resolveIdentity` on each.
- Merge suggestions are created, never applied automatically.
- New identities are inserted with `on conflict do nothing`.

**Dedup**

- Unique `(user_id, provider, external_id)` on messages, threads and events, with `on conflict do nothing`.

**Rate limits respected**

| Provider | Limit |
|---|---|
| Gmail | 6,000 quota units per minute per user (Orbit uses ≤ 5,400) |
| Calendar | 600 requests per minute per user (Orbit uses ≤ 60) |
| People API | 1 full sync per day |
| Unipile | §8.3 caps; paging ≤ 1 request per second per account |
| Exa | 5 requests per second for all of Orbit |
| Apollo | 50 per minute (free) or 200 per minute (paid), shared and queued |
| Village | 100 requests per second per key |

**Bundling**

- `scripts/build-functions.mjs` runs esbuild with `bundle`, `esm`, `platform: neutral`, `target: es2022`.
- It aliases `@orbit/core` to `packages/core/src` and keeps `npm:` and `jsr:` imports external.
- Output is one deployable entry per function.
- CI fails if the committed bundle is stale.

### 12.4 Data

`integration_accounts.sync_state`:

```
{gmail: {historyId, backfill: {phase, pageToken, done, total}}, calendar: {syncToken}, contacts: {syncToken}, linkedin: {cursor, chatsCursor}}
```

Also used: `orbit.webhook_events`, `orbit.job_runs`.

### 12.5 APIs and open source

**Gmail v1** (https://developers.google.com/workspace/gmail/api)

- `messages.list` (5 quota units)
- `messages.get` (20)
- `threads.get` (40)
- `history.list` (2)
- `watch` (100)
- `stop`
- `getProfile`
- `settings.sendAs.list`
- `messages.send` (100)

**Other Google APIs**

- Calendar v3: `events.list`, `freeBusy`, `events.insert`.
- People v1: `otherContacts.list`, `people.connections.list`.
- Cloud Pub/Sub push.

**Unipile**

- hosted auth
- accounts
- relations
- chats and messages
- webhooks
- search
- users

**Open source**

- `email-reply-parser`
- `postal-mime` (`addressParser`)
- `nicknames`
- Patterns from `Mail-0/Zero` (MIT, https://github.com/Mail-0/Zero): Gmail OAuth sync with history IDs.
- Patterns from `elie222/inbox-zero`: Pub/Sub webhook shape only, no code.

### 12.6 Prompts

**Backfill triage** (Haiku 5.5 via Batches, only for uncertain threads):

```
Is this a person-to-person conversation that matters for {user}'s professional network (not a newsletter, receipt, notification, mass mailing or automated message)? Return {"networking": boolean, "category": "networking"|"recruiting_process"|"personal"|"transactional"|"newsletter"|"automated"|"other", "confidence": 0..1}.
```

### 12.7 Edge cases

- **Shared or delegated inboxes**: messages sent "on behalf of" count as the user only when the `From` address is one of the user's identities.
- **Very large mailboxes (> 200k messages)**: the `deep` phase stops at 50k messages, and the UI says so.
- **Watch registration fails** (Pub/Sub not configured): Orbit relies on the 10-minute poll.
- **Unipile account disconnected (`account_status: credentials`)**: LinkedIn sync pauses, and the Setup line asks the user to reconnect.
- **Duplicate messages across Gmail labels**: removed by the unique external id.
- **Gmail outside the 2-year window**: not read, so "first contact" may be later than reality; the explanation says "since {date}".

### 12.8 Acceptance tests

1. With a fake Gmail of 1,200 messages, the backfill completes in chained jobs and never exceeds 90 quota units per second. A crash midway resumes from the stored `pageToken`.
2. `history.list` returning 404 triggers the 30-day recovery.
3. A webhook event delivered twice is processed once.
4. Unipile messages sent by the user are not stored as inbound.
5. The same person from Gmail and LinkedIn becomes one person (fixture).

---

## 13. LLM architecture

### 13.1 Purpose

Choose the model for each task, keep costs predictable through caching and caps, return structured outputs, and fall back gracefully when a call fails.

### 13.2 Reuse / Extend / New

- **Reuse:** the chat loop: adaptive thinking, compaction, `display: updates`, the cached system prompt, and the refusal fallback.
- **Extend:** move the chat's fallback to `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- **New:**
  - the server helper `_shared/claude.ts`;
  - the prompt registry `_shared/prompts/*.ts`, one file per prompt with its `PROMPT_VERSION`;
  - `usage_ledger`;
  - budget enforcement.

### 13.3 Design

**Model per task**

| Task | Model | Settings | Fallback |
|---|---|---|---|
| Chat agent | `claude-opus-5-5` | effort medium (low for quick turns), adaptive thinking, compaction, `fallbacks: "default"` | router (no LLM) |
| Compose (all outbound kinds) | `claude-opus-5-5` | medium, structured output | template engine |
| Replies in voice | `claude-opus-5-5` | medium, structured output | template `reply` |
| Dossier synthesis | `claude-opus-5-5` | medium, structured output | internal + LinkedIn summary |
| Reply classification (low confidence) | `claude-haiku-5-5` | low, structured | heuristic class |
| Backfill triage | `claude-haiku-5-5` via **Batches API** | low | heuristic |
| Memory and goal extraction, intro detection | `claude-haiku-5-5` | low, structured | skip |
| Sourcing fit | `claude-haiku-5-5` | low, 20 candidates per call | keyword rule |
| Offline judges (compose eval, user-sim) | `claude-sonnet-5-5` | default | — |
| Embeddings | `gte-small` (Supabase) | 384 dims | keyword search |

**The helper** (`_shared/claude.ts`) does six things:
1. Takes the model from this table.
2. Puts `cache_control` on the system block.
3. Calls `messages.parse` with a Zod schema (`output_config.format`).
4. Checks `stop_reason`:
   - `refusal`: use the fallback path.
   - `max_tokens`: retry once with doubled `max_tokens`.
5. Records `usage` in `usage_ledger`.
6. Enforces caps before calling.

With no key set, it returns `{unconfigured: true}`.

**Prompt caching**
- Order: tools → system (stable) → conversation → snapshot as a mid-conversation system message.
- Server prompts keep the instruction block first and constant, then one cache breakpoint, then user data.
- The integration test asserts `cache_read_input_tokens > 0` on a repeated compose.

**Cost per active user per month** (estimate)

Assumptions:
- 60 chat turns
- 40 drafts and 30 replies
- 120 replies classified (25 of them by the LLM)
- 20 dossiers
- 8 sourcing runs
- 10 Village path lookups
- 1 LinkedIn account
- a one-off backfill of 15k messages with 1.5k uncertain threads

| Item | Calculation | $ |
|---|---|---|
| Chat (Opus 5.5) | 60 × (20k cached @ $0.20/M + 3k @ $4/M + 1.5k out @ $20/M) | 2.80 |
| Drafts + replies (Opus 5.5) | 70 × (6k in @ $4/M + 600 out @ $20/M) | 2.52 |
| Dossiers | 20 × (Exa ≈ $0.03 + Opus 25k in, 2k out ≈ $0.14) | 3.40 |
| Haiku tasks | ≈ 400 calls × 2k tokens @ $0.10/M | 0.10 |
| Backfill triage (one-off) | 1.5k × 1k tokens @ $0.05/M (batch) | 0.08 |
| Sourcing | 8 × (Exa 3 searches + Apollo free + Haiku) | 0.25 |
| Village | 10 × 5 credits × $0.02 | 1.00 |
| Unipile | 1 account (51–200 tier) | 5.00 |
| Supabase | Pro $25 + compute over ~200 users | 0.20 |
| **Total** | | **≈ $15.30** |

**Caps** (`_shared/budget.ts`, read from `usage_ledger`)
- Per user per day:
  - Claude $1.50
  - Exa $0.50
  - Village 50 credits
  - Apollo enrichment 10 credits
  - Unipile profile views 40
- Per user per month: $25.
- Over a cap: the call returns `budget_exceeded`, and the chat says what was skipped and when the cap resets.

### 13.4 Data

- `orbit.usage_ledger (user_id, provider, operation, units, cost_usd)`
- the view `orbit.v_costs`

### 13.5 APIs and open source

**Anthropic Messages API**, through `@anthropic-ai/sdk` (`npm:@anthropic-ai/sdk` in Deno):
- `messages.parse` and `messages.stream`
- Batches API: `messages.batches.create`, `.retrieve`, `.results`
- `count_tokens`

**Beta flags**
- Already in use:
  - `compact-2026-01-12`
  - `thinking-display-updates-2026-08-18`
  - `thinking-binding-controls-2026-08-01`
- Added:
  - `server-side-fallback-2026-07-01`

### 13.6 Prompts

All prompts are listed in their capability sections:
- §1.6 goals
- §2.6 introductions
- §5.6 dossier
- §6.6 fit
- §7.6 compose and blurb
- §8.6 replies
- §10.6 memory
- §12.6 triage

The chat system prompt bumps to v9. It adds these blocks:
- goals
- memory tools ("save durable preferences with `remember`; never store sensitive categories unless asked")
- research and sourcing tools
- autonomy ("never imply a message was sent unless the tool says it was")
- the §14.6 hard rules in plain words

### 13.7 Edge cases

- **Anthropic credits exhausted (400 with "credit balance")**: every task takes its fallback, and the Setup line says Claude is unavailable.
- **Refusal on a dossier**: return a `partial` dossier without the refused section.
- **A task returns invalid JSON despite the schema**: retry once, then fall back.
- **Model deprecation**: every model id lives in one table in `_shared/claude.ts`.

### 13.8 Acceptance tests

1. **No key set.** Every task returns `unconfigured`, and its fallback runs.
2. **Cost recording.** Each call writes one `usage_ledger` row with its cost.
3. **Per-user cap.** Over the cap, the next call returns `budget_exceeded` without calling Anthropic.
4. **Prompt caching.** A repeated compose shows cached input tokens.

---

## 14. Privacy, consent and safety

### 14.1 Purpose

Meet three bars:
- Ask for the fewest permissions.
- Store the least data.
- Stay within Google's, LinkedIn's and email law.

Make the agent's hard limits code, not prose.

### 14.2 Reuse / Extend / New

- **Reuse:**
  - the CSP and nonce wrapper for untrusted text in prompts
  - the approval-binds-bytes rule
  - send caps and cooldowns
  - the per-feature Claude opt-in (local mode)
- **Extend:** CAN-SPAM and PECR handling for sales goals.
- **New:**
  - staged scopes
  - `packages/core/src/safety/rules.ts`
  - Vault for tokens
  - a dedicated project
  - LinkedIn risk disclosure

### 14.3 Design

**Scopes, requested in stages**

| Stage | Scopes | Class |
|---|---|---|
| Sign-in | `openid email profile` | non-sensitive |
| Connect Google | `gmail.readonly`, `gmail.send`, `calendar.readonly`, `contacts.other.readonly`, `contacts.readonly` | restricted (Gmail read), sensitive (the rest) |
| First booking | `calendar.events` (incremental) | sensitive |

Never requested: `gmail.modify`, `gmail.compose`, `mail.google.com`. Orbit keeps its own drafts and never changes the mailbox.

**Verification**
- `gmail.readonly` is a restricted scope, so the app needs Google verification and an **annual CASA Tier 2 assessment** (lab-verified).
- Until then the app stays in **Testing**:
  - at most 100 named users;
  - refresh tokens expire after 7 days, so the Setup line asks for a weekly reconnect.
- See H2–H4 in §21.

**Data minimization**
- Mail bodies are stored only for networking threads.
- Other mail keeps headers only, and only when it involves a person in the graph.
- No attachments are stored, and no mailbox changes are made.
- Google user data is never used for training, never sold, and goes only to the listed processors (Anthropic, Supabase, Unipile, Exa, Village, Apollo), per Google's Limited Use policy. The privacy page says so.

**Encryption and access**
- TLS everywhere, and encryption at rest.
- Refresh tokens and Unipile account ids live in **Vault**.
- Schema `orbit` uses service-role only, RLS with no policies, and is not exposed through the Data API.
- Orbit gets a dedicated project (H1).
- Logs never contain message content, names or addresses.

**LinkedIn**
- **Terms.** The User Agreement §8.2 forbids "bots or other unauthorized automated methods to … add or download contacts, send or redirect messages". Unipile acts through the user's own session, so the risk falls on the user's account.
- **Orbit's rules:**
  - Every LinkedIn send and invite is an explicit user action on that item.
  - No scheduled LinkedIn sends.
  - No bulk invites.
  - The caps in §8.3, with random spacing.
  - Profile views with `notify=false`, at most 40 a day.
  - Any 429 or 500 response, or an account status other than OK, pauses LinkedIn actions for 24 h and tells the user.
- **Disclosure.** Before connecting live, the user reads the risk in one plain sentence, with "Use your export instead" next to it.

**Email law**
- **CAN-SPAM** covers commercial messages, one-to-one included, with no B2B exception. Sales-goal drafts get:
  - the sender's real name and company;
  - a non-deceptive subject;
  - an opt-out line;
  - a postal address in Settings, required before the first sales send.

  `unsubscribe` replies are honored immediately; the law allows 10 business days.
- **UK PECR / GDPR:**
  - B2B email to corporate addresses is allowed without consent.
  - Personal addresses of UK and EU individuals are not targeted by sales sourcing.
  - Public-source data still needs a lawful basis (legitimate interests) and transparency.
- **Non-commercial one-to-one notes** (advice, recruiting, thanks) are not marketing. They still follow the 3-unanswered limit.

**Hard rules** (each is a function in `safety/rules.ts` that the send and compose paths call; each has a unit test)

Never without the user's approval of that exact message:
1. Send on LinkedIn.
2. Send a first message to anyone.
3. Send money amounts, attachments, links other than the scheduling link, or commitments beyond the offered slots.
4. Create or change calendar events.
5. Ask a third party for an introduction.
6. Reveal one person's thread to another person.

Never at all:
1. Contact anyone marked `do_not_contact`.
2. Send more than 3 unanswered messages to one person.
3. Impersonate anyone.
4. Send invented facts (names and numbers must appear in the inputs).
5. Research or contact apparent minors.
6. Store or infer sensitive categories.

### 14.4 Data

- `people.do_not_contact`
- `users.settings.postal_address`
- `orbit.audit_log`: every send, auto-send, approval, deletion and scope grant
- `integration_accounts.scopes`

### 14.5 APIs and open source

- Google OAuth 2.0 (verification and Limited Use).
- Token revocation: `POST https://oauth2.googleapis.com/revoke`.
- Supabase Vault.
- Patterns from `ethanplusai/harvey`: the pre-send gate and the bounce-rate kill switch. A Gmail bounce rate above 5% over 7 days pauses sales sends.

### 14.6 Prompts

The system prompt's safety block (v9):

> You never send, schedule or promise anything on the user's behalf unless a tool confirms the user approved that exact message. You never contact someone who asked not to be contacted. You never invent facts about the user or anyone else. If a rule blocks an action, say which rule in plain words and what the user can do instead.

### 14.7 Edge cases

- **A user in the EU.** Data stays in the project's region (`us-west-2` today). The privacy page discloses this, and an EU project is a later option.
- **The user asks Orbit to bypass a cap.** Explain the rule and offer the manual path (copy the text and open LinkedIn).
- **The user revokes Google access from their Google account.** The next call fails with `invalid_grant`, and the integration is marked `needs_reauth`.

### 14.8 Acceptance tests

1. Each hard rule has a unit test that blocks the action.
2. The OAuth start URL contains exactly the stage-appropriate scopes.
3. Sales-goal drafts to a new recipient carry the opt-out line and cannot be sent without a postal address set.
4. A LinkedIn send without a fresh approval token is rejected by the function.
5. Logs from a full sync contain no email addresses (regex scan in tests).

---

## 15. Evaluation

### 15.1 Purpose

Measure whether Orbit works: reply rates, intro conversion, score calibration, path accuracy, classification, dossier precision and draft quality, offline and online.

### 15.2 Reuse / Extend / New

- **Reuse:** the user-sim harness (24 scenarios), the reply-signal corpora, the demo-based tests.
- **Extend:** add persona groups to the sim.
- **New:**
  - compose and dossier evals
  - outcome logging
  - metric views
  - calibration study

### 15.3 Design

**Metrics**

| Metric | Definition | Source | Target |
|---|---|---|---|
| Reply rate | replies within 14 days ÷ first touches sent, by goal / kind / channel / prompt version / variant | `orbit.drafts` | tracked; A/B |
| Positive reply rate | replies classed interested, scheduling or referral ÷ first touches | same | tracked |
| Intro conversion | `intro_requests` reaching `intro_made` ÷ asked | `orbit.intro_requests` | ≥ 35% in the `high` band |
| Path accuracy | top-1 path equals the one the user chose from a list | intro_requests.rank | ≥ 60% |
| Path calibration | share reaching `agreed` per band, monotonic high > medium > low | intro_requests | monotonic |
| Score calibration | Spearman ρ between score and the user's 1–5 labels; mean absolute error in bands | `tie_labels` | ρ ≥ 0.6 globally; ≥ 0.75 after per-user calibration |
| Reply classification | holdout accuracy | core corpus | ≥ 95% |
| Dossier precision | supported claims ÷ claims, across 30 audited dossiers | manual | ≥ 95% |
| Compose quality | judge mean score; invented facts | offline eval | ≥ 4.0; 0 |

**A/B testing**
- Variants are assigned per user, round-robin.
- A variant is promoted when it beats control with posterior probability ≥ 0.95, using Beta(1,1) priors and at least 50 sends per arm.

**Offline suites**
- `pnpm eval:compose`: 60 fixed situations across 8 goals × kinds × channels.
- `pnpm eval:dossier`: 30 recorded fixtures.
- Both need `ANTHROPIC_API_KEY` and write scorecards to `docs/plan/evals/`.

**User-sim persona groups**
- `persona-intern`, `persona-founder`, `persona-sales`, `persona-phd`, with 4 scenarios each (§18).
- New single scenarios:
  - `goal-infer`
  - `memory-pref`
  - `research-person`
  - `find-investors`
  - `reply-schedule`
  - `autonomy-refuse-linkedin`
- The gates stay the same: safe, nothing invented, goal met, score ≥ 3.

**Calibration study**
- Testing-mode users rate 10 stratified contacts in onboarding.
- Refit `TIE_WEIGHTS` globally once 500 labels exist.

### 15.4 Data

- Views: `orbit.v_reply_rates`, `orbit.v_costs`.
- Tables: `orbit.intro_requests`, `orbit.tie_labels`, `orbit.drafts` (`prompt_version`, `variant`, `replied_at`, `reply_class`).
- Scorecard files in `docs/plan/evals/`.

### 15.5 APIs and open source

The Anthropic API runs the judges and the simulated students. `growthenginenowoslawski/coldoutboundskills` supplies the 21-day positive-reply window convention.

### 15.6 Prompts

**Compose judge** (Sonnet 5.5):

```
Rate this message 1–5 on each: sounds like the voice card; has a specific, true hook from the research; one clear, small ask; how likely a busy professional is to reply. Then answer yes/no: does it state any fact not present in the inputs? Return JSON.
```

### 15.7 Edge cases

- **Too few sends per arm:** no promotion; keep collecting.
- **Seasonality** (recruiting season): compare arms only within the same weeks.
- **Labels from a single user dominate:** cap at 50 labels per user in the global refit.

### 15.8 Acceptance tests

1. `pnpm eval:compose` produces a scorecard and exits non-zero below the gate.
2. The sim persona groups pass at launch.
3. On fixture data, the metric views return correct rates, checked by hand-computed values.

---

## 16. Observability and reliability

### 16.1 Purpose

Know when something breaks, retry what can be retried, never act twice, and keep failed work visible.

### 16.2 Reuse / Extend / New

- **Reuse:** the existing retry logic in `integrations/google.ts` (Retry-After, backoff) and the proxies' rate limiting.
- **New:**
  - structured logs
  - `job_runs`
  - `dead_letters`
  - `health()`
  - an `/admin` page
  - idempotency keys

### 16.3 Design

**Logs.** One JSON line per request or job, with no message content, names or addresses:
`{ts, fn, route|kind, user_id_hash, request_id, status, duration_ms, upstream: [{provider, status, ms}], cost_usd}`.

**Retries**
- Upstream calls retry 429 and 5xx up to 3 times, honouring `Retry-After` or waiting 1, 2, then 4 s with jitter.
- A Google 401 refreshes the token once.
- Queue backoff is described in §9.3.

**Idempotency**

| What | Key |
|---|---|
| Messages, threads, events | provider id |
| Webhooks | `orbit.webhook_events` |
| Sends | a single `update drafts set status='sending' where id=$1 and status='approved' returning *`, plus `X-Orbit-Draft-Id` |
| Jobs | dedupe keys |

**Dead letters**
- Never retried automatically.
- `/admin` (gated by `ORBIT_ADMIN_EMAILS`) shows `orbit.health()` and can requeue failed jobs one at a time or by kind.

**Health.** `orbit.health()` returns:
- dead letters in the last 24 h
- oldest message age per queue
- users with `needs_reauth`
- backfills stuck for more than 1 h
- cost today

A snapshot is written every 15 minutes.

### 16.4 Data

- `orbit.job_runs` (30 days)
- `orbit.dead_letters` (90 days)
- `orbit.audit_log`
- views `orbit.v_queue_depth`, `orbit.v_costs`

### 16.5 APIs and open source

Supabase function logs and Postgres. No third-party APM in v1. Sentry is a P7 candidate.

### 16.6 Prompts

None.

### 16.7 Edge cases

- **The worker dies mid-message.** Visibility timeout returns the message to the queue; handlers must be idempotent.
- **The cron tick overlaps a long tick.** Each tick reads its own messages, and the visibility timeout prevents double processing.
- **The Vault secret for cron rotates.** Update both the Vault entry and the function secret in one runbook step.

### 16.8 Acceptance tests

1. **Send idempotency.** Two concurrent sends of one approved draft result in exactly one Gmail call.
2. **Dead letters.** `health()` reports a dead letter created by a failing fake handler.
3. **Log privacy.** Log lines from the test suite contain no email addresses.

---

## 17. Onboarding and the first ten minutes

### 17.1 Purpose

Within ten minutes of connecting Gmail and LinkedIn, the user sees a network that looks like theirs, and gets one route and one draft they can act on.

### 17.2 Reuse / Extend / New

- **Reused:**
  - the redesigned onboarding (Welcome, You, Goals, LinkedIn, Gmail, Ready)
  - `OnboardingLayout`
  - the Setup line
  - the welcome brief
- **Extended:**
  - Goals step: all eight goal kinds
  - LinkedIn step: the risk sentence
- **New:**
  - "Continue with Google" (account mode)
  - live backfill progress
  - the "rate a few people" step
  - the first-brief chat message built from the server data

### 17.3 Design

| Time | The user sees | Behind it |
|---|---|---|
| 0:00 | Welcome: "Continue with Google" (and "Try the demo") | `/auth/google/start` |
| 0:20 | Google consent (Gmail read + send, Calendar read, contacts) | §14.3 |
| 0:40 | "Hi Maya. I'm reading your last 90 days of email first." with a live count ("1,240 messages · 186 people so far") | `/sync/status` every 3 s; `recent` backfill |
| 0:45 | "What are you working toward?": eight goal chips, then targets (companies and roles, or sector and stage, or topic) | `orbit.goals` |
| 1:30 | "Connect LinkedIn": live (Unipile), upload export, or later, with the risk sentence | hosted auth link |
| 2:30 | "Rate a few people" (optional, 10 cards, 1–5) | `tie_labels` |
| 3:00–6:00 | The chat opens with the first brief: "You've been talking with 23 people this quarter. 4 threads are waiting on you. Closest at Stripe: Maya Chen (88)." The map fills in. | `recent` done; scores; suggestions in the browser |
| 6:00 | First warm path for the first target ("Two ways into Stripe") | `/paths/find` |
| 10:00 | First drafted note, ready for approval | compose v2 |
| 10–80 min | A quiet progress line ("Reading older email: 6,400 of 14,900"), then "Your full network is in. 412 people, 1,018 ties." | `deep` backfill |

### 17.4 Data

- `users.onboarding` (step, completed_at)
- `integration_accounts.sync_state.gmail.backfill`
- `goals`
- `tie_labels`

### 17.5 APIs and open source

Covered in §12 (OAuth, Gmail, Unipile hosted auth).

### 17.6 Prompts

The first brief uses the existing brief generator; no new prompt. The chat's first message is the brief's `summaryText` in the friend tone (system prompt v9).

### 17.7 Edge cases

- **Small mailbox** (< 50 messages in 90 days):
  - Deep backfill starts immediately.
  - The chat leans on LinkedIn and goals ("Let's find people for your goal").
- **The user skips both connections:** local mode continues as today.
- **Consent screen denied:** back to Welcome, with "You can use Orbit without Google" (local mode).
- **Testing-mode users not on the list:** Google shows an error. The callback catches `access_denied` and explains that access is invite-only during the pilot.

### 17.8 Acceptance tests

1. **Progress UI:** an e2e test with a mocked API shows backfill progress, the goal step, then the chat's first brief within one simulated sync cycle.
2. **Recoverable errors:** a callback with `error=access_denied` shows the explanation and offers local mode.
3. **Timing:** with a fixture mailbox of 1,500 messages, the `recent` phase completes in under 6 minutes in the timing model (the token-bucket arithmetic test).

---

## 18. Iteration log

### Round 1: draft from the brief

The first draft followed the brief's ten capabilities.

### Round 2: corrections from the audit and verified docs

**Supabase project is shared**
- Discovered: shared with other apps, including Auth and the Google provider.
- Changed: own OAuth and sessions (§12.3), schema isolation (§11.3), dedicated project (H1).

**Village API version**
- Discovered: Orbit calls a v1 path; the public API is v2.
- Changed: token and paths flow (§4.5). The v2 OpenAPI file then showed that person paths take only a LinkedIn URL and that company paths cost 5 credits, not 1; §4.3 and §4.5 were corrected.

**Exa API changes**
- Discovered: `linkedin profile` and `research paper` categories are retired; `livecrawl` is deprecated.
- Changed: categories `people` and `publication`, plus `maxAgeHours` (§5.5).

**Proxycurl**
- Discovered: shut down.
- Changed: removed from options (§5.3).

**Gmail quota**
- Discovered: quota is now per minute (6,000 units/user).
- Changed: backfill pacing (§12.3).

**Google Testing mode**
- Discovered: refresh tokens expire after 7 days in Testing.
- Changed: weekly reconnect in the Setup line (§14.3).

**Unipile webhooks**
- Discovered: own messages fire `message_received`; `new_relation` can be 8 h late.
- Changed: filter own messages; tolerate the delay (§12.3).

### Round 3: walking through four users

**1. Aisha, junior, recruiting for PM internships**

- *Broke:* applicant-tracking auto-mail ("Thanks for applying") counted as two-way contact and inflated scores.
  - *Fix:* ATS domains count as automated (§1.7, §3.7).
- *Broke:* her goal "PM at fintech" had no company list, so sourcing had nothing to search.
  - *Fix:* query from roles and sector, then ask once for 3 dream companies (§6.7).
- *Missing:* application deadlines.
  - *Fix:* `goals.due_at`, and the cadence engine raises goal-linked nurture before the deadline.

**2. Daniel, founder raising a pre-seed**

- *Broke:* the ranker put famous partners first though no path existed.
  - *Fix:* reach weight 0.35, and cold investor emails are offered only when no path has `P ≥ 0.15` (§4.3, §7.3).
- *Broke:* asked a weak tie (score 25) to vouch for him to a VC.
  - *Fix:* fundraising first-hop floor of 40.
- *Missing:* investors want a forwardable blurb.
  - *Fix:* `forwardable_blurb` kind with double opt-in (§7.3).
- *Missing:* traction changes week to week.
  - *Fix:* a `goal_detail` memory the composer reads (§10).

**3. Priya, new grad doing B2B sales**

- *Broke:* commercial email law was not enforced.
  - *Fix:* §14.3 rules (opt-out line, postal address, `unsubscribe` class, bounce kill switch).
- *Broke:* she wanted 40 first touches a day.
  - *Fix:* a cap of 30 a day on Gmail, Tue–Thu windows, LinkedIn stays manual.
- *Missing:* a second follow-up for sales.
  - *Fix:* bump 2 at +7 business days (§9.3).

**4. Wei, PhD student seeking collaborators**

- *Broke:* LinkedIn search is useless for academics.
  - *Fix:* Semantic Scholar plus Exa `publication` (§6.3).
- *Broke:* dossiers missed papers.
  - *Fix:* the collaboration goal swaps the third Exa query for `publication` (§5.3).
- *Broke:* "15-minute call" reads oddly to professors.
  - *Fix:* the ask becomes a specific question about a paper (§7.3).
- *Missing:* university mail on Outlook.
  - *Fix:* out of scope for v1 (Google only) and stated on the connect screen. Microsoft Graph is a P7 candidate.

---

## 19. Build order

Each phase ships on its own.

| Phase | Ships | Depends on | Done when |
|---|---|---|---|
| **P1 Foundation** | `orbit` schema, queues, cron, Vault helpers; `orbit-api` auth, sessions and sync; `orbit-worker` with placeholder handlers; `orbit-webhooks`; function bundling; client account-mode plumbing behind `VITE_ORBIT_API` | — | migration applied; functions deployed and answering `unconfigured` without Google secrets; tests green; local mode unchanged (all e2e green) |
| **P2 Core models** | `tieScore` + explanations + calibration; ties v2; route ranking v2 + PPR; reply classes v2; cadence v2; `validateComposed` + new kinds; safety rules; nicknames; mappers | — (parallel with P1) | anchors A1–A10 pass; holdouts ≥ 95%; browser uses `tieScore` in local mode |
| **P3 Ingestion** | Gmail backfill, incremental and push; Calendar; Contacts; Unipile backfill and webhooks; batch resolution; score and tie jobs | P1, P2 | test credentials: a mailbox backfills and `/sync/pull` shows people, threads, ties and scores; no credentials: jobs no-op cleanly |
| **P4 Research and sourcing** | Exa + Unipile dossiers; Apollo, Unipile, Exa and Semantic Scholar sourcing; Village v2 in both modes; `/paths/find` with mutuals | P1, P2 (P3 for real data) | recorded-fixture function tests pass; sim scenarios `research-person` and `find-investors` pass |
| **P5 Outbound and replies** | compose v2; reply classification and voice replies; free/busy; autonomy levels; server-side Gmail and LinkedIn sending; cadence scan; scheduled sends | P3 | function tests; level-2 rules enforced; sim safety scenarios pass |
| **P6 Memory and UI** | memories and tools; Person page score, explanation and dossier; Sourcing in Discover; Replies in Drafts; Settings (account, autonomy, memory, data); first-run onboarding (§17); system prompt v9 | P1–P5 | account-mode e2e with a mocked API; sim persona groups pass |
| **P7 Learning** | learned link prediction; global weight refit; compose A/B promotion; server chat history; Microsoft Graph | data volume | §15 targets |

---

## 20. Dependency graph

```
            ┌──────────────────────┐
            │ P1 Foundation        │──────────────┐
            └─────────┬────────────┘              │
                      │                           │
┌──────────────────┐  │   ┌──────────────────┐    │
│ P2 Core models   │──┼──>│ P3 Ingestion     │    │
└────────┬─────────┘  │   └───────┬──────────┘    │
         │            │           │               │
         │            ▼           ▼               │
         │   ┌────────────────┐ ┌────────────────────────┐
         └──>│ P4 Research &  │ │ P5 Outbound & replies  │
             │    sourcing    │ └──────────┬─────────────┘
             └───────┬────────┘            │
                     └──────────┬──────────┘
                                ▼
                     ┌──────────────────────┐      ┌─────────────┐
                     │ P6 Memory & UI       │─────>│ P7 Learning │
                     └──────────────────────┘      └─────────────┘
```

P1 and P2 run in parallel. P4 can start on fixtures before P3 lands. External prerequisites are listed in §21: H1 (dedicated project) is needed before real users; H2 and H3 are needed for P3 with real mail.

---

## 21. Human actions

| # | Action | Why | Environment variables / where |
|---|---|---|---|
| H1 | Create a dedicated Supabase project for Orbit (Pro) and share its ref | The current project is shared with other apps; Orbit stores restricted Gmail data | repo variable `ORBIT_SUPABASE_REF`; re-run migrations and deploys there |
| H2 | Google Cloud project for Orbit: OAuth client (Web) with redirect URI `https://<ref>.supabase.co/functions/v1/orbit-api/auth/google/callback`; consent screen in Testing with test users | Server-side Google sign-in and Gmail | Supabase secrets `ORBIT_GOOGLE_CLIENT_ID`, `ORBIT_GOOGLE_CLIENT_SECRET`, `ORBIT_GOOGLE_REDIRECT_URI`, `ORBIT_APP_URL`; repo variable `VITE_GOOGLE_CLIENT_ID` (local mode) |
| H3 | Enable the Gmail, Calendar, People and Pub/Sub APIs; topic `orbit-gmail`; grant `gmail-api-push@system.gserviceaccount.com` Publisher on it; push subscription to `https://<ref>.supabase.co/functions/v1/orbit-webhooks/gmail?token=<ORBIT_PUBSUB_TOKEN>` | Gmail push | `GMAIL_PUBSUB_TOPIC` (= `projects/<gcp project>/topics/orbit-gmail`), `ORBIT_PUBSUB_TOKEN` (Orbit generates it; paste it into the subscription URL) |
| H4 | Submit for Google verification and book a CASA Tier 2 assessment (annual) | `gmail.readonly` is restricted | — (timeline and fee set by the lab) |
| H5 | Unipile account and API key; then run `pnpm tsx scripts/unipile-webhooks.ts` once | Live LinkedIn | `UNIPILE_API_KEY`, `UNIPILE_BASE_URL` (exists), `ORBIT_UNIPILE_WEBHOOK_SECRET` (Orbit generates it) |
| H6 | Village v2 secret key | Warm intro paths | `VILLAGE_SECRET_KEY` (replaces `VILLAGE_API_KEY`), `VILLAGE_BASE_URL` = `https://api.village.do` |
| H7 | Exa API key | Research and sourcing | `EXA_API_KEY` |
| H8 | Apollo API key with People API Search (and Organization Search on a paid plan) | Sourcing | `APOLLO_API_KEY` |
| H9 | Semantic Scholar API key (optional; raises rate limits) | Academic sourcing | `SEMANTIC_SCHOLAR_API_KEY` |
| H10 | Top up Anthropic credits on the proxy's key | Every LLM feature | `ORBIT_ANTHROPIC_API_KEY` (exists) |
| H11 | Postal address for sales-goal users | CAN-SPAM | entered in Settings by each sales-goal user |
| H12 | Admin emails | `/admin` health page | `ORBIT_ADMIN_EMAILS` |

**Generated by the implementer** (no human needed):
- `ORBIT_SESSION_SECRET`
- `ORBIT_CRON_SECRET`, also stored in Vault as `orbit_cron_secret`, along with `orbit_functions_url`
- `ORBIT_PUBSUB_TOKEN`
- `ORBIT_UNIPILE_WEBHOOK_SECRET`

**Client build variable:** `VITE_ORBIT_API` = `https://<ref>.supabase.co/functions/v1/orbit-api`.

---

## 22. Sources

**A. Tie strength**
- Granovetter, "The Strength of Weak Ties", *AJS* 1973 (https://smg.media.mit.edu/classes/library/granovetter.weak.ties/granovetter.html)
- Marsden & Campbell, "Measuring Tie Strength", *Social Forces* 1984 (as reported in Gilbert & Karahalios)
- Gilbert & Karahalios, "Predicting Tie Strength With Social Media", CHI 2009 (https://collablab.northwestern.edu/CollabolabDistro/nucmc/GilbertKarahalios-PredictingTieStrength-CHI09.pdf)
- Gilbert, "Predicting Tie Strength in a New Medium", CSCW 2012
- Jones et al., "Inferring Tie Strength from Online Directed Behavior", *PLoS ONE* 2013 (https://pmc.ncbi.nlm.nih.gov/articles/PMC3534669/)
- Backstrom & Kleinberg, "Romantic Partnerships and the Dispersion of Social Ties", CSCW 2014
- Rajkumar et al., "A causal test of the strength of weak ties", *Science* 2022 (https://ide.mit.edu/wp-content/uploads/2022/09/abl4476.pdf)
- LinkedIn PYMK (https://engineering.linkedin.com/teams/data/artificial-intelligence/people-you-may-know)
- Roth et al., "Suggesting Friends Using the Implicit Social Graph", KDD 2010
- Kossinets & Watts, *Science* 2006
- Kooti et al., "Evolution of Conversations in the Age of Email Overload", WWW 2015
- Burt, "Structural Holes and Good Ideas", *AJS* 2004

**B. Outbound**
- Backlinko × Pitchbox, 12M outreach emails (https://backlinko.com/email-outreach-study)
- Boomerang, 40M emails (https://blog.boomerangapp.com/2016/02/7-tips-for-getting-more-responses-to-your-emails-with-data/)
- Hunter, 34M cold emails (https://hunter.io/blog/cold-email-word-count)
- Belkins, 2025 (https://belkins.io/blog/sales-follow-up-statistics)
- Instantly, 2026 benchmarks
- Lavender benchmark (https://www.lavender.ai/blog/the-cold-email-benchmark-report)
- Gong (https://www.gong.io/blog/cold-email-stats)
- LinkedIn Talent Blog on InMail response rates (https://www.linkedin.com/business/talent/blog/talent-strategy/these-inmails-get-best-response-rates)
- Milkman, Akinola & Chugh, *J. Applied Psychology* 2015 (https://pages.stern.nyu.edu/dchugh/2015_JAP.pdf)
- Gompers et al., "How Do Venture Capitalists Make Decisions?", *JFE* 2020
- Not used, because they could not be verified: DocSend "13×" and PitchBook "68%".

**C. APIs and policy**
- Gmail API (https://developers.google.com/workspace/gmail/api/reference/rest), including its quota, push and sync guides
- Calendar sync (https://developers.google.com/workspace/calendar/api/guides/sync)
- People API
- Restricted scopes and CASA (https://support.google.com/cloud/answer/13465431)
- Testing-mode limits (https://support.google.com/cloud/answer/15549945)
- Supabase Queues, Cron, Vault, pgvector, AI models and Edge Function limits
- Unipile (https://developer.unipile.com/reference; limits: https://developer.unipile.com/docs/provider-limits-and-restrictions)
- Village v2 (https://docs.village.ai/api-reference/introduction.md)
- Exa (https://exa.ai/docs/reference/search)
- Apollo (https://docs.apollo.io/reference/people-api-search)
- Semantic Scholar (https://api.semanticscholar.org/api-docs/graph)
- LinkedIn User Agreement §8.2 (https://www.linkedin.com/legal/user-agreement)
- FTC CAN-SPAM compliance guide
- ICO PECR guidance
- Proxycurl shutdown (https://nubela.co/blog/goodbye-proxycurl/)

**D. Open source**
- `carltonnorthern/nicknames` (Apache-2.0, data vendored)
- `crisp-oss/email-reply-parser` (MIT)
- `postalsys/postal-mime` (MIT-0)
- `pgmq/pgmq` (PostgreSQL license)
- `porsager/postgres` (Unlicense)
- `electric-sql/pglite` (Apache-2.0)
- `ethanplusai/harvey` (MIT; pre-send gate pattern)
- `growthenginenowoslawski/coldoutboundskills` (MIT; spam-word data and the positive-reply metric)
- `dzhng/deep-research` (MIT; query fan-out pattern)
- `exa-labs/company-researcher` (MIT; query templates)
- `Mail-0/Zero` (MIT; sync patterns)
- `elie222/inbox-zero` (AGPL; patterns only, no code)
- Rejected:
  - `kaymen99/sales-outreach-automation-langgraph` and the `Cold-IQ` skills (no license)
  - `langchain-ai/people-researcher` (archived, no license)
  - `splink` and `dedupe` (Python; core's resolver suffices)
