# 22. The Prep deck: everything for the call, swiped through from About

Status: built (2026-10-25), with the three decisions taken as proposed: After the call lives in the deck, the header
button shows from a day before a scheduled chat to two hours after it, and Lately reads only posts Orbit already has.

## Why

Prep is a fourth tab today (`apps/web/src/pages/Person.tsx`, the `Prep` component, about 400 lines, plus
`PrepResearch`). It is a long page of cards the student scrolls: goal and ask, when and where, before the call, who
they are, from research, questions to ask, after the call. It reads well at a desk the night before. It is the wrong
shape five minutes before a call on a phone: the student wants to flip through what matters, one screen at a time, and
know when they have seen it all.

The deck replaces the tab. About (the `facts` tab) keeps the durable record of who someone is (their LinkedIn history,
Deep research, the student's own facts) and grows a **Prep** button that opens the deck over the page. The deck is the
same facts, arranged for the sixty seconds before a call.

## What the student sees

### The button

- About, at the top, a row above "From LinkedIn": **Prep for the call** (primary) and, when a chat is on the calendar
  in the next 24 hours, its time beside it ("in 2 h · Join link"). Deep research keeps its own button in the
  `ResearchDebrief` card below; the two never merge, since research spends money and prep never does.
- The person header shows the same button for the next 24 hours before a scheduled chat (and for 2 hours after, for
  the After the call card), so the student does not have to find the tab.
- Today's `prep_brief` card ("Open prep") and the chat tools that point at Prep open the deck directly.

### The deck

A full-screen overlay: a centred 560px card on a desktop, a sheet from the bottom on a phone. Click, swipe or use the
arrow keys to move; dots and "3 of 9" say where you are; Esc or the close button leaves it; reopening returns to the
card you were on (per person, for this tab's session). It is the morning brief's deck (`MorningBrief.tsx`: pointer swipe
that ignores drags starting on a button or a field, arrow keys, Enter for the primary button), factored out so both use
one component.

Cards, in the order the call itself runs. A card with nothing to show is dropped, never shown empty. The deck always
has at least the cover, who they are, your intro, questions and after the call.

1. **The call.** Their name and photo, when (from the next calendar event: "Today 3:00 pm · 30 min · Join link"), or
   "No time set yet" with Schedule. Your goal for this chat and your one ask (`buildPrep`: goal, ask).
2. **Who they are.** Headline, their last three roles with the companies' LinkedIn logos and years (the About work
   history, `db.affiliations` with `source: 'linkedin_profile'`), school and "your school's alum", city. One line from
   research (`DossierView.who`) when a brief exists.
3. **Lately.** What they have been up to: the brief's `recently` (cited), their latest LinkedIn posts (the engagement
   rows `checkHops` already reads for routing; a new selector `latestPostsOf(memberId)`), a job change the enrichment
   record noticed (`rec.jobChange`: "Moved to Blackstone in Aug"). While the live read is still running: "Reading
   their LinkedIn…". Nothing public: "Nothing public lately; the call leans on what they told you".
4. **What you share.** The brief's `inCommon`, same school or same past company (affiliations both ways), the mutuals
   who know them best (`mutualStandings`, top three, with the pair phrase: "Kenji knows them well · 82"), how you first
   met (the first touchpoint).
5. **Where you left off.** The last three things that happened between you (the timeline, one line per thing), the
   last message either way in a sentence, what you still owe them (open action items), and what they told you that
   matters (facts of type advice and personal, up to four).
6. **Your 30-second intro.** `plan.intro` large, with the missing-piece note (`introMissing`) when the profile is
   thin and a link to fill it in. "Say it out loud once."
7. **Openers.** The brief's openers with full support (never partial), then the reading list (`plan.research`: their
   recent post, the company page), each a link.
8. **Questions.** `plan.questions`, pick up to three (kept on the chat: `togglePrepQuestion`, `CoffeeChat.prepQuestions`
   as today), the closing question pinned at the bottom: "Is there anyone else you'd suggest I talk to?"
9. **Careful.** The brief's `careful` lines (company context only, by plan 20's rules), the audience tips
   (`logisticsTips`: a recruiter, a senior person), and a do-not-contact flag if set. Dropped when all three are
   empty.
10. **After the call.** Shown last, and the deck opens straight on it when the chat has a `completedAt` or the event
    ended: the follow-ups (`plan.followUps`), "Who did Ravi suggest you talk to?" (the suggested-names field from the
    tab, same save-or-confirm rules: `readSuggestedNames`, `saveSuggestedContacts`), and **Log this chat**, which marks
    the chat completed and queues the thank-you draft the pipeline already writes.

Copy rules as everywhere: no em or en dashes, the student's own words, nothing invented. Every claim from research
carries its source numbers and the brief's footer line stays on the Lately and Openers cards.

### What never happens

- The deck never starts Deep research, never reads LinkedIn beyond what About and the map already read for this
  person, and spends nothing. When no brief exists, the Lately card says so and points at the Deep research button on
  About with the month's count; the student presses that, not the deck.
- The deck is never a chat prerequisite: the chat tools keep answering "prep me for my next chat" in words and link to
  the deck.

## How it is built

### Engine

- `apps/web/src/engine/prepDeck.ts` (new, pure): `buildPrepDeck(args) => PrepCard[]`, where `PrepCard` is
  `{ kind, title, lines, links?, picks?, primary? }`. It takes what `buildPrep` takes plus: LinkedIn affiliations,
  the dossier view, the latest posts, the mutual standings, the timeline and thread lines, open items, the chat and
  the event. It calls `buildPrep` for goal, ask, intro, questions, research, closing and follow-ups (nothing in
  `prep.ts` is rewritten) and decides which cards exist and in what order. Tests pin the copy, the empty states, the
  minimum deck, the opens-on-After rule and the no-dash rule.
- `apps/web/src/engine/hopEvidence.ts`: `latestPostsOf(memberId, n)` over `db.engagement` (posts the live reader
  stored; already there for the map).
- Nothing new on the server. Account mode reads the same local tables; the research function, the ledgers and the
  budgets are untouched.

### UI

- `apps/web/src/ui/Deck.tsx` (new): the shell. Props: cards (rendered by the caller), index, onIndex, onClose,
  title. Swipe, arrow keys, Enter for `[data-primary]`, dots and counter, focus trap, `prefers-reduced-motion`, a
  sheet on phones. `MorningBrief.tsx` moves onto it (its behaviour stays as its tests say).
- `apps/web/src/components/people/PrepDeck.tsx` (new): the ten card renderers over `buildPrepDeck`, with the pick
  logic, the suggested-names field and Log this chat. Opens on `?prep=1` on the person page; closing drops the param.
- `apps/web/src/components/people/PrepButton.tsx` (new): the button with the next chat's time, used in About and in
  the header.
- `Person.tsx`: the `prep` tab, `Prep` and `PrepResearch` go. The tab type becomes `'timeline' | 'facts' |
  'connections'`. `?tab=prep` (old links in stored suggestions, chat panels, bookmarks) maps to
  `?tab=facts&prep=1`, so nothing a student saved breaks.
- Links that pointed at the tab now open the deck: `chat/tools/pipeline.ts:188`, `chat/tools/people.ts:292`,
  `components/SuggestionCard.tsx:447` (Open prep), `chat/testing/fakeEngine.ts:541`, and the panel tests that use
  `/people/p4?tab=prep` as a sample route (they only test URL handling, so they keep working either way).

### Session state

- The card the student was on, per person: `sessionStorage` key `prep:<personId>` like the morning brief's pill.
  Losing it only loses the position.
- Picked questions stay on `CoffeeChat.prepQuestions`. No schema change, no Dexie version bump.

## Tests and gates

- Unit: `prepDeck.test.ts` (builder), `Deck.test.tsx` (keys, swipe threshold, dots, reduced motion), `PrepDeck`
  component test (opens on After when completed, picks cap at three, Log this chat), `MorningBrief` tests unchanged.
- e2e (`orbit.spec.ts`): the two Prep tests become: About shows the Prep button; the deck opens, has the cover,
  "Questions" and the closing line; arrow keys and swipe move it; a pick persists across reopen; the suggested-names
  rules on the After card; `?tab=prep` opens the deck. `chat-sim` "prep me for my next chat" expects the deck link.
- The usual: `pnpm lint`, `pnpm typecheck`, core and web tests, `pnpm build`, then the Person and Prep e2e, with exit
  codes checked. Phone widths in the e2e (375 and 390) since the deck is for phones first.

## Order of work

1. `Deck.tsx` out of `MorningBrief.tsx`; the brief's tests still pass.
2. `buildPrepDeck` and its tests (the copy is settled here, before any UI).
3. `PrepDeck.tsx`, `PrepButton.tsx`, wired into About and the header; `?prep=1`.
4. Remove the tab; redirect `?tab=prep`; repoint the chat tools and Today's card.
5. e2e, then a pass on a phone width with screenshots.

About a day. Ten files touched, four new.

## Decisions to take before building

1. The After the call card lives in the deck (my pick: one place for the call, before and after) or stays a card on
   About.
2. The header button shows for 24 hours before a scheduled chat (my pick) or always.
3. Lately reads their latest LinkedIn posts from the engagement rows the map already fetches (my pick, no new reads)
   or asks the connector for posts when the deck opens (one more read per open against the daily ledger).

## What building it changed

- **The deck shell is shared mechanics, not one component.** The morning brief has a minimize-to-pill mode and its
  own footer, so `ui/Deck.tsx` exports the pieces both decks use (`useDeckKeys`, `useDeckFocus`, `useDeckSwipe`,
  `DeckLayer`, `DeckProgress`) and each deck draws its own header and footer. The morning brief's behaviour and tests
  are unchanged.
- **The layer renders into `document.body`.** Drawn inside the person page, a transformed ancestor pinned the fixed
  layer to the page instead of the screen (cut off on a laptop, off screen on a phone).
- **The deck remembers its card by kind, not by number.** Cards arrive after the first draw (the mutuals, a fact
  saved from After the call adds Where you left off), so a stored index moved the student to another card and
  remounted the card they were typing in.
- **Role dates are one helper** (`engine/roleDates.ts`), shared with About's LinkedIn history, so the two never
  disagree.
- **Old links still work.** `?tab=prep` opens About with the deck; every in-app link now points at
  `?tab=facts&prep=1`.
