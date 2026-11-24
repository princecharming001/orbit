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
