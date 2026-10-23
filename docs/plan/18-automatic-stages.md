# 18. Automatic stages: cards that move when something happens

Status: built (2026-10-23), local (browser) mode. Amends 05 §6 (stage machine), 14 §1 (when the engine runs) and 17 B (LinkedIn replies). Account mode keeps its server readers; the rules in §3 and §4 run there too, from the same code.

The complaint this answers, from students on the board: a reply arrives, a time is agreed, a meeting is booked, the meeting passes, a thank-you goes out, and the card sits where it was, or moves much later. The stage machine already knew every one of these moves. What was missing was anyone asking it in time.

---

## 1. What happened before (audit, 2026-10-23)

| Event | Reader | How it reached the board |
|---|---|---|
| Reply by email | `ingestEmails` (engine/ingest.ts), from `syncGoogle` | Only when a Google sync ran: on connect, on Settings "Sync now", or from the chat. Nothing ran on its own, ever. A reply could sit unread for days. |
| Reply on LinkedIn | `syncLinkedInReplies` (engine/linkedinInbox.ts) | Once when the app opened, and only if the last read was more than 15 minutes old. Never again while the app stayed open. A first reply was only proposed unless Orbit itself had sent the outreach on LinkedIn, so a message the student sent by hand on LinkedIn left the answer as a question card. |
| Text back | `importTexts` (engine/imessage.ts) | Only when the student imports Messages again. Proposes (0.7). Unchanged by this plan: the import is a file the student brings. |
| Time agreed by email | `ingestEmails` | Same as a reply by email. |
| Meeting booked on the calendar | `ingestEvents`, from `syncGoogle` | Same: only when a sync ran. |
| Meeting booked through Orbit, or typed in | `scheduleChatAt` (engine/move.ts) | At once. Fine. |
| Meeting passed | `ingestEvents` when a sync ran; otherwise `runTimedStageRules`, and only for events typed in or when Google was not connected | With Google connected, a passed meeting moved the card only at the next sync, which nobody ran. The timed rules ran once a day, when the first brief of the day was built. |
| Thank-you sent from Orbit | `finalizeSent` (engine/send.ts) | At once. Fine. |
| Thank-you sent from the mail app | `ingestEmails` | Only when a sync ran. |
| Two weeks after the thank-you | `runTimedStageRules` | Once a day, at the first open. |
| Silence after the bumps | `runTimedStageRules` | Once a day, at the first open. |

Two things follow. The readers were right; the cadence was wrong. And the one timed rule that depended on the calendar sync (a meeting over) never fired for a connected student, because the sync it waited on never ran by itself.

## 2. The transitions and what triggers each

Stages, in board order: To contact (`identified`), Warming up (`warming`), First message sent (`outreach_sent`), Replied (`replied`), Scheduling (`scheduling`), Scheduled (`scheduled`), Completed (`completed`), Thanked (`followed_up`), Staying in touch (`nurturing`). The machine is `decideTransition` in `packages/core/src/pipeline/transitions.ts`; every move is applied by `applyStage` in `apps/web/src/engine/stages.ts` and recorded as a stage event with the actor, the reason, the confidence and the evidence row.

| From | To | Trigger | Reason recorded | Reader |
|---|---|---|---|---|
| To contact, Warming up | First message sent | the outreach went out: Orbit sent it, or the student's own message was read in Gmail or LinkedIn | `outbound:outreach` | send, Gmail, LinkedIn |
| First message sent | Replied | a message from them after the ask went out, read with confidence 0.8 or more; a decline is always proposed | `inbound_signal:<signal>` | Gmail, LinkedIn, (texts: proposed) |
| Replied, First message sent | Scheduling | a time proposed by either side | `inbound_signal:scheduling_proposal`, `outbound:schedule` | Gmail, LinkedIn, send |
| anything before it (not Warming up) | Scheduled | a calendar event with the person (0.9 when they have an open chat), a confirmed time, a time typed in | `calendar:event_scheduled`, `user:scheduled` | calendar, send, the board |
| Scheduled | Completed | the event ended, plus a quarter hour (`MEETING_OVER_AFTER_MS`), whichever calendar it came from; notes from the chat | `calendar:event_ended`, `note:ingested` | calendar, the timed rules, notes |
| Scheduled | Scheduling | the event was cancelled | `calendar:event_cancelled` | calendar |
| Completed | Thanked | the thank-you went out: from Orbit, from the mail app (any message after the meeting), or "I already did this" | `outbound:thank_you` | send, Gmail, the card |
| Thanked | Staying in touch | 14 days after the thank-you | `timer:followed_up_14d` | the timed rules |
| Completed | Staying in touch | 14 days after a chat with no thank-you on record | `timer:completed_14d` | the timed rules |
| First message sent | No response | the bumps are used up and ten business days pass, or fifteen business days of silence | `timer:no_response` | the timed rules |

A move Orbit is not sure of (under 0.8) is a confirmation card, never a silent change (rule 3). A move the student makes by hand wins over anything Orbit proposed before it.

One amendment to 17 B. A first reply on LinkedIn now moves the card by itself when Orbit knows the ask went out on LinkedIn: it sent the message, or it read the student's own message to that person in the same LinkedIn inbox before the reply came. A LinkedIn message answering an ask that went out some other way (by email) is still proposed, because it may be about anything.

