-- Orbit's server data (docs/plan/16-network-agent-infrastructure.md §11.3): the `orbit` schema, its queues and the
-- functions the Edge Functions and pg_cron call. Every table has RLS on and no policies, and the schema is not exposed
-- through the Data API: only Orbit's functions reach it, over SUPABASE_DB_URL. Written to be replayed unchanged on a
-- dedicated project (human action H1), and to be re-runnable (if not exists / create or replace).
--
-- Extensions: pgvector is already installed in schema `public` on the shared project; on a new project it lands in
-- `extensions`. Column types below say `vector(384)` and resolve through the migration's search_path either way. No
-- security-definer function here touches a vector type or operator, so their empty search_path never needs it.

create schema if not exists orbit;
comment on schema orbit is 'Orbit server data. Service role only; never add this schema to the Data API.';

create extension if not exists pgmq;
create extension if not exists vector with schema extensions;

-- ---- identity and sessions ----------------------------------------------------------------------------------------

create table if not exists orbit.users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique not null,
  email text not null,
  full_name text, first_name text, last_name text, avatar_url text,
  school text, school_domain text, grad_year int, degree text, majors text[] not null default '{}',
  current_title text, current_org text, current_city text,
  timezone text not null default 'America/New_York',
  autonomy_level smallint not null default 0 check (autonomy_level between 0 and 2),
  settings jsonb not null default '{}'::jsonb,
  onboarding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  last_seen_at timestamptz, deleted_at timestamptz
);
create unique index if not exists users_email_lower_key on orbit.users (lower(email));

create table if not exists orbit.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  refresh_hash text not null unique, user_agent text,
  created_at timestamptz not null default now(), last_used_at timestamptz,
  expires_at timestamptz not null, revoked_at timestamptz
);
create index if not exists sessions_user_idx on orbit.sessions (user_id);

create table if not exists orbit.oauth_states (
  state text primary key, code_verifier text not null, redirect_to text not null,
  user_id uuid references orbit.users(id) on delete cascade,      -- set for incremental consent
  scopes text[] not null, created_at timestamptz not null default now(), expires_at timestamptz not null
);
create index if not exists oauth_states_expires_idx on orbit.oauth_states (expires_at);

create table if not exists orbit.login_codes (
  code_hash text primary key, user_id uuid not null references orbit.users(id) on delete cascade,
  expires_at timestamptz not null, used_at timestamptz
);
create index if not exists login_codes_user_idx on orbit.login_codes (user_id);

create table if not exists orbit.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  provider text not null check (provider in ('google','linkedin','village')),
  external_account_id text, email text, scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active','needs_reauth','revoked','error','connecting')),
  token_secret_id uuid,                      -- vault.secrets id holding the refresh token
  sync_state jsonb not null default '{}'::jsonb,  -- {gmail:{historyId, backfill:{phase,pageToken,done,total}}, calendar:{syncToken}, contacts:{syncToken}, linkedin:{cursor}}
  watch_expires_at timestamptz, last_synced_at timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
-- webhook lookups: Gmail push by address, Unipile by account id
create index if not exists integration_accounts_email_idx on orbit.integration_accounts (provider, lower(email));
create index if not exists integration_accounts_external_idx on orbit.integration_accounts (provider, external_account_id);

-- ---- people and organizations -------------------------------------------------------------------------------------

create table if not exists orbit.organizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  name text not null, name_norm text not null, domains text[] not null default '{}',
  linkedin_slug text, industry text, size_bucket text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, name_norm)
);

create table if not exists orbit.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  is_self boolean not null default false,
  display_name text not null, first_name text, last_name text, name_norm text not null,
  primary_email text, headline text, title text,
  org_id uuid references orbit.organizations(id) on delete set null, org_raw text,
  location text, timezone text, school text, is_alumni boolean not null default false,
  photo_url text, linkedin_url text, linkedin_slug text, linkedin_member_id text,
  relationship_type text, sources text[] not null default '{}',
  first_seen_at timestamptz, last_interaction_at timestamptz,
  strength real not null default 0,          -- = tie score / 100, kept for the v1 UI
  summary text, tags text[] not null default '{}', notes text,
  do_not_contact boolean not null default false,
  hidden_at timestamptz, merged_into uuid references orbit.people(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists people_self_key on orbit.people (user_id) where is_self;
create index if not exists people_name_idx on orbit.people (user_id, name_norm);
create index if not exists people_org_idx on orbit.people (user_id, org_id);

create table if not exists orbit.person_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('email','linkedin_member','linkedin_slug','phone','unipile_attendee')),
  value_norm text not null, value_raw text, source text not null, confidence real not null default 1,
  created_at timestamptz not null default now(),
  unique (user_id, kind, value_norm)
);
create index if not exists person_identities_person_idx on orbit.person_identities (person_id);
-- this table has no updated_at; sync reads it by created_at
create index if not exists person_identities_sync_idx on orbit.person_identities (user_id, created_at);

