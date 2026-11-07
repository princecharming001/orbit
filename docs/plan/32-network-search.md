# 32. Network search: any question about who you know, answered exactly

Status: plan, 2026-11-07. Replaces the people half of `search_people` for anything that is not a name; extends 06 §5 (network search), 16 §6 (sourcing) and 29 (friends). Sources: the Vultur study (`docs/research/vultur-study-2026-11-07.md`, 53 threads), a survey of how LinkedIn, Juicebox, Exa Websets, Parallel and Happenstance build people search (§12), and a measurement of the founder's own network (§0.2).

The student asks Orbi about their network the way they would ask a friend who knows everyone: "yc founders in my network", "ex-Google engineers now at seed-stage startups in NYC", "Berkeley people in VC I haven't talked to in a year", "who could help me with fundraising", "PMs at fintech companies". Today Orbi answers with three or four substring lookups over three fields, a list capped at 8, and an honest apology for what it cannot see. After this plan it answers with every person who matches, why each one matches (quoted from their profile), who is warm, who can introduce them, and what it could not check, in one card under one short paragraph, in a few seconds.

## 0. What exists today

### 0.1 Code the plan builds on

| Area | Where | What it gives us |
|---|---|---|
| Person record | `packages/core/src/types.ts:527` `Person` | name, `headline`, `currentTitle`, `currentOrganizationRaw`, `location`, `school`, `isAlumni`, `strength`, `tieBand`, `strengthBreakdown.lastConversationAt` and `counts`, `sources`, `linkedinMemberId`, `tags`, `notes`, `summary` |
| Roles and schools | `types.ts:597` `Affiliation`, Dexie `affiliations` | employment and education rows with partial dates; only the live profile read (`engine/enrichment/profile.ts:355-436`) writes past rows |
| Organizations | `types.ts:505` `Organization`, per user | `nameNormalized`, `domains`, `linkedinCompanyId`, `industry` and `sizeBucket` (almost never filled), `logoUrl` |
| Company names | `packages/core/src/text/normalize.ts:479` `normalizeCompany`, `ORG_ALIASES` (about 30); `supabase/functions/_shared/research/identity.ts:64` `COMPANY_ALIASES` (a second, different list) | two normalizers that disagree |
| Company kinds | `packages/core/src/drafts/sector.ts` `firmKindOf`, `sectorOf`, `seniorityOf`, `isRecruiter` | regex classes: bank, pe, trading, vc, consulting, big_tech, startup, tech, academic; four seniority levels |
| Headcount | `packages/core/src/graph/orgSize.ts` `KNOWN_SIZES` | buckets for common employers |
| Schools | `apps/web/src/data/schools.json` (11,807 rows from IPEDS and Hipo, built by `scripts/schools/build.py`) | name, domain, place, aliases ("Cal", "UCB", "UC Berkeley") |
| Search today | `apps/web/src/engine/search.ts:9` `rankPeople`, `:50` `filterPeople`; tool `chat/tools/read.ts:537` `search_people` | substring over name, company, title; default 8, max 50; summary "Check which one is meant before acting." |
| Company reach | `engine/graph.ts:838` `reachCompany`, tool `find_routes` (`read.ts:1225`) | current, former (5 years), routes; good, stays |
| Sourcing beyond the network | `chat/tools/network.ts:592` `find_people`, plan 31 | LinkedIn, Apollo, Exa, web; stays |
| LinkedIn live search | `apps/web/src/integrations/unipile.ts:439` `LinkedInSearchQuery` (`keywords`, `title`, `company`, `school`, `location`, `distance`, `cursor`); results carry `headline`, `location`, `distance`, `mutualCount` | LinkedIn filters with the full profile behind them; 100 calls a day per account (`orbit-connectors/main.ts:116`), 10 results a call |
| Friends | `supabase/migrations/20261101_orbit_friends.sql:51` `friend_shares` | per shared person: name, title, company, company domain, LinkedIn ids, school, alum, closeness 1 to 3; only through `orbit.friend_visible` |
| Lexical search library | `minisearch@7.2.0` already in `apps/web/package.json`, used by `engine/memoryLocal.ts` | BM25+, prefix, fuzzy, field boosts, MIT |
| Claude | proxy `supabase/functions/orbit-claude/proxy.ts` (call types `chat`, `memory`, `resume`, `rapport`; Haiku 5.5 allowed for non-chat), browser `integrations/anthropic.ts` `runParse`, server `_shared/claude.ts` `structured()` | structured output with zod, per-user dollar cap, daily buckets per call type |
| Chat tools and cards | `chat/types.ts` `ToolSpec`, `ResultEnvelope`; `chat/ui/cards/ResultCard.tsx`; `ui/cards/parts.tsx` `useFold`; `ui/cards/steps.ts` | 22 card kinds, no table, no server-side "load more"; the capabilities test pins the tool count at 110 |
| Bench | `chat/__tests__/sim/*`, `scripts/chat-baseline.sh`, `scripts/chat-eval.mjs` | Claude student plus judge, 8 dimensions, gate 2.5 |
| Jobs | `orbit-worker`, `_shared/queue.ts`, cron template in `20261102_orbit_voice.sql:60-86` | nightly jobs, budgets (`_shared/budget.ts`, Claude $1.50 a day per user) |

### 0.2 What the founder's network actually holds (measured 2026-11-07, production)

| Field | People with it (of 7,623) |
|---|---|
| headline | 6,489 (85%) |
| current title / company | 3,305 / 3,297 (43%) |
| headline only, no title or company | 3,199 (42%) |
| location | 5 |
| school | 0 |
| past jobs (affiliations) | 11 people |
| education rows | 0 |
| LinkedIn member id | 6,444 |
| a tie of any strength | 6,799 |
| founder words in title or headline | 1,026 |
| a "(YC W25)" style badge in the headline | 175 |

This table is the design. The headline is the only field almost everyone has, and it is rich ("Co-founder & CTO @ Knowlify (YC S25)", "CS @ Georgia Tech | Prev. @ Fleetline (YC S25, Acquired)", "UCR '28 Neuroscience"). Location, school and work history are missing for nearly everyone, so "in SF", "Berkeley alumni" and "ex-Google" cannot be answered from stored fields at all. Vultur answers them because it enriched every profile in the background. Orbit must do three things a better matcher alone cannot: read the headline properly, learn facts from LinkedIn's own search (which filters on the full profile), and say plainly what it could not check.

## 1. Why

The study showed the failure is retrieval, not the model. Orbi's prose was the more useful of the two (warmth, last talked, who can intro), but every answer was built on substring hits: "Y Combinator" 2, "YC" 20, "Y Combinator founder" nobody, "venture" capped at 15. The model then guessed which hits were real. Vultur shows the fix: compile the sentence into checkable filters plus free-text criteria, recall wide, verify each candidate with evidence. Vultur also shows what to avoid: unioned recall that lets a LexisNexis engineer score 99% for "ex-Google now at startups", 100% handed out without evidence, no memory between turns, no relationship data in search, silent dropping of constraints, never a clarifying question.

## 2. Principles

1. **Hard facts are filters, never similarities.** A named company, school, YC batch, place, title family or date window is checked by code against normalized fields. Embeddings and the judge never decide them.
2. **Three answers, not two.** Every check returns yes, no or unknown, each with the field and text it read. A must-have that is unknown keeps the person in a separate "could not check" band; it neither drops them nor counts as a match.
3. **The chat model compiles; code expands.** Orbi already reads the sentence and the conversation, so the search tool's input is the compiled query. Code turns intents into synonyms, aliases, metros and company facts the same way every time.
4. **Read once, search many times.** Normalization and extraction run once per unique raw value (a title, a headline, a company name, a place) and are stored. A query never calls a model to understand a profile it has already read.
5. **Judge only what code cannot check, only what the student looks at.** A model reads profiles only for free-text criteria and for unknowns, in batches of 10, the first page first.
6. **Evidence or it did not happen.** No row is shown as a strong match without a quote from its own profile for every must-have. A judge quote that is not a substring of the text it was given is discarded.
7. **Say what was not done.** Dropped words, relaxed filters, unknown counts and the data that was missing are part of the answer.
8. **Orbit's own facets are first-class.** Warmth, last talked, emailed, met, via which friend, tags and notes are filters like any other. This is the part no competitor can copy.

## 3. Architecture

