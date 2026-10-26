-- LinkedIn companies found once and kept for every student (orbit-connectors /companies). A company's LinkedIn id and
-- logo are public; finding "Google" costs one student's account one search, and every other student gets it free, so
-- logos fill in for whole networks without spending anyone's daily LinkedIn reads twice. Names LinkedIn cannot pin
-- down (several companies, or none, of that name) are kept too, so nobody searches them again for a month.
-- Logos are copied into the public bucket company-logos: LinkedIn's own links expire after a few weeks.
-- Keys are normalised company names; nothing says which student asked.

create schema if not exists orbit_private;

create table if not exists orbit_private.linkedin_companies (
  key text primary key,
  status text not null check (status in ('found', 'ambiguous', 'not_found')),
  company_id text,
  public_identifier text,
  name text,
  logo_url text,
  checked_at timestamptz not null default now()
);
comment on table orbit_private.linkedin_companies is
  'Orbit: LinkedIn companies by normalised name, shared across students; logos kept in storage bucket company-logos.';
alter table orbit_private.linkedin_companies enable row level security;
revoke all on table orbit_private.linkedin_companies from public, anon, authenticated;

create or replace function public.orbit_linkedin_companies_get(p_keys text[])
returns setof orbit_private.linkedin_companies
language sql
security definer
set search_path = orbit_private
as $$
  select * from orbit_private.linkedin_companies where key = any(p_keys)
$$;

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
    -- a found company keeps its stored logo when a later look could not copy one
    logo_url = coalesce(excluded.logo_url, orbit_private.linkedin_companies.logo_url),
    checked_at = excluded.checked_at
$$;

revoke all on function public.orbit_linkedin_companies_get(text[]) from public, anon, authenticated;
revoke all on function public.orbit_linkedin_companies_put(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.orbit_linkedin_companies_get(text[]) to service_role;
grant execute on function public.orbit_linkedin_companies_put(text, text, text, text, text, text) to service_role;

-- the logos themselves: public to read (they are LinkedIn's public company logos), written only by the function
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-logos', 'company-logos', true, 307200, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true;
