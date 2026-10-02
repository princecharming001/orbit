# 10. Security, privacy and compliance

Status: build specification. The rules that keep a student's inbox, calendar, network and notes safe, and the obligations that come with Google and LinkedIn data.

---

## 1. Threat model (what we protect against)

| Threat | Control |
|---|---|
| Another user reads my data | tenant scoping in every repository call (lint-enforced), RLS for client reads, no shared caches keyed without user id |
| Token theft from the database | OAuth tokens and API keys encrypted with AES-256-GCM under `TOKEN_ENCRYPTION_KEY` (env, never in the DB); key rotation via `TOKEN_ENCRYPTION_KEY_PREVIOUS`; decrypt only in the integrations package |
| Someone sends mail as me | sends require an approval row bound to the body hash, created by a server action under my session; webhooks and jobs cannot create approvals |
| Prompt injection via an email or note makes the system do something | models have no tools; extraction outputs are enums and short strings; drafts are validated; untrusted content is wrapped and labelled |
| Webhook spoofing | Pub/Sub push verified with Google OIDC tokens (audience check); Resend, Granola, Fathom, Unipile signatures verified with per-account or per-app secrets; replay prevented by `webhook_events` uniqueness |
| Mass data extraction via the export endpoint | export is per-user, rate limited (1 per 24 h), signed URL 24 h |
| LLM provider data use | Anthropic API data is not used for training by default; Orbit never sends more than the context pack; 30-day retention on Anthropic's side per their policy (confirm current terms) [GAP] |
| Enrichment provider leakage | only the LinkedIn URL or a hashed email is sent; never names from the student's inbox, never message content |
| Account takeover | Supabase Auth with Google only (no passwords); session cookies `HttpOnly`, `Secure`, `SameSite=Lax`; sensitive actions (disconnect, delete, export) re-check the session age < 24 h |

---

## 2. Google API Services User Data Policy (Limited Use)

Orbit's use of Gmail and Calendar data is limited to user-facing features visible in the product: reading threads to track and summarise the student's own networking conversations, sending messages the student approved, and reading events to detect and prepare for meetings. Specifically:

- No human at Orbit reads user data except with the user's explicit consent for support, or for security/abuse investigation, or as required by law.
- No transfer to third parties except as needed to provide the feature (Anthropic for processing, Resend for delivering the student's own notifications, enrichment providers receive no Google data), with no advertising use, no sale, and no use for training generalised models.
- The privacy policy page states these points in the exact structure Google's verification expects, and the consent screen links it. [VERIFIED requirements, 04 section 2.2]
- Disconnect deletes Google-derived content within 24 hours (03 section 6).

## 3. LinkedIn

- Orbit does not access LinkedIn except (a) OIDC sign-in data, (b) files the user exports and uploads themselves, (c) licensed enrichment providers, (d) when the user explicitly enables the flagged messaging integration, which the UI explains is the user's own session via a third party and may conflict with LinkedIn's User Agreement. The product does not scrape LinkedIn. [DECIDED]
- Enrichment data about third parties (the student's contacts) is professional, public-profile-derived data from licensed providers; it is cached 90 days, shown only to the user who has that person in their network, and deleted with the user's account. A contact who asks to be removed is handled by support via a global suppression list keyed by LinkedIn slug/email hash (`suppressed_identities` table added in Phase 7) [DEFAULT].

## 4. Email sending

Messages are sent from the student's own Gmail to individuals they chose, after approval; this is personal correspondence, not commercial bulk email. Orbit's own notification emails (Resend) are transactional, carry unsubscribe links per kind, and respect bounces/complaints (suppression via Resend).

## 5. Data classification and handling

| Class | Examples | Storage | Logs |
|---|---|---|---|
| Secrets | OAuth tokens, API keys, webhook secrets | encrypted columns | never |
| Content | email bodies, transcripts, notes, drafts | plaintext in Postgres (encrypted at rest by Supabase), 18/12-month retention | never (ids only) |
| Derived | facts, summaries, signals, embeddings | Postgres | never |
| Metadata | headers, timestamps, counts | Postgres | ids and counts only |
| Identity | names, emails, LinkedIn URLs | Postgres; hashed in analytics (PostHog receives user id hash only, no names) | hashed |

Sentry scrubs request bodies; breadcrumbs carry ids only. Langfuse traces store prompts and outputs (needed for evals) in a project with access limited to the founder; traces are deleted after 90 days; users can opt out of trace retention in Settings → Privacy (then traces are recorded with inputs redacted). [DEFAULT]

## 6. Access control inside the company

Production database access only through Supabase dashboard with 2FA and the founder's account; a `read_only` role for analytics without content columns (view `people_meta`, `chats_meta`). All access is logged by Supabase.

## 7. Student-facing privacy page (`/privacy`) must list

What is read (Gmail threads with people, Calendar events, LinkedIn export, resume, notes), what is derived, who processes it (Anthropic, Voyage, Resend, People Data Labs, Coresignal when enabled, Unipile when enabled, Granola/Fathom when connected, Vercel, Supabase, Inngest, Sentry, PostHog, Langfuse), retention, how to export and delete, that nothing is sent without approval, and contact details.

## 8. Incident response (minimum)

Kill switches in `feature_flags`: `sends_enabled` (stops all sends), `syncs_enabled`, `llm_enabled`. Runbook in `12` section 7. A credential leak triggers: rotate `TOKEN_ENCRYPTION_KEY` (re-encrypt job), revoke affected Google tokens (users re-consent), rotate provider keys, notify users within 72 hours if their data was exposed.
