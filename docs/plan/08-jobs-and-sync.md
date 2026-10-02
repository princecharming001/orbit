# 08. Jobs, events and sync

Status: build specification. The complete Inngest function catalogue, event schemas, schedules, concurrency and idempotency rules. Implemented in `packages/jobs`.

---

## 1. Client and conventions

```ts
// packages/jobs/src/client.ts
export const inngest = new Inngest({ id: 'orbit', schemas: new EventSchemas().fromZod(events) });
```

- Every function: `id` = event name with dots → dashes; `retries: 3` unless stated; `concurrency` keyed by `event.data.userId` where per-user serialisation matters; `idempotency` on the event id where the event can be re-emitted.
- Steps are named with stable strings; each step does one unit of work ≤ 60 s and writes its result to the database before returning (so a retried step is safe).
- Errors that are the user's to fix (token revoked) throw `NonRetriableError` and set `integration_accounts.status`.
- Functions never call the LLM directly; they call `runTask()`.

---

## 2. Event catalogue (`packages/jobs/src/events.ts`)

| Event | Data | Emitted by |
|---|---|---|
| `orbit/user.onboarded.step` | `{userId, step}` | server action |
| `orbit/user.onboarding.completed` | `{userId}` | server action |
| `orbit/resume.uploaded` | `{userId, resumeId}` | server action |
| `orbit/goals.updated` | `{userId}` | server action |
| `orbit/google.connected` | `{userId, accountId}` | OAuth callback |
| `orbit/google.backfill.requested` | `{userId, accountId}` | `google.connected` handler |
| `orbit/google.backfill.fast.done` | `{userId, accountId}` | backfill function |
| `orbit/google.backfill.full.done` | `{userId, accountId}` | backfill function |
| `orbit/gmail.push.received` | `{emailAddress, historyId}` (+ `webhookEventId`) | `/api/webhooks/gmail` |
| `orbit/gmail.messages.process` | `{userId, accountId, messageIds: string[], runId}` | backfill / history functions |
| `orbit/gmail.thread.classified` | `{userId, threadId}` | message processor |
| `orbit/gcal.sync.requested` | `{userId, accountId, full: boolean}` | connected / watch notification |
| `orbit/gcal.event.changed` | `{userId, eventId}` | calendar sync |
| `orbit/google.disconnected` | `{userId, accountId}` | server action |
| `orbit/linkedin.csv.uploaded` | `{userId, uploadPath, files: string[]}` | server action |
| `orbit/linkedin.message.received` | `{userId, accountId, externalId}` | Unipile webhook |
| `orbit/person.resolve` | `{userId, identity: {...}, payload: {...}, source}` | processors (batched) |
| `orbit/person.enrich.requested` | `{userId, personId, reason}` | rules, UI |
| `orbit/person.changed` | `{userId, personId, fields: string[]}` | processors |
| `orbit/graph.recompute` | `{userId}` | cron, imports |
| `orbit/strength.recompute` | `{userId?}` | cron |
| `orbit/note.email.received` | `{emailId}` | `/api/webhooks/resend` |
| `orbit/note.granola.received` | `{accountId, noteId}` | `/api/webhooks/granola/*` |
| `orbit/note.fathom.received` | `{accountId, recordingId}` | `/api/webhooks/fathom/*` |
| `orbit/note.captured` | `{userId, noteId}` | server action (capture box, upload, paste) |
| `orbit/note.process` | `{userId, noteId}` | all note receivers |
| `orbit/chat.stage.evaluate` | `{userId, chatId, cause}` | processors |
| `orbit/suggestions.evaluate` | `{userId, personId?, chatId?, cause}` | processors (⚡ rules) |
| `orbit/brief.generate` | `{userId, kind, briefDate}` | cron fan-out, backfill fast done |
| `orbit/brief.deliver` | `{userId, briefId}` | brief.generate |
| `orbit/suggestion.approved` | `{userId, suggestionId, outboundMessageId}` | server action |
| `orbit/message.send` | `{userId, outboundMessageId}` | server action (delay 60 s) |
| `orbit/message.cancel` | `{userId, outboundMessageId}` | server action |
| `orbit/recommendations.refresh` | `{userId, onDemand: boolean}` | cron (Monday), UI |
| `orbit/reach.query` | `{userId, reachQueryId}` | server action (async when enrichment needed) |
| `orbit/style.rebuild` | `{userId, cause}` | backfill fast done, weekly, edit count |
| `orbit/ai.batch.flush` | `{task}` | timer |
| `orbit/user.export.requested` | `{userId}` | server action |
| `orbit/user.delete.requested` | `{userId}` | server action |
| `orbit/user.delete.execute` | `{userId}` | cron (grace elapsed) |