create table if not exists orbit.affiliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  org_id uuid references orbit.organizations(id) on delete set null, org_raw text,
  kind text not null check (kind in ('employment','education')),
  title text, degree text, field text, start_date date, end_date date, is_current boolean not null default false,
  source text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists affiliations_person_idx on orbit.affiliations (person_id);

create table if not exists orbit.merge_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_a uuid not null references orbit.people(id) on delete cascade,
  person_b uuid not null references orbit.people(id) on delete cascade,
  score real not null, features jsonb not null,
  status text not null default 'open' check (status in ('open','merged','rejected')),
  created_at timestamptz not null default now(), decided_at timestamptz, updated_at timestamptz not null default now()
);
create table if not exists orbit.do_not_merge (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_a uuid not null, person_b uuid not null, created_at timestamptz not null default now(),
  primary key (user_id, person_a, person_b)
);

create table if not exists orbit.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null check (kind in ('recruiting','fundraising','sales','hiring','advice','cofounder','community','collaboration')),
  title text not null, description text,
  targets jsonb not null default '{"organizations":[],"roles":[],"geographies":[],"people":[]}'::jsonb,
  criteria jsonb not null default '{}'::jsonb,       -- sourcing filters: sector, stage, seniority, skills, keywords
  success_metric text, priority smallint not null default 2 check (priority between 1 and 3),
  status text not null default 'active' check (status in ('active','paused','done')),
  autonomy_level smallint check (autonomy_level between 0 and 2),
  due_at date, source text not null default 'user' check (source in ('user','onboarding','inferred')),
  evidence text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);

-- ---- mail, calendar, ties -----------------------------------------------------------------------------------------

create table if not exists orbit.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  provider text not null check (provider in ('gmail','linkedin')),
  external_id text not null, subject text,
  participant_person_ids uuid[] not null default '{}', participant_count int not null default 0,
  first_at timestamptz, last_at timestamptz, message_count int not null default 0,
  last_direction text check (last_direction in ('in','out')),
  category text, is_networking boolean not null default false, chat_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index if not exists threads_last_idx on orbit.threads (user_id, last_at desc);

create table if not exists orbit.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  thread_id uuid not null references orbit.threads(id) on delete cascade,
  provider text not null check (provider in ('gmail','linkedin')),
  external_id text not null, rfc_message_id text, in_reply_to text,
  direction text not null check (direction in ('in','out')),
  from_person_id uuid references orbit.people(id) on delete set null,
  from_addr text, to_addrs text[] not null default '{}', cc_addrs text[] not null default '{}',
  to_person_ids uuid[] not null default '{}', cc_person_ids uuid[] not null default '{}',
  sent_at timestamptz not null, subject text, snippet text,
  body_text text,                              -- networking threads only; nulled by retention
  is_automated boolean not null default false, list_unsubscribe boolean not null default false,
  reply_class text, reply_confidence real, extraction jsonb,
  embedding vector(384),                       -- outbound messages ≥ 25 words, for voice exemplars
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index if not exists messages_sent_idx on orbit.messages (user_id, sent_at desc);
create index if not exists messages_thread_idx on orbit.messages (thread_id, sent_at);
create index if not exists messages_embedding_idx on orbit.messages using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create table if not exists orbit.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  external_id text not null, title text, description text,
  start_at timestamptz not null, end_at timestamptz, status text,
  organizer_email text, attendees jsonb not null default '[]'::jsonb,   -- [{email, displayName, responseStatus, self}]
  attendee_person_ids uuid[] not null default '{}', attendee_count int not null default 0,
  conference_url text, is_one_on_one boolean not null default false, chat_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, external_id)
);

