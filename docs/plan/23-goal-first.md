# 23. Goal first: Orbit tells you what to do next

Status: built on 2026-10-25 (see "What building it changed" at the end). Amends 07 (the brief gains a weekly recap and auto-sent cards),
16 §8 (autonomy is offered by kind, from the student's own approvals, not set as a level), 18 (the reply check gains
a sibling: the notes check after a meeting) and 22 (the deck shell carries the weekly review too). Verified against the
code on 2026-10-25; every "today" claim below names the file.

## 0. The founder's ask, in one line

Make Orbit the most intuitive networking tool a recruiting student can pick up: never a blank screen, never more
than one tap to the next right move, and everything the student would otherwise do across LinkedIn, Gmail, Calendar
and a notetaker done from inside Orbit, with Orbit saying out loud what it is doing. Eight pieces, planned as one
product, built with the student's point of view first, and iterated after the build until each one is right.

The eight: paste a job link and get the plan; replies that finish themselves (in flight elsewhere, see §4.6); a
trust ladder for autopilot; the intro ask with a forwardable note; the machine's work made visible; company pages as
targets; the weekly review; and a clean view of upcoming chats with the meeting notes flowing back in afterwards.

## 1. The student's week, as this plan makes it

This is the spine every piece hangs on. Ravi, a junior at Michigan, recruiting for software internships.

**Sunday 6 pm.** Orbit opens on the weekly review: "6 reached, 3 replied, 2 chats booked, 1 went quiet. Two nudges
ready." He approves both nudges in two taps. The review ends with "Next week: 4 first messages, your usual."

**Monday morning.** He finds a Stripe posting. He pastes the link into Orbit (the Map's empty state, the chat, or
Discover; all three take a link). Twenty seconds later: Stripe, Software Engineer Intern, Payments. Three people,
each with a reason and a route: Dana Lee (Michigan 2023, on the team, he knows her: Direct · 68), Priya Raman
(university recruiter, via Kenji who worked with her: Strong · 74), Marcus Ortiz (the hiring manager, via Dana, after
Dana: Fair · 41). Three drafts, written in his voice, in a proposed order: Dana today, Kenji's intro ask Wednesday,
Marcus after Dana replies. He reads Dana's, changes a word, approves. Nothing else is sent.

**Monday, under the sidebar.** A quiet line: "Reading 40 LinkedIn profiles · 12 of 40". He clicks it once, sees what
Orbit is doing and that the reply check ran 2 minutes ago, and forgets about it.

**Wednesday.** The intro ask to Kenji is ready as planned: a four-line ask plus a note Kenji can forward unchanged.
Ravi approves. Kenji's reply lands Thursday ("Sure, happy to"): Orbit moves the card and queues a thank-you.

**Thursday.** Dana replies with "Sure, next week?" Orbit shows the reply inside Orbit, drafts the answer with three
free slots from his calendar, he taps once. When Dana picks Tuesday 3 pm, the event is created, and the Chats view
shows "Tue 3:00 pm · Dana Lee · Stripe · Prep".

**Tuesday 2:50 pm.** The Chats view, one tap into Prep. The deck from plan 22 runs him through who she is, what they
share, his questions. Fathom records the call.

**Tuesday 3:40 pm.** Ten minutes after the event ends, Orbit checks Fathom, files the notes on Dana, adds three
facts, marks the chat completed and writes the thank-you. The Chats row now reads "Notes in · 3 facts · thank-you
ready". He approves the thank-you.

**Three weeks on.** He has approved ten bumps without changing a word. A card: "Want Orbit to send bumps on its own?
You'll see each one after, and can undo for a minute." He says yes. Bumps go out at the recipient's 8:40 am; each
shows up in the morning brief as "Sent for you".

Nothing in that week is sent without his approval of the exact text, except the bumps he explicitly handed over, and
every number he saw carried a "why".

## 2. What is true today (from the code)

| Piece | What exists | What is missing or wrong |
|---|---|---|
| Job link | Target companies are a name, priority, status and deadline (`core/types.ts:327-338`, `engine/targets.ts`). Discover builds LinkedIn searches by company plus title or school (`core/recommend/discover.ts:209-290`, `engine/linkedinSearch.ts:55-110`). Drafts take a `posting` input and append its first `https://` link to referral asks (`engine/brief.ts:733-741`). | Nothing reads a URL or a posting. No role, team or link on a target. The Map with no target shows a search box and a how-to card (`pages/MapPage.tsx:1092-1141`). Onboarding asks goals, functions, companies and a weekly target (`pages/Onboarding.tsx:501-777`), never a job. |
| Company page | `reachCompany` splits people into there now, saved, former and three two-hop routes (`engine/graph.ts:568-788`); the page lists four cards (`pages/Company.tsx`). `functionOf(title)` buckets titles into twelve functions (`core/graph/titles.ts:44`). | Routes are capped at 3 and shown as arrows, not scores. No team grouping. The "Target company" chip matches on `organizationId`, which `addTargetCompany` never sets, so it never shows for a real student (`Company.tsx:17-27`, `targets.ts:11-27`). |
| Intro ask | The Map's "Ask Kenji for an intro" creates an `intro_request` card and draft with the path recorded (`engine/drafts.ts:197-254`); outcomes are learned (`engine/introOutcomes.ts`). The server's `/intros/ask` writes two drafts, the ask and a `forwardable_blurb` (`orbit-api/routes/paths.ts:5-62`). | Locally the blurb is a quoted sentence inside the ask (`core/drafts/templates.ts:2914-2975`), never a separate forwardable note, never stored, never editable once for all asks. |
| Upcoming chats | Events carry the time and join link (`CalendarEvent.startAt`, `conferenceUrl`); a chat points at its event by `scheduledEventId`. Drafts has a "Coming up" card for seven days (`pages/Inbox.tsx:114-131, 565-620`); the Person header shows "Chat {time}"; `prep_brief` cards fire the day before (`core/suggestions/rules.ts:638-670`). | No view of the week's chats. The "Scheduled" tab in Drafts lists autopilot sends, not chats (`Inbox.tsx:183-187`). Nothing shows what happened after a chat (notes in, thank-you ready). |
| Meeting notes | Fathom, Granola, Fireflies and Wispr Flow are built as pollers (`engine/fathom.ts`, `engine/meetingApps.ts`, `supabase/functions/orbit-notes`), syncing on app open when the last sync is over 12 hours old (`components/MeetingNotesAutoSync.tsx`). A stored note runs one pipeline: facts, promises as action items, timeline, stage to `completed`, thank-you draft (`engine/notes.ts:744-989`). | Nothing syncs when a meeting ends; a Tuesday 3 pm chat gets its notes at the next open after 3 am Wednesday. No test runs an imported meeting through to the thank-you. The Wispr field mapping is a guess (`meetingApps.ts:245`). Fireflies connect wrongly needs orbit-notes (`meetingApps.ts:526`). Any recorded meeting with one to four other people creates people and a `completed` chat for the first (`notes.ts:255-272, 777-827`), so a recorded standup becomes a networking chat with a thank-you. No webhooks; the plan's email forwarding was never built. |
| Replies | Reply classes, slots (`freeSlots`, `engine/brief.ts:230`), `book_call`, `schedule_confirm` cards exist. | Owned by the One inbox session (see §4.6). |
| Machine reading | Seven separate mechanisms, each with its own store: reply check kv (`engine/checkReplies.ts:35-46`), LinkedIn progress store (`engine/linkedinLive.ts:107-131`), enrichment budget kv (`engine/enrichment/store.ts`), photo and logo queues (no progress API), hop evidence map (`engine/hopEvidence.ts:99-123`), server sync status (`engine/serverSync.ts:654-685`). Shown in five places: Drafts and People subtitles, the LinkedIn banner, the Settings LinkedIn card, the import line in onboarding. | No one place says what Orbit is doing. The photo and logo queues are invisible. Enrichment status lives only inside Settings. |
| Weekly review | `Brief.kind 'recap'` and `Notification.kind 'weekly_recap'` are declared and never produced (`core/types.ts:885-895, 1028`). `weekStats` counts sent, replied, completed (`engine/today.ts:186-221`). `db.stageEvents` holds every dated transition (`core/types.ts:665-679`). | Nothing weekly runs. |
| Autopilot | A batch the student approves once goes out over the coming days (`engine/autopilot.ts`), weekdays 9 to 17 in the browser's clock (`engine/autopilotTime.ts`). Approvals and edits are recorded as `FeedbackEvent` rows with edit distance (`engine/send.ts:1093-1105`). The server has recipient-local send windows (`_shared/compose/window.ts`) and the level-2 rules (`core/safety/rules.ts:281-345`). | Nothing reads the approve-without-edit streaks. The local undo window is 10 s (`send.ts:43`), where 07 §4 says 60. No recipient time zone locally (`Person` has `location` only). Autonomy is a hidden level (`settings.autonomyLevel`, set by a chat tool), not something the product offers when earned. |

