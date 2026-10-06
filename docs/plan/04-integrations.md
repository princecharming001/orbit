# 04. Integrations

Status: build specification. Every external system Orbit touches, with the exact access path, the adapter interface, limits, failure handling and the facts the design depends on. Each fact carries a tag: **[VERIFIED]** seen on the vendor's official page or docs (2026-10-02), **[SECONDARY]** third-party source, **[UNCERTAIN]** could not be confirmed, **[DECIDED]** our choice, **[GAP]** to research before building that step. Citations are in section 9.

Adapters live in `packages/integrations/src/<provider>/` and expose typed functions only; nothing else in the codebase imports a vendor SDK.

---

## 1. Summary of decisions

| Need | Decision | Why |
|---|---|---|
| Sign-in | Supabase Auth, Google provider, `openid email profile` only | Supabase does not persist provider refresh tokens, so Gmail access cannot ride on sign-in [VERIFIED] |
| Gmail + Calendar | Our own Google OAuth app, direct Gmail API and Calendar API, push via Pub/Sub | Nylas' shared, pre-verified Google app is contract-only [VERIFIED]; direct is free and fully in our control |
| Google verification | Start restricted-scope verification + CASA Tier 2 in Phase 0; run the pilot in Testing status (100 users, weekly re-consent) | restricted scopes (`gmail.readonly`) require it; 2–3 weeks for Tier 2, $500–$4,500 official range, under $1,000 via self-serve labs [VERIFIED/SECONDARY] |
| LinkedIn connections | User-uploaded data export (`Connections.csv`), plus the OIDC identity for the profile URL | the only official, self-serve data paths for a US member [VERIFIED] |
| LinkedIn work/education history (for shared-employer and school inference) | People Data Labs Person Enrichment by LinkedIn URL (primary); Coresignal (secondary, cheaper at volume) behind flag | both return `experience[]` + `education[]`; licensed datasets, not live scraping [VERIFIED fields; SECONDARY pricing] |
| LinkedIn messaging | v1: "copy and open" handoff (no API). v1.5: Unipile hosted auth behind flag `linkedin_messaging` with hard caps | Unipile works via the member's own session, which is a LinkedIn User Agreement exposure for the student; the student must opt in knowingly [VERIFIED capabilities] |
| Meeting notes | Granola public API + webhooks for Business-plan users; share-by-email ingest and paste for everyone; Fathom webhooks as the recommended free notetaker | Granola API/webhooks/Zapier are Business+ only; Basic plan gets only MCP (30 days, no transcript) [VERIFIED] |
| Voice capture | Wispr Flow has no dictation API; it types into any text box, so Orbit's capture box is the integration; manual import of the Wispr data-export ZIP; optional read of Wispr's remote MCP (Notetaker meetings) behind flag `wispr_mcp` | [VERIFIED] |
| Transactional email + inbound | Resend | inbound receiving with `email.received` webhook + Received Emails API, included on all plans [VERIFIED] |

---

## 2. Google (Gmail, Calendar, OAuth)

### 2.1 OAuth app and scopes

Scopes requested at onboarding step 5, in one consent (incremental auth is not used; a single consent keeps the UX simple) [DECIDED]:

| Scope | Class | Used for |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | restricted [VERIFIED] | read threads/messages for classification, context, reply detection |
| `https://www.googleapis.com/auth/gmail.send` | sensitive [SECONDARY] | send approved messages from the student's address |
| `https://www.googleapis.com/auth/calendar.events` | sensitive | read events (attendees, times), write nothing in v1 |
| `openid email profile` | non-sensitive | identity of the connected mailbox |

Not requested: `gmail.modify` (we never label or archive), `gmail.metadata` (also restricted and insufficient), `contacts` (People API) in v1 [DECIDED].

