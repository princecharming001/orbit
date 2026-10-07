# 09. Application: routes, server actions, components

Status: build specification. The Next.js application: route tree, server actions (the only write API), route handlers (webhooks and OAuth), data loading, components and client state. Implemented in `apps/web`.

---

## 1. Principles

- Server components read; server actions write. No client-side database access except Supabase Realtime subscriptions on the tables allowed in `03` section 5.
- Every server action: `const scope = await requireScope()` → Zod-validate input → repository call → `revalidatePath`/`revalidateTag` → return a typed result `{ ok: true, data } | { ok: false, error: OrbitError }`. No throwing across the boundary.
- Route handlers exist only for webhooks, OAuth, file download, and the Inngest serve endpoint.
- Loading states use streaming (`loading.tsx`, `Suspense`) so the Today page paints the brief header within 300 ms and the cards as they resolve.

---

## 2. Route tree

```
app/
  (marketing)/page.tsx                      landing (sign in CTA, what we read, privacy)
  (auth)/sign-in/page.tsx                   Supabase Google sign-in
  (auth)/callback/route.ts                  Supabase auth code exchange
  (onboarding)/onboarding/[step]/page.tsx   steps 2..10 (01 §4); step guard redirects to users.onboarding_step
  (app)/layout.tsx                          app shell: left nav (Today, Pipeline, People, Map, Discover, Approvals, Settings), top bar (search ⌘K, + Note, avatar), Realtime provider
  (app)/today/page.tsx                      brief, cards, upcoming, needs-you, progress
  (app)/pipeline/page.tsx                   board | table (searchParams.view)
  (app)/pipeline/companies/page.tsx
  (app)/people/page.tsx
  (app)/people/[id]/page.tsx                profile; ?tab=timeline|facts|chats|connections
  (app)/people/[id]/prep/page.tsx           prep brief
  (app)/companies/[id]/page.tsx
  (app)/map/page.tsx                        orbit map; ?reach=<query|personId|url>&target=<orgId>
  (app)/discover/page.tsx
  (app)/inbox/page.tsx                      approvals: ?tab=pending|snoozed|sent
  (app)/settings/(sections)/profile|goals|integrations|notes|notifications|style|limits|privacy/page.tsx
  (app)/notes/new/page.tsx                  full-page capture (mobile-friendly)
  api/inngest/route.ts
  api/oauth/google/start/route.ts
  api/oauth/google/callback/route.ts
  api/webhooks/gmail/route.ts
  api/webhooks/resend/route.ts
  api/webhooks/granola/[token]/route.ts
  api/webhooks/fathom/[token]/route.ts
  api/webhooks/unipile/route.ts
  api/files/[kind]/[id]/route.ts            signed download (resume, export)
  api/health/route.ts
```

Drawers (profile, chat detail, draft editor) are intercepting routes (`@drawer` parallel slot) so deep links work: `/people/[id]` opens as a drawer from Pipeline/Map and as a page when loaded directly.

---

## 3. Server actions (`apps/web/src/actions/*.ts`)

