-- Orbit's shared Claude access (supabase/functions/orbit-claude): request counters and the server-side key.
-- Applied to the shared Supabase project; every object is prefixed orbit_ and reachable by the service role only.

create table if not exists public.orbit_proxy_counters (
  bucket text primary key,
  count integer not null default 0,
  expires_at timestamptz not null
);
comment on table public.orbit_proxy_counters is 'Orbit Claude proxy: request counters per visitor and day/minute window. Service role only.';
alter table public.orbit_proxy_counters enable row level security;
revoke all on public.orbit_proxy_counters from anon, authenticated;

-- Increment every bucket atomically and report whether all stayed within their limits.
create or replace function public.orbit_proxy_take(p_buckets text[], p_limits integer[], p_expires timestamptz[])
returns table(allowed boolean, over_bucket text)
language plpgsql
security definer
set search_path = public
as $$
declare
  i integer;
  c integer;
begin
  if random() < 0.02 then
    delete from public.orbit_proxy_counters where expires_at < now();
  end if;
  for i in 1 .. coalesce(array_length(p_buckets, 1), 0) loop
    insert into public.orbit_proxy_counters as t (bucket, count, expires_at)
      values (p_buckets[i], 1, p_expires[i])
      on conflict (bucket) do update set count = t.count + 1
      returning t.count into c;
    if c > p_limits[i] then
      allowed := false;
      over_bucket := p_buckets[i];
      return next;
      return;
    end if;
  end loop;
  allowed := true;
  over_bucket := null;
  return next;
end;
$$;
revoke all on function public.orbit_proxy_take(text[], integer[], timestamptz[]) from public, anon, authenticated;
grant execute on function public.orbit_proxy_take(text[], integer[], timestamptz[]) to service_role;

-- The Anthropic key, when it is not set as a function secret. Not in an exposed schema; read only through
-- orbit_secret(), which only the service role may call. The value is inserted out of band, never committed.
create schema if not exists orbit_private;
revoke all on schema orbit_private from public, anon, authenticated;
create table if not exists orbit_private.secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table orbit_private.secrets enable row level security;
revoke all on all tables in schema orbit_private from public, anon, authenticated;

create or replace function public.orbit_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = orbit_private
as $$ select value from orbit_private.secrets where name = p_name $$;
revoke all on function public.orbit_secret(text) from public, anon, authenticated;
grant execute on function public.orbit_secret(text) to service_role;
