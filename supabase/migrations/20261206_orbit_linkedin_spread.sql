-- LinkedIn reads that do not look like a crowd or a clock. Additive: one helper, one table, one function, and the three
-- schedulers replaced with only their LinkedIn enqueues changed.
--
-- 1. Spread the scheduled LinkedIn work. Unipile advises against polling at fixed times, and the three crons queued
--    LinkedIn work for every connected account in the same second. Each account's job now waits its own fixed offset
--    (from a hash of the account's key) plus a few random minutes, so the accounts spread over a window instead of
--    starting together, and one account does not start at exactly the same second every time:
--      orbit.enqueue_incremental_syncs  sync.linkedin    hourly    within 50 minutes, plus up to 5
--      orbit.enqueue_search_reading     search_reading   daily     within 12 hours, plus up to 20 minutes
--      orbit.enqueue_search_census      search_census    6-hourly  within 5.5 hours, plus up to 10 minutes
--    Google and everything else are queued exactly as before. The dedupe keys are unchanged: a job waiting in the queue
--    holds its key (orbit.enqueue finds it there), so the next tick cannot queue it again, and once it has run the key
--    is held for 24 hours.
--    The hourly LinkedIn poll was gated on "not synced in the last hour". With a spread start that gate would push each
--    account's next poll past its slot (a poll at 10:45 is not due again until the tick after 11:45, then waits its
--    offset once more), so the gate is now "not synced since this hour began", and the wait is cut so the job still
--    lands inside the hour it was queued for. Each account is polled about once an hour, at its own minute.
--    What the student asks for (Sync now, a page they open) is not scheduled and still runs at once.
--
-- 2. The swarm limit. LinkedIn bans the pattern of many accounts opening the same profile, and every account in it.
--    Every read aimed at one person (their profile, their connections, their activity) first asks
--    public.orbit_linkedin_target_take: one account may repeat itself freely, but a new account must wait a gap after
--    another account's read of that person, and at most a few accounts read them in a day. The person is kept as a
--    sha256 of the identifier as callers write it (trimmed, lower case), never the identifier itself, and rows go
--    after two days.

-- 1. the spread ------------------------------------------------------------------------------------------------------

-- seconds to wait: a fixed offset for this key within the window, plus a random wobble
create or replace function orbit.spread_delay(p_key text, p_window_seconds int, p_wobble_seconds int)
returns int
language sql
volatile
security definer
set search_path = ''
as $$
  select ((abs(hashtext(coalesce(p_key, ''))::bigint) % greatest(coalesce(p_window_seconds, 0), 1))
          + floor(random() * greatest(coalesce(p_wobble_seconds, 0), 0)))::int
