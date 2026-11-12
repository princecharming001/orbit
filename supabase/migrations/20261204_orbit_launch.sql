-- Plan 43: the owner's launch switches for the optional sources (Instagram, X, Texts), flipped without a redeploy.
-- What is offered to students is ORBIT_EXTRA_SOURCES (read once at cold start) together with every row here that is
-- offered, read by the edge functions through public.orbit_sources_offered() and kept about a minute per database
-- handle (_shared/sources/states.ts `offeredNow`). No row, or a row that is not offered, changes nothing: the shipped
-- default is every optional source off for students. Rows are written by the owner's PUT /admin/sources/:source
-- through public.orbit_source_launch_set(); only the service role may call either function.
create schema if not exists orbit_private;
create table if not exists orbit_private.source_launch (
  source text primary key check (source in ('instagram', 'x', 'imessage')),
  offered boolean not null default false,
  changed_by uuid,
  changed_at timestamptz
);
alter table orbit_private.source_launch enable row level security;
revoke all on orbit_private.source_launch from public, anon, authenticated;

-- every optional source the owner has launched, in one round trip
create or replace function public.orbit_sources_offered()
returns text[]
language sql
stable
security definer
set search_path = orbit_private
as $$ select coalesce(array_agg(source order by source), '{}') from orbit_private.source_launch where offered $$;
revoke all on function public.orbit_sources_offered() from public, anon, authenticated;
grant execute on function public.orbit_sources_offered() to service_role;

-- one launch switch set by the owner; returns whether it was offered before
create or replace function public.orbit_source_launch_set(p_source text, p_offered boolean, p_by uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = orbit_private
as $$
declare
  was boolean;
begin
  select offered into was from orbit_private.source_launch where source = p_source for update;
  insert into orbit_private.source_launch (source, offered, changed_by, changed_at)
  values (p_source, p_offered, p_by, now())
  on conflict (source) do update set
    offered = excluded.offered, changed_by = excluded.changed_by, changed_at = excluded.changed_at;
  return coalesce(was, false);
end
$$;
revoke all on function public.orbit_source_launch_set(text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.orbit_source_launch_set(text, boolean, uuid) to service_role;
