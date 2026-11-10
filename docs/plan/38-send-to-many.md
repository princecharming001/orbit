# Plan 38: send to many, replies on autopilot, and the calls it books

The three ways students will use Orbit most: writing to a lot of recruiters at once, letting Orbit answer the easy
replies, and seeing the calls that come out of it. Today each is possible only in pieces, and the pieces fight the
student. This plan puts them in one flow.

## What a student wants, from their side

A junior recruiting for PM internships has 40 recruiters across 12 target companies. What they want:

1. **Pick everyone at once.** "These 40 people", from People (with a filter like Recruiters, or a company), from a
   company page, or from the chat ("email recruiters at my targets"). Today: no multi-select anywhere, the chat drafts
   at most 10, and the drafts card has no way to act on all of them.
2. **One message, fitted to each.** Either Orbit writes each one, or the student writes their own once ("Hi {first},
   I'm a junior at Cornell…") and Orbit fills in each person. Then a quick read down the list, fixing the two that
   need it. Today: each draft is opened, read and approved one at a time.
3. **Send them without getting flagged, without thinking about it.** The student does not know Gmail's limits, how
   spam filters read bursts of near-identical mail, or that three recruiters at one company compare notes. They want
   to press one button and trust the pace. Today: approving the 16th email of the day is *refused* ("Daily limit
   reached"), so the student is left to come back tomorrow and remember where they were; the only spreading tool is a
   chat command; autopilot's window (Tue to Thu, 8:00 to 10:30) fits about four emails a day, so 40 would take a month.
4. **See what is going out and when.** A queue by day: "Tue 6, Wed 6, Thu 6", with Send now, Move to tomorrow, Cancel
   and Cancel the rest. Today: Scheduled shows only autopilot's own rows (an account's scheduled emails show nowhere),
   has no days, and says "weekdays between 9 and 5", which is not what happens.
5. **Replies handled.** When a recruiter says "sure, how's Thursday?", Orbit offers times or books the call and says
   thanks, and the student only sees what needs them. Today that needs full Autopilot mode (which also starts writing
   first messages on its own), and a cold recruiter's score (under 40) blocks the automatic reply anyway.
6. **See the calls.** "What does my week look like?" A week of calls at a glance, and how the outreach turned into
   them: sent, replied, booked. Today: the Chats page is behind a flag and is a plain list.

## The design

### A. Pick many (People, company page, chat)

- **People list: Select.** A Select button puts a checkbox on each row and a header checkbox for every row shown (so a
  filter like Recruiters, or a search for a company, then select all, is how a student picks "all recruiters at my
  targets"). A bar slides up from the bottom: "12 selected · Write to them · Clear".
- **Company page:** "Write to all N" on the people list header, for the team chip shown (Recruiting, Product…).
- **Chat:** the drafts card gets "Review and schedule all", which opens the same page with those drafts.

All three open **Send to many** (`/send?people=…` or `/send?drafts=…`).

### B. Send to many (`/send`)

One page, top to bottom, the whole job:

1. **Who.** Each person once: photo, name, title and company, and whether Orbit can email them. Rows that cannot go
   say why in plain words and step aside: no email address (LinkedIn by hand, from their page), they asked not to be contacted, you
   wrote to them recently, LinkedIn only (sent by hand, never scheduled). Remove anyone with ×.
2. **The message.** Two ways, as tiles:
   - *Orbit writes each one* (default): each person's draft, written for them, arriving one by one ("Writing 4 of 12").
   - *Write your own*: one subject and body with `{first}`, `{company}`, `{title}`, `{school}` chips to insert; Orbit
     fills them per person, live.
   Under it, every message as a row: who, subject, first line; open a row to edit that one. A row with a gap
   (`[ASK USER]`, an empty `{company}`) is marked "Needs a line" and is not sent until it has one. When messages read
   nearly the same, a note says so and why it matters.
3. **When they go: the pace.** Three tiles, the safe one chosen:
   - *Steady* (recommended): up to 8 a day, weekdays, 8 to 11:30 and 1 to 4 in each person's time.
   - *Faster*: up to the daily email limit (15, or the student's own lower one), the same hours.
   - *Gentle*: up to 4 a day, Tuesday to Thursday mornings, the classic window.
   Always on, said once: a random 6 to 20 minutes between emails; never two people at one company on the same day; the
   day's limit counts what is already scheduled; the student's local mode note when the browser has to stay open.
   A **preview** shows the plan as days: "Tue 12 · 6 emails, 8:14 to 11:02", with a bar against the day's limit, and
   the last day. Start: the next good time, or a date.
4. **When they reply.** One switch: *Answer simple replies for me* (offer times or book the call, say thanks), with a
   line on what never goes on its own. Every reply cancels anything else queued to that person (already true).
5. **Schedule N emails.** One button. Each message is approved as written (the hash binds the words) at its planned
   time. The page then says what happened ("12 scheduled, first one Tue 8:14 am to Priya") and links to the queue.

The batch is remembered (name, people, drafts) so the queue can show its progress: "Recruiters, Nov 12: 4 sent, 1
replied, 7 to go".

### C. The queue (Drafts, Scheduled)

- Everything scheduled, whoever scheduled it: autopilot's rows, the student's, and an account's server-held emails.
- Grouped by day, with the count against the day's limit. The next one first, in words: "Next: Priya Shah, Tue 8:14 am".
- Per row: Send now, Move to the next day, Cancel. Per batch: its progress and Cancel the rest.
- The copy says what really happens.

### D. A limit is a later time, not a no

Approving a message past the day's limit, or inside the cooldown, offers the next time it can go ("Send Wed 8:20 am
instead") instead of refusing. The engine's daily count is fixed to count the day the message goes (it counted every
later day too), and an account's server-scheduled rows count.

### E. Replies on autopilot

A setting, *Answer simple replies for me*, separate from Autopilot mode: Orbit answers scheduling replies (offers the
student's free times, books the one they pick), thank-yous, and an interested reply without a question, in a thread the
student started. Everything else waits under Needs you. On the server it lets `approveIfAllowed` act at level 2 for
replies only, and a cold recipient's low score does not block a reply to a thread the student started. In the browser
it hands over the ladder's reply kinds. Off by default, offered in the Send to many page and in Settings, Autopilot.

### F. The calls

The Chats page is on for everyone, and opens on **this week**: seven columns, each call a block (time, face, name,
company logo), today marked, arrows to the next and previous week. Above it, the outreach in three numbers for the last
30 days: sent, replied, calls booked. The list (Just happened, the days, No time yet) stays under it.

### G. A funnel per group

Groups are written to differently, and they are walked to the next step differently: recruiters to a booking link,
alumni to a resume, founders to three times. Each batch keeps its own funnel (users.settings.reply_funnels, the
server's person ids):

- **If they are interested:** offer three times from the calendar (the default), send the booking link with a short
  reply (the student can change the words), or the student's own reply for this group. `{first}`, `{company}` and
  `{link}` are filled in; the sign-off is the student's first name.
- **If they do not answer:** the one follow-up Orbit drafts says the group's words, when the student wrote some.
- A scheduling reply still books the slot they picked, and a question still waits for the student, in every group.

On the server `approveIfAllowed` puts the group's words in an interested reply's draft (and drops the offered slots
when it is the booking link), and `cadenceLadder` puts them in a follow-up. In the browser the same words replace the
draft `draftMessage` writes for a reply to an interested message or a follow-up.

## Rules kept

- LinkedIn is never scheduled or sent without a tap. LinkedIn-only people in a batch are listed for sending by hand.
- Autopilot still never writes a first message to a recruiter on its own; a batch is the student's own approval of
  each message, at a time the student chose.
- The caps (15 emails a day by hand) are the ceiling of every pace. No em dashes or exclamation marks in any text.

## Done when

- A student can pick 40 people, review 40 messages, and schedule them in under two minutes, with no message refused
  and none two at a company on a day.
- The queue shows every scheduled email, by day, for local and account mode, with Send now, Move, Cancel.
- Unit tests: the batch planner (paces, hours, company spacing, the day limit with what is already queued, time zones,
  weekends and holidays), the template fill, the similarity note, the day count fix, the later-time offer, the reply
  switch on the server. Component tests for the page. End to end: People select, Send to many, the queue, a move and a
  cancel, the calls week, in the demo and on the fake account.

## What shipped (2026-11-10)

- `engine/batchTime.ts` (the paces, the hours, one company a day, the day's limit with what is queued), `batchText.ts`
  (the template fill, the near-twin check), `batch.ts` (who can go, the draft per person on the server for an
  account, the plan, the schedule, the progress), `queue.ts` (Send now, Next day, Cancel), `funnels.ts`, `callsWeek.ts`.
- `/send` (pages/SendMany.tsx), Select on People with a Recruiters filter, Write to all on a company, Review and
  schedule all on the chat's drafts card, the queue under Drafts, Scheduled (components/Queue.tsx), the reply switch
  in Settings, Autopilot, the week of calls on Chats (components/chats/WeekCalendar.tsx).
- `checkSendAllowed` counts the day a message goes (it counted every later day too) and an account's held email, and
  its "not today" and "not yet" refusals carry a code; approving one offers "Send Wed 8:20 am instead".
- A batch the student planned keeps its spacing when it sends: autopilot's 25 minute gap applies to what Orbit
  approved itself only.
- Server: `/settings/profile` takes `autoReplies` and `replyFunnels`; `draftsOnItsOwn`, `approveIfAllowed` and
  `cadenceLadder` read them.
- Tests: batchTime (13), batchText (7), batch (12), core funnel (5), server group funnel (6) and the cadence follow-up,
  e2e send-many (5, demo and the fake account).
