# 03. Data model

Status: build specification, foundation document. Every table, column, enum and function name used anywhere in `docs/orbit/` is defined here. Code does not invent tables. If a later document needs a column that is not here, it adds a "Schema additions" section with DDL in these conventions and the DDL is merged here before the migration is written.

Conventions: `02-architecture.md` section 5.1. `uid` below means `uuid not null references users(id) on delete cascade`. `ts` means `timestamptz not null default now()`. Every table also has `created_at ts` and `updated_at ts` even where not repeated.

---

## 1. Entity map

```
users ─┬─ user_settings (1:1)
       ├─ recruiting_goals (1:1) ─ target_companies ─▶ organizations
       ├─ resumes ─ resume_facets
       ├─ integration_accounts ─ sync_runs
       ├─ people ─┬─ person_identities
       │          ├─ affiliations ─▶ organizations / schools
       │          ├─ person_facts
       │          ├─ touchpoints ─▶ (email_messages | calendar_events | linkedin_messages | meeting_notes | outbound_messages)
       │          ├─ coffee_chats ─┬─ coffee_chat_stage_events
       │          │                ├─ meeting_notes ─ action_items
       │          │                └─ outbound_messages
       │          └─ edges (person ↔ person)
       ├─ email_threads ─ email_messages
       ├─ calendar_events
       ├─ linkedin_messages
       ├─ suggestions ─▶ outbound_messages ; briefs
       ├─ recommendations ; reach_queries
       ├─ style_profiles ; feedback_events ; notifications ; audit_log ; ai_calls
       └─ merge_suggestions ; person_merges ; deletion_requests
global: organizations, organization_aliases, schools, enrichment_cache, embeddings (mixed), prompt_versions, feature_flags, webhook_events
```

---

## 2. Enums

```sql
create type integration_provider_enum as enum ('google','linkedin_csv','unipile_linkedin','granola','fathom','wispr_export','tracker_import');
create type integration_status_enum as enum ('active','needs_reauth','revoked','error','instructions_shown');
create type sync_kind_enum as enum ('backfill_fast','backfill_full','incremental','webhook','manual');
create type sync_status_enum as enum ('running','succeeded','failed','partial');
create type identity_kind_enum as enum ('email','linkedin_url','linkedin_member_id','phone','unipile_provider_id','granola_attendee');
create type person_source_enum as enum ('gmail','calendar','linkedin_csv','unipile','enrichment','tracker_import','manual','note','recommendation');
create type relationship_type_enum as enum ('unknown','recruiter','alumni','peer','mentor','professor','family_friend','colleague','other');
create type affiliation_kind_enum as enum ('employment','education');
create type edge_type_enum as enum ('co_tenure','same_school_cohort','email_cothread','meeting_coattendee','introduced_by','linkedin_mutual','same_current_company');
create type touchpoint_kind_enum as enum ('email_in','email_out','email_cc','meeting','linkedin_in','linkedin_out','linkedin_connected','linkedin_engaged','note','manual_log','intro_observed');
create type chat_stage_enum as enum ('identified','warming','outreach_sent','replied','scheduling','scheduled','completed','followed_up','nurturing','declined','no_response','archived');
create type chat_source_enum as enum ('recommendation','manual','detected','tracker_import','reach');
create type stage_event_status_enum as enum ('applied','proposed','confirmed','rejected');
create type actor_enum as enum ('system','user');
create type note_source_enum as enum ('granola_api','granola_email','fathom','wispr_capture','wispr_export','manual','email_ingest','upload','tracker_import');
create type note_match_status_enum as enum ('auto','confirmed','unmatched','rejected');
create type fact_type_enum as enum ('role_detail','background','advice','personal','offer','hook','preference','ask_made','contact_info');
create type action_item_status_enum as enum ('open','done','dismissed');
create type suggestion_kind_enum as enum ('new_outreach','warm_up_engage','follow_up_bump','schedule_propose','schedule_confirm','prep_brief','thank_you','action_item_reminder','nurture_checkin','reconnect','congratulate','ask_referral','intro_request','confirm_stage','confirm_merge','confirm_note_match');
create type suggestion_status_enum as enum ('pending','approved','edited','snoozed','dismissed','sent','expired','done');
create type channel_enum as enum ('gmail','linkedin','clipboard');   -- 'clipboard' is reserved for a future copy-only channel; v1 LinkedIn copy-and-open uses 'linkedin' with provider_message_id null (04 §3.4)
create type outbound_status_enum as enum ('draft','approved','queued','sending','sent','failed','cancelled');
create type message_kind_enum as enum ('outreach','bump','schedule','thank_you','nurture','congratulate','referral_ask','intro_request','reply');
create type recommendation_status_enum as enum ('new','saved','dismissed','converted','expired');
create type brief_kind_enum as enum ('welcome','daily','recap');
create type feedback_kind_enum as enum ('approve','edit','dismiss','snooze','expire','thumbs_up','thumbs_down','stage_confirm','stage_correct','merge_accept','merge_reject','fact_delete','recommendation_dismiss','note_match_confirm','note_match_reject');
create type notification_kind_enum as enum ('brief','reply_received','chat_tomorrow','action_item_due','integration_problem','weekly_recap','system');
create type embedding_kind_enum as enum ('person_profile','resume_facet','org_profile','note_chunk','goal','fact','candidate_profile');
create type email_direction_enum as enum ('inbound','outbound');
create type email_category_enum as enum ('networking','recruiting_process','personal','transactional','newsletter','automated','other');
create type reply_signal_enum as enum ('reply_positive','reply_neutral','reply_decline','scheduling_proposal','scheduling_confirmation','reschedule','thank_you','referral_offer','intro_offer','question','out_of_office','other');
```

