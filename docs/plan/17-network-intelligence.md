# 17 · Network intelligence: one person across sources, true closeness, warm paths, Discover, accuracy

Status: in progress (2026-10-22). Owner: Orbit. Scope: local (browser) mode first, since that is how students use
Orbit today (Gmail in the browser, iMessage import, live LinkedIn through the Unipile proxy); account mode keeps
working and gets the same core logic where it shares packages/core.

Rule for every workstream: use open-source code before writing our own (check the licence: MIT, Apache, BSD, ISC).

## What is wrong today (from the code, 2026-10-22)

| Area | Root cause | Where |
|---|---|---|
| Same person across sources | Phones are stored but never used to match; `mergePeople` drops phones and text history; name+company auto-merges namesakes; nicknames, middle names, ø/ł/ß and non-Latin names handled in some matchers only (enrich.ts treats any two non-Latin names as equal) | core/entity/resolve.ts, web/engine/people.ts, enrich.ts, vcard.ts |
| Two LinkedIn profiles merged | Same-name LinkedIn people paired or merged by name | fixed 2026-10-22 (`differentLinkedInProfiles`) |
| Closeness ignores LinkedIn | The inbox reader writes no touchpoints; comments/reactions never read; texts timed at the day's first message give 0-hour reply latency | linkedinInbox.ts, tieScore.ts, imessageDb.ts |
| "Replied on LinkedIn" when they did not | Inbox messages are not compared with the outreach time; confidence forced to 0.85 (auto-applies); name fallback can bind a namesake's member id; checkpoint skips truncated pages | linkedinInbox.ts, connectors.ts `unipileInbox` |
| Warm paths to 2nd-degree people fail | Browser route finding never passes LinkedIn mutuals or Village paths as candidates; edges not recomputed after adding a found person; routes through LinkedIn-only ties sit at the MIN_PATH_P cut; Village 503 (secret missing) swallowed | engine/graph.ts, core/graph/route.ts, MapPage.tsx, linkedinSearch.ts, connectors.ts |
| Discover shows only people you already have | Browser mode never sources new people; search sends keywords only and no cursor; Match/Reach are step functions (28/25 on most cards); outreach history and dismiss reasons unused | Discover.tsx, core/recommend/score.ts, brief.ts |
| Chat forgets the student | Local mode stores no memories; a recruiting goal set in chat never reaches drafts or recommendations | chat/agent/afterTurn.ts, tools/network.ts, brief.ts |
| Resume misread | Heuristic parser puts employers into Education when a heading is not recognised; facets fall back to other users' rows; Claude parsing needs the student's own key | core/resume/parse.ts, web/engine/resume.ts |
| Thin person profiles | One enrichment path (8 LinkedIn name lookups a day), no education/experience history, so alumni status is guessed | enrich.ts |

## Workstreams

### A. One person across Gmail, iMessage, LinkedIn (identity resolution)
- One matcher in core used by every path (resolve, enrich, inbox fallback, mutuals): normalised names with
  transliteration (`any-ascii`, ISC), nickname table (`carltonnorthern/nicknames`, Apache-2.0), middle-name and
  double-surname tolerance, Jaro-Winkler (existing) plus phonetic key (double metaphone from `talisman`, MIT).
- Phones as a first-class identity: `libphonenumber-js` (MIT) for E.164 with the student's region; phones in
  `IncomingIdentity`, deterministic match on a shared number, duplicate blocking on phone and member id.
- Evidence levels (Fellegi-Sunter style, our existing weights): deterministic (email, phone, slug, member id) →
  auto; name + one independent corroboration (work address fits name, same school, same phone country + name) →
  auto above 0.92; name + company only → suggestion, never auto (removes the namesake auto-merge).
- Hard negatives: two LinkedIn profiles, two different phone numbers both verified by Contacts, a stated
  "different people".
- `mergePeople` keeps phones, text threads, LinkedIn ids and photos.
- Gmail ↔ LinkedIn joining: a Gmail person with no LinkedIn is looked up (enrichment E) and joined only on a
  confident match (name + company/school/location agreement).
- Tests: a labelled corpus (≥150 pairs: nicknames, accents, CJK, maiden names, job changes, shared numbers,
  namesakes at one employer, Gmail-only vs LinkedIn-only) with precision ≥ 0.99 on auto-merge and recall reported.

### B. LinkedIn DMs and comments in closeness
- Proxy routes (Unipile): 1:1 chat history (`/chats`, `/chats/{id}/messages`), the student's posts
  (`/users/{me}/posts`), their comments and reactions (`/posts/{id}/comments`, `/posts/{id}/reactions`), and the
  student's comments on others' posts where Unipile exposes them. Paged with cursors; nothing skipped silently.
- Touchpoints: `linkedin_in` / `linkedin_out` per day per person from DMs; `linkedin_comment_in/out`,
  `linkedin_reaction_in` from posts. Matched by member id only (no name fallback for writing ids).
- Closeness (tieScore): LinkedIn DMs count like email; comments and reactions are weak, capped signals (they
  show attention, not a relationship); texts get real per-message timing so reply latency is honest.