Flow: `GET /api/oauth/google/start` builds the URL with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, a signed `state` (user id + nonce, 10 min TTL). Callback exchanges the code, verifies the id token's email, stores `access_token_enc`, `refresh_token_enc`, `token_expires_at`, `scopes`, and emits `orbit/google.connected`. Token refresh is done lazily by `googleClient(scope, accountId)` which refreshes when under 5 minutes to expiry, persists the new token, and marks the account `needs_reauth` on `invalid_grant`.

### 2.2 Verification plan

- Phase 0 (week 1): create the GCP project, OAuth consent screen (external), brand verification, privacy policy page with Google Limited Use disclosure, demo video; submit for sensitive + restricted scope verification. [VERIFIED requirements]
- CASA Tier 2 via an ADA-authorised lab (self-scan is deprecated; the lab reviews developer-run scan evidence and issues the letter) [VERIFIED]. Budget $600–$1,000 and 3 weeks; annual revalidation [VERIFIED/SECONDARY].
- Until verified, the app runs in Testing status: at most 100 test users, each listed by email in the consent screen, and refresh tokens expire after 7 days [VERIFIED]. Consequences built into v1: a weekly "Reconnect Google" card plus email, generated by the daily `google-token-check` cron function (08 §3.1), and the pilot roster is capped at 100.

### 2.3 Gmail sync

Backfill in two passes [DECIDED]:

1. **Fast path** (goal: welcome brief in under 5 minutes): `messages.list` with `q = "in:sent newer_than:90d"` plus `q = "newer_than:90d -category:promotions -category:social -category:updates -category:forums"`; the sent set first, because the student's own writing identifies their real correspondents and seeds the style card.
2. **Full path**: `messages.list` with `q = "newer_than:24m -category:promotions -category:social -category:forums"` paged (500 per page), then `messages.get` with `format=metadata` for all, and `format=full` only for threads that pass the human-thread prefilter (section 2.5). Processing in chunks of 100 message ids per Inngest step.

Quota budget [VERIFIED]: `messages.get` costs 20 units; per-user limit 6,000 units/minute (≈ 300 `messages.get` per minute). A 20,000-message mailbox where 40 percent passes the prefilter needs ≈ 8,000 full gets ≈ 27 minutes at the cap; the chunk size and an Inngest throttle of 250 `messages.get` per minute per user keep us under it. Project-level limit 1.2M units/minute [VERIFIED].

Incremental: `users.watch` on `INBOX` and `SENT` labels with the Pub/Sub topic; renewed daily by cron (`expires` is 7 days; Google recommends daily) [VERIFIED]. Push handler verifies the Pub/Sub OIDC token, stores the event, and emits `orbit/gmail.push.received {emailAddress, historyId}`; the job calls `history.list(startHistoryId = stored)` with `historyTypes = messageAdded`, fetches new messages, advances the stored history id. On HTTP 404 (history id too old) run a bounded re-sync (`newer_than:7d`) and reset the id [VERIFIED]. Debounce pushes per account to one run per 60 seconds (Inngest `debounce`).

### 2.4 Calendar sync

Initial: `events.list` on `primary` for `timeMin = now − 180 d`, `timeMax = now + 90 d`, `singleEvents = true`, store the `nextSyncToken`. Incremental: `events.watch` channel (renewed every 6 days) → on notification, `events.list` with `syncToken` [VERIFIED fields and watch method]. Fields used: `id`, `iCalUID`, `summary`, `description`, `start/end.dateTime`, `status`, `attendees[] {email, displayName, responseStatus, self, organizer}`, `conferenceData`, `hangoutLink` [VERIFIED].

Coffee-chat detection (code, not LLM): event has ≥ 1 non-self attendee, ≤ 3 attendees total, duration 15–60 min, at least one attendee resolves to a person with an active chat or is external to the student's school domain, and the title does not match a block list (standup, class, lecture, section, office hours, interview, exam). Confidence 0.9 when an attendee has an active chat, 0.7 otherwise (then a `confirm_stage` card asks "Was this a coffee chat with X?"). [DEFAULT]