create table if not exists orbit.ties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  a_person_id uuid not null references orbit.people(id) on delete cascade,
  b_person_id uuid not null references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('email_exchange','email_cc','email_cothread','meeting_coattendee','introduced_by','linkedin_mutual','village_path','co_tenure','same_school_cohort','same_current_company','same_city')),
  weight real not null check (weight between 0 and 1), confidence real not null check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,   -- {threadIds[], eventIds[], orgId, overlapMonths, source, count}
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (a_person_id < b_person_id),
  unique (user_id, a_person_id, b_person_id, kind)
);
create index if not exists ties_a_idx on orbit.ties (user_id, a_person_id);
create index if not exists ties_b_idx on orbit.ties (user_id, b_person_id);

create table if not exists orbit.tie_scores (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  score smallint not null check (score between 0 and 100), band text not null,
  features jsonb not null, contributions jsonb not null, explanation text[] not null default '{}',
  model_version text not null, computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, person_id)
);
create table if not exists orbit.tie_labels (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  closeness smallint not null check (closeness between 1 and 5),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (user_id, person_id)
);

-- ---- pipeline -----------------------------------------------------------------------------------------------------

create table if not exists orbit.chats (           -- pipeline cards (CoffeeChat in core)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  goal_id uuid references orbit.goals(id) on delete set null,
  org_id uuid references orbit.organizations(id) on delete set null,
  stage text not null, stage_entered_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,   -- the remaining CoffeeChat fields, camelCase, as in core
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists chats_person_idx on orbit.chats (person_id);

create table if not exists orbit.stage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  chat_id uuid not null references orbit.chats(id) on delete cascade,
  from_stage text, to_stage text not null, status text not null, actor text not null,
  reason text, evidence jsonb, confidence real,
  created_at timestamptz not null default now(), decided_at timestamptz, updated_at timestamptz not null default now()
);
create index if not exists stage_events_chat_idx on orbit.stage_events (chat_id);

create table if not exists orbit.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  chat_id uuid references orbit.chats(id) on delete set null,
  goal_id uuid references orbit.goals(id) on delete set null,
  channel text not null check (channel in ('gmail','linkedin')),
  kind text not null, subject text, body text not null,
  ask jsonb, hooks jsonb not null default '[]'::jsonb, via jsonb,
  thread_external_id text, in_reply_to text,
  status text not null default 'draft' check (status in ('draft','approved','scheduled','sending','sent','failed','discarded','cancelled')),
  autonomy_level smallint not null default 0, send_at timestamptz, sent_at timestamptz,
  provider_message_id text, error text, cancel_reason text,
  validator jsonb, generated_by text not null default 'template', prompt_version text, variant text,
  replied_at timestamptz, reply_class text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists drafts_due_idx on orbit.drafts (status, send_at) where status in ('approved','scheduled');
create index if not exists drafts_person_idx on orbit.drafts (person_id);

create table if not exists orbit.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_ids uuid[] not null default '{}', chat_id uuid references orbit.chats(id) on delete set null,
  source text not null, title text, occurred_at timestamptz not null, raw_text text not null,
  extraction jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists orbit.uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null check (kind in ('resume','note','transcript','linkedin_export')),
  filename text, text text not null, parsed jsonb, is_current boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists orbit.facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  type text not null, text text not null, source_table text, source_id uuid, occurred_at timestamptz,
  confidence real not null default 0.8, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists facts_person_idx on orbit.facts (person_id);

-- ---- research, sourcing, intros, memory ---------------------------------------------------------------------------

create table if not exists orbit.dossiers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  goal_id uuid references orbit.goals(id) on delete set null,
  status text not null check (status in ('pending','ready','partial','needs_disambiguation','failed')),
  content jsonb, sources jsonb not null default '[]'::jsonb, candidates jsonb,
  cost_usd numeric(8,4) not null default 0, model text, prompt_version text, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  unique (user_id, person_id)
);
create index if not exists dossiers_expires_idx on orbit.dossiers (expires_at);

create table if not exists orbit.research_cache (
  user_id uuid not null references orbit.users(id) on delete cascade,
  key text not null, provider text not null, response jsonb not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  primary key (user_id, key)
);
create index if not exists research_cache_expires_idx on orbit.research_cache (expires_at);

