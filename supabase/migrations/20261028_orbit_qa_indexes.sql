-- QA audit 2026-10-28 (docs/qa-audit-2026-10-28.md): indexes for reads that ran on every poll or under a lock.
-- Additive only; every table here is small enough today to index inside the migration.

-- /sync/status counts a user's pending jobs on every queue every few seconds, and orbit.enqueue checks a dedupe key
-- under an advisory lock: both read the message JSON, which no index served
do $$
declare q text;
begin
  foreach q in array array['orbit_send', 'orbit_classify', 'orbit_sync', 'orbit_cadence', 'orbit_score', 'orbit_enrich']
  loop
    if to_regclass(format('pgmq.q_%s', q)) is not null then
      execute format('create index if not exists %I on pgmq.%I ((message->>''userId''))', 'q_' || q || '_user_idx', 'q_' || q);
      execute format('create index if not exists %I on pgmq.%I ((message->>''dedupeKey''))', 'q_' || q || '_dedupe_idx', 'q_' || q);
    end if;
  end loop;
end $$;

-- the rate-limit store sweeps expired counters on one call in fifty
create index if not exists orbit_proxy_counters_expires_idx on public.orbit_proxy_counters (expires_at);

-- /sync/pull reads a user's hard deletes by id
create index if not exists audit_log_sync_delete_idx on orbit.audit_log (user_id, id) where action = 'sync.delete';

-- foreign keys to people that a delete or merge of a person checks, and joins by person
create index if not exists ties_a_person_idx on orbit.ties (a_person_id);
create index if not exists ties_b_person_idx on orbit.ties (b_person_id);
create index if not exists tie_scores_person_idx on orbit.tie_scores (person_id);
create index if not exists tie_labels_person_idx on orbit.tie_labels (person_id);
create index if not exists people_merged_into_idx on orbit.people (merged_into) where merged_into is not null;
create index if not exists people_org_idx on orbit.people (org_id) where org_id is not null;
create index if not exists recommendations_person_idx on orbit.recommendations (person_id);
create index if not exists dossiers_person_idx on orbit.dossiers (person_id);
create index if not exists memories_person_idx on orbit.memories (person_id) where person_id is not null;
create index if not exists messages_from_person_idx on orbit.messages (from_person_id) where from_person_id is not null;
create index if not exists merge_suggestions_a_idx on orbit.merge_suggestions (person_a);
create index if not exists merge_suggestions_b_idx on orbit.merge_suggestions (person_b);
create index if not exists intro_requests_target_idx on orbit.intro_requests (target_person_id);
create index if not exists intro_requests_introducer_idx on orbit.intro_requests (introducer_person_id);
create index if not exists drafts_chat_idx on orbit.drafts (chat_id) where chat_id is not null;
create index if not exists notes_chat_idx on orbit.notes (chat_id) where chat_id is not null;
