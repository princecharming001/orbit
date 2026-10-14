# 16. Orbit as a networking agent: infrastructure and capability plan

Status: **decided**. This document supersedes 02 (stack), 08 (jobs) and 09 (API) wherever they disagree. It was written to be implemented literally, one phase at a time (§17). Every number in it is a decision; where research informed the number, the source is cited in §20.

Audience: an implementer (human or LLM) working in this monorepo. Read §0 and §1 first, then the section for the capability you are building, then §11 (data), §12 (sync) and §13 (LLM).

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Where does the app run | The SPA stays on GitHub Pages (`apps/web`). Nothing about hosting the front end changes |
| Where does server work run | **Supabase only**: Postgres 17 + Edge Functions (Deno) + `pgmq` queues + `pg_cron` + `pg_net` + Vault + `pgvector`. No Next.js, no Inngest, no Redis, no separate worker host. 02/08/09's hosted stack is retired |
| Which Supabase project | The current project `nxibeiykcgxpbmkeadth` is **shared with other apps** (their tables, cron jobs, Auth users and Google provider all live there). Orbit's server data therefore lives in its own schema `orbit`, reachable only by Orbit's functions with the service role. **Before the first real user's mail is stored, Orbit moves to a dedicated Supabase project** (human action H1). All migrations are written to be replayed on the new project unchanged |
| Identity | **Orbit's own Google OAuth (authorization code + PKCE) run by the `orbit-api` function**, issuing Orbit session tokens (HS256 JWT, 1 h access, 30-day rotating refresh). Supabase Auth is not used: the shared project's Google provider belongs to another app, and an Orbit session must not be a valid session for the other apps' tables |
| Local-first or server | **Both, by mode.** *Local mode* (no account, today's app, the demo, all existing e2e) stays exactly as it is. *Account mode* (signed in with Google) makes Postgres the source of truth for everything ingested or computed in the background; Dexie becomes a cache filled by `/sync/pull`, and the existing browser engine keeps producing the brief and suggestions from that cache |
| What must move server-side | Anything that has to happen while the browser is closed or that needs a refresh token: Gmail/Calendar backfill and incremental sync, Gmail push, Unipile webhooks, reply classification, tie scores and edges for the whole graph, research dossiers, sourcing, scheduled sends, the cadence scan |
| Graph and scoring code | One implementation, in `@orbit/core` (pure TypeScript, no DOM). The browser imports it as today; Edge Functions import the **same files**, bundled by esbuild into each function (§12.7) |
| LLM | Anthropic only. Chat, drafting, replies in voice and research synthesis on `claude-opus-5-5`; bulk classification and extraction on `claude-haiku-5-5` (Batches API for backfill); the sim judge stays on `claude-sonnet-5-5`. Embeddings: Supabase's built-in `gte-small` (384 dims), no extra vendor (§13) |
| Web research | **Exa** (search with `category: people|company|news|publication`, then `/contents`), plus Unipile for LinkedIn profiles and posts, plus the user's own mail. Not Tavily, Perplexity, PDL or Clay (§5) |
| Sourcing | **Unipile LinkedIn search first** (warm, 2nd degree), **Apollo People API Search** (free, no emails) for firmographic filters, **Exa people** for semantic queries, **Semantic Scholar** for researchers. Not Crunchbase, Harmonic or PDL (§6) |
| Warm intros | Local graph (Yen's k-shortest paths over intro probabilities) merged with **Unipile mutual connections** and **Village API v2** paths; company targets use personalized PageRank to pick who to aim at (§4) |
| Sending | Gmail through `users.messages.send` (scope `gmail.send`); LinkedIn through Unipile chats. **LinkedIn is never sent without a per-message approval**, and Orbit never sends a connection request on its own (§8, §14) |
| Autonomy | Three levels: draft only (default), send after approval, auto-send within rules. Auto-send exists only for replies inside existing two-way Gmail threads (§8) |

---

## 1. Audit of the current stack, and what changes

Facts are from the code at `7d1fa4d` (`feat/chat-home` = `main`).

### 1.1 What exists

- **Storage**: Dexie (IndexedDB) with 30 tables (`apps/web/src/db/schema.ts:102-141`): users, settings, goals, targetCompanies, resumes, resumeFacets, organizations, people, affiliations, edges, touchpoints, threads, messages, events, chats, stageEvents, notes, facts, actionItems, outbound, suggestions, briefs, recommendations, feedback, notifications, audit, merges, integrations, styles, kv, chatConversations, chatMessages, chatActions. Types in `packages/core/src/types.ts`.
- **Google**: GIS token flow in the browser (`integrations/google.ts:144`), 1-hour token in `sessionStorage`, no refresh token. Scopes `gmail.readonly`, `gmail.send`, `calendar.events.readonly`. First sync reads 90 days (`engine/sync.ts:81`), at most 1,500 ids per query, `format=full`. No People API.
- **LinkedIn**: CSV/ZIP import (`engine/linkedin.ts`); Unipile through `orbit-connectors` (hosted auth link, relations, mutuals via `linkedin/search` with `connections_of`, disconnect); Village through `orbit-connectors` calling `POST /v1/paths` (**wrong: Village's public API is v2**, §4).
- **Strength**: `packages/core/src/scoring/strength.ts`, a 0–1 decayed-touch formula (90-day half-life), tiers strong ≥ 0.6, medium ≥ 0.3.
- **Edges**: `packages/core/src/graph/edges.ts` infers co_tenure, same_school_cohort, email_cothread, meeting_coattendee, introduced_by, same_current_company. Unipile mutuals and Village paths are shown in panels but **never written to the graph**.
- **Paths**: `packages/core/src/graph/paths.ts`, Dijkstra with cost `−ln w`, Yen's k-shortest, max 3 hops; score = product of weights.
- **Drafts**: template engine `packages/core/src/drafts` (10 kinds, word limits, banned phrases, validator, corpus); optional Claude rewrite that must pass the validator; style card from sent mail.
- **Pipeline**: stages identified → warming → outreach_sent → replied → scheduling → scheduled → completed → followed_up → nurturing (+ declined, no_response, archived); went-quiet after 7 days; bumps at 5/8 business days (Gmail) and 10/12 (LinkedIn).
- **Chat agent**: 69 tools (`apps/web/src/chat/tools/*`), system prompt v8, `claude-opus-5-5` through the user's key or the shared `orbit-claude` proxy; snapshot of 400–700 tokens per turn; no long-term memory.
- **Server**: `orbit-claude` (Claude proxy, per-IP limits), `orbit-connectors` (Unipile/Village proxy). One migration (`orbit_proxy_counters`, `orbit_private.secrets`). No accounts.
- **Tests**: ~660 web unit, ~459 core, ~174 e2e, a 24-scenario user-sim (student + judge).

### 1.2 What is re-architected

1. **Identity.** Today a user is a local Dexie row. Account mode adds `orbit.users` keyed by Google `sub`, with Orbit sessions (§11.2, §12.1).
2. **Google tokens move to the server.** The browser token flow cannot run a backfill of years of mail, cannot be woken by Gmail push, and expires hourly. In account mode the refresh token lives in Vault and every Gmail/Calendar call is made by an Edge Function. Local mode keeps the GIS flow.
3. **Ingestion moves to the server** in account mode (§12). The browser's `engine/ingest.ts` logic is split: the pure parts (participant extraction, automated-mail filters, triage, signals) are already in core and are called from the function; the Dexie writes become SQL upserts.
4. **Background jobs** become `pgmq` queues drained by one `orbit-worker` function, ticked by `pg_cron` every minute (§9). The browser timers (`OutboxScheduler`, `dailyMaintenance`) remain for local mode only.
5. **The graph becomes multi-source** (§2): mutuals and Village paths are written as ties with a source and a confidence, and every tie carries evidence.
6. **Strength becomes a 0–100 explainable score** (§3). The old 0–1 `strength` is kept, as `score / 100`, so the map, Reach and recommendations keep working unchanged.
7. **Drafting gains goals beyond recruiting** (fundraising, sales, hiring, advice, co-founder, community, collaboration) (§7), and replies get classified and answered (§8).
8. **Memory**: a server `memories` table with pgvector, plus `remember`/`recall`/`forget` tools (§10).

### 1.3 Reuse / extend / new, per capability

| # | Capability | Reused | Extended | New |
|---|---|---|---|---|
| 1 | Identity and context graph | core entity resolution, people/affiliations types, resume parser, LinkedIn CSV | resolution gains nicknames and identity rows; goals become multi-goal | server schema, Orbit accounts, Gmail/Calendar/Unipile server ingestion |
| 2 | Network map | `inferEdges`, noisy-OR pair weights, map renderer | per-kind confidence; mutual/Village/cc/directed-email kinds; decay | `orbit.ties` with evidence; incremental + nightly recompute |
| 3 | Strength 0–100 | touchpoint kinds | — | `scoreTie` (logistic over 14 features), explanations, per-user calibration |
| 4 | Warm paths | Yen's k-shortest in core | hop probabilities replace raw weights | intro-willingness model, PPR for companies, Village v2 + mutual merge, reasons |
| 5 | Deep research | person facts, `summary`, `talkingPoints` | — | Exa + Unipile profile research, dossiers with citations, cost caps |
| 6 | Sourcing | `recommendations` table and Discover page | — | Unipile search, Apollo search, Exa people, Semantic Scholar, ranking, pipeline flow |
| 7 | Outbound | template engine, validator, corpus, style card, playbook (15) | 7 new goal families, evidence rules, forwardable intro blurb | composer v2 prompt, outcome tracking, A/B evaluation |
| 8 | Replies | reply-signal classifier (95% holdout), extraction, send | classes mapped to 10 reply classes; LLM for low confidence | voice drafting with retrieved own replies, freebusy slots, autonomy levels |
| 9 | Cadence | bump/quiet/thank-you rules, stage machine | runs server-side on a schedule; nurture by tie importance | `cadence_scan`, scheduled sends |
| 10 | Pipeline and memory | chats, stage events, notes, facts | goal per chat | `memories` (pgvector), memory tools, retention jobs |

---

## 2. Identity and context graph (capability 1)

**Purpose.** One persistent model of who the user is, who they know, how, and what they want, built from Gmail (mail, threads, contacts, calendar), LinkedIn (connections, messages, profile via Unipile) and uploads (resume, notes), kept current from conversation.

**Reuse / Extend / New.** Reuse `resolveIdentity` (`packages/core/src/entity/resolve.ts:345`) and its thresholds (auto-merge 0.92, suggest 0.6), the resume parser, the CSV parser, `MergeSuggestion`. Extend resolution with a nickname table and per-identity rows. New: `orbit.users`, `orbit.person_identities`, `orbit.goals` with kinds, server ingestion (§12).

### 2.1 Design

- **The user is a person.** `orbit.people` has exactly one row with `is_self = true` per user; it holds the user's own emails and LinkedIn member id as identities, which is how "sent by me" is decided for every provider.
- **People are resolved, not duplicated.** Every incoming address/profile goes through `resolveIdentity` with these blocking keys, in order: exact email (normalized: lower-case, Gmail dots and `+tag` removed for gmail.com/googlemail.com), exact LinkedIn member id, exact LinkedIn slug, `name_norm + org_id`, `first_name_variant + last_name + email_local_part`. Name variants come from `carltonnorthern/nicknames` (Apache-2.0; vendor `names.csv` into `packages/core/src/entity/nicknames.csv` with its LICENSE notice; load into a `Map<string, Set<string>>` at module init). A nickname match adds the feature `firstNameVariant = 1` to `ResolveFeatures`.
- **Decisions**: score ≥ 0.92 → merge into the candidate and add the identity row; 0.6–0.92 → create the person and a `merge_suggestions` row the user confirms in chat ("Is Liz Chen the same as Elizabeth Chen at Stripe?"); < 0.6 → new person. A user's "not the same" answer writes a `do_not_merge` pair that resolution respects forever.
- **Context about the user** (`orbit.users` + the self person + `orbit.goals` + resume facets + memories) is what every prompt reads through one function, `buildUserContext(userId)`, which returns at most 1,200 tokens: name, school/grad year, current role, active goals with targets, top 5 resume facets, 10 most important memories (§10).
- **Goals.** A user has 0–5 active goals. `kind ∈ {recruiting, fundraising, sales, hiring, advice, cofounder, community, collaboration}`. Each goal has `targets` (organizations, roles, geographies, people), `success_metric` (e.g. "8 coffee chats with PMs by Dec 1"), `priority 1–3`, `status active|paused|done`. Goals are created in onboarding, by the chat tool `set_goal`, or proposed by the agent from conversation (the agent must ask "Want me to track this as a goal?" before saving an inferred goal; `source = inferred` is saved only after a yes). Every chat (pipeline card) and draft carries a `goal_id`.

### 2.2 Data

Tables `orbit.users`, `orbit.people`, `orbit.person_identities`, `orbit.organizations`, `orbit.affiliations`, `orbit.goals`, `orbit.merge_suggestions`, `orbit.do_not_merge` (§11.3).

### 2.3 APIs and open source

- Gmail API v1 `messages.list`, `messages.get` (`format=metadata`), `threads.get` (`format=full`), `history.list`, `watch` (§12.2).
- Calendar API v3 `events.list` with `syncToken` (§12.3).
- People API `GET https://people.googleapis.com/v1/otherContacts?readMask=names,emailAddresses&pageSize=1000` (scope `contacts.other.readonly`) and `GET /v1/people/me/connections?personFields=names,emailAddresses,organizations&pageSize=1000` (scope `contacts.readonly`): only names and emails, used to name people whose mail headers carry no display name.
- Unipile `GET /api/v1/users/relations`, `GET /api/v1/users/{id}?linkedin_sections=*`, `GET /api/v1/users/me`, chats and messages (§12.4).
- `carltonnorthern/nicknames` (https://github.com/carltonnorthern/nicknames), `postal-mime` (https://github.com/postalsys/postal-mime, MIT-0) for MIME parsing and `addressParser`, `email-reply-parser` (https://github.com/crisp-oss/email-reply-parser, MIT) for stripping quotes before classification and voice learning.

### 2.4 Prompts

Goal inference (Haiku 5.5, structured output, run after a chat turn that mentions plans):

```
System: You extract networking goals from a conversation with a student or early-career professional.
Return only goals the user states or clearly implies for themselves. Do not invent targets.
kind is one of recruiting, fundraising, sales, hiring, advice, cofounder, community, collaboration.
If nothing new is stated, return {"goals": []}.
User: <existing_goals>{json}</existing_goals>
<conversation>{last 6 turns}</conversation>
```
Schema: `{goals: [{kind, title (≤ 60 chars), targets: {organizations: string[], roles: string[], geographies: string[], people: string[]}, success_metric: string|null, is_update_of: goal_id|null, quote: string}]}`. `quote` must be a substring of the user's words; drop any goal whose quote is not found.

### 2.5 Edge cases

- Shared inboxes and role addresses (`recruiting@`, `noreply@`, `team@`): never become people (existing automated filters + a role-local-part list: `info, hello, team, support, careers, recruiting, jobs, noreply, no-reply, notifications, billing, admin, contact`).
- The user's own aliases (send-as addresses): read from `GET /gmail/v1/users/me/settings/sendAs` (scope `gmail.readonly` covers it) at connect time and attached to the self person.
- Two people with the same name at the same company: never auto-merge without an email or member-id match (cap the score at 0.85 when only name and org match).
- Name in headers is "Last, First": already handled in core; keep the test.
- A person changes jobs: affiliations are appended (`is_current` flips), never overwritten; `people.org_id` follows the current one.

### 2.6 Acceptance tests

1. Given a Gmail message from `Liz.Chen+jobs@gmail.com` and a LinkedIn relation "Elizabeth Chen, Stripe" that is later seen in a calendar invite with `lizchen@gmail.com`, resolution produces one person with three identities (core unit test with fixtures).
2. `do_not_merge` pairs are never merged even when score ≥ 0.92.
3. A goal stated in chat ("I'm raising a pre-seed for my climate startup in January") yields one proposed goal of kind `fundraising`, saved only after the user agrees (sim scenario `goal-infer`).
4. `buildUserContext` never exceeds 1,200 tokens (count with `messages.count_tokens` in an integration test against a fixture user with 5 goals and 50 memories).

---

## 3. Relationship strength, 0 to 100 (capability 3)

**Purpose.** A per-contact score that is explainable, decays with time, and can be calibrated to the user's own sense of closeness.

**Reuse / Extend / New.** Reuse touchpoint kinds and the existing data. New `scoreTie` in `packages/core/src/scoring/tieScore.ts`; the old `computeStrength` stays for local mode until account mode is the default, and `people.strength = score / 100` in both.

### 3.1 Research basis (§20 A)

- Tie strength combines time, emotional intensity, intimacy and reciprocal services (Granovetter 1973).
- The best single predictors in Gilbert & Karahalios (2009) were **days since last communication (β −0.76)** and **days since first communication (β +0.755)**, then words exchanged, the mean strength of mutual friends (+0.257) and intimacy; their linear model on log features reached 87% strong/weak accuracy. "Communicating once leads to a very large movement in tie strength."
- Simple sums of directed interactions already reach AUC 0.90 (Jones et al. 2013); private messages are no better than public ones.
- Email ties should require reciprocity (Kossinets & Watts 2006: one message each way within 60 days) and weight outgoing above incoming (Roth et al. 2010).
- For job help, the *weaker* ties by interaction and ties with ≤ 10 mutual connections were the most useful (Rajkumar et al. 2022). The score therefore measures closeness, and §4 uses closeness only as one input to "will they help", not as the goal itself.

### 3.2 Features (computed per user–person pair)

All counts exclude automated mail, mailing lists (`List-Unsubscribe` or `Precedence: bulk|list`) and threads with more than 8 participants.

| id | Feature | Definition |
|---|---|---|
| f1 | `log_days_last` | ln(1 + days since the last *two-way* exchange; if never two-way, days since the last contact of any kind; if never any contact, 0 and `never` = 1) |
| f2 | `log_days_first` | ln(1 + days since the first contact of any kind) (0 if never) |
| f3 | `log_out` | ln(1 + messages the user sent them, decayed with a 365-day half-life) across email and LinkedIn |
| f4 | `log_in` | ln(1 + messages they sent the user, same decay) |
| f5 | `reciprocity` | min(in, out) / max(in, out) over undecayed 2-year counts (0 when either is 0) |
| f6 | `log_meetings` | ln(1 + Σ meetings in 2 years, weight 1 for ≤ 4 attendees, 0.3 for 5–8, 0 above) |
| f7 | `log_threads` | ln(1 + distinct two-way threads with ≤ 3 participants) |
| f8 | `latency` | 1 − min(1, ln(1 + median hours they took to reply) / ln(169)); 0 if they never replied |
| f9 | `intros` | min(2, introductions between them and the user, either direction) |
| f10 | `shared` | min(2, same school + overlapping employer + same current city × 0.5) |
| f11 | `structural` | mean score/100 of their top 5 mutual contacts (previous nightly run; 0 on the first) |
| f12 | `linkedin` | 1 if LinkedIn-connected, else 0 |
| f13 | `warmth` | mean `warmth` from note extractions about them, in [−1, 1] (0 if none) |
| f14 | `never` | 1 if there has never been any message or meeting, else 0 |

### 3.3 Model

```
z = b + Σ w_i · f_i
score = round(100 · 1 / (1 + e^(−z)))
if in == 0 and out > 0: score = min(score, 20)            # unreciprocated cap (Kossinets & Watts)
if user label exists: score = calibrated (§3.5)
```

Starting weights (the implementer fits the final values to the anchors in §3.7 by least squares on logit targets, then freezes them as constants with the fit's residuals in a comment):

| term | w |
|---|---|
| b | −2.4 |
| f1 `log_days_last` | −0.40 |
| f2 `log_days_first` | +0.40 |
| f3 `log_out` | +0.35 |
| f4 `log_in` | +0.75 |
| f5 `reciprocity` | +0.60 |
| f6 `log_meetings` | +1.00 |
| f7 `log_threads` | +0.50 |
| f8 `latency` | +0.40 |
| f9 `intros` | +0.50 |
| f10 `shared` | +0.45 |
| f11 `structural` | +0.80 |
| f12 `linkedin` | +0.55 |
| f13 `warmth` | +0.50 |
| f14 `never` | −0.30 |

Model version string: `tie-v1`. Weights live in `TIE_WEIGHTS` in `tieScore.ts`.

**Decay** is built in: f1 grows as time passes and f3/f4 are decayed, so a score recomputed nightly falls without new contact. A former close tie two years dormant lands around 40, not 0, because f2, f6, f7, f9 keep it up (the "dormant tie" users want to re-engage, §7).

**Bands**: 0–19 Faint, 20–39 Light, 40–59 Warm, 60–79 Strong, 80–100 Close. Mapping to the old tiers for the map: Close/Strong → strong, Warm → medium, else weak.

### 3.4 Explanation

`explainTie(features, weights)` returns contributions `c_i = w_i · f_i` (relative to the population mean feature value, stored as `TIE_BASELINE`), then the top three positive and the top one negative as sentences, each built from the raw count rather than the log value:

| feature | positive sentence | negative sentence |
|---|---|---|
| f1 | — | "Last real exchange was {n} months ago" |
| f3+f4 | "{in + out} messages between you ({in} from them)" | "Mostly one-way: {out} sent, {in} back" |
| f6 | "{n} meetings in the last 2 years" | — |
| f9 | "{name} introduced you to someone" / "You introduced them to someone" | — |
| f10 | "You both went to {school}" / "You overlapped at {org} ({years})" | — |
| f11 | "Close with people you're close to ({names})" | — |
| f12 | "Connected on LinkedIn" | "Connected on LinkedIn, never talked" (when f14 = 1) |
| f8 | "Usually replies within {h} hours" | "Takes about {d} days to reply" |

The person page shows `78 · Strong` with the sentences under it and a "Not right?" control (§3.5). The chat tool `explain_score` returns the same object.

### 3.5 Calibration with the user's own labels

- In onboarding (optional, skippable) and whenever the user taps "Not right?", the user rates closeness 1–5 ("barely know" … "very close"). Stored in `orbit.tie_labels`.
- With ≥ 8 labels, fit per-user Platt parameters `(a, c)` minimizing Σ(σ(a·z + c) − (label − 1)/4)² + 0.5·((a − 1)² + c²) (ridge toward the global model), by 200 steps of gradient descent; store in `users.settings.tie_calibration`. Score = round(100·σ(a·z + c)).
- A labelled person's displayed score is the label's band midpoint (10, 30, 50, 70, 90) until new contact happens, so the user's correction sticks.

### 3.6 Data

`orbit.tie_scores (user_id, person_id, score, band, features jsonb, contributions jsonb, explanation text[], model_version, computed_at)` and `orbit.tie_labels`. Recomputed: for the people in a thread when a message lands (worker job `score.person`), and for everyone nightly (`score.user`).

### 3.7 Acceptance tests (anchors; core unit tests on synthetic touch histories)

| Anchor | History | Expected score |
|---|---|---|
| A1 | LinkedIn-connected 300 days ago, nothing else | 8–15 |
| A2 | One cold email out 10 days ago, no reply, not connected | 3–10 |
| A3 | One two-way thread 14 days ago (2 out, 1 in) | 30–45 |
| A4 | Weekly two-way email for 6 months, 3 1:1 meetings, last contact 3 days ago | 85–95 |
| A5 | A4's history but everything ended 2 years ago | 35–55 |
| A6 | 10 out, 0 in over 6 months | ≤ 20 |
| A7 | One 1:1 meeting 30 days ago + thank-you exchange | 45–60 |
| A8 | Same school and cohort, LinkedIn-connected, never talked | 15–25 |
| A9 | Monotonic: adding one inbound reply never lowers a score; 30 more days of silence never raises it |
| A10 | With 8 labels all "very close" on people scoring ~40, calibrated scores for those people move above 75 |

Offline calibration eval in §15.

---

## 4. Network map and warm path finding (capabilities 2 and 4)

### 4.1 Ties between other people (capability 2)

**Purpose.** Know who among the user's contacts know each other, with evidence and confidence, so routes can pass through them.

**Reuse / Extend / New.** Reuse `inferEdges` and `combinedPairWeights` (`packages/core/src/graph/edges.ts`). Extend each kind with a confidence and add five kinds. New table `orbit.ties` with evidence.

**Edge kinds** (`a_person_id < b_person_id`; the user's own ties are `tie_scores`, not rows here):

| kind | Evidence | weight w | confidence c |
|---|---|---|---|
| `email_exchange` | A and B both *sent* messages in the same thread (≤ 8 participants) | 0.6 + 0.1·(threads − 1), max 0.9 | 0.95 |
| `email_cc` | A sent a message with B in To/Cc (≤ 8 recipients) | 0.45 + 0.05·(messages − 1), max 0.7 | 0.85 |
| `email_cothread` | Both only *received* on the same thread (≤ 8) | min(0.5, 0.3 + 0.1·(threads − 1)) | 0.5 |
| `meeting_coattendee` | Both attendees of an event with ≤ 8 attendees, both not declined | min(0.9, 0.6 + 0.1·(events − 1)) | 0.8 |
| `introduced_by` | A introduced B (or B to A) in a thread the user is on | 0.85 | 0.95 |
| `linkedin_mutual` | B is in Unipile's `connections_of: [A]` search for A (or vice versa) | 0.3 | 0.95 |
| `village_path` | Village returned A as an introducer to B with warmth v | v | 0.7 |
| `co_tenure` | Overlapping stints at one organization | existing formula | 0.3 + 0.05·overlap months, max 0.8; × 0.5 if org size bucket ≥ 5,000; × 0.6 if the overlap ended > 10 years ago |
| `same_school_cohort` | Same school, overlapping years | existing 0.3 / 0.15 / 0.12 | 0.4 overlap / 0.25 within two years / 0.1 same school |
| `same_current_company` | Both currently at one org, dates unknown | 0.35·size factor | 0.35 (× 0.5 at ≥ 5,000) |

Pair combination (unchanged noisy-OR, now confidence-weighted):
`w_pair = 1 − Π_k (1 − w_k · c_k)`, `c_pair = 1 − Π_k (1 − c_k)`.
A pair is usable in routing only if `c_pair ≥ 0.5`, or it has an `email_exchange`, `email_cc`, `meeting_coattendee`, `introduced_by` or `linkedin_mutual` row. Interaction kinds decay: `w_k × 0.5^(years since last evidence / 2)`.

**Freshness.** On every new message or event the worker updates the pairs inside that thread/event (`ties.upsert_from_thread`). Nightly `score.user` rebuilds affiliation-based kinds. Mutuals are fetched lazily when a route to a target is requested and cached on the tie for 30 days (`last_seen_at`). A Unipile `new_relation` webhook adds the user's own tie and queues a mutual refresh only if that person is at a target organization.

**Map.** The existing renderer (`components/orbitScene.ts`) keeps its ring layout; it reads `tie_scores` (via `people.strength`) and the pair weights from `ties` exactly as it reads `edges` today. The round-two style chosen by the founder from https://claude.ai/artifact/MXPg8shmMnowfX5QsSzAtT is a separate visual task and is not blocked by this plan.

### 4.2 Warm path finding (capability 4)

**Purpose.** Given a target person or company, return the best routes, ranked by the chance the intro actually happens, each with a plain reason and a confidence.

**Algorithm choice.**

| Candidate | Verdict |
|---|---|
| Weighted Dijkstra / **Yen's k-shortest paths** over `−ln p` | **Chosen for person targets.** Already in core, exact, fast at user scale (≤ 20k nodes), and the product of hop probabilities is the quantity we want |
| **Personalized PageRank** from the user | **Chosen for company targets**, only to choose *which* people at the company to aim at when the user names no one; then Yen's runs per chosen person |
| Max-flow / bottleneck paths | Rejected as the ranker: it measures redundancy, not the best single intro. Used only as a feature: the count of first-hop-disjoint routes ("2 other ways in") |
| Learned link prediction | Deferred to Phase 7 (§17), once ≥ 200 logged intro outcomes exist (`orbit.intro_requests`); then a logistic regression over the same hop features replaces the hand-set willingness weights |

**Hop probabilities.**

- First hop, user → A (A must be someone the user can ask): `p_ask(A) = σ(−2.0 + 4.0·S_A/100 + 0.8·reciprocity_A + 0.6·[A introduced the user before] + 0.3·[A shares an active goal's target org] − 0.7·[the user asked A for an intro in the last 30 days] − 0.5·[the user owes A a reply])`, where `S_A` is A's tie score.
- Hop A → B between two other people: `p_know(A, B) = w_pair · c_pair` (§4.1); for a mutual-only pair 0.3 × 0.95; for a Village edge `warmth × 0.7`.
- Target receptivity (last hop into T): `r_T = 1 + 0.15·[T is an alum of the user's school] + 0.1·[T's seniority ≤ manager] − 0.15·[T is C-level or partner]` (from title keywords), capped to [0.7, 1.3].
- Path success: `P = p_ask(A) · Π p_know · r_T · 0.85^(hops − 2)` for hops ≥ 2 (a direct tie has `P = p_reply(T)` from the existing `responsePrior`). Evidence older than 3 years on any hop: × 0.7.
- Goal adjustment: for `fundraising` require the first hop to have score ≥ 40 (cold-intro asks to weak ties are worse than none for VCs, §20 B4); for `recruiting` and `advice` allow first-hop score ≥ 20.

**Procedure for a person target T.**
1. Resolve T to a local person if possible (§2).
2. Local: Yen's k = 12, max 3 hops, edge cost `−ln p` (first-hop edges use `p_ask`, others `p_know`).
3. Unipile mutuals (account mode, LinkedIn connected, T has a member id): `POST {UNIPILE}/api/v1/linkedin/search?account_id=` body `{"api":"classic","category":"people","network_distance":[1],"connections_of":["<T member id>"]}` → each result M (resolved to a local person) yields a 2-hop candidate user → M → T with a `linkedin_mutual` tie written to `orbit.ties`. At most one call per target per 30 days (cached).
4. Village (if `VILLAGE_SECRET_KEY` is set): token from `POST https://api.village.do/v2/auth/tokens` (header `secret-key`, body `{external_user_id: <orbit user id>, email}`), cached 50 minutes in memory; then `POST https://api.village.do/v2/people/paths` with `{linkedin_url}` (or `{name, company}`) → introducers with warmth → `village_path` ties. Costs 5 credits ($0.10) per person; capped per user (§13.5).
5. Merge candidates by first-hop person, compute `P`, keep the best path per first-hop person, keep at most 2 paths that share a middle person, sort by `P`, return the top 5.
6. Confidence band: high `P ≥ 0.35`, medium `0.15–0.35`, low `< 0.15`. With no path above 0.05, return `{paths: [], fallback: "cold"}` and the chat offers a cold note instead.

**Procedure for a company target C.**
1. People at C in the graph (current affiliation) → if ≤ 10, run the person procedure on each.
2. Otherwise run PPR from the user (restart α = 0.15, 30 power iterations, transition weights `p_know` / `p_ask`, implemented in `packages/core/src/graph/ppr.ts`, O(iterations × edges)) and take the 10 people at C with the highest PPR mass, then the person procedure for each.
3. Village `POST /v2/companies/paths` with `{domain}` (1 credit) adds introducers.
4. Return the 5 best (target, path) pairs, at most 2 per target.

**Reason text** (deterministic template, no LLM): `"{A} ({band} · {score}) {evidence of A→B} {evidence of B→T}."` Evidence phrases come from the strongest tie kind on each hop: `email_exchange` → "emails with {B}", `meeting_coattendee` → "met {B} ({month year})", `co_tenure` → "worked with {B} at {org} ({years})", `linkedin_mutual` → "is connected to {B} on LinkedIn", `village_path` → "knows {B} (via Village)", `introduced_by` → "introduced you to {B}". Then "{n} other ways in" when disjoint routes exist.

**Data.** `orbit.ties`, `orbit.tie_scores`, `orbit.intro_requests` (logs every path the user acted on: asked → agreed/declined/intro_made/meeting/no_response, with the path and its `P`).

**APIs.** Unipile `POST /api/v1/linkedin/search` (above); Village v2 `POST /v2/auth/tokens`, `POST /v2/people/paths`, `POST /v2/companies/paths`. The existing `orbit-connectors` Village call (`POST /v1/paths`) is replaced by the v2 calls in both local and account modes.

**Open source.** Yen's and Dijkstra stay hand-written in core (graphology has no k-shortest-paths and the core implementation is already tested); `graphology-metrics` is not added.

**Edge cases.** Target is already a direct tie (return "You know them" with their score and skip routing); the target's member id is unknown (skip mutuals, say so in the reasons); first hop is a family member or a professor (`relationship_type` set) — allowed; intermediaries the user hid are excluded; a route through someone who declined an intro request in the last 90 days is dropped.

**Acceptance tests.**
1. Core: on the demo graph, the path to "Priya Ahmed" ranks the route through a 2-way-thread mutual above one through a same-company-only pair.
2. Core: `p_ask` is monotonic in the score and lower when an intro was asked in the last 30 days.
3. Core: PPR on a star graph returns the hub first; mass sums to 1 ± 1e-6.
4. Function test (mock Unipile/Village): mutuals and Village introducers appear as candidates, are written to `orbit.ties` with the right kind/confidence, and a second request within 30 days makes no upstream call.
5. Path accuracy eval (§15): top-1 route agrees with the route the user picks ≥ 60% on the labelled set.

---

## 5. Deep research on a person (capability 5)

**Purpose.** Before any outreach, a short, cited profile of the person tuned to the user's goal: who they are, what they work on, what they said publicly, shared ground with the user, and 3 opening hooks.

**Reuse / Extend / New.** Reuse `people.summary`, `talkingPoints`, person facts. New: `orbit-api /research/*`, worker job `enrich.dossier`, `orbit.dossiers`, `orbit.research_cache`.

### 5.1 Provider choice

| Provider | Decision | Why |
|---|---|---|
| **Exa** | **Chosen** for public web | One API with a `people` category, `news`, `company`, `publication`, plus `/contents` (text/highlights) in one bill; $7/1k searches and $1/1k pages |
| **Unipile** `GET /users/{id}` + `/users/{id}/posts` | **Chosen** for LinkedIn | Already connected; returns experience/education/about and recent posts through the user's own account; ~100 profile views/day guidance → Orbit caps at 40/day |
| User's own mail and notes | **Chosen**, always first | Most specific source, free, private |
| Tavily, Perplexity Sonar | Not chosen | Generic web search without a people category; Exa covers the need |
| Apollo | Not for research | Used for sourcing only (§6); its records are firmographic, not narrative |
| PDL, Clay | Not chosen | $0.28/record (PDL) or a workflow tool (Clay); no unique data for this use |
| Proxycurl | Not available | Shut down 2025-07-04 after LinkedIn's lawsuit |
| Claude `web_search` server tool | Fallback only | Used if `EXA_API_KEY` is missing |

### 5.2 Pipeline (`enrich.dossier` job, budget ≤ $0.25 per dossier)

1. **Internal** (no cost): last 20 messages with the person (bodies stripped of quotes), notes, facts, calendar events, previous dossier.
2. **LinkedIn** (if connected, member id known, and the daily cap allows): `GET /api/v1/users/{member_id}?account_id=&linkedin_sections=*_preview,experience,education,about` and `GET /api/v1/users/{member_id}/posts?account_id=&limit=10`. `notify` stays false.
3. **Exa search**, three queries in parallel, `type: "auto"`, `numResults: 5`, `contents: {highlights: {query: "<goal-specific question>", maxCharacters: 1200}}`:
   - `category: "people"`, query `"{full name}" {current org} {title}`
   - `category: "news"`, query `"{full name}" {current org}`, `startPublishedDate` = 18 months ago
   - no category, query `"{full name}" {current org} podcast OR talk OR interview OR blog`; for `collaboration` goals use `category: "publication"` with `"{full name}" {field}` instead.
4. **Identity check**: keep a result only if the page text contains the full name *and* (the org name *or* the LinkedIn slug *or* a known email domain). If the people search returns two plausible different people (different orgs, both matching the name), stop and ask the user to pick (chat choices).
5. **Contents**: `POST /contents` for the top 6 kept URLs, `text: {maxCharacters: 6000}`, `maxAgeHours: 720`.
6. **Synthesis**: Claude Opus 5.5, effort `medium`, structured output (§5.4).
7. **Cache**: the dossier for 30 days (`expires_at`); Exa responses by request hash for 7 days in `orbit.research_cache`. A refresh within 30 days requires `refresh: true` and is free of Exa calls for cached URLs.

### 5.3 Output (what the user sees)

A card on the person page and in chat: one-line who-they-are; "Now" (role, team, since when); "Recently" (≤ 3 dated items: posts, news, talks) with links; "In common with you" (school, employers, people, interests); "Your history" (first/last contact, what was said); "Openers" (3 hooks, each tied to one source); "Careful" (anything to avoid: e.g. they just left a job, the article is about layoffs). Every sentence that came from the web has a numbered source link.

### 5.4 Prompt

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
<sources>{id: S1.., url, title, published, text}</sources>
```
Schema: `{who: string, now: {role, org, since|null, source_ids[]}, recently: [{date|null, text, source_ids[]}] (≤ 3), in_common: [{text, kind: school|employer|person|interest|place, source_ids[]}], history: {first_contact|null, last_contact|null, summary|null}, openers: [{text (≤ 25 words), source_ids[]}] (exactly 3, or fewer if sources are thin), careful: string[], confidence: "high"|"medium"|"low"}`. The function rejects (and retries once) any output with a `source_ids` entry not in the input.

### 5.5 Edge cases

Common names (identity check, then ask); people with no web presence (return internal + LinkedIn only, `confidence: low`, no padding); EU-located subjects (no special handling of public professional data in research, but never stored beyond 90 days and never used for automated decisions); sources behind paywalls (Exa returns highlights only; fine); minors (if the person appears to be in high school, stop and return nothing); Exa or Unipile down (dossier from what is available, marked partial).

### 5.6 Acceptance tests

1. Function test with recorded Exa/Unipile fixtures: dossier validates against the schema, every `source_ids` exists, cost recorded in `usage_ledger` ≤ $0.25.
2. Two same-name fixtures → the job returns `needs_disambiguation` with two candidates and makes no synthesis call.
3. Second request within 30 days returns the cached dossier with zero upstream calls.
4. Eval (§15): on 30 hand-checked people, factual precision of dossier claims ≥ 95% (claims supported by the cited source).

---

## 6. Sourcing (capability 6)

**Purpose.** Find people for a purpose (VCs for a raise, candidates for a role, customers, mentors, alumni in a field, research collaborators) and put the chosen ones in the pipeline.

**Reuse / Extend / New.** Reuse `recommendations` (now server-side `orbit.recommendations`), Discover page, `responsePrior`. New: `orbit-api /source/search`, provider adapters, ranking.

### 6.1 Providers by purpose (first listed runs first; results merge and dedupe)

| Purpose (goal kind) | Providers | Query built from |
|---|---|---|
| recruiting / advice (alumni, people at targets) | Unipile LinkedIn `classic` people search with `school`, `company`, `network_distance: [2, 3]`; Apollo `mixed_people/api_search` | goal targets (orgs, roles), user's school |
| fundraising (investors) | Exa `category: "people"` (e.g. "partner at a seed fund investing in climate software"), Exa `category: "company"` for funds, Apollo search with `person_titles: ["Partner","Principal","General Partner","Investor"]` and `q_keywords` | sector, stage, geography from the goal |
| sales (customers) | Apollo search (titles, seniorities, employee ranges, industries, locations) | ICP fields from the goal |
| hiring (candidates) | Unipile `classic` people search (`keywords`, `past_company`, `school`, distance 2–3); Exa people; Exa with `includeDomains: ["github.com"]` for engineers | role, skills, location |
| cofounder | Exa people + Unipile search (distance 2) | skills, domain, city |
| collaboration (PhD) | Semantic Scholar `GET https://api.semanticscholar.org/graph/v1/paper/search?query=&fields=title,year,authors,venue&limit=50`, then `GET /graph/v1/author/{id}?fields=name,affiliations,homepage,paperCount,hIndex`; Exa `category: "publication"` | research topic, keywords |
| community | Unipile search (distance 1–2, location) | community topic, city |

Rejected: Crunchbase and Harmonic (enterprise contracts; Exa + Apollo cover VC discovery for a student/seed founder), PDL (per-record cost), LinkedIn Sales Navigator unless the user's own account has a seat (then Unipile `api: "sales_navigator"` replaces `classic`, detected from `GET /users/me` `sales_navigator` field).

Contact details: emails are never bulk-revealed. Apollo `POST /api/v1/people/match` (1 credit) runs only when the user chooses to email a sourced person who has no known address.

### 6.2 Ranking

`rank = 0.45·fit + 0.35·reach + 0.20·responsiveness`
- `fit` ∈ [0, 1]: Haiku 5.5 scores each candidate against the goal's criteria (structured output `{fit: 0..1, reasons: string[≤2]}`), batched 20 per call; rule fallback = share of criteria matched by keyword.
- `reach` = best path `P` from §4 (computed for the top 30 by fit only), else 0.05 for 2nd-degree LinkedIn, else 0.
- `responsiveness` = existing `responsePrior` (seniority, alumni, sector).
Dedupe against existing people (resolution §2) and against people already in the pipeline for the same goal.

### 6.3 Flow into the pipeline

Results are written to `orbit.recommendations (goal_id, source, rank, fit, reach, reasons)`; the chat shows the top 10 with "Add" per row; "Add" creates/merges the person and a pipeline chat at stage `identified` with `goal_id`, and queues `enrich.dossier`.

### 6.4 Prompt (fit scoring)

```
System: Score how well each candidate matches what {user first name} is looking for. 0 = not a match, 1 = an excellent match.
Judge only from the fields given. Do not reward fame. Give at most two short reasons.
User: <looking_for>{goal title, criteria}</looking_for>
<candidates>{id, name, title, org, location, headline, source}</candidates>
```

### 6.5 Edge cases

Apollo's obfuscated last names (keep the record keyed by Apollo id; resolve when the user adds it); search returns people the user already knows (shown with their score, ranked by fit, labelled "You know them"); LinkedIn search cap (stop at 100 results per search, 10 searches per day); empty results (relax: drop location, then seniority, then say what was relaxed).

### 6.6 Acceptance tests

1. Function test (mock providers): a fundraising query merges Exa and Apollo results, dedupes a person present in both, and returns ranked results with reasons.
2. Adding a result creates exactly one person and one chat with the goal id, and queues one dossier job.
3. No provider key configured → `{results: [], unconfigured: [...]}` with no error.

---

## 7. Human-sounding outbound (capability 7)

**Purpose.** First messages, intro requests and thank-yous that people answer, in the user's voice, for every goal.

**Reuse / Extend / New.** Reuse the template engine, validator, banned phrases and the playbook (15) as the floor; every LLM draft must still pass `validateDraft`. Extend kinds and goal families. New: composer v2 prompt and outcome tracking.

### 7.1 What the evidence says, and the rules that follow (§20 B)

| Finding | Rule in Orbit |
|---|---|
| 50–125-word emails got the most replies (Boomerang, 40M emails); 20–39 words did best in Hunter's 34M cold emails, though the spread was small | First-touch email: 50–110 words (sales: 40–90). Bumps: 15–50 |
| Simple language (3rd-grade reading level) got 36% more replies (Boomerang) | Flesch–Kincaid grade ≤ 7, checked by the validator |
| 1–3 questions got 50% more replies than none (Boomerang); interest-based asks beat time-specific asks for sales (Gong) | Exactly one ask. Sales and fundraising: an interest ask ("Worth a look?"). Recruiting/advice: a small concrete ask (15–20 minutes) with the reason it's them |
| Subject lines of 3–4 words did best (Boomerang); 1–4 for executives (Gong) | Subject 2–6 words, ≤ 45 characters, lower-case except names, no clickbait |
| A personalized body got +32.7% replies (Backlinko, 12M) | Every first touch contains ≥ 1 hook from the dossier or history with a source; never fake familiarity |
| One follow-up adds ~66% more replies (Backlinko); 42–59% of replies arrive after step 1 (Instantly, Belkins); returns fall past 4–5 steps | Advice/recruiting: 1 bump (2 in finance/consulting, as today). Sales/fundraising/hiring cold: up to 2 bumps. Never more than 3 messages without a reply |
| InMails under 400 characters got +22% (LinkedIn) | LinkedIn messages ≤ 400 characters; connection notes ≤ 200 (limit 300) |
| Professors answered 67% of student cold emails, 95% of replies within 48 hours (Milkman et al.) | Treat 48 hours of silence as a weak "no reply yet"; bump timing below |
| Wednesday/Thursday best, weekends worst (Backlinko, Belkins); Friday/Saturday worse on LinkedIn | Default send window Tue–Thu 8:00–10:30 in the recipient's time zone (Mon allowed for LinkedIn), ± 0–20 min jitter |
| VCs source most deals from networks and referrals; only ~10% from inbound (Gompers et al. 2020) | Fundraising always looks for a warm path first; a cold email to an investor is offered only when no path has `P ≥ 0.15` |

### 7.2 Kinds and goal families

Kinds (extending `MessageKind`): `first_touch`, `warm_first_touch` (mentions the mutual), `intro_request` (to the intermediary), `forwardable_blurb` (attached to an intro request: ≤ 90 words, third person, written so the intermediary can forward it unchanged; double opt-in), `bump`, `thank_you`, `reengage` (dormant tie, score ≥ 30 and no contact in ≥ 180 days: a genuine update, no ask in the first message unless the user asks for one), `reply` (§8), `schedule`, `report_back`, `congratulate`, `nurture`, plus the existing `outreach`, `referral_ask`.

Goal families change register and ask:

| Goal | Default ask | Register |
|---|---|---|
| recruiting | 15-minute call about their path/team | warm, curious, specific |
| advice | 15–20 minutes on one named question | warm, humble, specific |
| fundraising | "Would you be open to a look?" + 1-line traction | crisp, numbers first |
| sales | "Worth a quick look?" tied to a trigger | short, concrete, no hype |
| hiring | "Open to hearing about it?" with the role's one hook | direct, respectful of their current job |
| cofounder | 20-minute call to compare notes on {problem} | peer-to-peer |
| community | invite to a specific event/group | friendly |
| collaboration | a specific question about their paper + a possible overlap | precise, academic |

### 7.3 Message schema

```ts
interface ComposedMessage {
  id: string; goalId: string | null; personId: string; kind: MessageKind;
  channel: 'gmail' | 'linkedin';
  subject: string | null;            // gmail only
  body: string;
  ask: { kind: 'call' | 'question' | 'interest' | 'intro' | 'none'; text: string };
  hooks: { text: string; sourceId: string }[];   // ≥ 1 for first touches
  via?: { introducerId: string; pathScore: number };
  sendWindow: { notBefore: string; tz: string };
  validator: { ok: boolean; issues: string[]; words: number; grade: number };
  promptVersion: string;             // e.g. 'compose-v2.0'
  variant: string | null;            // A/B arm
}
```

### 7.4 Personalization inputs and voice

- From §5: `openers`, `in_common`, `now`. From §2: user context and goal. From the thread: last inbound message (quotes stripped).
- **Voice model** (shared with §8): the existing `StyleCard` (greetings, sign-offs, sentence length, contractions, emoji, characteristic phrases) **plus** three retrieved exemplars: the user's own sent messages most similar to the situation (pgvector cosine on `messages.embedding` where `direction = out`, ≥ 25 words, not to the same person), with recipient names replaced by `[name]`.

### 7.5 Prompt (compose-v2.0, Opus 5.5, effort `medium`, structured output = §7.3 minus server fields)

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
After generation: `validateDraft` (existing) + new checks (word range by kind/goal, grade, single ask, hook present for first touches, no unknown names or numbers that are not in the inputs, LinkedIn length). One retry with the issues listed; if it still fails, fall back to the template and mark `generated_by = template`.

### 7.6 Evaluation harness

- **Offline (every prompt change, CI-optional, needs a key)**: 60 fixed situations (8 goals × kinds × channels, `packages/core/src/__tests__/fixtures/compose-cases.ts`), generate, then (1) the validator must pass 100%; (2) a Sonnet 5.5 judge scores each on a 1–5 rubric: sounds like the voice card, specific hook, one clear ask, would-reply likelihood, no invented facts (binary); gate: mean ≥ 4.0 and zero invented facts.
- **Online**: every sent first touch records `prompt_version`, `variant`, goal, kind, channel, words. Outcome = reply within 14 days (positive/any) from §8. Variants are assigned per user round-robin; a variant is promoted when its reply rate beats control with posterior probability ≥ 0.95 (Beta(1,1) priors, ≥ 50 sends per arm). Dashboard query in §16.
- **User-sim**: new scenarios per persona (§19).

### 7.7 Edge cases

Recipient in the EU/UK and the message is commercial (sales): add the user's company name and a one-line opt-out ("If this isn't relevant, just say so and I won't follow up.") and honour it (CAN-SPAM/PECR, §14); the recipient already said no (any goal): no new first touch for 180 days; same company contacted ≥ 3 times this week: warn before drafting a 4th (Backlinko saw gains from multiple contacts per company, but students hitting a whole team at once reads as spam, so Orbit caps at 3/week).

### 7.8 Acceptance tests

1. Core: the validator rejects 130-word first touches, two asks, grade > 7, missing hook, and LinkedIn > 400 chars.
2. Offline eval gate passes at launch (recorded in `docs/plan/evals/compose-v2.md`).
3. Function test: an invented fact (a name not in the inputs) is caught and the template fallback is used after one retry.

---

## 8. Reply handling and continuation in the user's voice (capability 8)

**Purpose.** Read every reply on Gmail and LinkedIn, know what it means, draft the answer as the user, steer to a call with real availability, and keep the user in control.

**Reuse / Extend / New.** Reuse the reply-signal classifier (`ReplySignal`, ~460 labelled replies, 95% holdout), message extraction (proposed times, asks, offers, return dates), send pipeline and undo window. New: 10-class mapping, LLM fallback, freebusy slots, autonomy levels, Unipile sending.

### 8.1 Classes

| Class | From existing `ReplySignal` | Next action |
|---|---|---|
| `interested` | reply_positive | propose times (§8.3) |
| `scheduling` | scheduling_proposal, scheduling_confirmation, reschedule | confirm a slot / create the event / reschedule |
| `question` | question | answer; if the user must supply facts, ask them in chat first |
| `objection` | (new) | acknowledge + one sentence + keep the door open; no second push |
| `referral` | referral_offer, intro_offer | thank, accept, ask for the intro or the contact; create the referred person |
| `not_now` | (new: timing push-back, "after the holidays") | thank; schedule a follow-up at the stated time |
| `out_of_office` | out_of_office | hold bumps until return + 2 business days (existing) |
| `decline` | reply_decline | thank briefly; close the chat as declined; no bumps |
| `unsubscribe` | (new: "remove me", "stop emailing") | no reply is drafted; mark the person `do_not_contact`; close the chat |
| `thanks` | thank_you | no reply needed unless it contains a question |
| `other` | other, reply_neutral | draft only on request |

Classifier: core heuristics first (`classifyReply` wraps the existing signal reader and adds the three new classes with keyword rules); if confidence < 0.75, Haiku 5.5 with structured output `{class, confidence, proposed_times[], return_date|null, referred_people[{name, email|null, org|null}], question|null}`. Labelled corpus extended with ≥ 40 examples each of objection, not_now and unsubscribe; holdout gate stays ≥ 95%.

### 8.2 Drafting the response

Opus 5.5, effort `medium`, same voice inputs as §7.4 but exemplars are the user's own *replies* (sent messages with `In-Reply-To`), and the thread is included in full (quotes stripped, oldest to newest, max 8 messages). Prompt adds: "Answer what they said. If they proposed times, accept one that is free (given) or offer the ones given. Keep it shorter than their message unless they asked questions."

### 8.3 Funnel to a call

- Availability: Calendar `POST https://www.googleapis.com/calendar/v3/freeBusy` `{timeMin: now+18h, timeMax: now+10 business days, timeZone: user tz, items: [{id: "primary"}]}`; candidate slots are 30 minutes, 9:00–17:30 user time, not on weekends, not adjacent to another event; pick 3 spread over 3 different days, rendered in the recipient's time zone when known (from their signature/headers/LinkedIn location), else the user's with the zone named.
- If `users.settings.scheduling_link` is set (Cal.com, Calendly), the draft offers the 3 times **and** the link.
- When they confirm a time: create the event with `POST /calendar/v3/calendars/primary/events?sendUpdates=all` **only after the user approves** (requires scope `calendar.events`; requested incrementally the first time, §14.1).

### 8.4 Autonomy levels (`users.autonomy_level`, per-goal override in `goals.autonomy_level`)

| Level | Name | What happens |
|---|---|---|
| 0 | Draft only (default) | Drafts appear in Drafts and the chat; the user sends |
| 1 | Send after approval | One tap "Send" schedules it with the 60-second undo window, at the next send window |
| 2 | Auto-send within rules | Allowed only when **all** hold: Gmail; reply inside an existing thread where both sides have written; class ∈ {scheduling, thanks, out_of_office follow-up}; the recipient's score ≥ 40; no new commitments (money, dates beyond the proposed slots, attachments, links other than the scheduling link); validator passes; ≤ 5 auto-sends per day; not between 21:00 and 7:00 recipient time. Every auto-send is listed in the morning brief and the audit log |

### 8.5 Channels

- **Gmail**: `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `{raw, threadId}`, headers `In-Reply-To` and `References` from the last message, scope `gmail.send`. Idempotency: the draft id is put in a custom header `X-Orbit-Draft-Id` and the worker checks `drafts.status` + `provider_message_id` before sending.
- **LinkedIn**: existing chat → `POST {UNIPILE}/api/v1/chats/{chat_id}/messages` (multipart: `text`, `account_id`); new conversation with a 1st-degree connection → `POST /api/v1/chats` (`account_id`, `attendees_ids[]`, `text`). Orbit **never** calls `POST /api/v1/users/invite` without the user pressing "Send invite" on that specific invite, and never sends InMail automatically. LinkedIn caps per user: 25 messages/day, 15 invites/day and 60/week, 40 profile views/day (well under Unipile's guidance).

### 8.6 Edge cases

Reply from a different person than the one written to (forwarded/delegated: resolve the sender, link to the same chat, note "Sam replied for Priya"); reply on LinkedIn to an email outreach (thread both into one chat); a reply that is both a decline and a referral (`referral` wins, chat closes as declined after the referred person is created); the user replied themselves from Gmail before Orbit drafted (incremental sync sees the outbound message and discards the draft); a thread contains a legal or medical matter (never auto-send; draft only).

### 8.7 Acceptance tests

1. Core: holdout ≥ 95% on 11 classes, 100% on unsubscribe and decline examples.
2. Function: a `scheduling` reply produces a draft with 3 free slots that do not overlap the fixture calendar and are in the recipient's time zone.
3. Function: level 2 auto-sends a scheduling confirmation in a two-way thread and refuses (draft only) for a first-touch reply from a cold recipient, a LinkedIn thread, or at 23:00 recipient time.
4. An `unsubscribe` reply sets `do_not_contact` and blocks any later draft to that person (compose returns an error the chat explains).

---

## 9. Follow-up and cadence engine (capability 9)

**Purpose.** Bumps, stage changes, went-quiet detection, thank-yous and periodic nurture of important ties, running whether or not the app is open.

**Reuse / Extend / New.** Reuse the rules in `packages/core/src/suggestions/rules.ts` and `pipeline/transitions.ts` (bump timing by channel and sector, quiet after 7 days, no_response after 14/21 days, thank-you window 3 days, OOO hold). New: server scheduler, nurture cadence by importance, scheduled sends.

### 9.1 Scheduler and workers

- **Queues** (`pgmq`): `orbit_send`, `orbit_classify`, `orbit_sync`, `orbit_cadence`, `orbit_score`, `orbit_enrich` (priority in that order).
- **Tick**: `pg_cron` every minute calls `orbit-worker` via `pg_net` with header `x-orbit-cron: <vault secret orbit_cron_secret>`.
- **Worker loop** (`supabase/functions/orbit-worker`): time budget 110 s per tick (fits the 150 s free-plan wall clock; raise to 300 s on a paid plan). For each queue in priority order: `pgmq.read(queue, vt => 120, qty => 10)`; run each message's handler; on success `pgmq.delete`; on failure `pgmq.set_vt(queue, msg_id, 30 * 2^read_ct)` (30 s, 1 min, 2 min, 4 min, 8 min); when `read_ct > 5` → `pgmq.archive` and insert into `orbit.dead_letters`. Each handler run writes `orbit.job_runs`.
- **Message shape**: `{kind: string, userId: uuid, payload: object, dedupeKey?: string}`; `dedupeKey` is checked against `orbit.job_runs` (status `ok` in the last 24 h) before running.
- **Cron entries**: `orbit-worker-tick` `* * * * *`; `orbit-incremental` `*/10 * * * *` → `orbit.enqueue_incremental_syncs()`; `orbit-cadence` `7 * * * *` → `orbit.enqueue_cadence()`; `orbit-nightly` `13 7 * * *` → `orbit.enqueue_nightly()` (scores, Gmail watch renew, calendar resync); `orbit-retention` `23 8 * * *` → `orbit.retention_purge()`.

### 9.2 `cadence.user` handler

For one user, with the user's time zone and quiet days:
1. Bumps due (existing `bumpDue`, plus goal families: sales/fundraising/hiring cold get bump 2 at +7 business days after bump 1; never a 4th message) → create `drafts` kind `bump` (status `draft`, or `approved` with `send_at` if the goal's autonomy is 1 and the user pre-approved bumps for that chat).
2. Went quiet (existing `wentQuiet`) → notification + draft bump if allowed.
3. Thank-you due (meeting ended < 3 days ago, no thank-you sent) → draft `thank_you` using the note if any.
4. Stage timers (existing `no_response` closing).
5. **Nurture**: for people with score ≥ 60 (Strong/Close) or tied to an active goal, no contact in `cadence_days` (Close 60, Strong 90, goal-linked 30), and a reason to write (new role, their post, a dossier "recently" item, the user's own news) → a `nurture`/`reengage` suggestion; at most 3 per week.
6. Approved drafts whose `send_at ≤ now` → enqueue `orbit_send`.

### 9.3 Edge cases

User on vacation (`settings.quiet_until`): no drafts or sends until then; send window falls on a holiday (skip US federal holidays and the recipient's weekend); the person replied between cadence runs (the send handler re-checks the thread for an inbound message newer than the draft and cancels with reason `replied`).

### 9.4 Acceptance tests

1. SQL test: `orbit.enqueue_cadence()` enqueues exactly one message per active user per hour (dedupe key `cadence:<user>:<yyyy-mm-dd-hh>`).
2. Worker test: a failing handler is retried with growing visibility timeouts and lands in `dead_letters` after 6 reads.
3. A bump is never sent when an inbound message arrived after it was drafted.
4. No more than 3 unanswered messages to one person, across channels, ever.

---

## 10. Pipeline and memory (capability 10)

**Purpose.** Store and retrieve every person, thread, goal, note and outcome so the agent has context, with a long-term memory that the user can see and delete.

**Reuse / Extend / New.** Reuse chats/stage events/notes/facts and the snapshot. New: `orbit.memories` (pgvector), memory tools, context assembly, retention.

### 10.1 Memory

- **What is a memory**: a durable statement about the user (preference, constraint, goal detail, outcome) or about a person ("Priya prefers LinkedIn", "Maya offered to refer me in March"). Facts already in structured tables are not duplicated.
- **Write paths**: tool `remember({text, personId?, kind})` (the agent may call it when the user states a durable preference; risk: none, but every write is shown as a small "Saved to memory" line); automatic extraction after each chat turn by Haiku 5.5 (`{memories: [{kind: preference|constraint|goal_detail|outcome|person_fact, text ≤ 200 chars, person_name|null, quote}]}`, quote must be in the user's words); note extraction (existing) writes person facts.
- **Dedupe**: before insert, search the user's memories with cosine ≥ 0.92 → update `last_seen_at` instead.
- **Embedding**: `gte-small` via `new Supabase.ai.Session('gte-small')`, `mean_pool: true, normalize: true`, 384 dims, computed in the function that writes the row.
- **Retrieval for the chat**: every turn, `recall(query = user's last message)` returns up to 8: `0.7·cosine + 0.2·importance + 0.1·recency(30-day half-life)`, filtered to the person in focus when there is one. Results go into the snapshot under "Remembered" (≤ 300 tokens).
- **User control**: Settings → Memory lists all memories with delete; chat "forget that" calls `forget`.

### 10.2 Context assembly for the agent (per turn)

Stable system prompt (cached) → tools (cached) → conversation (append-only, compaction beta) → snapshot as a mid-conversation system message (changed parts only), now containing: user context (§2), active goals, pipeline counts, brief cards, Setup line, "Remembered", and for a focused person: score + explanation, dossier summary, last 3 messages. Budget: snapshot ≤ 1,500 tokens.

### 10.3 Retention and deletion

| Data | Retention |
|---|---|
| Message metadata (headers, participants) | Until account deletion |
| Message bodies (networking threads only) | 24 months from `sent_at` (setting: 6/12/24) |
| Non-networking messages | Bodies never stored; metadata kept only if a participant is a person in the graph |
| Dossiers | 90 days, then deleted (re-researched on demand) |
| Research cache | 7 days |
| Memories | Until the user deletes them |
| Audit log | 2 years |
| Job runs | 30 days; dead letters 90 days |
| Account deletion | Hard delete of all `orbit.*` rows for the user within 24 h (`orbit.delete_user(uuid)`), Vault secrets deleted, Gmail `users.stop` called, Unipile account `DELETE /api/v1/accounts/{id}`, Google token revoked (`POST https://oauth2.googleapis.com/revoke`) |

### 10.4 Acceptance tests

1. `remember` then `recall` with a paraphrase returns the memory first (function test with gte-small).
2. A duplicate memory (cosine ≥ 0.92) updates instead of inserting.
3. `orbit.retention_purge()` nulls bodies older than the user's setting and deletes expired dossiers and cache rows (SQL test).
4. `orbit.delete_user()` leaves zero rows for the user in every `orbit` table (SQL test iterating `information_schema.columns` where `column_name = 'user_id'`).

---

## 11. Data model and storage

### 11.1 Where data lives

| Data | Local mode | Account mode |
|---|---|---|
| People, orgs, affiliations, identities | Dexie | Postgres (source of truth) → Dexie cache |
| Messages, threads, calendar events | Dexie (90 days) | Postgres (2 years backfill) → Dexie cache (last 180 days, networking threads only) |
| Ties, tie scores | Dexie (`edges`, `people.strength`) | Postgres → Dexie |
| Goals, chats, stage events, notes, drafts | Dexie | Postgres, edited through `/sync/push` |
| Suggestions, briefs, notifications | Dexie (derived in the browser) | Dexie (derived in the browser from the cache) |
| Dossiers, recommendations, memories | — | Postgres → Dexie (dossiers, recommendations); memories server only |
| Chat conversations | Dexie | Dexie (server copy is a Phase 7 item) |
| Secrets: Claude key, Google client id | `orbit-local` IndexedDB | Server: Vault; the browser holds only the Orbit session |

### 11.2 Identity and sessions

- `orbit.users` keyed by Google `sub`; `orbit.sessions (refresh_hash sha256, expires_at 30 d, rotated on each refresh)`.
- Access token: HS256 JWT `{sub: user_id, sid: session_id, aud: "orbit", iat, exp: +3600}` signed with `ORBIT_SESSION_SECRET` (32 random bytes, base64). Verified in `orbit-api` with `jose`.
- The SPA stores the access token in memory and the refresh token in IndexedDB `orbit-local` (`session` key); refresh 5 minutes before expiry.

### 11.3 Schema (migration `20261014_orbit_core.sql`)

All tables: schema `orbit`, RLS enabled, **no policies** (service role only), `revoke all on schema orbit from anon, authenticated`. The schema is not added to the Data API's exposed schemas; functions reach it with `postgres.js` (`npm:postgres`) over the `SUPABASE_DB_URL` that every Edge Function receives, with `prepare: false`, through one module `supabase/functions/_shared/db.ts`. Business logic takes a small `Db` interface (`sql` tagged template + `begin`) so it runs against PGlite (`@electric-sql/pglite`, with `vector`) in unit tests, where `pgmq`, `vault` and `cron` are replaced by stub schemas in `supabase/tests/stubs.sql`. `updated_at` maintained by trigger `orbit.touch_updated_at()`. Every user-owned table has `user_id uuid not null references orbit.users(id) on delete cascade` and an index on `(user_id, updated_at)` for sync.

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
  kind text not null check (kind in ('email_exchange','email_cc','email_cothread','meeting_coattendee','introduced_by','linkedin_mutual','village_path','co_tenure','same_school_cohort','same_current_company')),
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

Functions in the same migration: `orbit.touch_updated_at()` trigger; `orbit.enqueue(queue text, msg jsonb, delay int default 0)` wrapper over `pgmq.send`; `orbit.enqueue_incremental_syncs()`, `orbit.enqueue_cadence()`, `orbit.enqueue_nightly()`, `orbit.retention_purge()`, `orbit.delete_user(uuid)`, `orbit.vault_put(name text, secret text) returns uuid`, `orbit.vault_get(id uuid) returns text`, `orbit.vault_delete(id uuid)` (all `security definer`, `set search_path = ''`, execute granted to `service_role` only). Queues: `pgmq.create` for the six queues in §9.1.

### 11.4 Mapping to the client types

`/sync/pull` returns rows already shaped as the core types (camelCase), so Dexie stores them unchanged: `orbit.people` → `Person` (`strength`, `strengthBreakdown` from `tie_scores`), `orbit.threads` → `EmailThread`, `orbit.messages` → `EmailMessage` (`direction: 'inbound'|'outbound'`), `orbit.calendar_events` → `CalendarEvent`, `orbit.ties` → `Edge` (`type` = kind, `weight` = w·c), `orbit.chats` → `CoffeeChat` (spread `data`), `orbit.drafts` → `OutboundMessage`, `orbit.goals` → new core type `Goal` (and the first recruiting goal also fills `RecruitingGoals` for v1 screens), `orbit.dossiers` → new `Dossier`, `orbit.recommendations` → `Recommendation`. Mapping functions live in `packages/core/src/server/mappers.ts` and are used by both the function (to serialize) and tests.

---

## 12. Sync and ingestion architecture

### 12.1 Sign-in and Google consent

1. SPA "Continue with Google" → `GET {ORBIT_API}/auth/google/start?redirect=<app url>`.
2. Function creates `oauth_states` (state, PKCE verifier, 10-minute expiry) and 302s to `https://accounts.google.com/o/oauth2/v2/auth` with `client_id=ORBIT_GOOGLE_CLIENT_ID`, `redirect_uri=ORBIT_GOOGLE_REDIRECT_URI`, `response_type=code`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `code_challenge_method=S256`, scopes (§14.1 phase-1 set).
3. Callback `GET /auth/google/callback?code&state` → `POST https://oauth2.googleapis.com/token` (code + verifier + secret) → id_token verified (aud, iss, exp) → upsert `orbit.users` by `sub`, create the self person, store the refresh token with `orbit.vault_put('google_refresh:'||user_id, token)`, upsert `integration_accounts(google)` with scopes → create a login code (32 random bytes, stored hashed, 2-minute expiry) → 302 to `{ORBIT_APP_URL}/auth/done#code=<code>`.
4. SPA `POST /auth/session {code}` → `{accessToken, refreshToken, expiresAt, user}`; the SPA switches to account mode and calls `/sync/status` every 3 s during onboarding.
5. Access tokens for Google are minted on demand from the refresh token (`grant_type=refresh_token`), cached in memory per function instance for their lifetime minus 5 minutes. `invalid_grant` → `integration_accounts.status = needs_reauth` and the chat's Setup line asks to reconnect.

### 12.2 Gmail

- **Backfill** (`sync.gmail.backfill`, chained jobs):
  1. Phase `recent`: `GET /gmail/v1/users/me/messages?q=newer_than:90d -in:chats&maxResults=500` (5 units), page through ids.
  2. For each id not already stored: `GET /messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=List-Unsubscribe&metadataHeaders=Auto-Submitted&metadataHeaders=Precedence` (20 units).
  3. Classify the thread from headers (core `triage` + automated filters). Threads where the user sent at least one message, or that have ≤ 8 participants of whom one is a known person, and are not automated → **networking candidates** → `GET /threads/{id}?format=full` (40 units) → bodies parsed with `postal-mime`-equivalent payload walking (Gmail already parses MIME in `format=full`; take `text/plain`, else strip `text/html`), quotes removed with `email-reply-parser` for classification, full text stored.
  4. Phase `deep`: the same with `q=after:<2 years ago> before:<90 days ago>`.
  - **Rate**: a per-user token bucket of 90 units/second (of Google's 6,000/minute/user), 5 concurrent requests. One job processes up to 250 messages (~5,000 units, ~60 s), records `pageToken` in `sync_state`, and re-enqueues itself with `delay = 5 s`. Typical student mailbox (2 years ≈ 10–20k messages): `recent` in 3–6 minutes, `deep` in 40–80 minutes.
- **Incremental**:
  - Push: `POST /gmail/v1/users/me/watch {topicName: GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX","SENT"], labelFilterBehavior: "include"}` at connect and nightly (expires after 7 days). Pub/Sub push subscription → `POST {functions}/orbit-webhooks/gmail?token=ORBIT_PUBSUB_TOKEN`; body `message.data` base64 → `{emailAddress, historyId}` → enqueue `sync.gmail.incremental` with dedupe key `gmail:<user>:<historyId>`.
  - Fallback poll: `orbit.enqueue_incremental_syncs()` every 10 minutes for active users whose `last_synced_at` is older than 10 minutes.
  - Handler: `GET /history?startHistoryId=<stored>&historyTypes=messageAdded&maxResults=500` (2 units), then the same per-message path as backfill. **404** (history too old) → enqueue a `recent` backfill for the last 30 days and reset `historyId` from `GET /users/me/profile`.
- **Dedup**: `unique (user_id, provider, external_id)` on messages; `on conflict do nothing`.

### 12.3 Calendar and contacts

- `GET /calendar/v3/calendars/primary/events?singleEvents=true&timeMin=<2y ago>&timeMax=<+90d>&maxResults=2500` paging; store `nextSyncToken`. Incremental every 10 minutes with `syncToken` only (no timeMin/timeMax, §20 C); **410** → full resync.
- Contacts once at connect and weekly: `otherContacts.list` and `people.connections.list` with `requestSyncToken=true`; `EXPIRED_SYNC_TOKEN` (410) → full list again.

### 12.4 LinkedIn via Unipile

- Connect: `POST {UNIPILE_BASE_URL}/api/v1/hosted/accounts/link` with `name = <orbit user id>`, `notify_url = {functions}/orbit-webhooks/unipile/account?token=ORBIT_UNIPILE_WEBHOOK_SECRET`, `success_redirect_url = {ORBIT_APP_URL}/settings?linkedin=connected`.
- Backfill: relations `GET /api/v1/users/relations?account_id=&limit=1000&cursor=` until `cursor` is null; chats `GET /api/v1/chats?account_id=&limit=250&after=<2y ago>`; for chats with ≤ 3 attendees, `GET /api/v1/chats/{chat_id}/messages?limit=100` (most recent 100).
- Webhooks, created once per deployment by an admin script (`scripts/unipile-webhooks.ts`): `POST /api/v1/webhooks` for `source: "messaging"` (events `message_received`), `source: "users"` (`new_relation`), `source: "account_status"`, each with `request_url = {functions}/orbit-webhooks/unipile` and header `x-orbit-webhook: ORBIT_UNIPILE_WEBHOOK_SECRET`. Own messages also arrive as `message_received`: drop when `account_info.user_id == sender.attendee_provider_id`. Idempotency via `orbit.webhook_events (provider='unipile', event_id=message_id)`. `new_relation` may be up to 8 hours late; that is acceptable.

### 12.5 Entity resolution during ingestion

Every address/profile → `resolveIdentity` with candidates fetched by the blocking keys (§2.1) in one SQL query per batch (`person_identities` lookup by `value_norm in (...)`, then `people` by `name_norm`). New identities insert `person_identities`. Merge suggestions are created, never auto-applied, in the 0.6–0.92 band.

### 12.6 Rate limits and costs at a glance

| Provider | Limit we respect |
|---|---|
| Gmail | 6,000 units/min/user (we use ≤ 5,400) |
| Calendar | 600 requests/min/user (we use ≤ 60) |
| People API | 1 full sync/day |
| Unipile | per §8.5; relations/chats paging ≤ 1 request/s/account |
| Exa | 5 requests/s per Orbit (shared), per-user cost caps §13.5 |
| Apollo | 50/min (free) or 200/min (paid), shared across users; queued |
| Village | 100 requests/s per key; per-user credit cap |

### 12.7 Bundling shared code into functions

`scripts/build-functions.mjs` runs esbuild for each function entry (`supabase/functions/<name>/index.ts`) with `bundle: true, format: 'esm', platform: 'neutral', target: 'es2022'`, resolving `@orbit/core` to `packages/core/src` and leaving `npm:`/`jsr:` specifiers external, and writes `supabase/functions/<name>/dist/index.js`, which a two-line `index.ts` re-exports for deployment. CI runs the build and fails if the committed bundle is stale.

---

## 13. LLM architecture

### 13.1 Model per task

| Task | Model | Effort / settings | Calls | Fallback |
|---|---|---|---|---|
| Chat agent | `claude-opus-5-5` | medium (low for quick turns), adaptive thinking, compaction, `fallbacks: "default"` (`server-side-fallback-2026-07-01`) | per turn | router (no LLM) |
| Compose first touches, intro requests, reengage | `claude-opus-5-5` | medium, structured output | per draft | template engine |
| Replies in the user's voice | `claude-opus-5-5` | medium, structured output | per reply | template `reply` kind |
| Dossier synthesis | `claude-opus-5-5` | medium, structured output | per dossier | internal + LinkedIn summary without web |
| Reply classification (low confidence) | `claude-haiku-5-5` | low, structured output | ~20% of replies | heuristic class with `confidence` |
| Email triage during backfill | `claude-haiku-5-5` via **Batches API** (50% price) | low | only threads the heuristics mark uncertain | heuristic |
| Memory / goal extraction | `claude-haiku-5-5` | low | after chat turns with user statements | none (skip) |
| Sourcing fit scoring | `claude-haiku-5-5` | low | 20 candidates per call | keyword rule |
| Offline judges (compose eval, user-sim) | `claude-sonnet-5-5` | default | eval runs only | — |
| Embeddings | `gte-small` (Supabase built-in) | 384 dims | per memory / outbound message | none |

All server calls go through one helper, `supabase/functions/_shared/claude.ts`, using `@anthropic-ai/sdk` (`npm:@anthropic-ai/sdk`), which: sets the model per task from the table, adds `cache_control` on the system prompt, uses `client.messages.parse` with Zod schemas for structured output, checks `stop_reason` (`refusal` → fallback path; `max_tokens` → one retry with doubled `max_tokens`), records `usage` in `orbit.usage_ledger`, and enforces the per-user caps before calling.

### 13.2 Prompt caching

Order: tools → system (stable, versioned, cached) → conversation → per-turn snapshot as a mid-conversation system message. Server prompts (compose, reply, dossier) keep the instruction block first and constant, and put user data after a single cache breakpoint. Verify `cache_read_input_tokens > 0` in the integration test for repeated compose calls.

### 13.3 Structured outputs

Every non-chat task returns JSON validated by a Zod schema (`output_config.format` via `messages.parse`). Schemas live next to the prompt in `supabase/functions/_shared/prompts/*.ts` with a `PROMPT_VERSION` constant recorded on the output row.

### 13.4 Cost per active user per month (estimate)

Assumptions for an active student: 60 chat turns, 40 drafts, 120 replies classified (25 by LLM), 30 replies drafted, 20 dossiers, 8 sourcing runs, 10 path lookups that call Village, one LinkedIn account, a 2-year backfill once (15k messages, 1.5k uncertain threads).

| Item | Calculation | $ / month |
|---|---|---|
| Chat (Opus 5.5) | 60 × (20k cached @ $0.20/M + 3k fresh @ $4/M + 1.5k out @ $20/M) | 2.80 |
| Drafts + replies (Opus 5.5) | 70 × (6k in @ $4/M + 600 out @ $20/M) | 2.52 |
| Dossiers | 20 × (Exa ≈ $0.03 + Opus 25k in, 2k out ≈ $0.14) | 3.40 |
| Classification, extraction, fit (Haiku 5.5) | ≈ 400 calls × 2k tokens @ $0.10/M in, small out | 0.10 |
| Backfill triage (Haiku, batch, once) | 1.5k × 1k tokens @ $0.05/M | 0.08 (one-off) |
| Sourcing | 8 × (Exa 3 searches + Apollo free + Haiku) | 0.25 |
| Village | 10 person paths × 5 credits × $0.02 | 1.00 |
| Unipile | 1 account (51–200 tier) | 5.00 |
| Supabase | Pro project $25 + compute, amortized over 200 users | ≈ 0.20 |
| **Total** | | **≈ $15.30** |

### 13.5 Caps (enforced in `_shared/budget.ts` from `usage_ledger`)

Per user per day: Claude $1.50, Exa $0.50, Village 50 credits, Apollo match 10 credits, Unipile profile views 40. Per user per month: $25 total. Over a cap: the task returns `budget_exceeded` and the chat says what was skipped and when it resets. Global: `ORBIT_LIMIT_GLOBAL_PER_DAY` stays on the Claude proxy.

---

## 14. Privacy, consent and safety

### 14.1 Scopes, requested in stages

| Stage | Scopes | Classification | Why |
|---|---|---|---|
| Sign-in | `openid email profile` | non-sensitive | identity |
| Connect Gmail (onboarding step) | `gmail.readonly`, `gmail.send` | restricted, sensitive | read mail for the graph and replies; send what the user approves |
| Connect Calendar (same consent screen) | `calendar.readonly` | not on Google's restricted list | meetings and free/busy |
| Contacts (same screen) | `contacts.other.readonly`, `contacts.readonly` | sensitive | names for addresses |
| First time the user books a call from Orbit | `calendar.events` (incremental, `include_granted_scopes`) | sensitive | create the event |

Not requested: `gmail.modify`, `gmail.compose`, `mail.google.com` (Orbit keeps drafts itself and never changes the user's mailbox).

**Verification**: `gmail.readonly` is restricted, so storing its data on a server requires Google's verification plus an annual CASA assessment (Tier 2, lab-verified). Until it passes, the OAuth app stays in **Testing** (≤ 100 named test users; test users' refresh tokens expire after 7 days, so the Setup line asks them to reconnect weekly). Human actions H2–H4.

### 14.2 Data minimization

- Bodies are stored only for networking threads (§12.2); everything else is headers only, and headers only for messages involving a person in the graph.
- No attachments are downloaded. No mail is modified. No labels are read beyond INBOX/SENT/CATEGORY_*.
- Google user data is never used to train models, never sold, never shared beyond the processors listed (Anthropic, Supabase, Unipile, Exa, Village, Apollo), as Google's Limited Use policy requires; the privacy page says so.
- Research never stores sensitive categories (§5.4).

### 14.3 Encryption and access

TLS everywhere; Postgres encryption at rest (Supabase); OAuth refresh tokens and Unipile account ids in **Vault** (encrypted with the project key); the `orbit` schema is not exposed through the Data API and has RLS with no policies; only Orbit's functions (service role) read it. Dedicated project before real users (H1) so no other app's service key can read Orbit data.

### 14.4 LinkedIn

LinkedIn's User Agreement §8.2 forbids "bots or other unauthorized automated methods to … add or download contacts, send or redirect messages". Unipile acts through the user's own session, so the risk falls on the user's account and on Orbit. Orbit's rules: every LinkedIn send and invite is an explicit user action on that message; no scheduled LinkedIn sends; no bulk invites; caps far below Unipile's guidance (§8.5) with random 20–90 s spacing; profile views use `notify=false` and ≤ 40/day; on any 429/500 or `account_status` other than OK, LinkedIn actions pause for 24 h and the user is told. Users see this risk in plain words before connecting LinkedIn live, with "Use your export instead" as the alternative.

### 14.5 Email law

- **CAN-SPAM** applies to messages whose primary purpose is commercial, with no B2B exception: sales-goal drafts include the sender's real name and company, a non-deceptive subject, and an opt-out line; a postal address field is required in Settings before the first sales-goal send; opt-outs (class `unsubscribe`) are honoured immediately (law: within 10 business days).
- **UK PECR / GDPR**: B2B email to corporate addresses is allowed without consent; personal addresses of individuals in the UK/EU are not targeted by sales-goal sourcing; data from public sources (LinkedIn) still needs a lawful basis (legitimate interests) and transparency: the opt-out line names the user and how they found the person if asked.
- Non-commercial one-to-one notes (advice, recruiting, thanks) are not marketing; Orbit still never sends more than 3 unanswered messages.

### 14.6 Hard rules (enforced in code, not only in prompts)

The agent must never, without the user's approval of that exact message: send any message on LinkedIn; send a first message to anyone on any channel; send anything containing money amounts, attachments, links other than the user's scheduling link, or commitments of time beyond the offered slots; create or change calendar events; ask a third party for an introduction; reveal anything from one person's thread to another person. It must never: contact someone marked `do_not_contact`; send more than 3 unanswered messages to one person; impersonate anyone other than the user; invent facts about the user or the recipient (validator: names and numbers must appear in the inputs); research or contact someone who appears to be a minor; store or infer sensitive personal categories. Each rule is a check in `packages/core/src/safety/rules.ts` called by the send path and by compose, with a unit test per rule.

---

## 15. Evaluation

| Metric | Definition | Source | Target |
|---|---|---|---|
| Reply rate | replies within 14 days / first touches sent, by goal, kind, channel, prompt version | `orbit.drafts` (`replied_at`) | track; A/B per §7.6 |
| Positive reply rate | replies of class interested/scheduling/referral / first touches | same | track |
| Intro conversion | `intro_requests` reaching `intro_made` / asked | `orbit.intro_requests` | ≥ 35% for `high` band paths |
| Path accuracy | top-1 path == the path the user chose (when they chose from a list) | intro_requests.rank | ≥ 60% |
| Path calibration | in each band, share of requests reaching `agreed`; must be monotonic high > medium > low | intro_requests | monotonic |
| Score calibration | Spearman ρ between score and the user's 1–5 labels; mean absolute error in band units | `tie_labels` | ρ ≥ 0.6 global model; ≥ 0.75 after per-user calibration |
| Reply classification | holdout accuracy | core corpus | ≥ 95% |
| Dossier precision | supported claims / claims on 30 audited dossiers | manual audit | ≥ 95% |
| Compose quality | judge mean, invented facts | §7.6 | ≥ 4.0, 0 |

- **Offline** suites live in `apps/web/src/chat/__tests__/sim/` (agent behaviour) and `packages/core/src/__tests__/` (models). Compose and dossier evals run with `ANTHROPIC_API_KEY` set (`pnpm eval:compose`, `pnpm eval:dossier`), and write scorecards to `docs/plan/evals/`.
- **User-sim**: add the four personas of §19 as scenario groups (`persona-intern`, `persona-founder`, `persona-sales`, `persona-phd`), each with 4 scenarios; gates unchanged (safe, not invented, goal met, score ≥ 3).
- **Score calibration study**: during the Testing-mode period, ask each user to rate 10 random contacts (stratified across bands) in onboarding; refit `TIE_WEIGHTS` globally once 500 labels exist.

---

## 16. Observability and reliability

- **Logs**: every function logs one JSON line per request/job: `{ts, fn, route|kind, user_id_hash, request_id, status, duration_ms, upstream: [{provider, status, ms}], cost_usd}`. No message bodies, names or addresses in logs.
- **Job tables**: `orbit.job_runs` (30 days) and `orbit.dead_letters` (90 days). `orbit.health()` returns counts of dead letters in 24 h, oldest message age per queue, users with `needs_reauth`, and backfills stuck > 1 h; a cron (`*/15`) writes it to `orbit.audit_log` with `actor = system`, and the admin page (`/admin`, gated by `ORBIT_ADMIN_EMAILS`) shows it.
- **Retries**: queue backoff (§9.1); upstream calls retry 429/5xx up to 3 times with `Retry-After` or 1/2/4 s jitter; Google 401 → refresh token once.
- **Idempotency**: messages/threads/events by provider id; webhooks by event id; sends by draft id (status transition `approved → sending` is a single `update … where status = 'approved' returning *`); jobs by dedupe key.
- **Dead letters**: never retried automatically; `/admin` can requeue one or all of a kind after a fix.
- **Dashboards (SQL views)**: `orbit.v_reply_rates` (by goal/kind/variant/week), `orbit.v_queue_depth`, `orbit.v_costs` (by provider/day).

---

## 17. Build order (phases; each ships on its own)

| Phase | Ships | Depends on | Done when |
|---|---|---|---|
| **P1 Foundation** | `orbit` schema migration, queues, cron, Vault helpers; `orbit-api` auth + sessions + `/sync/status|pull|push`; `orbit-worker` skeleton; `orbit-webhooks` skeleton; functions bundling; client account-mode plumbing behind `VITE_ORBIT_API` | — | migration applied; functions deployed and answering `unconfigured` without Google secrets; unit + SQL tests green; local mode unchanged (all e2e green) |
| **P2 Models in core** | `tieScore` + explanations + calibration; ties v2 with confidence; path ranking v2 (`p_ask`, PPR, merge, reasons); reply classes v2; cadence v2 pure functions; compose v2 validator rules; safety rules; nicknames | — (parallel with P1) | anchors A1–A10 pass; holdouts ≥ 95%; all core tests green; the browser uses `tieScore` for `people.strength` in local mode too |
| **P3 Ingestion** | Gmail backfill + incremental + push; Calendar; Contacts; Unipile backfill + webhooks; resolution in ingestion; score/ties jobs | P1, P2 | with test credentials: a mailbox backfills, people/threads/ties/scores appear via `/sync/pull`; with none: jobs no-op cleanly |
| **P4 Research and sourcing** | Exa/Unipile dossiers; Apollo/Unipile/Exa/Semantic Scholar sourcing; Village v2 in both modes; `/paths/find` with mutuals | P1, P2 (P3 for real data) | function tests with recorded fixtures pass; chat tools `research_person`, `find_people` work in the sim |
| **P5 Outbound and replies** | compose v2; reply classification + voice replies; freebusy slots; autonomy levels; Gmail/LinkedIn sending server-side; cadence scan; scheduled sends | P3 | function tests; level-2 rules enforced; sim safety scenarios pass |
| **P6 Memory and UI** | memories + tools; Person page score/explanation/dossier; Sourcing in Discover; Replies in Drafts; Settings (account, autonomy, memory, data); onboarding first-run (§18) | P1–P5 | e2e for account mode with a mocked API; user-sim personas pass |
| **P7 Learning** | learned link prediction from intro outcomes; global weight refit from labels; compose A/B promotion; chat history server copy | data volume | metrics in §15 |

### Dependency graph

```
P1 Foundation ──┬──> P3 Ingestion ──┬──> P5 Outbound & replies ──┐
                │                   └──> P4 Research & sourcing ──┼──> P6 Memory & UI ──> P7 Learning
P2 Core models ─┴───────────────────────────────────────────────────┘
(P1 and P2 run in parallel; P4 can start on fixtures before P3 lands)
```

---

## 18. Onboarding and the first ten minutes

| Time | The user sees | Behind it |
|---|---|---|
| 0:00 | "Continue with Google" on the welcome step (local "try the demo" stays) | `/auth/google/start` |
| 0:20 | Google consent (Gmail read + send, Calendar read, contacts) | scopes §14.1 |
| 0:40 | Back in Orbit: "Hi Maya. I'm reading your last 90 days of email first." with a live count ("1,240 messages · 186 people so far") | `/sync/status` every 3 s; backfill `recent` running |
| 0:45 | Step "What are you working toward?": goal chips (Recruiting, Fundraising, Sales, Hiring, Advice, Co-founder, Community, Research collaboration), then targets (companies/roles or sector/stage) | `orbit.goals` |
| 1:30 | Step "Connect LinkedIn" (live via Unipile, or upload export, or later), with the risk sentence | hosted auth link |
| 2:30 | Step "Rate a few people" (optional): 10 cards "How close are you with …?" (1–5) | `tie_labels` |
| 3:00–6:00 | The chat opens with the first brief built from 90 days: "You've been talking with 23 people this quarter. 4 threads are waiting on you. Closest at Stripe: Maya Chen (88)." Map fills in; scores appear | `recent` done; scores job; first suggestions in the browser |
| 6:00 | First warm path for the first target ("Two ways into Stripe") | `/paths/find` |
| 10:00 | First drafted note, ready for approval | compose v2 |
| 10 min – 80 min | A quiet progress line ("Reading older email: 6,400 of 14,900") until `deep` backfill ends; then "Your full network is in. 412 people, 1,018 ties." | `deep` backfill |

---

## 19. Walkthroughs as four users, and what they changed

**1. Aisha, junior, recruiting for PM internships.** Connects Gmail; 90-day backfill finds career-fair recruiter mail and three alumni threads. *Broke:* recruiter auto-mail ("Thanks for applying") counted as two-way contact and inflated scores. *Fix:* `is_automated` covers ATS senders (Greenhouse, Lever, Workday, Ashby domains and `no-reply` patterns) and those threads never count in f3/f4 (§3.2). *Broke:* her goal "PM at fintech" had no company list, so sourcing had nothing to search. *Fix:* sourcing builds queries from roles + sector when organizations are empty (§6.1), and the chat asks for 3 dream companies once. *Missing:* she wanted to know when the deadline closes; goals gained `due_at` (§11.3).

**2. Daniel, founder raising a pre-seed.** Goal fundraising, sector climate software. Sourcing returns 40 investors from Exa and Apollo. *Broke:* the ranker put famous partners first though no path existed. *Fix:* `reach` weight 0.35 and the fundraising rule that cold first touches are offered only when no path has `P ≥ 0.15` (§4.2, §7.1). *Broke:* intro requests asked a weak tie (score 25) to vouch for him to a VC. *Fix:* fundraising first-hop floor 40 (§4.2). *Missing:* investors want a forwardable blurb; added the `forwardable_blurb` kind with double opt-in (§7.2). *Missing:* traction numbers change; they live as a `goal_detail` memory the composer reads (§10.1).

**3. Priya, new grad doing B2B sales.** Goal sales, ICP "ops leaders at 200–1,000-person logistics companies". Apollo search fits. *Broke:* sales sends are commercial; nothing enforced CAN-SPAM. *Fix:* §14.5 rules (opt-out line, postal address before first sales send, `unsubscribe` class). *Broke:* she wanted 40 first touches a day; Gmail and reputation risk. *Fix:* first-touch cap 30/day on Gmail for sales goals, existing per-person cooldown, Tue–Thu windows (§7.1); LinkedIn stays manual. *Missing:* follow-up step 2 for sales; added (§9.2).

**4. Wei, PhD student seeking collaborators.** Goal collaboration on "causal inference for genomics". *Broke:* LinkedIn search is useless for academics. *Fix:* Semantic Scholar + Exa `publication` sourcing (§6.1). *Broke:* dossiers missed papers. *Fix:* `collaboration` goals swap the third Exa query for `category: "publication"` (§5.2). *Broke:* the "15-minute call" ask reads oddly to professors. *Fix:* collaboration ask = a specific question about a paper (§7.2). *Missing:* university mail on Outlook; out of scope for v1 (Google only), stated on the connect screen; Microsoft Graph is a Phase 7 candidate.

---

## 20. Sources

**A. Tie strength** — Granovetter, "The Strength of Weak Ties", AJS 1973 (https://smg.media.mit.edu/classes/library/granovetter.weak.ties/granovetter.html); Marsden & Campbell, "Measuring Tie Strength", Social Forces 1984 (via Gilbert & Karahalios); Gilbert & Karahalios, "Predicting Tie Strength With Social Media", CHI 2009 (https://collablab.northwestern.edu/CollabolabDistro/nucmc/GilbertKarahalios-PredictingTieStrength-CHI09.pdf); Gilbert, "Predicting Tie Strength in a New Medium", CSCW 2012; Jones et al., "Inferring Tie Strength from Online Directed Behavior", PLoS ONE 2013 (https://pmc.ncbi.nlm.nih.gov/articles/PMC3534669/); Backstrom & Kleinberg, "Romantic Partnerships and the Dispersion of Social Ties", CSCW 2014; Rajkumar et al., "A causal test of the strength of weak ties", Science 2022 (https://ide.mit.edu/wp-content/uploads/2022/09/abl4476.pdf); LinkedIn PYMK (https://engineering.linkedin.com/teams/data/artificial-intelligence/people-you-may-know); Roth et al., "Suggesting Friends Using the Implicit Social Graph", KDD 2010; Kossinets & Watts, Science 2006; Kooti et al., "Evolution of Conversations in the Age of Email Overload", WWW 2015; Burt, "Structural Holes and Good Ideas", AJS 2004.

**B. Outbound** — Backlinko × Pitchbox, 12M outreach emails (https://backlinko.com/email-outreach-study); Boomerang, 40M emails (https://blog.boomerangapp.com/2016/02/7-tips-for-getting-more-responses-to-your-emails-with-data/); Hunter, 34M cold emails (https://hunter.io/blog/cold-email-word-count); Belkins 2025 (https://belkins.io/blog/sales-follow-up-statistics); Instantly 2026 benchmarks; Lavender benchmark (https://www.lavender.ai/blog/the-cold-email-benchmark-report); Gong (https://www.gong.io/blog/cold-email-stats); LinkedIn Talent Blog, InMail response rates (https://www.linkedin.com/business/talent/blog/talent-strategy/these-inmails-get-best-response-rates); Milkman, Akinola & Chugh, J. Applied Psychology 2015 (https://pages.stern.nyu.edu/dchugh/2015_JAP.pdf); Gompers et al., "How Do Venture Capitalists Make Decisions?", JFE 2020. Not used because unverifiable: DocSend "13×" and PitchBook "68%" warm-intro figures.

**C. APIs** — Gmail (https://developers.google.com/workspace/gmail/api/reference/rest, quota, push, sync guides), Calendar (https://developers.google.com/workspace/calendar/api/guides/sync), People API, Google restricted scopes and CASA (https://support.google.com/cloud/answer/13465431), Testing mode limits (https://support.google.com/cloud/answer/15549945); Supabase Queues, cron, Vault, pgvector, AI models, Edge Function limits; Unipile (https://developer.unipile.com/reference, limits: https://developer.unipile.com/docs/provider-limits-and-restrictions); Village v2 (https://docs.village.ai/api-reference/introduction.md); Exa (https://exa.ai/docs/reference/search); Apollo (https://docs.apollo.io/reference/people-api-search); Semantic Scholar Graph API (https://api.semanticscholar.org/api-docs/graph); LinkedIn User Agreement §8.2 (https://www.linkedin.com/legal/user-agreement); FTC CAN-SPAM guide; ICO PECR guidance; Proxycurl shutdown (https://nubela.co/blog/goodbye-proxycurl/).

**D. Open source reused** — `carltonnorthern/nicknames` (Apache-2.0, data vendored); `crisp-oss/email-reply-parser` (MIT, npm `email-reply-parser`); `postalsys/postal-mime` (MIT-0, only if raw MIME is ever fetched); `pgmq/pgmq` via Supabase Queues; patterns (not code) from `elie222/inbox-zero` (AGPL: do not copy code), `Mail-0/Zero` (MIT), `dzhng/deep-research` (MIT: the breadth × depth query loop informs §5.2), `exa-labs/company-researcher` (MIT: query templates), `ethanplusai/harvey` (MIT: deterministic pre-send gate informs §14.6). Rejected: `kaymen99/sales-outreach-automation-langgraph` and `Cold-IQ` skills (no license); `langchain-ai/people-researcher` (archived, no license).

---

## 21. Human actions (consolidated)

| # | Action | Why | Environment variables / where |
|---|---|---|---|
| H1 | Create a dedicated Supabase project for Orbit (Pro plan) and give its ref | The current project is shared with other apps; Orbit stores restricted Gmail data | GitHub repo variables `ORBIT_SUPABASE_REF`; then re-run migrations and deploys there |
| H2 | Create a Google Cloud project for Orbit, an OAuth client (Web application) with redirect URI `https://<ref>.supabase.co/functions/v1/orbit-api/auth/google/callback`, consent screen in Testing with test users | Server-side Google sign-in and Gmail | Supabase secrets `ORBIT_GOOGLE_CLIENT_ID`, `ORBIT_GOOGLE_CLIENT_SECRET`; repo variable `VITE_GOOGLE_CLIENT_ID` (local mode) |
| H3 | Enable Gmail, Calendar, People and Pub/Sub APIs; create topic `orbit-gmail`, grant `gmail-api-push@system.gserviceaccount.com` Publisher; create a push subscription to `https://<ref>.supabase.co/functions/v1/orbit-webhooks/gmail?token=<ORBIT_PUBSUB_TOKEN>` | Gmail push | Supabase secrets `GMAIL_PUBSUB_TOPIC` (= `projects/<gcp project>/topics/orbit-gmail`), `ORBIT_PUBSUB_TOKEN` (Orbit generates it; copy into the subscription URL) |
| H4 | Submit the OAuth app for verification and book a CASA Tier 2 assessment (annual) | `gmail.readonly` is restricted | — (timeline and fee set by the assessor lab) |
| H5 | Unipile account and key; then run `pnpm tsx scripts/unipile-webhooks.ts` once | Live LinkedIn | `UNIPILE_API_KEY`, `UNIPILE_BASE_URL` (exists), `ORBIT_UNIPILE_WEBHOOK_SECRET` (Orbit generates) |
| H6 | Village API secret key (v2) | Warm intro paths | `VILLAGE_SECRET_KEY` (replaces `VILLAGE_API_KEY`), `VILLAGE_BASE_URL` = `https://api.village.do` |
| H7 | Exa API key | Research and sourcing | `EXA_API_KEY` |
| H8 | Apollo API key with People API Search (and Organization Search on a paid plan) | Sourcing | `APOLLO_API_KEY` |
| H9 | Semantic Scholar API key (optional; raises rate limits) | Academic sourcing | `SEMANTIC_SCHOLAR_API_KEY` |
| H10 | Top up Anthropic credits on the key behind the proxy | Every LLM feature | `ORBIT_ANTHROPIC_API_KEY` (exists) |
| H11 | A postal address for CAN-SPAM in sales goals | Commercial email law | entered by each sales-goal user in Settings |
| H12 | Decide admin emails | `/admin` health page | `ORBIT_ADMIN_EMAILS` |

Generated by the implementer (no human needed): `ORBIT_SESSION_SECRET`, `ORBIT_CRON_SECRET` (also stored in Vault as `orbit_cron_secret`), `ORBIT_PUBSUB_TOKEN`, `ORBIT_UNIPILE_WEBHOOK_SECRET`. Client build variables: `VITE_ORBIT_API` = `https://<ref>.supabase.co/functions/v1/orbit-api`.
