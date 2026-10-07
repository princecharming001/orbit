# 07. Nurture engine and the morning brief

Status: build specification. Defines how suggestions are generated (triggers), scored, deduplicated, capped, drafted, assembled into a brief, delivered, acted on, and learned from. Implemented in `packages/core/src/suggestions` (rules and scoring), `packages/jobs/src/functions/brief` (orchestration) and `apps/web/src/app/(app)/today` (UI).

---

## 1. Suggestion kinds and triggers

Every rule runs in code over stored rows at brief time (and some on events, marked ⚡, so they appear on the Today page immediately). Each rule emits candidate suggestions with `signals` (the numbers it saw) and a `dedupe_key`.

| Kind | Trigger (all conditions) | Draft kind | Dedupe key window |
|---|---|---|---|
| `follow_up_bump` | chat `outreach_sent`; business days since the last outbound ≥ 5 for the first bump and ≥ 8 for the second (10 and 12 for LinkedIn copy-and-open); business days skip weekends, US federal holidays, the day after Thanksgiving and the Dec 20 to Jan 2 freeze, counted by calendar day in the student's timezone; no human inbound since (an out-of-office reply does not count as a reply: it sets `bump_not_before` to two business days after the return date it names, or five business days after the reply when it names none); `bump_count < max_bumps` (sector cap) | `bump` (`bumpNumber` 1 or 2) | `bump:{chat}:{bump_count+1}` |
| `thank_you` ⚡ | chat `completed` within 3 days of the meeting's real end (`completed_at` is the event end or the note's time, never the sync time); no outbound of any kind since completion | `thank_you` | `thank:{chat}` |
| `schedule_propose` ⚡ | chat `replied` with last inbound signal ∈ {reply_positive, question} and no scheduling message yet; or `scheduling` with the person's last message asking for times | `schedule` | `sched:{chat}:{last_inbound_id}` |
| `schedule_confirm` ⚡ | last inbound `scheduling_proposal` with ≥ 1 parsed time at least 2 h ahead that is free in the student's calendar; no event for the chat on the calendar yet. When every proposed time has passed or clashes, the rule emits `schedule_propose` instead (reason "X suggested ..., but that time has passed; propose new times", `payload.missedProposal`) | `reply` (accepting a specific time) | `confirm:{chat}:{last_inbound_id}` |
| `prep_brief` ⚡ | calendar event with a matched person starts within the next 30 h, or on tomorrow's date in the student's timezone, and has not started yet | — (payload = PrepBrief) | `prep:{event}` |
| `action_item_reminder` | open `action_items` due today or overdue, by calendar day in the student's timezone | — or `reply` when the item is "send X" | `ai:{action_item}` |
| `nurture_checkin` | chat `nurturing` (or `followed_up` for 14+ days); days since the last real conversation ≥ cadence (section 2); not contacted in the last 30 days; and either a hook or a non-intro offer from the last 90 days, or 14+ days past the cadence (then a plain "quick update" note whose draft asks the student for the update) | `nurture` | `nurture:{person}:{month}` |
| `nurture_checkin` (status news) | a target company's status changed to `applied`, `interviewing` or `offer` in the last 21 days (`status_changed_at`); one card per person at that company with a `followed_up|nurturing` chat (plus every mentor for an offer) who has not talked with the student since the change; `payload.update` carries the news ("I submitted my application to Stripe", "I'm now interviewing with Stripe", "I received an offer from Stripe, and I wanted to thank you for your help along the way") | `nurture` | `status:{target_company}:{status}:{person}` |
| `reconnect` | strength was ≥ 0.6 at any point and is now < 0.35; last touch > 60 days; person at a target company or alumni | `nurture` | `reconnect:{person}:{quarter}` |
| `congratulate` ⚡ | enrichment refresh shows a new current affiliation (org or title changed) within 30 days; strength ≥ 0.3 | `congratulate` | `congrats:{person}:{affiliation}` |
| `ask_referral` | chat `followed_up|nurturing`; person's org is a target company that is `applied`, or still `researching` with a referral offer on record or a deadline within 30 days (a referral helps before or with the application, not after); a referral offer or strength ≥ 0.5; not contacted in 30 days | `referral_ask` | `ref:{person}:{target_company}` |
| `intro_request` | created by Reach "Ask for intro" (user) or by a recommendation whose best path goes through a strong tie (≥ 0.5) and the target is at a priority-1 company | `intro_request` | `intro:{connector}:{target_key}` |
| `intro_request` (offered intro) | chat `followed_up|nurturing`; an offer fact to introduce the student ("happy to intro me to their PM lead") 7 to 60 days old; no chat referred by this person since; nothing sent to them in 5 days. The draft names the offer and includes a blurb they can forward | `intro_request` (`target.offered`) | `introfu:{offer_fact}` |
| `new_outreach` | weekly batch: top recommendations not yet acted on; limited by weekly target minus outreach already sent this week; skipped for a company where the student already has 2 live threads (`outreach_sent|replied|scheduling|scheduled`) | `outreach` | `new:{person}:{monday_of_week}` |
| `confirm_stage` ⚡ | `coffee_chat_stage_events.status = proposed` | — | `stage:{event}` |
| `confirm_merge` | `merge_suggestions.status = pending` and score ≥ 0.6 | — | `merge:{suggestion}` |
| `confirm_note_match` ⚡ | note `match_status = unmatched` with ≥ 1 candidate person | — | `note:{note}` |

