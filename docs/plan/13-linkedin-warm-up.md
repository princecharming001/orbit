# 13. LinkedIn warm-up (engage before you message)

Status: build specification, shipped in the static v1 except where marked *hosted only* (the cancel action in §5 and the metric in §7). Adds a `warming` stage and a `warm_up_engage` suggestion kind to the pipeline and brief. Amends 01 §5.2, 03 §2, 05 §6 and 07 §1. What the student writes during and after a warm-up follows the outreach playbook, 15 §2.3 (warm outreach) and §2.13 (comments on a post).

---

## 1. Why

Cold LinkedIn messages from a stranger get ignored. The same message after the recipient has seen the student's name two or three times (a profile view, a reaction, one thoughtful comment on a recent post) reads as "that student who's been following my work" and gets a materially higher reply rate. Orbit turns this into a short, tracked plan instead of leaving it to chance.

## 2. Feasibility and stance

- **No automation touches LinkedIn.** Every warm-up action is performed by the student in their own browser through a deep link. Orbit schedules, reminds, tracks and only then suggests the message. This keeps the student's account out of LinkedIn's automation enforcement and keeps Orbit off the scraping path. [DECIDED]
- Deep links used: profile `https://www.linkedin.com/in/<slug>/`, activity `https://www.linkedin.com/in/<slug>/recent-activity/all/`, compose `https://www.linkedin.com/messaging/compose/?recipient=<slug>`.
- A later hosted version could automate reactions through a session-based vendor behind the `linkedin_messaging` flag (04 §3.4), with the same caps. It is deliberately not built.

## 3. When a warm-up starts

`startWarmUpOrOutreach` creates the chat in `warming` instead of `identified` when all of: the channel is LinkedIn (no email on file), the person's closeness is under 0.2, the person has a LinkedIn slug, and the setting `warmUpEnabled` is on (default on; `warmUpDays` default 4, range 2–10). Otherwise the chat starts in `identified` with an outreach draft as before.

## 4. The plan

```
day 0                 view_profile   "View their profile and follow them"
day max(1, ⌊n/2⌋)     react_post     "React to one recent post that you genuinely find useful"
day max(2, n−1)       comment_post   "Leave one specific, non-flattering comment (a question or an added point)"
ready  day n, 09:00   outreach suggested once ready AND at least one action is done; or earlier once every action is done or skipped
```
`n` is `warmUpDays`; days are calendar days from the start and each action is due at 10:00 local (`buildWarmUpPlan` in `packages/core/src/warmup/rules.ts`). For the allowed range 2–10 the `max` guards never change the schedule; they only keep the three actions on separate days. Stored on `coffee_chats.warmUp` (`WarmUpPlan`: `startedAt`, `readyAt`, `actions[] {id, kind, label, url, dueAt, doneAt?, skippedAt?, note?}`).

## 5. Suggestions and brief

- `warm_up_engage`: one card for the next pending action, with **Open on LinkedIn**, **Done**, **Skip this one**; urgency 0.55 (0.65 when overdue by a day). At most two per brief. The card asks what the post said; for the comment step it drafts a question or an added point from that claim (`draftWarmUpComment`, 15 §2.13) and never offers praise. Marking done stores what the student engaged with on the action (`note`) and writes a `linkedin_engaged` touchpoint (weight 0.15) and a `warmup_done` feedback event; skipping writes `warmup_skip`.
- When the plan is ready, the rule emits `new_outreach` with `signals.warmUpDone`, which the selector treats as hard-urgent so it is never crowded out by generic recommendations. The outreach draft may open with the post ("Read your post on {note}.") only when at least one action is done and the student recorded what the post was about, and only when no stronger connection (a referrer, an event, a shared school) exists; with no note it says nothing about LinkedIn, so the message never claims engagement that did not happen (15 §2.3).
- Stage: `warming → outreach_sent` on send; `warming → replied` if they write first. *Hosted only:* `warming → identified` when the user cancels the plan. The transition is allowed by the stage machine, but the static build has no cancel action; the student can move the chat by hand in the pipeline table, which leaves the plan stored on the chat.

## 6. UI

Pipeline board shows a `Warming up` column with a progress bar per card; the profile shows the plan with checkmarks and the activity link; Discover labels cold LinkedIn-only candidates "Warm-up first" and the button reads "Start warm-up". Settings → Sending limits holds the toggle and length.

## 7. Metrics

*Hosted only.* Reply rate of outreach preceded by a completed warm-up vs. cold outreach on the same channel (PostHog event `message_sent` carries `warmed: boolean`, 11 §5), and warm-up completion rate per action kind. The static build sends no analytics (14 §1); the raw material is local (`warmup_done`/`warmup_skip` feedback events and the `linkedin_engaged` touchpoints) and leaves the browser only in the user's own export.
