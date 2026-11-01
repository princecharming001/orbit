-- Voice (docs/plan/29-friends-and-autopilot.md §B2.4, §B3, §C1 phase 4): every edit the student makes to a draft
-- before it goes is kept as a typed row, in both modes (the browser pushes its own through /sync/push), and a
-- server draft keeps the words Orbit first wrote so an edit is seen whatever path approved it.

create table if not exists orbit.draft_edits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  -- no foreign key: an edit from a browser can name a draft only that browser had
  draft_id uuid,
  kind text not null,
  reply_class text,
  before text not null,
  after text not null,
  -- words taken out or put in
  distance int not null default 0 check (distance >= 0),
  created_at timestamptz not null default now()
);
create index if not exists draft_edits_user_time_idx on orbit.draft_edits (user_id, created_at desc);
-- one row per draft: an edit made again before the send replaces the first
create unique index if not exists draft_edits_draft_idx on orbit.draft_edits (draft_id) where draft_id is not null;
alter table orbit.draft_edits enable row level security;
comment on table orbit.draft_edits is
  'Plan 29 §B2.4: what Orbit wrote and what the student sent instead, one row per edited draft; voice.distill reads the last thirty. orbit.delete_user takes them with the user (user_id cascade).';

-- the words Orbit first wrote: set once when the draft is made, so any later change to `body` is the student's edit
alter table orbit.drafts add column if not exists body_original text;
comment on column orbit.drafts.body_original is
  'Plan 29 §B2.4: the body as Orbit composed it; an approval of a different body writes a draft_edits row.';

create or replace function orbit.drafts_body_original()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.body_original := coalesce(new.body_original, new.body);
  return new;
end
$$;
drop trigger if exists drafts_body_original on orbit.drafts;
create trigger drafts_body_original before insert on orbit.drafts
  for each row execute function orbit.drafts_body_original();

-- users.settings gains the voice (plan 29 §B3):
--   style_card jsonb           the card the browser learned (or voice.card rebuilt from sent mail)
--   voice_notes jsonb          [{id, text, avoid?, evidence: uuid[], createdAt, keptAt, forgottenAt}]
--   voice_relearned_at text    ISO, the last time the card or the notes were learned again on the server
comment on column orbit.users.settings is
  'Per-user settings as one jsonb: auto_kinds, autopilot_mode, autopilot_paused_until, autopilot_paused_goals, daily_send_cap_gmail, daily_send_cap_linkedin, quiet_until, postal_address, scheduling_link, about, read_reply_tone, max_bumps, style_card, voice_notes, voice_relearned_at (plan 29 §B3).';

-- the same grants the core migration gives everything in the schema: service role only
revoke all on table orbit.draft_edits from public, anon, authenticated;
grant all on table orbit.draft_edits to service_role;
revoke all on function orbit.drafts_body_original() from public, anon, authenticated;
grant execute on function orbit.drafts_body_original() to service_role;

-- the nightly distillation (plan 29 §B2.4b): once a day, for everyone with an edit since the last day, the edits are
-- read into notes; the job itself merges them so a forgotten note is never learned again
create or replace function orbit.enqueue_voice_distill()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  day text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
begin
  for r in
    select distinct e.user_id from orbit.draft_edits e join orbit.users u on u.id = e.user_id
     where e.created_at >= now() - interval '25 hours' and u.deleted_at is null
  loop
    if orbit.enqueue('orbit_cadence', jsonb_build_object(
      'kind', 'voice.distill', 'userId', r.user_id, 'payload', jsonb_build_object('reason', 'nightly'),
      'dedupeKey', 'voice.distill:' || r.user_id || ':' || day)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
select cron.schedule('orbit-voice', '43 7 * * *', $$select orbit.enqueue_voice_distill()$$);
revoke all on function orbit.enqueue_voice_distill() from public, anon, authenticated;
grant execute on function orbit.enqueue_voice_distill() to service_role;
