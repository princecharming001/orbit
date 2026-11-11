-- Plan 40: tell the student when Orbit is ready.
--
-- orbit.user_notify keeps, per student, the phone number they gave (E.164, with the country it was typed for), which
-- ways they want to hear that the first import is done (email on by default, a text when they gave a number), when
-- readiness was first reached (ready_at) and when "Orbit is ready" went out (notified_at, with the channels used).
--
-- orbit-notify reads and writes it: POST /notify/contact (the student's own row), POST /notify/status (readiness and
-- the row), and POST /notify/sweep, which the cron below calls every two minutes while someone is still waiting: a
-- student who signed up in the last 7 days, with a source connected, who has not been told yet.
--
-- Additive only: a new table, one function, one cron entry.

create table if not exists orbit.user_notify (
  user_id uuid primary key references orbit.users(id) on delete cascade,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_country text check (phone_country is null or phone_country ~ '^[A-Z]{2}$'),
  email_on boolean not null default true,
  sms_on boolean not null default false,
  -- the first time every step of the first import was done
  ready_at timestamptz,
  -- when "Orbit is ready" went out, and how (["email"], ["email","sms"])
  notified_at timestamptz,
  notified_via text[] not null default '{}',
  -- the last failure sending it (a provider's status, never the message), for the owner's health checks
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table orbit.user_notify is
  'Orbit plan 40: the phone number a student gave and whether "Orbit is ready" went out. Service role only.';

alter table orbit.user_notify enable row level security;
revoke all on table orbit.user_notify from public, anon, authenticated;
grant all on table orbit.user_notify to service_role;

-- someone still waiting: signed up in the last week, not told yet (the sweep reads these first)
create index if not exists user_notify_waiting_idx on orbit.user_notify (created_at) where notified_at is null;

-- The sweep: called only when someone signed up in the last 7 days has not been told yet, so an idle system makes no
-- calls at all.
create or replace function orbit.cron_call_notify()
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
declare
  base text;
  secret text;
  waiting boolean;
begin
  select exists (
    select 1 from orbit.users u
     where u.deleted_at is null and u.created_at > now() - interval '7 days'
       and not exists (select 1 from orbit.user_notify n where n.user_id = u.id and n.notified_at is not null)
       and exists (select 1 from orbit.integration_accounts a
                    where a.user_id = u.id and a.status in ('active', 'needs_reauth', 'error')
                      and a.provider in ('google', 'linkedin'))
  ) into waiting;
  if not waiting then
    return null;
  end if;
  select decrypted_secret into base from vault.decrypted_secrets where name = 'orbit_functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'orbit_cron_secret';
  if coalesce(base, '') = '' or coalesce(secret, '') = '' then
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/orbit-notify/notify/sweep',
    body := jsonb_build_object('tick', now()),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-orbit-cron', secret),
    timeout_milliseconds := 10000
  );
end
$$;
revoke all on function orbit.cron_call_notify() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-notify-ready') then
    perform cron.unschedule('orbit-notify-ready');
  end if;
  perform cron.schedule('orbit-notify-ready', '*/2 * * * *', $cron$select orbit.cron_call_notify()$cron$);
end
$$;
