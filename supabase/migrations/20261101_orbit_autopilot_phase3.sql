-- Autopilot, phase 3 (docs/plan/29-friends-and-autopilot.md §B2.3, §B2.6, §B2.7, §C1): replies finished by class.
-- A draft keeps the slots it offered, so a reply that names one can book the call; a draft that asks the student
-- for a fact says so in a column instead of a bracket in its body; a reply that asked a question keeps the student's
-- answer; the cards and notifications the funnel raises get server tables of their own, pulled by the browser like
-- every other row; and the nightly outcome roll has a job.

-- the slots a reply offered (ISO starts), kept so a scheduling reply can be matched against them (§B2.3)
alter table orbit.drafts add column if not exists offered_slots jsonb;
-- what the draft still needs from the student before it can go: today only 'answer' (the [ASK USER] marker, §8.6)
alter table orbit.drafts add column if not exists needs text[] not null default '{}';
comment on column orbit.drafts.offered_slots is
  'Plan 29 §B2.3: the slot starts (ISO) this draft offered; a scheduling reply naming one of them books the call.';
comment on column orbit.drafts.needs is
  'Plan 29 §B2.3: what only the student can fill in before the draft can be approved; the [ASK USER] marker as data.';

-- the student's answer to a question a reply asked (Needs you, §B1), and when they gave it
alter table orbit.messages add column if not exists answer text;
alter table orbit.messages add column if not exists answered_at timestamptz;
comment on column orbit.messages.answer is
  'Plan 29 §B2.3: the student''s one-line answer to the question this reply asked; the reply is drafted around it.';

-- the cards the funnel raises for the student (needs_you, breaker, call_booked), one row per card, the shape the
-- browser's own suggestions have so the pull writes them into the same table
create table if not exists orbit.suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null,
  person_id uuid references orbit.people(id) on delete cascade,
  chat_id uuid references orbit.chats(id) on delete set null,
  draft_id uuid references orbit.drafts(id) on delete set null,
  message_id uuid references orbit.messages(id) on delete set null,
  priority_score real not null default 0.5,
  reason_text text not null,
  signals jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','approved','edited','snoozed','dismissed','sent','expired','done')),
  dedupe_key text not null,
  carried_over int not null default 0,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index if not exists suggestions_user_status_idx on orbit.suggestions (user_id, status);
create index if not exists suggestions_updated_idx on orbit.suggestions (user_id, updated_at);

-- what the student is told outside a card: the browser's notifications table, filled by the server too
create table if not exists orbit.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists notifications_updated_idx on orbit.notifications (user_id, updated_at);

alter table orbit.suggestions enable row level security;
alter table orbit.notifications enable row level security;

-- updated_at moves with every change, as on the other pulled tables
create trigger touch_updated_at before update on orbit.suggestions
  for each row execute function orbit.touch_updated_at();
create trigger touch_updated_at before update on orbit.notifications
  for each row execute function orbit.touch_updated_at();

-- users.settings gains one key (plan 29 §B2.7): the circuit breaker's pauses, one per goal
--   autopilot_paused_goals jsonb   { "<goalId>": { "reason": "Chloe asked to stop", "until": ISO | null, "at": ISO } }
-- nothing Orbit would send on its own for that goal goes out while the entry exists; the student lifts it
comment on column orbit.users.settings is
  'Per-user settings as one jsonb: auto_kinds, autopilot_mode, autopilot_paused_until, autopilot_paused_goals, daily_send_cap_gmail, daily_send_cap_linkedin, quiet_until, postal_address, scheduling_link, about, read_reply_tone, max_bumps (plan 29 §B3).';

-- the outcome roll (plan 29 §B2.5): once an hour, sent drafts with no reply after QUIET_DAYS are marked silent
create or replace function orbit.enqueue_outcomes()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  hour text := to_char(now() at time zone 'utc', 'YYYY-MM-DD-HH24');
begin
  if orbit.enqueue('orbit_cadence', jsonb_build_object(
    'kind', 'outcomes.roll', 'payload', '{}'::jsonb, 'dedupeKey', 'outcomes.roll:' || hour)) is not null then
    return 1;
  end if;
  return 0;
end
$$;
select cron.schedule('orbit-outcomes', '37 * * * *', $$select orbit.enqueue_outcomes()$$);
