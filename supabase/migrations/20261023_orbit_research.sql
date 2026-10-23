-- Deep research on a person (supabase/functions/orbit-research, docs/plan/20-deep-research.md). Four small tables, all
-- service role only with RLS on and no policies, so nobody but the function can read or write them:
--
--   orbit_research_uses          the monthly allowance: one row per (LinkedIn account, month, person researched). A
--                                student may research this many different people a month (15 until raised); asking
--                                again about the same person that month (a retry, Go deeper) does not count again.
--   orbit_research_runs          the cost log: one row per call, what it cost, what it skipped and why, any error. No
--                                brief, no LinkedIn data and no history is stored here: only hashes and numbers.
--   orbit_research_cache         public web search results and the public page text they point to, shared by every
--                                student for 7 days. Keyed by the query or the page address; nothing says who asked.
--   orbit_research_suppressions  the removal list: people who asked Orbit never to research them (the public "remove
--                                me" page), as hashes of their name with a LinkedIn address, email or company.
--
-- The account id and the person are stored hashed (sha-256 with the function's salt), never in the clear.

create table if not exists public.orbit_research_uses (
  account text not null,
  month text not null,
  person_key text not null,
  created_at timestamptz not null default now(),
  primary key (account, month, person_key)
);
comment on table public.orbit_research_uses is 'Orbit deep research: people researched per LinkedIn account per month (hashed). Service role only.';
alter table public.orbit_research_uses enable row level security;
revoke all on table public.orbit_research_uses from public, anon, authenticated;
grant select, insert, update, delete on table public.orbit_research_uses to service_role;

create table if not exists public.orbit_research_runs (
  id bigint generated always as identity primary key,
  account text not null,
  person_key text not null,
  kind text not null check (kind in ('quick', 'deeper')),
  status text not null,
  cost_usd numeric(10,5) not null default 0,
  steps jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  error text,
  ms integer,
  created_at timestamptz not null default now()
);
create index if not exists orbit_research_runs_created on public.orbit_research_runs (created_at);
create index if not exists orbit_research_runs_person on public.orbit_research_runs (account, person_key, created_at desc);
comment on table public.orbit_research_runs is 'Orbit deep research: one row per call with its cost and what it skipped. Service role only.';
alter table public.orbit_research_runs enable row level security;
revoke all on table public.orbit_research_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.orbit_research_runs to service_role;

create table if not exists public.orbit_research_cache (
  key text primary key,
  kind text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists orbit_research_cache_expires on public.orbit_research_cache (expires_at);
comment on table public.orbit_research_cache is 'Orbit deep research: public web search results and page text, 7 days, shared. Service role only.';
alter table public.orbit_research_cache enable row level security;
revoke all on table public.orbit_research_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.orbit_research_cache to service_role;

create table if not exists public.orbit_research_suppressions (
  key text primary key,
  source text not null default 'remove_page',
  created_at timestamptz not null default now()
);
comment on table public.orbit_research_suppressions is 'Orbit deep research: people who asked not to be researched (hashed keys). Service role only.';
alter table public.orbit_research_suppressions enable row level security;
revoke all on table public.orbit_research_suppressions from public, anon, authenticated;
grant select, insert, update, delete on table public.orbit_research_suppressions to service_role;

-- Count one person against an account's month, unless that person is already counted. Answers whether the brief may
-- run, how many people the month has used, and whether this person was new.
create or replace function public.orbit_research_use(p_account text, p_month text, p_person text, p_limit integer)
returns table(allowed boolean, used integer, counted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  -- one month at a time per account, so two tabs cannot both take the last brief
  perform pg_advisory_xact_lock(hashtext('orbit_research_use:' || p_account || ':' || p_month));
  if exists (select 1 from public.orbit_research_uses u
              where u.account = p_account and u.month = p_month and u.person_key = p_person) then
    select count(*)::int into n from public.orbit_research_uses u where u.account = p_account and u.month = p_month;
    allowed := true; used := n; counted := false;
    return next;
    return;
  end if;
  select count(*)::int into n from public.orbit_research_uses u where u.account = p_account and u.month = p_month;
  if n >= p_limit then
    allowed := false; used := n; counted := false;
    return next;
    return;
  end if;
  insert into public.orbit_research_uses (account, month, person_key) values (p_account, p_month, p_person);
  allowed := true; used := n + 1; counted := true;
  return next;
end;
$$;

-- Give a person back to the month: the brief could not be written and nothing was spent on it.
create or replace function public.orbit_research_refund(p_account text, p_month text, p_person text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.orbit_research_uses where account = p_account and month = p_month and person_key = p_person;
  select count(*)::int into n from public.orbit_research_uses where account = p_account and month = p_month;
  return n;
end;
$$;

-- How many people an account has researched this month, and what Orbit has spent on research today (all students),
-- for the global daily dollar cap.
create or replace function public.orbit_research_status(p_account text, p_month text)
returns table(used integer, spent_today numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::int from public.orbit_research_uses where account = p_account and month = p_month),
    (select coalesce(sum(cost_usd), 0) from public.orbit_research_runs
      where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
$$;

-- What the last quick brief on this person cost this account in the last 30 days, so Go deeper stays within the
-- $0.50 both calls may cost together; null when there was none.
create or replace function public.orbit_research_last_quick(p_account text, p_person text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select cost_usd from public.orbit_research_runs
   where account = p_account and person_key = p_person and kind = 'quick'
     and status in ('ready', 'partial') and created_at > now() - interval '30 days'
   order by created_at desc limit 1
$$;

-- Old rows go: the cache after it expires, the allowance after two months, the cost log after 90 days.
create or replace function public.orbit_research_cleanup()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.orbit_research_cache where expires_at < now();
  delete from public.orbit_research_uses where created_at < now() - interval '62 days';
  delete from public.orbit_research_runs where created_at < now() - interval '90 days';
$$;

revoke all on function public.orbit_research_use(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.orbit_research_refund(text, text, text) from public, anon, authenticated;
revoke all on function public.orbit_research_status(text, text) from public, anon, authenticated;
revoke all on function public.orbit_research_last_quick(text, text) from public, anon, authenticated;
revoke all on function public.orbit_research_cleanup() from public, anon, authenticated;
grant execute on function public.orbit_research_use(text, text, text, integer) to service_role;
grant execute on function public.orbit_research_refund(text, text, text) to service_role;
grant execute on function public.orbit_research_status(text, text) to service_role;
grant execute on function public.orbit_research_last_quick(text, text) to service_role;
grant execute on function public.orbit_research_cleanup() to service_role;