## 3. Rules for every piece (the student's point of view)

1. **Never a blank screen.** Every empty state names exactly one action, in a sentence, with the button under it.
2. **One tap to the next right move.** A card is Approve, Edit or Skip. A row is Open. A plan is Approve all or one
   at a time. Nothing needs a second screen to decide.
3. **Every number says why.** The route badge, the tie score, the pick: hover or tap gives the sentence (the map's
   `ROUTE_SCORE_WHY` pattern).
4. **Approval binds bytes** (01 §3.2 rule 1). The only exception is the trust ladder, which the student turns on by
   kind, sees after every send, and can undo for a minute.
5. **Quiet, not busy.** Status is one line at 12px, plain words, no spinners for trivial work, gone to "Up to date"
   when nothing runs. Progress for the first hour (the import) keeps its banner.
6. **Phone first for the moments that happen on a phone**: the chats list, prep, the weekly review, the reply. Desktop
   first for the plan and the company page.
7. **Nothing invented.** Every line in a plan, a review or a prep card traces to a stored row. A summary with no data
   says so ("Nothing moved this week").
8. **Copy rules as everywhere**: sentence case, no em or en dashes, the student's own words in drafts, "you" and the
   person's first name.

## 4. The pieces

### 4.1 Paste a job link, get the plan

**What the student sees.**

- **Where it starts.** Four doors, one builder:
  - The Map with no target: the primary action becomes a single field, "Paste a job link, or a company", with the
    secondary "Find a path to a person". The how-to lines stay below.
  - The chat: a message containing a job URL or "I'm applying to Stripe" opens the same plan as a card.
  - Discover's search box accepts a link.
  - Onboarding: a new optional step **A job**, right after **You** and before **Goals**: "Going for something right
    now? Paste the link or the company. Orbit plans your way in once your network is connected." Skippable in one tap.
    Goals still follow; a job given here pre-fills the target company and the function chips. The plan itself opens
    on the first home screen after LinkedIn (or the connections file) is in, as the first thing the student sees.
