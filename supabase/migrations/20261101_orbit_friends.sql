-- Friends (docs/plan/29-friends-and-autopilot.md Part A, §A3): two Orbit users pool their networks as signal, never
-- content. Invites and requests, the friendship itself (double consent), what each side shares with the other, the
-- projection a friend may read (rebuilt by the owner's side, never a read of the owner's own tables), an intro asked
-- of a friend, and the one cross-tenant predicate every friend read goes through: orbit.friend_visible(viewer, owner).
--
-- What is never projected (§A1): anything derived from Gmail or Calendar, addresses, phones, notes, scores, stage
-- names, a person the owner marked private, hid or who asked not to be contacted, and anyone with no identity to join
-- on. The closeness word comes from tie_scores.share_score, the tie score recomputed with the Google features zeroed
-- (core scoring/tieScore.ts shareScore).

-- ---- invites and requests -----------------------------------------------------------------------------------------

create table if not exists orbit.friend_invites (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references orbit.users(id) on delete cascade,
  to_email text,                      -- lower(email) of the invitee, or null for a link
  code text unique not null,          -- 22 chars base62, in the link
  status text not null check (status in ('pending','accepted','declined','expired','revoked')) default 'pending',
  created_at timestamptz not null default now(), expires_at timestamptz not null, answered_at timestamptz
);
create index if not exists friend_invites_from_idx on orbit.friend_invites (from_user_id, created_at);
create index if not exists friend_invites_email_idx on orbit.friend_invites (to_email) where status = 'pending';

-- ---- the friendship: one row per pair, a < b, both must accept before it is active -----------------------------------

create table if not exists orbit.friendships (
  id uuid primary key default gen_random_uuid(),
  a uuid not null references orbit.users(id) on delete cascade,
  b uuid not null references orbit.users(id) on delete cascade,
  status text not null check (status in ('pending','active','ended','blocked')),
  requested_by uuid not null,
  created_at timestamptz not null default now(), accepted_at timestamptz, ended_at timestamptz, ended_by uuid,
  check (a < b), unique (a, b)
);
create index if not exists friendships_a_idx on orbit.friendships (a, status);
create index if not exists friendships_b_idx on orbit.friendships (b, status);

-- what each side shares with the other; one row per direction
create table if not exists orbit.friend_share_settings (
  friendship_id uuid not null references orbit.friendships(id) on delete cascade,
  owner_user_id uuid not null references orbit.users(id) on delete cascade,
  mode text not null check (mode in ('all','companies','none')) default 'none',
  company_domains text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (friendship_id, owner_user_id)
);
create index if not exists friend_share_settings_sync_idx on orbit.friend_share_settings (owner_user_id, updated_at);

-- ---- the projection: what a friend may see of the owner's people, rebuilt by the owner side ----------------------------

create table if not exists orbit.friend_shares (
  owner_user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  display_name text not null, title text, company text, company_domain text,
  linkedin_member_id text, linkedin_slug text, email_hash text,   -- join keys only; never the address
  school text, is_alumni boolean not null default false,
  closeness smallint not null check (closeness between 1 and 3),  -- 1 knows, 2 knows well, 3 close
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, person_id),
  -- a person with nothing to join on is never projected: a friend route needs an identity, never a name alone
  constraint friend_shares_joinable check (
    linkedin_member_id is not null or linkedin_slug is not null or email_hash is not null
  )
);
create index if not exists friend_shares_member_idx on orbit.friend_shares (linkedin_member_id) where linkedin_member_id is not null;
create index if not exists friend_shares_slug_idx on orbit.friend_shares (lower(linkedin_slug)) where linkedin_slug is not null;
create index if not exists friend_shares_email_idx on orbit.friend_shares (email_hash) where email_hash is not null;
create index if not exists friend_shares_company_idx on orbit.friend_shares (owner_user_id, lower(company_domain));
-- the sync-shaped index every table with updated_at carries (the owner stands where user_id does elsewhere)
create index if not exists friend_shares_sync_idx on orbit.friend_shares (owner_user_id, updated_at);

