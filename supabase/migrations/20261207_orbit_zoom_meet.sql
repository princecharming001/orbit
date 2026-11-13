-- Zoom and Google Meet: notes from the call itself, and Zoom meetings for the calls Orbit books. Additive.
--
-- 1. integration_accounts takes two more providers:
--      zoom         the student's Zoom sign-in. token_secret_id holds the refresh token's Vault id (zoom_refresh:<user>),
--                   sync_state.zoom the access token's id (zoom_access:<user>) and expiry and the account's email,
--                   external_account_id the Zoom user id (how a Zoom webhook finds the student).
--      google_meet  Google Meet transcripts on or off. The permission itself (meetings.space.readonly) lives on the
--                   google row's scopes with the rest of the sign-in; this row only says the student turned it on.
--    Deleting an account already removes both: the rows go with the user, and orbit.delete_user deletes every Vault
--    secret named '<kind>:<user id>'.
-- 2. users.settings.meeting_link (meet, zoom or none; Google Meet when unset) needs no column: settings is jsonb.

alter table orbit.integration_accounts drop constraint if exists integration_accounts_provider_check;
alter table orbit.integration_accounts add constraint integration_accounts_provider_check
  check (provider in ('google', 'linkedin', 'village', 'instagram', 'x', 'zoom', 'google_meet'));
