# 13. LinkedIn warm-up (engage before you message)

Status: build specification, shipped in the static v1 except where marked *hosted only* (the metric in §7). §8 adds the automated run for Orbit accounts, which replaces the stance of §2 there: the local copy keeps §2 to §6 as written. Adds a `warming` stage and a `warm_up_engage` suggestion kind to the pipeline and brief. Amends 01 §5.2, 03 §2, 05 §6 and 07 §1. What the student writes during and after a warm-up follows the outreach playbook, 15 §2.3 (warm outreach) and §2.13 (comments on a post).

---

## 1. Why

Cold LinkedIn messages from a stranger get ignored. The same message after the recipient has seen the student's name two or three times (a profile view, a reaction, one thoughtful comment on a recent post) reads as "that student who's been following my work" and gets a materially higher reply rate. Orbit turns this into a short, tracked plan instead of leaving it to chance.

## 2. Feasibility and stance

- **In the local copy and the demo, no automation touches LinkedIn.** Every warm-up action is performed by the student in their own browser through a deep link. Orbit schedules, reminds, tracks and only then suggests the message. [DECIDED] **With an Orbit account and the student's own LinkedIn connected, Orbit runs the steps itself (§8)**, inside daily caps, after the student approves the plan and the exact comment. [DECIDED, superseding the line below]
- Deep links used: profile `https://www.linkedin.com/in/<slug>/`, activity `https://www.linkedin.com/in/<slug>/recent-activity/all/`, compose `https://www.linkedin.com/messaging/compose/?recipient=<slug>`.
- ~~A later hosted version could automate reactions through a session-based vendor. It is deliberately not built.~~ Built: §8.

## 3. When a warm-up starts

`startWarmUpOrOutreach` creates the chat in `warming` instead of `identified` when all of: the channel is LinkedIn (no email on file), the person's closeness is under 0.2, the person has a LinkedIn slug, the person is not at an organisation the student is in now (their own club or current job on the resume, `sharesOrgNow`: someone they see is not warmed up to), and the setting `warmUpEnabled` is on (default on; `warmUpDays` default 4, range 2–10). Otherwise the chat starts in `identified` with an outreach draft as before.

## 4. The plan

```
day 0                 view_profile   "Look at their profile and what they post about" due when the plan starts, or 10:00 that day if earlier
day max(1, ⌊n/2⌋)     react_post     "React to one recent post that you genuinely find useful"   10:00 (no later than the comment)
day max(1, n−1)       comment_post   "Leave one substantive comment: a question or an added point, not praise"   10:00 (day 1 when n = 2)
ready  day n, 09:00   outreach suggested once ready AND at least one action is done; once every action is resolved
                      with at least one done, from the start of day 2 (or day n if sooner), so the activity is never
                      one ten-minute burst; when every action is skipped, right away, worded as a choice
                      ("You skipped the warm-up. Message Dana without it?")
```
`n` is `warmUpDays`, clamped to 2..10. Days after day 0 are working days: no step is due on a Saturday or a Sunday, so a warm-up started on a Friday reacts on Tuesday and is ready on Thursday (n = 4). Days and hours are in the student's timezone (`user.timezone`), and every action is due before the ready date, so a plan started in the afternoon is never born overdue (`buildWarmUpPlan` in `packages/core/src/warmup/rules.ts`). Stored on `coffee_chats.warmUp` (`WarmUpPlan`: `startedAt`, `readyAt`, `actions[] {id, kind, label, url, dueAt, doneAt?, skippedAt?, note?}`).

## 5. Suggestions and brief

