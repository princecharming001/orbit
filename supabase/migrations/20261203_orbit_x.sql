-- Plan 43 §5: X's schedule. Additive and re-runnable.
--
-- orbit.enqueue_x(), hourly (cron 'orbit-x'):
--   x.dms     with no user, once an hour while anyone has X connected: the worker queues a DM read for each student
--             whose read is due (hourly while waiting on a reply over X, daily otherwise)
--   x.expire  once a day: X rows in the shared graph past their 30 days are deleted (X's rule that stored data follows
--             the platform)
-- Nothing else is needed in the schema: integration_accounts takes provider 'x' and social_account_id, the tokens live
-- in Vault, spending in orbit.usage_ledger and orbit.social_calls (20261130_orbit_social_sources.sql).

create or replace function orbit.enqueue_x()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  n int := 0;
begin
  if exists (select 1 from orbit.integration_accounts where provider = 'x' and status = 'active') then
    if orbit.enqueue('orbit_sync', jsonb_build_object(
      'kind', 'x.dms', 'payload', '{}'::jsonb,
      'dedupeKey', 'x.dms:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD-HH24'))) is not null then
      n := n + 1;
    end if;
  end if;
  if orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'x.expire', 'payload', '{}'::jsonb,
    'dedupeKey', 'x.expire:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'))) is not null then
    n := n + 1;
  end if;
  return n;
end
$$;
revoke all on function orbit.enqueue_x() from public, anon, authenticated;
grant execute on function orbit.enqueue_x() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-x') then
    perform cron.unschedule('orbit-x');
  end if;
  perform cron.schedule('orbit-x', '37 * * * *', $cron$select orbit.enqueue_x()$cron$);
end
$$;