---

## 3. Tables

### 3.1 users

Mirrors `auth.users` (created by trigger `handle_new_auth_user()` on insert into `auth.users`).

```sql
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null unique,
  full_name text,
  first_name text, last_name text,
  avatar_url text,
  school_id uuid references schools(id),
  school_name_raw text,
  graduation_year int, graduation_month int,
  degree text, majors text[] default '{}',
  home_city text, current_city text,
  timezone text not null default 'America/New_York',
  linkedin_url text,
  onboarding_step int not null default 1,          -- 1..10 per 01 section 4.1; 11 = done
  onboarding_completed_at timestamptz,
  last_seen_at timestamptz,
  created_at ts, updated_at ts
);
```
RLS: `select` own row. Realtime: no.

### 3.2 user_settings

```sql
create table user_settings (
  user_id uid primary key,
  brief_time_local time not null default '07:00',
  brief_channels text[] not null default '{email,in_app}',   -- subset of {email,in_app,push}
  quiet_days int[] not null default '{}',                     -- 0=Sun..6=Sat, no brief delivered
  weekly_outreach_target int not null default 4,
  daily_send_cap_gmail int not null default 15,
  daily_send_cap_linkedin int not null default 10,
  per_person_cooldown_hours int not null default 72,
  max_bumps int not null default 2,
  tone_preset text not null default 'warm',                   -- warm|direct|formal, used until style card exists
  scheduling_link text,
  notification_prefs jsonb not null default '{}',             -- schema NotificationPrefs
  enrichment_monthly_cap int not null default 100,
  created_at ts, updated_at ts
);
```

### 3.3 recruiting_goals and target_companies

```sql
create table recruiting_goals (
  user_id uid primary key,
  cycle_label text not null,                 -- "Summer 2027 internship"
  cycle_start date, cycle_end date,
  target_roles text[] not null default '{}',
  target_functions text[] not null default '{}',   -- normalised: swe, pm, ib, consulting, data, design, ...
  target_industries text[] not null default '{}',
  target_locations text[] not null default '{}',
  free_text text,
  structured jsonb not null default '{}',   -- schema RecruitingGoalsStructured (output of task goal_structuring)
  ambition int not null default 2,           -- 1..3 maps to weekly target 2/4/7
  created_at ts, updated_at ts
);

create table target_companies (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  organization_id uuid references organizations(id),
  name_raw text not null,
  priority int not null default 2,           -- 1 high, 2 normal, 3 low
  status text not null default 'researching',-- free text from a closed UI list: researching|applied|interviewing|offer|closed
  deadline date,
  notes text,
  created_at ts, updated_at ts,
  unique (user_id, organization_id)
);
create index on target_companies (user_id, priority);
```

### 3.4 resumes and resume_facets

```sql
create table resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  storage_path text not null,                -- bucket resumes/<user_id>/<id>.pdf
  original_filename text not null,
  mime_type text not null,
  parsed jsonb,                              -- schema ResumeParsed
  parsed_at timestamptz,
  parse_error text,
  is_current boolean not null default true,
  created_at ts, updated_at ts
);
create unique index resumes_one_current on resumes (user_id) where is_current;

create table resume_facets (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  resume_id uuid not null references resumes(id) on delete cascade,
  kind text not null,                        -- experience|education|project|skill_group|interest|summary
  title text, organization_name text, organization_id uuid references organizations(id),
  start_date date, end_date date,
  text text not null,                        -- the facet as one paragraph, embedded
  keywords text[] not null default '{}',
  confirmed boolean not null default false,
  created_at ts, updated_at ts
);
create index on resume_facets (user_id, resume_id);
```