create table if not exists orbit.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  goal_id uuid references orbit.goals(id) on delete cascade,
  person_id uuid references orbit.people(id) on delete cascade,
  candidate jsonb not null,                  -- provider record when not yet a person
  source text not null, external_id text,
  rank real not null, fit real, reach real, responsiveness real, reasons text[] not null default '{}',
  status text not null default 'new' check (status in ('new','added','dismissed')),
  batch_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists orbit.intro_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  target_person_id uuid references orbit.people(id) on delete set null,
  introducer_person_id uuid references orbit.people(id) on delete set null,
  goal_id uuid references orbit.goals(id) on delete set null,
  path jsonb not null, path_score real not null, rank int not null,
  status text not null default 'asked' check (status in ('asked','agreed','declined','intro_made','meeting','no_response')),
  asked_at timestamptz not null default now(), outcome_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists orbit.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('preference','constraint','goal_detail','outcome','person_fact','note')),
  text text not null, embedding vector(384), importance real not null default 0.5,
  source text not null, quote text,
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz
);
create index if not exists memories_embedding_idx on orbit.memories using hnsw (embedding vector_cosine_ops);

-- ---- operations ---------------------------------------------------------------------------------------------------

create table if not exists orbit.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid references orbit.users(id) on delete cascade,
  provider text not null, operation text not null, units numeric not null, cost_usd numeric(10,5) not null,
  created_at timestamptz not null default now()
);
create index if not exists usage_ledger_user_idx on orbit.usage_ledger (user_id, created_at);

create table if not exists orbit.job_runs (
  id bigint generated always as identity primary key,
  queue text not null, msg_id bigint, user_id uuid, kind text not null, dedupe_key text,
  status text not null check (status in ('running','ok','error','skipped')),
  attempt int not null default 1, error text, duration_ms int,
  started_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists job_runs_dedupe_idx on orbit.job_runs (dedupe_key, finished_at) where status = 'ok';
create index if not exists job_runs_started_idx on orbit.job_runs (started_at);
create index if not exists job_runs_user_idx on orbit.job_runs (user_id);

create table if not exists orbit.dead_letters (
  id bigint generated always as identity primary key,
  queue text not null, msg_id bigint, message jsonb not null, error text, created_at timestamptz not null default now()
);
create index if not exists dead_letters_created_idx on orbit.dead_letters (created_at);

create table if not exists orbit.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references orbit.users(id) on delete cascade,
  actor text not null check (actor in ('user','agent','system')),
  action text not null, target_table text, target_id text, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_user_idx on orbit.audit_log (user_id, created_at);
create index if not exists audit_log_created_idx on orbit.audit_log (created_at);

create table if not exists orbit.webhook_events (      -- idempotency for inbound webhooks
  provider text not null, event_id text not null, received_at timestamptz not null default now(),
  primary key (provider, event_id)
);
create index if not exists webhook_events_received_idx on orbit.webhook_events (received_at);

-- ---- sync indexes: every user-owned table with updated_at is read by (user_id, updated_at) ------------------------

do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.columns u
      on u.table_schema = c.table_schema and u.table_name = c.table_name and u.column_name = 'user_id'
    join information_schema.tables bt
      on bt.table_schema = c.table_schema and bt.table_name = c.table_name and bt.table_type = 'BASE TABLE'
    where c.table_schema = 'orbit' and c.column_name = 'updated_at'
  loop
    execute format('create index if not exists %I on orbit.%I (user_id, updated_at)', t || '_sync_idx', t);
  end loop;
end
$$;

-- ---- updated_at --------------------------------------------------------------------------------------------------

create or replace function orbit.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables bt
      on bt.table_schema = c.table_schema and bt.table_name = c.table_name and bt.table_type = 'BASE TABLE'
    where c.table_schema = 'orbit' and c.column_name = 'updated_at'
  loop
    execute format('drop trigger if exists touch_updated_at on orbit.%I', t);
    execute format(
      'create trigger touch_updated_at before update on orbit.%I for each row execute function orbit.touch_updated_at()',
      t
    );
  end loop;
end
$$;

-- ---- queues (§9.1), in priority order ----------------------------------------------------------------------------

create or replace function orbit.queue_names()
returns text[]
language sql
immutable
security definer
set search_path = ''
as $$ select array['orbit_send','orbit_classify','orbit_sync','orbit_cadence','orbit_score','orbit_enrich'] $$;

do $$
declare
  q text;
begin
  foreach q in array orbit.queue_names() loop
    perform pgmq.create(q);
  end loop;
end
$$;

-- Send one message. A message with a dedupeKey is dropped (returns null) while the same key is still queued or
-- in flight, or ran successfully in the last 24 hours.
create or replace function orbit.enqueue(queue text, msg jsonb, delay int default 0)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text := msg->>'dedupeKey';
  dup boolean;
  id bigint;
begin
  if not (queue = any (orbit.queue_names())) then
    raise exception 'orbit.enqueue: unknown queue %', queue;
  end if;
  if msg is null or jsonb_typeof(msg) <> 'object' or coalesce(msg->>'kind', '') = '' then
    raise exception 'orbit.enqueue: a message needs a kind';
  end if;
  if k is not null then
    perform pg_advisory_xact_lock(hashtextextended('orbit.enqueue:' || k, 0));
    if exists (
      select 1 from orbit.job_runs
      where dedupe_key = k and status = 'ok' and finished_at > now() - interval '24 hours'
    ) then
      return null;
    end if;
    execute format('select exists (select 1 from pgmq.%I where message->>''dedupeKey'' = $1)', 'q_' || queue)
      into dup using k;
    if dup then
      return null;
    end if;
  end if;
  select s into id from pgmq.send(queue, msg, greatest(coalesce(delay, 0), 0)) as s;
  return id;
end
$$;

-- Every 10 minutes: Gmail and Calendar incremental syncs for connected users not synced in the last 10 minutes
-- (the fallback for missed Gmail pushes, and Calendar's only incremental path, §12.2-12.3).
create or replace function orbit.enqueue_incremental_syncs()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  slot text := to_char(date_trunc('hour', now() at time zone 'utc')
    + floor(extract(minute from now() at time zone 'utc') / 10) * interval '10 minutes', 'YYYY-MM-DD-HH24-MI');
begin
  for r in
    select a.user_id, a.scopes from orbit.integration_accounts a
    join orbit.users u on u.id = a.user_id
    where a.provider = 'google' and a.status = 'active' and u.deleted_at is null
      and (a.last_synced_at is null or a.last_synced_at < now() - interval '10 minutes')
  loop
    if exists (select 1 from unnest(r.scopes) s where s like '%gmail.readonly') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.gmail.incremental', 'userId', r.user_id, 'payload', jsonb_build_object('reason', 'poll'),
        'dedupeKey', 'gmail-poll:' || r.user_id || ':' || slot)) is not null then
        n := n + 1;
      end if;
    end if;
    if exists (select 1 from unnest(r.scopes) s where s like '%calendar.readonly' or s like '%calendar.events') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.calendar', 'userId', r.user_id, 'payload', jsonb_build_object('reason', 'poll'),
        'dedupeKey', 'calendar-poll:' || r.user_id || ':' || slot)) is not null then
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end
$$;

