-- Plan 34 C1: one row per answer the Claude proxy (orbit-claude) forwards, with the token shape behind its price, so
-- the cache hit rate, model requests a turn and web searches a turn can be measured. Written by the proxy through
-- orbit_claude_usage_add (service role only); purged after 90 days by orbit.retention_purge.
-- Plan 34 A3: the proxy reads the session signing key from Vault the way orbit-api does, through
-- orbit_session_secret (service role only), so a signed-in request is charged to the user, not the browser.
create schema if not exists orbit_private;
revoke all on schema orbit_private from public, anon, authenticated;

create table if not exists orbit_private.claude_usage (
  id bigserial primary key,
  at timestamptz not null default now(),
  subject text not null,
  call text not null default 'chat',
  model text,
  input integer not null default 0,
  cache_read integer not null default 0,
  cache_write integer not null default 0,
  output integer not null default 0,
  web_searches integer not null default 0,
  iterations integer,
  usd numeric(10, 5) not null default 0
);
create index if not exists claude_usage_at_idx on orbit_private.claude_usage (at desc);
create index if not exists claude_usage_subject_at_idx on orbit_private.claude_usage (subject, at desc);
revoke all on orbit_private.claude_usage from public, anon, authenticated;
grant usage on schema orbit_private to service_role;
grant all on orbit_private.claude_usage to service_role;
grant usage, select on sequence orbit_private.claude_usage_id_seq to service_role;
comment on table orbit_private.claude_usage is 'Orbit Claude proxy: tokens, searches and price per answer. Service role only.';

create or replace function public.orbit_claude_usage_add(
  p_subject text,
  p_call text,
  p_model text,
  p_input integer,
  p_cache_read integer,
  p_cache_write integer,
  p_output integer,
  p_web_searches integer,
  p_iterations integer,
  p_usd numeric
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into orbit_private.claude_usage
    (subject, call, model, input, cache_read, cache_write, output, web_searches, iterations, usd)
  values (
    left(coalesce(p_subject, ''), 120), left(coalesce(p_call, 'chat'), 20), left(p_model, 60),
    greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_cache_read, 0), 0),
    greatest(coalesce(p_cache_write, 0), 0), greatest(coalesce(p_output, 0), 0),
    greatest(coalesce(p_web_searches, 0), 0), p_iterations, greatest(coalesce(p_usd, 0), 0)
  )
$$;
revoke all on function public.orbit_claude_usage_add(text, text, text, integer, integer, integer, integer, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.orbit_claude_usage_add(text, text, text, integer, integer, integer, integer, integer, integer, numeric)
  to service_role;

create or replace function public.orbit_session_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select orbit.secret('orbit_session_secret') $$;
revoke all on function public.orbit_session_secret() from public, anon, authenticated;
grant execute on function public.orbit_session_secret() to service_role;

-- Plan 34 E1: the connectors' browser routes that pay a provider (Exa from /web, Village from /paths) write
-- orbit.usage_ledger rows through this function: no user, the visitor hash as the account.
create or replace function public.orbit_usage_add(
  p_provider text,
  p_operation text,
  p_units numeric,
  p_cost_usd numeric,
  p_account_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider not in ('exa', 'village') then
    raise exception 'orbit_usage_add: provider % is not recorded here', p_provider;
  end if;
  insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, account_id)
  values (null, p_provider, left(coalesce(p_operation, 'call'), 60), greatest(coalesce(p_units, 0), 0),
          greatest(coalesce(p_cost_usd, 0), 0), left(p_account_id, 64));
end;
$$;
revoke all on function public.orbit_usage_add(text, text, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.orbit_usage_add(text, text, numeric, numeric, text) to service_role;