### 2.5 Human-thread prefilter (code)

Skip `messages.get full` and all LLM work when any of: `List-Unsubscribe` or `List-Id` header present; `Precedence: bulk|list|junk|auto_reply`; `Auto-Submitted` not `no`; `X-Autoreply`/`X-Autorespond` present; a `Sender` header that differs from `From` and is a notification address (Google Calendar invitations carry the organizer in `From` and `calendar-notification@google.com` in `Sender`); sender local-part in {`noreply`, `no-reply`, `no_reply`, `donotreply`, `notifications`, `newsletter`, `invitations`, `mailer-daemon`, `postmaster`, ...} or matching `^(.*-)?(noreply|notifications?)@`; sender domain in the notification-only list (`facebookmail.com`, `sendgrid.net`, `greenhouse-mail.io`, `myworkday.com`, ...) or a mail-sending subdomain of a large sender (`e.linkedin.com`, `email.chase.com`); Gmail labels include `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_FORUMS`, `CATEGORY_UPDATES`. Expected to remove 55–70 percent of messages before any LLM call. [DEFAULT]

The domain list never contains an employer's own domain: a person at `capitalone.com`, `linkedin.com`, `chase.com`, `google.com` or `greenhouse.io` is human unless the local part, headers or labels say otherwise (`EMPLOYER_MAIL_DOMAINS` in `packages/core/src/text/email.ts` lists the big senders whose subdomains are automated but whose apex is not). Vacation auto-replies and calendar invitations (subject `Invitation:`/`Accepted:` with a calendar body, or `Content-Class: calendarmessage`) are also marked automated; the calendar sync owns invitations, and the networking pass still reads an auto-reply for its out-of-office return date (05 §5.4).

Addresses: `To`/`Cc` are split with a quote-aware parser (`"Doe, Jane" <jane@x.com>` is one address). The student's own addresses are the connected address plus every `From` on a message Gmail labels `SENT` (send-as aliases), every `From` already stored as outbound, and a `From` at the school domain whose display name is the student's name; mail from any of them is outbound and never creates a person.

### 2.6 Sending

`messages.send` with a raw RFC 2822 message built by `buildMime()`: `From` = connected address with display name, `To`, `Subject`, `In-Reply-To`/`References` when replying (and `threadId` in the request body so Gmail threads it), `text/plain` always and `text/html` with the same content lightly formatted, plus header `X-Orbit-Message-Id: <outbound_messages.id>` for correlation. Cost 100 quota units per send [VERIFIED]. On success store `provider_message_id` and `gmail_thread_id`; the sent message is also picked up by the push sync and linked to the same `outbound_messages` row by the header.

### 2.7 Adapter interface

```ts
// packages/integrations/src/google/index.ts
export interface GoogleAdapter {
  startAuthUrl(userId: string): string;
  handleCallback(code: string, state: string): Promise<{ accountId: string }>;
  gmail: {
    listMessageIds(accountId, q: string, pageToken?): Promise<{ ids: string[]; nextPageToken?: string; estimate: number }>;
    getMessage(accountId, id, format: 'metadata' | 'full'): Promise<GmailMessage>;   // normalised: headers, parts → text
    history(accountId, startHistoryId): Promise<{ added: string[]; newHistoryId: string } | { resyncRequired: true }>;
    watch(accountId): Promise<{ expiration: Date; historyId: string }>;
    send(accountId, mime: Buffer, threadId?): Promise<{ messageId: string; threadId: string }>;
  };
  calendar: {
    listEvents(accountId, opts: { timeMin?; timeMax?; syncToken? }): Promise<{ events: GcalEvent[]; nextSyncToken: string }>;
    watch(accountId): Promise<{ channelId: string; resourceId: string; expiration: Date }>;
    stopWatch(accountId, channelId, resourceId): Promise<void>;
  };
  revoke(accountId): Promise<void>;
}
```

---

## 3. LinkedIn

### 3.1 What is and is not available [VERIFIED]