### 3.5 integration_accounts, sync_runs, webhook_events

```sql
create table integration_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  provider integration_provider_enum not null,
  external_account_id text,                  -- google: email; unipile: account_id; granola: key fingerprint
  status integration_status_enum not null default 'active',
  scopes text[] not null default '{}',
  access_token_enc bytea, refresh_token_enc bytea, token_expires_at timestamptz,
  api_key_enc bytea,                         -- granola, fathom
  webhook_secret_enc bytea,
  ingest_token text unique,                  -- notes ingest address token (notes-<token>@in.<domain>); present only on the row with provider 'granola' (one per user, created at onboarding step 7)
  sync_state jsonb not null default '{}',    -- schema per provider: GoogleSyncState {gmailHistoryId, watchExpiration, calendarSyncToken, backfillCursor, backfillDone}
  last_synced_at timestamptz,
  last_error text, error_count int not null default 0,
  connected_at ts,
  disconnected_at timestamptz,
  created_at ts, updated_at ts,
  unique (user_id, provider, external_account_id)
);
create index on integration_accounts (provider, status);

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  account_id uuid not null references integration_accounts(id) on delete cascade,
  kind sync_kind_enum not null,
  status sync_status_enum not null default 'running',
  started_at ts, finished_at timestamptz,
  stats jsonb not null default '{}',         -- {threadsSeen, messagesStored, llmCalls, skipped, errors[]}
  inngest_run_id text,
  error text,
  created_at ts, updated_at ts
);
create index on sync_runs (account_id, started_at desc);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                    -- gmail_pubsub|resend|granola|unipile|fathom
  external_id text not null,                 -- message id / event id; unique per provider
  payload jsonb not null,
  received_at ts,
  processed_at timestamptz,
  error text,
  unique (provider, external_id)
);
```

### 3.6 organizations, organization_aliases, schools (global)

```sql
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_normalized text not null,             -- lower, unaccent, strip legal suffixes (inc, llc, ltd, corp)
  domains text[] not null default '{}',
  linkedin_slug text,                        -- from linkedin.com/company/<slug>
  industry text, size_bucket text,           -- 1-10,11-50,51-200,201-500,501-1000,1001-5000,5001-10000,10001+
  hq_location text, logo_url text, description text,
  enrichment jsonb, enriched_at timestamptz,
  created_at ts, updated_at ts
);
create unique index on organizations (name_normalized);
create index on organizations using gin (domains);
create index on organizations using gin (name_normalized gin_trgm_ops);

create table organization_aliases (
  alias_normalized text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  source text not null                       -- seed|enrichment|user
);

create table schools (
  id uuid primary key default gen_random_uuid(),
  name text not null, name_normalized text not null unique,
  domains text[] not null default '{}',      -- edu domains
  linkedin_slug text, city text, state text,
  created_at ts, updated_at ts
);
```
Seed: ~4,000 US institutions (IPEDS list) and ~5,000 organizations (Fortune 1000 + top employers of new grads + common startups), with aliases. Seeds live in `packages/db/seeds/*.csv`.

### 3.7 people, person_identities, affiliations

```sql
create table people (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  display_name text not null,
  first_name text, last_name text,
  name_normalized text not null,             -- for blocking
  primary_email citext,
  linkedin_url text,                         -- normalised https://www.linkedin.com/in/<slug>
  headline text,
  current_title text,
  current_organization_id uuid references organizations(id),
  current_organization_raw text,
  location text,
  photo_url text,
  school_id uuid references schools(id), school_raw text,
  is_alumni boolean,                         -- same school as user, computed
  relationship_type relationship_type_enum not null default 'unknown',
  strength real not null default 0,          -- 0..1, see 06 section 3
  strength_breakdown jsonb not null default '{}',
  strength_updated_at timestamptz,
  first_seen_at timestamptz, last_interaction_at timestamptz,
  interaction_count int not null default 0,
  sources person_source_enum[] not null default '{}',
  linkedin_connected_on date,
  is_human boolean not null default true,    -- false for automated senders (noreply, lists)
  hidden_at timestamptz,
  enriched_at timestamptz, enrichment_provider text,
  summary text, summary_updated_at timestamptz, summary_sources jsonb,
  talking_points jsonb,                      -- string[]
  tags text[] not null default '{}',
  notes text,
  created_at ts, updated_at ts
);
create index on people (user_id, name_normalized);
create index on people (user_id, strength desc);
create index on people (user_id, current_organization_id);
create index on people (user_id, last_interaction_at desc);
create index on people using gin (display_name gin_trgm_ops);   -- combined with the user_id filter at query time

create table person_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid not null references people(id) on delete cascade,
  kind identity_kind_enum not null,
  value_normalized text not null,
  source person_source_enum not null,
  confidence real not null default 1,
  created_at ts, updated_at ts,
  unique (user_id, kind, value_normalized)
);
create index on person_identities (person_id);

create table affiliations (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid not null references people(id) on delete cascade,
  kind affiliation_kind_enum not null,
  organization_id uuid references organizations(id),
  school_id uuid references schools(id),
  name_raw text not null,
  title text, degree text, field text,
  start_date date, end_date date, is_current boolean not null default false,
  source person_source_enum not null,
  created_at ts, updated_at ts
);
create index on affiliations (user_id, organization_id);
create index on affiliations (user_id, school_id);
create index on affiliations (person_id);
```

