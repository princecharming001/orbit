# 01. Product specification

Status: build specification. Defines what Orbit does, for whom, every screen, every state, and the rules the engine follows. Technical documents (02 through 12) implement this document. If a technical document contradicts this one on *behaviour*, this one wins; if it contradicts on *names* (tables, events, routes), the technical document wins and this one gets a fix.

Confidence legend (shared with the rest of `docs/orbit/`): **[DECIDED]** a product decision, do not reopen without the founder; **[DEFAULT]** a number or rule chosen so the build can proceed, tune later with data; **[RESEARCHED]** backed by a citation in `04-integrations.md`; **[GAP]** unknown, research before building on it.

---

## 1. One page

Orbit is a networking copilot for college students who are recruiting. It connects to the student's Gmail, Google Calendar and LinkedIn data, learns what they are recruiting for and what they have done (resume), and then runs the whole coffee-chat loop with them:

1. **Find** the right people to talk to: alumni and people at target companies with overlapping interests, ranked by how reachable they are.
2. **Reach** them: drafts outreach in the student's own voice, over Gmail or LinkedIn, sent only after a tap.
3. **Track** every conversation through a pipeline (identified, outreach sent, replied, scheduling, scheduled, completed, followed up, nurturing) without manual data entry, because stages are inferred from email, calendar and notes.
4. **Remember** everything about each person: a profile with the full timeline, facts extracted from emails and from meeting notes (Granola, voice capture via Wispr Flow, manual), and talking points for next time.
5. **See** the network as a map: the student in the centre, people and companies in orbit by closeness; and, in Reach mode, the best path from the student to any target person or company through people they already know.
6. **Keep up**: every morning a brief lists the five to seven things worth doing today (follow up, thank, schedule, prep, reconnect, congratulate, ask for a referral), each with a ready-to-send draft that the student approves, edits, snoozes or dismisses.

The product never sends anything on its own. Every outbound email or LinkedIn message is approved by the student, bound to the exact text approved, and sent from the student's own accounts. [DECIDED]

Working name: **Orbit** (placeholder). The repository this plan lives in also holds a separate, unrelated product spec (Rooster, local-business GTM); the two share nothing except the confidence legend. [DECIDED]

---

## 2. Users and jobs to be done

### 2.1 Primary persona

A US undergraduate or master's student (sophomore to final year) recruiting for internships or full-time roles in a structured cycle: software engineering, product, investment banking, consulting, finance, data, design, or similar. They have a `.edu` Gmail or a personal Gmail they use for recruiting, a LinkedIn account with 200 to 1,500 connections, and a Google Calendar. They run 5 to 40 coffee chats a season and currently track them in a spreadsheet, Notion, or not at all.

What they are bad at today, in order of pain:

1. Following up. Outreach goes unanswered and they do not bump; chats end and no thank-you is sent; relationships go cold before the referral window.
2. Knowing who to reach out to next, and who in their network can introduce them.
3. Remembering what was said in chat 14 when writing to person 14 three weeks later.
4. Writing the message (fast enough, in their own voice, with a specific hook).

### 2.2 Jobs to be done (ranked)

| # | Job | Orbit feature |
|---|---|---|
| J1 | "Tell me what to do today for my recruiting network, and make it a tap." | Morning brief + approvals (section 6) |
| J2 | "Keep track of every coffee chat and where it stands without me typing it in." | Pipeline with inferred stages (section 5) |
| J3 | "Before I write to or meet someone, show me everything I know about them." | Person profile + prep brief (section 7) |
| J4 | "Find me the right people to talk to for the roles I want." | Discover (section 8) |
| J5 | "Show me how I can get to a specific person or company through people I know." | Map and Reach mode (section 9) |
| J6 | "Capture what happened in the chat without writing a report." | Meeting notes ingest: Granola, voice capture, manual (section 10) |

### 2.3 Non-goals for v1 [DECIDED]

