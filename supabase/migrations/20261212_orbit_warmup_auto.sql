-- The automated LinkedIn warm-up (docs/plan/13-linkedin-warm-up.md §8). Additive and re-runnable.
--
-- With an Orbit account and the student's own LinkedIn connected, starting a warm-up for a person runs the whole
-- sequence on the server: a visible profile view, a like on one recent post, the comment the student approved, each on
-- its own working day at a random minute inside working hours. Orbit's privacy policy promises nothing is posted from
-- a student's account without their approval of the exact words, so the comment is stored once at Start and can never
-- be changed afterwards (a trigger refuses it).
--
--   orbit.warmups         one row per warm-up: the person, the chosen post, the comment as drafted (comment_draft) and
--                         as approved (comment), the student's Unipile account the run acts through, where it stands
--                         (preview until the student presses Start, then running, then done or stopped with a reason)
--   orbit.warmup_steps    each step's time, state, tries and what happened on each try
--   orbit.warmup_actions  one row per automated action taken or tried: the daily counts and the spacing are read here
--   orbit.warmup_take     the counter: under a lock per student, refuses an action inside the gap after the last one,
--                         over the day's count for its kind, or on a person who already had an action today, and
--                         records it otherwise. The limits are passed in from WARMUP_AUTO_CAPS
--                         (packages/core/src/warmup/auto.ts), the one place they are set.
--   orbit.warmup_stop_reason  why a running warm-up must stop now (the person replied, was written to, became a
--                         connection, is marked do not contact, hidden or merged; LinkedIn is disconnected, parked or
--                         needs a new sign-in; the student turned "Run warm-ups for me" off), or null
--   orbit.enqueue_warmup_steps  every five minutes: stops the warm-ups that must stop, puts a step whose worker died
--                         back in line, and queues one warmup.step job per step whose time has come
--
-- users.settings gains one key: warmup_auto (false only; on is the default and is not stored).

create table if not exists orbit.warmups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  status text not null default 'preview' check (status in ('preview', 'running', 'done', 'stopped')),
  stop_reason text,
  -- the student's own LinkedIn at Unipile (integration_accounts.external_account_id when the post was read): the
  -- only account a step ever acts through, and only while it is still that student's active account
  linkedin_account text,
  -- the person as LinkedIn names them
  target_member_id text,
  target_slug text,
  connected_at_start boolean not null default false,
  -- the post the like and the comment go on (post_id is LinkedIn's social id); all null when they have no recent post
  post_id text,
  post_url text,
  post_excerpt text,
  post_topic text,
  post_at timestamptz,
  -- the words: as Orbit drafted them for the sheet, and as the student approved them at Start (null: left out)
  comment_draft text,
  comment text,
  comment_approved_at timestamptz,
  timezone text,
  warm_up_days smallint,
  started_at timestamptz,
  ready_at timestamptz,
  finished_at timestamptz,
  -- told once: the notification row written when the last step ran, and the toast the student saw
  notified_at timestamptz,
  told_at timestamptz,
  -- raised with every change to one of its steps, so updated_at moves and the next pull sends the run again
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table orbit.warmups is
  'Orbit: automated LinkedIn warm-ups. comment is the text the student approved at Start and never changes after it.';
-- one warm-up under way per person
create unique index if not exists warmups_live_idx on orbit.warmups (user_id, person_id) where status = 'running';
create index if not exists warmups_person_idx on orbit.warmups (person_id);
create index if not exists warmups_running_idx on orbit.warmups (user_id) where status = 'running';

create table if not exists orbit.warmup_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  warmup_id uuid not null references orbit.warmups(id) on delete cascade,
  seq smallint not null,
  kind text not null check (kind in ('view_profile', 'react_post', 'comment_post')),
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'skipped')),
  attempts smallint not null default 0,
  claimed_at timestamptz,
  ran_at timestamptz,
  -- why it was skipped, or how it ended (post_gone, failed, unconfirmed, already_reacted, stopped)
  note text,
  -- what happened: {tries: [{at, ok, error?, status?}], interrupted?: true}
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warmup_id, seq)
);
create index if not exists warmup_steps_due_idx on orbit.warmup_steps (due_at) where status = 'pending';

create table if not exists orbit.warmup_actions (
  id bigint generated always as identity primary key,
  user_id uuid not null references orbit.users(id) on delete cascade,
  -- no foreign key: the count stays true when a person is merged away
  person_id uuid not null,
  step_id uuid,
  kind text not null check (kind in ('view_profile', 'react_post', 'comment_post')),
  account text not null,
  at timestamptz not null default now()
);
create index if not exists warmup_actions_user_idx on orbit.warmup_actions (user_id, at);

do $$
declare
  t text;
begin
  foreach t in array array['warmups', 'warmup_steps'] loop
    execute format('drop trigger if exists touch_updated_at on orbit.%I', t);
    execute format(
      'create trigger touch_updated_at before update on orbit.%I for each row execute function orbit.touch_updated_at()',
      t
    );
    execute format('create index if not exists %I on orbit.%I (user_id, updated_at)', t || '_sync_idx', t);
  end loop;
  foreach t in array array['warmups', 'warmup_steps', 'warmup_actions'] loop
    execute format('alter table orbit.%I enable row level security', t);
    execute format('revoke all on orbit.%I from public, anon, authenticated', t);
    execute format('grant all on orbit.%I to service_role', t);
  end loop;