-- Hourly: one cadence scan per active user per hour (§9.2, §9.4 test 1).
create or replace function orbit.enqueue_cadence()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  hour text := to_char(now() at time zone 'utc', 'YYYY-MM-DD-HH24');
begin
  for r in select id from orbit.users where deleted_at is null loop
    if orbit.enqueue('orbit_cadence', jsonb_build_object(
      'kind', 'cadence.user', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cadence:' || r.id || ':' || hour)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- Nightly: scores for everyone, Gmail watch renewal, calendar resync, and contacts once a week (Sundays, UTC).
create or replace function orbit.enqueue_nightly()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  day text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  sunday boolean := extract(dow from now() at time zone 'utc') = 0;
begin
  for r in
    select u.id, a.scopes, a.status from orbit.users u
    left join orbit.integration_accounts a on a.user_id = u.id and a.provider = 'google'
    where u.deleted_at is null
  loop
    if orbit.enqueue('orbit_score', jsonb_build_object(
      'kind', 'score.user', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'nightly:score.user:' || r.id || ':' || day)) is not null then
      n := n + 1;
    end if;
    continue when r.status is distinct from 'active';
    if exists (select 1 from unnest(r.scopes) s where s like '%gmail.readonly') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.gmail.incremental', 'userId', r.id, 'payload', jsonb_build_object('renewWatch', true),
        'dedupeKey', 'nightly:gmail:' || r.id || ':' || day)) is not null then
        n := n + 1;
      end if;
    end if;
    if exists (select 1 from unnest(r.scopes) s where s like '%calendar.readonly' or s like '%calendar.events') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.calendar', 'userId', r.id, 'payload', jsonb_build_object('resync', true),
        'dedupeKey', 'nightly:calendar:' || r.id || ':' || day)) is not null then
        n := n + 1;
      end if;
    end if;
    if sunday and exists (select 1 from unnest(r.scopes) s where s like '%contacts%') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.contacts', 'userId', r.id, 'payload', '{}'::jsonb,
        'dedupeKey', 'weekly:contacts:' || r.id || ':' || day)) is not null then
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end
$$;

