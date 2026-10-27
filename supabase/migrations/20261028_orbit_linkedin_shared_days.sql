-- Shared LinkedIn reads can be kept longer than a day (orbit-connectors): a profile's public part (work history,
-- schools, photo) for a month, since it changes far more slowly than public activity, which stays a day. One
-- student's read then serves every other student who looks that person up within the month.

drop function if exists public.orbit_linkedin_shared_put(text, jsonb);

create or replace function public.orbit_linkedin_shared_put(p_key text, p_value jsonb, p_days integer default 1)
returns void
language plpgsql
security definer
set search_path = orbit_private
as $$
begin
  delete from orbit_private.linkedin_shared where expires_at <= now();
  insert into orbit_private.linkedin_shared (key, value, created_at, expires_at)
  values (p_key, p_value, now(), now() + make_interval(days => greatest(1, least(coalesce(p_days, 1), 45))))
  on conflict (key) do update
    set value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.orbit_linkedin_shared_put(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.orbit_linkedin_shared_put(text, jsonb, integer) to service_role;