### 3.8 person_merges and merge_suggestions

```sql
create table merge_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_a_id uuid not null references people(id) on delete cascade,
  person_b_id uuid not null references people(id) on delete cascade,
  score real not null,
  features jsonb not null,                   -- schema MergeFeatures
  status text not null default 'pending',    -- pending|accepted|rejected|stale
  decided_at timestamptz,
  created_at ts, updated_at ts,
  unique (user_id, person_a_id, person_b_id)
);

create table person_merges (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  survivor_id uuid not null references people(id) on delete cascade,
  merged_snapshot jsonb not null,            -- full row + identities + affiliations of the merged person, for undo
  merged_person_id uuid not null,            -- id of the removed row (not a FK; row is gone)
  decided_by actor_enum not null,
  score real, features jsonb,
  undone_at timestamptz,
  created_at ts, updated_at ts
);
```

### 3.9 edges

Person-to-person relationships inside one user's network (user-to-person strength lives on `people.strength`).

```sql
create table edges (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_a_id uuid not null references people(id) on delete cascade,
  person_b_id uuid not null references people(id) on delete cascade,  -- a < b enforced by check (person_a_id < person_b_id)
  type edge_type_enum not null,
  weight real not null,                      -- 0..1
  evidence jsonb not null,                   -- schema EdgeEvidence: {orgId, overlapMonths, threadIds[], eventIds[], ...}
  computed_at ts,
  created_at ts, updated_at ts,
  check (person_a_id < person_b_id),
  unique (user_id, person_a_id, person_b_id, type)
);
create index on edges (user_id, person_a_id);
create index on edges (user_id, person_b_id);
```

### 3.10 email_threads and email_messages

```sql
create table email_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  account_id uuid not null references integration_accounts(id) on delete cascade,
  gmail_thread_id text not null,
  subject text,
  snippet text,
  first_message_at timestamptz, last_message_at timestamptz,
  message_count int not null default 0,
  participant_emails citext[] not null default '{}',
  participant_person_ids uuid[] not null default '{}',
  category email_category_enum,
  category_confidence real,
  is_networking boolean not null default false,
  chat_id uuid,                              -- set when linked to coffee_chats (FK added after that table)
  classified_at timestamptz,
  created_at ts, updated_at ts,
  unique (account_id, gmail_thread_id)
);
create index on email_threads (user_id, last_message_at desc);
create index on email_threads (user_id, is_networking) where is_networking;

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  thread_id uuid not null references email_threads(id) on delete cascade,
  gmail_message_id text not null,
  direction email_direction_enum not null,
  from_email citext not null, from_name text,
  to_emails citext[] not null default '{}', cc_emails citext[] not null default '{}',
  from_person_id uuid references people(id) on delete set null,
  sent_at timestamptz not null,
  subject text,
  body_text text,                            -- plain text, quoted replies stripped; original kept in body_text_full only if < 50 KB
  body_text_full text,
  headers jsonb not null default '{}',       -- subset: message-id, in-reply-to, references, list-unsubscribe, precedence, auto-submitted
  has_attachments boolean not null default false,
  is_automated boolean not null default false,
  signal reply_signal_enum,
  signal_confidence real,
  extraction jsonb,                          -- schema MessageExtraction (proposed times, asks, signature contact info)
  processed_at timestamptz,
  created_at ts, updated_at ts,
  unique (thread_id, gmail_message_id)
);
create index on email_messages (user_id, sent_at desc);
create index on email_messages (from_person_id, sent_at desc);
```

### 3.11 calendar_events

