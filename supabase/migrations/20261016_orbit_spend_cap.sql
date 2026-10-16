-- What each user has spent on Orbit's Claude key, so no one passes the per-user cap (ORBIT_USER_CAP_USD, $20 until
-- raised). orbit-claude (the chat) adds to orbit_proxy_spend after every answer; the server tasks write
-- orbit.usage_ledger. A signed-in user's total counts both. Service role only, like the request counters.
--
-- subject: 'user:<uuid>' for a signed-in user, 'client:<id>' for a browser without an account, 'ip:<hash>' when the
-- browser sent no id.

create table if not exists public.orbit_proxy_spend (
  subject text primary key,
  usd numeric(12,5) not null default 0,
  requests integer not null default 0,
  first_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.orbit_proxy_spend is 'Orbit Claude proxy: dollars spent per user, browser or visitor. Service role only.';
alter table public.orbit_proxy_spend enable row level security;
revoke all on public.orbit_proxy_spend from anon, authenticated;

-- Everything a subject has spent: the chat's spend, plus the server tasks' spend for a signed-in user.
create or replace function public.orbit_spend_total(p_subject text)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  total numeric := coalesce((select usd from public.orbit_proxy_spend where subject = p_subject), 0);
  uid uuid;
begin
  if p_subject ~ '^user:[0-9a-fA-F-]{36}$' and to_regclass('orbit.usage_ledger') is not null then
    uid := substr(p_subject, 6)::uuid;
    total := total + coalesce((select sum(cost_usd) from orbit.usage_ledger where user_id = uid), 0);
  end if;
  return total;
end;
$$;

-- Adds one answer's cost and returns the new total for the subject's chat spend.
create or replace function public.orbit_spend_add(p_subject text, p_usd numeric)
returns numeric
language sql
security definer
set search_path = public
as $$
  insert into public.orbit_proxy_spend as s (subject, usd, requests)
    values (p_subject, greatest(p_usd, 0), 1)
    on conflict (subject) do update
      set usd = s.usd + greatest(p_usd, 0), requests = s.requests + 1, updated_at = now()
  returning usd
$$;

revoke all on function public.orbit_spend_total(text) from public, anon, authenticated;
revoke all on function public.orbit_spend_add(text, numeric) from public, anon, authenticated;
grant execute on function public.orbit_spend_total(text) to service_role;
grant execute on function public.orbit_spend_add(text, numeric) to service_role;