## 3. The reply check (while the app is open)

`checkReplies` in `apps/web/src/engine/checkReplies.ts`, mounted as `ReplyWatch` in the app shell. One check does, in this order:

1. Gmail and the calendar, when Google is connected and signed in: `syncGoogle` with `quiet: true`. Quiet means: only mail Orbit has not stored yet is downloaded (the list of the last day or two is compared with what is stored before anything is fetched), nothing is said when nothing new came in, and the heavier bookkeeping (style, edges, recommendations) is skipped when no message arrived. Syncs are serialised, so a check and a "Sync now" that overlap wait for each other.
2. LinkedIn messages, when LinkedIn is connected live in this browser: `syncLinkedInReplies`, from its checkpoint.
3. The timed rules (`runTimedStageRules`): a booked meeting that ended, the two-week timers, silence after the bumps.
4. For every chat moved in the check, the immediate suggestions, so the thank-you after a meeting is in Drafts the same minute.
5. The record of the check (`db.kv`, key `replies-check:<userId>`): when, which sources were read, what could not be read and why, how many chats moved.

When it runs:

- when the app opens (after setup), at once;
- every three minutes while the tab is visible (`CHECK_EVERY_MS`), never while hidden;
- when the window gets focus or the tab is shown again, if the last check is more than a minute old (`CHECK_ON_FOCUS_AFTER_MS`);
- on "Check now".

Checks that overlap share one run. Nothing runs when the app is closed: this is a timer in the open page, nothing more, as everything in local mode is (14 §1). The daily maintenance (the brief) still runs once a day at the first open; it runs the same rules.

What is read is bounded. Gmail: two list calls (sent, inbox) plus one calendar list every three minutes, far under the per-user quota, and message downloads only for new mail. LinkedIn: one proxy call every three minutes, read from Unipile's own synced copy, so LinkedIn itself is not touched. The Google sign-in lasts an hour, or until the tab closes; after that Gmail cannot be read until the student signs in again, and the line says so (§5).

Account mode: the server reads Gmail and LinkedIn for an Orbit account, and pulls deliver the results; the browser check reads nothing for such an account and only runs the rules. The sample student has nothing to read either (mock connectors); the check still runs the rules and shows its line, so the demo shows the feature.

## 4. What is idempotent, and why a check never double-moves

- `applyStage` refuses a move to the stage the chat is already in, and refuses any move the machine does not allow. A proposed move is recorded once per target stage.
- Gmail messages are keyed by Gmail's message id; a message already stored is skipped before it is even downloaded.
- Calendar events are keyed by the event id and written in place; the chat keeps its `scheduledEventId`.
- LinkedIn replies are compared with the chat's `lastInboundAt`; only newer messages count, and the checkpoint moves only when a read reached the end.
- The timed rules decide from dates alone, so running them twice decides the same thing, and the second decision is a refused move.
- Every move is a stage event with its evidence, so "why did this card move" is always answerable from the chat's history.

The tests in `apps/web/src/engine/checkReplies.test.ts` run every check twice and count the applied stage events.

## 5. What the student sees

- Under the board's title, and under Drafts' title: "Checked for replies 2 min ago · Check now" (`RepliesChecked`). While a check runs: "Checking for replies…". When a source could not be read: "Checked for replies 5 min ago · Gmail is signed out · Fix · Check now", with Fix leading to Settings.
- With nothing connected (no Google, no live LinkedIn, not the demo) the board keeps its older line: "Orbit cannot see your inbox: move a card when someone replies."
- Cards move live: the board reads Dexie live queries, so a move lands in its column the moment the stage event is written, with the same pop-in as a drag.
- A reply within the last three days still raises the "X replied" notification; a meeting over puts the thank-you card in Drafts and the badge counts it.

## 6. Files

- `apps/web/src/engine/checkReplies.ts` (new): the check, its record, the focus gate, the "2 min ago" words.
- `apps/web/src/components/ReplyWatch.tsx` (new): the timer, focus and visibility listeners.
- `apps/web/src/components/RepliesChecked.tsx` (new): the line.
- `apps/web/src/engine/sync.ts`: serialised, quiet runs, download only new mail.
- `apps/web/src/engine/stages.ts`: a booked meeting that ended completes the chat whichever calendar it came from; `MEETING_OVER_AFTER_MS`.
- `apps/web/src/engine/linkedinInbox.ts`: the 17 B amendment; the one-off reader on open is gone, the check replaced it.
- `apps/web/src/components/LinkedInAutoSync.tsx`, `AppShell.tsx`, `pages/People.tsx`, `pages/Inbox.tsx`: wiring and the line.
- Tests: `packages/core/src/__tests__/auto-stages.test.ts`, `apps/web/src/engine/checkReplies.test.ts`, `apps/web/src/engine/linkedinInbox.test.ts`, `apps/web/e2e/auto-stages.spec.ts`.

## 7. Not in this plan

- Texts still arrive by import; there is no background read of Messages in a browser.
- The Google sign-in cannot be renewed without the student: when it expires the line says so instead of popping a window.
- Push notifications or anything that runs with the app closed: local mode has no server to run them; account mode's server readers (16 §8) are that answer.
