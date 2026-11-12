-- Plan 43: what the browser needs on an attached account, additive only.
--
-- Whether someone accepts X messages from the student is X's answer to that student (`receives_your_dm` on a profile
-- read with the student's own token), so it is kept on the student's link to the account, not on the shared
-- orbit.social_accounts row: another student reading the same profile can get a different answer. It is reported to
-- the browser for 30 days after the read (X's keep rule), then read as unknown until the next profile read.
alter table orbit.social_links add column if not exists accepts_dms boolean;
alter table orbit.social_links add column if not exists accepts_dms_at timestamptz;

-- What the pull reads beside a link (the handle, whether they follow the student back) lives in other tables, and
-- touch_updated_at keeps updated_at when no column of the link changed. This stamp is set when the student's own lists
-- were read to the end, so the link changes and the browser is sent it again. Never sent to the browser.
alter table orbit.social_links add column if not exists refreshed_at timestamptz;
