# 06. Graph, relationship strength and Reach

Status: build specification. Defines the network graph (nodes, edges, weights), how relationship strength is computed, how person-to-person edges are inferred, how paths to a target are found and explained, and the orbit layout the map renders. Implemented in `packages/core/src/graph` and `packages/core/src/scoring`; rendered by `apps/web/src/components/OrbitMap.tsx` (a plain canvas renderer in the static v1; Reach highlights the route in place on the orbit, and the force-directed subgraph below is not built yet).

---

## 1. Graph model

Per user, an ego graph:

- **Centre**: the user.
- **Person nodes**: `people` rows with `is_human` and not hidden.
- **Organization nodes** (optional layer): `organizations` referenced by people's current affiliations.
- **User→person edges**: implicit; weight = `people.strength`.
- **Person↔person edges**: `edges` rows (section 4), weight 0..1.
- **Person→organization edges**: implicit from `affiliations` (current and past, with dates).
- **External target node** (Reach only): a person not in the network, materialised from an enrichment result as a `candidate` with affiliations.

Graph size: typically 300–2,000 person nodes, 1–5k edges. Loaded in one query set and held in memory per request (`buildGraph(scope)` ≤ 150 ms for 2k nodes, measured in tests).

---

## 2. Touchpoint weights

| Kind | Base weight `w` |
|---|---|
| `meeting` (calendar event with ≤ 3 attendees, or a matched note) | 1.0 |
| `email_out` (student wrote to the person directly, To) | 0.6 |
| `email_in` (person wrote to the student directly) | 0.7 |
| `email_cc` (on CC; at most one per thread per person; none at all on threads with more than 8 people, which are mailing lists or group mail) | 0.1 |
| `linkedin_in` | 0.6 |
| `linkedin_out` | 0.5 |
| `linkedin_connected` | 0.2 |
| `note` (manual note about the person) | 0.3 |
| `manual_log` (user logged a call/coffee) | 1.0 |
| `intro_observed` (a third party introduced them in a thread) | 0.8 |

[DEFAULT weights]

---

## 3. Relationship strength (user ↔ person)

```
raw(t)    = Σ_i  w_i · exp(−ln2 · (t − t_i) / H)        over touchpoints i with t_i ≤ t, H = 90 days
recency   = exp(−ln2 · days_since_last / 45)
strength  = 1 − exp(−raw / 1.6)                          // saturates: 2 fresh meetings ≈ 0.71, 5 ≈ 0.96
strength  = clamp(0.15·recency + 0.85·strength, 0, 1)    // a single old touch cannot exceed ~0.15 after a year
```
A touchpoint dated up to 24 hours ahead (clock skew, a meeting later today) is treated as happening now; anything further ahead is ignored until it happens. The constants are tuned to the canonical cases (tested in `strength-graph.test.ts`): two meetings anywhere in the last month is strong (0.63 for meetings 30 and 31 days ago), one coffee chat yesterday is medium (0.54), two meetings two months ago are medium, and one meeting 200 days ago is weak.
Reciprocity (implemented in `computeStrength`): touchpoints split into two-way evidence (`meeting`, `email_in`, `linkedin_in`, `manual_log`, `intro_observed`), one-way evidence (`email_out`, `linkedin_out`, `linkedin_engaged`, `note`) and ambient evidence (`email_cc`, `linkedin_connected`).

- Until the person has ever replied, met the student or been introduced, one-way evidence adds at most 0.35 decayed raw, the recency term is halved (0.075) and strength is capped at 0.29, so unanswered outreach plus bumps stays a weak tie however many emails were sent.
- `email_cc` adds at most 0.3 decayed raw in total, ever: CC can nudge a real tie, never create one.
- Recency is measured from the last real touch; a CC yesterday does not count as "we talked yesterday".
- `interactionCount` for explanations excludes `email_cc` and `linkedin_connected` (`interactionCount(counts)`).

Stored on `people.strength` with the breakdown `{raw, recency, counts by kind, last_interaction_at, half_life_days}`. Recomputed: on touchpoint insert (SQL function for that person) and nightly for everyone (`orbit/strength.recompute` in batches of 500) because decay changes values without events. Tiers: strong ≥ 0.6, medium 0.3–0.6, weak < 0.3. [DEFAULT constants]

