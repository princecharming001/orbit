-- The monthly Claude allowance (pricing: $49 a month with $10 of Claude per student, chat and server work together).
-- orbit-claude charges a signed-in student's chat to `user:<uuid>:m:<YYYY-MM>` as well as the day, and refuses once the
-- month's total reaches ORBIT_USER_MONTHLY_USD ($10). The total it reads, orbit_spend_total of that subject, is the chat's
-- month plus the server's Claude spend that month from orbit.usage_ledger, so the two share one allowance. Additive: the
-- function keeps its two existing answers (any subject, and the lifetime `user:<uuid>`).

create or replace function public.orbit_spend_total(p_subject text)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  total numeric := coalesce((select usd from public.orbit_proxy_spend where subject = p_subject), 0);
  uid uuid;
  m timestamptz;
begin
  if to_regclass('orbit.usage_ledger') is null then
    return total;
  end if;
  if p_subject ~ '^user:[0-9a-fA-F-]{36}$' then
    uid := substr(p_subject, 6)::uuid;
    total := total + coalesce((select sum(cost_usd) from orbit.usage_ledger where user_id = uid), 0);
  elsif p_subject ~ '^user:[0-9a-fA-F-]{36}:m:[0-9]{4}-[0-9]{2}$' then
    uid := substr(p_subject, 6, 36)::uuid;
    m := (right(p_subject, 7) || '-01')::date::timestamp at time zone 'UTC';
    total := total + coalesce((
      select sum(cost_usd) from orbit.usage_ledger
       where user_id = uid and provider = 'anthropic' and created_at >= m and created_at < m + interval '1 month'
    ), 0);
  end if;
  return total;
end;
$$;

revoke all on function public.orbit_spend_total(text) from public, anon, authenticated;
grant execute on function public.orbit_spend_total(text) to service_role;

-- This month's chat so far, from the day rows the proxy has written for signed-in students since they were charged to
-- their account (plan 34 A3), so the allowance starts from what was already used.
insert into public.orbit_proxy_spend (subject, usd, requests)
select regexp_replace(subject, '^(user:[0-9a-fA-F-]{36}):([0-9]{4}-[0-9]{2})-[0-9]{2}$', '\1:m:\2'),
       sum(usd), sum(requests)::int
  from public.orbit_proxy_spend
 where subject ~ '^user:[0-9a-fA-F-]{36}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   and substr(subject, 43, 7) = to_char(now() at time zone 'UTC', 'YYYY-MM')
 group by 1
on conflict (subject) do nothing;