- No autonomous sending at any level. (Unlike a sales tool, a student's reputation is the asset; one bad auto-send is fatal.)
- No scraping of LinkedIn by Orbit. LinkedIn data enters only through the student's own data export, the student's own session via a hosted-auth vendor (feature-flagged), or licensed enrichment providers. See `04-integrations.md`.
- No multi-user "shared network" or team features. A pooled campus graph is designed in `06-graph-and-reach.md` section 9 but ships after v1.
- No mobile app. Responsive web plus email is the delivery surface; the brief is designed to be cleared from a phone browser.
- No applications tracking (job postings, application status). Orbit tracks people and conversations; a `target_companies` list with a free-text status is the only concession.

---

## 3. The core loop and the engine's rules

### 3.1 Loop

```
onboard ──> sync (Gmail, Calendar, LinkedIn CSV, resume) ──> resolve people & companies
   ──> build graph & strengths ──> recommend who to reach ──> draft ──> APPROVE ──> send
   ──> watch replies & calendar ──> infer stage ──> ingest meeting notes ──> extract facts
   ──> nurture triggers ──> morning brief ──> APPROVE ──> ...
```

### 3.2 The five rules every subsystem obeys [DECIDED]

1. **Approval binds bytes.** A message is sent only if an `outbound_messages` row exists with `status = 'approved'`, the body hash at send time equals the hash approved, and the approving actor is the student. Edits create a new approval.
2. **Every claim in a draft traces to a fact.** A draft may mention a person's role, company, past conversation, or advice only if a `person_facts` or `touchpoints` row supports it; the drafting prompt receives only those rows and the validator rejects drafts citing anything else (see `05-ai-ml-system.md` section 7).
3. **Stages are inferred, never guessed silently.** A stage transition recorded by the system carries an evidence reference (message id, event id, note id) and a confidence; transitions under the confidence threshold become a one-tap confirmation card instead of a silent change.
4. **Cadence caps are code, not prompts.** No more than one outbound message per person per 72 hours unless the person replied in between; at most 2 unanswered bumps per thread; daily send caps per channel. Enforced in the send path, not in the suggestion generator. [DEFAULT numbers]
5. **The student can always see why.** Every suggestion, recommendation and path carries a human-readable reason built from stored signals, shown in the UI.

---

## 4. Onboarding

Goal: from sign-in to a first useful brief in under 12 minutes, with the Gmail backfill continuing in the background. Each step is skippable except 1, 3 and 5; skipped steps become cards on the Today page. [DEFAULT]

### 4.1 Steps

| Step | Screen | Collects | Writes to |
|---|---|---|---|
| 1 | Sign in with Google | identity, name, avatar | `users` (via Supabase Auth) |
| 2 | About you | school (autocomplete from a seeded list of ~4,000 US institutions), graduation month/year, degree, major(s), home city, current city, timezone (detected) | `users` |
| 3 | What you're recruiting for | recruiting cycle (e.g. "Summer 2027 internship", "Full-time 2027"), target roles (chips + free text), industries, target companies (autocomplete over `organizations`, free text allowed), target locations, deadlines (optional), ambition slider mapped to weekly outreach target (2 / 4 / 7 new people per week) | `recruiting_goals`, `target_companies` |
| 4 | Resume | PDF, Word (.docx) or plain text upload (10 MB max; legacy .doc and binary files are refused with a clear message); parsed into experiences, education, skills, projects, interests and an optional one-sentence summary; the student unchecks any extracted block that is wrong and Orbit never uses it (`resume_facets.excluded`); only the current resume's kept facets feed recommendations and drafts | `resumes`, `resume_facets` |
| 5 | Connect Gmail and Calendar | Google OAuth with the scopes in `04-integrations.md` section 2.1; the screen states in plain words what is read, that bodies are stored to build context, that nothing is sent without approval, and links the privacy policy (Google Limited Use language) | `integration_accounts` (provider `google`) |
| 6 | Connect LinkedIn | (a) paste profile URL; (b) upload the LinkedIn data export (Connections.csv at minimum; messages.csv and Invitations.csv if present) with step-by-step instructions and a "remind me by email when the export is ready" button (sends a Resend email after 15 minutes); (c) optional, behind flag `linkedin_messaging`: connect LinkedIn messaging via hosted auth (see 04 section 3.4) | `integration_accounts` (`linkedin_csv`, `unipile_linkedin`), `people`, `affiliations` |
| 7 | Meeting notes | shows the student's personal ingest address (`notes-<token>@in.<domain>`), explains the Granola share-by-email path and the webhook path, and the voice capture tip (Wispr Flow works in any text box, including Orbit's capture box) | `integration_accounts` (`granola`, status `instructions_shown`) |
| 8 | Preferences | brief delivery time (default 07:00 local), channels (email on, in-app on), quiet days, tone check (shows the style card built from sent mail once backfill has 20+ sent messages; until then, a 3-choice tone picker: warm / direct / formal), scheduling link (Calendly, Cal.com, Google appointment page; optional) | `user_settings`, `style_profiles` |
| 9 | Import existing tracker | CSV / Google Sheet export with column mapping UI (name, email, company, status, last contacted, notes) | `people`, `coffee_chats` (stage mapped from status column) |
| 10 | Done | "Your first brief is ready" once the fast path (sent mail of the last 90 days + calendar of the last 180 days + CSV) has processed; full backfill continues | `briefs` (kind `welcome`) |

