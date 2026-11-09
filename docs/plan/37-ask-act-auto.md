# 37. Ask, act, auto: one question when the ask is unclear, buttons that act in place, and a mode that picks its own effort

Status: plan, 2026-11-09. Written from three things the founder saw in the gallery and the live app on 2026-11-09, each
traced to its cause in main `cc02b34`. Amends 19 (persona: one question), 28 (the bench), 32 and 36 (network search and
the ladder), 35 D1 (chat effort) and the card layer of 14. Written for a Claude Code session to execute top to bottom in
the order of §7, iterating with the gallery and the bench until every acceptance line in §7 holds.

The three rules this plan adds to Orbit:

1. **Ask before you guess.** When a name in the ask fits more than one real thing (two companies called Triumph, two
   Lenas, two open drafts), Orbi asks one short question with the choices as buttons, and does nothing else until the
   student answers. Then it does the original ask, with the answer filled in, without being asked again.
2. **A button is the action.** Tapping a card button does the thing, flips the button to its done state, and adds
   nothing to the chat. No new student turn, no reply, no explanation. Only buttons that need the model to think (draft,
   prep, routes) start a turn.
3. **Orbit picks the effort.** A third composer mode, Auto, chooses Quick or Smart for each turn from what the turn
   is, and moves up to Smart mid-turn the moment the model reaches for a judgement tool. Smart and Quick stay as
   overrides.

## 0. Rules for the executor

Same as 35 §0: lint, typecheck, `TZ=UTC pnpm -r --no-bail test`, run the big suites one at a time, rebuild `dist` when
`supabase/functions` changes (nothing in this plan should), commit as Orbit with no trailers, push to main once checks
pass, wait for CI. Migrations: none are expected; if one is needed it is additive. No em dashes or exclamation marks in
UI, prompt or plan text. Anything marked DECISION waits for a yes. A bench run spends money and is approved as a budget
(§9).

Iterate, do not ship once: every phase in §7 ends with the gallery cases it names re-shot through the CLI shim
(handoff: `node scripts/claude-cli-shim.mjs`, `pnpm build`, `GALLERY_ONLY=...`, `scripts/chat-gallery/build.mjs`) and
reviewed against its acceptance lines. A phase is done when every line holds on two consecutive shoots.

## 1. The failing cases, with their causes

### 1.1 "Who do I know at Triumph" got a 90-word analysis instead of a question

What the student saw: a company card titled Triumph saying "nobody you know there now, 0 former employees you know"
with an "Add Triumph to targets" button, then a reply that described people at two different companies, Triumph Law and
Triumph Education Group, guessed that "Pm" at a law firm means partner, and judged a CEO "very senior to write to cold".

Causes, in the code:

- `find_routes` (`apps/web/src/chat/tools/read.ts:1290-1321`) has two inputs for a company. `company` goes straight to
  `reachCompany`, which matches the normalised name exactly (`engine/graph.ts:824-880`): "triumph" matches no
  organization, so the reach is empty and the card says nobody. `query` goes through `rankReachTargets` and
  `isUnambiguous` (`engine/graph.ts:744-822`), which would have returned both Triumphs as candidates with
  `ambiguous: true` and the summary "Several things match. Ask which one is meant." The model picked `company`, as its
  description invites ("a company name"), so the ambiguity path never ran. The resolution has to happen inside the
  tool whichever input the model used.
- The people in the prose came from `search_network`, whose company match is a token match on the LinkedIn facts
  (`packages/core/src/search/companies.ts`, `keysFor`, `isAmbiguousKey`), so "Triumph" found both firms. The card and the
  prose came from two tools with two notions of what Triumph is, and nothing joined them.
- The prompt (`agent/system.ts`, v27) says "one question per message, and only when it moves things on" (line 165) and
  the no-dead-ends rule says a people question never ends on nobody (line 38). Nothing says: when a name fits several
  things, ask which, and stop. Under those rules the model did what they reward, it kept going and filled the gap
  with analysis. Models under-clarify by default (§2), so a prompt line alone will not hold; the tool has to return the
  question and the loop has to stop the turn after the model's one line.

