-- Files on drafts: a student attaches a resume or any file to an email Orbit sends for them.
--
-- orbit.user_files keeps each file's bytes (at most 4 MB each), owned by the student and deleted with them. It is
-- read only by the service role (the API stores a file when a draft is approved with it, the worker reads it when it
-- builds the message); it never syncs to the browser, which keeps its own copy.
-- orbit.drafts.attachments lists a draft's files as [{id, name, mimeType, size}], ids in orbit.user_files.
--
-- Additive only: a new table and a new column with a default.

create table if not exists orbit.user_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null default 'file' check (kind in ('resume', 'file')),
  name text not null check (length(name) between 1 and 200),
  mime_type text not null,
  size int not null check (size > 0 and size <= 4194304),
  bytes bytea not null,
  created_at timestamptz not null default now()
);

create index if not exists user_files_user_idx on orbit.user_files (user_id, created_at desc);

alter table orbit.user_files enable row level security;
revoke all on orbit.user_files from anon, authenticated;

alter table orbit.drafts add column if not exists attachments jsonb not null default '[]'::jsonb;
