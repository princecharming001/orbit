-- Plan 37 follow-up: every company in a student's network gets its LinkedIn logo, not only companies 3 or more people
-- share across students (logos.sweep). Once a day, for each student with LinkedIn connected, orbit-worker logos.user
-- looks up the companies the shared list (orbit_private.linkedin_companies) does not answer yet, most people first,
-- from the student's own account and within part of its daily company ledger; it queues its next part while names are
-- left. Additive only: one function and one cron job.

create or replace function orbit.enqueue_logos_users()
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
  for r in
    select distinct a.user_id as id
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id and u.deleted_at is null
     where a.provider = 'linkedin' and a.status = 'active' and a.external_account_id is not null
  loop
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'logos.user', 'userId', r.id, 'payload', jsonb_build_object('part', 0),
      'dedupeKey', 'logos.user:' || r.id || ':' || day || ':0')) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_logos_users() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-logos-users') then
    perform cron.unschedule('orbit-logos-users');
  end if;
  perform cron.schedule('orbit-logos-users', '23 10 * * *', $cron$select orbit.enqueue_logos_users()$cron$);
end
$$;
