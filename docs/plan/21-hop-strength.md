# 21 · Every hop counts: how well each person on a route knows the next

Status: built (2026-10-25; see "What building it changed" at the end). Reviewed twice (a research pass on how Village, The Swarm, Connect The Dots, Affinity,
Homie, Via and the tie-strength literature do this, then an adversarial review of the draft; both folded in).
Owner: Orbit. Scope: both modes; the model lives in packages/core, the LinkedIn reads in orbit-connectors (browser)
and `_shared/providers/unipileResearch.ts` (account mode). Builds on plan 16 §4 (route ranking) and plan 17 §B/§C/§E
(LinkedIn activity, warm paths, enrichment). Depends on the mutual-connections fix of 2026-10-25 (`connections_of`
as an array, answers checked against LinkedIn's shared-connections count; deployed at ccd0a5b, CI pending): without
real mutuals there is nothing to weigh.

## 0. The founder's ask, in one line

A route is only as good as its weakest hop. Today the order of LinkedIn routes is decided almost entirely by how
close the student is to the first person; how well that person knows the next one (and the next) is a constant.
Weigh every hop from what the two people actually do with each other — reactions and comments on each other's
posts, shared employers and schools, what research on the pair shows — and make the result honest enough to act on.

## 1. What is true today (from the code)

- `rankWarmPaths` (core/graph/route.ts) already multiplies hop probabilities:
  `P = p_ask(A) · Π p_know(hop) · r_T · 0.85^(hops − 2)`, Yen's k-shortest paths over −ln p. The shape is right.
- `p_know(A, B)` is the pair weight from core/graph/ties.ts: a noisy-OR of evidence kinds, each with a weight and a
  confidence, decayed. Kinds: `email_exchange`, `email_cc`, `email_cothread`, `meeting_coattendee`, `introduced_by`,
  `linkedin_mutual`, `village_path`, `co_tenure`, `same_school_cohort`, `same_current_company`.
- Every kind except the affiliations needs the student in the picture (their threads, calendar, introductions). For two
  people who know each other without the student, Orbit has a flat `linkedin_mutual` (0.3 × 0.95 for *every* mutual),
  Village's warmth where Village is set up (it is not), and affiliations when both people's history is in Orbit.
- So for a target reached through LinkedIn, all N mutuals get the same last hop (0.3), and the route order is the order
  of the student's own tie scores; "People who know Arlan" (ReachMutuals.tsx) sorts by the student's score alone. That
  is what the founder saw.
- LinkedIn engagement is read only around the student (engine/linkedinActivity.ts: comments and reactions on the
  student's posts, the student's own comments) and feeds the student's tie scores, never a pair.
- Pairs are **undirected**: one `TiePair` per `a|b`, `addEdge(..., directed = false)`. Anything direction-dependent
  must be expressed through reciprocity, not a per-direction weight (§3.3).
- Plan 16 §4.3 named the learning loop (`intro_requests` outcomes → a fit over hop features once ≥ 200 outcomes exist).
  Nothing is logged yet.

## 2. What can be observed about a pair A ↔ B (neither is the student)

Through the student's LinkedIn (Unipile), for any person with a member id:

| Signal | Where it comes from | Cost | Notes |
|---|---|---|---|
| B's posts | `GET /users/{B}/posts` (≤ 100 per page, dated, counters, `is_repost`, `repost_content.author`) | 1 call | The index everything else is matched against: a post id → B, with its date. |
| A's reactions, with each post's author id | `GET /users/{A}/reactions` (100 per page) | 1 call | **No date on a reaction.** Its date is taken as the post's date, known when the post is in a posts list Orbit read (B's). Otherwise undated → counted at the oldest recency step. |
| A's comments | `GET /users/{A}/comments` (100 per page, dated, post ids, no post author) | 1 call | Author resolved by intersecting post ids with the posts lists Orbit read (B's). No per-post lookups. |
| Who commented on B's posts, and B's replies | `GET /posts/{id}/comments` | 1 per post | Used only for the top few of B's recent posts: **B replying to A's comment** is the one public act where B acknowledges A. |
| Recommendations A ⇄ B | profile `recommendations.received/given[].actor.provider_id` (a `linkedin_sections` read) | part of a profile read | People write these only for real colleagues: the strongest public pair signal. |
| Experience and education of A and B | profile sections (plan 17 §E stores them as affiliations) | profile read | Gives `co_tenure`, `same_school_cohort`, `same_current_company` for pairs Orbit could not score before. |
| B's followers and connections | profile (`follower_count`, `connections_count`) | same read | Needed to discount engagement with popular people; **read before any engagement is scored** (§3.3). |
| Mentions | post text `mentions[]` | with the posts list | A mentions B in a post: rare; weak when many people are tagged. |
| Common contacts inside Orbit | the student's own pair graph | free | People C with a real tie to both A and B. |
| Common LinkedIn contacts | `connections_of: [A]` ∩ `connections_of: [B]` within the student's 1st degree | 1–10 search pages per person, against the ~1,000 rows/day search allowance | Phase 3 at the earliest. |