- **The plan** (one card, 560px, or full width on a phone):
  - Header: the company's LinkedIn logo, "Software Engineer Intern · Payments · Stripe · San Francisco", the
    posting link, "Target · researching" with the status chips, a deadline field if the posting had one.
  - Up to three people, each a row: avatar, name, title, the role in the plan ("knows the team", "recruits for this
    posting", "the hiring manager"), the route line and badge exactly as the Map shows them ("via Kenji (close · 82)
    → Priya (worked together 2022 to 2025)" · "Strong · 74"), and the proposed day ("today", "Wed", "after Dana
    replies").
  - Under the three: "Draft all three" (primary) and "Pick who". Drafting opens the three drafts in Drafts, each in
    the student's voice, with the posting line in the reason ("your posting for the Payments intern role").
  - A fourth line when there are more: "9 more people you can reach at Stripe" → the company page (§4.2).
  - Order and dates are proposals. Approving a draft sends it (or schedules it with autopilot's plan); approving all
    three schedules them in the proposed order. Nothing goes out without approval; the hiring manager's draft is held
    ("after Dana replies") and promoted by the reply check.
- **Honest states.** The link is not a posting: "That page doesn't look like a job posting. Try the company name."
  No network yet: the posting is saved as a target and the plan says "Connect LinkedIn, and Orbit finds who can get
  you in" with the button. A company nobody in the network touches: the plan is three LinkedIn finds (recruiter,
  alum, team) with "cold, warm up first" routes, and says so. The student already wrote to one of the three: shown as
  "already in your pipeline · replied Thu", never redrafted.

**How it works.**

- **Reading the posting.** The browser cannot fetch another site. A new route on `orbit-connectors`, `/posting`,
  takes `{url}` or `{text}`, fetches the page (Greenhouse, Lever, Ashby, Workday, LinkedIn Jobs, careers pages; the
  same user-agent and 8 s timeout the research function uses), strips it to text, and asks Haiku for a fixed shape:
  `{company, role, team?, location?, level?, deadline?, requisitionId?, namesOnPage: {recruiters[], managers[]}}`,
  with "not a posting" as a valid answer. Cached by URL hash for 7 days in `orbit_private` (postings are public).
  A new ledger kind `postings`, 10 a day per visitor, 0.6 priority ceiling, like `logos`. Cost under a cent a call.
  When the function is unreachable the client falls back to the pasted text: a line with "at" or a company name
  alone still makes a target.
- **The target.** `TargetCompany` gains `role?`, `team?`, `postingUrl?`, `postingSeenAt?`. `addTargetCompany`
  resolves the organization (`resolveOrg`, creating one with the LinkedIn logo through `companyByName` when none
  exists) and **sets `organizationId`**, which also fixes the Company page chip. Status stays `researching`;
  `deadline` is filled from the posting when it had one.
- **Finding the three.** `engine/targetPlan.ts` (new): `buildTargetPlan(userId, target, opts) => TargetPlan`.
  1. Network first: `reachCompany` (extended in §4.2) gives everyone there now, former, and reachable, each with a
     route and score.
  2. Roles: `functionOf(title)` and `seniorityClass(title)` from `core/graph/titles.ts` sort people into
     *recruiter* (function recruiting), *team* (same function as the role, class 0 or 1), *manager* (same function,
     class 1 or 2, or a title containing "manager", "lead", "head"), *alum* (isAlumni). The posting's `team` text
     narrows *team* when a title mentions it.
  3. Picks: one from each of recruiter, team and manager, best route score first, alumni preferred within a tie,
     never someone with `doNotContact`, a declined chat, or a live chat (those show as "already in your pipeline").
     Fewer than three in the network: the gap is filled from LinkedIn with `searchLinkedInLive`, three queries
     (company + "recruiter", company + role title, company + the student's school) under Discover's daily search
     budget, results added through `addLinkedInFound` only when the student picks them (a found person is a *cold*
     pick with a warm-up route, plan 13).
  4. Order: the strongest direct tie today; a warm intro ask in two days (gives the first a chance to reply, keeps
     the per-person cooldown and daily caps in `checkSendAllowed`); the manager "after X replies", or day 5 if no one
     has. Dates land in `TargetPlan.steps[].when` as the autopilot's proposals; the reply check (18 §3) promotes a
     held step when the named reply arrives.
  5. Drafts: `create_drafts` kinds per route: `outreach` (direct), `intro_request` with the forwardable note (§4.3,
     warm), `warm_up_engage` then `outreach` (cold). Each draft's `posting` input is the posting line, so the
     referral and outreach templates name the role.
- **Persistence.** `db.targetPlans` (new table, Dexie v8): `{id, userId, targetCompanyId, builtAt, posting, steps[],
  suggestionIds[]}`. Rebuilt when the student asks ("Replan") or when a step's person changes company. The chat tool
  `plan_for_posting {url | text}` returns the same shape as a card; `get_person` and `list_pipeline` already cover
  the rest.
- **Account mode.** The same builder runs in the browser over the synced tables; the posting read goes through the
  same connector route. Nothing new on `orbit-api`.
- **Demo.** A canned Stripe posting (text, no fetch) and the sample network, so "Try the demo" shows the plan in
  under ten seconds with no network call.

**Edge cases.** A link to a careers *list* (no single role): "That's the careers page. Pick a role and paste its
link, or go with the company" and the company plan runs. A posting whose company differs from the page's host (an
agency): the company field wins, shown for correction. Two postings at one company: one target, two roles, the plan
offers both and shares the recruiter pick. A huge company (over 500 people in the network): `rankCompanyTargets`
narrows to the top 30 before roles are assigned. A posting in another language: Haiku answers in the same shape; the
UI copies the role as written.

**Acceptance tests.**

- Unit (`targetPlan.test.ts`): roles from titles (recruiter, team, manager, alum), picks never include do-not-contact,
  declined or live chats, the order rule, fill-from-LinkedIn only when short, plan rebuilt when a pick leaves the
  company, no dashes in any line.
- Simulation (`targetPlan.sim.test.ts`, the `discover.sim` pattern): 300 made-up students by network size (0 to
  2,000), with and without LinkedIn, postings at companies they do and do not touch; a coach's rules: every pick has
  a reason naming the person's tie to the posting, a warm pick never outranks a strong direct tie at the same
  function, nobody is picked twice across two postings in a week, the three roles are filled when the network allows.
- Connector (`connectors-proxy.test.ts`): `/posting` on fixtures for Greenhouse, Lever, Ashby, Workday, LinkedIn
  Jobs and a plain careers page; "not a posting" for a blog post; ledger spend; the cache hit; an unreachable upstream
  gives a clean error, never a 500.
- e2e (`orbit.spec.ts`, demo): paste the canned link on the Map → the plan shows three rows with badges and days in
  under 10 s; "Draft all three" opens Drafts with three drafts, zero sent; the Person page of a pick shows "In your
  plan for Stripe"; the chat "here's a posting {link}" shows the same card; onboarding's A job step is skippable and,
  when filled, pre-fills Goals. Phone width 375: the plan reads top to bottom with the badges intact.
- Real account (founder, once): a live Greenhouse link with LinkedIn connected; the three are real people at that
  company; the search budget line in Settings shows the spend.

### 4.2 Company pages as targets

**What the student sees** (the mock-up agreed on 2026-10-25).

- Header: the LinkedIn logo, name, "Fintech · 8,000 people · stripe.com", **Set as target** (or the target status
  chips when it is one). Four quiet stats: *You know there* · *Reachable warm* · *Alumni there* · *Best route* (a
  score, coloured by band).
- Team chips: *All teams*, then the functions present with counts (Engineering · 12, Product · 6, Recruiting · 3,
  Leadership · 2), then *Alumni only*. One list under them, grouped by team, each group sorted by route score.
- A row: avatar, name, title (and "Michigan 2023" for an alum), the route line in the map's words, the badge
  ("Direct · 68", "Strong · 74", "Fair · 41", "Cold"), one button: **Write to** (direct), **Ask Kenji** (warm),
  **Warm up** (cold with a warm-up plan), **Save** (cold).
- "Former employees you know" stays, as a small group at the end ("left 2024").
- When the company is a target with a plan: the **Suggested plan** card from §4.1 sits at the bottom with
  **Draft all three**.
- Empty: "Nobody in your network touches Stripe yet. Find people there" → Discover with the company filled in.

**How it works.**

- `reachCompany` returns one list, `people: CompanyPerson[]`, where `CompanyPerson = {person, team, seniority,
  alum, route: {kind: 'direct' | 'warm' | 'cold', path?: WarmReachPath, score, band, line}, action}`; `direct`,
  `saved`, `former` and `twoHop` stay for the map and the chat until they are retired. The route for a known person
  is the direct tie's score (plan 21's `direct` return); for others the best `reachPersonIn` route; for a saved
  person with none, `cold`. No cap at three: everyone is scored, and `rankCompanyTargets` narrows to 30 when there
  are more. `team` is `functionOf(title)`, with `seniorityClass === 2` as *Leadership* and no function as *Other*;
  the title's text after a comma (`prep.ts:52` `splitTitle`) names the team when it does.