| Action | Input | Effect |
|---|---|---|
| `saveOnboardingStep(step, data)` | per-step Zod | writes the step's tables; advances `onboarding_step`; emits step event |
| `uploadResume(formData)` | file | Storage put → `resumes` → T1 (streamed via `useActionState` polling `resumes.parsed_at`) |
| `confirmResumeFacets(resumeId, facets[])` | | updates facets, embeds |
| `saveGoals(data)` | `RecruitingGoalsInput` | upsert goals + target companies; T2; emit `goals.updated` |
| `connectGoogle()` | | returns the start URL |
| `disconnectIntegration(accountId)` | | status + emit `google.disconnected` (or provider-specific) |
| `uploadLinkedInExport(formData)` | zip/csv | Storage → emit `linkedin.csv.uploaded` |
| `connectGranola(apiKey)` | | validate by `GET /v1/notes?limit=1` → store encrypted → register webhook |
| `connectFathom(apiKey)` | | same shape |
| `regenerateIngestAddress()` | | new `ingest_token` |
| `importTracker(formData, mapping)` | csv + mapping | people + chats |
| `updateSettings(partial)` | `UserSettingsInput` | upsert |
| `createChat(personId | candidate, goalTags?)` | | `coffee_chats (identified)` + optional draft |
| `moveChatStage(chatId, stage)` | | `apply_stage_transition` actor user |
| `archiveChat(chatId)` | | |
| `decideStageEvent(eventId, confirm: boolean, correction?: stage)` | | applied/rejected + feedback |
| `draftMessage(personId, kind, channel, chatId?)` | | T8 → `outbound_messages (draft)`; returns the draft |
| `approveSuggestion(suggestionId, bodyFinal, subject?)` | | bind → emit `message.send` (delay 60 s) |
| `approveDraft(outboundMessageId, bodyFinal, subject?)` | | same without a suggestion |
| `undoSend(outboundMessageId)` | | cancel if `queued` |
| `snoozeSuggestion(id, until)` / `dismissSuggestion(id, reason)` | | status + feedback |
| `markPrepOpened(id)` | | |
| `addNote({ text, personIds, occurredAt, chatId? })` | | `meeting_notes (manual|wispr_capture)` → emit `note.captured` |
| `uploadNote(formData)` | | file → text → `meeting_notes (upload)` |
| `decideNoteMatch(noteId, personIds | reject)` | | |
| `decideMerge(suggestionId, accept)` / `mergePeople(aId, bId)` / `undoMerge(mergeId)` | | |
| `updatePerson(id, partial)` / `hidePerson(id)` / `deleteFact(factId)` / `addFact(personId, type, text)` | | |
| `saveRecommendation(id)` / `dismissRecommendation(id, reason)` / `startOutreachFromRecommendation(id)` | | converts candidate → person → chat → draft |
| `runReach(query)` | | sync when no enrichment is needed; else inserts `reach_queries` and emits `reach.query` (UI polls via Realtime) |
| `requestIntro(reachQueryId, pathIndex)` | | `intro_request` suggestion + draft |
| `requestExport()` / `requestDeletion()` / `cancelDeletion()` | | |
| `regenerateStyleCard()` / `pinStylePhrase(phrase)` | | |

All actions log to `audit_log` when they send, delete, merge, or change tokens.

---

## 4. Data loading (repositories, `apps/web/src/lib/repo/*.ts`)

Typed functions over Drizzle with mandatory `scope`. Key reads and their budgets (p95 on 2k-person users):

| Read | Query shape | Budget |
|---|---|---|
| `getTodayPage(scope, date)` | brief + suggestions (pending, selected) with person + draft; upcoming events (7 d) with people; proposed stage events; merge suggestions; integration problems; weekly stats | 120 ms, 6 queries |
| `getPipeline(scope, filters)` | chats with person, org, last touch, pending suggestion kind; paginated 200 | 80 ms |
| `getPerson(scope, id)` | person + identities + affiliations + facts + chats + last 50 touchpoints + edges with neighbours + pending drafts | 100 ms |
| `getMapData(scope)` | 06 section 7, cached 60 s | 150 ms |
| `getDiscover(scope)` | recommendations `new|saved` with reasons and paths | 60 ms |
| `searchPeople(scope, q)` | trigram on display_name + org name, limit 20 | 40 ms |

Mutations invalidate with `revalidateTag('user:<id>:<table>')`.

---

## 5. Realtime

Client subscribes (Supabase JS, anon key + session) to `postgres_changes` on `notifications`, `suggestions`, `coffee_chats`, `sync_runs` filtered by `user_id = auth.uid()` (RLS enforced). Events trigger TanStack Query invalidation (`['today']`, `['pipeline']`, `['person', id]`) rather than patching state by hand. Toasts for `reply_received` and `note processed`.

---

## 6. Components (`apps/web/src/components`)

