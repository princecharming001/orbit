-- Plan 43: Instagram, X and texts in the warm path engine. Additive and re-runnable.
--
-- 1. The checks widen to the new providers, identity kinds, tie kinds and draft channels. Nothing existing changes.
-- 2. People gain `listed` (a person made from an account takes part in paths before they appear in People) and the
--    account they were made from. Messages and threads gain the account they came from and whether words were
--    written, so the personal lane can keep only the time and the direction, and a wrong match can be undone.
-- 3. The follow graph, shared across students where the list is public:
--      social_accounts    one row per account Orbit has a reason to know (public profile fields only)
--      social_follows     "A follows B", ids only; a row from a student's own list carries its owner
--      social_list_reads  how much of each list was read, whether it ended, the count the profile showed, who read it
--      social_suppressed  accounts that must never be stored or used (opt-outs)
-- 4. Per student:
--      source_states      on, off or removed, per optional source
--      social_links       an account attached to a person, by proof, by score or by the student
--      social_match_asks  the "is this the same person" questions, and their answers
--      social_not_same    accounts the student said are not a person, never proposed again
--      social_lookups     one lookup of who could introduce the student to a target, as a resumable job
--      text_days          per person and local day, how many texts each way (never the words)
-- 5. social_calls: Instagram and X reads per day, account and caller, made, saved and refused, and what X cost.
-- 6. delete_user also removes the student's own accounts from the shared graph, and the follows that name them.

-- ---- 1. wider checks --------------------------------------------------------------------------------------------

alter table orbit.integration_accounts drop constraint if exists integration_accounts_provider_check;
alter table orbit.integration_accounts add constraint integration_accounts_provider_check
  check (provider in ('google', 'linkedin', 'village', 'instagram', 'x'));
-- the platform's own id for the student's account (the Unipile id stays in external_account_id)
alter table orbit.integration_accounts add column if not exists social_account_id text;

alter table orbit.threads drop constraint if exists threads_provider_check;
alter table orbit.threads add constraint threads_provider_check check (provider in ('gmail', 'linkedin', 'instagram', 'x'));
alter table orbit.messages drop constraint if exists messages_provider_check;
alter table orbit.messages add constraint messages_provider_check check (provider in ('gmail', 'linkedin', 'instagram', 'x'));

alter table orbit.person_identities drop constraint if exists person_identities_kind_check;
alter table orbit.person_identities add constraint person_identities_kind_check
  check (kind in ('email', 'linkedin_member', 'linkedin_slug', 'phone', 'unipile_attendee', 'instagram_id', 'x_id'));
-- the account an identity came from, so a detach can take back an email or phone the account added
alter table orbit.person_identities add column if not exists social_account_id text;

alter table orbit.ties drop constraint if exists ties_kind_check;
alter table orbit.ties add constraint ties_kind_check check (kind in (
  'email_exchange', 'email_cc', 'email_cothread', 'meeting_coattendee', 'introduced_by', 'linkedin_mutual',
  'village_path', 'co_tenure', 'same_school_cohort', 'same_current_company', 'same_city',
  'linkedin_recommendation', 'linkedin_engagement', 'linkedin_mention', 'common_contacts', 'student_says_close',
  'instagram_mutual', 'instagram_follow', 'x_mutual', 'x_follow'
));

alter table orbit.drafts drop constraint if exists drafts_channel_check;
alter table orbit.drafts add constraint drafts_channel_check
  check (channel in ('gmail', 'linkedin', 'instagram', 'x', 'imessage'));

-- ---- 2. people, messages, threads -------------------------------------------------------------------------------

alter table orbit.people add column if not exists listed boolean not null default true;
-- `${platform}:${account id}` of the account a person was made from (plan 43 §3.3)
alter table orbit.people add column if not exists source_account text;
create index if not exists people_source_account_idx on orbit.people (user_id, source_account) where source_account is not null;

alter table orbit.messages add column if not exists social_account_id text;
-- false: nothing was written (a reaction, a shared post); null on mail, where words are the point
alter table orbit.messages add column if not exists has_words boolean;
alter table orbit.threads add column if not exists social_account_id text;
create index if not exists messages_social_account_idx on orbit.messages (user_id, social_account_id)
  where social_account_id is not null;

-- ---- 3. the shared follow graph ---------------------------------------------------------------------------------

create table if not exists orbit.social_accounts (
  platform text not null check (platform in ('instagram', 'x')),
  account_id text not null,
  username text not null,
  name text,
  bio text,
  links text[] not null default '{}',
  email text,
  phone text,
  followers integer,
  following integer,
  verified boolean not null default false,
  is_private boolean not null default false,
  business boolean not null default false,
  category text,
  picture_hash text,
  default_picture boolean not null default false,
  kind text not null default 'unknown' check (kind in ('person', 'public_figure', 'brand', 'unknown')),
  read_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  primary key (platform, account_id)
);
create index if not exists social_accounts_username_idx on orbit.social_accounts (platform, lower(username));
create index if not exists social_accounts_expires_idx on orbit.social_accounts (expires_at);