- Sign In with LinkedIn (OpenID Connect) returns `sub`, name, picture, email only. No connections, positions or education.
- The Connections API requires LinkedIn partner approval; the Member Data Portability APIs allow a member to share their data (including connections) with a third-party app **only if the member is in the EEA/Switzerland**. A US student cannot consent. Orbit therefore has no official API path to a US student's connections.
- The self-service export ("Get a copy of your data") delivers `Connections.csv` by email within about 10 minutes, with columns `First Name, Last Name, URL, Email Address, Company, Position, Connected On` (email present only where the connection allowed it, roughly a third of rows; a few preamble "Notes:" lines precede the header) [VERIFIED content description; SECONDARY column order]. `messages.csv` and `Invitations.csv` exist with date, subject, content and profile URLs [VERIFIED description; UNCERTAIN exact headers → **[GAP]**: obtain a real export in Phase 1 and pin the parser to it].

### 3.2 LinkedIn export import (v1)

- Onboarding step 6 explains the export, offers "Email me the steps", and accepts a ZIP or individual CSVs via Supabase Storage (`imports/<user_id>/<upload_id>/`).
- Parser (`packages/integrations/src/linkedin-csv/`): detects the header row by scanning for `First Name`, tolerates preamble lines, BOM, quoted commas; normalises `Connected On` (`DD MMM YYYY`); normalises URLs to `https://www.linkedin.com/in/<slug>` (lowercase slug, strip query, trailing slash).
- Each row → `person_identities (linkedin_url)` (+ `email` when present) → entity resolution (`05` section 4) → `people` (source `linkedin_csv`, `linkedin_connected_on`), `affiliations (employment, is_current = true, name_raw = Company, title = Position)`, and a `touchpoints (linkedin_connected)` row dated `Connected On` with weight 0.2.
- `messages.csv` rows → `linkedin_messages (source linkedin_csv)` → touchpoints and reply-signal classification like email. `Invitations.csv` sent rows → touchpoints `linkedin_out` (weight 0.3) when the invitee matches a person.
- Re-upload is idempotent (unique on `(user_id, kind, value_normalized)`); people removed from a later export are not deleted.

### 3.3 Enrichment providers (work and education history)

Interface:

```ts
export interface EnrichmentProvider {
  readonly name: 'pdl' | 'coresignal';
  enrichByLinkedInUrl(url: string): Promise<EnrichedPerson | null>;
  enrichByEmail(email: string): Promise<EnrichedPerson | null>;        // pdl only
  searchPeople(q: PeopleSearchQuery): Promise<{ results: EnrichedPerson[]; cost: number }>;  // school + company + title filters
  costPerCall(kind): number;   // micro-dollars, for budgeting
}
// EnrichedPerson: { fullName, linkedinUrl, headline, location, photoUrl?, experience: [{company, companyLinkedinSlug?, title, start, end, isCurrent}], education: [{school, degree, field, start, end}], emails?: string[], raw }
```

- **People Data Labs** (primary) [DECIDED]: Person Enrichment with `profile = <linkedin url>` (or `email`) returns `experience[]` and `education[]` with dates [VERIFIED fields]. Person Search supports `experience` and `education` filters, 1 credit per returned profile [VERIFIED]. Pricing ≈ $0.20–$0.28 per successful match, Pro from $98/month with 350 credits [SECONDARY] → **[GAP]** confirm the plan before Phase 4.
- **Coresignal** (secondary, flag `enrichment_coresignal`): lookup by LinkedIn URL; experience and education objects [VERIFIED]; ≈ $0.20/record at the entry tier falling steeply at volume [SECONDARY]. Added when PDL spend exceeds $500/month or coverage of a school's alumni is poor.
- Not used: Enrich Layer (Proxycurl's successor; Proxycurl was shut down in 2025 after LinkedIn's suit [SECONDARY]), Crustdata live fetch, Phantombuster — live-scraping exposure [DECIDED].
- Cache: `enrichment_cache` keyed by `(provider, lookup_kind, lookup_key)`, 90 days; a miss is cached 30 days.
- Budget rules (code): per-user monthly cap `user_settings.enrichment_monthly_cap` (default 100); priority order for automatic enrichment: people with an active chat → people at target companies → top 150 by strength → alumni (same school) in the export; on-demand enrichment for Reach queries and Discover search counts against the cap and asks for confirmation beyond it. Platform-wide daily cap in `feature_flags.note` JSON → **[DEFAULT]** 2,000/day.
- Refresh: people with an active chat or strength ≥ 0.6 are re-enriched every 90 days to detect job changes (`congratulate` trigger).

