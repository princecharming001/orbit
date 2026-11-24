-- Backend audit 2026-11-24: indexes for the identity lookup every ingest starts with. Additive only.
--
-- resolvePeople (functions/_shared/ingest/people.ts) asks, for each page of addresses and profiles, which people
-- already carry one of them: by orbit.person_identities (indexed by its unique key) and by three columns of
-- orbit.people, which had no index, so each of the three read every person the user has (7,700 for the largest
-- network) on every page of every sync and every webhook. The indexes are partial, matching the lookup: only rows
-- that carry the value and are not deleted.
--
-- None is unique: 34 pairs of people share a linkedin_member_id today (two ingests created the same person at the
-- same moment, which the per-user lock in resolvePeople now prevents), and a unique index would fail on them.

create index if not exists people_primary_email_idx on orbit.people (user_id, primary_email)
  where primary_email is not null and deleted_at is null;
create index if not exists people_linkedin_member_idx on orbit.people (user_id, linkedin_member_id)
  where linkedin_member_id is not null and deleted_at is null;
create index if not exists people_linkedin_slug_idx on orbit.people (user_id, linkedin_slug)
  where linkedin_slug is not null and deleted_at is null;