---

## 3. Function catalogue

### 3.1 Google

| Function | Trigger | Steps | Flow control |
|---|---|---|---|
| `google-connected` | `google.connected` | register Gmail watch; register Calendar watch; emit `gcal.sync.requested {full:true}`; emit `google.backfill.requested`; insert `sync_runs` | — |
| `google-backfill` | `google.backfill.requested` | `fast-sent-list` (q `in:sent newer_than:90d`) → fan out `gmail.messages.process` in chunks of 100 with `runId` → `fast-inbox-list` → fan out → `wait-fast` (`step.waitForEvent` on all chunks or `step.sleep` polling of `sync_runs.stats` every 30 s, max 10 min) → emit `backfill.fast.done` (+ `style.rebuild`, `brief.generate {welcome}`) → `full-list` pages of 500 (q `newer_than:24m -category:...`) → fan out in chunks of 100 with a throttle → `wait-full` → emit `backfill.full.done`; update `sync_state.backfillDone` | concurrency 1 per `accountId`; throttle `gmail.messages.process` to 3 chunks/minute per account (≈ 300 `messages.get`/min ≤ 6,000 units) |
| `gmail-messages-process` | `gmail.messages.process` | `fetch-metadata` (batch `messages.get format=metadata`) → `prefilter` → `fetch-full` for survivors → `store` (threads, messages, identities → `person.resolve` inline, not as events, to keep ordering) → `triage` (T3 per new thread; batch mode if `runId` is a backfill) → `signals` (T4 for networking threads, realtime only; backfill defers T4 to the thread's first incremental message except the last 5 messages per networking thread) → `touchpoints` → emit `chat.stage.evaluate` and `suggestions.evaluate` for affected chats; increment `sync_runs.stats` | concurrency 2 per account; retries 5 |
| `gmail-push` | `gmail.push.received` | resolve account by email → `history.list` since stored id → on 404 run `resync-7d` → emit `gmail.messages.process` for added ids → store new history id; link messages carrying `X-Orbit-Message-Id` to their `outbound_messages` row | debounce 60 s per `emailAddress`; concurrency 1 per account |
| `gmail-watch-renew` | cron `0 */12 * * *` | for active google accounts with `watchExpiration < now + 36 h`: `users.watch`; on 401/403 mark `needs_reauth` | batch of 200 per run |
| `google-token-check` | cron `0 6 * * *` | for accounts in Testing-status projects: tokens issued > 6 days ago → notification `integration_problem` ("Reconnect Google") | — |
| `gcal-sync` | `gcal.sync.requested` | `list` (full window or sync token) → `store` → for each changed event: attendee resolution, coffee-chat detection → emit `gcal.event.changed` → `chat.stage.evaluate` (`scheduled`, `completed`, cancellations) → `suggestions.evaluate` (prep) | concurrency 1 per account |
| `gcal-watch-renew` | cron `0 */12 * * *` | renew channels expiring within 36 h | — |
| `gcal-completed-sweep` | cron `*/15 * * * *` | events ended 15–30 min ago with `is_coffee_chat` and a chat in `scheduled` → `apply_stage_transition(completed)` → `suggestions.evaluate` (thank_you, capture nudge) | — |
| `google-disconnected` | `google.disconnected` | stop watches; revoke token; delete messages/threads/events; keep people and touchpoint summaries; set status `revoked`; audit | — |

### 3.2 LinkedIn and enrichment

| Function | Trigger | Steps | Flow control |
|---|---|---|---|
| `linkedin-csv-import` | `linkedin.csv.uploaded` | `parse` (Storage read, tolerant CSV) → `resolve` in chunks of 500 (identities, people, affiliations, touchpoints) → `org-normalise` (aliases, trigram, create) → emit `graph.recompute`, `recommendations.refresh {onDemand:false}`; notification with counts | concurrency 1 per user |
| `person-enrich` | `person.enrich.requested` | check cap and cache → provider call (PDL; Coresignal when flagged and PDL misses) → normalise → `affiliations` (source enrichment), `people` fields by precedence, `person_identities` (emails), org upserts → embeddings → detect job change (new current affiliation vs previous) → emit `person.changed`, `suggestions.evaluate {cause: job_change}` when changed | concurrency 5 global; rate limit 10/s global; per-user monthly cap in code |
| `enrichment-refresh` | cron `0 3 * * 1` (Mondays 03:00 UTC) | people with active chats or strength ≥ 0.6 and `enriched_at < now − 90 d` → emit `person.enrich.requested` (reason `refresh`) | cap 2,000/day platform |
| `graph-recompute` | `graph.recompute`; cron `0 4 * * *` for users with changes | load people + affiliations + threads/events co-occurrence → compute edges (06 section 4) → diff-upsert `edges` | concurrency 1 per user; batch users 100 per cron run |
| `strength-recompute` | cron `30 3 * * *` | all people with `last_interaction_at` in the last 2 years; batches of 500; update strength and tier | — |
| `unipile-webhook` (flag) | `linkedin.message.received`, account status | fetch message → `linkedin_messages` → T4 → touchpoints → stage/suggestions | concurrency 1 per account |

### 3.3 Notes

| Function | Trigger | Steps |
|---|---|---|
| `note-email-received` | `note.email.received` | fetch via Resend Received Emails API → resolve `ingest_token` → detect Granola share (footer/link) → insert `meeting_notes` (source `granola_email` or `email_ingest`, external id = Resend email id) → emit `note.process` |
| `note-granola-received` | `note.granola.received` | fetch note with transcript (rate limit 4/s global) → insert/update `meeting_notes (granola_api)` → emit `note.process` |
| `granola-reconcile` | cron `0 5 * * *` | per connected Granola account: `GET /v1/notes` since `last_synced_at − 1 d`; ingest missing |
| `note-fathom-received` | `note.fathom.received` | fetch recording content → insert → `note.process` |
| `note-process` | `note.process` | `match` (people, event, chat; 05 section 9) → `extract` (T6; chunked) → `facts` (dedupe, supersede) → `action-items` → `stage` (`completed`) → `summary` (debounced T7 via `person.changed`) → emit `suggestions.evaluate {cause: note}` → notification "Notes from your chat with X are in" |

### 3.4 Engine

| Function | Trigger | Steps | Flow control |
|---|---|---|---|
| `chat-stage-evaluate` | `chat.stage.evaluate` | load chat + last signals + events → apply the transition table → `apply_stage_transition` (applied or proposed) | concurrency 1 per chat (`chatId`) |
| `suggestions-evaluate` | `suggestions.evaluate` | run ⚡ rules for the scope (person/chat) → upsert pending suggestions → draft immediately for `schedule_confirm`, `schedule_propose`, `thank_you` → Realtime notify | debounce 30 s per `userId+chatId`; concurrency 2 per user |
| `brief-tick` | cron `5 * * * *` | select users whose local hour == hour(`brief_time_local − 1h`) and not on a quiet day and `onboarding_completed_at` not null → emit `brief.generate {daily}` per user | — |
| `brief-generate` | `brief.generate` | steps per 07 section 3 (`refresh`, `candidates`, `select`, `draft` ×N parallel, `compose`, `persist`, emit `brief.deliver`, `carry_over`) | concurrency 1 per user; global concurrency 25; `draft` steps limited by a per-user concurrency key of 4 |
| `brief-deliver` | `brief.deliver` | wait until `brief_time_local` (`step.sleepUntil`) → in-app notification → Resend email → push | — |
| `message-send` | `message.send` (delayed 60 s) | per 07 section 5; `cancelOn: [{event: 'orbit/message.cancel', match: 'data.outboundMessageId'}]` | concurrency 1 per user |
| `recommendations-refresh` | `recommendations.refresh`; cron `0 7 * * 1` | candidates (05 section 8.1) → score → diversity → T14 explanations (batch) → upsert | concurrency 1 per user; enrichment search budget check |
| `reach-query` | `reach.query` | resolve target (enrichment when needed) → paths → store `reach_queries.paths` → Realtime notify | concurrency 2 per user |
| `style-rebuild` | `style.rebuild`; cron `0 2 * * 0` | select exemplars → T12 → upsert `style_profiles` (version +1) → invalidate per-user cache block hash | concurrency 1 per user |
| `person-summary-refresh` | `person.changed` (debounced 1 h per person) | T7 when the person has a chat or strength ≥ 0.6 | concurrency 5 global |
| `weekly-recap` | cron `0 * * * 0` (fan-out by local 18:00) | stats → `briefs (recap)` → email | — |
| `ai-batch-flush` | timer every 10 min + size trigger | `batches.create` per task buffer | — |
| `ai-batch-poll` | cron `*/5 * * * *` | for open batch ids: retrieve; `ended` → dispatch results to task handlers by `custom_id` (`<task>:<refTable>:<refId>`) | — |

### 3.5 Account lifecycle and housekeeping

| Function | Trigger | Steps |
|---|---|---|
| `user-export` | `user.export.requested` | dump user tables to JSON + CSVs → zip to Storage `exports/<user>/<id>.zip` → signed URL (24 h) by email |
| `user-delete-schedule` | `user.delete.requested` | insert `deletion_requests (grace 7 d)`; disable sends; email receipt of the request |
| `user-delete-execute` | cron `0 1 * * *` | requests past grace → stop watches, revoke Google, delete Storage objects, Resend contact removal, `purge_user` → receipt email |
| `retention-sweep` | cron `0 2 * * *` | 03 section 6 rules |
| `integration-health` | cron `*/30 * * * *` | accounts with `error_count ≥ 3` or watch expired → notification (once per 24 h) |

---

## 4. `brief-generate` in detail (reference implementation outline)

```ts
export const briefGenerate = inngest.createFunction(
  { id: 'brief-generate', concurrency: [{ limit: 25 }, { key: 'event.data.userId', limit: 1 }], retries: 2 },
  { event: 'orbit/brief.generate' },
  async ({ event, step }) => {
    const { userId, kind, briefDate } = event.data;
    await step.run('refresh', () => refreshForBrief(userId));                       // strengths, timed stage rules
    const candidates = await step.run('candidates', () => generateCandidates(userId, kind));
    const selected = await step.run('select', () => selectForBrief(userId, candidates, kind));
    const drafted = await Promise.all(selected.filter(needsDraft).map(s =>
      step.run(`draft-${s.id}`, () => draftForSuggestion(userId, s.id))));         // each ≤ 60 s; failures return {ok:false}
    const briefId = await step.run('compose', () => composeBrief(userId, kind, briefDate, selected, drafted));
    await step.sendEvent('deliver', { name: 'orbit/brief.deliver', data: { userId, briefId } });
    await step.run('carry-over', () => carryOver(userId, briefDate));
  });
```

---

## 5. Idempotency and ordering

- Webhooks: `webhook_events (provider, external_id)` unique; handlers return 2xx on duplicates without emitting.
- Message ids: `email_messages (thread_id, gmail_message_id)` unique; processors upsert.
- Stage events: `apply_stage_transition` rejects a transition identical to the chat's current stage.
- Sends: `outbound_messages.idempotency_key = 'send:' || id`; the adapter call is inside one step so a retried step after a successful provider call re-reads the row (`status = sent`) and skips.
- Entity resolution runs inline in processors (not as separate events) so that a thread's participants are resolved before touchpoints are written; a per-user advisory lock (`pg_advisory_xact_lock(hashtext(user_id))`) around merge decisions prevents two concurrent processors from creating duplicates.

---

## 6. Local development

`pnpm dev` runs `next dev`, `inngest-cli dev -u http://localhost:3000/api/inngest`, and `supabase start`. Webhooks in local: `pnpm tunnel` (cloudflared) prints a public URL for Google Pub/Sub push, Resend and Granola; fixtures under `packages/integrations/fixtures/` (Gmail message JSON, calendar events, Connections.csv, Granola note, Resend received email, PDL response) drive `pnpm seed:demo` which creates a demo user with a realistic network for UI work without any external account.
