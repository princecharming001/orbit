# Draft simulation report, 2026-10-30

Suite: `packages/core/src/__tests__/sim-drafts/` (new files only). Run it with:

```
cd packages/core && npx vitest run src/__tests__/sim-drafts
# full per-draft JSON and the summary as files:
SIM_OUT=/some/dir npx vitest run src/__tests__/sim-drafts
```

## What was run

- **44 personas**, generated deterministically (`personas.ts`):
  - Schools: elite (Stanford, Princeton), state (Michigan, ASU, UT Austin), community college (De Anza, Miami Dade) and international (IIT Bombay, Lagos, Tsinghua, Los Andes).
  - Majors: CS, econ, nursing, art history, mech eng, undecided, stats, poli sci, plus MBA and PhD.
  - Years: first-year through senior, two-year associate, MBA, PhD.
  - 12 goals: SWE, PM, IB, consulting, VC, design, data, research, fundraising, finding a co-founder, nurse to PM, teacher to data.
  - Resumes, run through the real `heuristicResumeParse`: rich, medium, thin, empty, a messy one-liner, non-native.
  - Own-words answers: detailed, blank, all lowercase, typos, very long, non-native, emoji, terse.
  - Nine never rules.
  - Names: diacritics, hyphens, a single name, an all-lowercase "kevin park".
- **6 recipients**:
  - An alum about two years in.
  - A senior VP, MD or partner who moved from McKinsey.
  - A university recruiter.
  - A seed-stage founder.
  - An associate professor.
  - "Sam", about whom nothing is known.
- **14 scenarios**:
  - First outreach by email.
  - First outreach on LinkedIn, including the connection note.
  - Bump, scheduling reply, thank-you, nurture, congratulate, referral ask, intro request.
  - Five reply classes. Inbound mail is read by the real `heuristicSignal` triage: a question, the same question with LLM-style extracted asks, "send me times", a hand-off to a cc'd colleague, and "ping me in January".
- **Total: 3,660 drafts** from the real `generateDraft` (no LLM, no network). There is no referral ask for fundraising or co-founder goals.
- Each draft is graded by `validateDraft` (with `contextText` grounding, asks, neverDo), by `validateComposed` (reported only), and by a 20-item reply-likelihood rubric (`rubric.ts`).
- **No open-source package was added.** None is in `node_modules`: no readability, syllable or text-statistics package, and no dependencies may be added. Reading grade uses the repo's own Flesch-Kincaid (`compose.ts:133`).

**Hard checks:** 100% green. None of the 3,660 drafts had a validator-blocking issue, a placeholder or a bracket, so `known.ts` is empty. The `it.fails` mechanism is in place for future known failures.

**Rubric:** 90.3% of the 58,186 applicable checks pass, but only 644 of the 3,660 drafts (18%) pass every item.

## Pass rates per rubric item

Weight is how much a miss hurts reply odds, on a 1 to 6 scale.

| item | weight | pass | where it fails most |
|---|---|---|---|
| blocking validator issues | 6 | 100% | - |
| placeholders or brackets | 6 | 100% | - |
| **responsive** (a reply answers what they said) | 5 | **33%** | reply to a question 0%, hand-off to a colleague 0%, "ping me in January" 0% |
| no invention | 5 | 96% | first touches 86% (two-year students called "senior") |
| goal fit | 4 | 92% | first touches 86%; fundraising and co-founder goals miss in every first touch |
| never rules respected | 4 | 94% | nurture 84%, bump 86%, first touches 88% |
| grammar | 3 | 89% | thank-you 50%, first touches 67% |
| LinkedIn note at most 300 characters, with an ask | 3 | 100% | - |
| why-you line (known recipients) | 3 | 100% | - |
| **personalised opener** | 3 | **58%** | the unknown recipient, every time |
| **own words used** (story or proud-of given) | 2 | **11%** | everywhere; the template never reads them |
| clean voice (no typos, emoji or 50-word pastes) | 2 | 94% | reply with LLM asks 42%, nurture 74% |
| length (first touch 50 to 125 words) | 2 | 97% | first-touch email 81% (40 to 47 words) |
| one ask | 2 | 95% | referral ask 63%, bump 67% |
| concrete ask (15 or 20 minutes, real times) | 2 | 100% | - |
| **subject** (2 to 6 words, at most 45 characters, not salesy) | 2 | **49%** | bump 0%, referral ask 0%, first touch 17%, congratulate 17% |
| filler and flattery | 2 | 76% | nurture 0%, "ping me in January" reply 0%, bump 44% |
| greeting with the right first name | 2 | 100% | - |
| sign-off with the student's name, capitalised | 2 | 96% | the lowercase "kevin" persona everywhere |
| no repeated sentences or openers | 2 | 97% | first-touch email 78% |
| reading grade at most 8 | 1 | 88% | intro request 26% |
| no long dashes | 1 | 100% | - |
| compose v2 validator (reported only) | 0 | 47% | first-touch email 12% (subjects, "quick question", grade) |