create table if not exists orbit.social_follows (
  id bigint generated always as identity primary key,
  platform text not null check (platform in ('instagram', 'x')),
  follower_id text not null,
  followed_id text not null,
  -- set when the row came from the student's own list (private to them); null for a public account's list
  owner_user_id uuid references orbit.users(id) on delete cascade,
  seen_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create unique index if not exists social_follows_key on orbit.social_follows
  (platform, follower_id, followed_id, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists social_follows_followed_idx on orbit.social_follows (platform, followed_id);
create index if not exists social_follows_follower_idx on orbit.social_follows (platform, follower_id);
create index if not exists social_follows_expires_idx on orbit.social_follows (expires_at);

create table if not exists orbit.social_list_reads (
  id bigint generated always as identity primary key,
  platform text not null check (platform in ('instagram', 'x')),
  account_id text not null,
  list text not null check (list in ('followers', 'following')),
  owner_user_id uuid references orbit.users(id) on delete cascade,
  -- who paid for the read (a public list read is shared, but each read is recorded with its reader, plan 43 §3.5)
  read_by uuid references orbit.users(id) on delete set null,
  rows_read integer not null default 0,
  total integer,
  ended boolean not null default false,
  cursor text,
  read_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create unique index if not exists social_list_reads_key on orbit.social_list_reads
  (platform, account_id, list, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists social_list_reads_expires_idx on orbit.social_list_reads (expires_at);

create table if not exists orbit.social_suppressed (
  platform text not null check (platform in ('instagram', 'x')),
  account_id text not null,
  reason text not null check (reason in ('opt_out', 'request', 'deleted_user')),
  created_at timestamptz not null default now(),
  primary key (platform, account_id)
);

-- ---- 4. per student ---------------------------------------------------------------------------------------------

create table if not exists orbit.source_states (
  user_id uuid not null references orbit.users(id) on delete cascade,
  source text not null check (source in ('instagram', 'x', 'imessage')),
  state text not null check (state in ('not_connected', 'on', 'off', 'removed')),
  -- when it last went off, for releasing an idle Unipile seat after 21 days
  off_since timestamptz,
  -- the student let Orbit friends find paths through who they follow (plan 43 §3.6), off by default; never for X
  share_follows boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source),
  check (source <> 'x' or not share_follows)
);
create index if not exists source_states_sync_idx on orbit.source_states (user_id, updated_at);

create table if not exists orbit.social_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'x')),
  account_id text not null,
  person_id uuid not null references orbit.people(id) on delete cascade,
  via text not null check (via in ('proof', 'score', 'student')),
  proof text check (proof in ('own_links', 'links_back', 'contact', 'address_book')),
  score real,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, account_id)
);
create index if not exists social_links_person_idx on orbit.social_links (person_id);
create index if not exists social_links_sync_idx on orbit.social_links (user_id, updated_at);

create table if not exists orbit.social_match_asks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'x')),
  account_id text not null,
  person_id uuid not null references orbit.people(id) on delete cascade,
  score real not null,
  signals jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'yes', 'no', 'stale')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, account_id, person_id)
);
create index if not exists social_match_asks_sync_idx on orbit.social_match_asks (user_id, updated_at);

create table if not exists orbit.social_not_same (
  user_id uuid not null references orbit.users(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'x')),
  account_id text not null,
  person_id uuid not null references orbit.people(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, platform, account_id, person_id)
);

create table if not exists orbit.social_lookups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'x')),
  target_person_id uuid not null references orbit.people(id) on delete cascade,
  target_account_id text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'done', 'failed')),
  -- the planner's memory between reads: lists tried, cursors, the count read this lookup
  state jsonb not null default '{}',
  -- bridges found, one-way follows, partial, reason
  result jsonb,
  -- what the student was shown before an X check, and what it cost (plan 43 §5)
  quoted_usd numeric(10, 4),
  cost_usd numeric(10, 4) not null default 0,
  notified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_lookups_target_idx on orbit.social_lookups (user_id, platform, target_person_id, created_at desc);
create index if not exists social_lookups_sync_idx on orbit.social_lookups (user_id, updated_at);

create table if not exists orbit.text_days (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  day date not null,
  in_count integer not null default 0,
  out_count integer not null default 0,
  -- the smallest chat that day, the student included (2 for one to one), which weighs a group down
  group_size integer not null default 2,
  -- false when only reactions or shared items passed that day
  words boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, person_id, day)
);
create index if not exists text_days_sync_idx on orbit.text_days (user_id, updated_at);

-- ---- 5. calls and cost ------------------------------------------------------------------------------------------

create table if not exists orbit.social_calls (
  day date not null,
  platform text not null check (platform in ('instagram', 'x')),
  account text not null,
  kind text not null,
  caller text not null,
  made integer not null default 0,
  saved integer not null default 0,
  refused integer not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  counted_at timestamptz not null default now(),
  primary key (day, platform, account, kind, caller)
);

