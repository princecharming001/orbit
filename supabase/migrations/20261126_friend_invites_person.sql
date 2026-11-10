-- Plan 37 follow-up: an invite to someone in the student's People who has no address goes as a LinkedIn message
-- with its own link; the person it went to is kept, so the suggestions do not offer them again.
alter table orbit.friend_invites add column if not exists to_person_id uuid;
create index if not exists friend_invites_to_person_idx on orbit.friend_invites (from_user_id, to_person_id)
  where to_person_id is not null;