The suite prints the persona x scenario table and the 15 worst drafts.

## Recurring failure patterns, ranked by how much they hurt reply chances

### 1. Replies that do not answer what the person said (responsive 33%; 1,056 of 1,584 reply drafts)

The person wrote back, which is the warmest moment in the whole funnel, and the draft talks past them. There are three sub-patterns.

**1a. A question is answered with calendar times** (264 of 264 drafts).

They wrote: *"What kind of roles are you looking at, and when do you graduate?"* The draft says:

> Thank you for the reply. Would either of these work for a quick call? Wednesday, Oct 7 at 10am or Friday, Oct 9 at 2pm (EDT). If neither does, send me a time and I'll make it fit.

- **Cause:**
  - The heuristic triage extracts no asks from this message. `ASK_OF_USER` matches only "what roles", not "what kind of roles" or "when do you graduate" (`packages/core/src/email/triage.ts:454-455`).
  - The reply writer then sets `wantsTimes = … || !asks.length` (`packages/core/src/drafts/templates.ts:2300-2301`).
- **Fix:**
  - In `ASK_OF_USER`, also match `what (kind|type)s? of`, `which`, `when do you`, `where are you`, and any sentence ending in "?" that is not about scheduling.
  - In the reply, never let an empty `asks` override a `question` signal: fall back to the `?` sentences of `lastInboundBody`.

**1b. When the asks are extracted (the LLM path), the reply dodges or pastes.**

With no `answer`, 36 drafts say *"Good questions, and happy to walk you through all of it when we talk."* (`templates.ts:2426-2429`).

With an answer, the draft pastes the student's raw text for the first question only and never answers the second (graduation, which Orbit already knows from `user.gradYear`):

> Thank you for the reply. As for roles, land a data scientist role at a compnay that care about users.

> As for roles, I want to get a product management role, ideally somewhere with real mentorship, where I can learn fast from people who have done this for years and eventually lead my own team, and I would honestly take any team as long as I learn.

- **Cause:** `templates.ts:2420-2423` answers `questions[0]` only. `answerLine` (`templates.ts:3086-3098`) passes the answer through verbatim.
- **Fix:**
  - Answer factual asks from the profile: graduation gives "I graduate in May 2028"; roles gives `lookingForPhrase(ctx)`.
  - Only fall back to "happy to walk you through it" for opinion questions.
  - Cut `answer` to its first clause of at most 25 words, capitalise it, and strip emoji when `styleCard.emoji` is false.

**1c. A hand-off to a colleague is answered by asking the person who handed off for times** (264 of 264).

They wrote: *"I'm not the best person for this, but my colleague Tom Reyes runs that team. I've cc'd him here."* (triage reads it as `intro_offer`). The draft says:

> Thanks for getting back to me. What times work for you over the next week or so? Send me a couple and I'll make one fit.

Tom is never named.

- **Cause:** the `reply` case (`templates.ts:2293-2441`) has no branch for `intro_offer` or `referral_offer`, so it falls through to `wantsTimes`.
- **Fix:** add a branch that:
  - thanks the sender and moves them to bcc;
  - addresses the named colleague with the one 15-minute ask.

  The name is in `lastInboundBody`, and `extraction.offers` already captures the sentence.

**1d. "Ping me again in January" is answered with a no-reply-needed check-in** (264 of 264).