- `warm_up_engage`: one card for the next pending action, shown from that action's day in the student's timezone (`warmUpStepDue`), so marking a step done does not put the next one on screen the same day; the toast says when it comes, with **Open on LinkedIn**, **Done**, **Skip this one**; urgency 0.55 (0.65 when overdue by a day). At most two per brief. The card asks what the post said; for the comment step it drafts a question or an added point from that claim (`draftWarmUpComment`, 15 §2.13) and never offers praise. Marking done stores what the student engaged with on the action (`note`) and writes a `linkedin_engaged` touchpoint (weight 0.15, deduplicated per action) and a `warmup_done` feedback event; marking an action that is already done again changes nothing; skipping writes `warmup_skip`.
- When the plan is ready, the rule emits `new_outreach` with `signals.warmUpDone`, which the selector treats as hard-urgent so it is never crowded out by generic recommendations. The outreach draft may open with the post ("Read your post on {note}.") only when at least one action is done and the student recorded what the post was about, and only when no stronger connection (a referrer, an event, a shared school) exists; with no note it says nothing about LinkedIn, so the message never claims engagement that did not happen (15 §2.3).
- Stage: `warming → outreach_sent` on send; `warming → replied` if they write first. `warming → identified` when the student stops the warm-up (**Stop** on the person's page and under Coming up on Drafts); the plan stays stored on the chat.

## 6. UI

Pipeline board shows a `Warming up` column with a progress bar per card; the profile shows the plan with checkmarks and the activity link; Discover explains for cold LinkedIn-only candidates why a warm-up comes first and the button reads "Start warm-up" (the student stays on the list; a toast links to the step on Today). A first-message card on Today for the same kind of person (from a recommendation, no chat yet) follows the same rule: its primary button is "Start warm-up", with "Write now instead" beside it. Settings → Limits and schedule holds the toggle and the length in working days. A warm-up whose next step's day has passed moves the steps left (and the first-message date) forward to today, keeping their spacing (`replanWarmUp`).

## 7. Metrics

*Hosted only.* Reply rate of outreach preceded by a completed warm-up vs. cold outreach on the same channel (PostHog event `message_sent` carries `warmed: boolean`, 11 §5), and warm-up completion rate per action kind. The static build sends no analytics (14 §1); the raw material is local (`warmup_done`/`warmup_skip` feedback events and the `linkedin_engaged` touchpoints) and leaves the browser only in the user's own export.

## 8. The automated run (Orbit accounts)

The student asked: "once you start the warm-up sequence, it just does the warm-up for you and lets you know when you're done." With an Orbit account and their own LinkedIn connected (Unipile), that is what happens. The setting **Run warm-ups for me** (Settings, Limits and schedule; on by default, stored as `users.settings.warmup_auto = false` only when off) turns it off and brings back §3 to §6.

### 8.1 Start: the exact words, approved once

1. The student starts a warm-up anywhere one starts today. Instead of starting at once, the **start sheet** opens (`WarmUpStartSheet`).
2. `POST /warmups/preview` reads the person's recent posts once through the student's own LinkedIn account (their profile first, quietly, when Orbit does not know LinkedIn's id for them), picks the one to engage with, and drafts the comment with the light model: one or two sentences about that post, a question or an added point, no praise, no ask, in the student's voice. Kept as a preview row for six hours, so opening the sheet twice reads LinkedIn once.
3. The sheet says the whole plan in plain words ("Today: view Priya's profile. Wednesday: like their post: … Thursday: comment on that post.") with the comment in a box the student can edit, a switch to leave the comment out, and one **Start** button.
4. `POST /warmups/start {warmupId, comment}` stores the text exactly as it was in the box and schedules the steps. **After Start nothing is asked and no words are written or changed**: the privacy policy promises nothing is posted without approval of the exact words, and a trigger on `orbit.warmups` refuses any later change to the comment, its post or its account.
5. No recent post of their own (reposts, posts older than 45 days and one-liners do not count): the warm-up is the profile view only, and the sheet says so.

### 8.2 Run

`orbit.enqueue_warmup_steps` (cron `orbit-warmup`, every five minutes) queues one `warmup.step` job per step whose time has come. The schedule is `autoWarmUpSchedule` (`packages/core/src/warmup/auto.ts`): the same days as §4 counted from the day of the profile view, except that no two steps share a day; working days only (no weekends, no US holidays), a random minute between 9:00 and 17:00 in the student's time zone; the profile view a few minutes after Start when Start is inside working hours.

| Step | What Orbit does | Unipile call |
|---|---|---|
| `view_profile` | a visit the person can see | `GET /api/v1/users/{id}?account_id=&notify=true` |
| `react_post` | a like on the chosen post | `POST /api/v1/posts/reaction` `{account_id, post_id, reaction_type: "like"}` |
| `comment_post` | the approved comment | `POST /api/v1/posts/{post_id}/comments` (form: `account_id`, `text`) |

Each step is recorded with when it ran and what happened (`orbit.warmup_steps.result.tries`). A step that fails is tried once more 45 to 120 minutes later the same day (the next working day when the day is nearly over), then skipped with a note; the run still finishes. A comment whose first try got no answer is looked for on the post before the second try, and never posted twice. A like LinkedIn says was already there counts as done.

### 8.3 Caps (`WARMUP_AUTO_CAPS`, the one place they are set)

Per student, per day in their time zone: **15 profile views, 10 likes, 4 comments**; any two automated actions **at least 90 seconds apart** plus up to 90 seconds at random; **one action per person per day**. Over a cap the step waits for the next working day. `orbit.warmup_take` counts under a lock, so two jobs at once cannot both pass. A warm-up view also counts toward the day's 40 profile views across Orbit (`budget.ts`), every read aimed at a person asks the swarm limit first (plan 41, `linkedinTargets.ts`), and the owner's `unipile_reads` switch stops all of it. Every call is counted in `orbit.linkedin_calls_daily` under caller `warmup`.

### 8.4 What stops it

- The student: **Stop** on the person's page and on Drafts (Coming up). The chat goes back to To contact.
- By itself (`orbit.warmup_stop_reason`, checked before every step and by the five-minute tick): the person wrote; the student wrote to them or queued a message; they became a connection; do not contact, hidden, merged or deleted; LinkedIn disconnected, parked, needing a new sign-in, or a different account than the one the run started with; the setting turned off (at once).
- The post was deleted: the like and the comment are skipped, the run goes on.
- When Orbit stops a run for a LinkedIn or settings reason, the steps it never reached go back to the student as the manual steps of §4.

Not detected on its own: a connection request the person sends the student. Orbit does not read received invitations; it shows up once accepted (a connection) or as a message.

### 8.5 Done

When the last step has run the run is `done`: the person shows **Warmed up**, the student is told once (one notification row written by the one update that sets `notified_at`; one toast, kept once across devices by `told_at`), and the first message is offered on Drafts at once ("Orbit finished the warm-up; ready to message Priya"), with the post's topic as its opener when there is one. The sequence never sends a message or a connection request.

### 8.6 Safety

Only the student's own row in `orbit.integration_accounts` (provider `linkedin`, status `active`) is ever acted through, and only while its Unipile id is the one the preview read with. No other Unipile account or webhook is listed, read or changed (the key is shared with another product). Nothing runs at night, at weekends, with the setting off, or without LinkedIn active.

### 8.7 The local copy and the demo

The local copy has no server: §3 to §6 unchanged. The demo keeps the manual flow until the sample LinkedIn is connected; then it simulates the run in the browser with the mock connector's posts (`tickDemoWarmUps`), so the feature can be tried. Nothing leaves the browser.

### 8.8 Data

`supabase/migrations/20261212_orbit_warmup_auto.sql`: `orbit.warmups` (the person, the post, the comment as drafted and as approved, the account, the state), `orbit.warmup_steps` (time, state, tries, result), `orbit.warmup_actions` (the daily counts). The browser receives each run with its steps through `/sync/pull` (`warmups`) and mirrors it onto the chat's `warmUp` plan (`planFromRun`), so the pipeline, the cards and the first message read it as they read a manual warm-up.
