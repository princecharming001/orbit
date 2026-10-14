-- Orbit's self-generated secrets (docs/plan/16 §21): created in SQL with random bytes, so no value passes through a person or
-- a tool. Functions read the environment variable first and fall back to orbit.secret('<name>'). The functions URL is
-- project-specific: on a new project (H1) replace the ref below before running.

create or replace function orbit.secret(p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = p_name $$;
revoke all on function orbit.secret(text) from public, anon, authenticated;
grant execute on function orbit.secret(text) to service_role;

do $$
declare n text;
begin
  if not exists (select 1 from vault.secrets where name = 'orbit_functions_url') then
    perform vault.create_secret('https://nxibeiykcgxpbmkeadth.supabase.co/functions/v1', 'orbit_functions_url');
  end if;
  foreach n in array array['orbit_cron_secret','orbit_session_secret','orbit_pubsub_token','orbit_unipile_webhook_secret'] loop
    if not exists (select 1 from vault.secrets where name = n) then
      perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), n);
    end if;
  end loop;
end $$;
