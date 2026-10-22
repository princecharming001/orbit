-- Which LinkedIn account a hosted Unipile sign-in produced. Unipile reports it to orbit-connectors' /connect/notify
-- with the reference Orbit gave the sign-in link; the browser that started that sign-in then reads it back through
-- /connect/status. Service role only: no one else can read or write it.
create table if not exists public.orbit_unipile_links (
  ref text primary key,
  account_id text not null,
  status text not null default 'CREATION_SUCCESS',
  created_at timestamptz not null default now()
);
alter table public.orbit_unipile_links enable row level security;
revoke all on table public.orbit_unipile_links from public, anon, authenticated;
grant select, insert, update, delete on table public.orbit_unipile_links to service_role;