Not observable: A and B's direct messages or email; their shared-connections count (LinkedIn shows it only relative to
the viewer); whether A and B are connected when neither is the student's 1st degree; reaction timestamps. Not
observable — and not inferable — is the *private* relationship between two colleagues who never touch each other's
posts, which is most real colleagues (§3.4).

LinkedIn limits (Unipile's guidance): ~100 profile reads a day, ~100 of any other read a day, ~1,000 search rows a
day, calls spaced at random, never in bursts; exceeding them risks a restriction on the student's *personal*
account. Everything here shares those allowances with the connection sync, the inbox reader, Discover's searches, the
photo refresh and the enrichment waterfall. §6 sets one budget for all of it.

## 3. The model

### 3.1 Keep the structure, change the inputs

`P = p_ask(A) · Π p_know(hop) · r_T · 0.85^(hops − 2)` stays (it is a probability, and the product over −ln p is the
standard uncertain-graph reachability model; Village's "capped at the weaker hop" is the alternative, and naming the
weakest hop in the reason text gives the student what that cap communicates). `p_know` stays a noisy-OR of evidence
kinds with decay (`combineTies`): the kinds are mostly independent sources (mail vs calendar vs LinkedIn vs employer
history). What changes is which kinds exist, how their weights are computed, and which kinds may *create* a route
versus only *strengthen* one. `p_ask` (the first hop) does not change.

### 3.2 Evidence kinds (core/graph/ties.ts)

| Kind | w (before decay) | c | Creates a route? | Decay | Evidence stored |
|---|---|---|---|---|---|
| `linkedin_recommendation` (new) | 0.85 | 0.95 | yes | half-life 5 years from the recommendation's year | direction, year, the first 80 chars of the caption (no body) |
| `linkedin_engagement` (new) | §3.3: ≤ 0.25 one-way, ≤ 0.5 reciprocal | 0.9 | **no** (support only) | built into E's recency | counts by kind and direction, newest post date, popularity used, post ids |
| `linkedin_mention` (new) | 0.6 ÷ max(1, tagged − 1) | 0.9 | no | 2 years | post id, date, tagged count |
| `common_contacts` (new) | `0.5 · (1 − e^(−S/2))`, S = Σ over common contacts of the weaker of their two tie weights | 0.6 | **no** (support only) | none | up to 5 contact ids |
| `student_says_close` (new) | 0.8 | 0.9 | yes | none | when, from the hop menu |
| `web_comention` (phase 3, optional) | 0.4 | 0.6 | no | 2 years | the page where a Deep research brief (plan 20) on one of them named the other |
| `linkedin_mutual` (existing) | 0.3 (unchanged; **no downgrade for silence**, §3.4) | 0.95 | yes | none | as today |
| `same_current_company` (existing) | by employer size: < 50 people 0.7 (c 0.8); 51–500 0.45 (c 0.45, so not routable alone); over 500 as today | | as today | | adds the size bucket |
| `co_tenure` (existing) | as today, confidence sharpened in §3.6 | | yes | as today | |

"Creates a route" = member of `ROUTABLE_TIE_KINDS` or counted in `isRoutable`'s confidence rule. The support-only
kinds go in a new `SUPPORT_ONLY_TIE_KINDS` set that `isRoutable` ignores entirely: engagement and common contacts
only make a pair that is already routable (connected on LinkedIn, mailed, met, recommended) stronger. They never
conjure a route between two people Orbit has no connection evidence for.

A **blocked pair** ("they don't really know each other", §3.5) is not a tie — a noisy-OR cannot lower a weight. It is
a `blockedPairs: ReadonlySet<string>` on `WarmPathInput`, filtered in `routingGraph`, stored in its own table.

### 3.3 Engagement, E → w

Over the engagement Orbit has read between A and B, either direction, with the post author's popularity known:

```
E = Σ_items  kind_weight × popularity(post author) × recency(post date) × volume(actor)
kind_weight:   author's reply to the other's comment 1.5 · comment 1.0 · repost 1.0 · reaction 0.1
               (mentions are their own kind, `linkedin_mention`, not part of E)
popularity:    audience = max(2000, followers of the post's author)
               reactions: 2000 / audience        comments, replies, reposts: sqrt(2000 / audience)
               followers unknown: 0.25 (conservative), and the hop's band may not rise until known
recency:       1 within 12 months · 0.6 within 24 · 0.35 older or undated (a reaction whose post is not in a
               posts list Orbit read has no date and counts as old)
volume:        a reaction from someone whose reactions page holds ≥ 60 items counts ×0.5 (a serial liker)

reaction-only E is capped at 1 (likes alone never make more than w 0.21 before the one-way cap)
reciprocal = both people have at least one comment, reply or repost on the other's posts (reactions do not count)

w_pair   = reciprocal ? min(0.5, 0.75 · (1 − e^(−E/3))) : 0          (the pair as a whole)
w_by[X]  = min(0.25, 0.75 · (1 − e^(−E_X/3)))                       (X's own acts alone)
hop A → B (A introduces the student to B):  p_know = noisy-OR(pair, w_by[B] · 0.9)   when not reciprocal
```

**Direction (found by the simulation, §11).** One-way engagement says something only in one direction: B reacting
to and commenting on A's posts means B knows A, so A's intro to B lands; A doing that to B's posts is what fans do.
So one-way engagement counts toward a hop only when the person being introduced did the engaging (for the last hop:
the target engaging with the mutual), never when the introducer did. The routing graph gets a directed edge each way
when the two directions differ. A mutual's comments on the target's posts are still shown to the student ("has left
3 comments on Arlan's posts"); they add nothing to the score. With the first draft's rule (one-way counted both ways,
capped at 0.25) the simulation ranked routes slightly *worse* than today (rank correlation 0.35 vs 0.36): fans were
lifted as much as colleagues. A sweep of the one-way cap (0.25, 0.15, 0.1, 0.05, 0) improved monotonically to 0.48 at
0 for the introducer's side; the directional rule keeps that and adds the target's side.

Why (sources in §9): a comment is a deliberate written act and predicts tie strength far better than a like, which the
literature finds is not among the top predictors at all; a like among thousands is noise; recency weighs most; a
prolific liker's like is worth less; and — the review's central point — **one-way public engagement mostly measures
fandom**: fans, sellers and engagement pods comment three times on someone's posts, close colleagues usually do not.
So one-way engagement can lift a hop from "connected" to a better-looking "connected", never to "know each other";
only reciprocity (and above all the author replying to the person) can, and even that is capped below what a real
email exchange or a recommendation gives.

Worked values (popularity 1, recent, no volume discount), before the mutual is combined in:

| Evidence | E | w |
|---|---|---|
| 1 reaction | 0.1 | 0.025 |
| 6 reactions | 0.6 | 0.14 |
| 20 reactions (capped at E = 1) | 1 | 0.21 |
| 1 comment | 1 | 0.21 |
| 3 comments, one way | 3 | 0.47 → **0.25** (one-way cap; counts only if the target wrote them) |
| 1 comment + the author's reply | 2.5 | 0.42 (reciprocal cap 0.5 not reached) |
| 3 comments each way | 6 | 0.65 → **0.5** (reciprocal cap) |
| 6 reactions on a 30,000-follower person | 0.04 | 0.01 |
| 3 comments on a 30,000-follower person (×0.26) | 0.77 | 0.17 |
| 3 comments on a 100,000-follower person (×0.14) | 0.42 | 0.10 |

Combined with the base `linkedin_mutual` (0.3 × 0.95 = 0.285) by noisy-OR (engagement c 0.9): the target commenting
3 times on the mutual's posts → **0.45**; the mutual commenting 3 times on the target's → **0.285** (unchanged); 1
comment + the author's reply → 0.55; 3 comments each way → **0.61**. A recommendation alone → 0.81 when new (0.85 ×
0.95, then a 5-year half-life); an email exchange → 0.69.

### 3.4 Absence of evidence counts for nothing

An earlier draft lowered a LinkedIn connection's weight when the pair was "checked and silent". The review was right
that this is backwards: most real colleagues never touch each other's posts, so public silence says nothing about a
private relationship, and acting on it would skip the best introducer. **A connection with no engagement stays at
0.3, its text stays "connected on LinkedIn", and nothing Orbit reads can lower a pair below that.** Only the student
can (§3.5).

### 3.5 What the student can say

Two corrections from a small menu on the hop: **"they don't really know each other"** — a blocked pair, the route
disappears until the student undoes it (stored as `blockedPairs`, not a tie) — and **"they're close"** — a
`student_says_close` tie (0.8 × 0.9). These are the cheapest, most reliable evidence Orbit will ever get, and they
are labelled data for §8.

### 3.6 Affiliation kinds, sharpened (existing kinds, new inputs)

- `co_tenure`: confidence as today (halves over 5,000 people; shrinks when it ended > 10 years ago), plus: under 50
  people ×1.3 (capped 0.9), 50–200 ×1.1, over 10,000 ×0.7 on top of the halving; peer seniority (both C-level, both
  senior, both junior — route.ts already has the classes) ×1.15, a two-class gap ×0.8; the same function word in
  both titles ×1.1. Dates and company ids come from both people's LinkedIn experience (plan 17 §E), which this plan
  makes a route-priority read.
- `same_current_company`: the size scale of §3.2. Two people at a 12-person startup or in one lab almost certainly
  know each other; this is the most common real signal for a student's targets, and today it is uniformly weak.
- `same_school_cohort`: unchanged (same years only; other years ≈ 0, as Village and The Swarm also found).
- `common_contacts`: S sums the *weaker* tie of each common contact, so three faint common contacts are worth less
  than one person who emails both.
- Reposts: A reposting B's post is in A's posts list (`is_repost`, `repost_content.author`); an engagement item of
  weight 1.0 when that list is read anyway.

### 3.7 Bands, and the ranking of "People who know {target}"

Hop band from p_know, pinned: **close ≥ 0.65 · know ≥ 0.5 · connected ≥ 0.2 · unclear < 0.2**. With the caps of
§3.3 this gives: one-way comments stay "connected" (0.45), reciprocal comments reach "know" (0.61), a
recommendation, an email exchange or small-company co-tenure reach "close". The vocabulary of §7 is tied to the band.

"People who know {target}" sorts by `p_ask(student→A) · p_know(A→target)`, not by the student's score alone, and
shows both halves in words ("you: close · knows Arlan: connected"). Expect this to change the order only where
evidence exists (§6, coverage).

## 4. Where the evidence comes from, in order of cost

Evidence is gathered per **person** and matched per pair, so one read serves every hop that person is on:

1. **Free, always:** Orbit's own records (mail, meetings, introductions), affiliations already stored, common
   contacts, the student's corrections. Computed in `inferTies` as today, plus the new kinds.
2. **Profile reads** (shared with plan 17 §E's waterfall): for the target and each person on a candidate route who
   lacks it, a profile read with `experience,education,recommendations`; `follower_count` and `connections_count`
   kept on the person. **The target's profile is read first**, before any engagement is scored (popularity). The
   waterfall's queue gets a priority bucket "on a route the student is looking at", above "in the pipeline".
3. **Engagement reads (new):** the target's posts list, reactions page and comments page (3 calls, after the profile);
   then, for the top 5 mutuals by current ranking, each one's reactions page and comments page (2 calls each),
   matched against the target's post ids; then the target's 3 most recent posts' comment threads for author replies
   (3 calls). ≈ 4 + 10 + 3 = 17 calls for a fresh target. A person's pages are cached 30 days and reused for every
   target they are a mutual of; a target's pages are reused when they appear as a middle hop elsewhere.
4. **Deferred:** LinkedIn common contacts; Village (unchanged, when configured); web co-mentions.

Reads happen **only when the student opens a target** (the Map's reach panel, a person's Reach tab, or a chat
`find_routes` for a named person) and never on a timer, never as background prefetch: steady third-party reads from
a student's personal account are the pattern that looks most like scraping (§6). Rendering is **progressive**: the
panel shows what Orbit has at once, hops still being read say "Checking…", evidence lands over one to three minutes
(jittered spacing), hop words update in place, and the route order changes only behind an "Order changed · refresh"
chip or on the next open — never under the student's hand.

## 5. Components

### 5.1 core (pure, shared)
- `types.ts`: the `EdgeType` union gains the new kinds (and `TIE_CONFIDENCE: Record<TieKind, number>` must list
  them, or nothing compiles).
- `graph/ties.ts`: the kinds of §3.2, `SUPPORT_ONLY_TIE_KINDS`, `isRoutable` ignoring them; `engagementWeight(items,
  popularityOf, now)` with the caps; `commonContacts(pairs, a, b)`; per-kind half-lives in `decayedTieWeight`
  (interaction kinds 2 years as today, recommendation 5, mention 2); `TieInput` gains `engagement`, `recommendations`,
  `mentions`, `followers`, `studentSays`. Engagement ties are produced by `inferTies` and reach `rankWarmPaths`
  through `pairs` — never as `ExternalCandidate`s (`withExternal` hardcodes the mutual's 0.3/0.95 and skips a kind the
  stored pair already has).
- `graph/route.ts`: `WarmPathInput.blockedPairs`; `WarmHop` gains `band` (§3.7) and `checking?: true`; `hopEvidence`
  phrases for the new kinds; the reason text names the weakest hop when it is not the first ("…though Noah and Arlan
  are only connected on LinkedIn"). The pinned strings in `route.test.ts` and `ties.test.ts` for the existing kinds
  are rewritten with the vocabulary of §7.
- `scoring/`: untouched.

### 5.2 orbit-connectors (browser mode)
- New account route `POST /engagement`: body `{ accountId, memberId, want: ('posts'|'reactions'|'comments'|
  'thread')[], postId?, cursor? }`; one Orbit call makes one upstream call (so the budget is exact) and returns the
  mapped page: posts `{id, at, reactionCount, commentCount, repostOf?, mentions[]}`, reactions `{postId, authorId,
  value}`, comments `{postId, at, replyToCommentId?}`, thread `{commenterId, at, isAuthorReply}`. **No comment text
  for third parties** (ids, dates, counts only; §7). Upstream calls carry 400–1,500 ms of jitter.
- `/profile` learns the `recommendations` section and returns `follower_count`, `connections_count`.
- The shared ledger of §6 replaces the per-route buckets for all non-messaging reads.

### 5.3 account mode
- `_shared/providers/unipileResearch.ts`: `postsOf`, `reactionsOf`, `commentsOf`, `postComments`; a worker job
  `hop_evidence` per target, triggered by the same student actions (an API call from the app), within the same ledger
  (keyed by the Unipile account id, so browser and server cannot double-spend); new kinds in `orbit.ties` (kind check
  constraint + migration); `blocked_pairs` table.

### 5.4 browser engine
- `engine/hopEvidence.ts`: the per-person store (`db.engagement`: `{ userId, memberId, posts[], reactions[],
  comments[], threads[], readAt, cursors }`), the queue (target profile → target pages → top-5 mutuals' pages → the
  target's 3 latest threads), the ledger check, and `evidenceForPairs(ids)` → `TieInput.engagement`.
- `db.blockedPairs` and `student_says_close` edges; Dexie version bump; `db.engagement` deleted on LinkedIn disconnect
  (derived ties fall back to `linkedin_mutual` alone).
- `engine/graph.ts`: `buildReachGraph` feeds the new inputs and `blockedPairs`; `reachPerson` returns at once and
  emits a second result through an `onUpdate` callback when the queue lands new evidence.
- `engine/enrichment`: the "on a route" priority bucket; `recommendations` and follower counts into the profile record.
- `engine/externalRoutes.ts`: the mutuals result (member ids) seeds the mutual-side reads; mutuals without a member
  id (export-only people whose `withMemberId` lookup has not run) are skipped, not guessed.

### 5.5 UI
- Map route card (MapPage.tsx): a band word per hop and, with explanations on, the evidence line; "Checking…" while a
  read is in flight; the weakest hop marked when it is not the first; the correction menu on each hop; the "Order
  changed · refresh" chip.
- ReachMutuals.tsx: sorted by §3.7, two words per row, the correction menu.
- Chat `find_routes`: the reason text flows through as today. **Intro drafts never mention third-party engagement**
  ("you've commented on a few of Arlan's posts" tells A the student has been watching A; it costs the ask).
  Engagement is for ranking and the student's eyes only.
- Settings › Integrations: "LinkedIn reads today: 31 of 100", one number for everything (§6).

## 6. Budget, caching, pacing, coverage (what decides whether this works in real life)

- **LinkedIn ledgers per account and per kind of read, ~100 a day each** (Unipile's guidance is per action: ~100
  profile visits, ~100 of each other read such as posts, ~1,000 search rows; implementation read the guidance more
  closely than the first draft, which had one ledger of 100 for everything). Within each ledger, callers have
  priority ceilings, so lower priorities stop first: profiles — route reads 100, photos 80, enrichment 70; posts —
  route evidence 100, the student's own post activity 85; searches — mutuals 100, Discover 80. Keyed by the Unipile
  account id (browser and server share it). Settings shows the day's use. The downside of a restriction on a
  student's personal account during a job search is asymmetric, so nothing goes above Unipile's numbers.
- Engagement gets what is left after sync and the reply reader — on a normal day 40–60 calls, i.e. **two or three
  fresh targets fully checked a day**, the rest partially (target side first), everything the student looked at this
  month already cached (30 days per person). No prefetch, no timers (§4).
- **Coverage, stated plainly:** most LinkedIn members rarely comment, and a student's network (students, juniors)
  less than most. Expect evidence beyond the base connection on roughly 10–20% of hops; where there is none the order
  stays the student-tie order, honestly labelled "connected on LinkedIn". The value is in the hops that do change and
  in never claiming more. §11's simulation is calibrated to the founder's real sparsity, not to a convenient one.
- **Member ids are a prerequisite.** Engagement matches by member id only. The live connection sync stores member ids
  for every connection; people from the LinkedIn export have only slugs until `withMemberId` resolves them (one lookup
  per person per day). Before phase 2, verify on the founder's account that connections carry member ids, and let
  the reach panel resolve the target's and the top mutuals' ids first.

## 7. Privacy and honesty rules

- Only public LinkedIn activity is read. Comment text of third parties is not stored or shown; counts, dates, post ids
  and member ids are. Recommendation bodies are not stored.
- Every hop sentence maps to a stored tie with evidence (plan 17 §F). Fixed vocabulary, tied to the band:
  "recommended X on LinkedIn" · "emails with X" · "met X (month year)" · "worked with X at Y (years)" · "went to Y
  with X" · "both commented on each other's posts" · "X replied to their comment" · "has commented on N of X's
  posts" · "has reacted to N of X's posts" · "connected on LinkedIn" · "you said they're close". Never "close
  friends"; never "knows well" from one-way engagement; never anything about a pair's silence.
- Engagement is matched by member id only (plan 17 rule); names never bind.
- Third-party engagement is kept 30 days and deleted when the student disconnects LinkedIn.
- The student's corrections win over everything automatic; a blocked pair survives every recompute until undone.
- Nothing Orbit reads about a pair ever appears in a message to either of them.

## 8. Learning loop (phase 4)

- `intro_requests` outcomes (plan 16 §4.3: agreed / declined / intro_made / meeting / no_response) are logged from the
  intro draft flow and reply detection, with the path's hop features frozen at ask time.
- All constants of §3 live in one `HOP_WEIGHTS` object. At ≥ 200 outcomes across students a logistic regression over
  `[p_ask, per-kind hop weights, hops, popularity, recency]` replaces the hand-set values without touching callers.
- The student's §3.5 corrections are labelled pairs for the same fit.

## 9. What others do, and what the research says (and what Orbit takes from each)

| Product | How | Taken |
|---|---|---|
| **Village** (docs.village.ai; the only published formula) | Additive points: LinkedIn connection +0.7, each meeting +1, recurring +10; work overlap at a company < 20 people +7, < 50 +3, > 100 "lower"; same school + time + major +3, same school other years ≈ 0; "met within last year" +30%. Labels Excellent ≥ 7 / Good 3–7 / Okay 1–3 / Weak < 1. **A multi-hop path is capped at the weaker relationship.** Per hop: score, label, `score_meta` evidence bullets. | A bare connection is a floor, not strength (0.3). Company size decides whether co-tenure means anything (§3.6). Per-hop labels with evidence bullets (§5.5). The weakest hop named (§5.1). |
| **The Swarm** (docs.theswarm.com) | `connection_strength` with `sources[]`: linkedin_connection, work_overlap (dates), email, calendar, education_overlap (same school **and** year), shared_investor, **social_engagement** (comments, reactions, reshares; a reshare is "a strong endorsement"). | Sources kept per tie (`kinds[]`). Reposts as a signal. Education only with the same years. |
| **Connect The Dots** (ctd.ai) | Email counts **only when two-way**; recency and volume; "same company, same time, similar roles → we predict you know each other"; scores user-editable. | Reciprocity as the gate to "know" (§3.3); peer seniority in co-tenure; the student's corrections. |
| **Homie** (warm-paths API) | Per hop `userToConnectorWarmness` and `connectorToProspectWarmness` with a factor breakdown and signal strings ("Both reacted to each other's posts", "3 mutual connections"). | The two-number display of §3.7 and the evidence lines. |
| **Via** (connectvia.ai) | Per hop a `confidence` (0.95, 0.41) with typed `evidence[]`; path = product; "strong paths look strong and weak ones look weak". | Plan 16's product model; the honesty rule. |
| **Affinity, Introhive, 4Degrees, Boomerang, Cabal, Draftboard** | Recency + frequency + reciprocity of email/calendar; Draftboard: shared work history "the heaviest predictor", team > department > company, peer seniority; Boomerang: recency weighs most, "if nothing scores > 50, say so"; Cabal: shorter paths and connector willingness. | Recency first; co-tenure sharpening; `fallback: 'cold'` (exists); `p_ask` (exists). |
| **LinkedIn TeamLink** | Shows only that a colleague is connected; practitioners: "assume a weak tie until the colleague says otherwise". | The 0.3 floor and §3.4. |

Research:

- **Gilbert & Karahalios 2009** (2,184 ties, strength predicted within ~0.1): the strongest predictor is **days since
  last communication (β −0.76)**; **the mean strength of the pair's mutual friends (β +0.26)** supports propagating
  strength along a path; a person's friend count is negative (β −0.14) — popular people's interactions mean less.
  → recency steps and the popularity discount (§3.3); `common_contacts` weighted by the common ties' strength (§3.6).
- **Jones et al. 2013** (PLOS ONE): from interaction counts alone the closest friend is found at 84%; top features are
  messages, photo tags, **comments**, wall posts — **likes are not among the top predictors**; same employer or school
  "contributed little"; public interactions predicted as well as private messages. → reaction 0.1 vs comment 1.0;
  public engagement is legitimate evidence, within its caps.
- **Xiang, Neville & Rogati 2010**: the actor's own activity volume is a nuisance variable. → the serial-liker discount.
- **Backstrom & Kleinberg 2014**: raw mutual count finds a partner 25% of the time; dispersion 48%. → common contacts
  are support only (c 0.6); dispersion is phase 3 if LinkedIn common contacts are ever read.
- **Marsden & Campbell 1984**: frequency and duration are "contaminated by proximity". → the big-employer discount
  stays; `same_current_company` scales down fast with size.
- **Granovetter; Rajkumar et al. 2022** (20M LinkedIn users): moderately weak ties were over twice as effective for
  job moves as strong ties. → the last hop is scored for "knows them enough to pass a note", not closeness; a
  weak-but-real tie is never punished (§3.4).
- **Trust propagation (TidalTrust; Appleseed ~0.85)** and **uncertain-graph reachability** (product of edge
  probabilities, Dijkstra over −log p): each extra hop costs about one label grade. → plan 16's product and 0.85 stay.
- **Tie decay**: exponential; time since last contact ~2× as predictive as time since first. → the recency steps; a
  "fading" word when a pair's newest evidence is older than 8× its cadence (phase 3).

Open source (licences checked): **graphology** + `graphology-shortest-path` (MIT) only if the browser graph outgrows
core's own Yen/Dijkstra (it has not); **networkx** `shortest_simple_paths` (BSD-3) for the offline simulation
harness; SNAP **Higgs Twitter** and the **Facebook New Orleans** wall-post dataset to shape the synthetic engagement
generator's distributions (heavy-tailed actors, celebrity nodes). `appleseed-metric` is AGPL: not used. No public
LinkedIn reaction/comment dataset exists; Orbit's own reads become the corpus for §8.

## 10. Edge cases

- **The target posts nothing.** No posts list → no comment matching, no reaction dates; the target's own reactions and
  comments elsewhere still score the mutuals' side; profiles still give co-tenure and recommendations.
- **Very popular target (100k followers).** Engagement ≈ 0; recommendations and co-tenure unaffected. Routes to such
  people rank on employer history, Village and the student's word, honestly.
- **Huge employers.** `co_tenure` halves over 5,000 and ×0.7 over 10,000; `same_current_company` stays weak.
- **Private or locked profiles (422).** "Could not check"; no retry for 30 days.
- **A person with two member ids** (merged profile). Evidence keyed by member id, joined through the person's ids.
- **The student is one of the pair.** Their own tie score covers it (unchanged).
- **A hop between two people with no LinkedIn member id** (Gmail-only). Free sources only.
- **Rate limit or Unipile down mid-queue.** The queue keeps its place (cursors) and continues on the next open.
- **Engagement pods** (reciprocal comments, both low-follower). Capped at "know" (0.61) — below a recommendation or
  mail; the fit of §8 is where this gets tightened if outcomes show it.
- **Account mode and browser mode on one account.** Same core function, same ledger key: no double-spend.

## 11. Acceptance tests

Core (`packages/core/src/__tests__/route.test.ts`, `ties.test.ts`; fixtures pinned with margins):
1. **The weakest hop decides, when the evidence is real.** Goal `advice` (floor 20). Student→Noah (65)→Arlan with a
   plain connection (0.285) ranks below Student→Jai (40)→Arlan where Jai and Arlan commented on each other's posts
   this year (0.61): P = 0.646 × 0.285 = 0.184 against 0.401 × 0.61 = 0.243. Both shown; Noah's hop reads "connected
   on LinkedIn", Jai's "…and trades comments with Arlan on LinkedIn".
2. **Fandom does not.** The same Jai with 3 comments on Arlan's posts and none back: the hop stays 0.285 (P 0.114);
   Noah stays first and Jai's hop still says "has left 3 comments on Arlan’s posts". The reverse — Arlan commenting
   on Jai's posts — lifts the hop to 0.45.
3. **Popularity.** 6 reactions on a 100,000-follower target move p_know by < 0.01; on a 1,000-follower target by
   ≥ 0.08. Unknown followers (0.25) never lift a hop's band.
4. **Recency, on E.** Items older than 24 months contribute 0.35 of a fresh item's E.
5. **Caps.** 20 reactions → w 0.21; 10 one-way comments → 0.25; 10 comments each way → 0.5.
6. **A four-person path** with hops 1.0 · 0.285 · 0.285 ranks below a three-person path with 0.6 · 0.285 by a margin
   > 0.05, and its reason text names the weak hop.
7. **Recommendation** between A and B makes the hop "close" on its own (0.81 when new); a 2015 recommendation decays
   to ≈ 0.18.
8. **Corrections.** A blocked pair removes the route and survives `inferTies`/`combineTies`; "they're close" lifts a
   plain connection to "close".
9. **Support-only kinds never create a route**: engagement or common contacts on a pair with no routable kind leave
   `isRoutable` false.
10. **Vocabulary.** Every `hopEvidence` phrase for every kind is in §7's list (the old pinned strings are rewritten).

Connector (`connectors-proxy.test.ts`): `/engagement` maps each page kind, returns no comment text, one upstream
call per Orbit call, jitter applied, the ledger's `limit` answer, a 422 answered as "could not check".

Engine (`hopEvidence.test.ts`): target profile first, then target pages, then top-5 mutuals, then threads; one read
per person per 30 days; a second target reuses a mutual's pages; ledger exhaustion leaves hops "not checked" and the
order unchanged; the `onUpdate` result changes hop words, not order; `db.engagement` is dropped on disconnect and the
derived ties fall back; a mutual without a member id is skipped.

E2E (Playwright, demo data + mocked connector): the route card shows band words; "Order changed · refresh" appears
and reorders on press; "People who know Arlan" reorders on the next open; the correction menu removes a route; an
intro draft contains no engagement facts; Settings shows the reads meter.

Simulation (`scripts/sim/hops.ts`): first measure sparsity on the founder's real account (fraction of mutual pairs
with any engagement, comment/reaction ratio, follower distribution); then 200 synthetic networks drawn from those
distributions **with the fan pattern built in** (a share of one-way commenters who do not know the author), with
ground-truth pair strengths. Pass: Spearman between ranked P and ground-truth path success ≥ 0.6 and ≥ 0.1 above
today's ranking on every network; no fan-only route enters the top 3 ahead of a real colleague.

Skeptical student (manual, on the founder's real account): for 10 targets with mutuals, every hop sentence on every
route traced to a stored tie; at least one route order changes for a reason the founder agrees with; no sentence the
founder would call a guess.

## 12. Sequencing

1. **Phase 1 (core + UI, no new LinkedIn reads):** kinds and `SUPPORT_ONLY_TIE_KINDS`, `blockedPairs`,
   `common_contacts`, the size scale on `same_current_company`, bands and vocabulary, the §3.7 sort, the correction
   menu, tests 1–10. Honest expectation: visible change where Orbit already holds affiliations or the student speaks;
   elsewhere the order is unchanged and now labelled.
2. **Phase 2 (reads):** the shared ledger (a prerequisite, not an add-on), profile-first with follower counts,
   `/engagement`, `db.engagement`, the queue, progressive hop words and the refresh chip, member-id verification on
   the founder's account, connector and engine tests, e2e, the sparsity measurement and the simulation.
3. **Phase 3:** recommendations and experience for route people with the route priority; account-mode job; the
   "fading" word; LinkedIn common contacts and web co-mentions if the ledger allows.
4. **Phase 4:** outcome logging, `HOP_WEIGHTS` in one place, the fit when data exists.

Merge order 1 → 2 → 3 → 4, full unit + e2e after each; connectors deploy before the app that calls the new route.


## What building it changed (2026-10-25)

- **One-way engagement is directional** (§3.3). The simulation showed the first draft's rule made rankings worse than
  today's; the directional rule makes them clearly better and never meaningfully worse. Measured on 200 seeded
  synthetic networks (5–30 mutuals each, 20% colleagues / 50% acquaintances / 30% fans, sparse evidence as assumed in
  `packages/core/src/__tests__/hop-sim.test.ts`): mean rank correlation with the true chance of an intro 0.48 vs 0.36
  for today's ranking; +0.12 where real evidence exists; no fan ahead of a colleague with real evidence whom the
  student knows better. These rates are assumptions to recalibrate from a real account once reads accumulate.
- **Ledgers per kind of read** (§6), matching Unipile's per-action guidance.
- **Mid-size employers** (51–500) give "same current company" c 0.45, below the routable bar of 0.5: being at the same
  300-person company is not on its own a reason to ask one to introduce the other.
- **Mentions** are only their own kind, not also part of E (no double count).
- **Recommendations** decay from the middle of their year, so even a new one is a little under 0.81: "close" either way.
- **Learning loop** (§8): routes are kept on each intro ask; outcomes (intro made, agreed, declined, three weeks of
  silence) are read from mail; `fitHopModel` refuses below 200 outcomes, so nothing changes a score until then.
- **Not built:** LinkedIn common contacts and web co-mentions (§4.4, both optional and budget-bound), and the
  real-account sparsity measurement (needs the founder's account and a few weeks of reads).