| Component | Notes |
|---|---|
| `AppShell`, `SideNav`, `TopBar`, `CommandPalette` (⌘K: people, companies, actions "Draft message to…", "Add note") | |
| `BriefHeader`, `SuggestionCard` (variants per kind), `DraftEditor` (textarea + subject, word count, validator warnings inline, "Reset to suggested"), `UndoToast` | approval UI; keyboard: `a` approve, `e` edit, `s` snooze, `d` dismiss, `j/k` move |
| `PipelineBoard` (dnd-kit), `PipelineTable` (TanStack Table), `StageStepper`, `ChatDrawer` | |
| `PersonHeader`, `StrengthDots`, `Timeline` (virtualised), `FactsPanel`, `TalkingPoints`, `ConnectionsPanel` | |
| `OrbitMap` (a thin React wrapper over `OrbitScene`, one canvas animated with the tweens and springs in `motion.ts`), `MapPage` panels (routes, company list, Introductions chains) | map state is React state in `MapPage`: filter, focus (company, route, Introductions match), hover; the scene keeps its own animation state (06 section 6.1) |
| `RecommendationCard`, `DiscoverSearch` | |
| `CaptureBox` (autosave, person picker, dictation hint), `NoteCard` | |
| `IntegrationCard` (status, scopes, last sync, reconnect/disconnect), `IngestAddress` (copy), `LinkedInExportGuide` (stepper with screenshots), `ResumeReview` (facet editor) | |
| `OnboardingStepper` | |
| Email templates (`react-email`): `BriefDaily`, `BriefWelcome`, `ReplyReceived`, `ChatTomorrow`, `IntegrationProblem`, `WeeklyRecap`, `ExportReady`, `DeletionReceipt`, `LinkedInExportReminder` | |

---

## 7. Accessibility and responsiveness

- All approval actions reachable by keyboard; focus order follows card order; live region announces "Sent" / "Snoozed".
- Mobile (≥ 360 px): Today and Approvals are single-column; the board becomes a stage picker + list; the map scales to fit, holds still (no drift), and a first tap names a person while a second opens them; the person's card spans the map at its top or bottom, whichever hides fewer people, never the tapped person, and stays clear of the tab bar (from 640 px up it sits next to the dot). Toasts span the screen less a margin, wrap long messages inside the pill and sit under the top bar, clear of the tab bar.
- Colour contrast AA; stage colours also carry text labels.

Usability round 1 (static build): every draft card on Today and in Approvals has a visible **Review draft** button (the preview itself also opens the editor, and its two-line clamp never shows half a third line); the editor shows **To:** and a labelled **Subject**, says "Goes as a reply in your email thread" for threaded mail, and its approve button says what happens (see the terminology table). Destructive or surprising actions confirm or offer Undo: merging two people is a second step that shows both records and what they share; Dismiss, Snooze, Hide, removing a target company, moving a chat and dismissing a recommendation raise a toast with **Undo**. Toasts wrap onto several lines, sit above the phone tab bar, keep at most two on screen, carry a close button and clear when the page changes (unless raised for that move). First-run hints (`FirstRunHint`, ids `today` and `pipeline`) explain Today and the Pipeline board once; **Got it** stores the id in `settings.dismissedHints`, so they never come back. A link can point Today at one card (`/today?card=<suggestionId>` or `/today?person=<personId>`): Today opens the "can wait" list if needed, scrolls to the card and outlines it; Pipeline next-step chips, a started warm-up and a saved note use it. A new student with an empty network gets **Add a person** (name, company, role, and an email or LinkedIn link; `addPersonByHand`) on Today, People, Pipeline and Discover, with one-click "Someone at <target company>" shortcuts; Google appears only when this copy of Orbit has a built-in client ID (`VITE_GOOGLE_CLIENT_ID`), otherwise the client ID field waits behind "For developers: connect your own Google Cloud project" (in Settings the Google card then says it is not part of this version and sits last). Onboarding addresses its steps 1 to 7 (`/onboarding/1` is About you; `user.onboardingStep` keeps the internal 2 to 8), shows "Step N of 7" with a seven-segment bar whose optional steps read **skipped** (not done) when nothing was added, saves the goals step on Back as well as Continue (a company typed but not added included), marks required fields, says what is missing while Continue is disabled, and shows one button on optional steps ("Skip for now" until something is done, then "Continue"). Pipeline: a stage legend, a "N more stages" button while columns are off to the side, a **Went quiet** filter (the student wrote last, 7 or more days ago, chat in First message sent, Replied or Scheduling), sortable table headers with `aria-sort`, and an undo toast on every move. Writing to someone new does not create a chat: the chat (and its Pipeline card) opens when the first message is approved and sent, or when a warm-up starts. On phones People is a one-column list instead of the table, and the Settings sections wrap instead of scrolling sideways.