- The page: `pages/Company.tsx` is rewritten over the new shape; the list virtualizes past 40 rows; the chips filter
  in place; the badge reuses the map's score badge component (factored out of `MapPage.tsx:1325-1350` into
  `components/map/RouteBadge.tsx`).
- Targets: the chip matches by `organizationId` or normalized name (the map's matcher, `graph.ts:67-85`), and
  `addTargetCompany` sets `organizationId` (§4.1). **Set as target** on the page writes the target and builds the
  plan.
- Chat: `company_reach {company}` returns the grouped list; "who can I reach at Stripe" answers with the top five and
  a link to the page.

**Acceptance tests.** Unit: grouping and sorting (score within team, Leadership from class 2, Other last), the
direct score equals the map's, a saved person with no route is Cold, the target chip shows for a name-only target.
e2e (demo): open Stripe from People → Companies: the stats, the chips, the first row's badge equals the badge on the
Map for that person; **Set as target** shows the chips and the plan card; **Ask Kenji** on a warm row lands on the
intro-ask card. Perf (`map-perf.spec.ts`): a 2,000-person network renders the page in under 1.5 s.

### 4.3 The intro ask, with the note they can forward

**What the student sees.**

- Pressing **Ask Kenji** (Map, company page, plan, chat) opens one card with two parts, each its own text:
  1. **The ask**, four lines at most: the small ask, why Priya ("she recruits for the Payments team you're applying
     to"), the shared context ("you two worked together at Lazard"), and the out ("no worries at all if not").
     Double opt-in built in: "if you think she'd be open to it".
  2. **The note Kenji can forward**, three lines in the third person, under a divider: who Ravi is, what he's going
     for, the one thing that makes him worth 15 minutes. **Copy** on the note alone.
- Below: "Your note, saved. Edit it once and every ask reuses it" → the note lives in Settings → You as **Your
  three lines**, with the last line (why this person) written per ask.
- Sending: by Gmail, one message, the ask then the note after a rule. By LinkedIn, the ask as the message, the note
  as a second message the student taps to send (every LinkedIn send is a tap, 16 §8.3). Hand-off (mailto, copy):
  both parts in the clipboard.
- After: the `report_back` card already exists (07 §1); when Priya replies or Kenji says "done", the card thanks
  Kenji in one line. `introOutcomes` keeps learning.

**How it works.**

- `settings.introNote?: {text, editedAt}` (schema, no index). `engine/introNote.ts`: `buildIntroNote(user, resume
  facets, goals)` makes the first version from `situation()` (`templates.ts:567-573`), the resume `summary` facet and
  `credibilityLine` (`brief.ts:559-580`); the per-ask last line comes from the target's title and company and the
  posting when there is one. 90 words at most (the server's limit, `templates.ts:360`).
- `requestIntro` writes **two** drafts locally as the server does: kind `intro_request` and kind `forwardable_blurb`
  (both exist in `MessageKind`), linked by `suggestionId`, and the card renders both (`SuggestionCard.tsx` gains the
  two-part body). `approveAndSend` on the ask attaches the note (Gmail: one body; LinkedIn: the second draft stays
  pending for its tap). The `intro_request` template drops its inline quoted blurb when a note draft exists.
- Validation: both parts run `validateComposed`; the note is checked for first-person slips ("I am") and for anything
  the never-write list forbids (20 §5), since it travels beyond the student's control.

**Acceptance tests.** Unit: the note is third person, under 90 words, names the goal and one credential, changes
only its last line between targets, and is rebuilt when the student edits it in Settings. Drafting tests
(`drafting.test.ts`): the ask has four lines or fewer and no inline blurb when a note exists. e2e: Ask Kenji on the
Map → one card, two texts, Copy copies the note only; Approve by Gmail sends one message whose body is ask, rule,
note; by LinkedIn the note waits for its tap. Chat-sim: "ask Kenji to intro me to Priya" produces the two-part card.

### 4.4 Your chats: the week ahead, and what came back

**What the student sees.**

- A **Chats** entry in the sidebar under Drafts, with a badge for today's count; on a phone, in the tab bar's More
  sheet and a line on the chat home ("Chat with Dana at 3:00 pm · Prep").
- The page, phone first: days as headings (Today, Tomorrow, Wednesday, next week), each chat a row: time and length,
  avatar, name, title, the company logo, **Join** (when the event has a link), **Prep** (the deck from 22, or the
  Prep tab until 22 ships), and a disclosure that opens three lines: the goal and ask, the last thing they said, one
  fact that matters. Tapping the name opens the person.
- A **No time yet** group for chats at the `scheduled` or `scheduling` stage with no event ("Agreed to talk, no time
  set · Propose times").
- **Just happened**, for the last 48 hours: each row says what came back: "Notes in · 3 facts · Thank-you ready",
  or "Waiting for Fathom's notes" with the app's logo, or "No notetaker · Add a note" when none is connected, with
  **Log this chat** when the student met and nothing was recorded.
- Empty: "No chats booked. When someone agrees to talk, it shows up here. Who's replied?" → Drafts.

**How it works.**

- `engine/chatsView.ts` (new, pure): `upcomingChats(events, chats, people, now, tz) => Day[]`, from `db.events` with
  `isCoffeeChat` (or `chatId`) and `attendeePersonIds`, not cancelled, from 48 hours back to 14 days ahead, plus
  chats in `scheduling`/`scheduled` with no event. Each row carries the person, the chat, the event, the prep state,
  and the **afterwards** state read from the chat's notes (`db.notes` with the chat or the event id), facts added
  since the event end, and the pending `thank_you` card.
- `pages/Chats.tsx` (new), route `/chats`; `AppShell.tsx` nav entry and badge; `chat/ui/homeStatus.ts` adds the
  next chat line; the Drafts "Coming up" card links to `/chats` instead of listing.
- The chat tool `list_upcoming_chats` returns the same days; `get_today_brief.comingUp` already exists and keeps
  working.

**Acceptance tests.** Unit: grouping by day in the student's time zone (a 11:30 pm chat stays on its day), No time
yet rows, the afterwards state in each of its four forms, cancelled events hidden. e2e (demo, 375 and 1280): the
page shows Today with the sample chat, Join opens the link in a new tab, Prep opens the prep, the disclosure shows
three lines, a seeded note flips the row to "Notes in"; the sidebar badge equals today's count.

### 4.5 Meeting notes: make the loop close, and prove it

The integrations exist (§2). What is missing is the moment: the notes should be in Orbit before the student thinks
to look, and every path should be shown to work against the real apps, not just fixtures.

**What the student sees.** Nothing new to learn. The Chats row says "Waiting for Fathom's notes" from the end of the
event, flips to "Notes in · 3 facts · Thank-you ready" when they land, and the status line (§4.7) says "Filed
Fathom's notes from your chat with Dana". If notes do not arrive within two hours: "Fathom has no recording of this
chat · Add a note" (so a missed recording is never silent). A recorded meeting that is not a networking chat never
becomes one without asking.

**How it works.**

1. **The notes check** (`engine/notesCheck.ts`, mounted like `ReplyWatch`): for every coffee-chat event that ended
   in the last 3 hours and has no note yet, sync the connected notetaker at end + 10 min, + 30, + 60, + 120 (then
   stop), and whenever the Chats page or the person opens. Same sync functions (`syncFathom`, `syncMeetingApp`),
   with a `since` of the event start so a check costs one call. Dedupe by `meetingSeen`.
2. **Matching guard.** `ingestNote` for an imported meeting files on people only when the meeting matches a
   coffee-chat event (±3 h, attendee overlap) or an attendee is already a person with a chat. A recording of unknown
   people raises `confirm_note_match` ("Was your 2 pm meeting with Priya and Sam a networking chat?") instead of
   creating people and a `completed` chat. Groups over four stay as today.
3. **Fixes found in the survey.** Fireflies connects without `orbit-notes` (`meetingApps.ts:526`); CORS to
   `api.fireflies.ai` is verified live, and if the browser is refused, Fireflies moves behind `orbit-notes` like
   Fathom. The Wispr mapping is pinned to a recorded real response (a fixture checked in, names and emails replaced).
   The "Dictated" button passes its source to the extractor, or loses the claim that it changes the reading.
4. **End to end test.** `notesLoop.test.ts`: an imported Fathom meeting (fixture) for a scheduled chat → the chat is
   `completed`, three facts on the person, a promise as an action item, a thank-you draft quoting the notes, the
   Chats row's afterwards state. The same for Granola and Wispr fixtures. `auto-stages.spec.ts` gains the notes check
   firing at end + 10 min with a faked clock.
5. **Live verification** (founder's accounts, written up in this file under "Live check"): connect each of Fathom
   (key, and sign-in when the secrets are set), Granola, Wispr Flow and Fireflies to a test Orbit; hold one short
   recorded call with a second account; confirm within 15 minutes that the note, facts, stage and thank-you appear
   and that the Chats row updated; record what each app returned (shape, latency, summary vs transcript). Any app
   that fails stays on the Settings row as "Paste notes in Add note instead" until fixed; nothing is claimed in the
   UI that the live check did not show.
6. **Webhooks** stay out of this plan. Fathom and Granola (Business) offer them (04 §5, §7); the end-of-meeting
   check gets the notes within ten minutes without a server route or a secret. Revisit when students report waiting.

**Acceptance tests.** Items 4 and 5 above, plus unit tests for the check's schedule (fires at the four offsets and
stops; never for a cancelled event; never twice for one meeting) and the matching guard's three outcomes.

### 4.6 Replies that finish themselves

Owned by the One inbox session (branch `feat/one-inbox`). This plan depends on its result and names the contract,
so the pieces fit:

- A reply classified `scheduling` or `interested` yields a card whose draft offers three free slots from
  `freeSlots` (`brief.ts:230`) in the recipient's time when known, and one tap sends.
- A confirmed time creates the event (`scheduleChatAt` plus the Google invite with the Meet link) and sets
  `chat.scheduledEventId`; the Chats view (§4.4) lists it at once, `prep_brief` fires the day before, and the notes
  check (§4.5) watches its end.
- A reply that lands while a §4.1 step is held ("after Dana replies") releases the step: `targetPlan` subscribes to
  the reply check's `moved` result.

If One inbox lands without the slots-in-draft piece, this plan adds it in Phase B (two days).

### 4.7 Show the machine reading, quietly

**What the student sees.**

- One line, 12px, in the sidebar footer above the account row; on a phone, in the More sheet's header and as the
  chat home's status line. A 6px dot before it: breathing while something runs (still under
  `prefers-reduced-motion`), solid when done, amber for a problem.
  - Running: "Reading LinkedIn profiles · 12 of 40", "Checking for replies…", "Reading Kenji's posts for the route",
    "Fetching 6 company logos", "Filing Fathom's notes".
  - Idle: "Up to date · checked replies 2 min ago".
  - A problem: "LinkedIn signed you out · Sign in again", "Daily LinkedIn reads used · more tomorrow".
- Click: a small popover, **What Orbit is doing**: the live items with counts, then **Today**: profiles 12 of 45,
  posts 3, searches 2 of 10, photos 18, logos 6, replies checked 14 times, notes 1; then **Problems** with their fix
  link. Nothing else. Closes on click-away.
- During the first hour the LinkedIn import banner (`LinkedInProgressBanner`) stays; the line takes over when it
  ends.

**How it works.**

- `engine/activity.ts` (new): one module store, `activityNow(): Activity` and `subscribeActivity(fn)`, where
  `Activity = {live: Item[], today: Counts, problems: Problem[], idleSince?}` and `Item = {id, text, done?, total?,
  startedAt, link?}`. Sources register with `startActivity(id, text, total?)`, `progressActivity(id, done)`,
  `endActivity(id)`; counts come from the kv rows that already exist (`enrich:budget`, `photos:day`, `logos:day`,
  `replies-check`) and the reply check's `watchReplyCheck`. The seven sources call these hooks at the points they
  already log: `enrichment/index.ts` (the run loop), `photoQueue.ts`, `logoQueue.ts`, `hopEvidence.ts` (`checkHops`),
  `checkReplies.ts`, `linkedinLive.ts` (sync), `fathom.ts` and `meetingApps.ts` (sync), `serverSync.ts` (account
  mode: the backfill and jobs pending). Problems come from `linkedInLiveStatus().signedOut`, the enrichment
  `pausedUntil`, and the server integrations' `needs_reauth`.
- `components/ActivityLine.tsx` and `ActivityPopover.tsx`; mounted in `AppShell.tsx:256` (above the footer) and in
  the More sheet; `homeStatus.ts` reads the same store. The Drafts and People `RepliesChecked` lines stay as they are.
- Rules in code: at most one live item is shown (the newest); an item older than 10 minutes with no progress is
  dropped (and logged); the line never changes more than once every 2 seconds; the popover's counts are read, never
  computed, so they match Settings.

**Acceptance tests.** Unit (`activity.test.ts`): registration, progress, the one-line choice, the stale drop, idle
text, problems with links, counts from kv. Component test: reduced motion stops the breathing. e2e: during the demo's
LinkedIn import the line shows the count and then "Up to date"; a seeded signed-out LinkedIn shows the amber problem
with Sign in again; the popover's profile count equals Settings' enrichment line. Visual: screenshots at 1280 and 375
in light, checked against the mock-up for weight (the line must not draw the eye).

### 4.8 The weekly review

**What the student sees.**

- Sunday from 5 pm local (or the first open after), a deck (the 22 shell) of four cards, phone first:
  1. **Your week**: "6 reached · 3 replied · 2 chats booked · 1 went quiet", each with the names on tap, against
     the weekly target ("4 first messages, you sent 6").
  2. **Who moved**: Dana replied Thu, Priya agreed to talk, Jay's chat happened Tue (3 facts), Kenji made the intro.
  3. **Waiting on you**: the pending nudges and thank-yous as cards, Approve on each (two taps and done), and anything
     overdue (a promise due Friday).
  4. **Next week**: the target, the chats already booked, and one plan-derived line when there is one ("Marcus is
     next in your Stripe plan once Dana replies"). Never advice invented from thin data.
- Dismissed, it is reachable from Drafts ("Last week's review") until the next one.

**How it works.**

- `engine/weekReview.ts` (new, pure): `buildWeekReview(userId, weekEnding, tz)` over `db.stageEvents` (applied in
  the window), `db.outbound` (sent, by kind), `db.chats` (`wentQuiet`), `db.notes`, `db.facts`, the intro threads and
  the pending cards. Stored as `Brief.kind 'recap'` with `stats` and `summaryText` (both exist), `briefDate` the
  Sunday. `generateBrief(user, 'recap')` becomes real; the `refresh_brief` chat tool's `recap` option now does
  something.
- `components/WeekReview.tsx` on the Deck shell; `morning.ts` style due-check (`weekReviewDue`: Sunday 17:00 local
  or later, not seen this week, at least 7 days since the first brief so a new student does not get an empty one).
- `Notification.kind 'weekly_recap'` is produced for the morning brief's channel settings.
- Chat tool `week_review` answers "how did my week go" with the same numbers.

**Acceptance tests.** Unit: counts from a seeded week (reached counts `outreach` and `first_touch` only, replied
counts inbound human replies, booked counts `→ scheduled`, went quiet uses `wentQuiet`), an empty week says "Nothing moved this week" and names the
holiday when the week held one, the due rule across time zones, no dashes. e2e (demo with a faked Sunday clock): the deck opens, the
numbers equal the board, Approve on a nudge sends it (demo mock), the review reopens from Drafts.

### 4.9 The trust ladder for autopilot

**What the student sees.**

- Nothing until earned. After ten approvals of one kind with no edits (bumps first; then thank-yous; then
  scheduling replies), a card in Drafts: "You've approved 10 bumps without changing a word. Want Orbit to send bumps
  on its own? You'll see each one after it goes, and can undo for a minute." **Yes, send bumps** · **Keep asking me**.
- Auto-sent messages appear in Drafts under **Sent for you** with "Sending in 58 s · Undo", then "Sent 8:40 am their
  time", and in the morning brief and the weekly review.
- Settings → Sending shows the ladder as it stands: "Bumps: Orbit sends · Thank-yous: 7 of 10 approved · Replies:
  asks you", each with a switch, and "Never: first messages, intro asks, anything on LinkedIn".
- Two edits to an auto kind within a month: "Keep sending bumps on your own?" with **Keep** · **Ask me again**.

**How it works.**

- `engine/trust.ts` (new): `approvalStreaks(userId) => Record<MessageKind, {unedited: number, edited: number,
  since}>` from `FeedbackEvent` rows (`send.ts:1093-1105`) joined to the message kind; the `trust_offer` card
  (`SuggestionKind`, new) when a kind in `LADDER_KINDS = ['bump', 'thank_you', 'schedule']` reaches 10;
  `settings.autoKinds: MessageKind[]` on accept.
- Sending: when a card is raised whose draft kind is in `autoKinds`, the draft passes `validateComposed`, the chat
  has had no reply since the card was raised, and the channel is Gmail, Orbit approves it itself
  (`approveAndSend` with `auto: true`): `queued`, `autopilot: true`, `sendAt = nextSendWindow(now, recipientTz ??
  studentTz)`. The window moves from `_shared/compose/window.ts` into `core/compose/window.ts` so the browser and
  the server share it (Tue to Thu, 8:00 to 10:30, no US holidays, jitter). The undo window for auto-sends is 60 s
  (`UNDO_WINDOW_MS` stays 10 s for taps unless decision 7 says otherwise; a second constant). Caps:
  the level-2 rules (`core/safety/rules.ts:281-345`): 5 a day, score 40 or more, quiet hours in the recipient's
  time; plus `checkSendAllowed` as for every send. LinkedIn never auto-sends (16 §8.3).
- Recipient time zone: `Person.timezone?` filled by `engine/timezone.ts` from `location` with a 300-city table and
  US state fallbacks (no network), else the student's.
- The reset: an edit to an auto kind increments `edited`; two in 30 days raise the keep-or-ask card; **Ask me
  again** removes the kind from `autoKinds` and the streak restarts.
- `autonomyLevel` stays for the server; the ladder maps to it (`autoKinds` non-empty ⇒ level 2 for those kinds).

**Acceptance tests.** Unit: streaks by kind from feedback rows, the offer at exactly 10, acceptance writes
`autoKinds`, an edit resets, the window in three time zones and across a holiday, 60 s undo for auto-sends and 10 s
for taps, LinkedIn never auto, caps hold. Safety tests (`safety/rules.test.ts`): nothing auto-sends when a reply
arrived after the card. e2e (demo): seed ten unedited bump approvals → the offer card; accept → a bump shows under
Sent for you with Undo; Undo returns it to draft; Settings shows the ladder.

## 5. Across the pieces

- **Shared components:** the Deck shell (22) for the weekly review; `RouteBadge` (from the Map) for the company page
  and the plan; `CompanyLogo`; `SuggestionCard` two-part body; `PersonRow` (new, one row design for the company page,
  the plan and Chats: avatar, name, title, logo, line, badge, one button).
- **Data (Dexie v8):** `targetCompanies` gains `role, team, postingUrl, postingSeenAt` (no index change);
  `targetPlans` (new); `settings.introNote`, `settings.autoKinds`; `people.timezone`; `briefs` kind `recap` produced;
  `SuggestionKind` gains `trust_offer`. Migration: fill `organizationId` on existing targets by name.
- **Server:** `orbit-connectors` `/posting` route and `postings` ledger (bundle rebuilt and committed, redeployed by
  sha as in 21); `orbit_private` posting cache table (migration). Account mode: target companies are a browser table
  today (the server's goals carry `targets` as JSON, `orbit-api/sync.ts:282`), so `targetPlans` stay in the browser
  too and the builder runs there over the synced people, chats and events; the `/intros/ask` route already writes
  both drafts.
- **Chat tools:** `plan_for_posting`, `company_reach`, `list_upcoming_chats`, `week_review`, `set_auto_kinds`; the
  router learns job URLs and "applying to X".
- **Copy:** every new string goes through the no-dash lint the e2e already runs on drafts; the status line and the
  review are read aloud once by someone who is not the author.
- **Flags:** each piece behind a kv flag (`flag:targetPlan`, `flag:chatsView`, `flag:activityLine`,
  `flag:weekReview`, `flag:trustLadder`) read at mount, default on in the demo and on main once its gates pass, so a
  piece can be turned off for everyone by one commit without reverting the code.

## 6. Testing, and the iteration after the build

Each piece ships only after the three loops below; "done" means the last loop found nothing.

### 6.1 Gates (every push)

`pnpm lint`, `pnpm typecheck`, `pnpm --filter @orbit/core test`, `pnpm --filter @orbit/web test`, `pnpm build`,
then `pnpm --filter @orbit/web exec playwright test --project=app` with the e2e named in §4, exit codes checked
(not piped through `tail`). Bundles: `node scripts/build-functions.mjs --check`. CI's e2e is the deploy gate as
today.

### 6.2 Loop one: does it work (code)

Unit and simulation tests per piece (§4). The simulations matter most for the plan builder and the company page:
hundreds of made-up networks, coach's rules, never worse than today's ranking by more than 0.05 (the hop-strength
pattern, 21 §11).

### 6.3 Loop two: does it feel right (the student's eyes)

After each piece passes loop one, a walk-through on the demo with screenshots at 1280 and 375 saved to the plan's
`shots/` folder, scored against this checklist, and fixed until every line is yes:

1. In the first 60 seconds of the demo, is the next right move obvious without reading the how-to text?
2. Does every empty state name one action with the button under it?
3. Does every number have a why on hover or tap, in a sentence?
4. Is there anything on the screen the student did not need right now? Remove it.
5. Does the status line disappear into the chrome, and the popover answer "is it working?" in one look?
6. Phone: thumb reach for the primary button, no horizontal scroll, text at 13px or larger.
7. No dashes, no title case, no "successfully", no "simply".
8. Could the student tell what will be sent and when, before pressing anything?
9. After a send: can they undo, and do they see where it went?
10. Would a career coach object to any pick, order or line? (Read the plan's three picks aloud.)

The scripted version: `walkthrough.spec.ts`, the week of §1 on the demo with a faked clock, in one run: review →
paste → plan → approve one → intro ask → reply → chats view → prep → note → thank-you → trust offer. It fails on any
dash, any empty state without a button, any card without a why, and takes a screenshot at each stop.

### 6.4 Loop three: does it hold up (real accounts)

With the founder's LinkedIn, Gmail, Calendar and notetaker connected: one real posting, one real intro ask (sent
only if the founder wants), one real reply with slots, one real recorded 10-minute call, one week of the activity
line. Each step's result written into the "Live check" section of this file, as 20 did: what came back, how long it
took, what it cost (the connector ledger and the research runs table). A piece that fails the live check stays off
behind its flag.

### 6.5 What to watch after shipping

Logged locally in `db.kv` (no new tracking): time from paste to plan; taps from reply to booked; share of auto-sends
undone (above 5% turns the ladder off for that student and raises a card); notes matched within 30 minutes of a
chat's end; weekly review opened. The chat tool `get_usage` reports them; the founder reads them from the demo
account and his own.

### 6.6 Iteration rounds

Round 1 (after Phase A): loop two on the company page, chats, intro ask and the activity line together, since they
share `PersonRow` and the badge; fix the row design once. Round 2 (after Phase B): the plan and the review, on a
phone first; the walkthrough spec is written here. Round 3 (after Phase C): the ladder on a real week of bumps; the
undo rate; the Settings ladder read by someone new to Orbit. Each round ends with the plan's "What building it
changed" section updated, as 21 does.

## 7. Order of work

| Phase | Pieces | Why this order | Files, mostly |
|---|---|---|---|
| A (days 1 to 5) | 4.7 activity store and line; 4.2 company page; 4.3 intro note; 4.4 chats view; 4.5 notes check, guard and fixes | Small, independent, all touch the row and badge design, and the chats view is where the notes work shows | `engine/activity.ts`, `components/ActivityLine.tsx`, `engine/graph.ts` (reachCompany), `pages/Company.tsx`, `components/map/RouteBadge.tsx`, `engine/introNote.ts`, `engine/drafts.ts`, `engine/chatsView.ts`, `pages/Chats.tsx`, `engine/notesCheck.ts`, `engine/notes.ts`, `engine/meetingApps.ts` |
| Live check (from day 1, in parallel) | 4.5 item 5 | Needs the founder's accounts and a second person; its findings change Phase A's fixes | this file |
| B (days 6 to 12) | 4.1 job link and plan (connector route, builder, Map and Discover doors, onboarding step, demo posting); 4.8 weekly review (needs the Deck from 22; if 22 is not built, the review ships on a plain card and moves onto the Deck later) | The plan reuses the company page's list and the intro note; the review needs a week of data in the demo seed | `orbit-connectors/connectors.ts`, `engine/targetPlan.ts`, `engine/targets.ts`, `pages/MapPage.tsx`, `pages/Discover.tsx`, `pages/Onboarding.tsx`, `onboardingSteps.ts`, `engine/weekReview.ts`, `components/WeekReview.tsx`, `engine/brief.ts` |
| C (days 13 to 16) | 4.9 trust ladder (streaks, window into core, time zones, 60 s undo, Sent for you, Settings ladder) | Last because it changes what sends without a tap; it needs Phases A and B's cards to have produced real approvals in the demo | `engine/trust.ts`, `core/compose/window.ts`, `engine/timezone.ts`, `engine/send.ts`, `pages/Inbox.tsx`, `pages/Settings.tsx` |
| Rounds | §6.6 after each phase | | |

About three weeks for one person; Phase A's five pieces can run as four sessions at once (activity line; company page
with the badge; intro note; chats view with the notes check), since they touch different files, with `PersonRow`
agreed first. Phase B's two pieces can run as two. Phase C is one.

## 8. Decisions to take before building

1. **Onboarding's A job step**: before Goals as proposed (one field, skippable), or folded into Goals as its first
   field. My pick: its own step; one question per screen is what makes onboarding feel short.
2. **Chats as a nav entry** (proposed) or a tab inside People. My pick: nav; it is the page a student opens at 2:50
   pm on a phone and should be one tap from anywhere.
3. **The ladder's kinds**: bumps, thank-yous and scheduling replies (proposed), or bumps only to start. My pick: all
   three offered in that order, each earned separately.
4. **The posting read on `orbit-connectors`** (proposed, one route and a ledger) or on `orbit-research`. My pick:
   connectors; it is a fetch and a shape, not research, and the ledger pattern is there.
5. **Webhooks for notes**: out (proposed); the end-of-meeting check gets notes in ten minutes.
6. **The weekly review's time**: Sunday 5 pm local (proposed) or Monday with the morning brief.
7. **The undo window for taps**: 10 s as today, or 60 s to match 07 §4 and the auto-sends. My pick: 60 s for
   auto-sends, 10 s for taps; a tap is already the decision, and a minute's wait makes a sent message feel unsent.

## 9. Not in this plan

A LinkedIn browser extension; push notifications; a Kanban redesign of People; email forwarding for notes; Otter,
Zoom or Meet transcripts; any change to how ties or routes are scored (21 stands); any change to Deep research (20
stands); the server-side autonomy level 2 for replies beyond the kinds the ladder names.

## What building it changed

Built on 2026-10-25, all of it except onboarding's A job step (the onboarding redesign, plan 24, asks for the job and
stores it as `goals.currentJob`; the plan reads it) and Replies (§4.6, the One inbox session). What the build found
and decided, piece by piece:

- **The Map's one field.** The founder asked for the search where the green button was, and no search at the top.
  So the Map has one field in the side panel, "Paste a job link, or a person or company": people and companies as
  the student types, LinkedIn people when they pause, and a pasted link becomes the plan on Enter. There is no
  separate "Find a path to a person": the field is that. On a phone, with a route or a company open, the field folds
  away so the routes stay on screen; Exit reach brings it back.
- **The status line** keeps photos and logos off the line: they trickle all afternoon (a photo every few seconds), so
  the line would never read "Up to date". They are listed in the popover as quiet work. A problem (LinkedIn signed
  out) outranks work in progress on the line, since it is the one thing that needs the student.
- **Route badges** read "Direct · 68" for a tie of the student's own, on the Map too, so the company page and the Map
  show the same words. Warm routes keep "Strong route · 74"; a faint tie is still "Cold tie · 12".
- **The company page** routes the 30 people the network reaches best (by the quick path estimate) when a company has
  more, and the list draws 40 rows at a time as it scrolls. At 2,000 people the page renders in about 0.4 to 0.9 s.
  The team comes from the title's function; recruiters are found before the function (a "Technical Recruiter" is
  recruiting, not engineering).
- **The intro note** is a field on the ask's draft (`forwardNote`) rather than a second draft from the start: a
  second draft row would show up as an unsent draft everywhere drafts are counted. By email the approved bytes are
  the ask, a rule (`----`) and the note, one message. On LinkedIn the ask goes alone and the note becomes its own
  `forwardable_blurb` draft, sent with "Send the note to Kenji" (it never waits out the cooldown). The never-write
  check is the research function's own (`_shared/research/guards.ts`). The student's lines live in Settings, You, as
  "Your three lines".
- **Chats** link Prep to the deck (`?tab=facts&prep=1`). Drafts' Coming up keeps the names (the e2e and the student
  both read them there) and links each one, and "Open your chats", to the page.
- **The notes check** asks the notetaker from the meeting's start without moving the regular import's place. The
  matching guard holds a recording of people Orbit cannot tie to a chat on a card ("Was your 2 pm meeting with Priya
  and Sam a networking chat?"): yes files it as a chat, no files it with nobody, and it is never asked twice.
  Fireflies' API answers any origin (checked live), so a pasted Fireflies key works without orbit-notes; its address
  joined the page's connect-src. The Dictated button's line no longer claims a different reading: the extractor reads
  dictation the same way as typed notes. The Wispr mapping is still the guess it was: pinning it needs a recorded
  real response (live check below).
- **The posting read** tries the page's schema.org JobPosting data first (Greenhouse, Lever, Ashby and Workday
  publish it), and asks the model (claude-haiku-5-5, one forced tool call) only for what it leaves out or when there
  is none. The cache is `orbit_private.posting_cache`, reached through two service-role functions. The ledger is a
  visitor bucket, 10 reads a day (`ORBIT_POSTINGS_PER_DAY`); a cache hit counts nothing. Redirects are followed by
  hand and each address is checked, so the route never reads a private address.
- **The plan's picks** put a strong tie of the student's own (direct, 60 or more) ahead of anyone on the posting's
  team, and spread intro asks across introducers (one person is not asked for three intros at once). With a company
  and no role, the role the student is going for (goals) tells who is on the team. "The hiring manager" and "recruits
  for this posting" are said only when the posting names that person; otherwise "leads the team" and "recruits at
  Stripe". The held step (the person who leads it) is drafted by the reply check when the reply it waits on arrives,
  or on its day. Plans are kept in Dexie v9 (plan 24 took v8).
- **The weekly review** opens by itself only once per visit and never over another deck; Drafts keeps "Last week's
  review" for eight days. A week with a holiday names the earliest one.
- **The trust ladder** follows the level-2 rules literally: a tie score of 40 or more, five a day, the recipient's
  morning window. That holds back most bumps (people who have not answered are rarely at 40), which is the safe
  side; the card waits for the student as before. The window is now in `packages/core/compose/window.ts`; the
  server's copy stays where it is (moving it would change orbit-api's bundle for no change in behavior) and a test
  holds the two to the same answers. `set_auto_kinds` is `update_limits`' `autoKinds` (the tool list has room for 95).
  An undo of something Orbit sent is counted in `trust:undone:` for the watch in §6.5.
- **Chat tools**: `plan_for_posting`, `list_upcoming_chats` and `week_review` are new; `company_reach` is
  `find_routes`' company answer, which now lists the five best ways in by team. The router sends a job link, "I'm
  applying to Stripe", "my coffee chats this week" and "how did my week go" to them.
- **Flags** are `flag:<piece>` rows in db.kv, on unless a row says false, plus an `OFF` set in `engine/flags.ts` for
  the one-commit switch.

### Live check (founder, once)

Not done in the build; each needs a real account:

1. A live Greenhouse link with LinkedIn connected: the three are real people at that company, and Settings' search
   budget line shows the spend.
2. Fathom (key and sign-in), Granola, Wispr Flow and Fireflies each connected to a test Orbit, one short recorded
   call with a second account: within 15 minutes the note, facts, stage and thank-you appear and the Chats row
   updates. Record each app's response shape and latency, and pin Wispr's mapping to a recorded response.
3. One real intro ask by Gmail (the rule and the note arrive as one message) and one on LinkedIn (the note as a
   second message).
4. A week of the status line; a real week of bumps on the ladder, and the undo rate.
