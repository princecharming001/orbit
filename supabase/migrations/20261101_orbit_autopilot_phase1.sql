-- Autopilot, phase 1 (docs/plan/29-friends-and-autopilot.md §B3, §C1): one send system. The server's drafts gain
-- the evening review window (a send waits at least until review_until), the rung of the ladder that sent one on its
-- own, and how it ended. The settings keys the browser now keeps in step with the server are written down here.

alter table orbit.drafts add column if not exists review_until timestamptz;
alter table orbit.drafts add column if not exists auto_rung text;
alter table orbit.drafts add column if not exists outcome text
  check (outcome is null or outcome in ('replied', 'booked', 'declined', 'silent'));

comment on column orbit.drafts.review_until is
  'Plan 29 §B2.2: the send job does not send before this; an autopilot first message waits here for the evening review.';
comment on column orbit.drafts.auto_rung is
  'Plan 29 §B3: which rung of the trust ladder approved it on Orbit''s own (bump, thank_you, schedule, later first_touch); null for a tap.';
comment on column orbit.drafts.outcome is
  'Plan 29 §B2.5: how it ended, set by the classifier and the booking: replied, booked, declined or silent.';

-- users.settings is one jsonb. The keys the browser and the server share (plan 29 §B2.1):
--   auto_kinds text[]              the ladder's kinds the student handed to Orbit (bump, thank_you, schedule)
--   autopilot_mode text            off | assist | autopilot; users.autonomy_level is set to 0, 1 or 2 with it
--   autopilot_paused_until text    ISO; nothing Orbit chose a time for is sent before then
--   daily_send_cap_gmail int       the student's own daily limits, when lower than the cap table in core
--   daily_send_cap_linkedin int
--   quiet_until text               ISO; nothing is drafted until then (the same pause sets both)
--   postal_address, scheduling_link, about, read_reply_tone, max_bumps   as before
comment on column orbit.users.settings is
  'Per-user settings as one jsonb: auto_kinds, autopilot_mode, autopilot_paused_until, daily_send_cap_gmail, daily_send_cap_linkedin, quiet_until, postal_address, scheduling_link, about, read_reply_tone, max_bumps (plan 29 §B3).';
