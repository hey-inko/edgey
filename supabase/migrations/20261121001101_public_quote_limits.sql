alter table private.request_rate_limits drop constraint request_rate_limits_scope_check,
  add check (scope in ('enquiry', 'trial', 'trade', 'trade_sign_in', 'staff_sign_in', 'staff_mfa', 'finder', 'selection_quote'));

create or replace function public.consume_request_rate_limit(p_scope text, p_ip_key text, p_email_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  dimension_limit record;
  checked_at timestamptz := clock_timestamp();
begin
  if p_scope is null or p_scope not in ('enquiry', 'trial', 'trade', 'trade_sign_in', 'staff_sign_in', 'staff_mfa', 'finder', 'selection_quote')
    or p_ip_key is null or p_ip_key !~ '^[a-f0-9]{64}$'
    or p_email_key is null or p_email_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_request_rate_limit_input';
  end if;

  for dimension_limit in
    select * from (values
      (1, 'ip', p_ip_key, case p_scope
        when 'finder' then 120 when 'selection_quote' then 120 when 'trade_sign_in' then 20
        when 'staff_sign_in' then 60 when 'staff_mfa' then 60 else 10 end),
      (2, 'email', p_email_key, case p_scope
        when 'finder' then 10000 when 'selection_quote' then 10000 when 'trade_sign_in' then 5
        when 'staff_sign_in' then 10 when 'staff_mfa' then 10 else 3 end)
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
  'Consume two server-derived dimensions atomically in one-hour windows. Trade sign-in: 20/IP and 5/email; staff password and TOTP: independent 60/IP and 10/IP+email; intake: 10/IP and 3/email; Finder events and selection quotes: independent 120/IP and 10,000 globally.';

create function public.lookup_selection_quote(p_variant_ids uuid[], p_quantities integer[])
returns table (
  id uuid, sku text, option_label text, price_1_4_pence integer, price_5_9_pence integer,
  price_10_plus_pence integer, quote_limit integer, photo text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if cardinality(p_variant_ids) is null or cardinality(p_variant_ids) not between 1 and 100
    or cardinality(p_variant_ids) is distinct from cardinality(p_quantities)
    or array_position(p_variant_ids, null) is not null or array_position(p_quantities, null) is not null
    or exists (select 1 from unnest(p_quantities) as quantity where quantity <= 0) then
    raise exception using errcode = '22023', message = 'invalid_selection_quote';
  end if;

  return query
    select v.id, v.sku, v.option_label, v.price_1_4_pence, v.price_5_9_pence, v.price_10_plus_pence,
      greatest(case when requested.quantity <= stock.sellable then requested.quantity else 0 end,
        case when stock.sellable >= 10 then 10 when stock.sellable >= 5 then 5 when stock.sellable >= 1 then 1 else 0 end),
      p.media->>'photo'
    from unnest(p_variant_ids, p_quantities) as requested(variant_id, quantity)
    join public.variants v on v.id = requested.variant_id and v.publication_status = 'published'
    join public.products p on p.id = v.product_id
    cross join lateral (select v.stock_on_hand - v.stock_reserved as sellable) stock;
end;
$$;

revoke all on function public.lookup_selection_quote(uuid[], integer[]) from public, anon, authenticated, service_role;
grant execute on function public.lookup_selection_quote(uuid[], integer[]) to service_role;
