-- The automated LinkedIn warm-up (20261212_orbit_warmup_auto.sql) also stops when the student sends the person a
-- LinkedIn connection request from Orbit (Connect from a people search, 20261214_orbit_source_connect.sql), since
-- the warm-up started. The warm-up itself never sends one. orbit.warmup_stop_reason is the 20261212 function with
-- that one case added; it lives here because orbit.linkedin_connects is made after 20261212. Additive only.

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
    -- the student sent them a connection request from Orbit (Connect, 20261214_orbit_source_connect.sql) since the
    -- warm-up started: a request that may have gone ('unconfirmed') counts, one still on its way does not yet
    when exists (
      select 1 from orbit.linkedin_connects lc
       where lc.user_id = w.user_id and lc.person_id = w.person_id and lc.status in ('sent', 'unconfirmed')
         and coalesce(lc.sent_at, lc.created_at) > w.started_at) then 'connect_sent'
    -- the browser's pipeline says the same things when it knows first (a reply it read, a send marked by hand). Only
    -- a card that entered its stage after the warm-up started counts: an old card for the same person (one that went
    -- quiet last year) says nothing about this warm-up.
    when exists (
      select 1 from orbit.chats c
       where c.user_id = w.user_id and c.person_id = w.person_id and c.archived_at is null
         and c.stage_entered_at > w.started_at
         and c.stage in ('replied', 'scheduling', 'scheduled', 'completed', 'followed_up', 'nurturing')) then 'replied'
    when exists (
      select 1 from orbit.chats c
       where c.user_id = w.user_id and c.person_id = w.person_id and c.archived_at is null
         and c.stage_entered_at > w.started_at
         and c.stage in ('outreach_sent', 'no_response', 'declined')) then 'messaged'
    -- the student took the card out of Warming up by hand (back to To contact, or archived): that is a Stop
    when exists (
      select 1 from orbit.chats c
       where c.user_id = w.user_id and c.person_id = w.person_id
         and ((c.stage in ('identified', 'archived') and c.stage_entered_at > w.started_at)
              or c.archived_at > w.started_at)) then 'cancelled'
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
