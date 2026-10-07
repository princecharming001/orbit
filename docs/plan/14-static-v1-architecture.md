# 14. Static v1: what was built and how it maps to the hosted plan

Status: as-built note for the first shipped version (browser-only, GitHub Pages). The hosted architecture in 02–12 remains the target; this document records the deltas so the migration is mechanical.

---

## 1. Shape

| Hosted plan (02) | Static v1 (shipped) |
|---|---|
| Next.js app + Supabase Postgres | Vite + React SPA; **Dexie (IndexedDB)** in the browser with the same tables and column names as 03 (camelCase) |
| Inngest jobs | The same engine functions run in the page: on app open (daily brief), after each sync/import/note/approval (⚡ rules), and from buttons (Refresh) |
| Server-side Gmail OAuth with refresh tokens | **Google Identity Services token flow** in the browser (1-hour access token, user re-consents); Gmail + Calendar REST called directly; the OAuth client ID is pasted into Settings |
| Claude via server with cost accounting | Optional **personal Anthropic API key**, kept in a separate IndexedDB database (`orbit-local`, never in the export; older builds' `localStorage` copy is migrated and deleted on load; each write is applied to the freshly read row inside a transaction and announced to other open tabs over a `BroadcastChannel`, and every Claude call re-reads the row first, so a key removal, a feature opt-out or the daily usage count is shared by all tabs); `@anthropic-ai/sdk` with `dangerouslyAllowBrowser`; model `claude-opus-5-5`; structured outputs via `messages.parse` + `zodOutputFormat` (schemas from `zod/v4`, which the helper requires); every task has a deterministic fallback in `@orbit/core` so the product works with no key. Use is opt-in per feature (§6) under a daily request and token cap |
| Voyage embeddings + pgvector | Not used; fit uses keyword overlap and structured matches (05 §8.2 without the cosine term) |
| Enrichment (PDL) | Not called; affiliations come from the LinkedIn CSV (current employer) and, in the demo, seeded history. Edges therefore rely on co-thread, co-attendee and same-company signals until enrichment exists |
| Resend email delivery | In-app only; the brief is a page, not an email |
| Gmail send via API | Gmail API when Google is connected; otherwise a `mailto:` hand-off. LinkedIn is always copy-and-open |
| Granola webhook/API | Paste or upload into the capture box (Granola layout recognised); the capture box is the Wispr Flow integration |

## 2. Repository layout

```
packages/core   pure domain logic: types, normalisers, entity resolution, strength, edges, Yen paths, orbit layout,
                stage machine, email triage/signals, note extraction, style card, draft templates + validator,
                warm-up rules, suggestion rules/scoring/selection, recommendations, LinkedIn CSV, resume parser, demo seed
apps/web        db/ (Dexie schema + repo), engine/ (people, ingest, stages, notes, brief, send, graph, linkedin, resume,
                sync, demo, account), integrations/ (google, anthropic, prefs), pages/, components/, ui/, e2e/
.github/workflows/deploy.yml   lint → typecheck → unit → build → e2e → deploy to Pages on main
```

## 3. Tests

- `@orbit/core`: 33 unit tests (normalisers, resolution decisions, strength, paths, edges, layout, transitions, triage, signals, time extraction, note extraction, warm-up, drafts for every kind through the validator, style card, suggestion rules over the demo dataset, recommendations, CSV, resume).
- `@orbit/web`: 10 integration tests against fake IndexedDB that replay the demo mailbox through the real ingest pipeline and assert derived stages, brief contents, approval binding and stage advance, cooldown enforcement, warm-up completion, note matching, Reach paths and company routes, idempotent CSV import.
- Playwright: 10 end-to-end tests over the built site (demo load, approve-and-send with edit, warm-up card, pipeline board/table/companies, profile tabs, orbit map + Reach for a person and a company, dictated note capture, Discover start, export and wipe, manual onboarding with a CSV upload).
- Security and Claude-use tests: unit tests for the nonce wrapper against an email carrying a fake closing tag and "ignore previous instructions", the per-feature gate, the daily cap, failure mapping and the single notification, prefs migration out of `localStorage`, prefs changes made in one tab surviving writes from another, and sync retry of failed downloads; Playwright checks the built site runs under its CSP with no violations (and blocks injected inline script) and that a legacy key migrates and the per-feature toggles persist.

## 4. Migration to the hosted plan

1. Replace `apps/web/src/db` with repositories over Supabase (same table names; `03` DDL), keeping `@orbit/core` untouched.
2. Move `apps/web/src/engine/*` into Inngest functions per `08`; the function bodies are already pure async functions over the repo.
3. Swap `integrations/google.ts` for the server OAuth flow (04 §2) and `integrations/anthropic.ts` for `packages/ai` with `runTask()` (05 §3).
4. Add enrichment (04 §3.3) to fill `affiliations`; the edge inference and Reach code already consume it.
5. Turn the brief page into the Resend email (07 §8).

## 5. Limits of the static build to tell users

- Data lives in one browser profile; clearing site data deletes it (Export exists).
- Google sessions last about an hour; the app asks to reconnect.
- With no API key, drafts are template-based: correct and specific but not as fluent as Claude's.
- LinkedIn connections only arrive through the user's own export.

## 6. Claude use, prompt safety and browser security

- **Opt-in per feature.** Settings, Integrations lists what each feature sends to Anthropic. With a key saved, only drafting is on by default; reading synced email (triage and reply signals), note extraction, resume parsing and person summaries are off until the student turns them on. Email triage, when on, only sends threads the rules classify below 0.8 confidence, plus each new message in a 1:1 networking thread for signal extraction.
- **Daily cap.** Defaults: 50 requests and 300,000 tokens per local day, editable in Settings. Usage is counted on this device; at the cap calls stop and Orbit falls back to templates until the next day.
- **Failures surface once.** A failed call (rejected key, no network, rate limit, server error, refusal, unusable output, cap) raises one `integration_problem` notification with the reason while an unread one exists, records the last problem for Settings, and the caller falls back to templates and rules.
- **Untrusted content.** Every prompt wraps third-party text (email bodies and subjects, thread context, notes, resume text, names and titles from headers, facts, the template draft) in an element whose tag carries a random per-call nonce (`<untrusted_<16 hex>>`); any `<untrusted…` or `</untrusted…` inside the text is escaped and attribute values are quoted safely. The system prompt names the tag and says its content is data. The draft prompt keeps the student's own profile, style card, update and calendar windows outside the wrapper and everything about the recipient inside it. No prompt caching breakpoint is set: the system prompts are far below the minimum cacheable prefix.
- **Content-Security-Policy.** `index.html` carries a CSP meta tag: scripts only from this origin and Google Identity Services, network only to this origin, `api.anthropic.com` and the Google APIs used, no inline script, no `eval`, no plugins. The Vite dev server strips the tag because HMR needs an inline preamble. The Google access token stays in `sessionStorage` for the tab's lifetime.
- **Sync checkpoint.** `syncState.lastSyncAt` is the start time of the last completed run. Gmail messages whose download failed are kept in `syncState.failedIds` and retried at the start of the next run, up to 5 attempts; the completion notification counts failures and skips.
- **Export.** The JSON export contains every table, including full email text and headers; the Privacy page says so. It never contains the local prefs database.