end
$$;
grant all on sequence orbit.warmup_actions_id_seq to service_role;

-- /sync/pull returns orbit.warmups, so a change to one moves the student's "changed" mark (20261121_orbit_user_marks):
-- the browser pulls when a warm-up starts, a step has run or it stops, not on a timer. A row is born a preview and a
-- preview is never pulled, so an insert moves nothing; a run only goes away with its person or its student, whose own
-- rows move the mark.
drop trigger if exists user_marks_upd on orbit.warmups;
create constraint trigger user_marks_upd after update on orbit.warmups
  deferrable initially deferred for each row
  when (new.status <> 'preview'
        and (to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at'))
  execute function orbit.mark_user_change();

-- ---- the approved comment never changes -----------------------------------------------------------------------------
-- The text is written once, in the update that takes a preview to running. From then on the comment, the post it
-- goes on and the account it goes from are frozen: no later code path, and no mistake in one, can post other words.
create or replace function orbit.warmups_freeze_approved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'preview' then
    if new.comment is distinct from old.comment
       or new.comment_approved_at is distinct from old.comment_approved_at
       or new.post_id is distinct from old.post_id
       or new.linkedin_account is distinct from old.linkedin_account
       or new.user_id is distinct from old.user_id then
      raise exception 'orbit.warmups: the approved comment, its post and its account cannot change after Start';
    end if;
    if new.status = 'preview' then
      raise exception 'orbit.warmups: a started warm-up cannot go back to a preview';
    end if;
  end if;
  return new;
end
$$;
revoke all on function orbit.warmups_freeze_approved() from public, anon, authenticated;
grant execute on function orbit.warmups_freeze_approved() to service_role;
drop trigger if exists warmups_freeze_approved on orbit.warmups;
create trigger warmups_freeze_approved before update on orbit.warmups
  for each row execute function orbit.warmups_freeze_approved();

-- ---- the daily counts and the spacing -------------------------------------------------------------------------------
create or replace function orbit.warmup_take(
  p_user uuid,
  p_person uuid,
  p_step uuid,
  p_kind text,
  p_account text,
  p_day_start timestamptz,
  p_day_limit integer,
  p_gap_seconds integer,
  p_person_limit integer,
  p_now timestamptz default now()
)
returns table (allowed boolean, reason text, retry_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
  v_kind integer;
  v_person integer;
begin
  perform pg_advisory_xact_lock(hashtext('orbit.warmup_take:' || p_user::text));
  delete from orbit.warmup_actions a where a.user_id = p_user and a.at < p_now - interval '30 days';
  -- the last action of any kind, today or before: the gap holds across midnight too
  select max(a.at) into v_last from orbit.warmup_actions a where a.user_id = p_user;
  if v_last is not null and p_now < v_last + make_interval(secs => p_gap_seconds) then
    return query select false, 'gap'::text, v_last + make_interval(secs => p_gap_seconds);
    return;
  end if;
  select count(*) filter (where a.kind = p_kind),
         count(*) filter (where a.person_id = p_person and a.step_id is distinct from p_step)
    into v_kind, v_person
    from orbit.warmup_actions a
   where a.user_id = p_user and a.at >= p_day_start;
  if v_kind >= p_day_limit then
    return query select false, 'day_cap'::text, null::timestamptz;
    return;
  end if;
  if v_person >= p_person_limit then
    return query select false, 'person_day'::text, null::timestamptz;
    return;
  end if;
  insert into orbit.warmup_actions (user_id, person_id, step_id, kind, account, at)
  values (p_user, p_person, p_step, p_kind, p_account, p_now);
  return query select true, null::text, null::timestamptz;
end
$$;
revoke all on function orbit.warmup_take(uuid, uuid, uuid, text, text, timestamptz, integer, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function orbit.warmup_take(uuid, uuid, uuid, text, text, timestamptz, integer, integer, integer, timestamptz)
  to service_role;

-- ---- when a warm-up stops by itself ---------------------------------------------------------------------------------
create or replace function orbit.warmup_stop_reason(p_warmup uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.id is null or p.deleted_at is not null then 'person_gone'
    when p.merged_into is not null then 'merged'
    when p.do_not_contact then 'do_not_contact'
    when p.hidden_at is not null then 'hidden'
    when coalesce(u.settings ->> 'warmup_auto', 'true') = 'false' then 'setting_off'
    when a.id is null or a.status = 'revoked' then 'linkedin_disconnected'
    when a.status = 'parked' then 'linkedin_parked'
    when a.status = 'needs_reauth' then 'linkedin_sign_in'
    when a.status = 'active' and a.external_account_id is distinct from w.linkedin_account then 'linkedin_changed'
    -- they wrote: a message from them since the warm-up started, on any channel
    when exists (
      select 1 from orbit.messages m
       where m.user_id = w.user_id and m.direction = 'in' and m.from_person_id = w.person_id
         and not m.is_automated and m.sent_at > w.started_at) then 'replied'
    -- the student wrote, or queued a message to go: the warm-up has done its job or been passed over
    when exists (
      select 1 from orbit.messages m
       where m.user_id = w.user_id and m.direction = 'out' and w.person_id = any(m.to_person_ids)
         and m.sent_at > w.started_at) then 'messaged'
    when exists (
      select 1 from orbit.drafts d
       where d.user_id = w.user_id and d.person_id = w.person_id and d.kind <> 'forwardable_blurb'
         and d.status in ('approved', 'scheduled', 'sending', 'sent')
         and coalesce(d.sent_at, d.updated_at) > w.started_at) then 'messaged'
    -- they accepted a connection request, or the two connected some other way
    when p.linkedin_connected_on is not null and not w.connected_at_start then 'connected'
    -- the browser's pipeline says the same things when it knows first (a reply it read, a send marked by hand)
    when exists (
      select 1 from orbit.chats c
       where c.user_id = w.user_id and c.person_id = w.person_id and c.archived_at is null
         and c.stage in ('replied', 'scheduling', 'scheduled', 'completed', 'followed_up', 'nurturing')) then 'replied'
    when exists (
      select 1 from orbit.chats c
       where c.user_id = w.user_id and c.person_id = w.person_id and c.archived_at is null
         and c.stage in ('outreach_sent', 'no_response', 'declined')) then 'messaged'
    else null
  end
  from orbit.warmups w
  join orbit.users u on u.id = w.user_id
  left join orbit.people p on p.id = w.person_id and p.user_id = w.user_id
  left join orbit.integration_accounts a on a.user_id = w.user_id and a.provider = 'linkedin'
  where w.id = p_warmup and w.status = 'running'
$$;
revoke all on function orbit.warmup_stop_reason(uuid) from public, anon, authenticated;
grant execute on function orbit.warmup_stop_reason(uuid) to service_role;

-- Stop one warm-up: the steps not run yet are closed as skipped, so nothing of it is ever picked up again.
create or replace function orbit.warmup_stop(p_warmup uuid, p_reason text, p_now timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update orbit.warmups
     set status = 'stopped', stop_reason = p_reason, finished_at = p_now
   where id = p_warmup and status = 'running'
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  update orbit.warmup_steps
     set status = 'skipped', note = coalesce(note, 'stopped')
   where warmup_id = p_warmup and status in ('pending', 'running');
  return true;
end
$$;
revoke all on function orbit.warmup_stop(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function orbit.warmup_stop(uuid, text, timestamptz) to service_role;

-- ---- the schedule: one job per step whose time has come -------------------------------------------------------------
create or replace function orbit.enqueue_warmup_steps()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  r record;
  n integer := 0;
  v_reason text;
begin
  -- nothing under way: nothing to do, and nothing is read
  if not exists (select 1 from orbit.warmups where status = 'running') then
    return 0;
  end if;
  -- the warm-ups that must stop, whether or not a step is due
  for r in select w.id from orbit.warmups w where w.status = 'running' loop
    v_reason := orbit.warmup_stop_reason(r.id);
    if v_reason is not null then
      perform orbit.warmup_stop(r.id, v_reason, now());
    end if;
  end loop;
  -- a step whose worker died under it goes back in line, marked: the next try checks before it acts again
  update orbit.warmup_steps s
     set status = 'pending', result = s.result || jsonb_build_object('interrupted', true)
   where s.status = 'running' and s.claimed_at < now() - interval '15 minutes';
  for r in
    select s.id, s.user_id, s.attempts, s.due_at
      from orbit.warmup_steps s
      join orbit.warmups w on w.id = s.warmup_id and w.status = 'running'
      join orbit.users u on u.id = s.user_id and u.deleted_at is null
     where s.status = 'pending' and s.due_at <= now()
     order by s.due_at
     limit 200
  loop
    perform orbit.enqueue('orbit_cadence', jsonb_build_object(
      'kind', 'warmup.step', 'userId', r.user_id,
      'payload', jsonb_build_object('stepId', r.id),
      'dedupeKey', 'warmup.step:' || r.id::text || ':' || r.attempts::text || ':'
                   || to_char(r.due_at at time zone 'utc', 'YYYYMMDD"T"HH24MISS')));
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function orbit.enqueue_warmup_steps() from public, anon, authenticated;
grant execute on function orbit.enqueue_warmup_steps() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-warmup') then
    perform cron.unschedule('orbit-warmup');
  end if;
  perform cron.schedule('orbit-warmup', '*/5 * * * *', $cron$select orbit.enqueue_warmup_steps()$cron$);
end
$$;

comment on column orbit.users.settings is
  'Per-user settings as one jsonb: auto_kinds, autopilot_mode, autopilot_paused_until, autopilot_paused_goals, daily_send_cap_gmail, daily_send_cap_linkedin, quiet_until, postal_address, scheduling_link, about, read_reply_tone, max_bumps, style_card, voice_notes, voice_relearned_at (plan 29 §B3), warmup_auto (false turns "Run warm-ups for me" off).';
