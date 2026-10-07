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
| `OrbitMap` (`react-force-graph-2d` wrapper), `MapFilters`, `ReachPanel`, `PathCard` | map state in Zustand: filters, hover, selected, reach query, rotation paused |
| `RecommendationCard`, `DiscoverSearch` | |
| `CaptureBox` (autosave, person picker, dictation hint), `NoteCard` | |
| `IntegrationCard` (status, scopes, last sync, reconnect/disconnect), `IngestAddress` (copy), `LinkedInExportGuide` (stepper with screenshots), `ResumeReview` (facet editor) | |
| `OnboardingStepper` | |
| Email templates (`react-email`): `BriefDaily`, `BriefWelcome`, `ReplyReceived`, `ChatTomorrow`, `IntegrationProblem`, `WeeklyRecap`, `ExportReady`, `DeletionReceipt`, `LinkedInExportReminder` | |

---

## 7. Accessibility and responsiveness

- All approval actions reachable by keyboard; focus order follows card order; live region announces "Sent" / "Snoozed".
- Mobile (≥ 360 px): Today and Approvals are single-column; the board becomes a stage picker + list; the map renders with 0.55× radii, no rotation, tap = select, long-press = recentre.
- Colour contrast AA; stage colours also carry text labels.

Static build (as shipped): dialogs (`Modal`, `Drawer` in `apps/web/src/ui`) close on Escape, trap Tab inside and return focus to the opener; every pipeline board card is one tab stop (the name link covers the card) and carries a "Move to…" stage menu, so drag and drop is never the only way to change a stage; icon-only buttons have an accessible name; hover-only controls (the fact delete button) also appear on keyboard focus. On phones the top bar carries Search, Add note and Settings next to the six-item bottom nav; headers, cards and action rows wrap instead of clipping, and wide tables scroll inside their card. Unknown person or company ids render a "can't find" state with a link back; unknown settings sections and onboarding steps redirect to a real one. The landing page never wipes an existing profile silently: an onboarded user sees "Open Orbit", a user mid-setup sees "Continue setup", and loading the demo over real data asks first (`demoResetPrompt`).

## 8. Terminology

One word per concept, everywhere in the UI. Internal codes (`swe`, `thank_you`, `gmail`, `family_friend`, `long_shot`) never reach the screen; they are mapped through `packages/core/src/labels.ts` (functions, message kinds, channels, relationship types, target-company statuses, reach bands, fact types, note sources, touchpoint kinds) and `STAGE_LABELS` in `pipeline/transitions.ts`.

| Concept | Word used | Not |
|---|---|---|
| How well the student knows someone (0 to 100) | Closeness, "Close ties" filter | strength, strong ties |
| How well two other people know each other | Tie strength | closeness |
| A tracked conversation with one person | coffee chat on first mention on a page, "chat" after | meeting, call |
| The queue of drafts and cards waiting on the student (route `/inbox`) | Approvals | Inbox, inbox zero |
| Ranked people to meet on Discover | recommendations | suggestions |
| A card on Today or in Approvals | suggestion or card | recommendation |
| The first message to someone new | First message (`outreach` in code; stage "First message sent", card chip "First message", Discover button "Write first message") | outreach, cold email |
| A message sent by Gmail or handed to LinkedIn | Email / LinkedIn | gmail, via gmail |