```
student sentence
   │  (Orbi, Opus 5.5, already in the turn)
   ▼
search_network tool input = QuerySpec (§4)          router mode: rule compiler (§4.5)
   │
   ▼  expand (code, deterministic, §5)
ExpandedQuery: title families + seniority, company aliases + facts (YC, stage, size, industry),
               metros, school aliases, keyword synonyms, relationship windows
   │
   ▼  retrieve (browser, Dexie + MiniSearch, under 150 ms for 10k, §6)
PersonDoc index ── tri-state predicate check per person ── lexical recall (BM25) ── score ── bands
   │                       │ unknown must-haves on LinkedIn-checkable facets
   │                       ▼
   │              LinkedIn facet recall (distance 1, §7.3) ── facts learned and stored
   ▼
candidates (≤ 300) with reasons
   │  only if criteria or unknowns remain, first 30 rows
   ▼  judge (Haiku 5.5, batches of 10, evidence quotes, §8)
result set (stored, id) ──► people_table card (§9) + compact summary to Orbi ──► prose
   ▲
   └── follow-ups refine the same result set (§4.4)
```

Everything up to the judge runs in the browser over the student's own Dexie tables, which already hold every person (the chat loads them all today). Nothing about a query leaves the device except LinkedIn facet calls and judge batches, which carry only the profile fields needed.

## 4. The query: `QuerySpec`

### 4.1 Schema (zod in the web tool, types in `packages/core/src/search/spec.ts`)

Revision 2 (review of 2026-11-07, §18): roles and companies are one bound `positions` block, so "PMs at fintech" needs one job that is both. Booleans are explicit: OR inside an array, AND across blocks, `anyOf` for OR between blocks.

```ts
type Need = 'must' | 'nice';
type When = 'current' | 'past' | 'ever';

interface Position {
  id?: string;                  // for anyOf
  role?: {
    titles?: string[];          // as said: "PM", "growth lead", "SWE" (ambiguous tokens resolved by company kind, §5.1)
    families?: TitleFamily[];   // §5.1
    seniority?: Seniority[];    // exact levels
    seniorityAtLeast?: Seniority; // ordinal: "senior engineers" = at least senior
    founder?: boolean;          // founded the company (founding engineer is not)
  };
  company?: {
    names?: string[];           // "Google", "Stripe"; a parent includes its subsidiaries (chip), a child never widens
    kinds?: CompanyKind[];      // 'big_tech'|'startup'|'bank'|'vc_firm'|'consulting'|'pe'|'hedge_fund'|'university'|'nonprofit'|'government'|'student_org'
    yc?: { batches?: string[]; any?: boolean };
    stages?: Stage[];           // estimated stages cap a row at Likely
    sizeMin?: number; sizeMax?: number;
    industries?: string[];      // nice by default unless the student insists
  };
  when?: When;                  // default 'current'; "YC founders" = 'ever' (card says so)
  startedWithinYears?: number; endedWithinYears?: number;
  need?: Need; negate?: boolean;
}

interface QuerySpec {
  ask: string;
  scope?: 'mine' | 'mine_and_friends';
  positions?: Position[];
  anyOf?: string[][];           // [['p1','p2']]: p1 OR p2, both ANDed with the rest
  schools?: { names: string[]; fields?: string[]; degree?: ('undergrad'|'masters'|'mba'|'phd'|'high_school')[];
              gradFrom?: number; gradTo?: number; need?: Need; negate?: boolean }[];
  places?: { names: string[]; need?: Need; negate?: boolean }[];  // residence only; "from India" = living in India, card says so
  keywords?: { terms: string[]; need?: Need; negate?: boolean };
  relationship?: {
    warmthAtLeast?: 'light' | 'warm' | 'strong' | 'close';
    types?: RelationshipType[];               // peer, mentor, family_friend, professor, recruiter, ...
    everTalked?: boolean;
    talkedWithinDays?: number;
    quietForDays?: number;                    // everTalked AND last conversation older than N
    touched?: { channel: 'email'|'meeting'|'text'|'linkedin'; direction?: 'in'|'out'|'any';
                withinDays?: number; beforeDays?: number; negate?: boolean }[];
    connectedWithinDays?: number;             // LinkedIn connection date
    hasChat?: boolean; tags?: string[];
    mutualWith?: string;                      // my people this friend also knows
    throughFriend?: string;                   // this friend's people (friends scope)
    alumOfMySchool?: boolean;
  };
  like?: string;                // person id: build a spec from their doc, BM25 on their headline as nice
  exclude?: { personIds?: string[] };         // everything else uses negate
  criteria?: { text: string; need?: Need }[]; // at most 3 after lint; never what a field expresses
  unsupported?: string[];
  count?: boolean;              // "how many": fetch LinkedIn total_count too
  sort?: 'match' | 'warmth' | 'recent' | 'name';  // reorders inside bands only
  refine?: { resultSetId: string; mode: 'narrow' | 'widen' | 'replace'; onlyThese?: boolean };
  limit?: number;
}
```

`packages/core/src/search/lint.ts` normalizes every spec before it runs: drops criteria that restate a block, caps criteria at 3, maps enum synonyms ("exec" to vp and c_level, "founder" seniority to `role.founder`), demotes an unquoted keyword `must` to nice when a block already constrains the set, refuses criterion-only specs without a generator (intent templates: fundraising, recruiting, mentorship, breaking into X), and writes every change to `spec.lint[]` for the card.

Rules written into the tool description and enforced by the expander:

- **Needs.** Everything the student stated is `must` unless they softened it ("ideally", "bonus if", "preferably"). Ordering words ("closest first") go to `sort`, not to a filter.
- **Negation** goes to `exclude` ("not in AI" becomes `exclude.families` or a `must` criterion "not working in AI" when no field expresses it).
- **Time.** "ex-", "former", "used to work at", "alumni of X company" set `when: 'past'`; "now at", "currently" set `current`; "has ever worked at" sets `ever`. "Recently left" sets `withinYears: 2`.
- **Demographics, appearance, protected traits** ("indian founders", "women in VC") go to `unsupported` with no criterion. The card says "Orbit doesn't search on that, so these are all founders" in one line. This matches Vultur's choice but says so out loud.
- **Vague asks** ("cool people", "asdfgh") compile to no filters and no criteria. The tool refuses to run an empty spec and the model asks one clarifying question with up to three `offer_choices` options built from the student's goals.
- **Anything a field can express must use the field.** "Works in fintech" is `companies.industries: ['fintech']` plus `keywords: ['fintech', 'payments', ...]`, not a criterion. Criteria are for things like "raised a round in the last year", "has written about climate policy", "seems open to mentoring".

### 4.2 Why the chat model compiles (and not a separate call)

The alternative, a dedicated compile call like Vultur's `/intake`, costs one extra model round (1 to 3 s), loses the conversation (Vultur's "show me investors instead" became an unrelated search), and was visibly non-deterministic. Orbi already reads the sentence and the history; giving it a precise input schema is the cheapest compile there is. Determinism comes from the expander: the model only says `families: ['founder']` and `yc: { any: true }`, and code supplies the same 40 title patterns and the same 6,374 companies every time. A compile cache is unnecessary because there is no compile call.

The input schema is long. It is sent once per turn inside the cached tool block (`loop.ts:220-223`), so it costs cache reads (about a tenth of input), not fresh tokens. The plan budgets 1,200 tokens for the description and schema and measures it in `context-budget.test.ts`.

### 4.3 The tool family

| Tool | Kind | Purpose |
|---|---|---|
| `search_network` | read | Run a `QuerySpec` over the student's people (and friends' shares when `scope` says so). Returns a `people_table` envelope and a compact model summary (§9.3). Replaces `search_people` for every ask that is not a person's name. |
| `search_network_more` | read | Next page or more judging for a stored result set (`resultSetId`, `offset`). Called by the card's own buttons with `caller: 'ui'`, so paging needs no chat turn. Also callable by the model ("show me the rest"). |
| `explain_match` | read | Why one person is (or is not) in a result set: every predicate with its evidence, the judge's quotes. Answers "why is Varun a match", which Vultur could not. |
| `search_people` | read | Kept, narrowed to names and the People-page filters. Its description changes to "Call this first whenever the student names a person". Its company/title substring branch is removed so the model stops using it as network search. |

Tool count goes from 110 to 112 (`search_network`, `search_network_more`, `explain_match` added, nothing removed; `capabilities.test.ts` updated). New capability ids: `network_search`, `network_search_more`, `network_explain`, each with three utterances, which also feed the offline router sim.

### 4.4 Follow-ups on the same result set

Every run stores a result set in Dexie (`searchSets`, §10.1) with its id, its `QuerySpec`, the ordered person ids, the predicate results and the judge verdicts. The model summary carries the id. Follow-ups pass `refine`:

