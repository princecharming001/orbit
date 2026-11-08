-- Profile reading (docs/plan/33-profile-reading.md): LinkedIn About sections, job histories and company pages, read
-- slowly in the background and on demand, and what Claude understood from them, each fact with the words it rests on.
--
--   orbit.profile_reads           one row per person read: their About, their jobs (title, company, LinkedIn company
--                                 id, dates, what they wrote under it) and the reading (stated stage, team size, what
--                                 they work on, signals such as hiring or angel investing). Per student; server-written.
--   orbit_private.company_pages   a company's LinkedIn page (About, tagline, headcount, growth, founding year,
--                                 industry), shared by every student like company_facts; names no student.
--   company_facts                 gains the page's founding year, growth, a stated stage and a short About; a page
--                                 is also projected into it as a 'linkedin' row, so the browser's facts include it.
--   facet_assertions.ref          the LinkedIn company id behind a company assertion (from the census), so the
--                                 company's page can be read without a search.
-- Additive only.

alter table orbit.facet_assertions add column if not exists ref text;

alter table orbit_private.company_facts
  add column if not exists linkedin_id text,
  add column if not exists founded_year int,
  add column if not exists growth_12m int,
  add column if not exists stage text,
  add column if not exists stage_evidence text,
  add column if not exists kind text,
  add column if not exists about text;

create table if not exists orbit_private.company_pages (
  linkedin_id text primary key,
  public_identifier text,
  name text not null,
  website text,
  industries text[] not null default '{}',
  tagline text,
  description text,
  employee_count int,
  employee_range text,
  growth_6m int,
  growth_12m int,
  growth_24m int,
  founded_year int,
  hq text,
  status text not null default 'ok' check (status in ('ok', 'not_found', 'refused')),
  read_at timestamptz not null default now(),
  reading jsonb,                          -- {stage, stageEvidence, kind, what} after the quote rule
  reading_at timestamptz
);
create index if not exists company_pages_unread_idx on orbit_private.company_pages (read_at) where reading_at is null;
comment on table orbit_private.company_pages is
  'Orbit: LinkedIn company pages (About, headcount, growth, founding year) read for network search; shared, names no student.';
alter table orbit_private.company_pages enable row level security;
revoke all on table orbit_private.company_pages from public, anon, authenticated;

create table if not exists orbit.profile_reads (
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  member_id text,
  about text,
  experience jsonb not null default '[]'::jsonb,
  status text not null default 'ok' check (status in ('ok', 'not_found', 'refused')),
  read_by text not null default 'background' check (read_by in ('background', 'ask')),
  read_at timestamptz not null default now(),
  reading jsonb,
  reading_model text,
  reading_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, person_id)
);
create index if not exists profile_reads_user_updated_idx on orbit.profile_reads (user_id, updated_at);
create index if not exists profile_reads_unread_idx on orbit.profile_reads (user_id) where reading_at is null;
alter table orbit.profile_reads enable row level security;
revoke all on table orbit.profile_reads from public, anon, authenticated;
grant all on table orbit.profile_reads to service_role;

-- every two hours per student with LinkedIn: one step of reading (company pages, a few profiles, the reading itself)
create or replace function orbit.enqueue_search_reading()
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
     where a.provider = 'linkedin' and a.status = 'active'
  loop
    if orbit.enqueue('orbit_enrich', jsonb_build_object(
      'kind', 'search_reading', 'userId', r.id, 'payload', '{}'::jsonb,
      'dedupeKey', 'cron:search_reading:' || r.id || ':' || slot)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_search_reading() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-search-reading') then
    perform cron.unschedule('orbit-search-reading');
  end if;
  perform cron.schedule('orbit-search-reading', '41 */2 * * *', $cron$select orbit.enqueue_search_reading()$cron$);
end
$$;
