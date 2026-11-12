-- Plan 43, Instagram on the server. Additive and re-runnable.
--
-- Instagram's limits are rolling windows per account (Unipile advises about 10 actions an hour and 100 a day), not a
-- day that resets at midnight, so each call is logged with its time and the next one is let through only while the
-- last hour and the last 24 hours have room:
--   social_call_log   one row per call made, per platform and account (Unipile's account id), kept two days
--   social_take       the counter: under a lock per account, counts both windows (and the caller's own day when it
--                     has a ceiling of its own), logs the call when it fits, and says when room opens when it does not.
--                     It also adds to orbit.social_calls, the daily made and refused counts.
-- Background work asks with 60 percent of each window and the student's own request with all of it, so a background
-- job never leaves the student's request without room (plan 43 §3.10).

create table if not exists orbit.social_call_log (
  id bigint generated always as identity primary key,
  platform text not null check (platform in ('instagram', 'x')),
  account text not null,
  kind text not null,
  caller text not null,
  at timestamptz not null default now()
);
create index if not exists social_call_log_account_idx on orbit.social_call_log (platform, account, at);

alter table orbit.social_call_log enable row level security;
revoke all on table orbit.social_call_log from public, anon, authenticated;
grant all on table orbit.social_call_log to service_role;

create or replace function orbit.social_take(
  p_platform text,
  p_account text,
  p_kind text,
  p_caller text,
  p_hour_limit integer,
  p_day_limit integer,
  p_units integer default 1,
  p_now timestamptz default now(),
  p_caller_day_limit integer default null
)
returns table (allowed boolean, retry_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_units integer := greatest(coalesce(p_units, 1), 1);
  v_hour integer;
  v_day integer;
  v_mine integer;
  v_retry timestamptz;
  v_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('orbit.social_take:' || p_platform || ':' || p_account));
  delete from orbit.social_call_log
   where platform = p_platform and account = p_account and at < p_now - interval '2 days';
  select count(*) filter (where at > p_now - interval '1 hour'),
         count(*),
         count(*) filter (where caller = p_caller)
    into v_hour, v_day, v_mine
    from orbit.social_call_log
   where platform = p_platform and account = p_account and at > p_now - interval '24 hours' and at <= p_now;
  if v_hour + v_units <= p_hour_limit and v_day + v_units <= p_day_limit
     and (p_caller_day_limit is null or v_mine + v_units <= p_caller_day_limit) then
    insert into orbit.social_call_log (platform, account, kind, caller, at)
    select p_platform, p_account, p_kind, p_caller, p_now from generate_series(1, v_units);
    perform orbit.social_calls_add(p_platform, p_account, p_kind, p_caller, v_units, 0, 0, 0);
    return query select true, null::timestamptz;
    return;
  end if;
  -- when enough of the oldest calls have left the window that is full
  v_retry := p_now;
  if v_hour + v_units > p_hour_limit then
    select l.at into v_at from orbit.social_call_log l
     where l.platform = p_platform and l.account = p_account and l.at > p_now - interval '1 hour' and l.at <= p_now
     order by l.at offset greatest(v_hour + v_units - p_hour_limit - 1, 0) limit 1;
    v_retry := greatest(v_retry, coalesce(v_at, p_now) + interval '1 hour');
  end if;
  if v_day + v_units > p_day_limit then
    select l.at into v_at from orbit.social_call_log l
     where l.platform = p_platform and l.account = p_account and l.at > p_now - interval '24 hours' and l.at <= p_now
     order by l.at offset greatest(v_day + v_units - p_day_limit - 1, 0) limit 1;
    v_retry := greatest(v_retry, coalesce(v_at, p_now) + interval '24 hours');
  end if;
  if p_caller_day_limit is not null and v_mine + v_units > p_caller_day_limit then
    select l.at into v_at from orbit.social_call_log l
     where l.platform = p_platform and l.account = p_account and l.caller = p_caller
       and l.at > p_now - interval '24 hours' and l.at <= p_now
     order by l.at offset greatest(v_mine + v_units - p_caller_day_limit - 1, 0) limit 1;
    v_retry := greatest(v_retry, coalesce(v_at, p_now) + interval '24 hours');
  end if;
  perform orbit.social_calls_add(p_platform, p_account, p_kind, p_caller, 0, 0, 1, 0);
  return query select false, v_retry;
end
$$;
revoke all on function orbit.social_take(text, text, text, text, integer, integer, integer, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function orbit.social_take(text, text, text, text, integer, integer, integer, timestamptz, integer)
  to service_role;