### 4.2 Onboarding rules

- Step 5 starts `orbit/google.backfill.requested` immediately on consent; the UI shows a progress bar (threads processed / estimated) on the Today page until done.
- The welcome brief is generated as soon as the fast path finishes (target: under 5 minutes for a mailbox of 20k messages) and contains: detected existing coffee chats (threads classified as networking in the last 90 days, each as a pipeline card to confirm), the top 3 recommended people, and any upcoming calendar event that looks like a coffee chat.
- Resume parsing runs synchronously with a streamed progress state (upload, extract, structure) and must complete in under 30 seconds p95. [DEFAULT]
- Everything collected in onboarding is editable in Settings; nothing is only collectable once.

---

## 5. Pipeline (coffee chat tracker)

### 5.1 Entities

A **coffee chat** is one relationship-in-progress with one person, at one point in the student's recruiting. A person can have more than one coffee chat over time (a new one when the student re-engages after `nurturing` for a new cycle). A chat belongs to one person and inherits the person's current company for roll-ups.

### 5.2 Stages [DECIDED]

| Stage | Meaning | Entered by |
|---|---|---|
| `identified` | the student (or a recommendation) picked this person; nothing sent | user action, recommendation accepted, tracker import |
| `warming` | cold LinkedIn target; the student is engaging with their posts for a few days before messaging (see 13) | start outreach on a LinkedIn-only person with closeness < 0.2 |
| `outreach_sent` | first outbound message sent | send pipeline |
| `replied` | the person replied with anything that is not a decline | inbound classifier (`reply_positive`, `reply_neutral`) |
| `scheduling` | times are being negotiated | inbound classifier (`scheduling_proposal`) or outbound draft of kind `schedule_propose` sent |
| `scheduled` | a calendar event exists with this person as attendee, in the future | calendar sync |
| `completed` | the scheduled event ended, or notes were ingested for a meeting with this person | calendar sync (event end + 15 min) or notes ingest |
| `followed_up` | a thank-you or follow-up was sent after completion | send pipeline |
| `nurturing` | long-term relationship mode; cadence rules apply | automatic 14 days after `followed_up`, or user action |
| `declined` | the person said no, or asked not to be contacted | inbound classifier (`reply_decline`) with confirmation card, or user |
| `no_response` | 2 bumps sent and 14 days silent since the last | nightly rule |
| `archived` | user removed it from view | user |

Transitions are recorded in `coffee_chat_stage_events` with `evidence_ref` and `confidence`. Any transition with `confidence < 0.8` is recorded as `proposed` and surfaces as a confirmation card ("Looks like Priya replied and suggested Thursday. Move to Scheduling?"). The user confirms or corrects; corrections are feedback events. [DEFAULT threshold]

Backwards transitions are allowed by the user only (e.g. `scheduled` back to `scheduling` when a meeting is cancelled is automatic because the calendar event was cancelled; everything else manual).

### 5.3 Pipeline screen (`/pipeline`)

Two views, remembered per user:

- **Board**: one column per active stage (`identified` … `nurturing`); `declined`, `no_response`, `archived` are behind a "Closed" toggle. Cards show avatar, name, title at company, days in stage, last touch, and one chip: the next suggested action if one is pending ("Bump", "Thank", "Prep"). Drag between columns is allowed and creates a user-actor stage event.
- **Table**: sortable columns: person, company, stage, days in stage, last outbound, last inbound, next action, strength, source. Bulk actions: archive, add tag, export CSV.

Filters: stage, company, target companies only, source, tag, date range. Search by name/company.

**Companies roll-up** (`/pipeline/companies`): one row per organization: number of people, chats by stage, last activity, whether it is a target, and the best path strength (from `06`). Clicking a company opens the map filtered to that company.

### 5.4 Chat detail (drawer from any card)

Header (person, company, stage stepper), timeline (touchpoints newest first: emails as collapsed cards with expand, calendar events, LinkedIn messages, notes, system stage changes), facts panel (from `person_facts`, grouped: role, background, advice given, personal, hooks), action items, drafts (pending and sent), and a "Next" box with the current suggestion for this chat.

