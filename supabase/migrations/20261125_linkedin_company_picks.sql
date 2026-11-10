-- Plan 37 logos: the company a name means for one LinkedIn account, settled exactly. A position on the profile of
-- someone in the student's network names its company by LinkedIn's id ("Triumph" for the student whose people work
-- at Triumph Labs), or the student picked the company from LinkedIn's own list. orbit-connectors /companies answers
-- these before the shared list, which only ever holds names LinkedIn's search answers plainly. Service role only.
create table if not exists orbit_private.linkedin_company_picks (
  account_id text not null,
  key text not null,
  company_id text not null,
  public_identifier text,
  name text,
  logo_url text,
  -- 'position': a LinkedIn position named it; 'student': the student picked it
  source text not null default 'position' check (source in ('position', 'student')),
  picked_at timestamptz not null default now(),
  primary key (account_id, key)
);
comment on table orbit_private.linkedin_company_picks is
  'Orbit: the LinkedIn company a name means for one account, from a position or the student''s pick.';
alter table orbit_private.linkedin_company_picks enable row level security;
revoke all on table orbit_private.linkedin_company_picks from public, anon, authenticated;

create or replace function public.orbit_linkedin_company_picks_get(p_account text, p_keys text[])
returns setof orbit_private.linkedin_company_picks
language sql
stable
security definer
set search_path = orbit_private
as $$
  select * from orbit_private.linkedin_company_picks where account_id = p_account and key = any(p_keys)
$$;

-- a student's own pick is never replaced by a position read later
create or replace function public.orbit_linkedin_company_picks_put(
  p_account text,
  p_key text,
  p_company_id text,
  p_public_identifier text,
  p_name text,
  p_logo_url text,
  p_source text
)
returns void
language sql
security definer
set search_path = orbit_private
as $$
  insert into orbit_private.linkedin_company_picks
    (account_id, key, company_id, public_identifier, name, logo_url, source, picked_at)
  values (p_account, p_key, p_company_id, p_public_identifier, p_name, p_logo_url, p_source, now())
  on conflict (account_id, key) do update set
    company_id = excluded.company_id,
    public_identifier = excluded.public_identifier,
    name = excluded.name,
    logo_url = case when excluded.company_id = orbit_private.linkedin_company_picks.company_id
                    then coalesce(excluded.logo_url, orbit_private.linkedin_company_picks.logo_url)
                    else excluded.logo_url end,
    source = excluded.source,
    picked_at = excluded.picked_at
  where orbit_private.linkedin_company_picks.source = 'position' or excluded.source = 'student'
$$;

revoke all on function public.orbit_linkedin_company_picks_get(text, text[]) from public, anon, authenticated;
revoke all on function public.orbit_linkedin_company_picks_put(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.orbit_linkedin_company_picks_get(text, text[]) to service_role;
grant execute on function public.orbit_linkedin_company_picks_put(text, text, text, text, text, text, text)
  to service_role;

-- which lookup rules made a row: 1 before 2026-11-10 (follower counts and the page at a company's own name could
-- decide), 2 since (linkedinCompanies chooseCompany). Rows of rule 1 are answered with until logos.user checks them.
alter table orbit_private.linkedin_companies add column if not exists rules smallint not null default 1;

create or replace function public.orbit_linkedin_companies_put2(
  p_key text,
  p_status text,
  p_company_id text,
  p_public_identifier text,
  p_name text,
  p_logo_url text,
  p_rules smallint
)
returns void
language sql
security definer
set search_path = orbit_private
as $$
  insert into orbit_private.linkedin_companies
    (key, status, company_id, public_identifier, name, logo_url, checked_at, rules)
  values (p_key, p_status, p_company_id, p_public_identifier, p_name, p_logo_url, now(), p_rules)
  on conflict (key) do update set
    status = excluded.status,
    company_id = excluded.company_id,
    public_identifier = excluded.public_identifier,
    name = excluded.name,
    logo_url = case when excluded.status = 'found'
                         and excluded.company_id = orbit_private.linkedin_companies.company_id
                    then coalesce(excluded.logo_url, orbit_private.linkedin_companies.logo_url)
                    else excluded.logo_url end,
    checked_at = excluded.checked_at,
    rules = excluded.rules
$$;
revoke all on function public.orbit_linkedin_companies_put2(text, text, text, text, text, text, smallint)
  from public, anon, authenticated;
grant execute on function public.orbit_linkedin_companies_put2(text, text, text, text, text, text, smallint)
  to service_role;

-- the shared list keeps a stored logo only for the same company still found: a name found to be ambiguous later, or
-- found as another company, no longer answers with the old company's logo
create or replace function public.orbit_linkedin_companies_put(
  p_key text,
  p_status text,
  p_company_id text,
  p_public_identifier text,
  p_name text,
  p_logo_url text
)
returns void
language sql
security definer
set search_path = orbit_private
as $$
  insert into orbit_private.linkedin_companies (key, status, company_id, public_identifier, name, logo_url, checked_at)
  values (p_key, p_status, p_company_id, p_public_identifier, p_name, p_logo_url, now())
  on conflict (key) do update set
    status = excluded.status,
    company_id = excluded.company_id,
    public_identifier = excluded.public_identifier,
    name = excluded.name,
    logo_url = case when excluded.status = 'found'
                         and excluded.company_id = orbit_private.linkedin_companies.company_id
                    then coalesce(excluded.logo_url, orbit_private.linkedin_companies.logo_url)
                    else excluded.logo_url end,
    checked_at = excluded.checked_at
$$;
