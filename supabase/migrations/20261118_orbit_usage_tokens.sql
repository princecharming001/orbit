-- Plan 35 A5 and C2. Additive only.
--
-- A5: a Claude row in orbit.usage_ledger keeps the token split it was priced from (input, cache read, cache write,
-- output), so cache behaviour and the batch discount can be read from the ledger instead of guessed. Older rows and
-- rows of other providers leave them null. orbit_usage_add also takes Claude rows now: orbit-connectors reads job
-- postings with Haiku for visitors who are not signed in, and those calls were not recorded anywhere.
--
-- C2: requests Orbit sends through Anthropic's Message Batches (half price, answered within 24 hours) wait in
-- orbit.claude_batch_requests: queued until the next claude.batch.poll submits them together, submitted until the
-- batch ends, then done (the job that asked for it ran on the answer), expired (the batch's 24 hours ran out, so the
-- job ran synchronously instead) or failed. The poll is queued every 5 minutes, and only while a request is waiting.
--
-- C3: an address Orbit built or guessed for a sourced person (from a company's pattern, or a finder's unconfirmed
-- answer) is checked with a verifier before the first message goes to it, not during the search. orbit.people keeps
-- how the address was found (null: the student's own mail or contacts, never checked) and when it was checked.

alter table orbit.usage_ledger add column if not exists input_tokens bigint;
alter table orbit.usage_ledger add column if not exists cache_read_tokens bigint;
alter table orbit.usage_ledger add column if not exists cache_write_tokens bigint;
alter table orbit.usage_ledger add column if not exists output_tokens bigint;
comment on column orbit.usage_ledger.input_tokens is
  'Plan 35 A5: uncached input tokens of a Claude call (null for other providers and older rows).';
comment on column orbit.usage_ledger.cache_read_tokens is 'Plan 35 A5: input tokens read from the prompt cache.';
comment on column orbit.usage_ledger.cache_write_tokens is 'Plan 35 A5: input tokens written to the prompt cache.';
comment on column orbit.usage_ledger.output_tokens is 'Plan 35 A5: output tokens, thinking included.';

create or replace function public.orbit_usage_add(
  p_provider text,
  p_operation text,
  p_units numeric,
  p_cost_usd numeric,
  p_account_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider not in ('exa', 'village', 'anthropic') then
    raise exception 'orbit_usage_add: provider % is not recorded here', p_provider;
  end if;
  insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, account_id)
  values (null, p_provider, left(coalesce(p_operation, 'call'), 60), greatest(coalesce(p_units, 0), 0),
          greatest(coalesce(p_cost_usd, 0), 0), left(p_account_id, 64));
end;
$$;
revoke all on function public.orbit_usage_add(text, text, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.orbit_usage_add(text, text, numeric, numeric, text) to service_role;

create table if not exists orbit.claude_batch_requests (
  id uuid primary key default gen_random_uuid(),
  -- whose budget pays; null for system work
  user_id uuid references orbit.users(id) on delete cascade,
  -- the person the answer is about, when there is one (autopilot counts a waiting first message as written)
  person_id uuid,
  task text not null,
  model text not null,
  -- {system, user, maxTokens}: what a synchronous call sends when the batch cannot answer
  request jsonb not null,
  -- the Messages API parameters as submitted
  params jsonb not null,
  -- the job that runs on the answer (batchJobs.ts) and what it needs
  handler text not null,
  payload jsonb not null default '{}'::jsonb,
  -- at most one waiting request per key
  dedupe_key text,
  status text not null default 'queued'
    check (status in ('queued', 'submitted', 'done', 'expired', 'failed')),
  batch_id text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  expires_at timestamptz,
  finished_at timestamptz,
  error text
);
create unique index if not exists claude_batch_requests_dedupe_idx on orbit.claude_batch_requests (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'submitted');
create index if not exists claude_batch_requests_waiting_idx on orbit.claude_batch_requests (status, created_at)
  where status in ('queued', 'submitted');
create index if not exists claude_batch_requests_user_idx on orbit.claude_batch_requests (user_id, created_at desc);
alter table orbit.claude_batch_requests enable row level security;
revoke all on table orbit.claude_batch_requests from public, anon, authenticated;
grant all on table orbit.claude_batch_requests to service_role;
comment on table orbit.claude_batch_requests is
  'Plan 35 C2: Claude requests sent through Message Batches at half price; claude.batch.poll submits them, reads the answers and runs the job named in handler. orbit.delete_user takes them with the user (user_id cascade).';

create or replace function orbit.enqueue_claude_batch_poll()
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (select 1 from orbit.claude_batch_requests where status in ('queued', 'submitted')) then
    return null;
  end if;
  return orbit.enqueue('orbit_enrich', jsonb_build_object(
    'kind', 'claude.batch.poll', 'payload', '{}'::jsonb,
    'dedupeKey', 'claude.batch.poll:' || to_char(date_trunc('minute', now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI')));
end
$$;
revoke all on function orbit.enqueue_claude_batch_poll() from public, anon, authenticated;
grant execute on function orbit.enqueue_claude_batch_poll() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-claude-batch') then
    perform cron.unschedule('orbit-claude-batch');
  end if;
  perform cron.schedule('orbit-claude-batch', '*/5 * * * *', $cron$select orbit.enqueue_claude_batch_poll()$cron$);
end
$$;

alter table orbit.people add column if not exists email_confidence text
  check (email_confidence is null or email_confidence in ('verified', 'page', 'pattern', 'guess', 'invalid'));
alter table orbit.people add column if not exists email_checked_at timestamptz;
comment on column orbit.people.email_confidence is
  'Plan 35 C3: how primary_email was found for a sourced person (verified, page, pattern, guess; invalid once a verifier said so); null for addresses from the student''s own mail or contacts. pattern and guess are verified before a send.';
comment on column orbit.people.email_checked_at is 'Plan 35 C3: when a verifier last checked primary_email.';