Guard conditions applied to every message-bearing kind before it is kept: `check_send_allowed` would allow it now; the person is human and not hidden; the chat is not `declined`; no other pending message-bearing suggestion for the same person today (one per person per brief; reminders, prep cards and the hard-urgent kinds are exempt, so a promise due today is never dropped next to a thank-you); not snoozed (`snoozed_until > now`); the kind is enabled in `notification_prefs`.

Validity: a suggestion must be true when it is shown. Every pending or snoozed rule card is re-checked against its rule before a brief is built, on every ⚡ evaluation for its chat, and when Today opens. A card whose rule no longer fires (the chat changed stage, the proposed time passed, a newer reply arrived, the bump went out, the action item was closed) gets `status = expired` with `expired_reason` and its untouched draft is cancelled. When a chat changes stage, older `proposed` stage events for it are rejected as `superseded:{stage}` and their confirm cards retired; confirming a proposal the chat has already moved past does nothing.

### 1.1 Nurture cadence by relationship type [DEFAULT]

| Relationship type | Cadence (days since last touch) |
|---|---|
| `mentor`, `alumni` with completed chat | 45 |
| `recruiter` | 30 during the cycle, 90 outside |
| `peer`, `colleague` | 60 |
| `professor`, `family_friend` | 90 |
| `unknown`, `other` | 75 |

A `nurture` draft requires at least one hook: a fact of type `hook` or `offer` from the last 90 days (the newest wins), a new affiliation, a user update (new experience in the resume, a new target company that relates to the person), or a seasonal event (semester start, graduation, offer season). Without a hook, no suggestion.

---

## 2. Scoring and selection

```
urgency   = kind base: schedule_confirm 1.0, thank_you 0.95, prep_brief 0.95, schedule_propose 0.9, confirm_stage 0.85,
            follow_up_bump 0.7 (+0.1 per business day over the threshold, cap 0.9), action_item_reminder 0.7 (overdue +0.15),
            ask_referral 0.65 (+0.2 if deadline ≤ 7 days), congratulate 0.6 (decays −0.05/day after detection),
            intro_request 0.55, confirm_note_match 0.5, confirm_merge 0.4, nurture_checkin 0.4, reconnect 0.35, new_outreach 0.3
value     = 0.5 + 0.5·goal_relevance   where goal_relevance ∈ [0,1] = 1 for target company (priority 1), 0.8 priority 2, 0.5 target industry/function match, 0.3 alumni, 0.2 otherwise
confidence= model confidence of the triggering signal (1.0 for calendar-driven rules)
fatigue   = 1 − 0.15·(number of dismissals of this kind for this person in 60 days), floor 0.4
priority_score = urgency · value · confidence · fatigue
```

