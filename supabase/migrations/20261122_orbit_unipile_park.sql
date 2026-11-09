-- Plan 35 E1 and E5: the LinkedIn line. Additive only.
--
-- E1  orbit-unipile-reconcile at 07:30 UTC queues one unipile.reconcile job: the worker lists the accounts on the
--     shared Unipile key (read only, never deletes) and writes an audit row with Orbit's linked accounts, the LinkedIn
--     accounts Orbit made that no student row holds (orphans), and everyone else's (Osmo's) counted apart. The cost
--     digest (07:50) and orbit.health() read the newest row.
-- E5  integration_accounts.status gains 'parked': a student away ORBIT_LINKEDIN_PARK_DAYS days (worker setting,
--     default 21, 0 is off) with nothing waiting on LinkedIn has the Unipile link removed (Unipile bills the peak of
--     linked accounts) while the row and every synced row stay. orbit-linkedin-park at 07:10 UTC queues one
--     linkedin.park job; the poll already passes over a row that is not active.

alter table orbit.integration_accounts drop constraint if exists integration_accounts_status_check;
alter table orbit.integration_accounts add constraint integration_accounts_status_check
  check (status in ('active', 'needs_reauth', 'revoked', 'error', 'connecting', 'parked'));

create index if not exists audit_log_action_created_idx on orbit.audit_log (action, created_at desc)
  where action in ('unipile.reconcile', 'linkedin.park');

create or replace function orbit.enqueue_unipile_reconcile()
returns bigint
language sql
security definer
set search_path to ''
as $$
  select orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'unipile.reconcile', 'payload', '{}'::jsonb,
    'dedupeKey', 'unipile.reconcile:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')))
$$;
revoke all on function orbit.enqueue_unipile_reconcile() from public, anon, authenticated;

create or replace function orbit.enqueue_linkedin_park()
returns bigint
language sql
security definer
set search_path to ''
as $$
  select orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'linkedin.park', 'payload', '{}'::jsonb,
    'dedupeKey', 'linkedin.park:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')))
$$;
revoke all on function orbit.enqueue_linkedin_park() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-unipile-reconcile') then
    perform cron.unschedule('orbit-unipile-reconcile');
  end if;
  perform cron.schedule('orbit-unipile-reconcile', '30 7 * * *', $cron$select orbit.enqueue_unipile_reconcile()$cron$);
  if exists (select 1 from cron.job where jobname = 'orbit-linkedin-park') then
    perform cron.unschedule('orbit-linkedin-park');
  end if;
  perform cron.schedule('orbit-linkedin-park', '10 7 * * *', $cron$select orbit.enqueue_linkedin_park()$cron$);
end
$$;

-- health() as of 20261105, plus the newest reconcile's orphan count (null before it first runs) and parked links
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
    -- runs still 'running' long after they started: the isolate died under them (a CPU or memory limit)
    'orphaned_runs', (select count(*) from orbit.job_runs where status = 'running' and started_at < now() - interval '10 minutes'),
    -- hours since the stalest user's newest tie score: the nightly rebuild is late when this passes 36
    'scores_oldest_hours', (select coalesce(max(extract(epoch from now() - last) / 3600), 0)::int
                              from (select max(computed_at) as last from orbit.tie_scores group by user_id) x),
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
    ),
    -- plan 35 E1: LinkedIn accounts Orbit made at Unipile that no student row holds, each billed until deleted
    'unipile_orphans', (
      select (details->>'orbitOrphanCount')::int from orbit.audit_log
       where action = 'unipile.reconcile' order by created_at desc limit 1
    ),
    'unipile_reconciled_at', (
      select max(created_at) from orbit.audit_log where action = 'unipile.reconcile'
    ),
    -- plan 35 E5: LinkedIn links parked while their student is away
    'linkedin_parked', (select count(*) from orbit.integration_accounts where provider = 'linkedin' and status = 'parked')
  )
$$;
