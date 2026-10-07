# 14. Static v1: what was built and how it maps to the hosted plan

Status: as-built note for the first shipped version (browser-only, GitHub Pages). The hosted architecture in 02–12 remains the target; this document records the deltas so the migration is mechanical.

---

## 1. Shape

| Hosted plan (02) | Static v1 (shipped) |
|---|---|
| Next.js app + Supabase Postgres | Vite + React SPA; **Dexie (IndexedDB)** in the browser with the same tables and column names as 03 (camelCase) |
| Inngest jobs | The same engine functions run in the page: on app open (daily brief), after each sync/import/note/approval (⚡ rules), and from buttons (Refresh) |
| Server-side Gmail OAuth with refresh tokens | **Google Identity Services token flow** in the browser (1-hour access token, user re-consents); Gmail + Calendar REST called directly; the OAuth client ID is pasted into Settings |
| Claude via server with cost accounting | Optional **personal Anthropic API key** in `localStorage`; `@anthropic-ai/sdk` with `dangerouslyAllowBrowser`; model `claude-opus-5-5`; structured outputs via `messages.parse` + `zodOutputFormat`; every task has a deterministic fallback in `@orbit/core` so the product works with no key |
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

- `@orbit/core`: unit tests (normalisers, resolution decisions, strength, paths, edges, layout, transitions, triage, signals, time extraction, note extraction, warm-up, drafts for every kind through the validator, style card, suggestion rules over the demo dataset, recommendations, CSV, resume) and a corpus of more than 60 recruiting emails (`src/__tests__/fixtures/email-corpus.ts`) that pins the signal, the extracted times and the quote/signature stripping for each message.
- `@orbit/web`: integration tests against fake IndexedDB that replay the demo mailbox through the real ingest pipeline and assert derived stages, brief contents, approval binding and stage advance, cooldown enforcement, warm-up completion, note matching, Reach paths and company routes, idempotent CSV import; plus ingest tests for explicit timezones, send-as aliases, out-of-office return dates (also for responders without auto-reply headers), quoted `"Last, First"` addresses, campus recruiting inboxes, signature titles, CC'd intros, calendar invitations, thank-you notes and Gmail's wrapped quote headers.
- Playwright: 10 end-to-end tests over the built site (demo load, approve-and-send with edit, warm-up card, pipeline board/table/companies, profile tabs, orbit map + Reach for a person and a company, dictated note capture, Discover start, export and wipe, manual onboarding with a CSV upload).

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
