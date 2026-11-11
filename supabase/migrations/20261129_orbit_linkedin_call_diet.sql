-- Plan 41: fewer LinkedIn reads. Additive.
--
-- 1. People's photos are kept in Orbit's storage (bucket people-photos), like company logos, so a picture is read
--    from LinkedIn once and its link never expires.
-- 2. A kept photo's record stays a year in orbit_private.linkedin_shared (the put function allowed 45 days at most).
-- 3. orbit.linkedin_calls_daily: per account, ledger and part of Orbit, how many reads were made, how many were
--    answered from what Orbit already kept, and how many were refused. This is how the saving is checked. It holds
--    no profile data and nothing that names a person: account ids, ledger names and counts.

-- 1. the bucket (only where Supabase Storage exists: a bare Postgres, such as the tests' PGlite, has no storage schema)
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('people-photos', 'people-photos', true, 614400,
            array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    on conflict (id) do update set public = true;
  end if;
end;
$$;

-- 2. shared reads may be kept up to 400 days (photos); everything else passes its own, shorter time
create or replace function public.orbit_linkedin_shared_put(p_key text, p_value jsonb, p_days integer default 1)
returns void
language plpgsql
security definer
set search_path = orbit_private
as $$
begin
  delete from orbit_private.linkedin_shared where expires_at <= now();
  insert into orbit_private.linkedin_shared (key, value, created_at, expires_at)
  values (p_key, p_value, now(), now() + make_interval(days => greatest(1, least(coalesce(p_days, 1), 400))))
  on conflict (key) do update
    set value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.orbit_linkedin_shared_put(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.orbit_linkedin_shared_put(text, jsonb, integer) to service_role;

-- 3. the daily count
create table if not exists orbit.linkedin_calls_daily (
  day date not null,
  linkedin_account text not null,
  kind text not null,
  caller text not null,
  made integer not null default 0,
  saved integer not null default 0,
  refused integer not null default 0,
  counted_at timestamptz not null default now(),
  primary key (day, linkedin_account, kind, caller)
);
comment on table orbit.linkedin_calls_daily is
  'Orbit: LinkedIn reads per day, account, ledger and caller: made, answered from what was kept, refused (plan 41).';
alter table orbit.linkedin_calls_daily enable row level security;
revoke all on table orbit.linkedin_calls_daily from public, anon, authenticated;

create or replace function public.orbit_linkedin_calls_add(
  p_account text,
  p_kind text,
  p_caller text,
  p_made integer default 0,
  p_saved integer default 0,
  p_refused integer default 0
)
returns void
language sql
security definer
set search_path = orbit
as $$
  insert into orbit.linkedin_calls_daily (day, linkedin_account, kind, caller, made, saved, refused)
  values ((now() at time zone 'utc')::date, left(p_account, 120), left(p_kind, 40), left(p_caller, 40),
          greatest(0, coalesce(p_made, 0)), greatest(0, coalesce(p_saved, 0)), greatest(0, coalesce(p_refused, 0)))
  on conflict (day, linkedin_account, kind, caller) do update
    set made = orbit.linkedin_calls_daily.made + excluded.made,
        saved = orbit.linkedin_calls_daily.saved + excluded.saved,
        refused = orbit.linkedin_calls_daily.refused + excluded.refused,
        counted_at = now()
$$;

revoke all on function public.orbit_linkedin_calls_add(text, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.orbit_linkedin_calls_add(text, text, text, integer, integer, integer) to service_role;
