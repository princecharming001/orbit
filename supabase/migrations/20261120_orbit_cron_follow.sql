-- Plan 35 B5 and B6: the crons follow the student.
--   orbit-incremental   Google work only for a student seen in the last 14 days, or with a draft going out or a reply
--                       awaited (a networking thread whose last message is theirs, in the last 14 days). Gmail is
--                       polled only while no Gmail watch is active (push delivers it; the nightly sync stays as the
--                       net). The calendar every 30 minutes for a student seen in the last day, hourly otherwise
--                       (no longer skipped when a Gmail sync happened to stamp last_synced_at in the last 10 minutes).
--                       LinkedIn hourly instead of every 10 minutes: Unipile's webhooks deliver messages and account
--                       status as they happen. Gmail and the calendar stay separate jobs: they now run at different
--                       rates, so one combined job would save nothing.
--   orbit-cadence       the "has an unarchived chat" clause matched nearly everyone, so the 14-day filter did
--                       nothing. A student away for 14 days is now scanned only when something is due within the
--                       hour: a draft to send (or one stuck sending), a stage timer (followed up or completed for 14
--                       days, outreach sent 3 days ago or more), or a goal running on autopilot.
--   orbit-nightly       "scored since" reads people.scored_at (plan 35 B1): unchanged tie_scores rows keep their old
--                       computed_at now (B2), so the latest score time is the latest scored_at.
--   orbit-friends-nightly  still expires old friend asks every night, but rebuilds a projection only when something
--                       it is made from changed since the last rebuild (people, scores, labels, organizations,
--                       identities). The last page of a score run already rebuilds it after scores move.
--   orbit-search-reading   daily (was every 6 hours), and only for profiles someone asked about in the last 7 days
--                       (orbit.profile_requests: a network search's read or label, a Map target, an opened person
--                       page) plus, once, the 50 closest people never read.
--   orbit-search-census    every 6 hours until the first full pass ends, then one step a week.
-- Additive only: one new table and replaced functions; schedules re-registered under the same names.

create table if not exists orbit.profile_requests (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  requested_at timestamptz not null default now(),
  primary key (user_id, person_id)
);
create index if not exists profile_requests_recent_idx on orbit.profile_requests (user_id, requested_at desc);
alter table orbit.profile_requests enable row level security;
revoke all on table orbit.profile_requests from public, anon, authenticated;
grant all on table orbit.profile_requests to service_role;

-- a student Orbit should still poll Google for: seen lately, a draft going out, or a reply awaited
create or replace function orbit.follows_student(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from orbit.users u where u.id = p_user and u.last_seen_at > now() - interval '14 days')
      or exists (select 1 from orbit.drafts d
                  where d.user_id = p_user and d.status in ('approved', 'scheduled', 'sending'))
      or exists (select 1 from orbit.threads t
                  where t.user_id = p_user and t.is_networking and t.last_direction = 'out'
                    and t.last_at > now() - interval '14 days')
$$;
revoke all on function orbit.follows_student(uuid) from public, anon, authenticated;

create or replace function orbit.enqueue_incremental_syncs()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  r record;
  n int := 0;
  utc timestamp := now() at time zone 'utc';
  slot text := to_char(date_trunc('hour', utc) + floor(extract(minute from utc) / 10) * interval '10 minutes',
    'YYYY-MM-DD-HH24-MI');
  half text := to_char(date_trunc('hour', utc) + floor(extract(minute from utc) / 30) * interval '30 minutes',
    'YYYY-MM-DD-HH24-MI');
  hour text := to_char(utc, 'YYYY-MM-DD-HH24');
