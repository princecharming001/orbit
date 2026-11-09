-- LinkedIn kept current on the server. sync.linkedin was queued only by Unipile's webhooks (never registered, so none
-- arrived), by Sync now and by a pass queueing its own next page, so once the long pass of 2026-11-08 ended nothing new
-- came in: no messages, no new connections. The ten-minute poll now queues LinkedIn too, for connected accounts not
-- synced in 10 minutes whose student was seen in the last 14 days (plan 34 D1). A full pass ended in the last 7 days, so
-- each of these is a short pass (worker FRESH_FOR_MS): the newest page of relations and the chats with activity since
-- the last pass, a few requests. Google is polled exactly as before.

create or replace function orbit.enqueue_incremental_syncs()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
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

  for r in
    select a.user_id from orbit.integration_accounts a
    join orbit.users u on u.id = a.user_id
    where a.provider = 'linkedin' and a.status = 'active' and a.external_account_id is not null
      and u.deleted_at is null
      and u.last_seen_at > now() - interval '14 days'
      and (a.last_synced_at is null or a.last_synced_at < now() - interval '10 minutes')
  loop
    if orbit.enqueue('orbit_sync', jsonb_build_object(
      'kind', 'sync.linkedin', 'userId', r.user_id, 'payload', jsonb_build_object('mode', 'sync', 'reason', 'poll'),
      'dedupeKey', 'linkedin-poll:' || r.user_id || ':' || slot)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$function$;