```sql
create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  account_id uuid not null references integration_accounts(id) on delete cascade,
  gcal_event_id text not null, ical_uid text,
  title text, description text,
  start_at timestamptz not null, end_at timestamptz not null,
  status text not null,                      -- confirmed|tentative|cancelled
  attendees jsonb not null default '[]',     -- [{email, displayName, responseStatus, self, organizer}]
  attendee_person_ids uuid[] not null default '{}',
  conference_url text,
  is_coffee_chat boolean, coffee_chat_confidence real,
  chat_id uuid,
  processed_at timestamptz,
  created_at ts, updated_at ts,
  unique (account_id, gcal_event_id)
);
create index on calendar_events (user_id, start_at);
```

### 3.12 linkedin_messages

```sql
create table linkedin_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  account_id uuid references integration_accounts(id) on delete cascade,
  external_id text,                          -- unipile message id or csv row hash
  person_id uuid references people(id) on delete set null,
  direction email_direction_enum not null,
  sent_at timestamptz not null,
  body text,
  source person_source_enum not null,        -- unipile|linkedin_csv|manual
  signal reply_signal_enum, signal_confidence real,
  processed_at timestamptz,
  created_at ts, updated_at ts,
  unique (user_id, source, external_id)
);
create index on linkedin_messages (person_id, sent_at desc);
```

### 3.13 touchpoints

The unified timeline. Written by processors; read by strength computation, the profile timeline and the drafting context.

```sql
create table touchpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid not null references people(id) on delete cascade,
  kind touchpoint_kind_enum not null,
  occurred_at timestamptz not null,
  ref_table text not null,                   -- email_messages|calendar_events|linkedin_messages|meeting_notes|outbound_messages|manual
  ref_id uuid not null,
  summary text,                              -- one line for the timeline
  weight real not null,                      -- base weight by kind, see 06 section 3
  created_at ts, updated_at ts,
  unique (user_id, person_id, ref_table, ref_id)
);
create index on touchpoints (user_id, person_id, occurred_at desc);
create index on touchpoints (user_id, occurred_at desc);
```

### 3.14 coffee_chats and coffee_chat_stage_events

```sql
create table coffee_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid not null references people(id) on delete cascade,
  organization_id uuid references organizations(id),
  stage chat_stage_enum not null default 'identified',
  stage_entered_at ts,
  source chat_source_enum not null,
  goal_tags text[] not null default '{}',
  outreach_channel channel_enum,
  first_outreach_at timestamptz, last_outbound_at timestamptz, last_inbound_at timestamptz,
  bump_count int not null default 0,
  scheduled_event_id uuid references calendar_events(id) on delete set null,
  completed_at timestamptz, followed_up_at timestamptz,
  thread_id uuid references email_threads(id) on delete set null,
  warm_up jsonb,                             -- schema WarmUpPlan (13 §4), null unless stage passed through 'warming'
  outcome jsonb,                             -- schema ChatOutcome: {referralOffered, introOffered, rating, notes}
  priority int not null default 2,
  archived_at timestamptz,
  created_at ts, updated_at ts
);
create index on coffee_chats (user_id, stage);
create index on coffee_chats (user_id, person_id);
create unique index coffee_chats_one_active on coffee_chats (user_id, person_id) where stage not in ('declined','no_response','archived');
alter table email_threads add constraint email_threads_chat_fk foreign key (chat_id) references coffee_chats(id) on delete set null;
alter table calendar_events add constraint calendar_events_chat_fk foreign key (chat_id) references coffee_chats(id) on delete set null;

create table coffee_chat_stage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  chat_id uuid not null references coffee_chats(id) on delete cascade,
  from_stage chat_stage_enum, to_stage chat_stage_enum not null,
  status stage_event_status_enum not null default 'applied',
  actor actor_enum not null,
  reason text not null,                      -- machine reason code, e.g. inbound_signal:scheduling_proposal
  evidence_ref_table text, evidence_ref_id uuid,
  confidence real,
  decided_at timestamptz,
  created_at ts, updated_at ts
);
create index on coffee_chat_stage_events (chat_id, created_at desc);
create index on coffee_chat_stage_events (user_id, status) where status = 'proposed';
```

### 3.15 meeting_notes, person_facts, action_items

