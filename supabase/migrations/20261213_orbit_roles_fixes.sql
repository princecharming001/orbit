-- Plan 44, Roles for you: what joining the three parts (job sources; search and score; the browser) showed was
-- missing. Additive only.
--
-- role_profiles.confirmed_at: when the student confirmed their profile ("Find roles"). The first read of a resume or
-- LinkedIn profile makes the row with what Orbit proposed, so the proposal survives a reload; it is the student's
-- profile only once they have looked at it and saved it. Until then the profile route answers the proposal alone,
-- the browser shows the review screen again, and nothing is searched, scored or topped up for a profile nobody
-- checked (plan 44 §2.2: Orbit shows what it read before any role is listed).

alter table orbit.role_profiles add column if not exists confirmed_at timestamptz;

-- Rows from before this column: confirmed when the student changed what Orbit proposed, or has searched with it.
update orbit.role_profiles p
   set confirmed_at = p.updated_at
 where p.confirmed_at is null
   and (p.proposed is null
        or p.profile is distinct from p.proposed
        or exists (select 1 from orbit.role_searches s where s.user_id = p.user_id));

-- job_boards: a 429 is the board asking Orbit to slow down, not a failure of the board. It is asked once more later
-- the same day, then daily, and only several days in a row that end on a 429 set it aside.
--   rate_limited_at    when it first answered 429 on its latest day of doing so
--   rate_limited_days  days in a row that ended on a 429 (0 after a read that worked)
alter table orbit_private.job_boards add column if not exists rate_limited_at timestamptz;
alter table orbit_private.job_boards add column if not exists rate_limited_days int not null default 0;

-- Ashby boards are read whole up to 12 MB now (2 MB before). The ones set aside as too large under the old limit and
-- within the new one are due again, a tick each.
update orbit_private.job_boards
   set next_read_at = now()
 where last_error like 'too_large%'
   and (last_size_bytes is null or last_size_bytes <= 12000000);
