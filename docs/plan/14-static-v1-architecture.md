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
| Gmail send via API, delayed 60 s for undo (Inngest) | Gmail API when Google is connected, queued in the browser for the same 60 s undo window; otherwise a `mailto:` hand-off. LinkedIn is always copy-and-open. See §6 |
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
- `@orbit/web`: integration tests against fake IndexedDB that replay the demo mailbox through the real ingest pipeline and assert derived stages, brief contents, approval binding and stage advance, cooldown enforcement, warm-up completion, note matching, Reach paths and company routes, idempotent CSV import; `engine/send.test.ts` covers sending against a fake Gmail (threading and headers, the undo queue, hand-offs, caps and cooldowns, idempotent approval, re-validation, sync de-duplication, API retries).
- Playwright: 10 end-to-end tests over the built site (demo load, approve-and-send with edit, warm-up card, pipeline board/table/companies, profile tabs, orbit map + Reach for a person and a company, dictated note capture, Discover start, export and wipe, manual onboarding with a CSV upload).

## 4. Migration to the hosted plan

1. Replace `apps/web/src/db` with repositories over Supabase (same table names; `03` DDL), keeping `@orbit/core` untouched.
2. Move `apps/web/src/engine/*` into Inngest functions per `08`; the function bodies are already pure async functions over the repo.
3. Swap `integrations/google.ts` for the server OAuth flow (04 §2) and `integrations/anthropic.ts` for `packages/ai` with `runTask()` (05 §3).
4. Add enrichment (04 §3.3) to fill `affiliations`; the edge inference and Reach code already consume it.
5. Turn the brief page into the Resend email (07 §8).

## 5. Limits of the static build to tell users

- Data lives in one browser profile; clearing site data deletes it (Export exists).
- Google sessions last about an hour; the app asks to reconnect. The first connection shows Google's consent screen; later reconnects pass an empty prompt, so Google skips the screen unless a permission is still missing (a partial grant keeps asking, and Disconnect revokes the grant so the next connection asks again).
- Orbit asks for `gmail.readonly`, `gmail.send`, `calendar.events.readonly` and `openid email profile`. The scopes Google actually granted are stored on the integration row and the token. Settings and onboarding say in plain words what a missing permission means; without `gmail.send`, approved email hands off to the mail app instead of failing at send time, and a 403 for a missing permission reads as "Google did not give Orbit permission for this".
- With no API key, drafts are template-based: correct and specific but not as fluent as Claude's.
- LinkedIn connections only arrive through the user's own export.

## 6. Sending, undo and hand-offs

What `engine/send.ts` does when the student presses Approve (the hosted plan's `approveSuggestion` + delayed `orbit/message.send`, 07 §5):

1. **Re-validate, then check the send rules, before anything changes.** The text about to go out is run through the core validator (`reviewDraft`). Problems the student's edit introduced keep the validator's blocking flag (wrong name, template phrase, dash, placeholder, instruction-like text, banned subject); problems already in Orbit's draft and style points in the student's own words only warn. A LinkedIn connection note over 300 characters always blocks. Then `checkSendAllowed`: the daily cap per channel (sent plus queued), the per-person cooldown, a declined chat, and the bump limit. The editor shows all of this inline before the click. A blocked approval leaves the draft and its suggestion untouched.
2. **Cooldown semantics.** The per-person cooldown (default 72 h) applies only to new outreach and bumps, the asks that can go unanswered. Replies, scheduling, thank-yous and congratulations are never held back. A Gmail reply after the last message, or the chat being in Replied or later since then (including a manual move), counts as an answer. Only the chat the message is about is checked for Declined, so an old declined chat does not block outreach started fresh later.
3. **Gmail connected: queue with a 60 s undo.** The message moves `draft → queued` with `sendAt = now + 60 s` in a single IndexedDB transaction, so a double click or two open editors cannot approve it twice. The card and composer show "Sending to Dana in N seconds" with Undo (back to `draft`). `OutboxScheduler`, mounted in the app shell, calls `sendDueQueued` every few seconds; it claims each due message `queued → sending` atomically and sends it. A queue found more than 10 minutes late (Orbit was closed) or a send interrupted mid-flight goes to `failed` with a reason instead of being sent blindly.
4. **Threading and headers.** A message in an existing conversation always goes out with the thread's subject as `Re: <subject>` (never an empty or made-up subject), the Gmail `threadId`, `In-Reply-To` set to the latest message in the thread and `References` carrying that message's chain. Header values are stripped of CR/LF, non-ASCII is RFC 2047 encoded, long headers are folded, and the body is base64 UTF-8. Every send carries `X-Orbit-Message-Id`.
5. **After a successful send** (`finalizeSent`): the message is `sent`, the suggestion `sent`, approve/edit feedback is logged, an outbound touchpoint is written, the chat advances (outreach to `outreach_sent`; a `reply` moves to scheduling only when it confirms or proposes a time), and outreach approved from a recommendation opens its chat (`identified → outreach_sent`, source `recommendation`) and converts the recommendation. For a Gmail API send, the returned `threadId` is stored on the message, a thread row is created or linked to the chat (`chat.threadId`), and the sent message is stored with the Message-ID Gmail assigned, so follow-ups reply in the same thread.
6. **Next sync.** An email whose `X-Orbit-Message-Id` (or Gmail id) matches an outbound row is recognised as Orbit's own send: its touchpoint is keyed to the outbound row, so it is not counted twice, and the stage change is not applied again. A chat found by person learns its thread.
7. **No Gmail, or LinkedIn: hand-off.** The message becomes `handed_off`, not `sent`. Email opens the mail app (`mailto:` with `Re: <subject>` for a thread). LinkedIn copies the text and opens compose for a connection, or the profile for everyone else, where the student clicks Connect, Add a note and pastes the note. The copy starts inside the click; the toast only says "Copied" when the clipboard write succeeded. The mail app opens through a link click (not a popup); LinkedIn opens in a new tab, and when the browser blocks that tab the toast offers an Open LinkedIn button that opens it inside a fresh click. While the message is handed off the card also has Open again. The card shows "Mark as sent when you have sent it" with **I sent it** (records it as sent, with the touchpoint and stage change) and **Not sent, edit it** (back to `draft`). A person with no email and no LinkedIn profile gets an error, never a hand-off.
8. **Retrying.** Provider failures leave the message `failed` with the reason and the suggestion pending. Approvals → Outbox lists queued, handed-off and failed messages, with Undo, I sent it, or the editor to try again.
9. **API limits.** Google calls retry 429 and Gmail's 403 rate-limit responses with exponential backoff (honouring `Retry-After`, at most 4 retries); server errors are retried only for reads, so a send is never duplicated.