alter table orbit.people add column if not exists private boolean not null default false;
comment on column orbit.people.private is
  'Plan 29 §A1: hidden from friends. A private person is never written to friend_shares, whatever the owner shares.';

-- the closeness a friend sees: the tie score with every Google-derived feature zeroed (plan 29 §A2.2), filled by the
-- scorer beside `score`; null until the next scoring run
alter table orbit.tie_scores add column if not exists share_score smallint
  check (share_score is null or share_score between 0 and 100);
comment on column orbit.tie_scores.share_score is
  'Plan 29 §A2.2: the score recomputed from LinkedIn, manual labels, shared context and engagement only (core shareScore). What a friend''s closeness word is built from; never the score itself.';

-- The rule the projection job also follows, held in the database so no writer can slip past it: a private, hidden or
-- do-not-contact person, or one the owner does not have, is never projected.
create or replace function orbit.friend_shares_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  select user_id, private, hidden_at, do_not_contact, deleted_at, merged_into, is_self
    into p from orbit.people where id = new.person_id;
  if p is null or p.user_id <> new.owner_user_id then
    raise exception 'friend_shares: % is not one of the owner''s people', new.person_id;
  end if;
  if p.private or p.hidden_at is not null or p.do_not_contact or p.deleted_at is not null
     or p.merged_into is not null or p.is_self then
    raise exception 'friend_shares: % is private, hidden or asked not to be contacted', new.person_id;
  end if;
  return new;
end
$$;
drop trigger if exists friend_shares_guard on orbit.friend_shares;
create trigger friend_shares_guard before insert or update on orbit.friend_shares
  for each row execute function orbit.friend_shares_guard();

-- a person turned private, hidden or do-not-contact leaves every projection at once, in the same transaction
create or replace function orbit.people_unshare()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.private and not old.private)
     or (new.hidden_at is not null and old.hidden_at is null)
     or (new.do_not_contact and not old.do_not_contact)
     or (new.deleted_at is not null and old.deleted_at is null)
     or (new.merged_into is not null and old.merged_into is null) then
    delete from orbit.friend_shares where owner_user_id = new.user_id and person_id = new.id;
  end if;
  return new;
end
$$;
drop trigger if exists people_unshare on orbit.people;
create trigger people_unshare after update of private, hidden_at, do_not_contact, deleted_at, merged_into on orbit.people
  for each row execute function orbit.people_unshare();

-- ---- an intro asked of a friend; the friend's answer makes the forward draft on their side --------------------------

create table if not exists orbit.friend_intro_asks (
  id uuid primary key default gen_random_uuid(),
  friendship_id uuid not null references orbit.friendships(id) on delete cascade,
  asker_user_id uuid not null references orbit.users(id) on delete cascade,
  friend_user_id uuid not null references orbit.users(id) on delete cascade,
  target_person_id uuid not null,            -- the friend's people.id (the projection row)
  asker_person_id uuid,                      -- the asker's own row for the same human, when they have one
  note text not null,                        -- the forwardable blurb, the asker's words
  status text not null check (status in ('asked','forwarded','declined','expired')) default 'asked',
  created_at timestamptz not null default now(), answered_at timestamptz,
  forwarded_message_id uuid               -- the friend's outbound message (orbit.drafts id), when sent
);
create index if not exists friend_intro_asks_friend_idx on orbit.friend_intro_asks (friend_user_id, status);
create index if not exists friend_intro_asks_asker_idx on orbit.friend_intro_asks (asker_user_id, status);

-- ---- the one cross-tenant predicate -------------------------------------------------------------------------------

