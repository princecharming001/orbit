-- Plan 35 B3 and B4.
--
-- B3: one cheap "something changed" mark per student instead of three polls. orbit.user_marks keeps, per user, when
-- anything the browser pulls last changed (changed_at), when what /linkedin/status answers last changed
-- (linkedin_at) and when what /autopilot/status answers last changed (autopilot_at). /sync/status reads this one row
-- (and the queue depth only while setup runs) instead of nine count(*) queries and a scan of every queue; the browser
-- pulls only when changed_at moved, and reads LinkedIn's and autopilot's status only when their marks moved.
--
-- The marks are kept by deferred row triggers on every table /sync/pull returns (orbit-api/tables.ts PULL_TABLES),
-- plus integration_accounts, the autopilot-relevant audit rows and the user's autopilot settings. Each trigger fires
-- only on a real change: inserts, deletes, and updates where the row differs apart from updated_at (the same test
-- plan 35 B2 puts in touch_updated_at, so this holds before and after B2). The triggers are deferred to commit, so
-- the mark row is locked only for the instant of the commit, never for a whole transaction, and each transaction
-- writes each user's mark at most once (a transaction-local setting remembers which marks it already moved): a
-- nightly score run touching 7,000 rows writes one mark, not 7,000.
--
-- The mark is a timestamp that always moves forward (at least one microsecond past the last), so the browser only
-- compares it for inequality. counts/counts_at keep /sync/status's counts for older browsers, recomputed only after
-- changed_at moved past counts_at.
--
-- B4: the whole-network logo sweep moves from every open browser to one weekly worker job (logos.sweep) over
-- companies 3 or more people work at across all students, filling the shared orbit_private.linkedin_companies list.
--
-- Additive only: a new table, new functions, new triggers, one new cron entry.

create table if not exists orbit.user_marks (
  user_id uuid primary key references orbit.users(id) on delete cascade,
  changed_at timestamptz not null default now(),
  linkedin_at timestamptz not null default now(),
  autopilot_at timestamptz not null default now(),
  counts jsonb,
  counts_at timestamptz
);
comment on table orbit.user_marks is
  'Orbit plan 35 B3: when each student''s pulled data, LinkedIn status and autopilot status last changed. Service role only.';

-- the same access as every other orbit table: RLS on with no policies, service role only
alter table orbit.user_marks enable row level security;
revoke all on table orbit.user_marks from public, anon, authenticated;
grant all on table orbit.user_marks to service_role;

-- ---- the mark writer ------------------------------------------------------------------------------------------------