---

## 6. Today page and the morning brief

### 6.1 Today page (`/today`), the default landing after onboarding

Layout top to bottom:

1. **Brief header**: date, one-line summary ("3 follow-ups, 1 thank-you, 1 chat tomorrow with Daniel at Stripe").
2. **Suggestion cards** (5 to 7, ranked): each card = kind label, person (avatar, name, title, company), the reason (one sentence from stored signals), the draft (collapsed preview, expandable, editable inline), and actions: **Approve & send**, **Edit**, **Snooze** (tomorrow / 3 days / next week), **Dismiss** (with optional reason: "already did this", "not now", "wrong person", "bad draft"). Prep cards have **Open prep** instead of send.
3. **Upcoming**: calendar events in the next 7 days matched to people, each with a "Prep" link.
4. **Needs you**: proposed stage transitions awaiting confirmation; merge suggestions; integration problems (reauth), with exactly one recovery action each.
5. **Progress**: this week's outreach vs target, chats completed this season, reply rate (last 30 days).

### 6.2 Brief generation and delivery

- Generated nightly for each user at `brief_time_local - 60 min` (default 06:00 local), delivered at `brief_time_local` by email (Resend) and in-app; push notifications are v1.5. The email mirrors the cards with deep links; approvals happen in the web app (one tap on mobile web), never from the email itself (no magic-link sends). [DECIDED]
- Minimum 0 cards (then the email is not sent and the Today page says "Nothing to do today, your network is in good shape"), maximum 7. [DEFAULT]
- Suggestion kinds, triggers, ranking and guardrails are specified in `07-nurture-and-morning-brief.md`.
- "Approve & send" opens a 60-second undo toast; the send is queued with a 60 s delay and cancelled on undo. [DEFAULT]
- A suggestion not acted on by the next brief is carried over at most once, then expires with a feedback event `expired`.

### 6.3 Approvals centre (`/inbox`)

