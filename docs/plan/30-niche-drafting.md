# 30. Niche drafting: one playbook per kind of outreach

Status: built, 2026-11-03. Builds on 16 (§7 compose), 24 (own words), 28 (the bench). Replaces the per-goal registers of 16 §7.3 (`GOAL_REGISTER` on the server, `DRAFT_RULES` in core) with niche playbooks; `ASK_RULES` (what to ask each kind of firm) stays and is now read through the playbook.

## 1. Why another layer

Before this plan a draft knew the goal kind (recruiting, advice, collaboration...) and the kind of firm, and nothing else. A live bench of nine realistic students (§4) showed what that misses: **3 of 27 drafts passed**.

- A startup note never named the open role and asked for "15 minutes about your path", because the recruiting register won.
- A professor was greeted "Hi Rachel" (the student's voice card won), was never offered a CV or the student's hours, and the subject did not say undergraduate.
- Every follow-up was "just bumping this in case it got buried". Three of them were the template, garbled ("Have you tried your method on research assistant?").
- Replies offered 30 minute slots to someone who asked for 15, turned down the times offered, and never said phone or video.
- The goal kinds inference gave research students were inconsistent (collaboration, recruiting, advice), so the same student got different registers on different days.

The playbooks were not grounded in how these niches actually work, and the drafts read the same across niches, so the extra layer was worth building.

## 2. Design

One module, `packages/core/src/drafts/niche.ts`, read by both draft paths (the server's `composeDraft` and the browser's `llmDraft`).

- `nicheFor({goalKind, goalText, recipient, targetFunctions, degree})` decides which of 14 niches a message is in. These are IB, consulting and finance coffee chats; tech recruiting; a startup role open now; an undergraduate asking for a lab position; a research collaboration; fundraising; sales; hiring; advice; co-founder; community; and general. It is pure and deterministic, so the server and the browser always agree.
- `NICHE_PLAYBOOKS[niche]` holds the norms for each step: first message, follow-up, reply, thank-you. They are written in Orbit's own words from cited public guidance, and every entry lists its sources.
- `NICHE_FORM[niche]` sets the message's shape:
  - the default ask;
  - the highest reading grade (10 for a professor email, 7 for a coffee chat);
  - a fixed greeting that wins over the voice card ("Dear Professor Kim");
  - the call length.
- `draftPlaybook(...)` is the single entry point. It returns the niche, its form and the numbered rule lines (13 onward). On a first message in a coffee-chat niche it adds the firm's ask rule (`ASK_RULES`). It also adds the greeting, the call length, and the goal's own brief.
- The validator follows the niche. `wordRange(kind, goal, niche)` uses the niche's first-message range; a niche follow-up gets 20 to 75 words, which leaves room to point back to the first note. The reading-grade bar is the niche's.
- Niches Orbit did not pre-build are handled through the goal. `set_goal` takes `norms`, written by the chat model only for fields with no playbook (law, medicine, journalism...), and stored as `goals.criteria.playbook`. Every draft for that goal carries it ("For this goal in particular: ...").
- Context the drafts did not see before:
  - the goal the chat belongs to (the browser used to guess it from the cycle label);
  - chat memories about the student and about this recipient;
  - the links on the resume (GitHub, a portfolio), which a reply may now include.
- The template fallback knows the niche: a professor gets "Dear Professor Kim" and a lab ask, a startup gets the role ask, and a follow-up points back to the first note.
- Why the model's drafts were refused (the validator's issue codes and details) is written to `audit_log.details` on every compose. The bench reads it.

Models: compose and reply stay on `claude-opus-5-5`, where draft quality matters. Goal inference stays on `claude-haiku-5-5`. The niche norms for an unbuilt niche come from the chat model (Opus) when it saves the goal, so no extra call is made.

## 3. Sources

| Niche | Sources (checked 2026-11-03) |
|---|---|
| IB, consulting, finance coffee chats | mergersandinquisitions.com networking guide; Wall Street Oasis cold-email thread; Michigan banking email guide; PrepLounge cold email |
| Startup role open now | 1752 VC "how to cold email a startup founder for a job"; Next Play substack; Colin Keeley on cold email for startup roles |
| Undergraduate lab position | MIT UROP email templates; UT Austin CNS "how to reach out to professors"; UNC OUR emails to faculty; Princeton PCUR on cold emails |

## 4. The bench

`supabase/tests/functions/draft-bench-live.test.ts`, with personas in `draft-bench-personas.ts`. It runs the real `composeDraft` against the real model on a pglite database with a real goal inference, then has an independent judge (Sonnet, with niche norms written separately from Orbit's prompt) score each draft 1 to 3 on five dimensions: specificity, norms, ask, length and tone. A draft passes when every dimension is at least 2 and the mean is at least 2.5.

Nine students, three per scenario, each with a first message, a follow-up and a reply:

| Scenario | Students |
|---|---|
| Coffee chats | UT Austin junior to an IB alum; Georgetown sophomore to a McKinsey alum; Rutgers senior moving from audit to restructuring |
| Labs | UC Davis sophomore to a sleep-lab professor; Georgia Tech junior to an NLP professor; Ohio State first-year to a PhD student |
| Startups hiring now | Northeastern senior SWE to a CTO; NYU junior growth to a founder; CMU MS ML to a CEO |

Run: `ORBIT_DRAFT_BENCH=1 ANTHROPIC_API_KEY=… DRAFT_BENCH_OUT=<dir> pnpm --filter @orbit/supabase-tests exec vitest run functions/draft-bench-live.test.ts`

Results are in §6.

## 5. Not built yet

- Server sourcing and Discover ranking do not read the resume, own words, memories or dismissals beyond wrong-role and wrong-company (the plan 30 context map). That is the next step.
- The feedback kinds `snooze`, `warmup_skip`, `fact_delete`, `stage_correct` and `intro_reject` are written but not read back.
- People search still uses about six substring matchers. MiniSearch, already a dependency, is the planned replacement.

## 6. Results

Live bench, 9 students × first message, follow-up and reply (27 drafts), judged by Sonnet:

| Round | What changed | Passed |
|---|---|---|
| Baseline | goal registers only | 3/27 |
| 2 | niche playbooks, forms, greeting rule | 7/27 |
| 3 | follow-up and reply rules; why a draft was refused goes to the audit log | 6/27 |
| 4 | the validator stops refusing good drafts: "Dear Professor Kim" names the person, a "Re:" subject on a follow-up is dropped, a reading grade up to one over the bar is a warning, contractions and common acronyms ("It'll", "API") are not unknown details; replies see the free hours of each day for two weeks, so they take a time the person named or offer exact times next week | 16/27 |

By scenario in round 4: coffee chats 9/9; labs 4/9; startups hiring now 3/9. The startup misses are the same kind (the first message hides the student's proof of work, and the follow-up adds nothing new), which is the next pass. A reply's times, when the model takes them from the free hours rather than the three offered slots, are saved as offered, so a "Tuesday at 2 works" still books the call.
