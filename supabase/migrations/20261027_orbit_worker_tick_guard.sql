-- The worker tick only when there is work (docs/plan/26-cost-and-speed.md #3). pg_cron still fires every minute, but
-- the function posts to orbit-worker only when a queue has a visible message, or on the ten-minute heartbeat so a
-- message that slipped past the depth check (visibility timeouts, a race with enqueue) is still picked up within ten
-- minutes. With two users this was 1,437 near-empty invocations a day.

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
  heartbeat := extract(minute from now())::int % 10 = 0;
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