-- ---- Vault (refresh tokens and other per-user secrets) -----------------------------------------------------------

create or replace function orbit.vault_put(p_name text, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  sid uuid;
begin
  select id into sid from vault.secrets where name = p_name;
  if sid is null then
    sid := vault.create_secret(p_secret, p_name);
  else
    perform vault.update_secret(sid, p_secret);
  end if;
  return sid;
end
$$;

create or replace function orbit.vault_get(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where id = p_id $$;

create or replace function orbit.vault_delete(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$ delete from vault.secrets where id = p_id $$;

-- ---- retention and deletion (§10.3) ------------------------------------------------------------------------------

create or replace function orbit.retention_purge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  out jsonb := '{}'::jsonb;
  n bigint;
  r record;
begin
  -- accounts marked deleted are hard-deleted within 24 hours
  n := 0;
  for r in select id from orbit.users where deleted_at is not null and deleted_at < now() - interval '24 hours' loop
    perform orbit.delete_user(r.id);
    n := n + 1;
  end loop;
  out := out || jsonb_build_object('users', n);

  -- message bodies (and the embedding derived from them) after the user's setting: 6, 12 or 24 months
  update orbit.messages m
     set body_text = null, embedding = null
    from orbit.users u
   where m.user_id = u.id
     and (m.body_text is not null or m.embedding is not null)
     and m.sent_at < now() - make_interval(months => case
           when u.settings->>'body_retention_months' in ('6', '12', '24') then (u.settings->>'body_retention_months')::int
           else 24 end);
  get diagnostics n = row_count;
  out := out || jsonb_build_object('message_bodies', n);

  delete from orbit.dossiers where expires_at < now() or created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('dossiers', n);

  delete from orbit.research_cache where expires_at < now() or created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('research_cache', n);

  delete from orbit.audit_log where created_at < now() - interval '2 years';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('audit_log', n);

  delete from orbit.job_runs where started_at < now() - interval '30 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('job_runs', n);

  delete from orbit.dead_letters where created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('dead_letters', n);

  -- housekeeping for short-lived auth rows and webhook ids
  delete from orbit.oauth_states where expires_at < now() - interval '1 day';
  delete from orbit.login_codes where expires_at < now() - interval '1 day';
  delete from orbit.sessions where expires_at < now() - interval '1 day'
     or (revoked_at is not null and revoked_at < now() - interval '1 day');
  delete from orbit.webhook_events where received_at < now() - interval '30 days';

  return out;
end
$$;

-- Hard delete of everything Orbit holds for one user: Vault secrets, queued jobs, dead letters, and every row in
-- every orbit table with a user_id column. Provider-side cleanup (Google revoke, Gmail stop, Unipile account delete)
-- is done by orbit-api before it calls this.
create or replace function orbit.delete_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q text;
  t text;
begin
  delete from vault.secrets s
   where s.id in (select token_secret_id from orbit.integration_accounts where user_id = p_user and token_secret_id is not null)
      or s.name like '%:' || p_user::text;

  foreach q in array orbit.queue_names() loop
    execute format('delete from pgmq.%I where message->>''userId'' = $1', 'q_' || q) using p_user::text;
    execute format('delete from pgmq.%I where message->>''userId'' = $1', 'a_' || q) using p_user::text;
  end loop;
  delete from orbit.dead_letters where message->>'userId' = p_user::text;

  delete from orbit.users where id = p_user;

  -- tables without a foreign key to users (job_runs) and anything a cascade missed
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables bt
      on bt.table_schema = c.table_schema and bt.table_name = c.table_name and bt.table_type = 'BASE TABLE'
    where c.table_schema = 'orbit' and c.column_name = 'user_id'
  loop
    execute format('delete from orbit.%I where user_id = $1', t) using p_user;
  end loop;
end
$$;

-- ---- observability (§16) ----------------------------------------------------------------------------------------

create or replace function orbit.queue_depth()
returns table (queue text, priority int, depth bigint, visible bigint, oldest_age_sec int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q text;
  i int := 0;
begin
  foreach q in array orbit.queue_names() loop
    i := i + 1;
    queue := q;
    priority := i;
    execute format(
      'select count(*), count(*) filter (where vt <= now()), coalesce(extract(epoch from now() - min(enqueued_at)), 0)::int from pgmq.%I',
      'q_' || q
    ) into depth, visible, oldest_age_sec;
    return next;
  end loop;
end
$$;

create or replace function orbit.health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'dead_letters_24h', (select count(*) from orbit.dead_letters where created_at > now() - interval '24 hours'),
    'job_errors_24h', (select count(*) from orbit.job_runs where status = 'error' and started_at > now() - interval '24 hours'),
    'queues', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'queue', d.queue, 'depth', d.depth, 'visible', d.visible, 'oldest_age_sec', d.oldest_age_sec) order by d.priority), '[]'::jsonb)
      from orbit.queue_depth() d
    ),
    'needs_reauth', (select count(*) from orbit.integration_accounts where status = 'needs_reauth'),
    -- a Gmail backfill whose phase is not 'complete' and whose account row has not moved for an hour
    'stuck_backfills', (
      select count(*) from orbit.integration_accounts
      where provider = 'google'
        and sync_state #>> '{gmail,backfill,phase}' is not null
        and sync_state #>> '{gmail,backfill,phase}' <> 'complete'
        and updated_at < now() - interval '1 hour'
    )
  )