Selection for a daily brief: sort by `priority_score`; always include every `schedule_confirm`, `thank_you`, `prep_brief`, `confirm_stage` and `action_item_reminder` (hard-urgent set plus promises due today or overdue, up to 5; a promise has goal relevance 1); then the obligations inside live threads (`follow_up_bump`, `schedule_propose`, `action_item_reminder`, `ask_referral`, `report_back`, and `intro_request`, the follow-up on an intro the person offered) before any cold outreach; fill to 7 with the rest, at most 2 `new_outreach`, at most 1 each of `reconnect` and `nurture_checkin`, and at most 2 non-urgent message-bearing suggestions to the same company. Any suggestion attached to an active chat has a goal relevance of at least 0.6. Fewer than 7 is fine; zero means no email.

Weekly outreach pacing (weeks run Monday to Sunday): if the student is behind their weekly target from Wednesday on, `new_outreach` urgency rises to 0.5; if ahead, it drops to 0.2.

Quiet days (the student's `quiet_days`, weekends, US federal holidays and the winter freeze, in the student's timezone): the brief only selects answers inside live exchanges and time-bound items (`schedule_confirm`, `schedule_propose`, `thank_you`, `prep_brief`, `confirm_stage`, `action_item_reminder`, `warm_up_engage`); bumps, check-ins and cold outreach stay pending as deferred and compete again on the next working day.

---

## 3. Brief generation (per user)

Inngest function `brief.generate` (08 section 4) steps:

1. `refresh`: run strength recompute for people touched since yesterday; run stage rules (`no_response`, `followed_up → nurturing`, `completed → nurturing` 14 days after a meeting with no thank-you on record).
2. `candidates`: run every rule in section 1, then the validity pass (section 1). Upsert into `suggestions` with `status = pending`, `expires_at = brief_date + 2 days`, `dedupe_key`: an existing pending row with the same key is kept and its signals refreshed (an untouched scheduling draft is re-drafted when its time windows change; an untouched thank-you, check-in or referral ask is re-drafted when the person has facts newer than the draft, from notes, a reply or a fact typed in, which the validity pass on opening Today also checks, and `payload.factsAsOf` records the newest fact used so the same facts never re-draft twice); a row the system expired comes back as pending when its trigger is true again; only user decisions (dismissed, sent, done, approved, edited) block a key for good.
3. `select`: section 2; mark selected rows with `brief_id`; unselected rows that are still true stay pending with `deferred = true` (no draft until opened), are listed under "N more suggestions" on Today and compete again in the next brief.
4. `draft` (parallel steps, concurrency 4 per user): for each selected message-bearing suggestion without an `outbound_message_id`, build the context pack, run T8, validate, insert `outbound_messages (status draft)`; failures remove the suggestion from the brief with a log entry. Prep briefs run T10. All T8 calls for one user share the per-user cached block (05 section 3).
5. `compose`: T9 produces `summary_text`; insert `briefs`.
6. `deliver`: in-app (`notifications` row, Realtime), email via Resend (template `brief-daily`, cards with deep links `/today?s=<id>`), push if enabled and flag `web_push`.
7. `carry_over`: a pending suggestion picked again by a later brief gets `carried_over += 1`. Nothing expires by count; expiry comes only from the validity pass, with a `feedback_events (expire)`.

Welcome brief: same function with `kind = welcome`, triggered by `orbit/google.backfill.fast.done`, with the rules limited to detected chats (`confirm_stage`), `prep_brief`, `thank_you` for chats completed in the last 7 days, and `new_outreach` (3), plus onboarding cards (skipped steps).

Weekly recap (Sunday 18:00 local): counts and highlights only; no suggestions; `kind = recap`.

---

## 4. Acting on a suggestion

