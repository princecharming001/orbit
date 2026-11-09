-- Plan 35 B2 (and the column B1 needs): stop rewriting what did not change.
--   touch_updated_at   bumps updated_at only when some other column changed. An update that rewrites a row with the
--                      same values (a nightly score run's 7.7k tie_scores, 13.5k ties, 7.7k people.strength) kept its
--                      old updated_at no longer, so the next /sync/pull sent every one of them to the browser again.
--                      The comparison leaves out updated_at itself and people.scored_at (bookkeeping the browser never
--                      reads), and keeps the old updated_at even when the statement set it explicitly.
--   people.scored_at   when the person was last scored (plan 35 B1, delta scoring): the nightly run rescores only
--                      people with an input newer than this, and everyone once a week.
-- Additive only: one nullable column and a replaced function; every existing trigger keeps calling it by name.

alter table orbit.people add column if not exists scored_at timestamptz;

create or replace function orbit.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'updated_at' - 'scored_at') = (to_jsonb(old) - 'updated_at' - 'scored_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;