```sql
create table meeting_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  source note_source_enum not null,
  external_id text,                          -- granola note id, resend email id, fathom recording id, upload hash
  title text,
  occurred_at timestamptz,
  raw_text text not null,                    -- notes or transcript as received (transcript may be large; cap 400 KB, keep summary beyond)
  raw_summary text,                          -- provider summary if any (granola summary_markdown)
  attendees jsonb not null default '[]',     -- [{name, email}]
  person_ids uuid[] not null default '{}',
  chat_id uuid references coffee_chats(id) on delete set null,
  calendar_event_id uuid references calendar_events(id) on delete set null,
  match_status note_match_status_enum not null default 'unmatched',
  match_confidence real,
  extraction jsonb,                          -- schema NoteExtraction
  summary text,
  processed_at timestamptz,
  created_at ts, updated_at ts,
  unique (user_id, source, external_id)
);
create index on meeting_notes (user_id, occurred_at desc);

create table person_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid not null references people(id) on delete cascade,
  type fact_type_enum not null,
  text text not null,
  source_table text not null, source_id uuid not null,
  occurred_at timestamptz,
  confidence real not null default 0.8,
  superseded_by uuid references person_facts(id) on delete set null,
  deleted_at timestamptz,                    -- user deleted; never regenerate from the same source
  created_at ts, updated_at ts
);
create index on person_facts (user_id, person_id) where deleted_at is null and superseded_by is null;

create table action_items (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid references people(id) on delete cascade,
  chat_id uuid references coffee_chats(id) on delete cascade,
  text text not null,
  owner actor_enum not null default 'user',  -- 'user' = the student owes it; 'system' unused; the other party's promises are facts of type 'offer'
  due_at timestamptz,
  status action_item_status_enum not null default 'open',
  source_table text, source_id uuid,
  created_at ts, updated_at ts
);
create index on action_items (user_id, status, due_at);
```

### 3.16 suggestions, briefs, outbound_messages

```sql
create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid not null references people(id) on delete cascade,
  chat_id uuid references coffee_chats(id) on delete set null,
  suggestion_id uuid,                        -- FK added below
  channel channel_enum not null,
  kind message_kind_enum not null,
  gmail_thread_id text, in_reply_to_message_id text,  -- for replies
  to_email citext, to_linkedin_url text,
  subject text,
  body_draft text not null,                  -- as generated
  body_final text,                           -- as approved (after edits)
  body_final_hash text,                      -- sha256 of body_final, bound at approval
  status outbound_status_enum not null default 'draft',
  approved_at timestamptz, approved_by uuid,
  queued_at timestamptz, sent_at timestamptz,
  provider_message_id text,
  error text, attempt_count int not null default 0,
  idempotency_key text unique,
  prompt_version text, generation_meta jsonb,   -- {model, inputTokens, factsUsed[], exemplarIds[]}
  created_at ts, updated_at ts
);
create index on outbound_messages (user_id, status);
create index on outbound_messages (person_id, sent_at desc);

create table briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  kind brief_kind_enum not null,
  brief_date date not null,
  generated_at timestamptz, delivered_at timestamptz, opened_at timestamptz,
  channels text[] not null default '{}',
  summary_text text,
  stats jsonb not null default '{}',         -- {candidates, shown, approved, ...}
  resend_email_id text,
  created_at ts, updated_at ts,
  unique (user_id, kind, brief_date)
);

create table suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  kind suggestion_kind_enum not null,
  person_id uuid references people(id) on delete cascade,
  chat_id uuid references coffee_chats(id) on delete cascade,
  outbound_message_id uuid references outbound_messages(id) on delete set null,
  brief_id uuid references briefs(id) on delete set null,
  priority_score real not null,
  reason_text text not null,                 -- one sentence shown to the user
  signals jsonb not null,                    -- schema SuggestionSignals: the features that produced the score
  payload jsonb not null default '{}',       -- kind-specific: proposed times, prep doc id, target person id, stage event id, merge id
  status suggestion_status_enum not null default 'pending',
  dedupe_key text not null,                  -- kind:person:window, prevents duplicates across days
  snoozed_until timestamptz,
  carried_over int not null default 0,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at ts, updated_at ts,
  unique (user_id, dedupe_key)
);
create index on suggestions (user_id, status, priority_score desc);
alter table outbound_messages add constraint outbound_messages_suggestion_fk foreign key (suggestion_id) references suggestions(id) on delete set null;
```

### 3.17 recommendations and reach_queries

```sql
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  person_id uuid references people(id) on delete cascade,     -- set once the candidate is materialised as a person
  candidate jsonb,                           -- schema CandidateProfile when from enrichment search and not yet a person
  candidate_key text not null,               -- linkedin_url or email or provider id; dedupe
  score real not null,
  fit_score real, reach_score real, response_prior real, novelty real,
  reasons jsonb not null,                    -- [{code, text}]
  best_path jsonb,                           -- schema ReachPath
  status recommendation_status_enum not null default 'new',
  dismissed_reason text,
  batch_date date not null,
  created_at ts, updated_at ts,
  unique (user_id, candidate_key)
);
create index on recommendations (user_id, status, score desc);

create table reach_queries (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  query_text text not null,
  target_kind text not null,                 -- person|organization
  target_person_id uuid references people(id) on delete set null,
  target_candidate jsonb,
  target_organization_id uuid references organizations(id),
  paths jsonb not null,                      -- ReachPath[]
  created_at ts, updated_at ts
);
create index on reach_queries (user_id, created_at desc);
```