> Thanks again for your help. I wanted to check in and see how things are going. … No reply needed, just wanted to stay in touch.

- **Cause:** `reply_decline` is not in `ANSWERABLE` (`packages/core/src/drafts/thread.ts:20-28`), so `writtenKind` rewrites the reply as `nurture` with `reopen` (`templates.ts:1729-1737`).
- **Fix:**
  - A soft decline that carries a `followUpAfter` should produce a two-line acknowledgement ("Thanks, will do. I'll write again in early January.") and schedule the re-engage (`declineReengage`).
  - It must never produce a "check in" to someone who wrote an hour ago.

### 2. Non-recruiting goals are written as job hunting (goal fit 86% on first touches; every fundraising and co-founder first touch)

> *(fundraising founder, to a seed founder)* I'm a first-year PhD student at Michigan studying nursing. I shipped a course-matching app … and I'm recruiting for full-time roles this cycle. One question …: what do you look for in early hires at Loomly?

> *(co-founder seeker, to an alum)* … I saw that you're a fellow alum, now at Ramp. Would you have 20 minutes … to tell me how you ended up as a software engineer there?

The draft never says the student is looking for a co-founder.

- **Cause:**
  - `DraftContext.user` carries no goal kind, only `targetFunctions` and `cycleLabel`.
  - The who-I-am clause is hard-wired to recruiting: `` `I'm ${me}, recruiting for ${lookingForPhrase(ctx)} this cycle` `` (`templates.ts:1981`, `2005`, `1204-1211`, `lookingForPhrase` at `556-580`).
  - `sectorOf` maps a `vc` target to finance (`packages/core/src/drafts/sector.ts:50`). For an unknown recipient that gives banking questions (11 drafts): *"what made you pick your bank over the other banks"* (`packages/core/src/drafts/register.ts:139-142`).
- **Fix:**
  - Pass `GoalKind` (recruiting, fundraising, advice, cofounder) into `DraftContext.user`.
  - Branch the self-intro: "I'm building X and raising a pre-seed round"; "I'm looking for a technical co-founder for …".
  - Branch the question bank by goal.
  - Map `vc` to a VC firm kind, not to `bank`.

### 3. Never rules are not applied by the template, and half are not even checkable (never_do 94%; up to 21% misses for some rules)

