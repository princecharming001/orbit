-- Plan 44: Roles for you. Open roles from public job boards, Workday career sites, the SimplifyJobs lists, the
-- student's own LinkedIn job search and pasted postings, read into one shared table; each student's profile, the roles
-- that fit it with a score out of 10 and its reasons, and the companies they watch. Additive only.
--
-- Shared, in orbit_private (public job data, no student's information, service role only):
--   feature_launch      the owner's launch switch for a feature ('roles'), beside the source switches
--   job_boards          one company's board on one service, how it was found, when it is next read
--   job_board_lookups   one company looked for, found or not, so it is not looked for again for 30 days
--   jobs                one open (or closed) role, from any source; text and requirements filled when first needed
--   roles_usage         a day's count of shared work (requirement reads, discovery requests), so overall limits hold
-- Per student, in orbit (cleared and exported with the account, like every table with user_id):
--   role_profiles       the profile the student confirmed, and the one Orbit proposed
--   role_searches       one search: the profile it was for, how many roles are listed and read
--   role_matches        a role for a student: rank, score, parts, quotes, caps, status (saved, dismissed, applied)
--   role_watches        companies the student watches for a fitting role
--   role_source_reads   the student's LinkedIn job searches, kept a day so one search is never run twice

create schema if not exists orbit_private;

-- ---- the feature switch ------------------------------------------------------------------------------------------

create table if not exists orbit_private.feature_launch (
  feature text primary key check (feature ~ '^[a-z][a-z_]{1,40}$'),
  offered boolean not null default false,
  changed_by uuid,
  changed_at timestamptz
);
alter table orbit_private.feature_launch enable row level security;
revoke all on orbit_private.feature_launch from public, anon, authenticated;

create or replace function public.orbit_features_offered()
returns text[]
language sql
stable
security definer
set search_path = orbit_private
as $$ select coalesce(array_agg(feature order by feature), '{}') from orbit_private.feature_launch where offered $$;
revoke all on function public.orbit_features_offered() from public, anon, authenticated;
grant execute on function public.orbit_features_offered() to service_role;

create or replace function public.orbit_feature_launch_set(p_feature text, p_offered boolean, p_by uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = orbit_private
as $$
declare
  was boolean;
begin
  select offered into was from orbit_private.feature_launch where feature = p_feature for update;
  insert into orbit_private.feature_launch (feature, offered, changed_by, changed_at)
  values (p_feature, p_offered, p_by, now())
  on conflict (feature) do update set
    offered = excluded.offered, changed_by = excluded.changed_by, changed_at = excluded.changed_at;
  return coalesce(was, false);
end
$$;
revoke all on function public.orbit_feature_launch_set(text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.orbit_feature_launch_set(text, boolean, uuid) to service_role;

-- ---- boards ------------------------------------------------------------------------------------------------------

create table if not exists orbit_private.job_boards (
  id uuid primary key default gen_random_uuid(),
  service text not null check (service in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'recruitee')),
  -- the board's name on its service; for Workday 'host/tenant/site' (nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite)
  token text not null,
  company_key text,
  company_name text,
  company_domain text,
  found_via text not null check (found_via in ('careers_page', 'simplify', 'posting', 'name', 'seed', 'owner')),
  found_url text,
  status text not null default 'active' check (status in ('active', 'empty', 'gone', 'refused')),
  roles_open int not null default 0,
  last_size_bytes int,
  failures int not null default 0,
  last_error text,
  last_read_at timestamptz,
  next_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (service, token)
);
create index if not exists job_boards_due_idx on orbit_private.job_boards (next_read_at) where status in ('active', 'empty');
create index if not exists job_boards_company_idx on orbit_private.job_boards (company_key);

create table if not exists orbit_private.job_board_lookups (
  company_key text primary key,
  company_name text not null,
  domain text,
  outcome text not null check (outcome in ('found', 'none', 'failed')),
  board_id uuid references orbit_private.job_boards(id) on delete set null,
  checked_at timestamptz not null default now()
);
create index if not exists job_board_lookups_checked_idx on orbit_private.job_board_lookups (checked_at);

-- ---- roles -------------------------------------------------------------------------------------------------------

create table if not exists orbit_private.jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in (
    'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'recruitee', 'simplify', 'linkedin', 'posting'
  )),
  external_id text not null,
  board_id uuid references orbit_private.job_boards(id) on delete set null,
  company_key text not null,
  company_name text not null,
  company_domain text,
  company_linkedin_id text,
  company_logo_url text,
  title text not null,
  title_key text not null,
  team text,
  family text,
  -- null: the posting does not say
  level text check (level in ('intern', 'entry', 'mid', 'senior', 'lead', 'exec')),
  employment text check (employment in ('full_time', 'part_time', 'contract', 'internship', 'temporary')),
  places text[] not null default '{}',
  countries text[] not null default '{}',
  remote text check (remote in ('remote', 'hybrid', 'on_site')),
  term text,
  pay jsonb,
  sponsorship text check (sponsorship in ('offers', 'none')),
  degrees text[] not null default '{}',
  language text,
  url text not null,
  apply_url text,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,
  -- the posting's text, cleaned and capped; read when the role is first needed, kept by its hash
  text text,
  text_hash text,
  text_read_at timestamptz,
  -- the requirements read from the text by the model (plan 44 §6.2), for the text_hash they were read from
  requirements jsonb,
  requirements_hash text,
  -- the same role listed again (another city, a repost, another source): the one it repeats
  dupe_of uuid references orbit_private.jobs(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  unique (source, external_id)
);
create index if not exists jobs_open_idx on orbit_private.jobs (family, level) where closed_at is null and dupe_of is null;
create index if not exists jobs_company_idx on orbit_private.jobs (company_key) where closed_at is null;
create index if not exists jobs_title_idx on orbit_private.jobs (title_key) where closed_at is null;
create index if not exists jobs_board_idx on orbit_private.jobs (board_id) where closed_at is null;
create index if not exists jobs_closed_idx on orbit_private.jobs (closed_at) where closed_at is not null;

create table if not exists orbit_private.roles_usage (
  day date not null,
  kind text not null,
  n int not null default 0,
  primary key (day, kind)
);

-- take one unit of a shared daily allowance; false when the day's limit is reached
create or replace function public.orbit_roles_take(p_kind text, p_limit int, p_n int default 1)
returns boolean
language plpgsql
volatile
security definer
set search_path = orbit_private
as $$
declare
  got int;
begin
  insert into orbit_private.roles_usage (day, kind, n)
  values ((now() at time zone 'utc')::date, p_kind, p_n)
  on conflict (day, kind) do update set n = orbit_private.roles_usage.n + excluded.n
    where orbit_private.roles_usage.n + excluded.n <= p_limit
  returning n into got;
  return got is not null and got <= p_limit;
end
$$;
revoke all on function public.orbit_roles_take(text, int, int) from public, anon, authenticated;
grant execute on function public.orbit_roles_take(text, int, int) to service_role;

do $$
begin
  execute 'alter table orbit_private.job_boards enable row level security';
  execute 'alter table orbit_private.job_board_lookups enable row level security';
  execute 'alter table orbit_private.jobs enable row level security';
  execute 'alter table orbit_private.roles_usage enable row level security';
  execute 'revoke all on orbit_private.job_boards, orbit_private.job_board_lookups, orbit_private.jobs, orbit_private.roles_usage from public, anon, authenticated';
end
$$;

-- ---- per student -------------------------------------------------------------------------------------------------

create table if not exists orbit.role_profiles (
  user_id uuid primary key references orbit.users(id) on delete cascade,
  -- the RoleProfile the student confirmed (packages/core/src/roles/types.ts)
  profile jsonb not null,
  -- what Orbit read from the lines, before the student changed anything
  proposed jsonb,
  evidence_hash text not null,
  wants_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orbit.role_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  evidence_hash text not null,
  wants_hash text not null,
  status text not null default 'reading' check (status in ('reading', 'done', 'failed', 'dropped')),
  listed int not null default 0,
  read int not null default 0,
  -- what was searched, for the line above the table ("Roles from 1,240 boards and your LinkedIn search")
  sources jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists role_searches_user_idx on orbit.role_searches (user_id, created_at desc);

create table if not exists orbit.role_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  job_id uuid not null references orbit_private.jobs(id) on delete cascade,
  search_id uuid references orbit.role_searches(id) on delete set null,
  -- the profile evidence the score was read against; a new one sends the row back to to_read, keeping its status
  evidence_hash text not null,
  state text not null default 'to_read' check (state in ('to_read', 'read', 'failed', 'gone')),
  -- the free ranking (plan 44 §5 step 2), higher first
  rank real not null default 0,
  fit smallint check (fit between 1 and 10),
  parts jsonb,
  answers jsonb,
  caps jsonb,
  reason text,
  gaps jsonb,
  status text not null default 'new' check (status in ('new', 'saved', 'dismissed', 'applied', 'interviewing')),
  dismiss_reason text check (dismiss_reason in ('kind', 'level', 'place', 'company', 'other')),
  seen_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_id)
);
create index if not exists role_matches_list_idx on orbit.role_matches (user_id, status, fit desc nulls last);
create index if not exists role_matches_read_idx on orbit.role_matches (search_id, state, rank desc);
create index if not exists role_matches_job_idx on orbit.role_matches (job_id);