### 3.18 style_profiles, feedback_events, notifications, audit_log

```sql
create table style_profiles (
  user_id uid primary key,
  style_card jsonb not null,                 -- schema StyleCard
  exemplar_message_ids uuid[] not null default '{}',   -- email_messages ids (outbound) chosen as few-shot
  version int not null default 1,
  built_from_count int not null default 0,
  created_at ts, updated_at ts
);

create table feedback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  kind feedback_kind_enum not null,
  suggestion_id uuid references suggestions(id) on delete set null,
  outbound_message_id uuid references outbound_messages(id) on delete set null,
  recommendation_id uuid references recommendations(id) on delete set null,
  ref_table text, ref_id uuid,
  reason text,
  edit_before text, edit_after text, edit_distance int,
  context jsonb not null default '{}',
  created_at ts, updated_at ts
);
create index on feedback_events (user_id, created_at desc);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  kind notification_kind_enum not null,
  title text not null, body text, link text,
  read_at timestamptz,
  delivered jsonb not null default '{}',     -- {email: resendId, push: ...}
  created_at ts, updated_at ts
);
create index on notifications (user_id, created_at desc) where read_at is null;

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uid,
  actor actor_enum not null,
  action text not null,                      -- message.sent, token.granted, token.revoked, data.exported, account.deleted, merge.applied, ...
  object_table text, object_id uuid,
  metadata jsonb not null default '{}',
  created_at ts
);
create index on audit_log (user_id, created_at desc);
```

### 3.19 embeddings, enrichment_cache, ai_calls, prompt_versions, feature_flags, deletion_requests

```sql
create table embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,   -- null for global objects (org_profile, candidate_profile cache)
  kind embedding_kind_enum not null,
  object_id uuid not null,
  model text not null default 'voyage-4',
  text_hash text not null,
  embedding vector(1024) not null,
  created_at ts, updated_at ts,
  unique (kind, object_id, model)
);
create index embeddings_hnsw on embeddings using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index on embeddings (user_id, kind);

create table enrichment_cache (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                    -- pdl|coresignal
  lookup_kind text not null,                 -- linkedin_url|email_sha256|name_company
  lookup_key text not null,
  status text not null,                      -- hit|miss|error
  payload jsonb,                             -- provider response (normalised to schema EnrichedPerson in payload.normalized)
  cost_usd_micros bigint not null default 0,
  fetched_at ts, expires_at timestamptz not null,
  unique (provider, lookup_kind, lookup_key)
);

create table ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  task text not null,
  prompt_version text not null,
  model text not null,
  mode text not null,                        -- realtime|batch
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
  cost_usd_micros bigint,
  latency_ms int,
  status text not null,                      -- ok|refusal|error|parse_error
  trace_id text,
  ref_table text, ref_id uuid,
  created_at ts
);
create index on ai_calls (user_id, created_at desc);
create index on ai_calls (task, created_at desc);

create table prompt_versions (
  name text not null, version text not null, hash text not null,
  created_at ts,
  primary key (name, version)
);

create table feature_flags (
  key text primary key, enabled boolean not null default false,
  user_allowlist uuid[] not null default '{}', note text, updated_at ts
);

create table deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                     -- not FK: survives the user row
  email citext not null,
  requested_at ts, grace_until timestamptz not null, completed_at timestamptz,
  receipt_sent_at timestamptz
);
```

---

## 4. Database functions and triggers