- Replies: a LinkedIn message counts as a reply only if it is after the outreach went out, and it proposes (0.7,
  student confirms) unless Orbit itself sent that outreach on LinkedIn.
- Tests: mocked Unipile pages (truncation, groups, duplicates, ids), scoring fixtures (a friend you only DM, a
  stranger who reacts to every post, a recruiter who wrote first).

### C. Warm paths that work for LinkedIn people
- Route finding in the browser passes LinkedIn mutuals (1st-degree connections who know the target) and Village
  paths as candidates; mutuals fetched on demand for the target and cached.
- Adding a found person recomputes their edges; the Map shows "People who know them" (mutuals with photos) even
  when no scored route clears the bar, ranked by how close you are to each.
- Route probability floor for LinkedIn-only first hops tuned so a real mutual is never dropped; explain "weak tie"
  instead of hiding it.
- Village: health check, clear "not set up" state in Settings, read key from the secrets table.
- Tests: fixtures for a 2nd-degree target (found by search, with/without member id), a target with mutuals only,
  a target with Village paths, and the Map/chat answers for each.

### D. Discover as a feed of new people
- Infinite feed of people not in the network, sourced from LinkedIn search with filters built from the student's
  goals and from who they actually reach out to (titles, companies, schools of sent outreach), paged by cursor.
- "Proactive" rows: why this person now (shared school, a mutual, a target company, someone like the people who
  replied), each with one action (warm-up, ask for an intro through X, write).
- Scores: continuous fit (title similarity, seniority fit, company tier/target priority, shared school, recency)
  and reach (best mutual / path probability), so cards differ; dismiss reasons feed the next page.
- Tests: ranking fixtures, paging (no repeats, no people already known), learning from dismisses.

### E. Enrichment waterfall
- One pipeline, cheapest and most certain first, stops when fields are filled with enough confidence:
  1. What Orbit already has (email signatures, calendar, notes, resume of the student).
  2. Gravatar by email hash (free) for photo/name.
  3. Unipile full profile (`linkedin_sections`: experience, education, skills) for LinkedIn people → real
     education history, so alumni status is evidence, not a guess.
  4. Unipile search by name + company/school for Gmail-only people (joins identity, A).
  5. Web (Exa search + page contents; Firecrawl as fallback) for bios, personal sites, GitHub, publications.
  6. Paid people-data APIs (Apollo, People Data Labs) only if the student provides keys.
- Every enriched field records its source and confidence; nothing overwrites a field the student set.
- Budget and rate limits per day; runs in the background with a visible status.
- Tests: waterfall order, stop conditions, provenance, conflict handling, budget caps, offline fallback.

### F. Accuracy audit (no claim without evidence)
- Every sentence the app says about a person (alum, replied, closeness, last touch, "knows X", why now) traced to
  stored evidence; claims without evidence removed or reworded.
- Alumni only from education evidence (LinkedIn education, a school address of the same school, the student's
  own statement), never from a headline mention or employer domain.
- A one-time repair of saved data (false alumni, false "replied" stage moves, wrong companies).
- Tests: a "skeptical student" checklist per screen run against a seeded real-looking account.

### G. Chat that remembers and answers well
- Local memory store (Dexie) with the same remember/recall/forget tools as account mode; extraction after each turn
  (Claude through Orbit's proxy when allowed, heuristics otherwise); recruiting goals from chat update the goals
  that drafts and recommendations read.
- Resume: fix section detection; never read another user's facets; Claude parsing through the proxy; school,
  majors, past employers flow into the profile with the student's confirmation.
- Simulation: hundreds of scripted and generated conversations (single and multi-turn) through the real engine:
  router mode offline for every run; Claude mode with a judge when a key and budget are available. Scorecard per
  capability (right tool, right card, no invented facts, concise), regressions fail CI for router mode.

### H. Chat cards (in progress separately)
Compact cards, no duplicate status lines, next-step chips (e.g. "Draft a message to each").

## Sequencing
1. A, B, C, D, F in parallel (separate worktrees; owners per file area below), H finishing.
2. E after A (uses the matcher), G after H (shares chat files).
3. Merge in order H → A → B → C → D → F → E → G, full unit + e2e after each merge, then push.

File ownership to avoid conflicts: A = core/entity, engine/people.ts, imessage*, vcard.ts, enrich.ts matching;
B = linkedinInbox.ts, connectors.ts (chats/posts routes), unipile.ts (inbox/posts), core/scoring;
C = engine/graph.ts, core/graph, MapPage.tsx, warmIntros.ts, village; D = Discover.tsx, core/recommend,
brief.ts recommendations, linkedinSearch.ts search params, connectors.ts `/search`; F = claims and repairs it finds,
coordinating with owners.

## Needs from the student
- An Anthropic API key in the shell (`ANTHROPIC_API_KEY`) or approval of a budget on Orbit's server key, for
  Claude-mode chat simulations (router-mode simulations need nothing).
- Optional enrichment keys: Exa, Firecrawl, Apollo or People Data Labs (stored as Supabase function secrets).
- Village: `VILLAGE_USER_EMAIL` and the key as function secrets, if warm intros through Village are wanted.
