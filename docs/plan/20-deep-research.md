# 20 · Deep research on a person

Status: built on `feat/deep-research` (2026-10-23), not deployed. Design: the approved v3 ("Deep research on people:
final design"), with the founder's decisions below applied on top.

## The founder's decisions, and what they removed from v3

- **Research starts only when the student presses Deep research on a person's About tab**, and Go deeper is a second
  button on the finished brief. Removed from v3:
  - the weekly batch ("research the 6 people you're writing to or meeting this week");
  - "brief me the day before a coffee chat";
  - any automatic or background research. Account mode's sourcing used to queue a dossier on its own when a
    recommended person was added (`_shared/sourcing/run.ts`); that is gone too;
  - the chat starting research. "Research Dana" now answers with where the button is and links Dana's About tab
    (`show_research`); the chat can still read a brief (`get_dossier`, and `get_person` with prep for "what should I
    know before my call with Dana").
  - The first "Write to" a stranger shows a quiet "Research them first" link to the About tab. It starts nothing.
- **Allowance:** 15 different people a month per student, apart from the chat's budget. The student sees counts
  ("Research · 12 left this month"); dollars only in Settings.
- **Model:** Opus 5.5 (`claude-opus-5-5`) writes the brief. The support check runs on Haiku 5.5, and so do the web
  searches and page fetches (they only call the tools; see "Why the gathering runs on Haiku" below).
- **Web search:** Exa when `EXA_API_KEY` is set (preferred), otherwise Claude's own server tools
  (`web_search_20260209`, `web_fetch_20260209`), which is what the live site uses today. Caps: $0.30 for the quick
  brief, $0.50 for quick plus Go deeper. Every call's cost is logged.

## What was built, by v3 section

### §1 How it runs
- New Edge Function `supabase/functions/orbit-research` (`research.ts` handler, `main.ts` entry, bundled by
  `scripts/build-functions.mjs` into `dist/index.js` like the other account-mode functions). Routes, POST from Orbit's
  origins only: `/quick` (85 s budget inside the 90 s deadline), `/deeper` (120 s), `/status` (this month's count,
  nothing researched), `/remove` (the public removal request).
- The pipeline reuses `_shared/research/`: `dossier.ts` (`writeBrief`, `finish`, `dropUncited`, `pickIdentity`),
  `guards.ts`, `prompts.ts`, `deps.ts`, with new modules beside them: `identity.ts` (scoring), `web.ts` (Exa and
  Claude web, the shared cache), `support.ts` (the support check), `brief.ts` (the quick and deeper runs).
- The browser sends the person, the LinkedIn profile the enrichment step already read (positions, schools, headline,
  location, about; no extra LinkedIn view), and a short digest of the last few messages and notes with them. The
  digest is used for "in common" and openers and is never stored on the server. Posts are sent when the browser has
  them; today's enrichment does not read other people's posts, so the list is empty.
- The brief is kept in the browser (`db.dossiers`, with a `research` block saying how it was made) for 90 days and
  shown in the About tab's existing layout (`ResearchDebrief`), now for everyone, not only account mode. Each call is
  also logged in the new Dexie table `researchRuns` (version 6), which Settings sums for the month's dollars.
- A quick brief that times out or meets a server error is tried once more by the browser; the 7-day cache makes the
  retry nearly free (the searches and pages are not paid again).
- Who can use it: a browser holding the LinkedIn account token orbit-connectors' `/connect/status` hands out for a
  connected Unipile account (an HMAC of the account id with the service role key). The allowance is counted per that
  account, server-side, in `public.orbit_research_uses`. The demo account gets sample briefs made in the browser with
  no network call (`demoBriefFor`), so the whole feature is visible and tested there. Account mode keeps the server
  queue (`DossierCard`).

### §2 Getting the right person
- `identity.ts` builds an identity card from LinkedIn: name and nicknames, current employer and the two before it,
  schools (not high school), city, LinkedIn public name, work email domain.
- Company alias table (Meta = Facebook, AWS = Amazon, Block = Square, J.P. Morgan = JPMorgan Chase, Alphabet, and
  about 60 more). Whole-word matching; employers that are everyday words (Meta, Block, Ramp, Notion, Amazon, Apple…)
  match only as written, so "metadata", "a block of time" and "a wheelchair ramp" never count.
- A page is strong only with the name plus a second signal (an employer, a school, a link to their LinkedIn profile,
  their work domain); the city, and a site whose address is their name, count only beside another (the live check
  found five namesakes' sites for "David Kim", none his). A title giving them an employer they never had is
  a conflict. LinkedIn and the sites that copy it (ZoomInfo, RocketReach, ContactOut…) are never strong. Only strong
  pages are read and cited. Account mode's dossier now uses the same scoring.
- No LinkedIn and no company: nothing is spent or counted; the card asks for one ("needs_anchor").
- The "more than one person matches" picker stays: with only a company to go on and pages naming two or more other
  employers, the student picks; the pick goes back as the anchor.

### §3 What it looks at
- Quick: the history digest, the LinkedIn profile, three searches (about them, news in the last 18 months,
  talks/podcasts/writing, or papers for advice and research goals), up to 10 pages read and the best 8 kept.
- Go deeper: more about them only when the quick brief found a strong page beyond LinkedIn, otherwise their company's
  news and hiring (no wrong-person risk). GitHub only when the profile links one. The quick round is read back from
  the cache, then the deeper round adds up to 8 pages; company pages feed "At their company" and "Be careful" only.
- Exa first when configured; Exa down or missing, Claude's web search and fetch.

### §4 Writing the brief
- Opus 5.5 writes from the page text (structured output). The prompt now spells out the never-write list, the honest
  default, cited "careful" items about the company only, a "company" section, and openers as statements of at most
  25 words.
- **The support check:** after writing, Haiku 5.5 reads every claim beside the pages it cites. Unsupported claims are
  removed; partly supported ones stay, marked "(partly supported)", and never become an opener, a draft line or a
  fact. If the check cannot run, nothing from that brief becomes a fact or a draft line.
- **The paid-answer fix:** when the source-id retry would cost more than the brief has left, or the retry fails,
  `writeBrief` keeps the first, already-paid answer with only its uncited lines removed (it used to discard it).
- **Grammar size fix:** the brief's schema went over the structured-output grammar limit (400 "The compiled grammar
  is too large", true of the old v1.1 schema too). The brief task now sends `string | null` fields as plain strings
  (`flatNullable` in `_shared/claude.ts`) and turns blanks back into nulls.
- Honest default: with nothing beyond LinkedIn the brief says "Not much is public about Dana beyond LinkedIn." and
  keeps to LinkedIn; with no time or money left to write, the brief is assembled from the profile alone.
- Refresh is offered only when the enrichment step's regular LinkedIn re-check (every 45 days) has seen a new job, or
  the headline or company changed since the brief.

### §5 Privacy rules
- Only public web search results and the public text of those pages are cached across students
  (`public.orbit_research_cache`, 7 days, keyed by the query or the address). Briefs, LinkedIn data and history never
  are.
- Blocked sources (`guards.ts`): people-search and background-check sites, property, political donations, court
  records, crowdfunding, obituaries, personal social accounts. They go to Exa as `excludeDomains` and to Claude's tools
  as `blocked_domains`, and are filtered again in code.
- Never written (`guards.ts`, applied after writing as well as asked in the prompt): home finer than a city, salary
  and pay, personality or "communication style", health, family, religion, sexuality, politics and donations, legal
  matters, immigration, a lost job or leave. "Careful" is company context only.
- Never researched: anyone marked do-not-contact (checked in the browser and refused by the server), anyone on the
  removal list. The public page `/remove-me` (linked from the landing page's footer) takes a name with a LinkedIn
  address, an email or a company and stores only hashes in `public.orbit_research_suppressions`.
- Under every brief: "Public professional sources only, every line cited, kept 90 days." Deleting a brief deletes the
  facts it wrote; a brief past its 90 days goes with its facts when the app opens; merging two people drops the merged
  one's brief and its facts. (Local mode has no "delete person" yet; `deletePersonResearch` is there for it.)

### §6 Where the student sees it
- About tab: the Deep research card (with the month's count), the brief, Go deeper, Delete brief, the footer.
- Drafts: a first message with no human link (no referral, meeting, shared school or employer) opens with the brief's
  top fully supported opener as its "one thing only true of them" line, with a chip "from research [n]" linking its
  source; Swap moves to the next opener, then to the student's own line. Facts a brief wrote never go through the
  template's own fact picking.
- Prep tab: "From research" shows what they did lately and the openers, or a link to the About tab.
- Facts: role detail, openers (hooks), recent items (background) and what they share with the student (connection),
  from fully supported claims only, shown as "from research".
- Settings: "Deep research" row with the month's people researched and dollars.
- Chat: `show_research` (never starts research), `get_dossier` (works in local mode now), `research_left`, and
  `get_person` prep with the brief. Router phrases: "research Dana", "how many research briefs do I have left", "what
  should I know before my call with Dana". Capabilities 206 → 208, tools 91 → 92.

### §7 Budget
- 15 different people a month per LinkedIn account (`ORBIT_RESEARCH_PER_MONTH`), counted only when a brief is written
  ("which one?" and "add their company" give the person back); asking again about the same person that month, a retry
  or Go deeper, is not counted again.
- Per brief: $0.30 quick, $0.50 for both (Go deeper gets $0.50 minus what the quick brief cost, from the cost log).
  Every paid step is estimated first and skipped if it would cross the cap; the brief is then marked partial with a
  note saying what was skipped.
- Abuse: a global daily dollar cap across all students (`ORBIT_RESEARCH_USD_PER_DAY`, $40), 40 calls a day per
  account, and per-visitor minute and day counters (`orbit_proxy_take`, keys prefixed `research:`), never a per-IP
  dollar cap (a campus shares one IP).
- Cost log: `public.orbit_research_runs`, one row per call with its cost, each step's cost, tokens and time, what was
  skipped and why, and any error. Account and person are hashed; no names, briefs or history.

### §8 How we know it's good
- Identity: a labelled set of 50 people sharing 15 common names (`apps/web/src/server/__tests__/identitySet.ts`):
  precision 99.5% of strong pages (the one miss is a namesake at the same employer, which one page cannot settle),
  all right pages found. The set is built from templates with the traps real searches turn up, so it checks the rules,
  not search quality; the live check below is the real-world sample.
- Live check (`supabase/tests/functions/research-live.test.ts`, run by hand): see the results below.

## Live check (2026-10-23, Claude web search, no Exa key)
The real pipeline (`runBrief`) run locally against the Claude API on four public professionals (Lenny Rachitsky,
Julia Evans, Charity Majors, Shreyas Doshi) and two low-footprint names (an "Emily Johnson, PM at Ramp" and a "David
Kim, engineer at Plaid" with made-up LinkedIn profiles). Total spend for the whole check, probes and reruns included:
about $3.95.

| | Cost | Time |
|---|---|---|
| Quick brief, public person (6 runs) | $0.175–0.185 | 34–50 s |
| Quick brief, low-footprint name (4 runs) | $0.052–0.093 | 19–31 s |
| Go deeper (Julia Evans) | $0.225 (quick + deeper $0.41) | 48 s |

- Where a quick brief's money goes: three searches $0.03 plus $0.005 of Haiku tokens, ten pages read $0.004, Opus 5.5
  writing $0.13–0.145, the support check $0.003.
- Identity: all 32 web sources read for the four public people were about them (checked by hand), and the 5 Go deeper
  added for Julia Evans too. The low-footprint names found two real faults, both fixed and tested: a site named after
  the name (davidkim.tech, emilyjohnsonstl.com) counted as a match on its own, and a namesake's portfolio that
  "integrated Plaid" or used "the Plaid API" counted as working at Plaid. After the fixes the honest brief comes
  back: "Not much is public about Emily beyond LinkedIn."
- Claims: graded by Opus 5.5 against the cited page text, 82 of 84 claims kept in 10 briefs were supported, 2 partly
  (97.6%).
- The support check first ran Haiku at low effort, which marked fair paraphrases "partial" and so removed nearly every
  opener. Replaying the same check on the same 16 claims: Haiku low effort agreed with Opus on 8, Haiku high effort
  on 14 ($0.003, 8 s), Sonnet 5.5 low effort on 13 ($0.044). It now runs Haiku at high effort, and the briefs keep
  three openers each.

## Why the gathering runs on Haiku
Claude's web search returns about 10,000 tokens of results per search, and every step of a server-side tool loop
re-reads everything before it: one Sonnet call that searched and fetched in turns cost $0.29 for the web alone, the
whole brief's cap. Splitting it into two calls that do everything at once (all searches in one step, then the pages
identity scoring picked, all fetched in one step) on Haiku 5.5 costs about $0.04 with the same tools
(`web_search_20260209`, `web_fetch_20260209`, which Haiku 5.5 accepts). The gatherer only calls the tools and writes
nothing; Opus 5.5 reads the fetched text and writes the brief. `ORBIT_RESEARCH_GATHER_MODEL` switches it.

## The investigator loop (2026-10-27)

Deep research used to run three searches, all tied to the person's current employer, read about ten pages and have the
writing model read them raw: $0.12 a brief, and it missed the niche record (a student's DECA officer role and club pages
were never searched for, and high schools were dropped from the identity card). With `PARALLEL_API_KEY` or
`SERPER_API_KEY` set, a brief now runs the loop in `_shared/research/investigate.ts`:

1. **Wide:** 12 to 16 searches from every anchor (each employer, each school including high school, the city) and the
   kinds of pages niche facts live on (awards, officer roles, teams, hackathons, talks, their accounts via `site:`).
   Plain queries go to Parallel in fast mode, five per request ($1 per 1,000 requests; the $5 monthly credit covers
   5,000); queries with operators go to Serper, which is Google (about $1 per 1,000). Either does everything when the
   other is missing, and Serper takes over when Parallel fails or runs out of credit.
2. **Read:** pages are fetched straight from their sites (`pageText.ts`), for nothing; a page built in the browser keeps
   the search excerpt that named them.
3. **Extract and judge:** Haiku reads each page against who they are (roles, schools and their years, city) and says
   whether it is them (yes, likely, no), the facts it states about them (each with a short exact quote), and leads worth
   searching next. A page that only matches the name can be "likely" when everything fits; the writer may use it only
   as likely. Sensitive categories are dropped; facts from someone's under-18 years are only achievements an
   organization published (an award, an officer role, a team, a result), nothing personal.
4. **Follow-ups:** the leads become new searches with their name (one round for the quick brief, up to three on Go
   deeper), until nothing new turns up or time or money runs out.
5. **Accounts:** usernames they published on their own pages, and a distinctive LinkedIn address (ten letters or more,
   no digits), are checked on 15 work and hobby sites using Maigret's detection rules (`handles.ts`, MIT); each account
   found is read and judged like any page. Never payment, dating or adult sites.
6. **Write:** the brief is written on Sonnet from the extracted facts (`research_brief` in `claude.ts`), then the
   support check runs as before.

Searches, pages and readings share the 7-day cache, so Go deeper pays only for new rounds. A quick brief costs about
$0.03 to $0.08 (searches about $0.01, reading free, extraction about $0.01, writing about $0.02 to $0.05). Without either
key, research searches as before (Exa or Claude's web search), now also written on Sonnet.

## To go live
1. Apply the migration `supabase/migrations/20261023_orbit_research.sql` (four service-role-only tables with RLS on,
   and the functions `orbit_research_use`, `orbit_research_refund`, `orbit_research_status`,
   `orbit_research_last_quick`, `orbit_research_cleanup`).
2. Deploy the function `orbit-research` (from `supabase/functions/orbit-research`, whose `index.ts` imports the
   committed bundle) with `supabase functions deploy orbit-research --no-verify-jwt`; it checks the origin and the
   LinkedIn account token itself. It reads `ORBIT_ANTHROPIC_API_KEY` from its function secrets or, like orbit-claude, from
   `orbit_private.secrets` (already there), and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (set by Supabase).
3. Optional: set `EXA_API_KEY` (function secret or `orbit_private.secrets`) to search with Exa instead of Claude's web
   search. Optional knobs: `ORBIT_RESEARCH_PER_MONTH` (15), `ORBIT_RESEARCH_USD_PER_DAY` (40),
   `ORBIT_RESEARCH_ACCOUNT_PER_DAY` (40), `ORBIT_RESEARCH_GATHER_MODEL` (claude-haiku-5-5).
4. The site finds the function next to orbit-connectors (`VITE_ORBIT_LINKEDIN_PROXY` with orbit-connectors swapped
   for orbit-research), so the build needs no new variable; `VITE_ORBIT_RESEARCH_PROXY` overrides it.
5. orbit-api and orbit-worker were rebuilt (shared research code changed); redeploy them with account mode.