$$;
revoke all on function orbit.spread_delay(text, int, int) from public, anon, authenticated;
grant execute on function orbit.spread_delay(text, int, int) to service_role;

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
  hour_began timestamptz := date_trunc('hour', utc) at time zone 'utc';
  hour_left int := greatest(0, 3599 - floor(extract(epoch from utc - date_trunc('hour', utc)))::int);
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

  -- LinkedIn: hourly; the webhooks carry what happens in between. Each account waits its own minute of the hour
  -- (orbit.spread_delay), cut so the job still runs inside this hour; the hour's key stops a second one
  for r in
    select a.user_id from orbit.integration_accounts a
    join orbit.users u on u.id = a.user_id
    where a.provider = 'linkedin' and a.status = 'active' and a.external_account_id is not null
      and u.deleted_at is null
      and u.last_seen_at > now() - interval '14 days'
      and (a.last_synced_at is null or a.last_synced_at < hour_began)
  loop
    if orbit.enqueue('orbit_sync', jsonb_build_object(
      'kind', 'sync.linkedin', 'userId', r.user_id, 'payload', jsonb_build_object('mode', 'sync', 'reason', 'poll'),
      'dedupeKey', 'linkedin-poll:' || r.user_id || ':' || hour),
      least(orbit.spread_delay('li-poll:' || r.user_id, 3000, 300), hour_left)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$function$;
revoke all on function orbit.enqueue_incremental_syncs() from public, anon, authenticated;
grant execute on function orbit.enqueue_incremental_syncs() to service_role;

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
    -- spread over the 12 hours after the 09:41 UTC run, plus up to 20 minutes
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'search_reading', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cron:search_reading:' || r.id || ':' || slot),
      orbit.spread_delay('li-reading:' || r.id, 43200, 1200)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_search_reading() from public, anon, authenticated;
grant execute on function orbit.enqueue_search_reading() to service_role;

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
    -- spread over 5.5 of the 6 hours to the next run, plus up to 10 minutes
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'search_census', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cron:search_census:' || r.id || ':' || slot),
      orbit.spread_delay('li-census:' || r.id, 19800, 600)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_search_census() from public, anon, authenticated;
grant execute on function orbit.enqueue_search_census() to service_role;

-- 2. the swarm limit ------------------------------------------------------------------------------------------------

create schema if not exists orbit_private;
revoke all on schema orbit_private from public, anon, authenticated;

create table if not exists orbit_private.linkedin_target_reads (
  target text not null,
  account text not null,
  at timestamptz not null default now()
);
create index if not exists linkedin_target_reads_target_at on orbit_private.linkedin_target_reads (target, at);
comment on table orbit_private.linkedin_target_reads is
  'Orbit: which Unipile account looked up which LinkedIn person (a sha256 of the identifier) and when; two days.';
alter table orbit_private.linkedin_target_reads enable row level security;
revoke all on table orbit_private.linkedin_target_reads from public, anon, authenticated;

-- May this account look this person up now? {"allowed": bool, "retryAt": iso or null}. An allowed look is recorded.
create or replace function public.orbit_linkedin_target_take(
  p_target text,
  p_account text,
  p_max_accounts integer default 3,
  p_gap_seconds integer default 1200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = orbit_private
as $$
declare
  v_norm text := lower(trim(coalesce(p_target, '')));
  v_account text := left(trim(coalesce(p_account, '')), 200);
  v_max integer := greatest(coalesce(p_max_accounts, 3), 1);
  v_gap integer := greatest(coalesce(p_gap_seconds, 1200), 0);
  v_now timestamptz := now();
  v_target text;
  v_others integer;
  v_at timestamptz;
begin
  if v_norm = '' or v_account = '' then
    return jsonb_build_object('allowed', false, 'retryAt', null);
  end if;
  v_target := encode(sha256(convert_to(v_norm, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('orbit.linkedin_target_take:' || v_target, 0));
  delete from orbit_private.linkedin_target_reads where target = v_target and at < v_now - interval '2 days';

  -- one account looking again at someone it looked at today is fine
  if exists (select 1 from orbit_private.linkedin_target_reads
              where target = v_target and account = v_account and at > v_now - interval '24 hours') then
    insert into orbit_private.linkedin_target_reads (target, account, at) values (v_target, v_account, v_now);
    return jsonb_build_object('allowed', true, 'retryAt', null);
  end if;

  -- enough other accounts looked at them today: room opens when the earliest of them leaves the 24 hours
  select count(distinct account) into v_others from orbit_private.linkedin_target_reads
   where target = v_target and account <> v_account and at > v_now - interval '24 hours';
  if v_others >= v_max then
    select x.last_at into v_at from (
      select max(at) as last_at from orbit_private.linkedin_target_reads
       where target = v_target and account <> v_account and at > v_now - interval '24 hours'
       group by account) x
     order by x.last_at
     offset v_others - v_max limit 1;
    return jsonb_build_object('allowed', false,
      'retryAt', to_char((v_at + interval '24 hours') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;

  -- another account looked at them a moment ago: wait the gap, and a few random minutes more
  select max(at) into v_at from orbit_private.linkedin_target_reads
   where target = v_target and account <> v_account and at > v_now - make_interval(secs => v_gap);
  if v_at is not null then
    return jsonb_build_object('allowed', false,
      'retryAt', to_char((v_at + make_interval(secs => v_gap + floor(random() * 600)::int)) at time zone 'utc',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;

  insert into orbit_private.linkedin_target_reads (target, account, at) values (v_target, v_account, v_now);
  return jsonb_build_object('allowed', true, 'retryAt', null);
end;
$$;
revoke all on function public.orbit_linkedin_target_take(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.orbit_linkedin_target_take(text, text, integer, integer) to service_role;