begin
  for r in
    select a.user_id, a.scopes, a.watch_expires_at, a.last_synced_at, u.last_seen_at
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id
     where a.provider = 'google' and a.status = 'active' and u.deleted_at is null
       and orbit.follows_student(a.user_id)
  loop
    -- Gmail: pushed while a watch is active, polled otherwise
    if exists (select 1 from unnest(r.scopes) s where s like '%gmail.readonly')
       and (r.watch_expires_at is null or r.watch_expires_at <= now())
       and (r.last_synced_at is null or r.last_synced_at < now() - interval '10 minutes') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.gmail.incremental', 'userId', r.user_id, 'payload', jsonb_build_object('reason', 'poll'),
        'dedupeKey', 'gmail-poll:' || r.user_id || ':' || slot)) is not null then
        n := n + 1;
      end if;
    end if;
    -- the calendar: once a half hour for a student seen in the last day, once an hour for the rest (the key holds
    -- the slot: orbit.enqueue drops a key that ran in the last 24 hours, so the 10-minute cron cannot repeat it)
    if exists (select 1 from unnest(r.scopes) s where s like '%calendar.readonly' or s like '%calendar.events') then
      if orbit.enqueue('orbit_sync', jsonb_build_object(
        'kind', 'sync.calendar', 'userId', r.user_id, 'payload', jsonb_build_object('reason', 'poll'),
        'dedupeKey', 'calendar-poll:' || r.user_id || ':'
          || case when r.last_seen_at > now() - interval '1 day' then half else hour end)) is not null then
        n := n + 1;
      end if;
    end if;
  end loop;

  -- LinkedIn: hourly; the webhooks carry what happens in between
  for r in
    select a.user_id from orbit.integration_accounts a
    join orbit.users u on u.id = a.user_id
    where a.provider = 'linkedin' and a.status = 'active' and a.external_account_id is not null
      and u.deleted_at is null
      and u.last_seen_at > now() - interval '14 days'
      and (a.last_synced_at is null or a.last_synced_at < now() - interval '1 hour')
  loop
    if orbit.enqueue('orbit_sync', jsonb_build_object(
      'kind', 'sync.linkedin', 'userId', r.user_id, 'payload', jsonb_build_object('mode', 'sync', 'reason', 'poll'),
      'dedupeKey', 'linkedin-poll:' || r.user_id || ':' || hour)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$function$;
revoke all on function orbit.enqueue_incremental_syncs() from public, anon, authenticated;

create or replace function orbit.enqueue_cadence()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  r record;
  n int := 0;
  hour text := to_char(now() at time zone 'utc', 'YYYY-MM-DD-HH24');
begin
  for r in
    select u.id from orbit.users u
     where u.deleted_at is null
       and (u.last_seen_at > now() - interval '14 days'
         or exists (select 1 from orbit.sessions s
                     where s.user_id = u.id and s.revoked_at is null
                       and coalesce(s.last_used_at, s.created_at) > now() - interval '14 days')
         -- a draft to send within the hour, or one a dead worker left sending
         or exists (select 1 from orbit.drafts d
                     where d.user_id = u.id
                       and (d.status = 'sending'
                         or (d.status in ('approved', 'scheduled')
                             and (d.send_at is null or d.send_at <= now() + interval '1 hour'))))
         -- a stage timer due within the hour (core cadence stageTimer; outreach sent 3 days ago may need a bump)
         or exists (select 1 from orbit.chats c
                     where c.user_id = u.id and c.archived_at is null
                       and ((c.stage in ('followed_up', 'completed')
                             and c.stage_entered_at <= now() - interval '14 days' + interval '1 hour')
                         or (c.stage = 'outreach_sent'
                             and c.stage_entered_at <= now() - interval '3 days' + interval '1 hour')))
         -- a goal on autopilot plans tomorrow's first messages whether or not the student is around
         or exists (select 1 from orbit.goals g
                     where g.user_id = u.id and g.status = 'active' and g.deleted_at is null
                       and coalesce(g.autonomy_level, u.autonomy_level) = 2))
  loop
    if orbit.enqueue('orbit_cadence', jsonb_build_object(
      'kind', 'cadence.user', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cadence:' || r.id || ':' || hour)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_cadence() from public, anon, authenticated;

create or replace function orbit.enqueue_nightly()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  r record;
  n int := 0;
  day text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  sunday boolean := extract(dow from now() at time zone 'utc') = 0;
  scored timestamptz;
  stale boolean;
begin
  for r in
    select u.id, a.scopes, a.status from orbit.users u
    left join orbit.integration_accounts a on a.user_id = u.id and a.provider = 'google'
    where u.deleted_at is null
  loop
    -- scores are rebuilt when a message, meeting or person arrived after the last scoring, and at least weekly so
    -- recency decay still moves them; the run itself rescores only the people with something new (plan 35 B1)
    select greatest((select max(p.scored_at) from orbit.people p where p.user_id = r.id),
                    (select max(s.computed_at) from orbit.tie_scores s where s.user_id = r.id))
      into scored;
    stale := scored is null
      or scored < now() - interval '7 days'
      or exists (select 1 from orbit.messages m where m.user_id = r.id and m.created_at > scored)
      or exists (select 1 from orbit.calendar_events e where e.user_id = r.id and e.created_at > scored)
      or exists (select 1 from orbit.people p where p.user_id = r.id and p.created_at > scored);
    if stale and orbit.enqueue('orbit_score', jsonb_build_object(
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
        'kind', 'sync.calendar', 'userId', r.id,
        'payload', case when sunday then jsonb_build_object('resync', true) else '{}'::jsonb end,
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
revoke all on function orbit.enqueue_nightly() from public, anon, authenticated;

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
  built timestamptz;
begin
  perform orbit.expire_friend_asks();
  for r in
    select distinct u.id from orbit.users u
     where u.deleted_at is null
       and exists (select 1 from orbit.friendships f where f.status = 'active' and (f.a = u.id or f.b = u.id))
  loop
    select max(fs.updated_at) into built from orbit.friend_shares fs where fs.owner_user_id = r.id;
    continue when built is not null
      and not exists (select 1 from orbit.people p where p.user_id = r.id and p.updated_at > built)
      and not exists (select 1 from orbit.tie_scores s where s.user_id = r.id and s.updated_at > built)
      and not exists (select 1 from orbit.tie_labels l where l.user_id = r.id and l.updated_at > built)
      and not exists (select 1 from orbit.organizations o where o.user_id = r.id and o.updated_at > built)
      and not exists (select 1 from orbit.person_identities i where i.user_id = r.id and i.created_at > built);
    if orbit.enqueue('orbit_score', jsonb_build_object(
      'kind', 'friend_shares_refresh', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'nightly:friend_shares_refresh:' || r.id || ':' || day)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_friend_refresh() from public, anon, authenticated;

-- the profiles background reading may take: asked about in the last 7 days, or among the 50 closest and never read
create or replace function orbit.reading_candidates(p_user uuid, p_limit int default 50)
returns table (person_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from orbit.people p
    join orbit.profile_requests q on q.user_id = p.user_id and q.person_id = p.id
   where p.user_id = p_user and q.requested_at > now() - interval '7 days'
     and p.deleted_at is null and p.merged_into is null and p.hidden_at is null and not p.is_self
     and coalesce(p.linkedin_member_id, p.linkedin_slug) is not null
     and not exists (select 1 from orbit.profile_reads r
                      where r.user_id = p.user_id and r.person_id = p.id and r.read_at > now() - interval '180 days')
  union
  select top.id from (
    select p.id from orbit.people p
     where p.user_id = p_user and p.deleted_at is null and p.merged_into is null and p.hidden_at is null
       and not p.is_self and coalesce(p.linkedin_member_id, p.linkedin_slug) is not null
     order by p.strength desc, p.id
     limit p_limit) top
   where not exists (select 1 from orbit.profile_reads r where r.user_id = p_user and r.person_id = top.id)
$$;
revoke all on function orbit.reading_candidates(uuid, int) from public, anon, authenticated;

create or replace function orbit.enqueue_search_reading()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  r record;
  n int := 0;
  slot text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
begin
  for r in
    select distinct a.user_id as id
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id and u.deleted_at is null
     where a.provider = 'linkedin' and a.status = 'active'
       and exists (select 1 from orbit.reading_candidates(a.user_id))
  loop
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'search_reading', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cron:search_reading:' || r.id || ':' || slot)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_search_reading() from public, anon, authenticated;

create or replace function orbit.enqueue_search_census()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  slot text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
  -- the week's one step for a student whose first pass is done: Monday's first run (00:00 to 05:59 UTC)
  weekly boolean := extract(dow from now() at time zone 'utc') = 1 and extract(hour from now() at time zone 'utc') < 6;
begin
  for r in
    select distinct a.user_id as id
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id and u.deleted_at is null
      left join orbit.search_census c on c.user_id = a.user_id
     where a.provider = 'linkedin' and a.status = 'active'
       and (c.pass_done_at is null
         or (weekly and (c.cursor is not null or c.pass_done_at < now() - interval '30 days')))
  loop
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'search_census', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cron:search_census:' || r.id || ':' || slot)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_search_census() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-search-reading') then
    perform cron.unschedule('orbit-search-reading');
  end if;
  perform cron.schedule('orbit-search-reading', '41 9 * * *', $cron$select orbit.enqueue_search_reading()$cron$);
end
$$;
