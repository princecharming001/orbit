-- Reply rapport (docs/plan/27-reply-warmth.md): how warm someone's replies read becomes f16 of the tie score. Readings
-- live in orbit.messages.extraction.rapport (no new column); the classify job writes them for new replies. This queues
-- one rapport.backfill per user who has connected an account, so a year of stored replies gets readings and everyone
-- is rescored under tie-v2.

select orbit.enqueue('orbit_classify', jsonb_build_object(
  'kind', 'rapport.backfill', 'userId', u.id, 'payload', '{}'::jsonb,
  'dedupeKey', 'rapport.backfill:v1:' || u.id))
  from orbit.users u
 where u.deleted_at is null
   and exists (select 1 from orbit.integration_accounts a
                where a.user_id = u.id and a.provider in ('google', 'linkedin') and a.status = 'active');