Why this form: additive evidence with exponential forgetting is the standard contact-strength model (as in Gmail's own ranking and CRM "warmth" scores); the saturating transform keeps the scale interpretable and the recency term preserves "we talked yesterday" over "we exchanged 40 emails two years ago".

---

## 4. Person↔person edge inference

Computed by `orbit/graph.recompute` (nightly, and after enrichment or CSV import) in `packages/core/src/graph/edges.ts`. Each rule emits `(type, weight, evidence)`; multiple edge types between the same pair are kept as separate rows and combined at path time (section 5).

Affiliations are grouped by the organization's normalized name (else `normalizeCompany(nameRaw)`), so "Stripe", "Stripe, Inc." and an org-linked Stripe share one group. Groups of up to 150 people get every pair; larger groups (a big employer, the student's own university) are never dropped: every member is paired with the group's 20 strongest ties to the student (its likely connectors), which keeps every useful route while the edge count grows linearly.

`size_factor` uses the organization's `sizeBucket`; when that is missing, a built-in table of large employers students target (`graph/orgSize.ts`), then the number of people at that company in the student's network (30 or more: 0.4, 12 or more: 0.6), else 0.5.

| Type | Rule | Weight |
|---|---|---|
| `co_tenure` | both have employment affiliations at the same organization with overlapping dates (a stint's span is known only with a start date and, unless current, an end date; when both people are current and either span is unknown the pair gets `same_current_company` instead, never a "since" year; past stints with an unknown span that are not provably disjoint get a weak edge of `0.15 · size_factor`) | `min(1, 0.25 + 0.05·overlap_months) · size_factor` where `size_factor` = 1.0 for orgs ≤ 200 people, 0.7 for 201–5,000, 0.4 for > 5,000, 0.5 when size unknown |
| `same_current_company` | both currently at the same org (subset of co_tenure; emitted when either start date is unknown) | 0.35 · size_factor |
| `same_school_cohort` | same school with education dates overlapping, or graduation years within 2 | 0.3 (overlap) / 0.15 (within 2 years) |
| `email_cothread` | both appear as non-user participants on the same email thread | 0.5 + 0.1·(threads − 1), cap 0.8 |
| `meeting_coattendee` | both attended the same calendar event (≤ 8 attendees) | 0.6 + 0.1·(events − 1), cap 0.9 |
| `introduced_by` | T4 `mentioned_people` or a thread where A adds B (B's first message is a reply in a thread A started with the user) | 0.9 |
| `linkedin_mutual` | Unipile relations of a relation (only when `linkedin_messaging` is on and the API exposes it) [GAP] | 0.4 |

Edges from enrichment require the enrichment payload's affiliations, so coverage grows as people are enriched (`04` section 3.3 budget order).

Combined pairwise weight: `w_ab = 1 − Π_types (1 − w_type)` (noisy-OR).

---

## 5. Reach: paths to a target

### 5.1 Target resolution

Input is one of: a person in the network; a free-text query ("Daniel Kim at Stripe", "someone on Figma's growth team"); a LinkedIn URL. Steps:

1. Network search (trigram on name, filter by org) → if a unique person matches, target = that person.
2. Otherwise enrichment: URL → `enrichByLinkedInUrl`; name + company → `searchPeople` (top 5, the UI asks the user to pick). The chosen `EnrichedPerson` becomes the external target with affiliations (not persisted as a person until the user starts outreach).
3. For a company target (no person): the target is the organization node.

### 5.2 Edges to an external target

The target's affiliations are compared with every person's affiliations in the network using the rules in section 4 (co_tenure, same_school_cohort, same_current_company), plus `is_alumni` of the user's school as a user→target direct hint ("you share a school") with weight 0.2.

### 5.3 Path search

Implementation: a hop-bounded Dijkstra over `(node, hops)` states with a binary heap (`O(H·(V+E)·log(H·V))` for hop limit H), so a node first reached through a cheap long chain is still explored over fewer hops and a valid short route is never lost; Yen's algorithm runs on top of it. For many targets at once (recommendations, company reach) `bestPathsFrom(g, 'user', 3)` computes the best route to every node in one search. User→person weight is `max(strength, 0.12 if connected on LinkedIn)`.

Graph: nodes = user, people, target. Edge cost = `−ln(w)` (user→person `w = strength`, person→person `w = w_ab`, person→target per 5.2). Run Yen's k-shortest simple paths (k = 5, max 3 hops) from the user to the target; path strength = product of edge weights = `exp(−cost)`. Dedupe paths sharing the same first hop unless the second hop differs materially; return the top 3. Also return the **direct** option whenever the student has a tie to the target (`reachPersonIn`): first when the tie is warm (closeness 30 and up), so someone the student knows is never reached through others; last, after the warmer routes, when the tie is faint (a LinkedIn connection, an email that went unanswered) and those routes outrank it. The Reach panel then says why, under the routes ("You're connected with Felix on LinkedIn (since Mar 2026). That tie is faint, so a note from you alone may go unanswered. A word from someone who knows Felix carries more weight, which is why the routes through people you know come first. Writing to Felix yourself is Route 4."), marks that route "Cold tie", and picking it offers "Write to Felix directly". A person on the map with no tie to the student and no route still reads "No route found through your network yet". For cold targets, the alumni option.

Company targets: the query is matched on normalized names (exact, then prefix, then word prefix, then substring, ties to the company with more people in the network; the Reach box shows a picker when several match). Compute for each person currently at the org: direct strength (ties broken by alumni first, then the newest LinkedIn connection; alumni carry a badge rather than a second list); for former employees (affiliation at org ended within 5 years): strength × 0.6, scaled down linearly to × 0.3 at five years (× 0.4 when the end date is unknown), with label "former"; then, for each current employee who is not yet a warm tie, take the best route through people the student knows (two or three hops, the same route Reach shows first for that person; a unit test checks they agree) and return the best 3. Panel order, on the map's Reach panel and on the company page: direct current (alumni marked with an "Alum" badge) → direct former → "Routes through people you know", each with its number of hops and the people in between ("Nina Mehta 3 hops, via Lena then Isabel"), so the panel and Reach never disagree on how far away someone is. Because those people are also listed as there now, the section says why it suggests a route to them: "You know these people only slightly, so a word from someone who knows them is likelier to get a reply than a note from you alone."

### 5.4 Explanations (code, template per edge type)

Generated in `graph/explain.ts` (`describeUserTie`, `describePairHop`), one text per direction so every hop names its own two people in order:

- `strength`: "You've had 3 emails and a meeting with {A}; the last one was 2 weeks ago" ("the last one" is the latest email, meeting, logged chat or LinkedIn message, never a CC or the LinkedIn connection). No reply yet: "You've emailed {A} twice and haven't heard back yet." LinkedIn only: "You're connected with {A} on LinkedIn (since Jan 2026)."
- `same_current_company`: "{A} and {B} both work at {Org} now."
- `co_tenure`: "{A} and {B} both worked at {Org} from 2021 to 2023" / "in 2023"; both still there: "{A} and {B} have worked together at {Org} since 2022"; unknown dates: "{B} used to work at {Org}, where {A} works now" or "{A} and {B} both used to work at {Org}".
- `same_school_cohort`: "{A} and {B} were both at {School} around {year}."
- `email_cothread`: "{A} and {B} were on 3 email threads with you (last in Mar 2026)."
- `meeting_coattendee`: "{A} and {B} were in a meeting with you."
- `introduced_by`: "{A} introduced {B} to you."

When a pair has several edge types, one supporting reason is appended: "..., and they both went to Cornell."

Path score bands shown to the user: strong (≥ 0.4), possible (0.15–0.4), long shot (< 0.15).

### 5.5 Ask for intro

Creates `suggestions (kind intro_request, person_id = first hop, payload.target = {name, title, org, why})` and a draft (T8 kind `intro_request`) that includes a forwardable blurb. Cadence and cooldown rules apply to the first hop.

---

## 6. Orbit layout (default map)

Computed in `packages/core/src/graph/layout.ts`, deterministic for a given input (no physics on the default view):

1. Partition people into rings by strength tier (inner, middle, outer); radii 160 / 300 / 440 px at unit scale. The layout is computed once per network; the map scales it to fit the canvas so the dots plus company labels never clip (labels are clamped inside the canvas horizontally, and the top and bottom labels keep at least 14 px from the edge).
2. Within the whole set, group by the organization's normalized name, else `normalizeCompany(current_organization_raw)` (none → "Independent"); order groups by total strength desc the first time; assign each group one contiguous arc shared by every ring, so a company reads as a wedge, and every dot's centre lies inside its company's arc. A group's arc is as wide as its dots need on its most crowded ring: on each track, a dot keeps one dot-width of angle from the previous dot on that track (whatever its company), and at least a quarter of that step lies inside its own arc. Dots go on the track where they fit earliest, so neighbouring small companies stagger across tracks instead of each taking a full step. Spare angle is shared out in proportion to need. Companies with no dot left (every member merged into "Other companies") get no arc.
   Stability: the map passes the wedges the student last saw (`previous`, kept for the whole visit). Companies then keep their order (a new company slots in after the company it follows by strength), and the wedge boundaries are placed as close as possible, in least squares, to where they were, each wedge keeping at least the width its dots need (isotonic regression on the boundaries with the minimum widths taken out); each dot keeps its packed offset from its wedge's start. So one tie growing closer moves that person, not the companies: on the demo, Daniel Okafor becoming a close tie used to swap Stripe with another wedge and move 72 of 89 other dots by more than 40 px (mean 72 px); now 1 dot moves more than 40 px (mean 7 px). A unit test checks, at 90, 300 and 2,000 people, that wedges move less than a fresh layout would and by under 6° on average.
3. Within a group on a ring, members are spread evenly in the arc as far as the spacing allows, strongest first, then jittered deterministically by `hash(person_id)` by up to ±6° (never past half the free space to a neighbour or out of the arc) and, on a ring that uses a single track, ±6 px radius, to avoid a grid feel.
4. Company labels: on the outer ring's circumference at the arc centre, for groups with ≥ 2 members or any target company; logo 20 px + name.
5. Node size: 32 px (weak), 40 px (medium), 48 px (strong); pipeline ring 2 px coloured by stage; pending-suggestion pulse on the people behind the six highest-priority pending suggestions (when everyone pulses, no one stands out).
6. Packing: each ring may use concentric tracks within its own radial band (bands never overlap). Every ring starts on its main track with everyone shown. When the arcs do not fit around the circle, the ring whose dots set the width of the most arcs gets room in this order: another track, then smaller dots (the inner ring takes the two smaller dot sizes first and only then a second track, so close ties stay one clean ring and one more close tie does not send half of them to a cramped inner track) (85 then 75 percent; strong ties down to 55 percent), then fewer dots, weak and medium rings before the strong one and only in the arcs that ring makes widest: such a company keeps its strongest members on that ring as dots and its overflow collapses into one grey "+N" dot standing for at least three people (a click focuses that company: the dot bursts open on the map and the panel lists everyone there); a company already down to one dot there moves into a single "Other companies" dot, smallest first. No two dots overlap and no dot leaves its company's arc at any network size (tested at 90, 150, 300, 1,000 and 2,000 people). In practice nothing is aggregated up to about 300 people; at 2,000 the map shows roughly 350 to 500 dots. Strong ties stay individual dots up to 2,000 people with a realistic mix of strengths (tested with up to about 100 strong ties). Past about 100 strong ties the strong ring has to aggregate too, a company at a time, so with a few hundred strong ties most of them sit inside "+N" dots. That is far beyond what a student's network holds, so it is a known limit rather than a target.
7. Rotation: all rings turn together, one revolution per 12 minutes (`ORBIT_PERIOD_MS`), so the company wedges stay aligned; applied at render time so hit-testing uses the rotated positions. The drift eases to a stop under a hovered dot (420 ms) and picks up again when the pointer leaves (900 ms), never an abrupt pause; it holds still while a company, a route or an Introductions match is turned to the top, on touch screens and with `prefers-reduced-motion`. A drag turns the orbit by hand and a flick keeps it turning for a moment: only the release speed above about 70 degrees a second carries on, so a slow, steady drag stops where the hand let go. The loop draws at full frame rate during a transition, at 30 frames a second for the suggestion ripples, at 15 for the drift alone (a few pixels a second), waiting on a timer between those slower draws rather than waking every display frame, and sleeps when nothing moves (section 6.1).
8. Labels: biggest companies first, shown only where the label's arc is free (judged on angles so the set does not flicker while rotating).
9. Touch: the first tap on a dot shows its name, a second tap opens it; every dot gets a 44 px hit area (the nearest dot wins where they overlap).

Reach is drawn on the orbit itself: the target turns to the top, the route draws out from "You" hop by hop, everyone off the route fades back in place, and the camera zooms and pans just enough to keep the whole route in view (section 6.1, animation 3).

Rendering: one `<canvas>` driven by `OrbitScene` (`apps/web/src/components/orbitScene.ts`); `OrbitMap.tsx` only hands it the layout, data and targets. Dots are cached sprites (photo or initials, stage ring) rebuilt only when the size they are heading for changes, within 4 ms of building per frame; dots that are fully transparent are skipped; the canvas is DPI-aware. Hover, tap and keyboard hit-testing use the animated positions, so a click lands on the dot where it is drawn.

### 6.1 Motion

Every change on the map is animated on the canvas itself, never behind a loading screen, and each animation answers a question the student has: where is this company, how do I reach this person, who did this person bring me, what changed.

Mechanics: `apps/web/src/components/motion.ts` holds the easing curves, a `Tween` that retargets from its current value, a closed-form damped `Spring`, angle helpers (the shortest turn, the rotation that brings an angle to twelve o'clock) and the frame-time recorder; `orbitGeometry.ts` holds the pure geometry (wedge centre, fan slots, curved links, camera framing, label slots). Dots animate in polar units (angle before rotation, radius), so they travel round the orbit rather than across it. Any change retargets from where things are, so one animation can interrupt another without a jump; the e2e suite steps a paused clock a frame at a time through interrupted focuses to check it. A layout change (someone new, a tie that grows stronger) moves every dot from its old slot to its new one; when a few people change rings, they lead: they glide first and land in a short spotlight (larger, with a halo and a ripple), and everyone else makes room 160 ms later, so the eye follows the person who changed. When the page moves or resizes the canvas (a panel above it grows), the orbit first stays where the eye has it, then glides to its new centre. Steps last 150 to 700 ms and nothing blocks input.

| # | When | What moves |
|---|---|---|
| 1 | First map visit of a session (a `sessionStorage` flag) | The rings sweep in from the centre (520 ms each, 80 ms apart), then every dot spirals out of "You" to its slot (700 ms, slight overshoot), inner rings first, in a wave that runs down both sides from twelve o'clock and meets at six (so there is no seam where it began); company labels fade in last; all done in about 1.3 s. The map waits for the day's maintenance (every tie's strength recomputed when the app opens) for at most 2.5 s before it lays out, so people do not change rings straight after they land. "You" swells once from the size it had while loading, and its loading halo fades out rather than stopping. The sprites of the people about to arrive are built with whatever is left of each loading frame's drawing budget, so the frames where they fly in only draw them. Any pointer press fast-forwards everything still on its way to its place in 140 ms (no hard cut), and a click on a dot that was still flying in opens that dot. |
| 2 | A company: a search, a row in the Target companies list, a "+N" dot | The turn starts the moment the student asks, from the layout the map already has; who they know there (the panel's lists) is looked up in the background, and Esc or a newer search drops a lookup that finishes late. The orbit turns the shortest way until the company's wedge sits at the top (spring, about 700 ms, slight overshoot; a turn of more than 60 degrees takes 2.2 ms longer a degree, at most 950 ms, so the outer ring stays easy to follow). A translucent wedge fades in behind its people and opens with them, never ahead of them; with the Target companies filter on, the other target companies' tint steps back so the focused wedge stands alone. The other companies close up a little round the rest of the orbit to make the room (their labels with them), so the opened wedge never pushes its dots onto a neighbour's. Its people pop one after another (to 1.35 times, 1.12 times on rings packed in tracks, and never further than their neighbours leave room, with the overshoot only where there is room for it) with a glow, all within 350 ms however many there are, while everyone else fades to 15 percent. A "+N" dot for that company bursts open and its members fan out along the outer edge of the wedge, at most a little wider than the opened wedge (whoever does not fit stays in the "+N" dot); the labels of neighbouring wedges under the fan fade out while it is open. A chip above the wedge reads "7 at Stripe · 2 warm", counting the same people as the line under the filters, and any company label under it steps aside; the panel lists six of them with a "Show all" button for the rest. Clearing plays it backwards and turns the orbit back; searching the same company again while its fan folds back turns the fanned dots round where they are. |
| 3 | Reach | While the routes are worked out, a radar sweep turns round "You" and the target pulses; the sweep shows for at least 480 ms, so a route found at once still reads as a search first. Then the target turns to the top, the camera frames the route, and the route draws hop by hop (350 ms a hop), each dot on it popping as the line reaches it and growing, pop included, only as far as its neighbours leave room; a small arrowhead halfway along each hop says which way it goes, and a soft comet runs along it every 2.5 s. Hops bow gently to one side; a hop whose straight line would pass near "You" swings round it instead, and a hop that heads back the way the last one came bows apart from it like a lens (the way out away from where the way back ends), so a route never reads as a line from You and two legs never fold into one. People on the route who sit side by side on the orbit step apart along their ring while the route shows (450 ms, each taking half the step, at most about 30 degrees), until any two of them have room for the hop's line, its arrowhead and both names between them (26 px past their popped size); clearing the route puts them back. Everyone on the route is named under their dot (a first name, with the last initial when two people on the map share it), each name appearing as the line reaches them, so the panel's words match the dots. Picking another route morphs: the hops both routes share stay drawn, the rest of the old line pulls back toward You (260 ms) while the new one draws out at once, a little faster (220 ms a hop), so the map never shows no route and a three-hop route is finished in about 0.7 s. With no route, the sweep fades and the target shakes gently. Clearing turns back more slowly for a long turn (spring period 700 ms plus 3 ms a degree, at most 1,150 ms), so the outer ring glides while the camera zooms out. |
| 4 | Someone new in the network | Their dot is born at whoever introduced them (else at the "+N" dot that held them, else at "You"), travels a curved path to its slot (800 ms) and lands with a ripple and a spotlight (larger, as far as its neighbours leave room, with a halo) that lasts until the introduction's link fades, 3 s later. The line under the filters says it for six seconds ("Jamie Lindgren joined your orbit, introduced by Tomas Costa."), and the map names them under their dot while the spotlight lasts, as it does anyone whose tie moved them to another ring (up to four at a time; a bigger import is said in the line only). With no introducer on record yet, the dot waits 180 ms at "You": the record often lands just after the person, and then they still set out from their introducer. Several newcomers arrive up to 120 ms apart; a large import comes in faster. |
| 5 | A chat changes stage | The stage ring crossfades to the new colour (450 ms); booking a chat and completing one add a single burst in the stage colour (a bold ring and a thinner one just behind it) while the dot lifts above its neighbours for about 1.6 s; the line under the filters says it for six seconds ("Your chat with Maya Chen is booked.") and the map names the person under their dot while they are lifted. |
| 6 | The Introductions view | Section 6.2. |
| 7 | Hover, or arrow-key focus | The dot lifts to 1.25 times (120 ms), thin lines to its strongest ties inside the network (up to 12) grow out of it, and a thin accent ring marks each person a line reaches as it arrives (so it reads who they run to, not just where), and the name card fades and slides in near the dot (the side away from the centre first), where it hides the fewest people: each dot under it or just peeping out from under its edge counts, the people right round the person up to six times as much as someone across the map, the people the lines run to and the lines on top of that, and, for arrow-key focus, the dots the arrow keys go to next, which it never covers. It may sit a little further from the dot (rarely more than about 150 px) to clear them; never over the person it is about, and not "You"; the map does not also write the name above the dot. On a map narrower than 640 px the card spans the top or the bottom and the name stays above the dot. The drift eases to a stop. Leaving reverses it. |
| 8 | Filters (Everyone, Target companies, Alumni, In pipeline, Last 90 days) | Alpha and scale tween over 250 ms, starting at twelve o'clock and sweeping clockwise round the orbit. |
| 9 | Pending suggestions | One soft ripple every 2.4 s, on the same beat, on the people behind the three highest-priority pending suggestions, drawn at 30 frames a second; the loop sleeps between ripples. |
| 10 | Loading | An empty orbit whose rings breathe and whose "You" pulses; when the people arrive, animation 1 plays (or a short fade when it already played this session). The arrival carries on from those rings: they stay while the pen draws round them and step back once all three are drawn, so the orbit never blinks out between loading and arrival. |

Words and keys: a line under the filters says what the map shows whenever it changes ("Showing 7 people at Stripe, 2 warm. Drag to turn the orbit, Esc to clear."). Esc steps back out with the reverse animation: an Introductions match first, then the route or company, then the filter. Tab focuses the canvas; the arrow keys move to the nearest dot in that direction among the people the view shows (a dot a filter, a focus or the Introductions view has faded back is skipped), which pops and shows its card as on hover; Enter opens the person (or the company, on a "+N" dot); Esc lets go of the dot before anything else. A polite live region reads out the focused person, and the line under the filters is one too. A search that finds no one says so in that line ("No one matches “Zzyzx” in your network yet.") and in a toast, and the search box shakes once, so the student sees the search was heard; the route or company the last search showed goes with the reverse animation, so the map and the panel never answer an older question. the next search, typing in the search box again (on a phone the toast sits over it), or any change of view, takes that toast down. A search with several matches ("Ines") lights every match on the map (people, and everyone at a matching company) while the rest fade back, and the line reads "Several matches, lit on the map. Pick the one you meant." With a filter on, the subtitle counts what it shows ("60 of 90 people shown"). In the Introductions view, a chain lit from the map is said in a sentence under the list unless a list entry already says exactly that, in which case that entry is marked instead.

Reduced motion (`prefers-reduced-motion`): no arrival, no drift, no travel (the Introductions tree and an opening wedge are set in place), no sweep and no bursts; every change is an instant set or a fade of at most 140 ms, and the map reports itself settled as soon as that fade ends. While routes are worked out the target gets a still ring instead of the radar sweep, and the orbit turns the target to the top only with the answer, in the same set as the camera framing the route (never two snaps a moment apart); Introductions links and routes are drawn whole at once. Touch screens: no drift, since a moving dot is hard to tap; every control on the page (the filter chips, the search box, the panel's buttons and links, the card's Open link) is at least 44 px tall; the first tap names a person and the second opens them; on a phone the person's card prefers the top of the map, spans its width, never covers the tapped person, and takes the bottom only when it is clear of the tab bar; a tapped person is let go when the view changes (a search, a route, a filter, Introductions). With a mouse the card lets the pointer through to the dots under it.

The canvas has `role="application"` (with `aria-roledescription="orbit map"`) so screen readers pass the arrow keys through to it.

Test hooks: the canvas carries `data-animating` (true while anything is in transition, set the moment one starts; the drift and the ripples do not count), `data-phase` (the named animation), `data-focus`, `data-chip` and `data-path`. Under automation (`navigator.webdriver`) or with `?perf=1`, `window.__orbitMap` returns a snapshot (recent phases, rotation, camera, emphasised and dimmed people, fanned dots, Introductions links drawn and lit, the names written under dots, the people the ripple marks, frames drawn) and every dot's position; `?perf=1` also records each animation frame's `requestAnimationFrame` delta and drawing time on `window.__orbitPerf`.

### 6.2 Introductions view

`buildIntroWeb` (`packages/core/src/graph/introWeb.ts`) builds the web of who introduced the student to whom from what is recorded, never guessed: `introduced_by` edges, threads recorded as introductions, chat referrers, and the people someone suggested the student talk to (connection facts from the prep tab). One link per pair; each person hangs from their earliest introducer; a link that would close a loop is left out. Each person gets a generation (1 for someone the student already knew who introduced others) and a lineage (the chain's first introducer). The demo has three chains, two of them three generations deep: Elena introduced the student to Tomas, who introduced them to Aisha.

The Introductions chip turns the orbit into a tree: each chain sits round the middle of where its people already are (so nobody crosses the orbit to reach it), its first introducer on the inner ring, each generation one ring further out beneath whoever introduced them, chains pushed apart where they would overlap; the camera moves in to frame the tree and the orbit holds still. Someone faded back whose dot would sit under a person in the tree steps out of sight, so no spot reads as a double dot. The line under the filters says what the rings mean now ("Each ring out from You is one more introduction."). Everyone in the web is named under their dot (in a web of more than 16 people, only the lit chain), and a name that would cover another is moved above its dot or left out; while a chain is lit, the other names fade back. Members move out generation by generation (110 ms apart), then the links draw outward one generation at a time (250 ms apart, 450 ms each), pointing from introducer to introduced, one colour per lineage; everyone outside the web fades back and the company labels dim. Hovering a chain in the panel, or anyone in it on the map, lights the whole chain with a light travelling along it (a 1.7 s trip, then a 0.9 s rest during which the loop sleeps; the link gradients are kept while the dots hold still); for a chain lit from the map, a sentence under the list says it in words, or, when a list entry already says exactly that ("Elena introduced you to Tomas, who introduced you to Aisha."), that entry is marked instead of being repeated. The search box searches the web: a match turns to the top, as a company does, and the line under the filters says what it shows ("Showing the introductions through Tomas Costa."). A dashed line runs from You to each chain's first person; the panel says "A dashed line from You means you know that person directly." With nothing recorded the view says "No introductions recorded yet."

### 6.3 Frame times

`apps/web/e2e/map-perf.spec.ts` runs each animation in headless Chromium (software rendering, 1280 × 800, the real clock) on the demo grown to 300 people and to 2,000 people with the e2e suite's synthetic network, from the trigger until the map settles. Only animation frames count: the drift is drawn at a lower rate on purpose and is not a dropped frame. The first frame after the loop wakes for a change counts from the moment of the change, so work the page does in between (React applying a search) shows up as a long frame. The spec runs in its own Playwright project after every other test, so nothing else loads the machine while it measures. The bar is p95 ≤ 24 ms at 300 people and ≤ 40 ms at 2,000, with p95 drawing time ≤ 8 ms per frame; an animation over the bar is run again, up to three times, and its best run counts, since a slow map is slow every time and a busy machine is not. Measured on 7 October 2026 in the full e2e run (perf project, after the other 61 tests), every animation met the bar on its first run:

| Animation | 300 people (300 dots): p50 / p95 / max frame, dropped | 2,000 people (444 dots): p50 / p95 / max frame, dropped | Drawing p95 / max (300; 2,000) |
|---|---|---|---|
| Arrival (with loading) | 16.7 / 16.8 / 33.5 ms, 1.2% | 16.7 / 16.8 / 33.4 ms, 2.3% | 5.1 / 6.5 ms; 4.8 / 9.1 ms |
| Company focus | 16.7 / 16.8 / 33.3 ms, 1.5% | 16.7 / 16.7 / 33.3 ms, 1.6% | 2.0 / 7.4 ms; 2.8 / 5.2 ms |
| Company cleared | 16.7 / 16.7 / 16.8 ms, 0.0% | 16.7 / 16.7 / 16.8 ms, 0.0% | 1.6 / 2.3 ms; 2.3 / 3.5 ms |
| Reach route | 16.7 / 16.8 / 16.8 ms, 0.0% | 16.7 / 16.8 / 33.3 ms, 0.8% | 4.1 / 5.6 ms; 4.8 / 6.5 ms |
| Reach cleared | 16.7 / 16.7 / 16.8 ms, 0.0% | 16.7 / 16.7 / 16.8 ms, 0.0% | 1.0 / 1.4 ms; 1.9 / 3.8 ms |
| Introductions view | 16.7 / 16.8 / 16.8 ms, 0.0% | 16.7 / 16.7 / 16.8 ms, 0.0% | 1.1 / 2.0 ms; 1.6 / 3.8 ms |
| Introductions closed | 16.7 / 16.8 / 16.8 ms, 0.0% | 16.7 / 16.7 / 50.0 ms, 3.4% | 1.0 / 2.1 ms; 1.6 / 1.8 ms |
| Hover over 12 people | 16.7 / 16.7 / 16.8 ms, 0.0% | 16.7 / 16.7 / 16.8 ms, 0.0% | 1.3 / 1.9 ms; 1.6 / 3.3 ms |

Route members stepping apart, the spotlight names and the card's look at the hovered person's ties cost nothing measurable: run back to back against the build before them on the same machine, the perf project's drawing p95 stayed within the run-to-run spread (reach 4.3 to 4.9 ms before and 4.5 to 5.5 ms after at 300 people, 4.6 to 5.2 ms and 4.6 to 6.5 ms at 2,000).

The 2,000-person arrival no longer has a long first frame (its drawing time peaked at 45.6 ms before): the layout is worked out once the whole network has loaded rather than as each part arrives, and the arriving people's sprites are built during the loading frames. Earlier measurements on this branch: a company search at 2,000 people turns the map 90 to 100 ms after Enter (it used to wait 2 to 9 s for the lookup, with nothing moving), and the panel's lists follow about 100 ms later; the widest step any dot takes in one frame while a route is cleared fell from about 99 px to 44 px; the idle map draws about 18 frames a second on the demo (15 for the drift, more while the pending-suggestion ripples play), down from about 26 to 29.

---

## 7. Queries the map needs

```sql
-- people for the map (one query)
select id, display_name, photo_url, strength, current_organization_id, current_title, is_alumni, relationship_type,
       (select stage from coffee_chats c where c.person_id = p.id and c.stage not in ('declined','no_response','archived') limit 1) as stage,
       exists(select 1 from suggestions s where s.person_id = p.id and s.status = 'pending') as has_pending
from people p where user_id = $1 and is_human and hidden_at is null;
-- organizations for labels
select o.id, o.name, o.logo_url, count(*) from people p join organizations o on o.id = p.current_organization_id where p.user_id = $1 group by o.id;
-- edges (reach / connections panel)
select person_a_id, person_b_id, type, weight, evidence from edges where user_id = $1;
```
Cached per user for 60 s in the server (`unstable_cache` keyed by user and `graph_version` = max(updated_at) of people/edges).

---

## 8. Alumni and school signals

`people.is_alumni` = `school_id = users.school_id` (from the CSV `Company`/`Position` columns we rarely get a school; it comes from enrichment, email domain `.edu` matching the user's school domain, or the user's own tagging). Alumni are a first-class filter on the map and a strong prior in recommendations (05 section 8).

---

## 9. Pooled campus graph (not in v1; design only)

When flag `pooled_graph` is on for a campus: a global `pooled_identities` table maps hashed LinkedIn slugs to the set of opted-in users who have that person in their network (no strengths, no content). Reach can then show "2 students in your club can reach someone at Figma" and lets the user request an intro through the app (the other student sees a request card; no identities are revealed until both accept). Requires: opt-in per user, campus allowlist, a `pooled_intro_requests` table, and a privacy review. Everything else in this document is unaffected.
