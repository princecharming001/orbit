-- Connect from a people search (POST /source/connect). The button on someone found outside the student's network
-- sends a LinkedIn connection request from the student's own account, on that one click. Additive: one table.
--
--   orbit.linkedin_connects  one row per student and LinkedIn member a connection request was asked for. The primary
--                            key is the marker that makes a request go once: the route inserts the row before it asks
--                            LinkedIn, and two clicks, two tabs or a retry find it there and send nothing.
--     target  who on LinkedIn, as Orbit knows them when the request is asked for: 'in:<profile name>' (the end of
--             their profile address, lower case) when Orbit has it, else 'id:<member id>'. It is the member and not
--             Orbit's own person row on purpose: two rows made for one person at the same moment still share it.
--     status  sending      the request is on its way to LinkedIn (the row was just claimed)
--             sent         LinkedIn has a request from the student to this person (Orbit sent it, or LinkedIn said one
--                          was already waiting)
--             unconfirmed  the call to LinkedIn broke off after it left, so the request may or may not have gone:
--                          never sent a second time, the student checks on LinkedIn
--   A request that did not go (a limit, a profile LinkedIn could not find, a refusal) removes the row, so a later
--   click can try again.

create table if not exists orbit.linkedin_connects (
  user_id uuid not null references orbit.users(id) on delete cascade,
  target text not null,
  person_id uuid references orbit.people(id) on delete set null,
  status text not null default 'sending' check (status in ('sending', 'sent', 'unconfirmed')),
  -- LinkedIn's id for the request, when it gave one
  invitation_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (user_id, target)
);
create index if not exists linkedin_connects_person_idx on orbit.linkedin_connects (user_id, person_id);

alter table orbit.linkedin_connects enable row level security;
revoke all on table orbit.linkedin_connects from public, anon, authenticated;
grant all on table orbit.linkedin_connects to service_role;