Usability round 1, second pass: **Import LinkedIn connections** on an empty Today, People or Discover opens the file picker itself (`LinkedInImportButton`, also used in Settings), and the upload rebuilds recommendations and, after setup, the brief (`importLinkedInExport`), so the toast can say how many people are worth meeting and link to Discover. Every file upload (resume, LinkedIn, note) is a keyboard-reachable input. **Start warm-up** on Discover keeps the student on the list; the toast links to the step on Today. Each page and each onboarding step opens scrolled to its top. The onboarding asks for the graduation year (no default, since it decides "junior" or "senior" in every message). The draft box grows with the message so the sign-off is never hidden inside it. Facts that answer the same question differently (two hometowns, two teams) are marked on the Facts tab (`conflictingFacts`), and deleting a fact offers Undo. A note can add the person it was with when they are not in Orbit yet. The profile summary speaks to the student ("She offered to refer you"). Pipeline matches target companies on the normalized name ("McKinsey" covers "McKinsey & Company").

Usability round 2: **Add note** never fills "Who was this with?" on its own; under the picker a line says who Orbit will file the note with and why (`previewNoteMatch`: a notetaker title line such as "Meeting summary - Hannah Brooks (Figma) / Alex Rivera", a full name in the text, then the calendar chat that just ended), and `ingestNote` follows the same order, so a note naming someone else is never filed with the meeting that just ended. Saving says when the note moved the chat's stage and lands on the person page, whose **Waiting on you** section shows the thank-you draft and any message opened in the mail app or LinkedIn but not confirmed. Drafts the student edits are saved as they type (`bodyFinal`), and **Write to** reopens the draft already started. A draft opened in the mail app leaves Ready to send and waits under **Not sent yet** (the page opens there when something waits) and in **Did these go out?** on Today. The student's own ordinary words ("reach out") are a suggestion, not a block; form-letter openers still block. Moving a chat to Scheduled without a meeting on the calendar asks **When is the chat?** (`scheduleChatAt` stores a `manual:` event, so it shows under Coming up, gets prep, and moves to Completed once it has passed); moving one to Completed raises its thank-you at once (`moveChat`). On phones the Pipeline board stacks its stages and lists the empty ones in one line; with a filter on, only stages that hold a match are shown; the "N more stages" button sits above the columns. Toasts show one at a time, under the top bar on phones, for at most five seconds unless they carry an action. The demo shows a banner with **Set up Orbit for me** (`leaveDemoForOwnSetup`), and the landing page in the demo offers the same. Onboarding has five steps without a built-in Google client ID (About you, Recruiting for, Resume, LinkedIn, Preferences) and six with one; meeting notes are a tip on the last step. A weak duplicate guess (different first names, no shared address) waits under "can wait". The stage `followed_up` reads **Thanked**.

