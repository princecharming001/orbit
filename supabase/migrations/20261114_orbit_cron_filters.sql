-- Plan 34 D1: the crons enqueue only when there is work to do.
--   search_reading   every 6 hours (was 2), and only for a student with a LinkedIn connection whose profile has not
--                    been read in the last 180 days; 15 runs a day found little or nothing to read
--   search_census    every 6 hours (was 3): the 40-page daily ledger share is the real bound, 4 steps reach it
--   cadence.user     hourly, only for a student seen in the last 14 days or with an open draft, card or goal
--   nightly          the calendar re-lists two years back on Sundays only (an ordinary nightly sync otherwise), and
--                    score.user runs only when something new arrived since the last scores, or they are a week old
--   worker tick      the heartbeat post is every 30 minutes (was 10); a queue with work still posts every minute
--   orbit-health     hourly (was every 15 minutes)

create or replace function orbit.enqueue_search_reading()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  r record;
  n int := 0;
  slot text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
begin
  for r in
    select distinct a.user_id as id
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id and u.deleted_at is null
     where a.provider = 'linkedin' and a.status = 'active'
       and exists (
         select 1 from orbit.people p
          where p.user_id = a.user_id and p.linkedin_member_id is not null and p.deleted_at is null
            and not exists (
              select 1 from orbit.profile_reads pr
               where pr.user_id = p.user_id and pr.person_id = p.id
                 and pr.read_at > now() - interval '180 days'))
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

-- a student Orbit should still work for: seen lately, or with something open that cadence moves forward
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
         or exists (select 1 from orbit.drafts d
                     where d.user_id = u.id and d.status in ('draft', 'approved', 'scheduled'))
         or exists (select 1 from orbit.chats c where c.user_id = u.id and c.archived_at is null)
         or exists (select 1 from orbit.goals g
                     where g.user_id = u.id and g.status = 'active' and g.deleted_at is null))
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
    -- scores are rebuilt when a message, meeting or person arrived after the last rebuild, and at least weekly so
    -- recency decay still moves them
    select max(s.computed_at) into scored from orbit.tie_scores s where s.user_id = r.id;
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

create or replace function orbit.cron_call_worker()
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
declare
  base text;
  secret text;
  waiting boolean;
  heartbeat boolean;
begin
  heartbeat := extract(minute from now())::int % 30 = 0;
  select exists (select 1 from orbit.queue_depth() q where coalesce(q.visible, 0) > 0) into waiting;
  if not waiting and not heartbeat then
    return null;
  end if;
  select decrypted_secret into base from vault.decrypted_secrets where name = 'orbit_functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'orbit_cron_secret';
  if coalesce(base, '') = '' or coalesce(secret, '') = '' then
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/orbit-worker',
    body := jsonb_build_object('tick', now(), 'reason', case when waiting then 'queue' else 'heartbeat' end),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-orbit-cron', secret),
    timeout_milliseconds := 5000
  );
end
$$;
revoke all on function orbit.cron_call_worker() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-search-reading') then
    perform cron.unschedule('orbit-search-reading');
  end if;
  perform cron.schedule('orbit-search-reading', '41 */6 * * *', $cron$select orbit.enqueue_search_reading()$cron$);
  if exists (select 1 from cron.job where jobname = 'orbit-search-census') then
    perform cron.unschedule('orbit-search-census');
  end if;
  perform cron.schedule('orbit-search-census', '11 */6 * * *', $cron$select orbit.enqueue_search_census()$cron$);
  if exists (select 1 from cron.job where jobname = 'orbit-health') then
    perform cron.unschedule('orbit-health');
  end if;
  perform cron.schedule('orbit-health', '3 * * * *', $cron$select orbit.health_snapshot()$cron$);
end
$$;