$$;

create or replace function orbit.health_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h jsonb := orbit.health();
begin
  insert into orbit.audit_log (user_id, actor, action, details) values (null, 'system', 'health.snapshot', h);
  return h;
end
$$;

create or replace view orbit.v_queue_depth with (security_invoker = true) as
  select queue, priority, depth, visible, oldest_age_sec from orbit.queue_depth();

create or replace view orbit.v_costs with (security_invoker = true) as
  select (created_at at time zone 'utc')::date as day, provider,
         count(*) as calls, sum(units) as units, sum(cost_usd) as cost_usd, count(distinct user_id) as users
    from orbit.usage_ledger
   group by 1, 2;

-- Reply rates of sent drafts (§7.6, §15): a reply counts when it came within 14 days of the send.
create or replace view orbit.v_reply_rates with (security_invoker = true) as
  select date_trunc('week', d.sent_at) as week,
         g.kind as goal_kind, d.goal_id, d.kind, d.channel, d.variant, d.prompt_version,
         count(*) as sent,
         count(*) filter (where d.replied_at is not null and d.replied_at <= d.sent_at + interval '14 days') as replied,
         count(*) filter (where d.replied_at is not null and d.replied_at <= d.sent_at + interval '14 days'
                            and d.reply_class in ('interested', 'scheduling', 'referral')) as replied_positive,
         round((count(*) filter (where d.replied_at is not null and d.replied_at <= d.sent_at + interval '14 days'))::numeric
               / nullif(count(*), 0), 4) as reply_rate
    from orbit.drafts d
    left join orbit.goals g on g.id = d.goal_id
   where d.status = 'sent' and d.sent_at is not null
   group by 1, 2, 3, 4, 5, 6, 7;

-- ---- access: RLS on everywhere with no policies; service role only -------------------------------------------------

do $$
declare
  t text;
begin
  for t in select table_name from information_schema.tables where table_schema = 'orbit' and table_type = 'BASE TABLE'
  loop
    execute format('alter table orbit.%I enable row level security', t);
  end loop;
end
$$;

revoke all on schema orbit from public, anon, authenticated;
grant usage on schema orbit to service_role;
revoke all on all tables in schema orbit from public, anon, authenticated;
revoke all on all sequences in schema orbit from public, anon, authenticated;
grant all on all tables in schema orbit to service_role;
grant all on all sequences in schema orbit to service_role;
revoke all on all functions in schema orbit from public, anon, authenticated;
grant execute on all functions in schema orbit to service_role;
alter default privileges in schema orbit revoke all on tables from public, anon, authenticated;
alter default privileges in schema orbit revoke all on functions from public, anon, authenticated;
alter default privileges in schema orbit revoke all on sequences from public, anon, authenticated;