### 1.2 "Add Triumph to targets" started a chat turn

What the student saw: tapping the button posted "Add Triumph to my target companies" as their own message, the model
replied with words, and a second card appeared.

Cause: every card button is a `NextStep = { label, message }` (`chat/ui/cards/parts.tsx:296-299`, built in
`cards/next.ts`, for this one `addTarget`, line 157). `NextSteps` calls `actions.send(step.message)`, which is
`threadActions.turn` (`ui/threadStore.ts:357`): it appends a user turn and streams an assistant turn. There is no other
path for a card button. The one precedent for a model-free exact action is the picked-people message in
`agent/index.ts:308-312` (an "Add to People: A [rec x]" message runs through the router even with Claude on), and the
chips on the home page (`agent/chips.ts`) run a tool directly through `execute()`. Both still add turns to the thread.

### 1.3 Smart and Quick are a switch nobody flips

`ui/prefs.ts` stores `smart | quick` in localStorage; `engineContext.tsx:32` reads it as `quick: () => ...`;
`agent/loop.ts:501` sets `output_config.effort` to `low` or `medium` for every request of the turn. Plan 35 D1 proposed
exactly the per-turn choice ("low for turns the local router marks simple, medium for the rest") and did not ship for
want of a bench run. There is no telemetry of which effort a turn used (`StoredUsage`, `loop.ts:513`).

## 2. Research: when an assistant should ask, and how

Read on 2026-11-09 from abstracts, summaries and the posts themselves; marked [SECONDARY] where the paper was not read in
full. The field agrees on more than it disagrees.

**Findings**

- Asking is the exception, guessing is the default failure. Across 6,120 multi-turn dialogues, every model tested
  "favours premature answering" over asking (ClarifyMT-Bench, arXiv 2512.21120 [SECONDARY]). A 300-session timing study
  found GPT over-asks, Claude "asks selectively and late", Gemini never asks [SECONDARY]. So the detection of ambiguity
  cannot be left to the model's judgement in the moment: the system detects it and hands the model the question.
- Detecting that a question is needed and writing a good one are different skills and "not strongly correlated"
  (DiscoBench [SECONDARY]). Keep them apart: tools detect, the UI renders the choices, the model writes one line.
- When to ask has been studied far less than what to ask (Aliannejadi et al., Qulac 2019, arXiv 1907.06554; ClariQ 2021,
  arXiv 2109.05794; zero-shot clarification need prediction 2025, arXiv 2503.00179). The usable rule from that line of
  work: ask when the candidate readings lead to different results, not when the query merely looks vague.
- The practitioner consensus (Zowie "knowledge disambiguation"; the "clarification protocol" and "convergent flows"
  posts; barkingiguana "handling ambiguous questions"): ask when the readings diverge into different actions and a wrong
  guess costs the user something; use what you already know about the user before asking (one open order means no
  question); one question, answerable in a word or a tap; never ask twice about the same thing; name the options rather
  than asking open-ended; and after the answer continue the original task without making the user restate it.
- Tool-using agents that ask only on structural ambiguity cut questions 1.5 to 2.7 times while covering 7 to 39% more
  ambiguous tasks (ClarifyBench / SAGE-Agent, arXiv 2511.08798 [SECONDARY]). That is the shape of §3: the question comes
  from the tool that found two referents, never from the model's hunch.

**The rules Orbit takes from this** (they are the acceptance criteria of §7)

- R1, referent versus degree. A proper noun that fits two or more distinct things (companies, people, drafts) is
  ambiguity of referent: ask, for reads as well as writes. Fuzziness of degree (how many, how far back, which week) is
  not: proceed with the default and say it in one clause.
- R2, context first. Before asking, resolve from: a thing already named with an id earlier in this conversation; a
  target company or goal company whose name matches exactly; and for people the person in the current thread or
  pipeline card. One survivor means no question.
