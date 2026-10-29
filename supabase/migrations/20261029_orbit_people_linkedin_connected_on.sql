-- When the student and this person connected on LinkedIn, from the live sync (Unipile relations) or a webhook.
-- The browser reads it as linkedinConnectedOn: a connection is someone the student knows (isKnownContact), so the
-- People page counts them, as it already did for a LinkedIn export. Existing connections are filled in from their
-- identity rows (source linkedin_relation, created when they connected) and bumped so every browser pulls them.

alter table orbit.people add column if not exists linkedin_connected_on timestamptz;
comment on column orbit.people.linkedin_connected_on is
  'When the student connected with them on LinkedIn (live sync); null for people from mail, calendar or a search.';

update orbit.people p
   set linkedin_connected_on = s.connected_at, updated_at = now()
  from (select person_id, min(created_at) as connected_at
          from orbit.person_identities
         where kind = 'linkedin_member' and source = 'linkedin_relation'
         group by person_id) s
 where s.person_id = p.id and p.linkedin_connected_on is null;