### 3.4 LinkedIn messaging via Unipile (v1.5, flag `linkedin_messaging`)

Capabilities [VERIFIED by docs snippets]: hosted auth link (student logs into LinkedIn inside Unipile's wizard, including 2FA); list the member's own relations (`GET /api/v1/users/relations`); start chats and send messages (`POST /api/v1/chats`, `POST /chats/{id}/messages`; new chats only with existing relations unless InMail); send invitations with a note (`POST /api/v1/users/invite`); read the inbox with webhooks for new messages; fetch a profile by public slug. Pricing ≈ €49/month for up to 10 accounts then €5/account/month [VERIFIED]. Unipile's recommended limits: ≈ 100 sensitive actions/day/account, 80–100 invitations/day, lower for new accounts; exceeding them risks disconnection or LinkedIn restrictions [VERIFIED].

Orbit rules when the flag is on [DECIDED]:

- Explicit opt-in screen that states in plain words that this uses the student's LinkedIn session through a third party, that LinkedIn's User Agreement restricts automation, and that Orbit will send at most what they approve, never more than 10 messages and 5 invitations per day, with human-like spacing (random 3–15 minute gaps, working hours in their timezone only).
- Relations sync replaces the CSV path for connections when connected (same resolution pipeline, source `unipile`); inbox sync writes `linkedin_messages (source unipile)`; webhooks `message_received` emit `orbit/linkedin.message.received`.
- `check_send_allowed` applies `daily_send_cap_linkedin` (default 10) and the invite cap (5).
- Account status webhooks (`CREDENTIALS`, `DISCONNECTED`) → `integration_accounts.status = needs_reauth` + notification.

Until the flag is on (all of v1): LinkedIn messages are delivered as **Copy and open**: the approval action copies the body to the clipboard, marks the outbound message `sent` with `channel = linkedin`, `provider_message_id = null`, and opens `https://www.linkedin.com/messaging/compose/?recipient=<slug>` (or the profile URL when the slug is unknown) in a new tab. Reply detection for these relies on the student's later CSV upload or manual logging; the pipeline treats LinkedIn outreach as `outreach_sent` with a lower bump cadence (10 days). [DEFAULT]

---

## 4. Resend (outbound notifications and inbound ingest)

- Outbound: domain `<domain>` with sending subdomain `mail.<domain>`; templates rendered server-side with `react-email`; topics (Resend "topics"/unsubscribe groups) per notification kind for one-click unsubscribe; `tags` carry `user_id` hash and `kind`. Webhooks `email.delivered`, `email.bounced`, `email.complained` update `notifications.delivered` and `briefs.delivered_at`.
- Inbound: enable Receiving on `in.<domain>` (MX record) [VERIFIED]; addresses `notes-<token>@in.<domain>`. On `email.received` (metadata only), the handler emits `orbit/note.email.received {emailId}`; the job fetches the content via the Received Emails API and attachments via the Attachments API [VERIFIED], resolves the token to the user, and inserts `meeting_notes (source email_ingest | granola_email)` (Granola-shared emails are detected by the Granola footer/share link pattern and marked `granola_email`). Unknown tokens are dropped and counted. Received emails count against the sending quota [VERIFIED]; Pro at $20/month covers 50k/month.

---

## 5. Granola

Facts [VERIFIED]: public REST API `https://public-api.granola.ai/v1` with Bearer keys (`grn_…`) created in Settings → Connectors → API keys; `GET /v1/notes` (paginated, date filter), `GET /v1/notes/{id}?include=transcript`, `GET /v1/notes/{id}/transcript`; rate limit 5 rps / 300 per minute; notes carry `summary_markdown`, `attendees[] {name, email}`, `calendar_event {event_title, invitees, organiser, calendar_event_id, scheduled_start_time, scheduled_end_time}`, `web_url`, and a speaker-attributed transcript. Webhooks `note.generated`, `note.edited` with signature verification; payloads carry no content (fetch on receipt). API, webhooks and Zapier are **Business ($14/user/month) and Enterprise only**; Basic (free) has the MCP server only (last 30 days, no transcripts). Whether `calendar_event_id` equals the Google event id is **[UNCERTAIN]** → match by time and attendees as the primary key, event id as a bonus.

Paths, in order of preference, all behind one adapter:

1. **API key connect** (flag `granola_api`, for Business users): the student pastes an API key; Orbit stores it encrypted, registers a webhook (per-account secret) pointing at `/api/webhooks/granola/<accountToken>`, and runs an initial pull of the last 90 days of notes (own notes only). On `note.generated`, fetch the note with transcript and ingest. Daily reconciliation pull catches missed webhooks.
2. **Share by email**: the student uses Granola's "Email" share, which opens a Gmail draft with the note body, addressed to their `notes-<token>@in.<domain>` address (shown with a copy button in onboarding step 7 and in Settings). Ingested as `granola_email`. Works on every plan.
3. **Paste**: the capture box accepts pasted Granola notes; the parser recognises Granola's headings.
4. Zapier is not built by Orbit; the API path covers the same plans.

Transcripts: stored in `meeting_notes.raw_text` up to 400 KB; the extraction task receives the summary plus the transcript (chunked if over 60k tokens, which is rare for a 30-minute chat).

---

## 6. Wispr Flow and voice capture

Facts [VERIFIED]: Wispr Flow has no public API for dictation history; its "Flow API" is an invite-only speech-to-text service for apps, not a data feed. There is an official read-only remote MCP server (`https://api.wisprflow.ai/connect/mcp`, OAuth) exposing Notetaker meetings, transcripts, scratchpad notes and calendar events, but not dictation history. Users can export their data (Settings → Data and Privacy → Download your data) as a ZIP containing dictation history, available 30 days. In-app history keeps 14 days.

Design [DECIDED]:

1. **Capture box is the integration.** Every place a note can be added in Orbit is a plain text area; Wispr Flow (or any dictation) types into it. The post-meeting prompt in the Today page ("Your chat with Priya ended 20 minutes ago. Talk it out:") opens the capture box with the person pre-selected.
2. **Export import**: Settings → Meeting notes → "Import Wispr Flow export": accepts the ZIP; the parser reads the dictation history file(s) (format pinned in Phase 5 from a real export → **[GAP]**), filters dictations longer than 40 words that mention a known person's name or occurred within 3 hours after a coffee-chat event, and ingests them as `meeting_notes (source wispr_export)` with a confirmation card per note.
3. **Remote MCP read** (flag `wispr_mcp`, v1.5 experiment): if the student uses Wispr's Notetaker, Orbit can read meetings and transcripts through the MCP server. Implementation: Orbit acts as an MCP client (`@modelcontextprotocol/sdk`) with OAuth (dynamic client registration if the server supports it → **[GAP]**), lists meetings since the last sync nightly, and ingests transcripts as `meeting_notes (source wispr_capture)`.

---

## 7. Fathom (recommended free notetaker, flag `fathom`)

Facts [VERIFIED]: REST API and webhooks on all plans including Free; webhook "new meeting content ready" carries transcript, summary, action items, with `calendar_invitees[] {name, email, is_external}`; HMAC-signed; 60 calls/minute. Adapter: API key connect, webhook registration, ingest as `meeting_notes (source fathom)` with attendees from `calendar_invitees`. Offered in onboarding step 7 as "Don't have Granola? Fathom is free and connects in one click".

Fireflies (GraphQL, 50 requests/day on Free) and Otter (Enterprise only) are not built in v1 [DECIDED].

---

## 8. Scheduling links

No calendar writes in v1. The student's `scheduling_link` (Calendly, Cal.com, Google appointment schedule) is inserted into drafts of kind `schedule`; when absent, drafts propose two concrete windows computed from free/busy in the student's calendar (`events.list` on `primary` is enough: find 30-minute gaps in the next 5 working days between 10:00 and 17:00 local, excluding events) [DEFAULT].

---

## 9. Sources (observed 2026-10-02)

Google: restricted scopes list https://support.google.com/cloud/answer/13464325 ; scopes https://developers.google.com/workspace/gmail/api/auth/scopes ; restricted-scope verification https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification ; user data policy https://developers.google.com/terms/api-services-user-data-policy ; assessment FAQ https://support.google.com/cloud/answer/13463817 ; CASA Tier 2 https://appdefensealliance.dev/casa/tier-2/tier2-overview ; testing status https://support.google.com/cloud/answer/15549945 ; Gmail push https://developers.google.com/workspace/gmail/api/guides/push ; sync https://developers.google.com/workspace/gmail/api/guides/sync ; quota https://developers.google.com/workspace/gmail/api/reference/quota ; Calendar discovery https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest ; Supabase provider tokens https://supabase.com/docs/guides/auth/social-login/auth-google ; Nylas shared app https://developer.nylas.com/docs/provider-guides/google/shared-gcp-app/ .

LinkedIn: OIDC https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 ; Connections API https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api ; Member Data Portability (3rd party) https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/ ; data export https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data ; PDL fields https://docs.peopledatalabs.com/docs/fields ; Coresignal data dictionary https://docs.coresignal.com/employee-api/clean-employee-api/data-dictionary-clean-employee-api ; Unipile hosted auth https://developer.unipile.com/docs/hosted-auth ; relations https://developer.unipile.com/docs/retrieving-users ; send https://developer.unipile.com/docs/send-messages ; invites https://developer.unipile.com/docs/invite-users ; limits https://developer.unipile.com/docs/provider-limits-and-restrictions ; pricing https://www.unipile.com/pricing-api/ ; Proxycurl shutdown https://nubela.co/blog/goodbye-proxycurl/ .

Granola: https://docs.granola.ai/introduction ; https://docs.granola.ai/api-reference/get-note ; https://docs.granola.ai/api-reference/get-transcript ; https://docs.granola.ai/api-reference/changelog ; pricing https://www.granola.ai/pricing ; MCP https://docs.granola.ai/help-center/sharing/integrations/mcp ; sharing https://docs.granola.ai/help-center/sharing/sharing-notes .

Wispr Flow: https://api-docs.wisprflow.ai/quickstart ; https://github.com/Wispr-AI/wispr-flow-plugin ; https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server ; data export https://docs.wisprflow.ai/articles/9609615338-private-cloud-sync-and-data-sharing-preferences-in-wispr-flow .

Fathom: https://developers.fathom.ai/webhooks ; https://developers.fathom.ai/api-reference/meetings/list-meetings . Fireflies limits https://docs.fireflies.ai/fundamentals/limits . Otter https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API .

Resend: https://resend.com/docs/webhooks/emails/received ; https://resend.com/docs/dashboard/receiving/get-email-content ; https://resend.com/pricing . Inngest https://www.inngest.com/pricing ; https://www.inngest.com/docs/durable-execution/flow-control . Voyage https://docs.voyageai.com/docs/pricing ; https://platform.claude.com/docs/en/build-with-claude/embeddings . Supabase HNSW https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes .
