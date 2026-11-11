# 42. A card's button does its work beside the chat

The problem: tapping "Write to Zain", "Ask Arnav for an intro" or "Find warm routes" on a card sent that sentence as
the student's next message, and the answer came as another turn under it. To see the draft, the student scrolled
down; the thread filled with requests they never typed.

## What happens now

A button runs its tool at once and opens the result beside the chat, in the side panel the chat already has. The
thread gets no new message and no new turn.

- The result is the same card the chat would draw (`/result/<action id>`, `chat/panel/ResultPanel.tsx`), flat inside
  the panel, with every button on it working: a draft can be edited and sent from there, through the same approval.
- A button on that card opens its result in the same panel, and Back returns to the card before it.
- The button reads as done ("Draft to Zain", with "Open"): tapping it again opens the same card instead of writing a
  second draft.
- The run is recorded on the card's conversation (as plan 37 §4 built for "Add to targets"): a reload shows the button
  done, a refresh keeps the panel's card, and the next turn tells the model what the student did.
- A page outside the chat, with no panel to show the result in, sends the message as before.

## The audit

| Button | Where | Now |
|---|---|---|
| Write to X, Thank X, Follow up with X (every kind) | person, people, pipeline, routes, company, note cards; people tiles | draft in the panel (`create_draft`) |
| Draft a message to all N, Follow up with the quiet ones | people, company, pipeline cards; picked people | drafts in the panel (`create_drafts`) |
| Ask X for an intro | routes card rows and steps, routes to several people, mutuals | intro ask in the panel (`create_draft`, intro_request) |
| Find a warm intro, Find warm routes | person card, picked people | routes in the panel (`find_routes`) |
| Add and find routes, Add and write to them | picked people found in a search | added, then routes or drafts in the panel (`add_sourced` with `next`) |
| Warm up first, Write now | the warm-up question for a LinkedIn-only stranger | in the panel (`create_draft` with `warmUp`) |
| Prep for the chat, Review the thank-you | person, pipeline, note cards | the person's page in the panel (prep deck, the draft open) |
| Add to targets, Add to People, Show again | company, found people, a hidden person | in place, as before (plan 37 §4) |
| A choice the model offered, an answer to a question back | choices, clarify cards | still a message: the student is answering in words |

A button the card can only name by name (no id for the person) keeps sending the message, so nothing is lost.

## The intro ask

The note the introducer can forward used to sit in a second box under the ask, sent as a separate add-on. It is now
inside the one message ("here's a short note you could forward:" and the note in quotes), so the box the student edits
is exactly what goes out. A LinkedIn connection note (300 characters) goes as the ask alone.
