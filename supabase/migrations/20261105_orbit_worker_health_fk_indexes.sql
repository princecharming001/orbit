-- 2026-11-05: covering indexes for the orbit foreign keys the linter flagged, a partial index for the worker's orphan
-- sweep, and two more health() signals: runs that died with their isolate, and how old the newest tie scores are.
create index if not exists people_org_fk_idx on orbit.people (org_id);
create index if not exists affiliations_org_fk_idx on orbit.affiliations (org_id);
create index if not exists recommendations_goal_fk_idx on orbit.recommendations (goal_id);
create index if not exists oauth_states_user_fk_idx on orbit.oauth_states (user_id);
create index if not exists drafts_goal_fk_idx on orbit.drafts (goal_id);
create index if not exists chats_goal_fk_idx on orbit.chats (goal_id);
create index if not exists chats_org_fk_idx on orbit.chats (org_id);
create index if not exists suggestions_message_fk_idx on orbit.suggestions (message_id);
create index if not exists suggestions_person_fk_idx on orbit.suggestions (person_id);
create index if not exists suggestions_draft_fk_idx on orbit.suggestions (draft_id);
create index if not exists suggestions_chat_fk_idx on orbit.suggestions (chat_id);
create index if not exists intro_requests_goal_fk_idx on orbit.intro_requests (goal_id);
create index if not exists blocked_pairs_a_fk_idx on orbit.blocked_pairs (a_person_id);
create index if not exists blocked_pairs_b_fk_idx on orbit.blocked_pairs (b_person_id);
create index if not exists friend_intro_asks_friendship_fk_idx on orbit.friend_intro_asks (friendship_id);
create index if not exists friend_shares_person_fk_idx on orbit.friend_shares (person_id);
create index if not exists dossiers_goal_fk_idx on orbit.dossiers (goal_id);
create index if not exists job_runs_running_idx on orbit.job_runs (started_at) where status = 'running';

create or replace function orbit.health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'dead_letters_24h', (select count(*) from orbit.dead_letters where created_at > now() - interval '24 hours'),
    'job_errors_24h', (select count(*) from orbit.job_runs where status = 'error' and started_at > now() - interval '24 hours'),
    -- runs still 'running' long after they started: the isolate died under them (a CPU or memory limit)
    'orphaned_runs', (select count(*) from orbit.job_runs where status = 'running' and started_at < now() - interval '10 minutes'),
    -- hours since the stalest user's newest tie score: the nightly rebuild is late when this passes 36
    'scores_oldest_hours', (select coalesce(max(extract(epoch from now() - last) / 3600), 0)::int
                              from (select max(computed_at) as last from orbit.tie_scores group by user_id) x),
    'queues', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'queue', d.queue, 'depth', d.depth, 'visible', d.visible, 'oldest_age_sec', d.oldest_age_sec) order by d.priority), '[]'::jsonb)
      from orbit.queue_depth() d
    ),
    'needs_reauth', (select count(*) from orbit.integration_accounts where status = 'needs_reauth'),
    -- a Gmail backfill whose phase is not 'complete' and whose account row has not moved for an hour
    'stuck_backfills', (
      select count(*) from orbit.integration_accounts
      where provider = 'google'
        and sync_state #>> '{gmail,backfill,phase}' is not null
        and sync_state #>> '{gmail,backfill,phase}' <> 'complete'
        and updated_at < now() - interval '1 hour'
    )
  )
$$;
