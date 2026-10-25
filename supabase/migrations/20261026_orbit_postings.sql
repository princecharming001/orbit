-- Job postings read by orbit-connectors' /posting route (docs/plan/23-goal-first.md §4.1). Postings are public pages,
-- so what Orbit read from one is kept 7 days and shared by everyone who pastes the same link, keyed by a hash of the
-- address. Nothing says who asked. The table lives in orbit_private; the function reaches it only through the two
-- service-role functions below.

create schema if not exists orbit_private;
revoke all on schema orbit_private from public, anon, authenticated;

create table if not exists orbit_private.posting_cache (
  key text primary key,
  url text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index if not exists posting_cache_expires on orbit_private.posting_cache (expires_at);
comment on table orbit_private.posting_cache is 'Orbit: what a public job posting says, by address hash, 7 days, shared.';
alter table orbit_private.posting_cache enable row level security;
revoke all on table orbit_private.posting_cache from public, anon, authenticated;

-- A cached answer that has not expired, or null.
create or replace function public.orbit_posting_get(p_key text)
returns jsonb
language sql
security definer
set search_path = orbit_private
as $$
  select value from orbit_private.posting_cache where key = p_key and expires_at > now()
$$;

-- Keep an answer for 7 days (a newer read of the same address replaces it); expired rows go on the way.
create or replace function public.orbit_posting_put(p_key text, p_url text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = orbit_private
as $$
begin
  delete from orbit_private.posting_cache where expires_at <= now();
  insert into orbit_private.posting_cache (key, url, value, created_at, expires_at)
  values (p_key, left(p_url, 2000), p_value, now(), now() + interval '7 days')
  on conflict (key) do update
    set url = excluded.url, value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.orbit_posting_get(text) from public, anon, authenticated;
revoke all on function public.orbit_posting_put(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.orbit_posting_get(text) to service_role;
grant execute on function public.orbit_posting_put(text, text, jsonb) to service_role;