All pending suggestions and drafts across days (not only today's), plus a **Sent** tab (every message Orbit sent, with provider id and reply status) and a **Snoozed** tab.

---

## 7. People and profiles

### 7.1 People list (`/people`)

Searchable, filterable list of every person in the student's network who has at least one touchpoint or came from the LinkedIn export. Columns: name, title, company, relationship type, strength (0 to 100 shown as a 4-level dot), last interaction, pipeline stage (if any), tags. Filters: company, school (alumni), relationship type, strength tier, has chat, target companies only, source. Hidden by default: people with zero human interaction and not in the LinkedIn export (e.g. automated senders) and people the user hid.

### 7.2 Profile (`/people/[id]`)

- **Header**: avatar, name, headline, current title and company (with dates), location, school, LinkedIn link, email(s), relationship type (editable), strength with the breakdown on hover ("4 emails, 1 meeting, last 12 days ago"), tags.
- **Summary**: a 3 to 5 sentence narrative generated from facts and touchpoints (task `person_summary`), regenerated when new facts arrive, with "last updated" and the sources it cites.
- **Talking points**: 3 to 5 bullets for the next conversation (open action items, things they offered, their recent changes, hooks).
- **Timeline**: all touchpoints (emails, meetings, LinkedIn messages, notes, sends, stage changes).
- **Facts**: grouped and editable; each fact shows its source; the user can delete a fact (then it is never regenerated from that source).
- **Chats**: all coffee chats with this person, current one first.
- **Connections**: people in the student's network linked to this person (co-tenure, same school, co-threads), with the evidence; link to the map centred on this person.
- **Actions**: Draft message (choose kind and channel), Add note (text box that works with voice dictation), Log a meeting, Merge with…, Hide.

### 7.3 Companies (`/companies/[id]`)

Header (name, domain, industry, logo), people in the network at this company (current and former, with tenure), chats, target status, "best paths" (from Reach), and notes.

---

## 8. Discover

`/discover` shows ranked **recommendations**: people the student should start a coffee chat with. Sources (in `05-ai-ml-system.md` section 8): the student's own network (LinkedIn export, email contacts) filtered by fit, alumni and people at target companies found through enrichment search, and people adjacent to existing strong ties (former colleagues of mentors). Each card: person, why (fit reasons: "Alum, same major; PM at Figma, a target; worked with your contact Mei at Notion"), path strength, and actions **Start outreach** (creates a chat in `identified` and a draft), **Save**, **Not relevant** (feedback with reason chips: wrong role, wrong company, already know them, not now).

Search box: "Find people at <company>" or "<name> at <company>" runs the Reach query (section 9) and the enrichment search, deduplicated against the network.

Recommendation budget: 10 new candidates per week by default, refreshed Monday in the brief, plus on-demand refresh (capped at 3 per day because enrichment calls cost money). [DEFAULT]

---

## 9. Map and Reach

### 9.1 Default view (`/map`)

Visual reference: the Framer team page layout provided by the founder (centre badge, concentric faint rings, circular avatars distributed on rings, name tooltip on hover) [DECIDED as the aesthetic].

- Centre node: the student's avatar.
- Three rings by relationship strength: inner (strong, strength ≥ 0.6), middle (0.3 to 0.6), outer (< 0.3). [DEFAULT thresholds]
- Angular position groups people by company (companies occupy contiguous arcs; the arc gets a small label with the company name and logo on the outermost ring). Within a company arc, ordered by strength.
- Nodes: circular avatars (photo if known, initials otherwise), 32 px to 48 px by strength; pipeline stage shown as a thin coloured ring around the avatar; a tiny pulse on nodes with a pending suggestion.
- Hover: name tooltip (as in the reference). Click: opens the profile drawer. Double-click: recentre the map on that person (ego view of their connections).
- Slow continuous rotation of each ring (opposite directions), paused on hover; respects `prefers-reduced-motion`.
- Filters (chips): target companies only; stage; relationship type; recency (touched in last 30/90/365 days); show companies as nodes (toggle: adds company hub nodes with edges to their people).
- Performance budget: 1,500 nodes at 60 fps on a 2020 laptop; above 1,500 the outer ring collapses into company clusters that expand on click. [DEFAULT]

### 9.2 Reach mode (`/map?reach=...`)

Input: a target person (from the network, from a search result, or a pasted LinkedIn URL) or a target company.

Output: up to 3 paths from the student to the target, each a chain of 1 to 3 hops with an explanation per hop ("You met Mei twice; Mei worked with Daniel at Stripe 2021 to 2023") and a path score. The map dims everything except the path nodes, draws the path as a curved line through them, and the side panel lists the paths with a **Ask for intro** button that creates an `intro_request` suggestion addressed to the first hop, with a draft that mentions the target and why.

For a target company, the panel lists: direct contacts there (current), former employees in the network, alumni there (from enrichment), and second-hop routes, each with a strength.

Algorithms and data are in `06-graph-and-reach.md`.

---

## 10. Meeting notes and voice capture

### 10.1 Sources

| Source | How it arrives | Spec |
|---|---|---|
| Granola | webhook or automation (Zapier/Make) posting to Orbit's ingest endpoint; or the student shares the note by email to their ingest address; or paste | `04-integrations.md` section 5 |
| Voice capture (Wispr Flow or any dictation) | the student dictates into Orbit's capture box (on the chat drawer, the profile, or the global "+ Note" button); Wispr Flow types into any text field so no API is needed; an import path for exported dictation history is specified if the vendor offers one | `04` section 6 |
| Manual | same capture box, typed | — |
| Email ingest | any email forwarded to the ingest address (e.g. the student's own post-chat notes from Apple Notes) | `04` section 5.3 |
| Upload | .md / .txt / .docx / .pdf file | — |

### 10.2 What happens to a note

1. Stored raw in `meeting_notes` with source and external id (idempotent).
2. Matched to a calendar event and person(s): by event id if provided, else by time window (note timestamp within ±3 hours of an event with external attendees), else by names mentioned (entity resolution), else unmatched. Matches with confidence < 0.8 become a confirmation card. [DEFAULT]
3. Extracted (task `note_extraction`) into: summary; facts about each person (role details, background, advice given, personal details, offers made such as "happy to refer you", hooks for later); action items with owner and due date; sentiment/warmth; suggested next step.
4. Facts are written to `person_facts` (deduplicated against existing facts by embedding similarity > 0.92), action items to `action_items`, and the chat moves to `completed` if it was `scheduled`.
5. The next brief gets a `thank_you` suggestion (if within 48 hours) and `action_item_reminder` suggestions as they fall due.

### 10.3 Capture box behaviour

A single multi-line text box with a "Who was this with?" person picker (pre-filled from the calendar event ending most recently), a timestamp (editable), and a Save button. Placeholder copy nudges dictation: "Talk it out: what did you learn, what did they offer, what did you promise?" Autosaves every 5 seconds to a draft so a closed tab loses nothing.

---

## 11. Notifications

| Kind | Trigger | Channels (default) |
|---|---|---|
| Morning brief | nightly generation | email, in-app |
| Reply received | inbound message on a networking thread from a person with an active chat | in-app (realtime), email digest if not opened within 4 hours |
| Chat tomorrow | calendar event with a matched person in 24 hours | in-app, email (with the prep brief link) |
| Action item due | due date reached | in-app, in the brief |
| Relationship cooling | strong tie's strength decays below 0.4 with no touch in 45 days | in the brief only |
| Job change / news | enrichment refresh detects a new current affiliation for a person in the network | in the brief (`congratulate`) |
| Integration problem | token revoked, watch expired and could not renew, CSV import failed | in-app banner + email once |
| Weekly recap | Sunday 18:00 local: outreach sent, replies, chats, strongest new ties, next week's targets | email |

Preferences per kind in Settings. Every email has a one-click unsubscribe per kind (Resend topics) and the morning brief cannot be disabled while the account is active except by setting all channels off (then the Today page still shows it). [DEFAULT]

---

## 12. Settings (`/settings`)

Profile; Recruiting goals and target companies; Integrations (status, scopes, reconnect, disconnect with a stated consequence, sync status and last run); LinkedIn export re-upload; Notes ingest address (regenerate); Notifications; Writing style (view the style card, pick exemplars, regenerate); Sending limits (daily caps, cadence, quiet hours); Data & privacy (export everything as JSON + CSV, delete account with 7-day grace, list of what is stored); Billing (v1: free, with a placeholder plan page).

---

## 13. Design language

- Clean white canvas, near-black text, one accent (indigo `#5B5BD6` family), state colours used sparingly: green (sent/completed), amber (needs you), red (problem), grey (closed). Dark mode from day one via tokens.
- Type: Inter (UI), tabular numerals for tables. Base 14 px, 1.5 line height.
- Circular avatars everywhere people appear; initials fallback with a deterministic hue from the person id.
- Cards have 12 px radius, 1 px hairline border, no heavy shadows except the brief cards (soft 24 px shadow at 6% alpha).
- Motion: 150 ms ease-out for UI; the map rotates at 1 revolution per 6 minutes (inner) and 10 minutes (outer). Reduced-motion disables rotation and uses opacity transitions only.
- Copy rules: second person, present tense, no exclamation marks in system copy, never the words "AI", "leverage", "synergy", "reach out" (use "write to", "message"). Suggestions explain their reason in one sentence that names the signal ("No reply in 6 days").
- Reference library: use Mobbin for the onboarding stepper (reference: Linear, Notion), kanban (Linear), CRM profile (Attio, Folk), and approval cards (Superhuman).

---

## 14. Success metrics (instrumented from day one)

| Metric | Definition | v1 target |
|---|---|---|
| Activation | completed steps 1 to 5 and received a welcome brief | 70 percent of sign-ups |
| Brief open rate | opened Today or the brief email on a day a brief existed | 60 percent of days |
| Approval rate | approved or edited-then-sent / suggestions shown | 40 percent |
| Edit rate | edited before send / sent | under 50 percent, trending down |
| Reply rate | inbound reply within 10 days / outreach sent | 35 percent for warm paths, 15 percent cold |
| Chats per active week | `completed` transitions per user per week | 1.5 |
| Stage accuracy | user-confirmed or uncorrected auto transitions / all auto transitions | 90 percent |
| Fact precision | facts not deleted by the user / facts shown | 95 percent |
| Time to welcome brief | step 5 consent to welcome brief ready | p50 under 5 min |

Events are listed in `11-testing-evals-observability.md` section 5.

---

## 15. Copy and tone of generated messages

The drafting system (`05` section 7) is told, for every message:

- Audience: a professional the student does not know well; keep under 120 words for first outreach, under 80 for bumps, under 100 for thank-yous. [DEFAULT]
- Structure for outreach: one line of connection (shared school, mutual contact, specific interest), one line of context (who the student is, one specific thing), one ask (a 15 to 20 minute call, with 2 time windows or the scheduling link), a short sign-off.
- Voice: the student's style card (greeting, sign-off, formality, sentence length, use of contractions, emoji policy) learned from their sent mail; never more formal than the student's own writing.
- Specificity: at least one concrete, fact-backed detail about the recipient; never generic praise.
- Never: fabricate a mutual connection, claim to have read something not in the facts, mention the student's GPA unless they put it in the goals, or apologise for writing.