-- ---- triggers, indexes and grants as the rest of the schema -------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['source_states', 'social_links', 'social_match_asks', 'social_lookups', 'text_days'] loop
    execute format('drop trigger if exists touch_updated_at on orbit.%I', t);
    execute format(
      'create trigger touch_updated_at before update on orbit.%I for each row execute function orbit.touch_updated_at()',
      t
    );
  end loop;
  foreach t in array array[
    'social_accounts', 'social_follows', 'social_list_reads', 'social_suppressed', 'source_states', 'social_links',
    'social_match_asks', 'social_not_same', 'social_lookups', 'text_days', 'social_calls'
  ] loop
    execute format('alter table orbit.%I enable row level security', t);
    execute format('revoke all on table orbit.%I from public, anon, authenticated', t);
    execute format('grant all on table orbit.%I to service_role', t);
  end loop;
end
$$;

-- add to the call counts, one row per day, platform, account, kind and caller
create or replace function orbit.social_calls_add(
  p_platform text,
  p_account text,
  p_kind text,
  p_caller text,
  p_made integer default 0,
  p_saved integer default 0,
  p_refused integer default 0,
  p_cost_usd numeric default 0
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into orbit.social_calls (day, platform, account, kind, caller, made, saved, refused, cost_usd, counted_at)
  values (current_date, p_platform, p_account, p_kind, p_caller, greatest(p_made, 0), greatest(p_saved, 0),
          greatest(p_refused, 0), greatest(p_cost_usd, 0), now())
  on conflict (day, platform, account, kind, caller) do update set
    made = orbit.social_calls.made + excluded.made,
    saved = orbit.social_calls.saved + excluded.saved,
    refused = orbit.social_calls.refused + excluded.refused,
    cost_usd = orbit.social_calls.cost_usd + excluded.cost_usd,
    counted_at = now();
$$;
revoke all on function orbit.social_calls_add(text, text, text, text, integer, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function orbit.social_calls_add(text, text, text, text, integer, integer, integer, numeric) to service_role;

-- shared rows past their 30 days go; a list read that expires takes the public follows it backed with it
create or replace function orbit.social_expire()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from orbit.social_follows where expires_at <= now();
  delete from orbit.social_list_reads where expires_at <= now();
  delete from orbit.social_accounts a
   where a.expires_at <= now()
     and not exists (select 1 from orbit.social_links l where l.platform = a.platform and l.account_id = a.account_id);
end
$$;
revoke all on function orbit.social_expire() from public, anon, authenticated;
grant execute on function orbit.social_expire() to service_role;

-- ---- 6. delete_user ---------------------------------------------------------------------------------------------
-- As 20261101_orbit_friends.sql, and first: the student's own Instagram and X accounts leave the shared graph, with
-- every follow that names them, and are suppressed so another student's later read does not store them again.
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
  insert into orbit.social_suppressed (platform, account_id, reason)
  select i.provider, i.social_account_id, 'deleted_user'
    from orbit.integration_accounts i
   where i.user_id = p_user and i.provider in ('instagram', 'x') and i.social_account_id is not null
  on conflict do nothing;
  delete from orbit.social_follows f
   using orbit.integration_accounts i
   where i.user_id = p_user and i.provider in ('instagram', 'x') and i.social_account_id is not null
     and f.platform = i.provider and (f.follower_id = i.social_account_id or f.followed_id = i.social_account_id);
  delete from orbit.social_list_reads r
   using orbit.integration_accounts i
   where i.user_id = p_user and i.provider in ('instagram', 'x') and i.social_account_id is not null
     and r.platform = i.provider and r.account_id = i.social_account_id;
  delete from orbit.social_accounts a
   using orbit.integration_accounts i
   where i.user_id = p_user and i.provider in ('instagram', 'x') and i.social_account_id is not null
     and a.platform = i.provider and a.account_id = i.social_account_id;
  update orbit.social_list_reads set read_by = null where read_by = p_user;

  delete from vault.secrets s
   where s.id in (select token_secret_id from orbit.integration_accounts where user_id = p_user and token_secret_id is not null)
      or s.name like '%:' || p_user::text;

  foreach q in array orbit.queue_names() loop
    execute format('delete from pgmq.%I where message->>''userId'' = $1', 'q_' || q) using p_user::text;
    execute format('delete from pgmq.%I where message->>''userId'' = $1', 'a_' || q) using p_user::text;
  end loop;
  delete from orbit.dead_letters where message->>'userId' = p_user::text;

  delete from orbit.friend_intro_asks where asker_user_id = p_user or friend_user_id = p_user;
  delete from orbit.friend_shares where owner_user_id = p_user;
  delete from orbit.friend_share_settings where owner_user_id = p_user;
  delete from orbit.friendships where a = p_user or b = p_user;
  delete from orbit.friend_invites where from_user_id = p_user;

  delete from orbit.users where id = p_user;

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
revoke all on function orbit.delete_user(uuid) from public, anon, authenticated;
grant execute on function orbit.delete_user(uuid) to service_role;
