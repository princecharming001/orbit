-- Orbit's schedules (docs/plan/16-network-agent-infrastructure.md §9.1, §16), after 20261014_orbit_core.sql.
-- Re-runnable: every orbit-* job is unscheduled first, then scheduled again.
--
-- The worker tick posts to the orbit-worker function through pg_net, following Supabase's scheduled-functions
-- pattern. Two Vault secrets must exist first (created once by hand, never committed; see supabase/functions/README.md):
--   orbit_functions_url  e.g. https://<ref>.supabase.co/functions/v1
--   orbit_cron_secret    the same value as the orbit-worker function secret ORBIT_CRON_SECRET
-- Until both exist the tick does nothing (orbit.cron_call_worker returns null).

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function orbit.cron_call_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'orbit_functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'orbit_cron_secret';
  if coalesce(base, '') = '' or coalesce(secret, '') = '' then
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/orbit-worker',
    body := jsonb_build_object('tick', now()),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-orbit-cron', secret),
    timeout_milliseconds := 5000
  );
end
$$;
revoke all on function orbit.cron_call_worker() from public, anon, authenticated;
grant execute on function orbit.cron_call_worker() to service_role;

select cron.unschedule(jobid)
  from cron.job
 where jobname in ('orbit-worker-tick', 'orbit-incremental', 'orbit-cadence', 'orbit-nightly', 'orbit-retention',
                   'orbit-health');

select cron.schedule('orbit-worker-tick', '* * * * *', $$select orbit.cron_call_worker()$$);
select cron.schedule('orbit-incremental', '*/10 * * * *', $$select orbit.enqueue_incremental_syncs()$$);
select cron.schedule('orbit-cadence', '7 * * * *', $$select orbit.enqueue_cadence()$$);
select cron.schedule('orbit-nightly', '13 7 * * *', $$select orbit.enqueue_nightly()$$);
select cron.schedule('orbit-retention', '23 8 * * *', $$select orbit.retention_purge()$$);
-- written straight from SQL so a stalled worker still shows up in the snapshots
select cron.schedule('orbit-health', '*/15 * * * *', $$select orbit.health_snapshot()$$);
