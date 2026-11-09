-- Plan 34 D3, E1, E2: housekeeping, one view of what Orbit spends, and the daily cost digest.
--
-- D3  retention_purge also drops: pg_cron's run log after 7 days (85k rows, never purged), the usage ledger after 13
--     months, the Claude proxy's per-day spend rows after 90 days (the lifetime rows stay), health snapshots after 30
--     days (96 a day, kept two years), and the proxy's per-answer token rows after 90 days. An index lets the budget
--     check read one user's spend for one provider without scanning the ledger.
-- E1  orbit.v_spend_daily: every recorded dollar by UTC day, from the usage ledger, the chat proxy's day totals and
--     the research log, with the chat's token shape beside it. sum(usd) is the day's spend: the token rows carry
--     no dollars of their own (the proxy's day total already holds them).
-- E2  orbit-cost-digest at 07:50 UTC queues one cost.digest job; the worker writes an audit row and mails the owner
--     when a threshold is crossed.

create index if not exists usage_ledger_user_provider_idx
  on orbit.usage_ledger (user_id, provider, created_at desc);
-- the worker counts a message's paid failures (plan 34 A6) by queue and message id
create index if not exists job_runs_msg_error_idx on orbit.job_runs (queue, msg_id) where status = 'error';

create or replace function orbit.retention_purge()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  out jsonb := '{}'::jsonb;
  n bigint;
  r record;
begin
  -- accounts marked deleted are hard-deleted within 24 hours
  n := 0;
  for r in select id from orbit.users where deleted_at is not null and deleted_at < now() - interval '24 hours' loop
    perform orbit.delete_user(r.id);
    n := n + 1;
  end loop;
  out := out || jsonb_build_object('users', n);

  -- message bodies (and the embedding derived from them) after the user's setting: 6, 12 or 24 months
  update orbit.messages m
     set body_text = null, embedding = null
    from orbit.users u
   where m.user_id = u.id
     and (m.body_text is not null or m.embedding is not null)
     and m.sent_at < now() - make_interval(months => case
           when u.settings->>'body_retention_months' in ('6', '12', '24') then (u.settings->>'body_retention_months')::int
           else 24 end);
  get diagnostics n = row_count;
  out := out || jsonb_build_object('message_bodies', n);

  delete from orbit.dossiers where expires_at < now() or created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('dossiers', n);

  delete from orbit.research_cache where expires_at < now() or created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('research_cache', n);

  -- health snapshots are a running log: a month is enough
  delete from orbit.audit_log where action = 'health.snapshot' and created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('health_snapshots', n);

  delete from orbit.audit_log where created_at < now() - interval '2 years';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('audit_log', n);

  delete from orbit.job_runs where started_at < now() - interval '30 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('job_runs', n);

  delete from orbit.dead_letters where created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('dead_letters', n);

  delete from orbit.usage_ledger where created_at < now() - interval '13 months';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('usage_ledger', n);

  -- the proxy's per-day rows (subject ending in a date); lifetime rows have no date and stay
  delete from public.orbit_proxy_spend
   where subject ~ ':\d{4}-\d{2}-\d{2}$' and updated_at < now() - interval '90 days';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('proxy_spend_days', n);

  if to_regclass('orbit_private.claude_usage') is not null then
    execute 'delete from orbit_private.claude_usage where at < now() - interval ''90 days''';
    get diagnostics n = row_count;
    out := out || jsonb_build_object('claude_usage', n);
  end if;

  -- pg_cron's own run log (two every-minute ticks write to it)
  if to_regclass('cron.job_run_details') is not null then
    execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
    get diagnostics n = row_count;
    out := out || jsonb_build_object('cron_run_details', n);
  end if;

  -- housekeeping for short-lived auth rows and webhook ids
  delete from orbit.oauth_states where expires_at < now() - interval '1 day';
  delete from orbit.login_codes where expires_at < now() - interval '1 day';
  delete from orbit.sessions where expires_at < now() - interval '1 day'
     or (revoked_at is not null and revoked_at < now() - interval '1 day');
  delete from orbit.webhook_events where received_at < now() - interval '30 days';

  return out;
end
$$;
revoke all on function orbit.retention_purge() from public, anon, authenticated;

create or replace view orbit.v_spend_daily as
  select (l.created_at at time zone 'utc')::date as day, 'ledger'::text as source, l.provider, l.operation,
         l.user_id::text as subject, count(*)::bigint as calls, sum(l.units)::numeric as units,
         sum(l.cost_usd)::numeric as usd,
         null::bigint as input_tokens, null::bigint as cache_read_tokens, null::bigint as cache_write_tokens,
         null::bigint as output_tokens, null::bigint as web_searches
    from orbit.usage_ledger l
   group by 1, 2, 3, 4, 5
  union all
  -- the chat's day total for everyone: global:<day>, one row a day, so nothing is counted twice
  select substring(s.subject from 'global:(\d{4}-\d{2}-\d{2})$')::date, 'proxy', 'anthropic', 'chat', null,
         s.requests::bigint, null, s.usd::numeric, null, null, null, null, null
    from public.orbit_proxy_spend s
   where s.subject ~ '^global:\d{4}-\d{2}-\d{2}$'
  union all
  select (r.created_at at time zone 'utc')::date, 'research', 'anthropic', 'research', null, count(*)::bigint, null,
         sum(r.cost_usd)::numeric, null, null, null, null, null
    from public.orbit_research_runs r
   group by 1
  union all
  -- the chat's token shape; its dollars are already in the proxy rows above
  select (c.at at time zone 'utc')::date, 'claude_usage', 'anthropic', c.call, null, count(*)::bigint, null, null,
         sum(c.input)::bigint, sum(c.cache_read)::bigint, sum(c.cache_write)::bigint, sum(c.output)::bigint,
         sum(c.web_searches)::bigint
    from orbit_private.claude_usage c
   group by 1, 4;
revoke all on orbit.v_spend_daily from public, anon, authenticated;
comment on view orbit.v_spend_daily is 'Orbit spend by UTC day across the usage ledger, the chat proxy and research (plan 34 E1). sum(usd) is the total.';

create or replace function orbit.enqueue_cost_digest()
returns bigint
language sql
security definer
set search_path to ''
as $$
  select orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'cost.digest', 'payload', '{}'::jsonb,
    'dedupeKey', 'cost.digest:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')))
$$;
revoke all on function orbit.enqueue_cost_digest() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-cost-digest') then
    perform cron.unschedule('orbit-cost-digest');
  end if;
  perform cron.schedule('orbit-cost-digest', '50 7 * * *', $cron$select orbit.enqueue_cost_digest()$cron$);
end
$$;