- R3, candidates that could matter. A company candidate with nobody in the network and not a target drops out before
  counting; two or more left means ask.
- R4, one question, tap to answer. The question is one line under 20 words, the choices are buttons with one line of
  context each (what the company is, how many people there), two to four of them. Typing still works.
- R5, the answer completes the ask. The pick carries the original message; the student never restates it. The
  resolution holds for the rest of the conversation ("Triumph" means Triumph Law from then on).
- R6, never twice, never for show. The same ambiguity is not asked again in a conversation. A tool that found one
  referent never produces a question, and the prompt forbids the model inventing one.
- R7, nothing else in the turn. A clarifying turn is the question and the buttons. No analysis of the options, no
  partial answer for one of them, no next steps.

Sources: [Qulac](https://arxiv.org/abs/1907.06554), [ClariQ](https://arxiv.org/abs/2109.05794),
[zero-shot CNP](https://arxiv.org/abs/2503.00179), [ClarifyMT-Bench](https://www.emergentmind.com/papers/2512.21120),
[ClarifyBench](https://arxiv.org/abs/2511.08798),
[convergent clarification flows](https://tianpan.co/blog/2026-05-07-ai-clarification-dialogue-convergent-flows),
[the clarification protocol](https://dev.to/askpatrick/the-clarification-protocol-how-to-stop-ai-agents-from-guessing-when-they-should-ask-2hpp),
[knowledge disambiguation](https://getzowie.com/blog/knowledge-disambiguation),
[handling ambiguous questions](https://barkingiguana.com/writing/handling-ambiguous-questions-with-clarification/).

## 3. Design A: ask before you guess

### 3.1 One result kind: `clarify`

A new `ResultEnvelope.kind = 'clarify'` with data:

```
{
  about: 'company' | 'person' | 'draft',
  question: string,                       // "Which Triumph?"
  original: string,                       // the student's message this answers, verbatim
  options: {
    label: string,                        // "Triumph Law"
    sub?: string,                         // "Startup law firm. 3 people you know"
    resolve: { company?: string; organizationId?: string; personId?: string; draftId?: string },
  }[],                                    // 2 to 4
}
```

`toModel` returns one instruction, not the options: "The ask fits several things. Write one short question naming the
choices in a clause and stop. Do not describe, compare or pick. The buttons under your line carry the choices." The
loop treats a clarify result as terminal for the round: when one arrives, the runner is rebuilt (as `loop.ts:874` and
`:899` already do) with `tool_choice: { type: 'none' }`, so the model can only write its line, and the turn ends.

### 3.2 The card

`ClarifyCard` in `chat/ui/cards/Clarify.tsx`: flat, no nested boxes, the question as the title, one button per option
with its `sub` as a second line, in the style of the choice pills (`Choices.tsx`). A tap:

1. flips the card to a quiet line, "Triumph Law" with a check, and disables the other options (the same
   `laterUserText` mechanism as `Choices.tsx:36-47`);
2. records the resolution on the conversation (§3.4);
3. sends the pick as the student's next turn: the visible user text is the label ("Triumph Law"); the model receives
   `[picked Triumph Law (org:…) for: who do I know at Triumph]` as the message content, so the next call runs the original
   ask with the id bound. The router reads the same bracketed form, so the no-key path continues too.

The thread hides a clarify card once the turn after it shows the settled card (the `KnownPeople` rule at
`ResultCard.tsx:119-128` extended to clarify), so a read-back of the chat is question, answer, result, never a dead
button.

### 3.3 Where ambiguity is detected (structural, model-free)

| Referent | Tool | Detection | Options |
|---|---|---|---|
| Company | `find_routes`, both `company` and `query` | `resolveCompanyRef(name, people, orgs, targets)` in `engine/graph.ts`: exact normalised key wins when exactly one org has it; else `rankReachTargets` prefix and word matches grouped by `orgKey`; drop candidates with no people and not a target (R3); one left proceeds; two or more return `clarify` | label the org name, sub from `companyFacts` (kind, one-line description) plus "N people you know" |
| Company | `search_network` with `position.company.names` | same resolver on each name before the search runs; when ambiguous, the tool returns `clarify` instead of running | same |
| Company | `find_people` with a company | same resolver; a company nobody knows is fine here (sourcing is for new people), so R3 is skipped and only distinct orgs on file count | same |
| Person | `search_people`, `get_person` by name, `create_draft` and `draft_reply` by name | the existing candidates path (`Which "Lena"?`, `PeopleCards.tsx:174`) returns `clarify` with `about: 'person'`; the people list card stays for searches that are not a name lookup | name, sub "title at company, how you know them" |
| Draft | `send_draft`, `update_draft_body`, `manage_draft`, "send it", "fix the draft" with no id and two or more open drafts | drafts tools return `clarify` with `about: 'draft'` | first line of the draft, sub "to Lena Novak, started today" |

Out of scope here, listed so they are not forgotten: a time ("Tuesday" when two are plausible) and a goal (which of two
active goals an ask belongs to). Both are ambiguity of degree in most asks; they get defaults and one clause (R1).

### 3.4 Context before asking, and memory after

`ChatConversation.resolved: { key: string; about; resolve; label }[]` (Dexie, additive field; account mode mirrors it on
`orbit.chat_conversations` only if the field is already JSON there, otherwise it stays client-side, DECISION-free). The
resolver checks, in order: a `resolved` entry for the normalised name in this conversation; a target company or goal
company with the exact key; then the candidate rules. A pick writes the entry. `snapshot.ts` adds one line per
resolution to the next turn's context ("Triumph means Triumph Law in this chat"), so the model does not re-ask.

### 3.5 The prompt, v28

Two lines, no more:

- "When a tool returns a clarify result, write one short question naming the choices in a clause ("Triumph Law or
  Triumph Education?") and stop: no analysis, no partial answer, no next steps. When the student picks, run the ask they
  first made with that choice, without asking anything else."
- Amend the no-dead-ends line: "A clarify result is not a dead end and is never answered around."

And strike nothing else; the model gets fewer words, not more.

### 3.6 The no-key router

`routerNetwork.ts` and `routerThread.ts` call the same tools, so they get the same `clarify` envelopes for free; the
router's text for the turn is the question itself. The pick's bracketed form is parsed in `router.ts` next to the picked
people form.

### 3.7 Guarding against over-asking

- A tool returns `clarify` only from its own data (two org ids, two person ids, two draft ids), never from a score
  threshold alone.
- Unit tests assert that "who do I know at Stripe" (one Stripe), "tell me about Lena Novak" (one Lena when the demo has
  one), and a company already in targets never produce a clarify.
- The bench gets a `clarify` group (§6) that scores both directions: asked when it should, did not ask when it should
  not.

## 4. Design B: a button is the action

### 4.1 Three kinds of button

Every `NextStep` is one of:

- `run`: a state change the tools can make without the model. Runs the tool directly, records the result, flips to a
  done state. Nothing is added to the thread.
- `ask`: needs the model (write to them, prep me, find a warm intro, who does she know). Sends a message as today.
- `go`: navigation (Show on map, Open). A link, as today.

```
export interface NextStep {
  label: string;
  message?: string;                                     // ask
  run?: { tool: string; input: Record<string, unknown>; done: string; undo?: { tool; input } };  // run
  href?: string;                                        // go
}
```

`cards/next.ts` is where each step is defined, so the reclassification is one file:

| Step (label) | Today | After | Tool |
|---|---|---|---|
| Add {company} to targets | message | run, done "Target" (chip on the card turns to Target) | `manage_target_company` add |
| Add to People (pick bar, `adds` only) | message through the router | run, done "Added" | `add_sourced` / `save_suggested_contacts` with the picked ids |
| Find email | only on the Find People page today (`components/account/FindPeople.tsx:204`, `engine/sourcing.ts` `findEmail`); the chat's sourced-people card has no button | run on the sourced card, done is the address filled in on the row | a new `find_email` tool over `findEmail`; a paid lookup, so plan 35 caps apply and it runs only on the tap |
| Snooze, Dismiss, Hide (brief and suggestion cards) | message | run, done "Snoozed until Mon" etc. | `manage_suggestion`, `dismiss_suggestion`, `manage_recommendation`, `hide_person` |
| Mark done, Move to stage (pipeline cards) | message | run, done "Marked done", with undo | `move_pipeline_stage`, undo `undo_stage_move` |
| Forget this (voice notes, memory) | message | run, done "Forgotten" | `forget_voice_note`, `forget` |
| Track as a goal (afterTurn offer) | choice message | stays a message: set_goal wants the model's reading of the chat | |
| Write to them, Prep, Find warm routes, Who X knows, Ask for an intro, Warm up first, Write now | message | ask (unchanged) | |
| Show on map, Open, profile links | link | go (unchanged) | |
| Send / Approve on a draft | in place already (`ResultCard.tsx:1600-1703`) | unchanged; it is the model for `run` | |
| offer_choices pills | message | unchanged: they are replies, not actions | |

### 4.2 The engine path

`ChatEngine.runStep(conversationId, step, origin: { toolUseId })` in `agent/index.ts`:

1. `execute(step.run.tool, step.run.input)` through the registry, the same permission and confirmation rules as a
   model call (a tool that returns `needs_confirmation` shows the existing Approve card inside the same card instead of
   a done state).
2. `recordToolAction` (`agent/actions.ts`) with `id = newId()`, `messageId` of the card's assistant message, and a new
   optional `origin: { toolUseId, label }` so hydration can find it.
3. Returns the envelope. No `TurnEvent`, no user turn, no assistant turn. The thread's `running` flag is not set, so
   other buttons stay live.

### 4.3 Done state, live and after a reload

- Live: the button shows a check and `done` ("Target"), and the card re-reads what changed. The company card already
  reads `target` from the envelope; it moves to a live read (`useLiveQuery` on `targetCompanies`, the pattern of
  `useLiveDraft`) so the chip and the button agree with the data, not with the moment of the tap.
- After a reload: `hydrate` (`threadStore.ts:243`) already receives `actions`; a card finds done rows by
  `origin.toolUseId` and marks the matching step done. Where the data itself says it (the company is a target, the
  person is in People), the live read wins and the action row is not needed.
- Failure: the button shows the error in place in one short line ("Couldn't add it. Try again.") and stays tappable.
- Undo: a `run` step with `undo` shows "Undo" beside the done state for the rest of the card's life (the
  `AddTargetCompany` component already toggles a target off; reuse its logic rather than a second implementation).

### 4.4 Telling the model what the student did

The model never saw the tap, so without a note it will offer the same step again. `snapshot.ts` adds a "Since your last
reply, in cards:" block listing run steps since the last assistant message ("added Triumph Law to targets"), built from
action rows with `origin`. It goes in the per-turn context, not the history, so the cached prefix is unchanged.

### 4.5 Tests

- `cards/next.test.ts`: every exported step has exactly one of `message`, `run`, `href`; every `run` tool exists in the
  registry and its input parses against the tool's schema.
- `cards/pick.test.tsx`: tapping a run step calls `actions.runStep`, never `send`; the button shows `done`; a failing run
  shows the error and stays enabled.
- `ui/thread.test.tsx`: hydrating a thread with a done action row shows the step done; the turn count equals the
  message count (no turn was added by a run).
- e2e `chat-pick.spec.ts`: on the demo, "who do I know at Stripe", tap "Add Stripe to targets": the number of turns is
  unchanged, the card's chip says Target, Settings lists Stripe as a target, and a reload keeps all three.

## 5. Design C: Auto mode

### 5.1 The third mode

`ChatMode = 'auto' | 'smart' | 'quick'`, Auto first in the menu with the hint "Orbit picks. Quick for lookups and small
edits, Smart for drafts and judgement calls." The composer button reads "Auto" and, after a turn, its menu says what it
chose last ("Last reply: Quick"), nowhere else. DECISION D1: whether Auto becomes the default for everyone (the pref
unset reads as `auto`) or stays opt-in until the bench in §5.4 passes.

### 5.2 The choice before the turn

`agent/effort.ts`, `pickEffort(text, ctx): { effort: 'low' | 'medium'; reason: string }`, model-free, microseconds:

- `low` when the message is a continuation (a clarify pick, a picked-people message, a choice pill, a one or two word
  reply, "yes", "ok", "thanks"), small talk by `smallTalk.ts`, or a read intent the router recognises
  (`routeUtterance` kind `tool` for a tool with `kind: 'read'`: today, pipeline, who went quiet, when is my next chat,
  show my drafts, open X, tell me about X, who do I know at X).
- `medium` for everything else: anything the router cannot route, any write intent (draft, reply, bump, thank, intro,
  ask, send), "should I", "what do you think", "how do I", "help me", a pasted posting or thread (over 300 characters or
  a URL), advice and how-it-works questions, and every turn whose previous turn was medium and ended in a question from
  Orbi (the student is answering something that needed thought).

The known router gap (the handoff: "who do I know who works in climate" is not routed to network search) is fixed
here so the classifier sees it as a read: `routerNetwork.ts` learns the "who do I know who works in <field>" shape.

### 5.3 Moving up inside a turn

A `low` turn can turn out to need judgement: the model calls `create_draft`, `create_drafts`, `redraft_with_inputs`,
`draft_reply`, `answer_reply`, `plan_for_posting`, `ask_for_intro`, `ask_friend_for_intro`, or `set_goal`. The loop already rebuilds the tool runner with
changed params (`loop.ts:874`, `:899`); on the first such call it rebuilds with `output_config.effort: 'medium'` for the
remaining iterations. The effort of the request that produced the final text is what the turn records. The reverse
never happens: a turn that started at medium stays there.

### 5.4 Telemetry and the bench

- `StoredUsage` gains `effort` and `effortReason`; `recordTokens` passes `effort` so the per-request usage table
  (plan 34 C1, `orbit_private.claude_usage`) can split cost by effort. The 35 §9 queries get one more: cost per message
  by mode.
- Bench: plan 35 D1's gate, run as two `chat-baseline.sh` runs on Auto against the last Smart baseline (about $8 a run,
  approval in §9): no dimension average under 2.5 (friendAhead 2.1, shape 2.2), no scenario under 2, cost per message
  down 10% or more. If Auto passes, D1 is shipped; if Smart still wins on `rightOutcome` or `friendAhead`, §5.2 moves
  the failing scenario shapes to `medium` and runs again.
- Gallery: every existing case shoots on Auto; the review page shows the effort chip on each shot so a weak answer can
  be read against the choice that produced it.

### 5.5 What Auto never does

It never changes the model (35 D2 is separate and stays bench-gated), never lowers effort mid-turn, never applies in
router mode (the menu shows Templates as today), and never writes anything into the chat about itself.

## 6. The bench and the gallery for this plan

**Sim scenarios** (`chat/__tests__/sim/scenarios.ts`), new group `clarify`, demo account. The demo data gains a pair of
companies sharing a stem that nothing else uses (DECISION D2 on the names; the plan assumes "Harbor Health", a clinic
group with two people, and "Harbor Capital", a seed fund with one), so the Triumph case can be reproduced without
touching Stripe, Bain or the Lenas:

| id | goal | expect |
|---|---|---|
| clarify-company-two | "who do I know at Harbor" | one question under 20 words, a clarify card with two options, no people named, no next steps; after the pick, the company card for the chosen one and a normal answer |
| clarify-company-one | "who do I know at Stripe" | no clarify; the company card as today |
| clarify-company-target | "who do I know at Harbor" after Harbor Health is a target | no clarify; Harbor Health |
| clarify-company-sticky | "who do I know at Harbor", pick Harbor Capital, then "draft a note to someone there" | no second question; the draft goes to the Harbor Capital person |
| clarify-person-two | "tell me about Lena" with two Lenas | one question, the two Lenas as options with their titles; after the pick, the person card |
| clarify-draft-two | two open drafts, "send it" | one question, the two first lines as options; the pick leads to the Approve card, nothing sent |
| clarify-never-invent | "find me PMs at Figma" | no clarify; `rightOutcome` 3 |

Judge: `rightOutcome` already names "a question back when the ask was ambiguous"; its description gains the opposite
clause, "and no question when one reading was clearly meant". Shape check: a clarify turn is under 25 words and ends on
the card.

**Gallery cases** (`apps/web/e2e/gallery.spec.ts`): `c01` the two-company ask, `c02` the pick and the answer, `c03`
the one-company control; `b01` "Add Stripe to targets" tapped (one shot before, one after, same turn count), `b02` Find
email tapped, `b03` a reload after `b01`; `a01` to `a03` the existing `n07`, `d01` and `p02` shot on Auto with the effort
chip visible. Acceptance for each is the §7 line it belongs to.

## 7. The plan, in order

### Phase 1: companies ask first (the Triumph case)

Files: `engine/graph.ts` (`resolveCompanyRef`), `chat/tools/read.ts` (`find_routes`), `chat/tools/search.ts` and
`engine/networkSearch/index.ts` (resolve names before the search), `chat/tools/network.ts` (`find_people`), `chat/types.ts`
(`clarify` kind, `ChatConversation.resolved`), `chat/ui/cards/Clarify.tsx`, `cards/shapes.ts` (`readClarify`),
`ResultCard.tsx` (route the kind, hide a settled clarify), `agent/loop.ts` (tool_choice none after a clarify),
`agent/system.ts` v28, `agent/snapshot.ts` (resolutions), `agent/router.ts` and `routerNetwork.ts` (read the pick),
`db/schema.ts` (Dexie version bump for `resolved`), demo data for the Harbor pair.

Tests: `engine/graph.test.ts` (resolver: exact wins, prefix pair asks, target resolves, nobody-and-not-target drops),
`chat/__tests__/clarify.test.ts` (each tool returns clarify when it should and never when it should not; the pick runs
the original ask with the id; the resolution sticks), `cards/pick.test.tsx` (the card, the flip, the hidden state),
`thread.test.tsx` (question, answer, result read back), sim group `clarify` offline, gallery `c01` to `c03`.

Acceptance: on the demo, "who do I know at Harbor" shows one line and two buttons and nothing else; the tap shows
"Harbor Health" as the student's turn and the right company card; "who do I know at Stripe" is unchanged; the router
path does the same without a key.

### Phase 2: buttons act in place

Files: `cards/parts.tsx` (`NextStep`, `NextSteps` with three kinds, the done and error states), `cards/next.ts`
(reclassify per §4.1), `chat/types.ts` (`ChatEngine.runStep`, `ChatAction.origin`), `agent/index.ts` (`runStep`),
`agent/actions.ts`, `ui/threadStore.ts` (`threadActions.runStep`, hydration of done steps), `ResultCard.tsx`
(`CardActions.runStep`, the company card's live target read), `agent/snapshot.ts` ("in cards" block),
`components/AddTargetCompany.tsx` (share the toggle).

Tests: §4.5.

Acceptance: tapping "Add Stripe to targets" changes the chip to Target, adds nothing to the thread, survives a reload,
and the next reply does not offer it again; the same for Add to People from a pick bar and for Find email; Write to
them and Prep still start a turn.

### Phase 3: people and drafts ask first

Files: `chat/tools/people.ts` and `read.ts` (name lookups return clarify), `chat/tools/drafts.ts` (two open drafts),
`PeopleCards.tsx` (the `Which "X"?` title goes; the people list is for searches), `cards/next.ts` (the pick's follow-on
steps), router thread handling.

Tests: sim `clarify-person-two`, `clarify-draft-two`; unit tests as Phase 1.

Acceptance: "tell me about Lena" with two Lenas asks once; "send it" with two drafts asks once and the pick opens
Approve, nothing is sent.

### Phase 4: Auto mode

Files: `ui/prefs.ts`, `ui/Composer.tsx` (menu and the last-choice line), `engineContext.tsx` and `agent/index.ts`
(`effort` getter replacing `quick`), `agent/effort.ts` (new), `agent/loop.ts` (effort per request, the move up),
`agent/routerNetwork.ts` (the "works in <field>" shape), `chat/types.ts` (`StoredUsage.effort`), `scripts/chat-gallery`
(the effort chip), `integrations/anthropic.ts` (`recordTokens` with effort).

Tests: `agent/__tests__/effort.test.ts` (40 messages labelled by hand, the continuation and small talk cases, the move
up), `loop.test.ts` (a low turn that calls create_draft finishes at medium and records it), `widgets.test.tsx` (the menu
has three modes, Auto first), router test for the climate shape.

Acceptance: Auto is selectable; a lookup records low, a draft records medium, a lookup that turns into a draft records
medium; the gallery shots show the chip; nothing about effort appears in the chat.

### Phase 5: the rounds

1. Gallery round on every case in §6 plus the full existing set on Auto. Review in the artifact; fix; re-shoot the
   failures with `GALLERY_ONLY`. Repeat until two clean shoots.
2. Live check on the founder's own account: two companies that share a stem in their real network, one tap on a target
   button, one Find email. Fix anything the demo did not show.
3. Bench for Auto (§5.4), after approval of the budget. Decide D1 from the result.
4. Write §8 with the before and after of each case, and the decisions taken, in the same commit that closes the plan.

## 8. Before and after

| Case | Before (2026-11-09) | After |
|---|---|---|
| "who do I know at Triumph", two Triumphs | a company card saying nobody, 90 words comparing both firms and judging who is too senior | "Triumph Law or Triumph Education Group?" and two buttons; a tap, then the right company card and a short answer |
| "Add Triumph to targets" | a new student turn, a reply, a second card | the chip says Target, the button says Target with a check, the thread is unchanged |
| Composer mode | Smart or Quick, set by hand, never changed | Auto: Quick for lookups and taps, Smart for drafts and judgement calls, moving up mid-turn when needed; Smart and Quick remain as overrides |
| Cost a message (35 §1.1: about $0.045) | all turns at medium | measured in Phase 5 step 3; target 10% down at the same scorecard |

## 9. Decisions and approvals

- D1 Auto as the default mode for everyone, or opt-in until the bench passes. Recommendation: opt-in until the bench
  passes, then default.
- D2 The demo's company pair for the ambiguity cases (the plan assumes Harbor Health and Harbor Capital).
- D3 A read with two candidates always asks (R1), as this plan says, rather than taking the first and offering the
  other in a clause. Recommendation: ask; the founder's report was a read.
- D4 Undo on run steps: for the card's whole life (the plan) or for a few seconds. Recommendation: the card's life; it
  is one word and matches Settings.
- Budget: two chat bench runs on Auto, about $16, plus one on Smart if the last baseline is older than plan 36 (another
  $8).

## 10. Risks

- The model answers around a clarify result despite the prompt. Mitigation: `tool_choice: none` after the result makes
  the turn end on its one line; the shape check fails any clarify turn over 25 words.
- Over-asking from name stems that are common words ("Scale", "Here"): `isAmbiguousKey` already marks these in the
  search; the resolver treats a common-word stem as a match only on the exact key, never on a prefix.
- Run steps and the model's picture of the world drift: the snapshot block in §4.4 is the fix; the test in §4.5 that the
  next reply does not re-offer the step is the check.
- Auto picks low for an ask that needed thought and the move up never triggers (no judgement tool is called, the model
  just answers). Mitigation: the `medium` list in §5.2 errs toward medium for anything the router cannot name; the bench
  is the arbiter, and Smart is one tap away.