-- May `viewer` read `owner`'s projection: an active friendship between the two, and the owner sharing something.
create or replace function orbit.friend_visible(viewer uuid, owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from orbit.friendships f
    join orbit.friend_share_settings s on s.friendship_id = f.id and s.owner_user_id = owner
    where f.status = 'active' and ((f.a = viewer and f.b = owner) or (f.a = owner and f.b = viewer))
      and s.mode <> 'none'
  );
$$;

-- Asks and invites end on their own after 14 days (plan 29 §A3). Called nightly and before every read of the lists.
create or replace function orbit.expire_friend_asks()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int := 0;
  m int := 0;
begin
  update orbit.friend_intro_asks set status = 'expired', answered_at = now()
   where status = 'asked' and created_at < now() - interval '14 days';
  get diagnostics n = row_count;
  update orbit.friend_invites set status = 'expired', answered_at = now()
   where status = 'pending' and expires_at < now();
  get diagnostics m = row_count;
  return n + m;
end
$$;

-- Nightly: every owner with an active friendship rebuilds their projection, so a person who changed company, a new
-- identity or a rescored tie reaches their friends by morning; the asks and invites past their time expire.
create or replace function orbit.enqueue_friend_refresh()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  day text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
begin
  perform orbit.expire_friend_asks();
  for r in
    select distinct u.id from orbit.users u
     where u.deleted_at is null
       and exists (select 1 from orbit.friendships f where f.status = 'active' and (f.a = u.id or f.b = u.id))
  loop
    if orbit.enqueue('orbit_score', jsonb_build_object(
      'kind', 'friend_shares_refresh', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'nightly:friend_shares_refresh:' || r.id || ':' || day)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-friends-nightly') then
    perform cron.unschedule('orbit-friends-nightly');
  end if;
  perform cron.schedule('orbit-friends-nightly', '43 7 * * *', $cron$select orbit.enqueue_friend_refresh()$cron$);
end
$$;

-- ---- row security, triggers and deletion -------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['friend_invites', 'friendships', 'friend_share_settings', 'friend_shares', 'friend_intro_asks'] loop
    execute format('alter table orbit.%I enable row level security', t);
  end loop;
  foreach t in array array['friend_share_settings', 'friend_shares'] loop
    execute format('drop trigger if exists touch_updated_at on orbit.%I', t);
    execute format(
      'create trigger touch_updated_at before update on orbit.%I for each row execute function orbit.touch_updated_at()',
      t
    );
  end loop;
end
$$;

-- delete_user gains the friends tables (plan 29 §A3): the rows keyed by a, b, from_user_id, owner_user_id,
-- asker_user_id and friend_user_id, which the user_id loop below never sees. Otherwise as 20261014_orbit_core.sql.
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

  -- friends (plan 29): both sides of every friendship, the invites, the projections and the asks either way
  delete from orbit.friend_intro_asks where asker_user_id = p_user or friend_user_id = p_user;
  delete from orbit.friend_shares where owner_user_id = p_user;
  delete from orbit.friend_share_settings where owner_user_id = p_user;
  delete from orbit.friendships where a = p_user or b = p_user;
  delete from orbit.friend_invites where from_user_id = p_user;

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

-- the same grants the core migration gives everything in the schema: service role only
do $$
declare
  t text;
begin
  foreach t in array array['friend_invites', 'friendships', 'friend_share_settings', 'friend_shares', 'friend_intro_asks'] loop
    execute format('revoke all on table orbit.%I from public, anon, authenticated', t);
    execute format('grant all on table orbit.%I to service_role', t);
  end loop;
end
$$;
revoke all on function orbit.friend_visible(uuid, uuid), orbit.friend_shares_guard(), orbit.people_unshare(),
  orbit.expire_friend_asks(), orbit.enqueue_friend_refresh() from public, anon, authenticated;
grant execute on function orbit.friend_visible(uuid, uuid), orbit.friend_shares_guard(), orbit.people_unshare(),
  orbit.expire_friend_asks(), orbit.enqueue_friend_refresh() to service_role;