| never rule | drafts that break it |
|---|---|
| "dont mention my school" | 87 of 420 |
| "Never use the word 'just'" | 72 of 414 |
| "Don't say I'm a student" | 29 of 414 |
| "No emojis" | 12 of 414 (emoji pasted from the student's update) |

> Hi Jen, I'm a first-year PhD student at Indian Institute of Technology Bombay … *(rule: "Don't say I'm a student.")*

> Just surfacing my note from last week … *(rule: never use "just")*

- **Cause:**
  - `generateDraft` never reads `user.neverDo`; it is only typed (`templates.ts:171-172`) and passed to the LLM prompt (`apps/web/src/integrations/anthropic.ts:779`). The template fallback ignores it.
  - `validate.ts:264-265` reports `never_do` as non-blocking, so it ships.
  - `mentionTarget` / `neverDoChecks` (`packages/core/src/drafts/neverDo.ts:52-73`, `76-101`) reads "dont mention my school" as the literal word "school", and "Don't say I'm a student" as the literal phrase "I'm a student". Neither catches "Stanford" or "PhD student".
- **Fix:**
  - Run a post-pass in `generateDraft` that applies checkable rules:
    - drop the school clause and the subject prefix when the rule names the school;
    - swap "student" year nouns for "I'm studying X at …" or "I'm finishing my PhD";
    - rewrite "just" and filler;
    - strip emoji.
  - Teach `neverDo.ts` semantic targets: school maps to the `user.school` names; student maps to the year nouns.
  - Make an unfixed `never_do` blocking.

### 4. Class year is wrong for two-year and graduate students (no invention 96%; 169 drafts)

> I'm a senior at De Anza studying economics … *(an associate-degree student)*

> Miami Dade senior, following up on my note

126 drafts call every PhD student a "first-year PhD student", whether they have one year left or four.

- **Cause:** `yearLabel` (`sector.ts:110-125`) assumes a four-year bachelor's for any non-graduate degree (AA gives "senior"). For a PhD it returns "first-year" whenever at least one year is left.
- **Fix:**
  - AA and AS degrees: use "first-year" or "second-year" from a two-year span.
  - PhD: omit the year ("a PhD student in physics at …") unless a start year is known.

### 5. Notes spliced in with no subject (grammar 89%; 264 drafts, plus 132 thank-yous)

> I saw that posted that your team is hiring its first five people, and that's what made me write.

> I saw that studies how matching markets place new graduates, and that's what made me write.

> I really appreciated your point that lead every interview answer with the result, then the story.

- **Cause:**
  - `LEAD_VERBS` (`packages/core/src/drafts/phrasing.ts:193-194`) lacks "posted", "studies", "teaches", "researches", "writes", "published", so `clause()` returns `you: false`.
  - The hook connection still uses the raw clause text (`templates.ts:1578`), and the hook opener splices it after "I saw that" (`templates.ts:1380-1385`).
  - `pointPhraseRaw` turns any subject-less note into "your point that \<imperative\>" (`phrasing.ts:506`).
- **Fix:**
  - Add the verbs to `LEAD_VERBS`.
  - At `templates.ts:1578`, accept a hook only when `c.you`, or prefix it with "you ".
  - In `pointPhraseRaw`, turn an imperative note ("lead with …") into "your advice to lead with …".

### 6. Generic opener and the student's own words never used (opener 58%, own words 11%)

All 88 first touches to someone Orbit knows nothing about open with:

> I came across your profile and thought I'd introduce myself.

That is `plainWhyThem` (`templates.ts:1059`), which is a near-twin of the banned "came across your profile and was impressed".

Across all recipients, the student's story and proud-of answers are not used. For example, "I rebuilt the food pantry ordering system and cut wait times from 40 minutes to 10" never appears. The 11% passes are coincidental overlaps with resume bullets.

- **Cause:** `story`, `aim` and `proudOf` are on `DraftContext.user` (`templates.ts:165-170`), but no template branch reads them. Only the LLM prompt does (`anthropic.ts:778`).
- **Fix:**
  - When `credibility` is missing, use `proudOf`, cleaned to one clause, as the credibility line.
  - When nothing is known about the recipient, open with the student's strongest line plus the reason for writing to this kind of person, instead of `plainWhyThem`.
  - Use `aim` to make the ask specific.

### 7. Subjects too long, salesy or bare (subject 49%; 689 subjects over 6 words, 142 with "quick question")

| scenario | example subject | words | cause | template line |
|---|---|---|---|---|
| bump | Indian Institute of Technology Bombay junior, following up on my note | 11 | `` `${school} ${yl}, following up on my note` ``, and `schoolShort` (`phrasing.ts:66-80`) has no short form for "Indian Institute of Technology …" | `templates.ts:2237` |
| referral ask | Quick update + applied to Allen Institute for AI Research Intern role | 12 | | `templates.ts:2925` |
| recruiter outreach | De Anza '27, question about South Park Commons new grad recruiting | 11 | | `templates.ts:1882` |
| first touch | Quick question about your path to your role / to Northwestern University | 8 | v1's `BANNED_SUBJECT_PATTERNS` only bans `^quick question$` (`templates.ts:442`), while compose v2 bans "quick question" anywhere (`compose.ts:84`) | `templates.ts:2051` |
| congratulate (promotion) | Congratulations | 1 | | `templates.ts:2784` |

- **Fix:**
  - Cap generated subjects at 6 words and 45 characters, with a fallback chain ("following up", "my application at Evercore", "your move to Datadog").
  - Drop the school when it is long, and add `IIT Bombay`-style short forms.
  - Remove "Quick question" from the subject candidates, and align the v1 banned list with compose v2.
  - For a promotion, use "Congrats on the new role".

### 8. Filler baked into fixed strings (filler 76%)

| string | occurrences | template line |
|---|---|---|
| "No reply needed, just wanted to stay in touch." | every nurture, 528 in all, including 264 sent right after the person wrote | `templates.ts:2671` |
| "Just surfacing my note …" | | `templates.ts:2221` |
| "… I'd be grateful." in referral asks | 145 | `templates.ts:2894`, `2900` |
| "well deserved" | | `templates.ts:2776` |
| "I came across your profile and thought I'd introduce myself." | | `templates.ts:1059` |

- **Fix:** rewrite the strings:
  - "No need to reply. Rooting for you at X."
  - "Bumping this in case it got buried."
  - "Would you be open to flagging my name to the recruiting team?" This also turns the implicit ask into a question: referral one-ask is 63% because the conditional "If you'd be comfortable …, I'd be grateful" carries no question.

### 9. Repeated openers in one note (no repeat 97%; first-touch email 78%; 76 drafts)

> I saw that you moved from McKinsey to Airbnb. I'm a first-year PhD student at Arizona State studying economics. I saw that you lead the team that built Airbnb's first self-serve product.

- **Cause:** the transition opener (`templates.ts:1341-1342`) is followed by `roleSentence`, `` `I saw that you ${useRole.you}.` `` (`templates.ts:1976`). The guard `!op.usedRole` does not check whether the opener already said "I saw that".
- **Fix:**
  - When the opener used "I saw", write the role line as "…, and now you lead …", or merge the two into one sentence.
  - Also, do not repeat a long school name in both the body and the signature line (23 drafts).

### 10. The student's raw typing is pasted into messages (clean voice 94%; nurture 74%; reply with LLM asks 42%)

> Quick update since we talked in August: I finished my first case competiton and placed 3rd.

> Quick update since we talked in August: just got my first offer 🎉.

> As for roles, research internship ✨ ideally in NYC 🗽.

- **Cause:**
  - `update` (`templates.ts:2574`, used at `2605` and `2618`) and `answer` (`answerLine`, `templates.ts:3086`) go in verbatim apart from `softLower` and `strip`.
  - The sign-off and the forwardable blurb also use `user.firstName` as typed. "Best, kevin park" appears in 5% of all drafts (`signoff`, `templates.ts:520-543`; blurb `templates.ts:2990`).
- **Fix:** add a light normaliser for student-typed text:
  - capitalise "i", "im" and the first letter;
  - strip emoji when `styleCard.emoji` is false;
  - fix a small list of common misspellings, or flag them in the editor;
  - cap the text at its first clause.
  - Capitalise all-lowercase names once at the context boundary (`apps/web/src/engine/brief.ts:964`, `firstName: user.firstName`).

### 11. A professor is treated as a junior employee (11 of 88 professor first touches)

> I'd love to hear what your first few months at Northwestern University were like.

That line went to an associate professor.

- **Cause:** `seniorityOf` matches `associate` as junior (`sector.ts:76`), which picks the junior question bank (`register.ts:335`).
- **Fix:**
  - Exclude "associate" and "assistant professor" from junior.
  - Add an academic question bank: their research, a paper, whether they take undergraduate research assistants.

### 12. Minor: short first touches, reading grade on the intro blurb

- **Length:** 19% of first-touch emails are 39 to 47 words. Recruiter notes and the alum template are the thin ones; Boomerang's sweet spot is 50 to 125 words. Fix: add the `credibility` or `proudOf` line when one exists.
- **Reading grade:** the forwardable intro blurb is above grade 8 in 74% of intro requests. Long institution names and "recruiting for product management internships" drive it. Fix: use short school names and "PM internships".

## Notes and limits

- This exercises the **template writer only**. In production, an LLM rewrite may improve voice and use `story`, `aim`, `proudOf` and `neverDo` through the prompt (`anthropic.ts:778-779`). But the template is the fallback, and the floor every rewrite must pass.
- Personas, recipient facts and inbound replies are synthetic.
- Some inputs are deliberately awkward, the way real notes are: a subject-less "posted that …" hook, an imperative advice note.
- The rubric is heuristic: regexes plus the repo's own `asksIn`, `fleschKincaidGrade` and `unsupportedDetails`. Per-item reasons are in the run output and in `SIM_OUT/sim-drafts-results.json`.
- Nothing in `apps/web` or the existing core files was modified.
