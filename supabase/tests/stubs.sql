-- Stand-ins for the Supabase-managed pieces PGlite does not have: the API roles, the `extensions` schema, and the
-- pgmq, vault, cron and net schemas. Only what Orbit's migrations and functions call, with the same names,
-- signatures and table shapes (pgmq keeps one q_<name> and one a_<name> table per queue, as the real extension does).
-- The test harness strips `create extension if not exists pgmq|pg_cron|pg_net` from the migrations and runs this first.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end
$$;

create schema if not exists extensions;
set search_path = "$user", public, extensions;

-- ---- pgmq ---------------------------------------------------------------------------------------------------------

create schema if not exists pgmq;
create type pgmq.message_record as (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb);
create table pgmq.meta (queue_name text primary key, created_at timestamptz not null default now());

create function pgmq."create"(queue_name text) returns void language plpgsql as $$
begin
  execute format('create table if not exists pgmq.%I (msg_id bigint generated always as identity primary key, '
    'read_ct integer not null default 0, enqueued_at timestamptz not null default now(), '
    'vt timestamptz not null default now(), message jsonb)', 'q_' || queue_name);
  execute format('create table if not exists pgmq.%I (msg_id bigint primary key, read_ct integer not null default 0, '
    'enqueued_at timestamptz not null, archived_at timestamptz not null default now(), vt timestamptz not null, '
    'message jsonb)', 'a_' || queue_name);
  insert into pgmq.meta (queue_name) values (queue_name) on conflict do nothing;
end
$$;

create function pgmq.send(queue_name text, msg jsonb, delay integer default 0) returns setof bigint language plpgsql as $$
begin
  return query execute format(
    'insert into pgmq.%I (vt, message) values (clock_timestamp() + make_interval(secs => $2), $1) returning msg_id',
    'q_' || queue_name) using msg, delay;
end
$$;

create function pgmq.read(queue_name text, vt integer, qty integer) returns setof pgmq.message_record language plpgsql as $$
begin
  return query execute format(
    'with c as (select msg_id from pgmq.%1$I where vt <= clock_timestamp() order by msg_id limit $2 for update skip locked) '
    'update pgmq.%1$I m set vt = clock_timestamp() + make_interval(secs => $1), read_ct = m.read_ct + 1 '
    'from c where m.msg_id = c.msg_id returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message',
    'q_' || queue_name) using vt, qty;
end
$$;

create function pgmq.delete(queue_name text, msg_id bigint) returns boolean language plpgsql as $$
declare n int;
begin
  execute format('delete from pgmq.%I where msg_id = $1', 'q_' || queue_name) using msg_id;
  get diagnostics n = row_count;
  return n > 0;
end
$$;

create function pgmq.archive(queue_name text, msg_id bigint) returns boolean language plpgsql as $$
declare n int;
begin
  execute format('with d as (delete from pgmq.%I where msg_id = $1 returning msg_id, read_ct, enqueued_at, vt, message) '
    'insert into pgmq.%I (msg_id, read_ct, enqueued_at, vt, message) select * from d',
    'q_' || queue_name, 'a_' || queue_name) using msg_id;
  get diagnostics n = row_count;
  return n > 0;
end
$$;

create function pgmq.set_vt(queue_name text, msg_id bigint, vt integer) returns setof pgmq.message_record language plpgsql as $$
begin
  return query execute format(
    'update pgmq.%I set vt = clock_timestamp() + make_interval(secs => $2) where msg_id = $1 '
    'returning msg_id, read_ct, enqueued_at, vt, message', 'q_' || queue_name) using msg_id, vt;
end
$$;

-- ---- vault --------------------------------------------------------------------------------------------------------

create schema if not exists vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at
    from vault.secrets;

create function vault.create_secret(new_secret text, new_name text default null, new_description text default '',
  new_key_id uuid default null) returns uuid language sql as $$
  insert into vault.secrets (secret, name, description, key_id) values (new_secret, new_name, new_description, new_key_id)
  returning id
$$;

create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null) returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
    description = coalesce(new_description, description), key_id = coalesce(new_key_id, key_id), updated_at = now()
  where id = secret_id
$$;

-- ---- pg_cron ------------------------------------------------------------------------------------------------------

create schema if not exists cron;
create table cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  jobname text unique,
  active boolean not null default true
);

create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;

create function cron.unschedule(job_id bigint) returns boolean language plpgsql as $$
declare n int;
begin
  delete from cron.job where jobid = job_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'could not find valid entry for job %', job_id; end if;
  return true;
end
$$;

create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
declare n int;
begin
  delete from cron.job where jobname = job_name;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'could not find valid entry for job %', job_name; end if;
  return true;
end
$$;

-- ---- pg_net -------------------------------------------------------------------------------------------------------

create schema if not exists net;
create table net.http_request_queue (
  id bigint generated always as identity primary key,
  method text not null,
  url text not null,
  headers jsonb,
  body jsonb,
  timeout_milliseconds integer
);

create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds) returning id
$$;
