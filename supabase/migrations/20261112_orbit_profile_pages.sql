-- Plan 34 B1: a LinkedIn profile's public text (About, jobs and what they wrote under them) read once for every
-- student who has that person, keyed by LinkedIn member id, like orbit_private.company_pages. Holds only what
-- LinkedIn shows any viewer of the profile; nothing from a student's messages, notes or reading choices. The reading
-- (what Claude took from that text) rides along so a second student with the same person needs no model call either.
-- Additive only.
create schema if not exists orbit_private;
create table if not exists orbit_private.profile_pages (
  member_id text primary key,
  about text,
  experience jsonb not null default '[]'::jsonb,
  status text not null default 'ok',
  read_at timestamptz not null default now(),
  reading jsonb,
  reading_model text,
  reading_at timestamptz
);
alter table orbit_private.profile_pages enable row level security;
revoke all on orbit_private.profile_pages from public, anon, authenticated;
grant all on orbit_private.profile_pages to service_role;