- "only the W26 batch" is `refine: narrow` plus `companies: [{ yc: { batches: ['W26'] } }]`: re-checks only the stored rows, instantly.
- "exclude the first two" is `refine: narrow` plus `exclude.personIds`.
- "what about investors instead" is a new spec (no refine) because the subject changed.
- "add people at Anthropic too" is `refine: widen`: runs the added block, unions.
- "why her" is `explain_match`.
- "show them as a list with company and batch" needs no tool: the model formats from the stored summary, or the student switches the card to list view.

The router keeps a pointer to the last result set in `threadContextFor` (`agent/routerThread.ts:60`) so "the second one", "draft to the top three" and "routes to all of them" work without a key; `peopleIn` (`:152`) learns the `people_table` kind.

### 4.5 Router mode (no Claude)

`chat/agent/searchCompile.ts`, a rule compiler for the common shapes, tried before the existing router patterns when the sentence contains "who", "people", "anyone", "my network" or a plural role word:

- role words from the title lexicon (§5.1) become `roles`;
- "at X", "from X", "ex-X", "former X" become `companies` with `when`;
- "YC", "Y Combinator", a batch token (`/\b[WSFX]\d{2}\b/`) becomes `companies.yc`;
- "in <place>" matched against the metro table becomes `places`;
- school names and aliases from `schools.json` become `schools`;
- "haven't talked to in <n> <unit>", "talked to recently", "close friends", "I've emailed" become `relationship`;
- whatever is left over becomes `keywords`.

It covers the offline sim cases; anything it cannot parse falls through to the router as today.

## 5. Expansion: from intents to checkable values

All tables live in `packages/core/src/search/` so the browser and the edge functions use the same code (edge functions already bundle `@orbit/core` through `scripts/build-functions.mjs`).

### 5.1 Titles: families and seniority (`titles.ts`)

- **Families** (22): founder, executive, engineering, data_ml, research, product, design, sales, marketing, growth, operations, finance, investing, consulting, banking, legal, people_recruiting, customer, education_academia, healthcare, student, other.
- **Seniority** (10): intern, student, entry, mid, senior, staff_lead, manager, director_head, vp, c_level, plus the flags `founder`, `partner`, `owner`. The existing four-level `seniorityOf` (`sector.ts:62`) stays for drafting and is reimplemented on top of the new one.
- **Lexicon:** about 600 patterns (whole-word regexes with abbreviations: "SWE", "SDE", "PM", "APM", "TPM", "MLE", "GP", "LP", "EIR", "VC", "IB", "S&T", "BD", "AE", "SDR", "CSM", "RA", "TA", "PhD candidate"), each mapping to families and a seniority. Built by hand for the startup and student vocabulary. The family axis is cross-checked against O*NET 31.0 `job_titles.csv` (54,269 titles mapped to 1,016 occupations, CC BY 4.0; the SOC major group gives a function for free) by `scripts/search/title-coverage.mjs`, which reads a de-identified title list and prints unmatched titles by frequency. Seniority has no open source anywhere (the survey found none), so it stays a hand-written layer. Attribution in `packages/core/src/search/NOTICE.md`.
- **The founder family is special** because it is the most asked: founder, co-founder, cofounder, founding (engineer, CEO, CTO, team), CEO or CTO at a company under 50 people or a YC company, "building X", "stealth", "started X", owner of a startup. "Founder" of a student club or a nonprofit club is caught by the "club / society / chapter / association" guard and labelled `founder` with `org_kind: 'club'`, which a startup-founder query excludes.
- **Residue:** titles no pattern matches go to the Haiku extraction job (§7.2), which returns `{families, seniority}` per unique title, stored in `title_labels`. On the founder's network the plan expects the lexicon to cover at least 85% of distinct titles and 95% of people (measured in Phase 1).

### 5.2 Companies: one normalizer and a facts table (`companies.ts`)

