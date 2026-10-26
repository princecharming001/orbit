-- Repair for JSON the functions stored as JSON strings (postgres.js encoded text that was already JSON a second
-- time; fixed in _shared/db.ts `pgTypes`). Attendee lists, audit details and dead letters were strings, and each
-- sync_state patch (`section || patch`) appended a string, so a section such as `calendar` grew into an array with
-- one element per run. Strings are decoded; an array section is folded back into one object, later runs winning.

create or replace function pg_temp.unwrap(j jsonb) returns jsonb
language plpgsql as $$
begin
  while jsonb_typeof(j) = 'string' loop
    begin
      j := (j #>> '{}')::jsonb;
    exception when others then
      return j;
    end;
  end loop;
  return j;
end
$$;

update orbit.calendar_events set attendees = pg_temp.unwrap(attendees) where jsonb_typeof(attendees) = 'string';
update orbit.audit_log set details = pg_temp.unwrap(details) where jsonb_typeof(details) = 'string';
update orbit.dead_letters set message = pg_temp.unwrap(message) where jsonb_typeof(message) = 'string';

do $$
declare
  r record;
  folded jsonb;
  e jsonb;
begin
  for r in
    select a.id, s.key, s.value
      from orbit.integration_accounts a, jsonb_each(a.sync_state) s
     where jsonb_typeof(s.value) = 'array'
  loop
    folded := '{}'::jsonb;
    for e in select x from jsonb_array_elements(r.value) x loop
      e := pg_temp.unwrap(e);
      if jsonb_typeof(e) = 'object' then
        folded := folded || e;
      end if;
    end loop;
    update orbit.integration_accounts set sync_state = jsonb_set(sync_state, array[r.key], folded) where id = r.id;
  end loop;
end
$$;
