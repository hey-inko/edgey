alter table private.request_rate_limits drop constraint request_rate_limits_scope_check,
  add check (scope in ('enquiry', 'trial', 'trade', 'trade_sign_in', 'staff_sign_in', 'finder'));

create or replace function public.consume_request_rate_limit(p_scope text, p_ip_key text, p_email_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  dimension_limit record;
  checked_at timestamptz := clock_timestamp();
begin
  if p_scope is null or p_scope not in ('enquiry', 'trial', 'trade', 'trade_sign_in', 'staff_sign_in', 'finder')
    or p_ip_key is null or p_ip_key !~ '^[a-f0-9]{64}$'
    or p_email_key is null or p_email_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_request_rate_limit_input';
  end if;

  for dimension_limit in
    select * from (values
      (1, 'ip', p_ip_key, case p_scope when 'finder' then 120 when 'trade_sign_in' then 20 when 'staff_sign_in' then 60 else 10 end),
      (2, 'email', p_email_key, case p_scope when 'finder' then 10000 when 'trade_sign_in' then 5 when 'staff_sign_in' then 10 else 3 end)
    ) as limits(lock_order, dimension, key, quota) order by lock_order
  loop
    insert into private.request_rate_limits as counter (scope, dimension, key, attempts, expires_at)
    values (p_scope, dimension_limit.dimension, dimension_limit.key, 1, checked_at + interval '1 hour')
    on conflict (scope, dimension, key) do update set
      attempts = case when counter.expires_at <= checked_at then 1 else counter.attempts + 1 end,
      expires_at = case when counter.expires_at <= checked_at then excluded.expires_at else counter.expires_at end
    where counter.expires_at <= checked_at or counter.attempts < dimension_limit.quota;
    if not found then
      raise sqlstate 'P0901' using message = 'request_rate_limit_exceeded';
    end if;
  end loop;
  return true;
exception when sqlstate 'P0901' then
  return false;
end;
$$;

comment on function public.consume_request_rate_limit(text, text, text) is
  'Consume two server-derived dimensions atomically in one-hour windows. Trade sign-in allows 20/IP and 5/email; staff sign-in allows 60/IP and 10/IP+email; intake forms allow 10/IP and 3/email; Finder allows 120/IP and 10,000 globally.';
