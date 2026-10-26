-- Public LinkedIn reads shared across students for a day (orbit-connectors). When twenty students look at the same
-- Stripe recruiter, one student's account reads her profile and posts and the other nineteen get that copy, so
-- LinkedIn never sees many accounts opening the same person at once, and nobody spends a read on it twice.
-- Only what anyone on LinkedIn would see is kept: work history, schools, about, photo, follower and connection counts,
-- recommendations, and public activity (posts, reactions, comments). Never contact details, never network distance,
-- never a read LinkedIn held sections back on, and nothing that says which student asked. Keys are hashes.
-- The table lives in orbit_private; the function reaches it only through the two service-role functions below.

create schema if not exists orbit_private;
revoke all on schema orbit_private from public, anon, authenticated;

create table if not exists orbit_private.linkedin_shared (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 day'
);
create index if not exists linkedin_shared_expires on orbit_private.linkedin_shared (expires_at);
comment on table orbit_private.linkedin_shared is
  'Orbit: public LinkedIn reads (profile public parts, activity pages), by key hash, 1 day, shared across students.';
alter table orbit_private.linkedin_shared enable row level security;
revoke all on table orbit_private.linkedin_shared from public, anon, authenticated;

-- A shared read that has not expired, or null.
create or replace function public.orbit_linkedin_shared_get(p_key text)
returns jsonb
language sql
security definer
set search_path = orbit_private
as $$
  select value from orbit_private.linkedin_shared where key = p_key and expires_at > now()
$$;

-- Keep a read for a day (a newer read of the same thing replaces it); expired rows go on the way.
create or replace function public.orbit_linkedin_shared_put(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = orbit_private
as $$
begin
  delete from orbit_private.linkedin_shared where expires_at <= now();
  insert into orbit_private.linkedin_shared (key, value, created_at, expires_at)
  values (p_key, p_value, now(), now() + interval '1 day')
  on conflict (key) do update
    set value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.orbit_linkedin_shared_get(text) from public, anon, authenticated;
revoke all on function public.orbit_linkedin_shared_put(text, jsonb) from public, anon, authenticated;
grant execute on function public.orbit_linkedin_shared_get(text) to service_role;
grant execute on function public.orbit_linkedin_shared_put(text, jsonb) to service_role;