| Action | Effect |
|---|---|
| **Approve & send** | server action `approveSuggestion(id, bodyFinal?)` → `bind_approval()` with the body as shown (edited or not) → `suggestions.status = approved|edited` → `feedback_events (approve|edit with diff)` → emit `orbit/message.send` delayed 60 s → UI shows "Sending in 60s · Undo" |
| **Undo** (within 60 s) | `outbound_messages.status = cancelled`; the delayed event is cancelled via Inngest `cancelOn` matching `orbit/message.cancel` with the same message id; suggestion back to `pending` |
| **Edit** | inline editor; on save the approval binds the edited body; `edit_distance` recorded |
| **Snooze** | `status = snoozed`, `snoozed_until`; reappears as pending after; `feedback_events (snooze)` |
| **Dismiss** | `status = dismissed` with reason chip; `feedback_events (dismiss)`; fatigue applies; "wrong person" also opens the merge/hide menu; "bad draft" stores the draft for eval review |
| **Open prep** | marks `done` when opened; `feedback_events` none |
| **Confirm / correct** (stage, merge, note match) | writes the decision (`apply_stage_transition` with actor user, `merge_people`, note match update) and `feedback_events` |

For `channel = linkedin` without the Unipile flag, "Approve & send" is labelled **Copy & open LinkedIn**; it binds approval, copies the text, opens the compose URL, and marks the message `sent` with `provider_message_id = null` (04 section 3.4).

---

## 5. Send pipeline

Inngest `message.send` (idempotent on `outbound_messages.id`):

1. Load the message; require `status = approved`; recompute `sha256(body_final)` and compare with `body_final_hash`; mismatch → `failed` with reason `hash_mismatch` (never send).
2. `check_send_allowed(user, person, channel)`; if not allowed → `failed` with the reason; notification "Not sent: daily limit reached" with a one-tap "Send tomorrow" (re-queues with the next-day delay).
3. `status = sending`; call the channel adapter (Gmail `send` with thread id for replies; Unipile when flagged); on success `status = sent`, `sent_at`, `provider_message_id`, `audit_log (message.sent)`, `touchpoints (email_out|linkedin_out)`, chat timestamps and `bump_count` (for `bump`), stage transition per 05 section 6, `suggestions.status = sent`.
4. On provider error: retry up to 3 times with backoff (Inngest step retries) for 5xx/429; 4xx → `failed`, notification with "Retry" and "Reconnect Google" when the token is invalid.
5. Never send more than one message per person per run; a second approved message for the same person in the same minute is delayed by 2 minutes.

---

## 6. Replies and realtime

When T4 classifies a new inbound message on an active chat: insert `notifications (reply_received)`, push via Realtime to the Today page ("Priya replied"), and run the ⚡ rules immediately so a `schedule_confirm` or `schedule_propose` card appears without waiting for the morning. If the student does not open the app within 4 hours, a single email "Priya replied to your note" is sent (not for every message; batched per hour).

---

## 7. Learning from feedback

- **Style**: edit pairs feed T12 (05 section 7.4); phrases deleted in ≥ 3 edits enter `style_card.avoid`.
- **Ranking**: per-kind approval and dismissal rates per user adjust `urgency` by ±0.1 after 20 decisions (bounded); dismiss reasons "not now" raise the cadence for that person by 50 percent; "already did this" triggers a check of the Sent mail for an outbound the sync missed and logs a stage-inference miss.
- **Suggestion quality dashboard** (`11` section 5): approval, edit distance, dismiss reasons by kind, time-to-decision, reply rate after send by kind and by path band.

---

## 8. Email template (brief-daily)

Subject: `{first name}, {n} things for today · {weekday}` (n = card count). Preheader: the summary sentence. Body: greeting line, summary, one block per card (kind label, person line, reason, draft preview truncated at 280 chars, button "Review and send" → `/today?s=<id>`), "Also today" list (upcoming chats), footer with progress line and the unsubscribe link for the brief topic. Plain-text alternative generated from the same data. No tracking pixels beyond Resend's open tracking (on, used for `opened_at`).