- **One normalizer.** `normalizeCompany` (core) absorbs the edge function `normOrg` and both alias lists (`ORG_ALIASES`, `COMPANY_ALIASES`). The edge function code imports it. Legal-suffix stripping uses `ts-cleanco@1.2.2` (MIT, a TypeScript port of cleanco's multilingual suffix table, edge-safe) before Orbit's own alias table, which still owns brand and parent pairs (Meta and Facebook, Alphabet and Google) that suffix stripping cannot solve.
- **Company facts** (§10.2, `orbit_private.company_facts`, shared by all students, no tenant data) keyed by normalized name, with domains and LinkedIn company id as second keys:
  - from **yc-oss** (`https://yc-oss.github.io/api/companies/all.json`, rebuilt daily from YC's public directory; 6,374 companies, 51 batches, fields `name`, `former_names` (3,126 companies have some), `website`, `batch`, `status` (Active 4,403, Inactive 1,108, Acquired 840, Public 23), `stage` (Early, Growth), `team_size`, `industries`, `tags` (338), `all_locations`, `one_liner`). The repo has no license file; the data is YC's public directory. Orbit uses it to label companies internally and links to the YC page, which is fair factual use; if YC objects, the source is swapped for Orbit's own nightly read of the public directory pages.
  - from **LinkedIn company lookups** already done for logos (`orbit_private.linkedin_companies`): extended to keep `industry`, `employee_count_range` and `website` when Unipile returns them (to verify in Phase 1; the logo lookup already reads the company page).
  - from **sector.ts** classes for kinds (big_tech, bank, vc, pe, consulting, trading) and `orgSize.ts` for headcount where nothing better exists.
  - from **Wikidata** later (CC0: employees P1128, inception P571, industry P452) for large and public companies, only if the bench shows company-size queries failing.
- **Batch tokens.** "W26", "Winter 2026", "S25", "F24", "X25" (spring), "IK12" normalize to one form. `yc.any` matches any batch.
- **Matching a person to a YC company, with confidence:**
  - **strong:** a YC badge in their headline names this company ("@ Weave (YC W25)"), or their email domain equals the company website domain, or their current organization's LinkedIn company id resolves to a page whose website equals the YC website.
  - **medium:** an exact normalized name match on a distinctive name (not a common English word, not a person's given name: checked against a 20,000-word list and `given-names.ts`).
  - **weak:** an exact match on a common-word name ("Weave", "Lantern", "Gale", "Aden") with nothing else. Weak matches are `unknown`, not `yes`, and go to the judge with the company's one-liner and the person's headline, which settles most of them.
  
  This is what makes "yc founders" precise rather than merely wide: the study's top 100% rows were all real, but a name-only join on 6,374 companies would label every "Lantern" employee in the network a YC founder.
- **Stage and size** come from yc-oss (`stage`, `team_size`), LinkedIn employee count ranges, `KNOWN_SIZES`, and the `founded` year where known. Stage words map to ranges: pre-seed and seed mean team size 1 to 15 or yc stage Early with a batch in the last 2 years; series A means 10 to 60; growth means yc Growth or more than 200 people. These are heuristics and say so on the card ("stage estimated from team size").

### 5.3 Places: metros (`places.ts`)

- US metros come from the Census CBSA delineation (July 2023 `list1_2023.xlsx` county to CBSA and CSA, `list2_2023.xlsx` principal cities; public domain), built into a table by `scripts/search/build-places.mjs`. On top of it a hand-written alias table of about 200 rows covers the strings LinkedIn uses ("San Francisco Bay Area", "Greater Boston", "New York City Metropolitan Area", "Greater Seattle Area"), common short forms ("SF", "bay area", "NYC", "DMV"), and about 25 international metros (London, Toronto, Bangalore, Singapore, Paris, Berlin, Tel Aviv). No open LinkedIn-region mapping exists, so this table is Orbit's own.
- City strings that no metro lists fall back to GeoNames `cities15000` plus `admin1CodesASCII` (CC BY 4.0, 34,205 cities), trimmed at build time to name, ascii name, country, admin1 and population, with country names and codes from `countries-list` (MIT). That places any city in a state or country so "in California" or "in India" still works. The trimmed file is about 1 MB gzip, loaded lazily the first time a place filter is used.
- Widening ladder for relaxation (§6.5): city, then metro, then state or region, then country.
- "Remote" is a keyword filter on headline and location, not a place.

### 5.4 Schools (`schools.ts`)

- `apps/web/src/data/schools.json` (already shipped, aliases included) is the table. A school name in a query or a profile is matched by normalized name or alias; "Cal" only counts as Berkeley when the field is a school field.
- Grad years come from education rows, from headline tokens (`'28`, `28'`, `Class of 2027`, `Purdue 30'`), and from the student's own year when "people in my year" is asked.
- `relationship.alumOfMySchool` reuses `schoolTie` (`engine/alumni.ts:21`).

### 5.5 Keywords

The model supplies its own synonyms ("climate" becomes climate, carbon, decarbonization, clean energy, solar, battery, grid, EV, sustainability). Code adds the industry tag mapping (yc-oss `industries` and `tags`, LinkedIn industry names) so "climate" also matches companies tagged Climate or Climate Tech even when the person's headline never says it. Keywords match through the lexical index (§6.3), never as a hard filter unless the student said a must-have word ("must mention Rust").

## 6. Retrieval

### 6.1 The person document (`PersonDoc`, Dexie `searchDocs`)

One derived record per person, rebuilt when the person, their affiliations, their facts, their tie score or the company facts change (a version field plus `updatedAt` comparison; a full rebuild of 10,000 takes under 2 s in a worker thread and runs on first load after an upgrade).

```ts
interface PersonDoc {
  personId: string; v: number;
  name: string;
  text: { headline: string; title: string; company: string; past: string; schools: string; tags: string; notes: string; summary: string; facts: string };
  roles: { title: string; families: TitleFamily[]; seniority: Seniority; founder: boolean; orgKey?: string; orgKind?: 'company' | 'club' | 'school';
           current: boolean; start?: string; end?: string; source: 'title' | 'headline' | 'affiliation' | 'linkedin_search' | 'extract' }[];
  companies: { key: string; raw: string; current: boolean; end?: string; source: string; yc?: { batch: string; confidence: 'strong' | 'medium' | 'weak' };
               stage?: string; size?: number; kinds: CompanyKind[]; industries: string[] }[];
  schools: { key: string; raw: string; gradYear?: number; source: string }[];
  place?: { raw: string; metro?: string; region?: string; country?: string; source: string };
  rel: { band: TieBand; strength: number; lastTalked?: string; emailed: number; met: number; texted: number; hasChat: boolean;
         friends: { friendUserId: string; name: string; closeness: 1 | 2 | 3 }[]; tags: string[]; sources: PersonSource[]; alum: boolean };
  known: { place: boolean; schools: boolean; pastJobs: boolean };   // whether the absence of a value means "no" or "unknown"
}
```

`known` is the honesty switch. If the person's full LinkedIn profile has been read (`fieldSources` says `linkedin_profile`) or a LinkedIn facet search covered them, an empty `schools` means "no school matches". Otherwise it means "unknown". The founder's network today would have `known.schools = false` for everyone; after the warm-tie profile reads and facet recall (§7) that changes person by person.

### 6.2 Predicates, three answers each

Each block of the expanded query becomes a predicate `(doc) => { verdict: 'yes' | 'no' | 'unknown'; field?: string; text?: string }`:

- role block: any role matching families, seniority, title patterns and `when`;
- company block: any company matching names/aliases, kinds, YC (by confidence), stage, size, industries, `when`, `withinYears`;
- school block, place block: with the `known` rule above;
- relationship block: always known (Orbit owns the data), so never unknown;
- exclude: a yes on any exclude is a hard no;
- keyword block (when must): yes if the lexical index hits the term in any text field, unknown otherwise (absence of a word is weak evidence).

### 6.3 Lexical recall (MiniSearch)

One MiniSearch index over `PersonDoc.text` fields with boosts (title 3, headline 3, company 2.5, past 2, schools 2, tags 2, summary 1, facts 1, notes 1), prefix on, fuzzy 0.2 for terms of five or more characters (typo tolerance like Vultur's "yc fouders bay aera"), English stop words. The index is built from `searchDocs` and kept in memory per session; it serializes to Dexie (`kv`) so a cold start loads in under 300 ms for 10,000 people. MiniSearch already ships in the bundle; Orama (facets plus vectors, 3.1.18) was considered and is not needed because facet filtering over 10,000 objects in plain code takes under 10 ms.

Embeddings are not in v1. The evidence (§12) is that they help paraphrase-heavy text and hurt on the rare tokens that matter here (company names, "YC", "W21"). The bench decides whether a later phase adds `bge-small-en-v1.5` through transformers.js for the soft keyword channel only (§13).

### 6.4 Scoring and bands

For each person: `must` predicates decide eligibility; `nice` predicates and lexical score order the rest.

- any `must` no, or any exclude yes: out.
- all `must` yes: **Match** band.
- no `must` no, at least one `must` unknown: **Could not check** band, which feeds LinkedIn facet recall (§7.3) and the judge (§8).
- `score = Σ_must w·[yes] + Σ_nice w_nice·([yes] + 0.4·[unknown]) + w_lex·bm25_norm + w_rel·prior`, where `prior` is the tie strength only when `sort` is `warmth` or the ask is about who to talk to; otherwise relationship only breaks ties. Weights start at `w=1, w_nice=0.5, w_lex=0.3, w_rel=0.1` and are tuned on the gold set (§11) as a convex combination, not reciprocal rank fusion with default constants.
- Shown as bands, not percentages: **Strong** (all must-haves yes with evidence, and every criterion met by the judge), **Likely** (all must-haves yes, a criterion unclear or not yet judged), **Could not check** (a must-have unknown), and hidden **No**. A percentage appears only in `explain_match`. This is item 13: no 100% without evidence, no wall of 49% to 50% ties.

### 6.5 Zero results and thin results

When the Match plus Likely bands are empty, or below 3 when the student asked for "people" in the plural, the engine relaxes one step at a time, in this order, stopping at the first step that yields results:

1. drop `nice` blocks (they never exclude anyway; this only matters for the count message);
2. widen places one level (city to metro to region to country);
3. widen time (`withinYears` doubled, `current` to `ever` for companies only if the student said "at", never if they said "now at");
4. widen titles from exact patterns to their family, and seniority by one level;
5. widen company stage or size by one band.

Named entities (a company, a school, a batch, a friend) are never relaxed. Each step taken is reported in the summary ("No one at seed-stage startups in NYC; 4 in the Bay Area"). If nothing is found after the ladder, the answer says so, offers the two nearest variants as choices, and offers sourcing beyond the network (`find_people`) when the student's goal fits, which plan 31 already handles.

### 6.6 Speed budget

| Step | Target |
|---|---|
| expand | under 5 ms |
| predicates over 10,000 docs | under 40 ms |
| lexical query | under 20 ms |
| score, band, reasons | under 20 ms |
| card ready (first paint) | under 150 ms after the tool call arrives |
| judge first 30 rows | under 4 s, streamed into the card as batches land |
| LinkedIn facet recall | under 3 s per call, in parallel with the judge |

The model's turn: one tool call instead of three to six substring lookups. With effort `medium` the study's 25 to 55 s answers should drop to the time of one tool round plus prose, about 8 to 12 s, most of it the model writing (item 17, measured in the bench).

## 7. Coverage: learning the facts the network does not hold yet

### 7.1 Headline parser (deterministic, Phase 1, `headline.ts`)

Splits headlines on `|`, `•`, `·`, `;`, " and ", line breaks, and reads each part with ordered patterns:

- `<role> @ <org>`, `<role> at <org>`, `<role>, <org>`, `<org> <role>` when the org is in the user's organizations;
- `(YC <batch>)`, `YC <batch>`, `(YC <batch>, Acquired)` attached to the nearest org;
- `ex-<org>`, `ex <org>`, `prev <role> @ <org>`, `formerly <org>`, `previously at <org>` as past roles;
- `<School> '28`, `<School> 28'`, `<major> @ <School>`, `<degree> student at <School>`, `Class of 2027` as schools with years, school names checked against `schools.json`;
- `Building <X>`, `Founder of <X>`, `Started <X>` as founder roles;
- `Angel investor`, `Partner at <fund>`, `Investor @ <fund>` as investing roles.

Each extracted value carries `source: 'headline'`. The founder's network has 6,489 headlines; the Phase 1 exit is at least 80% of them yielding a role, an org or a school, measured by `scripts/search/headline-coverage.mjs` over a de-identified export.

### 7.2 Extraction job for the residue (Haiku, Phase 5)

A worker job `search_extract` (account mode) reads, once, every unique title, headline and location string the deterministic layers could not label, in batches of 50, with Haiku 5.5 through `_shared/claude.ts` `structured()`, and stores the labels per unique string (not per person) in `orbit.search_labels (user_id, kind, raw_hash, label jsonb, model, created_at)`. The browser pulls them with the existing sync (`serverSync.ts` `PULL_TARGETS`). Cost for the founder's network: about 3,000 unique strings, 60 calls, under $0.10 once, then cents a week for new people. Counted as `anthropic / search_extract`.

### 7.3 LinkedIn facet recall (Phase 5): let LinkedIn filter on the full profile

This is the mechanism the founder asked for: search by LinkedIn's own filters and keywords instead of reading each prospect.

- When a query has a must-have place, school, company (current or past) or keyword block, and the Could-not-check band is large (more than 20 people, or more than half the candidates), the engine runs LinkedIn's people search with `distance: [1]` (first-degree connections only) and the facet: `location`, `school`, `company`, past company where Unipile supports it (to verify in Phase 0; Recruiter-style `role.scope: CURRENT_OR_PAST` exists, classic search exposes `company` and `school` today), plus `keywords` for title or topic words.
- Results come back 10 a page with `headline` and `location`. They join to people by `linkedinMemberId` (6,444 of the founder's 7,623 have one) or by profile slug.
- Every result becomes a **facet assertion** in Dexie `facetAssertions` and on the server (`orbit.facet_assertions`): `{personId, facet, value, source: 'linkedin_search', at}`. A place from a result fills `person.location` when empty (source `linkedin_search`, precedence 85, below a full profile read). A school or past-company assertion marks that person's `known` for that value and becomes a predicate `yes`.
- The search's total count is kept too: "LinkedIn says 212 of your connections are in the Bay Area; Orbit has read 30 of them so far" is honest and lets the card offer "Check 20 more" (each page is one call).
- **Budget:** the account's 100 search calls a day are shared with `find_people`. Network search may use at most 3 calls per query automatically and 30 a day; more only from the card's own "Check more" button. Facet assertions expire after 180 days.
- **Negative knowledge:** being absent from a facet search's results is not a no (LinkedIn caps results and ranks them). Only a completed search (fewer results than a full page, or the reported total reached) marks absentees as no for that value.

### 7.4 Warm-tie profile reads (Phase 5)

The existing live profile read (`applyLinkedInProfile`) gives location, every past role and every school. It is capped at 40 views a day (`_shared/budget.ts`). A background queue reads the student's warm, strong and close ties first (the people search answers matter most for), then people who appear in Could-not-check bands of real queries, skipping anyone read in the last 90 days. For the founder's network that is a few hundred people over one to two weeks, after which "Berkeley people I'm close to" is exact for the people who matter.

### 7.5 Friends' networks (`scope: 'mine_and_friends'`)

A new route `POST /search/friends` in `orbit-api` runs the same predicates (core code) over `friend_shares` rows visible to the student through `orbit.friend_visible`: title, company, company domain, school, alum, closeness. Rows come back with the friend's name and closeness as the path ("through Henry, who knows her well"). Names of a friend's people are already shareable under plan 29's rules; nothing new is exposed. The card shows them in a separate "Through friends" group with "Ask Henry" as the action (plan 29's intro ask).

## 8. The judge

### 8.1 When it runs

Only for rows in the first page (30, then 20 per "Check more") that have a free-text criterion, a must-have still unknown after facet recall, or a weak YC match. Purely structured asks ("who do I know at Google", "close friends at banks") never call it.

### 8.2 The call

- Browser to the proxy with a new call type `judge` (`orbit-claude/proxy.ts` `CALL_TYPES`), Haiku 5.5, no tools, no thinking, `max_tokens` 1,500, body up to 60 KB, its own daily bucket (300 a day per user) under the same dollar cap. Own-key users call Claude directly with the same request.
- Structured output through `runParse` (`integrations/anthropic.ts:436`) with a zod schema.
- Prompt layout: a frozen rubric (cache breakpoint), then the ask and criteria (second breakpoint, reused by every batch of the same query), then 10 candidates, each as a compact block of only the fields that matter: `id`, name, headline, current title and company, past roles, schools, location, company facts relevant to the ask (YC batch and one-liner for a weak match), with every third-party string wrapped as untrusted (`makeWrap`).
- Candidates are shuffled within a batch (position bias), and batches run four at a time.

```ts
const Verdict = z.object({
  id: z.string(),
  checks: z.array(z.object({
    criterion: z.number().int(),           // index into the criteria list, or -1..-n for unknown predicates
    verdict: z.enum(['yes', 'no', 'unclear']),
    quote: z.string().max(200),            // copied from the candidate block, empty when unclear
    field: z.enum(['headline', 'title', 'company', 'past', 'school', 'location', 'company_facts', 'notes']),
  })),
});
```

### 8.3 What the code does with the answer

- A quote that is not a substring of the field it names (after whitespace and case folding) turns that check into `unclear`.
- A must-have `no` drops the row; all must-haves `yes` with quotes promotes it to Strong; anything `unclear` leaves it Likely or Could not check.
- Verdicts are cached in Dexie `judgeCache` by `(personDocHash, criterionHash)`, so refining, paging back and re-asking cost nothing.
- Cost: about 10 candidates x 250 tokens plus 80 output tokens each; at Haiku 5.5 prices ($0.10 / $0.50 per million) a 30-row page is about $0.002, a heavy day of 50 searches under $0.15. Counted under the proxy's existing per-user cap.
- Two permutations for the top band only when the bench shows instability above 5% (Phase 4 measures it).

## 9. The answer: `people_table` card and the model summary

### 9.1 Card (`chat/ui/cards/PeopleTable.tsx`, new result kind `people_table`)

- **Header:** the ask in the student's words, then a row of chips, one per expanded block, each with its count when removed would change it: "Founders +12 titles", "YC company (strong or medium)", "Bay Area +9 cities", "Not talked in 1 year". Clicking a chip opens a small popover to remove it or switch must and nice; the change runs `search_network` with `refine` through `caller: 'ui'`, no chat turn. Dropped words show as a muted chip "Not searched: indian". Relaxations show as an amber chip "Widened to Bay Area".
- **Counts line:** "23 match, 41 could not be checked" with the reason ("Orbit doesn't know where most of your connections live yet").
- **Table** (desktop, container width at least `@3xl`): avatar and name; role and company with logo (`CompanyLogo`); Match band chip; one narrow column per criterion with a check, a cross or a question mark, the quote on hover and focus; Warmth (tie band chip); Last talked (`relDate`); Path (the best first hop from the reach graph or "Through Henry"); row actions on hover: Draft, Routes, Open.
- **List view** (mobile, and a toggle on desktop): the existing `PersonRow` with the band chip and one reason line ("Co-founder @ Knowlify (YC S25)").
- **Groups:** Match first, then Through friends, then Could not check (collapsed with its count and "Check 20 more", which runs facet recall and the judge on the next 20).
- **Footer:** "Show 20 more" (paging from the stored set, no model), "Export CSV" (name, title, company, band, warmth, last talked, LinkedIn URL), and the existing quiet `OpenInApp` link to a full People page view of the result set (`/people?set=<id>`).
- **Selection:** checkboxes reuse `PickBox` and `SelectionBar` (`ui/cards/parts.tsx:185-267`): "Routes to each" (10), "Write to each" (5), "Add to a goal".
- **Loading (item 10):** the card paints the moment predicates finish (under 150 ms). Rows still being judged show a shimmer in the band cell that turns into the chip when their batch lands; the counts line says "Checking 30 people". Skeleton rows only when the table is empty and still loading. No animation beyond the existing `pop-in` and `loading-in` classes.
- **Never folded:** `people_table` joins `OUTCOME_KINDS` (`ui/Thread.tsx:121`) so it is never hidden in the work log.
- **Copy rules:** no dashes, no exclamation marks, plain words, tested by the existing `DASHES` checks.

### 9.2 Next-step chips (`ui/cards/steps.ts`)

For `people_table`, at most three, chosen from: "Routes to the top 3", "Draft to <first name>", "Only the warm ones", "Look beyond my network" (when results are thin), "Ask <friend> about them" (when a friend path exists).

### 9.3 What the model sees

A compact projection (`toModel`), about 600 tokens for any result size:

```json
{ "resultSetId": "rs_…", "ask": "yc founders in my network",
  "applied": ["founder titles (current)", "YC company, strong or medium match"],
  "notSearched": [], "relaxed": [],
  "counts": { "match": 23, "likely": 6, "couldNotCheck": 9, "throughFriends": 4 },
  "unknownBecause": ["5 have a common-word company name; checking them"],
  "top": [ { "id": "p_…", "name": "Jai Bhatia", "line": "Co-founder, Turnstone (YC W26)", "band": "strong", "warmth": "warm", "lastTalked": "2026-09-14", "path": "you" }, … 10 rows ],
  "warmest": [ … up to 3 by warmth among matches ],
  "next": "Say the count, name the two or three worth contacting first and why, and mention what could not be checked. The card shows the full list." }
```

The system prompt's existing rules (three to five best fits, under 60 words, do not restate the card) keep the prose short; a new line tells the model never to say "no one in your network matches" when `couldNotCheck` is above zero, and to name what was missing instead.

## 10. Data

### 10.1 Browser (Dexie version 14)

| Table | Key and indexes | Holds |
|---|---|---|
| `searchDocs` | `personId, userId, v` | `PersonDoc` |
| `searchSets` | `id, userId, createdAt, conversationId` | spec, ordered ids, predicate results, counts, relaxations; kept 30 days or the last 200 |
| `judgeCache` | `key, userId, at` | verdicts by `(personDocHash, criterionHash)`; 30 days |
| `facetAssertions` | `id, userId, personId, [facet+value]` | LinkedIn facet facts, 180 days |
| `companyFacts` | `key, domain, linkedinId` | the slim company facts snapshot (§10.2) |
| `labels` | `[kind+rawHash]` | per-string labels from the extraction job |

### 10.2 Server (migration `20261108_orbit_network_search.sql`)

- `orbit_private.company_facts (key text primary key, name text, aliases text[], domains text[], linkedin_company_id text, yc_batch text, yc_status text, yc_stage text, team_size int, industries text[], tags text[], locations text[], one_liner text, website text, sources text[], updated_at timestamptz)`, read through `public.orbit_company_facts_snapshot()` (security definer, service role), served by `orbit-api` `GET /companies/facts` as a slim JSON (about 1.5 MB raw, about 350 KB gzip) with an ETag; the browser refreshes it weekly.
- `orbit.facet_assertions (id, user_id, person_id, facet text check (facet in ('place','school','company','past_company','keyword')), value text, source text, at timestamptz, expires_at timestamptz)` with `(user_id, person_id)` and `(user_id, facet, value)` indexes, RLS on, revoke and grant as `20261102_orbit_voice.sql:52-54`.
- `orbit.search_labels (user_id, kind text, raw_hash text, label jsonb, model text, created_at, primary key (user_id, kind, raw_hash))`.
- Nightly job `company_facts_sync` (cron `29 7 * * *`, a template copy of `enqueue_voice_distill`), handler in `orbit-worker/handlers/companyFacts.ts`: fetch yc-oss `all.json` (10.9 MB, CORS open), parse, slim, upsert in batches of 500 by key; `HEAVY_KINDS` entry and a `RESERVE_MS` of 60 s; it runs once globally, not per user (dedupe key `company_facts:<day>`).
- Local mode (no account, demo) reads a static snapshot `apps/web/public/data/company-facts.json`, written by `scripts/search/build-company-facts.mjs` from the same source and refreshed by hand with releases.
- `delete_user` already loops over `orbit` tables with `user_id`; the two new per-user tables are covered.

## 11. Measuring it: the gold set and the bench

### 11.1 Gold set (Phase 0, before any engine code)

- **60 asks** from the founder's network, written to cover: company (8: "at Google", "ex-McKinsey", "left Meta in the last 2 years"), YC and startups (8: "yc founders", "W26", "seed stage", "under 50 people"), roles (8: "PMs", "ML engineers", "recruiters at big tech", "angel investors"), schools (6), places (6), relationship (8: "haven't talked to in a year", "I've emailed", "close friends in finance"), combinations (10: "Berkeley alumni at YC companies in SF"), soft criteria (4: "could help with fundraising", "works on climate"), and traps (2: "indian founders", "cool people").
- **Labels:** for each ask, an exhaustive pass labels every plausible candidate (a wide union recall, then a Sonnet 5.5 judge with quotes, then the founder or a reviewer confirms a 20% sample and every disputed row). Stored de-identified as person ids against a frozen export of the founder's network (`docs/qa/search-gold/` is private and never committed; the runner reads it from `private/`).
- **Metrics:** must-have precision@20 (share of shown Match rows that truly meet every must-have), recall@50 against the labeled set, nDCG@10, zero-result rate, could-not-check rate, p50 and p95 latency to card, judge calls and dollars per ask.
- **Runner:** `apps/web/src/engine/search/__tests__/gold.bench.test.ts`, run with `ORBIT_SEARCH_GOLD=1`, two modes: `spec` (hand-written `QuerySpec` per ask, which tests retrieval alone, no model) and `chat` (the real model compiles, which tests compile plus retrieval).

### 11.2 Bars ("nailed")

| Metric | Today (estimated, measured in Phase 0) | Exit bar |
|---|---|---|
| must-have precision@20 | low, unmeasured | at least 0.95 |
| recall@50 on fields Orbit holds | low | at least 0.90 |
| recall@50 on place, school, past company (after §7) | near 0 | at least 0.70, with the remainder in Could not check, never claimed as no |
| "yc founders in my network" | 2 to 20 substring hits | every person with a YC badge or a strong or medium YC match and a founder role; zero non-founders, zero non-YC |
| zero-result rate on answerable asks | high | 0 |
| p50 time to card | 25 to 55 s | under 10 s end to end, under 150 ms engine |
| judge cost per ask | none | under $0.01 at p95 |
| sim bench (plan 28 groups `data`, `knowledge`, new group `search`) | 2.5 gate | every dimension at least 2.7, no scenario under 2, zero invented people |

### 11.3 Sim scenarios (new group `search`, `sim/scenarios.ts`)

Twelve multi-turn scenarios with the pattern the study used (ask, refine, explain, act): "yc founders" then "only W26" then "draft to the warmest"; "who do I know at Google" then "only engineers" then "routes to the top 3"; "people in VC in SF" then "why is X there"; "indian founders" (must say what was not searched); "cool people" (must ask one question); "Berkeley friends I haven't talked to in a year" then "draft a catch-up to two of them". Each `expectTools` includes `search_network`, and a new `shapeCheck` rule fails any answer that says "no one" while the result had Could-not-check rows.

### 11.4 Unit tests

- core: titles (founder guard, abbreviations, club founders), headline parser (50 real de-identified headlines with expected output), companies (normalizer equivalences, batch tokens, YC confidence on common-word names), places (metro membership, widening), schools (aliases, year tokens), predicates (tri-state, `known` switch), relaxation order, scoring determinism.
- web: `searchDocs` rebuild on change, MiniSearch index round trip, result-set refine, judge quote verification, card render and paging (`ui/cards/people-table.test.tsx`), router compile cases.
- functions: `company_facts_sync` against a fixture slice, `/companies/facts` ETag, `/search/friends` visibility (a non-friend sees nothing, a `companies` share mode sees only shared domains).
- e2e (`apps/web/e2e/search.spec.ts`, fake engine script): ask, card appears with chips and rows, chip removal refines without a turn, "Show 20 more" pages, CSV downloads.

## 12. What the research says, and what Orbit takes from it

- **LinkedIn** (engineering blog 2026-01-21; "Semantic Search at LinkedIn", arXiv 2602.07309): a router sends precise entity lookups to keyword retrieval and ambiguous asks to an LLM that extracts facets (title, company, school, location); attribute filters run before any similarity; the parsed query is shown to the user. Orbit takes: facets first, show the parse (chips), names go to `search_people`.
- **LinkedIn hiring agent memory** (arXiv 2604.26197): per-facet micro-matching beat whole-profile embedding on structured constraints; embeddings won only on free-form text. Orbit takes: per-predicate checks, no embeddings for hard facts.
- **Juicebox PeopleGPT:** "filters narrow the pool, criteria rank it"; Good match, Potential, Not a match with evidence per criterion. Orbit takes: the filters and criteria split and the three bands.
- **Exa Websets:** each item carries per-criterion `satisfied: yes | no | unclear` with references; the count is a target, not a promise. Orbit takes: the tri-state verdict with quotes, and never padding a short list.
- **Batched self-consistency** (arXiv 2505.12570) and the reranker surveys (arXiv 2508.16757): several candidates per call beat one at a time on accuracy and cut latency about 10x; position bias is real and a shuffle or two removes most of it; verbal 0 to 100 scores are poorly calibrated (arXiv 2508.06225). Orbit takes: batches of 10, shuffled, categorical verdicts, a number derived from them.
- **Fusion** (Bruch et al., arXiv 2210.11934): a tuned convex combination beats reciprocal rank fusion. Orbit takes: convex weights tuned on the gold set.
- **Query relaxation** (Taobao LEAPS, arXiv 2601.05513; Bloomreach): relax the least important constraint first, never silently drop identifiers. Orbit takes: the ladder in §6.5 with named entities pinned and every step reported.
- **Evaluation** (PeopleSearchBench, arXiv 2603.27476, MIT): decompose each ask into checkable criteria, grade results per criterion, use padded nDCG so short lists are penalized. Orbit takes: the gold set design in §11.

## 13. Open source used

Verified on 2026-11-07 against the registries and repositories; versions pinned at least two weeks old.

| Need | Choice | License | How |
|---|---|---|---|
| lexical index | `minisearch@7.2.0` (already a dependency, 5.7 KB) | MIT | `PersonDoc.text`, BM25+, prefix, fuzzy; facets are plain code over `PersonDoc` |
| company suffixes | `ts-cleanco@1.2.2` | MIT | inside `normalizeCompany`, before Orbit's alias table |
| YC companies | yc-oss/api `companies/all.json` (6,374 companies, rebuilt daily, CORS open) | no license file; YC public directory | nightly into `company_facts` (§5.2 caveat) |
| public companies | SEC EDGAR `company_tickers.json` (10,409 tickers) | public domain | `kinds: 'public'` flag in `company_facts` |
| schools | IPEDS + Hipo `university-domains-list` (already built into `schools.json`); ROR v2.15 education rows for extra aliases and acronyms if the bench shows misses | public domain / MIT / CC0 | aliases and domains |
| title families | O*NET 31.0 `job_titles.csv` (54,269 titles) | CC BY 4.0 | family coverage check and SOC function fallback |
| US metros | Census CBSA delineation, July 2023 | public domain | metro membership |
| cities | GeoNames `cities15000` + `admin1CodesASCII`; `countries-list@3.4.1` | CC BY 4.0; MIT | fallback for places outside the metro table |
| common words | a 20,000-word English frequency list (license checked in Phase 1) | to confirm | YC common-name guard |
| structured output | `@anthropic-ai/sdk` `messages.parse` + `zodOutputFormat` (already used) | Apache 2.0 | judge and extraction |
| batching | `p-limit@7.3.3` | MIT | four judge batches at a time |
| eval seed | `adi790uu/linkedout-oss` 20 spike queries and its routing rules for "previously at", funding stage and location | Apache 2.0 | seeds the gold set asks; its schema confirms the `PersonDoc` shape |
| metrics | `ranx` (Python) offline | MIT | cross-checks Orbit's own 40-line nDCG and recall code, tunes the convex weights |
| later, only if the bench asks | `@orama/orama@3.1.18` (BM25+, facets, hybrid vectors in 24 KB) with `@huggingface/transformers@4.3.1` and `Xenova/gte-small` q8 (34 MB, the same space as Supabase's `gte-small`) | Apache 2.0 / MIT | the soft keyword channel; Orama replaces MiniSearch only if vectors are added |
| later, company facts beyond YC | BigPicture `companies-2023-q4-sm` (17 million companies with LinkedIn handle, size, founded year, industry; frozen 2023) and Wikidata (employees P1128, inception P571, industry P452, LinkedIn company id P4264) | ODC-BY; CC0 | joined on LinkedIn handle or domain, loaded only for companies that appear in students' networks |

Considered and not used: FlexSearch and Fuse.js (no BM25 field model), lunr (unmaintained), ParadeDB `pg_search` (not on managed Supabase; checked `pg_available_extensions`), cross-encoder rerankers (`ms-marco-MiniLM-L6-v2`, `jina-reranker-v1-tiny-en`: they rank relevance and cannot verify "is a YC company"), ESCO (O*NET covers the US titles students have), dr5hn cities (ODbL share-alike), `country-state-city` (GPL 3.0), OpenCorporates (paid, ODbL), Crunchbase Open Data Map (no new keys), PDL free dataset (not an open license), jneidel/job-titles (no license), twenty's search (AGPL), open-websets (pattern only: its `{qualified, reasoning}` judge schema is the shape §8 extends with quotes). Nothing open source ships a natural-language-to-filter schema or a per-criterion judge for a private network; those two pieces are Orbit's own, built on the SDK's structured output.

## 14. Phases

Each phase lands on main behind the browser flag `networkSearch` (`engine/flags.ts`, off in the `OFF` set until Phase 6 passes), with its tests, and is benched before the next starts.

| Phase | What | Exit |
|---|---|---|
| 0. Measure | gold set (§11.1), baseline of today's `search_people` on it, Unipile facet capabilities verified (classic `company`, `school`, `location`, past company, `distance: [1]`, total counts), LinkedIn company page fields verified | baseline numbers written into §11.2; facet capabilities table in this plan |
| 1. Vocabulary | `titles.ts`, `headline.ts`, `companies.ts` (one normalizer, YC batches, confidence), `places.ts`, `schools.ts`; `company_facts` migration, sync job, `/companies/facts`, Dexie `companyFacts`; coverage scripts | title lexicon covers 95% of people's titles; headline parser yields a fact for 80% of headlines; YC match precision 1.0 on a 100-row hand check |
| 2. Engine | `PersonDoc` builder and Dexie table, predicates, MiniSearch index, scoring, bands, relaxation, reasons, result sets; all in `apps/web/src/engine/search/` with core pieces in `packages/core/src/search/` | gold set in `spec` mode: precision@20 at least 0.95 and recall@50 at least 0.90 on held fields, engine under 150 ms for 10,000 docs |
| 3. Tool | `search_network`, `search_network_more`, `explain_match`; `search_people` narrowed; system prompt routing lines; router compile; `toModel` projection; capability ids and tests | gold set in `chat` mode within 0.03 of `spec` mode; offline router sim at least 0.98 |
| 4. Judge | proxy `judge` call type and bucket, `runParse` call, batching, quote verification, `judgeCache`, bands updated | criteria asks reach precision@20 at least 0.9; p95 judge cost under $0.01 per ask; instability under 5% |
| 5. Coverage | LinkedIn facet recall and `facetAssertions` (both sides), warm-tie profile read queue, `search_extract` job and `search_labels`, `/search/friends` | place and school recall at least 0.70 on the gold set; no facet call spent on asks that did not need it |
| 6. Card | `people_table` card, chips and refine, groups, paging, CSV, selection, loading states, steps; e2e | e2e green; sim group `search` passes the bars in §11.2 |
| 7. Fixes and rollout | items 14 to 17 (§15), latency pass, flag on for the founder, then everyone | a week on the founder's account with no regression in the plan 28 groups; flag default on |

## 15. The four bugs from the study (items 14 to 17)

- **14. "Which 'W26'?" picker on a non-name.** `PeopleCard` titles itself `Which "<query>"?` whenever `search_people` returns more than one row for a query (`ResultCard.tsx:319-323`). After Phase 3, `search_people` is called for names only; in addition the picker title and the `ambiguous` flag (`read.ts:603`) are set only when the query looks like a name (`isGivenName` from `engine/given-names.ts:115` on its first word, or the query matches a person's display name prefix) and otherwise the card uses the plain summary title. Test: `search_people({query: 'W26'})` renders no picker.
- **15. "Check which one is meant before acting." on company hits.** The suffix (`read.ts:596`) is added only under the same name test; company and title matches get "N people match X." Test in `registry.test.ts`.
- **16. LinkedIn "did not connect (408/403)" banner that never leaves.** `LinkedInProgressBanner` clears itself only after `done` (`components/LinkedInProgressBanner.tsx:15-20`); a `failed` phase stays until dismissed and can be raised by a background re-read failing, not only by a sign-in. Fix: a failure during a background refresh (not a sign-in the student started) updates the Integrations status line and never raises the banner; a sign-in failure auto-hides after 20 s; the same error is not raised again for 24 h after a dismissal. The readiness session's note about a pre-existing `/relations` 403 is the likely trigger and is checked first.
- **17. 25 to 55 s answers.** Removed at the root by one `search_network` call replacing three to six serial lookups (§6.6); also the tool's `progress` label is specific ("Checking 7,623 people"), and the bench records time to card and time to last word per scenario.

## 16. Risks

- **Weak YC matches on common words** would make the flagship query wrong in a new way. Mitigated by the confidence levels and the judge (§5.2), and gated by the 100-row hand check in Phase 1.
- **LinkedIn rate limits and account safety.** Facet recall spends the account's search allowance; caps in §7.3 keep it to 3 calls per ask and 30 a day, below plan 21's ledgers. A 429 from the proxy turns into "LinkedIn search is resting until tomorrow" in the counts line, never an error card.
- **Bigger tool schema** costs cache-read tokens every turn; measured in `context-budget.test.ts` with a 1,200 token ceiling.
- **Stale company facts** (a company leaves YC's directory, renames): nightly sync, `former_names` matching, and `updated_at` shown in `explain_match`.
- **yc-oss licensing** has no license file; fallback is a direct read of YC's public directory (§5.2).
- **Model compiles badly** for an unusual ask: the chips show the compile, the student can remove a chip, the sim group catches regressions, and `chat` mode is benched against `spec` mode on every prompt change.

## 17. Not in this plan

- Searching people outside the network (stays `find_people`, plan 31). The card offers it when results are thin.
- Embedding search, rerankers and a learned ranker (only if the gold set shows a gap after Phase 6).
- Roles board, referral bounties, event groups, the onboarding checklist and other growth ideas from the study.
- A separate search page. The People page gains `?set=<id>` to show a result set, nothing more.
- Writing anything from search results without the student: drafts and intro asks still go through their existing confirmation flows.

## 18. Revision 2: what the adversarial review changed (2026-11-07)

A review traced 30 asks through the plan: 7 came out correct, 17 degraded and 6 wrong. Four causes explained nearly all the wrong ones: roles and companies were not bound, "unknown" was undefined for current fields and relationship sources, relaxation ran on unknowns, and there was no path to LinkedIn's counts. This section overrides earlier sections wherever they disagree.

**18.1 Bound positions (§4.1).** A `positions` block is yes only when one `PersonDoc.roles[]` entry satisfies both its role and its company. "Founder, Berkeley Blockchain | SWE @ Weave (YC W25)" is no for "YC founders": the founder role and the YC company are different entries.

**18.2 Knownness for every predicate (§6.1, §6.2).** `PersonDoc.known = { current, place, schools, pastJobs, email, texts, linkedinMsgs }`.
- Current is known when `currentOrganizationRaw` exists or the headline gives a role at an org.
- Email facets are known only while Gmail is connected and the touch falls inside the sync window. Texts need the Mac import. LinkedIn messages need chat history.
- Every unknown carries `signal: 'hint' | 'none'`. A hint is a lexical or headline clue. Hint rows are listed, judged and facet-checked; no-signal rows are only counted ("plus 3,100 with no current job on file").
- An unknown on a negated block caps the row at Likely.
- A keyword `must` with no hit is a no once the doc has a headline.

**18.3 Background LinkedIn census, starting in Phase 1 (§7.3a, new).** A worker job (`search_census`) runs distance-1 classic searches partitioned by location id:
- top metros and countries first, then the student's own school (all pages), then the 20 schools and companies seen most often in headlines;
- each page asserts place, school or company for 10 people and refreshes `positions` (the web `LinkedInFound` type learns `positions`);
- a partition read to its last page marks everyone absent as a known no for that value;
- it spends under a new ledger caller `search.network` with ceiling 0.4 (40 of the 100 daily searches), never touching the student's interactive budget;
- location and school ids are cached in `orbit.linkedin_search_ids`, so id lookups are paid once;
- the browser `/search` route passes `past_company` (it is already sent server-side in `_shared/sourcing/search.ts`), and Phase 0 checks whether LinkedIn honours it.

Query-time recall sends one multi-facet call per ask (every facet the ask has). Count asks always fetch `total_count`. Facet assertions of kind `keyword` are not stored.

**18.4 Relaxation only on real nos (§6.5).**
- It runs only when Match plus Likely is empty because predicates said no. When unknowns caused the empty result, run facet recall and report Could not check instead.
- Never widen a time window whose dates are unknown.
- Ladder: grad year ±1, then relationship window ×3, then seniority by one level, then the existing family and metro steps. Named entities are never relaxed.

**18.5 Refine re-runs (§4.4).** `narrow` merges the new block into the stored spec: a block of the same kind is tightened or replaced, never added independently. It then re-runs over the whole network. It intersects with stored ids only when the student points at them ("these", "them", `onlyThese`). Result sets store every Match and Likely id, uncapped.

**18.6 Company relations, not equivalences (§5.2).** The alias table keeps only same-entity names (Facebook and Meta). Brands and subsidiaries become `parent` edges: Instagram and WhatsApp under Meta, YouTube, DeepMind and Waymo under Alphabet, Slack under Salesforce, LinkedIn under Microsoft, Cash App under Block. A parent query includes children with a chip; a child query never widens to the parent. Bain stays apart from Bain Capital. Matching is on exact org keys, never substrings ("Box" is not "Dropbox"). "Partner @ Y Combinator" is YC staff, not a YC founder.

**18.7 Title lexicon (§5.1).**
- Ambiguous tokens expand to every reading and the company kind picks: PM, TA, RA, AE, IB, SE, Partner, Principal, Associate, Analyst, Director.
- A student-year guard: "Senior at Berkeley" is a student.
- "Founding engineer" is engineering plus `early_employee`, not founder.
- Org kind (student group, nonprofit, school) is classified on the organization for every role, not only founders.
- New families: policy_government, media, life_sciences, real_estate, military.
- A small multilingual core (founder, engineer, student, intern, investor in ten languages). Headlines split on `| • · ; – — / ,` and emoji.

**18.8 Judge (§8).**
- It sends criteria and only those unknowns that have hint text, never field-absent unknowns.
- A `no` needs a verified quote too, otherwise it counts as unclear.
- `max_tokens = 120 + candidates × checks × 70`, capped at 4,000; batches split to fit.
- Cache key `(docTextHash, askHash, criterionHash)`, with relationship data left out of the doc hash.
- On criteria asks the model summary waits for batch 1 (at most 4 s) or carries `pending: n`, and the prose never names a pending row as strong.

**18.9 Ordering (§6.4).**
- Within a band, order by evidence rank first: profile read or title field, then LinkedIn facet, then headline (current), then headline (past), then weak YC or estimated values.
- Next comes nice score plus BM25, then warmth. For "talk to", "help", "intro" and "reconnect" intents, warmth comes before BM25.
- `sort` reorders inside bands only.

**18.10 Gold set without circularity (§11.1).**
- Ground truth: the warm-tie profile-read queue (§7.4, 40 a day) starts in Phase 0 on a random sample of 300 connections, giving true place, school and past companies.
- Candidate pools come from four channels: BM25, the structured engine, LinkedIn facet totals and the Vultur study rows.
- Sonnet pre-sorts; the disputed rows are reviewed by hand.
- Metrics: recall over the whole relevant set plus R-precision, instead of recall@50.
- A second network (a non-founder student test account) is benched before rollout beyond Anish.

**18.11 Lean PersonDoc (§6.1, §10.1).**
- Relationship data and company facts are joined at query time from in-memory maps, so nightly rescoring does not rebuild docs.
- The MiniSearch index is rebuilt in memory on load and updated with `replace`, not persisted as one blob.
- Budget 25 MB, tested.
- Title patterns compile into one alternation per family.

**18.12 Friends (§7.5).** `friend_shares` carries no headline, so 4 in 10 of a friend's people have no job there. A plan 29 amendment adds derived columns (`role_family`, `org_key`, `yc_batch`, `grad_year`), computed on the sharer's device and never the raw headline. Until it ships, the card says how much of the friend's network has no job on file.

**18.13 Compile guardrails (§4.2).**
- Budget an honest ceiling of 2,500 tokens for the schema plus description, measured in `context-budget.test.ts`.
- `explain_match` folds into `search_network_more` as `action: 'more' | 'explain'`, so the tool count is 112 and the pinned ceiling in `capabilities.test.ts` moves deliberately.
- In router mode the rule compiler emits no criteria, and the card says "not checked (no AI right now)".

**18.14 Privacy, stated accurately (§3).** What leaves the device for a search:
- To Anthropic: the ask and spec (Opus compiles it), the top-10 summary, and judge payloads. Notes are sent only when a criterion is about notes.
- To the Orbit server: headline extraction input and facet assertions.
- To Unipile and LinkedIn: the facets of a facet call or census page.

**18.15 Phase order (§14).**
- 0: measure, ground-truth reads, census ids.
- 1: vocabulary, lint, census job.
- 2: engine and lean PersonDoc.
- 3: tools and a minimal list card.
- 4: judge.
- 5: full card.
- 6: extraction and friends.
- 7: rollout.

Company size and industry for non-YC companies come from the BigPicture free company dataset (ODC-BY, frozen 2023, keyed by LinkedIn handle), moved into Phase 1. It is loaded into `company_facts` with `source: 'bigpicture'` and labelled "estimated" when older than a year.

**18.16 Deviations from the first draft.**
- Places use GeoNames `cities15000` plus about 80 curated metros (center, radius, aliases), not Census CBSA, so places outside the US work the same way.
- Company legal suffixes are ported from ts-cleanco into `LEGAL_SUFFIXES`, not added as a dependency, because edge functions bundle core.
- Schools use a strict free-text index (`schools.ts`): a nickname two schools share goes to neither unless a curated override decides, short nicknames count only from a well-known list, and common words never count alone.

## Changelog

- 2026-11-07: revision 2 from the adversarial review (§18), schema v2 in §4.1.

| Date | What | Commit |
|---|---|---|
| 2026-11-07 | Plan written from the Vultur study, the code survey, the network measurement and the research survey | |