| Name | Purpose |
|---|---|
| `set_updated_at()` | trigger on every table with `updated_at` |
| `handle_new_auth_user()` | trigger on `auth.users` insert → insert `users` + `user_settings` |
| `apply_stage_transition(chat_id, to_stage, actor, reason, evidence_table, evidence_id, confidence)` | inserts `coffee_chat_stage_events`; if `confidence >= 0.8` or actor = 'user' sets `status='applied'`, updates `coffee_chats.stage`, `stage_entered_at`, denormalised timestamps; else inserts with `status='proposed'` and returns the event id for a `confirm_stage` suggestion. Rejects illegal transitions per `05` section 6 (the transition table lives in `packages/core/src/pipeline/transitions.ts` and is mirrored as a SQL check in this function; a test asserts both agree). |
| `bind_approval(outbound_message_id, user_id, body_final)` | sets `body_final`, `body_final_hash`, `status='approved'`, `approved_at`, `approved_by`; raises if status is not `draft` |
| `check_send_allowed(user_id, person_id, channel)` | returns `{allowed boolean, reason text}` applying: daily cap by channel (count `sent` today in user tz), per-person cooldown (last `sent` to this person within `per_person_cooldown_hours` and no inbound since), `max_bumps` for kind `bump`, chat stage not `declined`, person not hidden |
| `recompute_person_strength(person_id)` | computes strength from `touchpoints` with the decay in `06` section 3 (also implemented in `core` for batch recompute; SQL version used by triggers on touchpoint insert) |
| `merge_people(user_id, survivor_id, merged_id, actor, score, features)` | snapshots the merged row, repoints identities, affiliations, touchpoints, facts, chats, edges (dedupe), threads, events, messages; inserts `person_merges`; deletes the merged row |
| `undo_merge(merge_id)` | restores from snapshot; repoints rows whose `ref` was repointed (uses the snapshot's id lists) |
| `purge_user(user_id)` | hard-deletes everything (cascade from `users`) plus storage objects via the app (storage deletion is done in the job, not SQL), writes `deletion_requests.completed_at` |

---

## 5. RLS summary

| Table group | `authenticated` select own rows | Notes |
|---|---|---|
| `notifications`, `suggestions`, `briefs`, `coffee_chats`, `sync_runs`, `integration_accounts` (columns via view `integration_accounts_public` without token columns) | yes | Realtime subscriptions for live updates |
| every other user-scoped table | no policies for `authenticated` (deny) | server only |
| global tables | `select` for `authenticated` on `organizations`, `schools`, `feature_flags` | autocomplete from the client |

Service role bypasses RLS; the repository layer enforces scope (02 section 5.1).

---

## 6. Retention and deletion

| Data | Retention | Mechanism |
|---|---|---|
| `email_messages.body_text_full` | 18 months rolling | nightly job nulls the column; `body_text` (stripped, ≤ 8 KB) kept while the account exists |
| `meeting_notes.raw_text` transcripts over 100 KB | 12 months | nightly job truncates to the first 100 KB after `summary` and `extraction` exist |
| `webhook_events` | 30 days | nightly delete |
| `ai_calls` | 13 months | nightly delete |
| `enrichment_cache` | 90 days (`expires_at`) | read path ignores expired; weekly delete |
| Disconnect Google | messages, threads, calendar events deleted within 24 h; people and touchpoints derived only from them are kept with `summary` lines but no bodies | job `orbit/google.disconnected` |
| Delete account | 7-day grace, then `purge_user` + storage purge + Resend contact removal; receipt email | `deletion_requests` |
| Export | JSON (all user tables) + CSV (people, chats, touchpoints) in a zip, signed URL valid 24 h | job `orbit/user.export.requested` |

---

## 7. Migration plan

| File | Contents |
|---|---|
| `0000_extensions.sql` | `vector`, `pg_trgm`, `citext`, `pgcrypto`, `unaccent`; `set_updated_at()` |
| `0001_enums.sql` | section 2 |
| `0002_global.sql` | `organizations`, `organization_aliases`, `schools`, `feature_flags`, `prompt_versions`, `webhook_events`, `enrichment_cache` |
| `0003_users.sql` | `users`, `user_settings`, `recruiting_goals`, `target_companies`, `handle_new_auth_user()`, `deletion_requests` |
| `0004_integrations.sql` | `integration_accounts`, `sync_runs` |
| `0005_people.sql` | `people`, `person_identities`, `affiliations`, `merge_suggestions`, `person_merges`, `edges`, `merge_people()`, `undo_merge()` |
| `0006_interactions.sql` | `email_threads`, `email_messages`, `calendar_events`, `linkedin_messages`, `touchpoints`, `recompute_person_strength()` + trigger |
| `0007_pipeline.sql` | `coffee_chats`, `coffee_chat_stage_events`, FK back-references, `apply_stage_transition()` |
| `0008_notes.sql` | `meeting_notes`, `person_facts`, `action_items` |
| `0009_engine.sql` | `outbound_messages`, `briefs`, `suggestions`, `recommendations`, `reach_queries`, `bind_approval()`, `check_send_allowed()` |
| `0010_learning.sql` | `style_profiles`, `feedback_events`, `notifications`, `audit_log`, `ai_calls`, `embeddings`, `resumes`, `resume_facets` |
| `0011_rls.sql` | enable RLS everywhere; policies per section 5; `integration_accounts_public` view |
| `0012_seed.sql` | schools and organizations seeds (generated from CSV by `pnpm db:seed`) |

Drizzle schema files mirror these (one file per migration group) and `drizzle-kit check` runs in CI to prove schema and migrations agree.