Usability round 3 (never lose the student's work, honest hand-offs): **Cancel** on a draft whose text or subject changed since it opened asks **Keep your changes?** (Keep changes, Discard changes, Keep editing); edits are saved as typed, when the editor closes, and when the tab is hidden, so leaving a page never drops them. A draft the student starts on a person's page (Write to, the Map, Discover) belongs to no card; it is a **started draft** (`startedDrafts`: status `draft`, no `suggestionId`) and waits under **Waiting on you** on the person page (Continue writing, Discard draft with Undo), under **Started by you, not sent yet** on Drafts (counted in Ready to send and in the nav badge) and under **Drafts you started** on Today; `/people/<id>?open=<draftId>` reopens it. **Write to** reopens a started draft before asking about the warm-up again; Cancel on a draft nobody wrote anything in drops it. The kind of message is a choice only when more than one kind fits; a single kind shows no button. **Copy text** is a hand-off like the mail app (`approveAndSend(..., { via: 'copy' })`, `handoffVia: 'copy'`): it is disabled while a required line is missing, copies the subject too (the `Re:` subject for a reply), and the message waits for **I sent it** under Not sent yet. Sending the answer to a **Confirm time** card books the chat at that time (`scheduleChatAt`, unless a meeting is already on the calendar), so it shows under Coming up with prep the day before. Today names the next step when there are no cards: a draft to finish, or **Next: write to the people you added** (`notYetWritten`: added by hand in the last 30 days, no chat, message or card), and only then Discover (when it has recommendations) or Add a person; its side column lists **Waiting on a reply** (chats that went quiet without a follow-up card) with a **They replied** button. Discover rebuilds its list when it opens, and an empty list says when everyone who fits is already in the Pipeline. Without Google, the landing page, Today and Pipeline say that Orbit cannot see the inbox and that the student moves a chat when someone answers. The Pipeline table shows the company under the name so it fits 1280 px; on the board an empty stage is narrow, and a chip says how many cards with a next step are off to the right and scrolls to them.

Static build (as shipped): dialogs (`Modal`, `Drawer` in `apps/web/src/ui`) close on Escape, trap Tab inside and return focus to the opener; every pipeline board card is one tab stop (the name link covers the card) and carries a "Move to…" stage menu, so drag and drop is never the only way to change a stage; icon-only buttons have an accessible name; hover-only controls (the fact delete button) also appear on keyboard focus. On phones the top bar carries Search, Add note and Settings next to the six-item bottom nav; headers, cards and action rows wrap instead of clipping, and wide tables scroll inside their card. The map is reachable from the keyboard: Tab focuses the canvas, the arrow keys move between people (the focused dot pops and shows its card, as on hover), Enter opens, and Esc lets go of the dot, then steps back out of a match, a route or company, and a filter, each with its reverse animation; a line under the filters says in words what the map shows whenever it changes (a search that finds no one says so there, and the search box shakes once), and it and the focused person are read out through polite live regions. With `prefers-reduced-motion` the map does not drift, travel or sweep: every change is instant or a fade of at most 140 ms. The canvas is `role="application"`, so screen readers pass the arrow keys through. Unknown person or company ids render a "can't find" state with a link back; unknown settings sections and onboarding steps redirect to a real one. The landing page never wipes an existing profile silently: an onboarded user sees "Open Orbit", a user mid-setup sees "Continue setup", and loading the demo over real data asks first (`demoResetPrompt`).

## 8. Terminology

One word per concept, everywhere in the UI. Internal codes (`swe`, `thank_you`, `gmail`, `family_friend`, `long_shot`) never reach the screen; they are mapped through `packages/core/src/labels.ts` (functions, message kinds, channels, relationship types, target-company statuses, reach bands, fact types, note sources, touchpoint kinds) and `STAGE_LABELS` in `pipeline/transitions.ts`.

| Concept | Word used | Not |
|---|---|---|
| How well the student knows someone (0 to 100) | Closeness, "Close ties" filter | strength, strong ties |
| How well two other people know each other | Tie strength | closeness |
| A tracked conversation with one person | coffee chat on first mention on a page, "chat" after | meeting, call |
| Messages Orbit drafted for the student to edit and send (route `/inbox`; tabs Ready to send, Not sent yet, Snoozed, Sent). "Ready to send" lists the drafts that are cards on Today, with the rest behind "Show N that can wait"; the nav badge counts exactly that tab (`draftLists`). Prep, warm-up and confirmation cards live on Today only | Drafts | Approvals, Inbox, Outbox, inbox zero |
| A message opened in the mail app or LinkedIn and not confirmed with "I sent it", or one that failed (the undo window too) | Not sent yet | In progress, Outbox, pending |
| Ranked people to meet on Discover | recommendations | suggestions |
| A card on Today or in Approvals | suggestion or card | recommendation |
| How well a recommendation fits the student's goals (0 to 100) / how easy they are to reach (0 to 100) | Match / Reach | Fit, Reachable |
| Finding who can introduce the student to someone (the map's path finder) | Find an intro, Find someone who can introduce you | Reach (as a button label) |
| How the drafts sound (onboarding and Settings) | Writing style | Tone |
| Send button on a draft | "Send to Priya" when Gmail sends; "Open in mail app" when it hands off to the mail app, next to "Copy text" for Gmail in the browser (both then wait for "I sent it"); "Copy & open LinkedIn" / "Copy note & open LinkedIn". Copy says "nothing goes out until you send it yourself" | Approve, Approve & send |
| Stage `identified` / `nurturing` | To contact / Staying in touch (each stage has a one-line meaning in `STAGE_HELP`, shown in the Pipeline legend) | Identified, Nurturing |
| The first message to someone new | First message (`outreach` in code; stage "First message sent", card chip "First message", Discover button "Write first message") | outreach, cold email |
| A message sent by Gmail or handed to LinkedIn | Email / LinkedIn | gmail, via gmail |
| The one line only true of the recipient that a first message needs from the student | Why them (the bracketed gap "[Why them: one line only true of Priya, ...]", the card line "Needs one line from you: Why them", the editor box "Why them"; `WHY_THEM` in core) | your link, your line, why you are writing to them |
| A draft the student started on someone's page and has not sent | started draft ("Drafts you started", "Started by you, not sent yet") | unsaved, pending |
