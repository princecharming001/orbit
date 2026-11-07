-- Network search (docs/plan/32-network-search.md §4, §6, §18): the facts a search checks that no headline carries,
-- and what LinkedIn has said about who is where.
--
--   orbit_private.company_facts   companies with public facts (YC batch, status, stage, team size, industries), shared
--                                 by every student; refreshed nightly from yc-oss (company_facts_sync). Nothing in it
--                                 names a student.
--   orbit.facet_assertions        "LinkedIn listed this person under this place / school / company" (positive), or a
--                                 finished partition that did not list them (negative). Written by the census and by
--                                 the facet lookups a search makes; read by the browser through orbit-api.
--   orbit.search_census           one row per student: where the background sweep of their LinkedIn connections is.
--   orbit.facet_scans             an ask-time LinkedIn lookup with one filter, and whether it listed every match
--   orbit.search_labels           a student's "yes, a match" / "not a match" on a search row, kept so the judge and
--                                 later searches learn from it.
-- Additive only: no existing table or function changes shape except orbit.delete_user's coverage (it already deletes
-- every orbit table with a user_id column, which all three new user tables have).

create schema if not exists orbit_private;

-- ---- company facts --------------------------------------------------------------------------------------------------

create table if not exists orbit_private.company_facts (
  source text not null check (source in ('yc', 'bigpicture', 'curated', 'linkedin')),
  source_id text not null,
  key text not null,                      -- core orgKey(name)
  name text not null,
  former_names text[] not null default '{}',
  website text,
  linkedin_handle text,
  yc_batch text,                          -- canonical: W26, S25, F24, X25
  yc_status text check (yc_status in ('Active', 'Inactive', 'Acquired', 'Public')),
  yc_stage text check (yc_stage in ('Early', 'Growth')),
  team_size int,
  industries text[] not null default '{}',
  one_liner text,
  ambiguous_name boolean not null default false,
  as_of date,
  updated_at timestamptz not null default now(),
  primary key (source, source_id)
);
create index if not exists company_facts_key_idx on orbit_private.company_facts (key);
create index if not exists company_facts_updated_idx on orbit_private.company_facts (updated_at);
comment on table orbit_private.company_facts is
  'Orbit: public company facts (YC batch, status, stage, size, industries) by normalised name; shared, names no student.';
alter table orbit_private.company_facts enable row level security;
revoke all on table orbit_private.company_facts from public, anon, authenticated;

-- ---- facet assertions -------------------------------------------------------------------------------------------------

create table if not exists orbit.facet_assertions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  kind text not null check (kind in ('place', 'school', 'company', 'past_company')),
  value text not null,                    -- what LinkedIn said or was asked: a location line, a school or company name
  positive boolean not null,
  source text not null check (source in ('census', 'facet_search', 'profile', 'user')),
  at timestamptz not null default now(),
  unique (user_id, person_id, kind, value, source)
);
create index if not exists facet_assertions_user_at_idx on orbit.facet_assertions (user_id, at);
create index if not exists facet_assertions_person_idx on orbit.facet_assertions (person_id);

-- ---- census progress ----------------------------------------------------------------------------------------------------

create table if not exists orbit.search_census (
  user_id uuid primary key references orbit.users(id) on delete cascade,
  cursor text,                            -- Unipile's cursor into the sweep of 1st-degree connections
  seen int not null default 0,            -- connections read in this pass
  matched int not null default 0,         -- of those, people Orbit already had
  pass_started_at timestamptz,
  pass_done_at timestamptz,               -- the last full pass; a new one starts 30 days later
  last_error text,
  updated_at timestamptz not null default now()
);

-- ---- labels ------------------------------------------------------------------------------------------------------------

create table if not exists orbit.search_labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  ask_hash text not null,                 -- core hashString of the normalised spec
  ask text not null,                      -- the ask in the student's words, for review
  verdict text not null check (verdict in ('yes', 'no')),
  created_at timestamptz not null default now(),
  unique (user_id, person_id, ask_hash)
);
create index if not exists search_labels_user_idx on orbit.search_labels (user_id, created_at);

-- One ask-time LinkedIn lookup of the student's connections with one filter (a company, school or place). complete =
-- LinkedIn listed every match within the pages read, so a connection it did not list does not have that facet.
create table if not exists orbit.facet_scans (
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null check (kind in ('place', 'school', 'company')),
  value text not null,
  complete boolean not null default false,
  matched int not null default 0,
  at timestamptz not null default now(),
  primary key (user_id, kind, value)
);

do $$
declare
  t text;
begin
  foreach t in array array['facet_assertions', 'search_census', 'search_labels', 'facet_scans'] loop
    execute format('alter table orbit.%I enable row level security', t);
    execute format('revoke all on table orbit.%I from public, anon, authenticated', t);
    execute format('grant all on table orbit.%I to service_role', t);
  end loop;
end
$$;

-- ---- schedules ------------------------------------------------------------------------------------------------------------

-- nightly: refresh company facts (one job for everyone; userId null)
create or replace function orbit.enqueue_company_facts_sync()
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  if orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'company_facts_sync', 'userId', null, 'payload', '{}'::jsonb,
    'dedupeKey', 'nightly:company_facts_sync:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'))) is not null then
    return 1;
  end if;
  return 0;
end
$$;

-- every three hours: one census step for each student with a live LinkedIn account whose pass is unfinished or
-- older than 30 days. A step spends only what the census may take of the day's LinkedIn searches.
create or replace function orbit.enqueue_search_census()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  slot text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
begin
  for r in
    select distinct a.user_id as id
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id and u.deleted_at is null
      left join orbit.search_census c on c.user_id = a.user_id
     where a.provider = 'linkedin' and a.status = 'active'
       and (c.pass_done_at is null or c.pass_done_at < now() - interval '30 days')
  loop
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'search_census', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cron:search_census:' || r.id || ':' || slot)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

revoke all on function orbit.enqueue_company_facts_sync(), orbit.enqueue_search_census() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-company-facts-nightly') then
    perform cron.unschedule('orbit-company-facts-nightly');
  end if;
  perform cron.schedule('orbit-company-facts-nightly', '29 7 * * *', $cron$select orbit.enqueue_company_facts_sync()$cron$);
  if exists (select 1 from cron.job where jobname = 'orbit-search-census') then
    perform cron.unschedule('orbit-search-census');
  end if;
  perform cron.schedule('orbit-search-census', '11 */3 * * *', $cron$select orbit.enqueue_search_census()$cron$);
end
$$;