create table if not exists orbit.role_watches (
  user_id uuid not null references orbit.users(id) on delete cascade,
  company_key text not null,
  company_name text not null,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, company_key)
);

create table if not exists orbit.role_source_reads (
  user_id uuid not null references orbit.users(id) on delete cascade,
  source text not null check (source in ('linkedin')),
  query_key text not null,
  results int not null default 0,
  read_at timestamptz not null default now(),
  primary key (user_id, source, query_key)
);

do $$
declare
  t text;
begin
  foreach t in array array['role_profiles', 'role_searches', 'role_matches'] loop
    execute format('drop trigger if exists touch_updated_at on orbit.%I', t);
    execute format(
      'create trigger touch_updated_at before update on orbit.%I for each row execute function orbit.touch_updated_at()',
      t
    );
    execute format('create index if not exists %I on orbit.%I (user_id, updated_at)', t || '_sync_idx', t);
  end loop;
  foreach t in array array['role_profiles', 'role_searches', 'role_matches', 'role_watches', 'role_source_reads'] loop
    execute format('alter table orbit.%I enable row level security', t);
    execute format('revoke all on orbit.%I from public, anon, authenticated', t);
  end loop;
end
$$;

-- ---- the background work: one tick every ten minutes -------------------------------------------------------------
-- orbit-worker roles.tick reads the boards that are due, looks for new boards, reads the SimplifyJobs lists once a
-- day and tops up active students' matches once a night, each within its own share of the run (plan 44 §4.6).

create or replace function orbit.enqueue_roles_tick()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select orbit.enqueue('orbit_score', jsonb_build_object(
    'kind', 'roles.tick', 'payload', '{}'::jsonb,
    'dedupeKey', 'roles.tick:' || to_char(date_trunc('minute', now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI')))
$$;
revoke all on function orbit.enqueue_roles_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-roles') then
    perform cron.unschedule('orbit-roles');
  end if;
  perform cron.schedule('orbit-roles', '*/10 * * * *', $cron$select orbit.enqueue_roles_tick()$cron$);
end
$$;
