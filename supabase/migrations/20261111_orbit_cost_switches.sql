-- Plan 34 A5: one switch per paid provider, flipped with an update and read by the edge functions within 5 minutes
-- (no deploy). A provider with no row, or a row that is enabled, is on. Read only through the two functions below,
-- which only the service role may call.
create schema if not exists orbit_private;
create table if not exists orbit_private.provider_switches (
  provider text primary key,
  enabled boolean not null default true,
  note text,
  updated_at timestamptz not null default now()
);
alter table orbit_private.provider_switches enable row level security;
revoke all on orbit_private.provider_switches from public, anon, authenticated;

insert into orbit_private.provider_switches (provider) values
  ('anthropic'), ('hunter'), ('apollo'), ('exa'), ('unipile_reads'), ('village'), ('web_search')
on conflict (provider) do nothing;

-- whether one provider is on (true when it has no row)
create or replace function public.orbit_provider_enabled(p text)
returns boolean
language sql
stable
security definer
set search_path = orbit_private
as $$ select coalesce((select enabled from orbit_private.provider_switches where provider = p), true) $$;
revoke all on function public.orbit_provider_enabled(text) from public, anon, authenticated;
grant execute on function public.orbit_provider_enabled(text) to service_role;

-- every provider that is switched off, in one round trip
create or replace function public.orbit_providers_off()
returns text[]
language sql
stable
security definer
set search_path = orbit_private
as $$ select coalesce(array_agg(provider order by provider), '{}') from orbit_private.provider_switches where not enabled $$;
revoke all on function public.orbit_providers_off() from public, anon, authenticated;
grant execute on function public.orbit_providers_off() to service_role;
