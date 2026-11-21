alter table private.payment_rate_limits
  drop constraint payment_rate_limits_scope_check,
  add constraint payment_rate_limits_scope_check check (scope in ('checkout', 'checkout_review', 'checkout_close', 'request_receipt'));

create or replace function public.consume_checkout_rate_limit(p_scope text, p_ip_key text, p_email_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  dimension_limit record;
  checked_at timestamptz := clock_timestamp();
begin
  if p_scope is null or p_scope not in ('checkout', 'checkout_review', 'checkout_close')
    or p_ip_key is null or p_ip_key !~ '^[a-f0-9]{64}$'
    or p_email_key is null or p_email_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_checkout_rate_limit_input';
  end if;

  for dimension_limit in
    select * from (values
      (1, 'ip', p_ip_key, case p_scope when 'checkout_review' then 60 else 10 end),
      (2, 'email', p_email_key, case p_scope when 'checkout_review' then 30 else 3 end)
    ) as limits(lock_order, dimension, key, quota) order by lock_order
  loop
    insert into private.payment_rate_limits as counter (scope, dimension, key, attempts, expires_at)
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

alter function private.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid)
  rename to create_order_reservation;

create function private.create_order_with_reservations(
  p_attempt_token uuid, p_lines jsonb, p_contact jsonb, p_address jsonb, p_totals jsonb,
  p_hold_expires_at timestamptz, p_delivery_service text, p_dispatch_date date, p_delivery_date date,
  p_buyer_id uuid default null
) returns public.orders
language plpgsql set search_path = ''
as $$
declare
  is_new boolean;
  result public.orders;
begin
  if p_attempt_token is not null and (p_totals ? 'checkout_ip_key' or p_totals ? 'checkout_email_key') then
    perform pg_advisory_xact_lock(hashtextextended('order-attempt:' || p_attempt_token, 0));
    is_new := not exists (select 1 from public.orders where checkout_attempt_token = p_attempt_token);
  end if;
  result := private.create_order_reservation(p_attempt_token, p_lines, p_contact, p_address, p_totals,
    p_hold_expires_at, p_delivery_service, p_dispatch_date, p_delivery_date, p_buyer_id);
  if is_new then
    if not public.consume_checkout_rate_limit('checkout', p_totals->>'checkout_ip_key', p_totals->>'checkout_email_key') then
      raise sqlstate 'P0901' using message = 'checkout_reservation_rate_limit_exceeded';
    end if;
  end if;
  return result;
end;
$$;
revoke all on function private.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid)
  from public, anon, authenticated, service_role;
