# 06. Graph, relationship strength and Reach

Status: build specification. Defines the network graph (nodes, edges, weights), how relationship strength is computed, how person-to-person edges are inferred, how paths to a target are found and explained, and the orbit layout the map renders. Implemented in `packages/core/src/graph` and `packages/core/src/scoring`; rendered by `apps/web/src/components/map`.

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
| `email_cc` (either on CC or a thread with > 4 participants) | 0.1 |
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
strength  = 1 − exp(−raw / 2)                            // saturates: 2 fresh meetings ≈ 0.63, 5 ≈ 0.92
strength  = clamp(0.15·recency + 0.85·strength, 0, 1)    // a single old touch cannot exceed ~0.15 after a year
```
Stored on `people.strength` with the breakdown `{raw, recency, counts by kind, last_interaction_at, half_life_days}`. Recomputed: on touchpoint insert (SQL function for that person) and nightly for everyone (`orbit/strength.recompute` in batches of 500) because decay changes values without events. Tiers: strong ≥ 0.6, medium 0.3–0.6, weak < 0.3. [DEFAULT constants]

Why this form: additive evidence with exponential forgetting is the standard contact-strength model (as in Gmail's own ranking and CRM "warmth" scores); the saturating transform keeps the scale interpretable and the recency term preserves "we talked yesterday" over "we exchanged 40 emails two years ago".

---

## 4. Person↔person edge inference

Computed by `orbit/graph.recompute` (nightly, and after enrichment or CSV import) in `packages/core/src/graph/edges.ts`. Each rule emits `(type, weight, evidence)`; multiple edge types between the same pair are kept as separate rows and combined at path time (section 5).

| Type | Rule | Weight |
|---|---|---|
| `co_tenure` | both have employment affiliations at the same organization with overlapping dates (unknown dates: `is_current` for both counts as overlap) | `min(1, 0.25 + 0.05·overlap_months) · size_factor` where `size_factor` = 1.0 for orgs ≤ 200 people, 0.7 for 201–5,000, 0.4 for > 5,000, 0.5 when size unknown |
| `same_current_company` | both currently at the same org (subset of co_tenure; emitted when dates unknown) | 0.35 · size_factor |
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

Graph: nodes = user, people, target. Edge cost = `−ln(w)` (user→person `w = strength`, person→person `w = w_ab`, person→target per 5.2). Run Yen's k-shortest simple paths (k = 5, max 3 hops) from the user to the target; path strength = product of edge weights = `exp(−cost)`. Dedupe paths sharing the same first hop unless the second hop differs materially; return the top 3. Also return the **direct** option when the target is already a network person (strength shown) and, for cold targets, the alumni option.

Company targets: compute for each person currently at the org: direct strength; for former employees (affiliation at org ended within 5 years): strength × 0.6 with label "former"; then run 5.3 against each current employee as a target and return the best 3 two-hop routes. Panel order: direct current → direct former → alumni there (enrichment) → two-hop.

### 5.4 Explanations (code, template per edge type)

- `strength`: "You've had {n} {emails|meetings} with {A}; last one {relative date}."
- `co_tenure`: "{A} worked with {B} at {Org} ({years})."
- `same_school_cohort`: "{A} and {B} were both at {School} around {years}."
- `email_cothread`: "{A} and {B} were on the same email thread with you ({date})."
- `meeting_coattendee`: "{A} and {B} were in a meeting with you ({date})."
- `introduced_by`: "{A} introduced {B} to you."

Path score bands shown to the user: strong (≥ 0.4), possible (0.15–0.4), long shot (< 0.15).

### 5.5 Ask for intro

Creates `suggestions (kind intro_request, person_id = first hop, payload.target = {name, title, org, why})` and a draft (T8 kind `intro_request`) that includes a forwardable blurb. Cadence and cooldown rules apply to the first hop.

---

## 6. Orbit layout (default map)

Computed in `packages/core/src/graph/layout.ts`, deterministic for a given input (no physics on the default view):

1. Partition people into rings by strength tier (inner, middle, outer); radii 160 / 300 / 440 px (scaled to viewport; minimum viewport width 360 px uses 0.55×).
2. Within the whole set, group by `current_organization_id` (null → "Independent"); order groups by total strength desc; assign each group a contiguous arc on every ring proportional to its member count + 1 (so small groups still get space), the same angular range on all rings so a company reads as a wedge.
3. Within a group on a ring, place members evenly in the arc, jittered deterministically by `hash(person_id)` by ±6° and ±12 px radius to avoid grid feel.
4. Company labels: on the outer ring's circumference at the arc centre, for groups with ≥ 2 members or any target company; logo 20 px + name.
5. Node size: 32 px (weak), 40 px (medium), 48 px (strong); pipeline ring 2 px coloured by stage; pending-suggestion pulse.
6. Over 1,500 people: the outer ring shows one cluster node per company ("+14") that expands into the ring on click.
7. Rotation: inner ring +1 rev/6 min, middle −1 rev/8 min, outer +1 rev/10 min; applied as a rotation transform at render time so hit-testing uses the rotated positions; paused on hover/drag/`prefers-reduced-motion`.

Reach view uses `d3-force` on the subgraph (path nodes + their first-degree neighbours, ≤ 60 nodes), with the user pinned left and the target pinned right; everything outside the subgraph is faded to 15 percent opacity in place.

Rendering: `react-force-graph-2d` with custom `nodeCanvasObject` (avatar images cached in an `Image` map; initials fallback), `linkCanvasObject` for curved path lines, `onNodeHover` tooltip (name only, as in the reference), `onNodeClick` → profile drawer. Canvas DPI-aware; 60 fps budget at 1,500 nodes verified in `11` section 4.

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
