-- Plan 43, the server base: the off rule in the database, the listed flag for friends, and the marks the browser reads.
-- Additive and re-runnable: new functions, a new column, functions replaced with a stricter version, new triggers.
--
-- 1. orbit.person_in_use: whether a person row counts while some optional sources are out of use (the student
--    switched them off, removed them, never connected them, or the owner does not offer them). A person known only
--    from those sources (people.sources holds nothing else, or the person was made from an account on one of those
--    platforms) is left out wherever people are read (plan 43 §3.2).
-- 2. Friend sharing leaves out people who are not listed (plan 43 §3.3): the guard refuses them, and a person who
--    becomes unlisted leaves every projection at once, as a hidden one does.
-- 3. user_marks.graph_version: moved by the switch job (sources.switch) when a source goes on, off or is removed. The
--    browser drops its cached graph when the number it holds differs from /sync/status's marks.graphVersion.
-- 4. The new tables the browser pulls (source_states, social_links, social_match_asks, social_lookups, text_days) move
--    the "something changed" mark like every other pulled table.

-- ---- 1. the off rule --------------------------------------------------------------------------------------------

create or replace function orbit.person_in_use(p_sources text[], p_source_account text, p_hidden text[])
returns boolean
language sql
immutable
parallel safe
security definer
set search_path = ''
as $$
  select cardinality(coalesce(p_hidden, '{}')) = 0
      or (not (cardinality(coalesce(p_sources, '{}')) > 0 and p_sources <@ p_hidden)
          and (p_source_account is null or split_part(p_source_account, ':', 1) <> all(p_hidden)))
$$;
revoke all on function orbit.person_in_use(text[], text, text[]) from public, anon, authenticated;
grant execute on function orbit.person_in_use(text[], text, text[]) to service_role;

-- ---- 2. friends see listed people only ----------------------------------------------------------------------------

-- As 20261101_orbit_friends.sql, and a person who is not listed (made from an account, no real exchange yet) is refused
create or replace function orbit.friend_shares_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  select user_id, private, hidden_at, do_not_contact, deleted_at, merged_into, is_self, listed
    into p from orbit.people where id = new.person_id;
  if p is null or p.user_id <> new.owner_user_id then
    raise exception 'friend_shares: % is not one of the owner''s people', new.person_id;
  end if;
  if p.private or p.hidden_at is not null or p.do_not_contact or p.deleted_at is not null
     or p.merged_into is not null or p.is_self then
    raise exception 'friend_shares: % is private, hidden or asked not to be contacted', new.person_id;
  end if;
  if not p.listed then
    raise exception 'friend_shares: % is not listed', new.person_id;
  end if;
  return new;
end
$$;

create or replace function orbit.people_unshare()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.private and not old.private)
     or (new.hidden_at is not null and old.hidden_at is null)
     or (new.do_not_contact and not old.do_not_contact)
     or (new.deleted_at is not null and old.deleted_at is null)
     or (new.merged_into is not null and old.merged_into is null)
     or (not new.listed and old.listed) then
    delete from orbit.friend_shares where owner_user_id = new.user_id and person_id = new.id;
  end if;
  return new;
end
$$;
drop trigger if exists people_unshare on orbit.people;
create trigger people_unshare after update of private, hidden_at, do_not_contact, deleted_at, merged_into, listed
  on orbit.people
  for each row execute function orbit.people_unshare();
revoke all on function orbit.friend_shares_guard(), orbit.people_unshare() from public, anon, authenticated;
grant execute on function orbit.friend_shares_guard(), orbit.people_unshare() to service_role;

-- ---- 3. the graph mark ------------------------------------------------------------------------------------------

alter table orbit.user_marks add column if not exists graph_version integer not null default 0;
comment on column orbit.user_marks.graph_version is
  'Plan 43 §3.2: moved by the switch job when an optional source goes on, off or is removed; the browser drops its cached graph and pulls again when it moves.';

create or replace function orbit.bump_graph_version(p_user uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into orbit.user_marks as m (user_id, graph_version)
  select p_user, 1 where exists (select 1 from orbit.users u where u.id = p_user)
  on conflict (user_id) do update set graph_version = m.graph_version + 1,
    changed_at = greatest(clock_timestamp(), m.changed_at + interval '1 microsecond')
  returning graph_version;
$$;
revoke all on function orbit.bump_graph_version(uuid) from public, anon, authenticated;
grant execute on function orbit.bump_graph_version(uuid) to service_role;

-- ---- 4. the new pulled tables move the change mark --------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['source_states', 'social_links', 'social_match_asks', 'social_lookups', 'text_days'] loop
    execute format('drop trigger if exists user_marks_ins_del on orbit.%I', t);
    execute format('drop trigger if exists user_marks_upd on orbit.%I', t);
    execute format(
      'create constraint trigger user_marks_ins_del after insert or delete on orbit.%I '
      'deferrable initially deferred for each row execute function orbit.mark_user_change()',
      t
    );
    execute format(
      'create constraint trigger user_marks_upd after update on orbit.%I '
      'deferrable initially deferred for each row '
      'when ((to_jsonb(old) - ''updated_at'') is distinct from (to_jsonb(new) - ''updated_at'')) '
      'execute function orbit.mark_user_change()',
      t
    );
  end loop;
end
$$;

create index if not exists text_days_person_idx on orbit.text_days (person_id);
create index if not exists social_follows_owner_idx on orbit.social_follows (owner_user_id) where owner_user_id is not null;