-- Moves the named marks ('c' changed, 'l' linkedin, 'a' autopilot) for one user, once per transaction per mark.
-- A user that is gone (an account deleted in this same transaction) is skipped.
create or replace function orbit.move_user_marks(p_user uuid, p_kinds text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  done text := coalesce(current_setting('orbit.marks_moved', true), '');
  want text := '';
  k text;
begin
  if p_user is null or coalesce(p_kinds, '') = '' then
    return;
  end if;
  foreach k in array string_to_array(p_kinds, ',') loop
    if position('|' || p_user::text || ':' || k || '|' in done) = 0 then
      want := want || k;
      done := done || '|' || p_user::text || ':' || k || '|';
    end if;
  end loop;
  if want = '' then
    return;
  end if;
  perform set_config('orbit.marks_moved', done, true);
  insert into orbit.user_marks (user_id, changed_at, linkedin_at, autopilot_at)
  select p_user, clock_timestamp(), clock_timestamp(), clock_timestamp()
   where exists (select 1 from orbit.users u where u.id = p_user)
  on conflict (user_id) do update set
    changed_at = case when position('c' in want) > 0
                      then greatest(clock_timestamp(), orbit.user_marks.changed_at + interval '1 microsecond')
                      else orbit.user_marks.changed_at end,
    linkedin_at = case when position('l' in want) > 0
                       then greatest(clock_timestamp(), orbit.user_marks.linkedin_at + interval '1 microsecond')
                       else orbit.user_marks.linkedin_at end,
    autopilot_at = case when position('a' in want) > 0
                        then greatest(clock_timestamp(), orbit.user_marks.autopilot_at + interval '1 microsecond')
                        else orbit.user_marks.autopilot_at end;
end
$$;

-- The row trigger: which marks a change to this table's row moves. Every pulled table moves changed_at; LinkedIn's
-- account row and its imported relations move linkedin_at; drafts, the funnel's cards, inbound replies, goals and
-- the draft audit rows move autopilot_at (what /autopilot/status reads).
create or replace function orbit.mark_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  uid uuid;
  kinds text := 'c';
begin
  if tg_op = 'DELETE' then
    r := old;
  else
    r := new;
  end if;
  if tg_table_name = 'users' then
    uid := r.id;
    kinds := 'a';
  elsif tg_table_name = 'audit_log' then
    uid := r.user_id;
    kinds := 'a';
  else
    uid := r.user_id;
    if tg_table_name = 'integration_accounts' then
      if r.provider = 'linkedin' then
        kinds := 'c,l';
      end if;
    elsif tg_table_name = 'person_identities' then
      if r.source = 'linkedin_relation' then
        kinds := 'c,l';
      end if;
    elsif tg_table_name in ('drafts', 'suggestions', 'goals') then
      kinds := 'c,a';
    elsif tg_table_name = 'messages' then
      if r.direction = 'in' then
        kinds := 'c,a';
      end if;
    end if;
  end if;
  perform orbit.move_user_marks(uid, kinds);
  return null;
end
$$;

revoke all on function orbit.move_user_marks(uuid, text), orbit.mark_user_change() from public, anon, authenticated;
grant execute on function orbit.move_user_marks(uuid, text), orbit.mark_user_change() to service_role;

-- ---- the triggers ---------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    -- orbit-api/tables.ts PULL_TABLES, in its order
    'organizations', 'people', 'person_identities', 'affiliations', 'merge_suggestions', 'goals', 'threads',
    'messages', 'calendar_events', 'ties', 'tie_scores', 'tie_labels', 'chats', 'stage_events', 'drafts', 'notes',
    'uploads', 'facts', 'dossiers', 'recommendations', 'intro_requests', 'suggestions', 'notifications',
    -- and the integrations /sync/status reports
    'integration_accounts'
  ] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'orbit' and table_name = t and column_name = 'user_id'
    ) then
      raise exception 'user_marks: orbit.% has no user_id', t;
    end if;
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

-- the audit rows /autopilot/status counts (approvals, auto sends): append-only, so inserts only
drop trigger if exists user_marks_audit on orbit.audit_log;
create constraint trigger user_marks_audit after insert on orbit.audit_log
  deferrable initially deferred for each row
  when (new.action like 'draft.%')
  execute function orbit.mark_user_change();

-- the autopilot mode, pauses, rungs and timezone live on the user row; last_seen_at and the rest do not move it
drop trigger if exists user_marks_settings on orbit.users;
create constraint trigger user_marks_settings after update on orbit.users
  deferrable initially deferred for each row
  when (old.settings is distinct from new.settings
        or old.autonomy_level is distinct from new.autonomy_level
        or old.timezone is distinct from new.timezone)
  execute function orbit.mark_user_change();

-- ---- B4: the weekly logo sweep ----------------------------------------------------------------------------------------

-- one job for everyone (userId null): companies 3 or more people work at across all students, looked up on LinkedIn
-- once and kept in orbit_private.linkedin_companies with their logos, so every browser answers them from the shared list
create or replace function orbit.enqueue_logos_sweep()
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  if orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'logos.sweep', 'userId', null, 'payload', jsonb_build_object('part', 0),
    'dedupeKey', 'weekly:logos.sweep:' || to_char(now() at time zone 'utc', 'IYYY-IW') || ':0')) is not null then
    return 1;
  end if;
  return 0;
end
$$;

revoke all on function orbit.enqueue_logos_sweep() from public, anon, authenticated;
grant execute on function orbit.enqueue_logos_sweep() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-logos-weekly') then
    perform cron.unschedule('orbit-logos-weekly');
  end if;
  perform cron.schedule('orbit-logos-weekly', '17 9 * * 0', $cron$select orbit.enqueue_logos_sweep()$cron$);
end
$$;
