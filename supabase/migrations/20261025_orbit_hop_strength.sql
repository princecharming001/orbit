-- Every hop counts (docs/plan/21-hop-strength.md, account mode §5.3):
--
--   orbit.ties kind check      gains the five plan 21 kinds: linkedin_recommendation, linkedin_engagement and
--                              linkedin_mention (from the hop_evidence job's LinkedIn reads), common_contacts (computed
--                              in core, kept for completeness) and student_says_close (the student's "they're close").
--   orbit.blocked_pairs        "they don't really know each other": a pair the student took out of routing. Not a tie
--                              (a noisy-OR cannot lower a weight); it survives every recompute until the student undoes it.
--   orbit.people               LinkedIn follower and connection counts, kept when a profile is read (the popularity
--                              discount of §3.3 reads the post author's followers).
--   orbit.intro_requests       hop_features: the path's hops (p, kind, band) and P frozen when the ask is made, the
--                              labelled data for the fit of §8.
--   orbit.usage_ledger         account_id: the Unipile account a LinkedIn read was made through, so the daily read
--                              budget is per LinkedIn account (§6), not per Orbit user.
--
-- The engagement pages themselves (ids, dates and counts only, never comment text) live 30 days in
-- orbit.research_cache, like the mutual-connection lists. Re-runnable.

alter table orbit.ties drop constraint if exists ties_kind_check;
alter table orbit.ties add constraint ties_kind_check check (kind in (
  'email_exchange', 'email_cc', 'email_cothread', 'meeting_coattendee', 'introduced_by', 'linkedin_mutual',
  'village_path', 'co_tenure', 'same_school_cohort', 'same_current_company', 'same_city',
  'linkedin_recommendation', 'linkedin_engagement', 'linkedin_mention', 'common_contacts', 'student_says_close'
));

create table if not exists orbit.blocked_pairs (
  user_id uuid not null references orbit.users(id) on delete cascade,
  a_person_id uuid not null references orbit.people(id) on delete cascade,
  b_person_id uuid not null references orbit.people(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (a_person_id < b_person_id),
  primary key (user_id, a_person_id, b_person_id)
);
comment on table orbit.blocked_pairs is 'Plan 21 §3.5: pairs the student said do not really know each other; never a hop.';
-- RLS on with no policies, service role only, as every orbit table (20261014_orbit_core.sql)
alter table orbit.blocked_pairs enable row level security;
revoke all on table orbit.blocked_pairs from public, anon, authenticated;
grant all on table orbit.blocked_pairs to service_role;

alter table orbit.people add column if not exists linkedin_follower_count integer;
alter table orbit.people add column if not exists linkedin_connections_count integer;

alter table orbit.intro_requests add column if not exists hop_features jsonb;

alter table orbit.usage_ledger add column if not exists account_id text;
create index if not exists usage_ledger_account_idx on orbit.usage_ledger (account_id, created_at)
  where account_id is not null;
