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
| Approve & send queued for 60 s with an Undo toast (01 §6, 07 §4, 12 D12) | **Not built.** Approval binds the text and acts at once: the Gmail API sends immediately, or the `mailto:`/LinkedIn hand-off opens. There is no queued send and no undo window, so the editor is the last chance to change a draft |
| Granola webhook/API | Paste or upload into the capture box (Granola layout recognised); the capture box is the Wispr Flow integration |
| Drafting rules (05 §7) | Template engine in `packages/core/src/drafts` written to the outreach playbook (15): limits per kind, connection first, sector register, banned phrases; the optional LLM pass must clear the same validator |
| LinkedIn warm-up (13) | Built as specified, except the cancel action (13 §5) and the reply-rate metric (13 §7), which are hosted only |
| Product analytics (PostHog, 11 §5) | Not built; nothing about usage leaves the browser. Feedback events stay local and appear in the export |
| Demo seed (`pnpm seed:demo`, 12 Phase 0) | `buildDemoDataset` in `packages/core/src/demo/seed.ts` and `loadDemo` in `apps/web/src/engine/demo.ts`, see §3 |

## 2. Repository layout

```
packages/core   pure domain logic: types, normalisers, entity resolution, strength, edges, Yen paths, orbit layout,
                stage machine, email triage/signals, note extraction, style card, draft templates + validator,
                warm-up rules, suggestion rules/scoring/selection, recommendations, LinkedIn CSV, resume parser, demo seed
apps/web        db/ (Dexie schema + repo), engine/ (people, ingest, stages, notes, brief, send, graph, linkedin, resume,
                sync, demo, account), integrations/ (google, anthropic, prefs), pages/, components/, ui/, e2e/
.github/workflows/deploy.yml   lint → typecheck → unit → build → e2e → deploy to Pages on main
```

## 3. The demo

"Try it with demo data" (and Settings → Reset to demo) loads one junior's recruiting season, deterministic for a given day (seeded PRNG, seed 42), with every date relative to the moment it is loaded and on a business day (weekends, Independence Day, Christmas Eve and Day, New Year's Eve and Day are skipped, and earlier chats stay out of the winter break, Dec 20 to Jan 2).

- **Showcase, written by hand** (`buildDemoDataset`): about fourteen people whose title, firm, school and dates agree with what their threads say, and threads written to the playbook (15): a cold outreach due a bump, an alumna asking for times, a proposed slot still ahead, a booked chat the other side moved (the next business day, so a prep card whatever day the demo is loaded), a chat that just ended with a Granola note, a mentor thanked seven weeks ago who made an introduction, a referral offer on a target whose posting closes soon, a decline confirmed at the time and one waiting for confirmation, an out-of-office auto-reply, a recruiter's process email, last spring's chat with a check-in, and a LinkedIn warm-up in progress.
- **Texture, generated**: the other LinkedIn connections (titles drawn from each firm's own ladder and gated by years since graduation, with the earlier titles that led to a senior one, so nobody holds a senior title from the month after graduating; jobs only after graduation; unique names; firm-style addresses) and a few closed loops from earlier in the year, two of them reached through an introduction. Each earlier conversation has its own topic (subject, question, the advice the thank-you names and a summer check-in that refers back to that same advice), and replies, confirmations and thank-yous are worded differently from thread to thread.
- **Replay** (`loadDemo`): mail, calendar invites and moves, meetings ending, notes, the daily timer and the student's confirmation of the old decline are replayed through the real pipeline in time order, each step on its own clock, so stages and their timestamps come from the engine (`followed_up → nurturing` included). Suggestions raised along the way belonged to their moment and are dropped, and so are notifications from before the previous business day (on a Monday, Friday's replies are still news); the welcome brief is then computed once on the final state, with every note's facts in place.
- Tests pin it: `packages/core/src/__tests__/demo-seed.test.ts` (plausible people and careers, business days, copy rules, no subject or sentence shared between threads, no time zone in a proposed time, the heuristics read each message as annotated, for every load day of a year) and `apps/web/src/engine/demo.test.ts` (every seeded stage is what the replay derives; the brief has the thank-you, prep, confirm, propose, bump, warm-up and referral cards; the thank-you cites the note; loaded on a Friday morning or evening, a weekend or a Monday evening, the brief still has its prep card and the last business day's replies).

## 4. Tests

- `@orbit/core` (Vitest): normalisers, resolution decisions, strength, paths, edges, layout, transitions, triage, signals, time extraction, note extraction, warm-up, drafts for every kind through the validator and the playbook checks, style card, suggestion rules over the demo dataset, recommendations, CSV, resume, and the demo seed's invariants.
- `@orbit/web` (Vitest, fake IndexedDB): `engine.test.ts` replays the demo through the real pipeline and asserts derived stages, brief contents, approval binding and stage advance, cooldown enforcement, warm-up completion, note matching, Reach paths and company routes, idempotent CSV import; `demo.test.ts` covers the demo itself (§3). Both pin the clock to a weekday, because the demo is laid out on business days.
- Playwright: 10 end-to-end tests over the built site, with the browser clock pinned to a Tuesday morning (demo load and its brief, approve-and-send with edit, warm-up card, pipeline board/table/companies, profile tabs, orbit map + Reach for a person and a company, dictated note capture, Discover start, export and wipe, manual onboarding with a CSV upload).

## 5. Migration to the hosted plan

1. Replace `apps/web/src/db` with repositories over Supabase (same table names; `03` DDL), keeping `@orbit/core` untouched.
2. Move `apps/web/src/engine/*` into Inngest functions per `08`; the function bodies are already pure async functions over the repo.
3. Swap `integrations/google.ts` for the server OAuth flow (04 §2) and `integrations/anthropic.ts` for `packages/ai` with `runTask()` (05 §3).
4. Add enrichment (04 §3.3) to fill `affiliations`; the edge inference and Reach code already consume it.
5. Turn the brief page into the Resend email (07 §8).
6. Put the 60-second queued send and Undo in front of `approveAndSend` (07 §4), and emit the 11 §5 analytics events.

## 6. Limits of the static build to tell users

- Data lives in one browser profile; clearing site data deletes it (Export exists).
- Google sessions last about an hour; the app asks to reconnect.
- With no API key, drafts are template-based: correct and specific but not as fluent as Claude's.
- LinkedIn connections only arrive through the user's own export.
- Approve & send acts immediately (Gmail send or the mail-app hand-off); there is no undo window, so read the draft before approving.
