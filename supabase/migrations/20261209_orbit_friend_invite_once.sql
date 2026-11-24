-- One invite an address. Two taps of Invite a second apart made two invites to the same address, each its own line
-- under Requested, and an invite that was never emailed looked the same as one that was.
--
--   emailed_at / emailed_via: when the invite's email went out and how (the student's own Gmail, or Orbit's address).
--   Null means nobody was sent it: the student still has to pass the link on, and the page says so.

alter table orbit.friend_invites add column if not exists emailed_at timestamptz;
alter table orbit.friend_invites add column if not exists emailed_via text;

-- Doubles already there: the newest waiting invite to an address stays, the older ones to it are withdrawn. None of
-- them was emailed (no mail went out before this change), so no link anyone holds stops working.
update orbit.friend_invites f
   set status = 'revoked', answered_at = now()
 where f.status = 'pending'
   and f.to_email is not null
   and exists (
     select 1 from orbit.friend_invites g
      where g.from_user_id = f.from_user_id
        and g.to_email = f.to_email
        and g.status = 'pending'
        and (g.created_at, g.id) > (f.created_at, f.id)
   );

-- and the database refuses a second one, whatever the code above it does (two requests at the same moment)
create unique index if not exists friend_invites_one_pending_email
  on orbit.friend_invites (from_user_id, to_email)
  where status = 'pending' and to_email is not null;
create unique index if not exists friend_invites_one_pending_person
  on orbit.friend_invites (from_user_id, to_person_id)
  where status = 'pending' and to_person_id is not null;
