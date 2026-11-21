create function public.reserve_order_with_delivery(
  p_attempt_token uuid, p_lines jsonb, p_contact jsonb, p_address jsonb, p_totals jsonb,
  p_hold_expires_at timestamptz, p_delivery_service text, p_dispatch_date date, p_delivery_date date,
  p_delivery_terms jsonb, p_payment_method public.order_payment_method,
  p_buyer_id uuid default null, p_po_number text default null
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  target public.orders;
  matched_terms jsonb;
  postcode text;
  existing_order boolean;
begin
  if p_attempt_token is null then
    raise exception using errcode = '22023', message = 'checkout_attempt_token_required';
  end if;
  if p_payment_method is null
    or (p_payment_method = 'card' and p_po_number is not null)
    or (p_payment_method = 'net30' and (p_buyer_id is null or nullif(btrim(p_po_number), '') is null)) then
    raise exception using errcode = '22023', message = 'invalid_reservation_payment_method';
  end if;
  if jsonb_typeof(p_delivery_terms) is distinct from 'object'
    or p_delivery_terms->'version' is distinct from '1'::jsonb then
    raise exception using errcode = '22023', message = 'invalid_delivery_terms';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order-attempt:' || p_attempt_token, 0));
  existing_order := exists (select 1 from public.orders where checkout_attempt_token = p_attempt_token);
  if not existing_order then
    postcode := upper(regexp_replace(p_address->>'postcode', '[[:space:]]', '', 'g'));
    postcode := left(postcode, -3) || ' ' || right(postcode, 3);
    matched_terms := private.resolve_delivery_terms(postcode);
    if matched_terms is null or matched_terms is distinct from p_delivery_terms
      or p_delivery_service is distinct from matched_terms->'quote'->>'serviceName'
      or (p_totals->>'delivery_net_pence')::integer is distinct from (case
        when matched_terms->'quote'->>'kind' = 'next-working-day' and (p_totals->>'goods_net_pence')::integer >= 15000
          then 0
        else (matched_terms->'quote'->>'chargeExVatPence')::integer
      end) then
      raise exception using errcode = '22023', message = 'delivery_terms_changed';
    end if;
  end if;

  if p_payment_method = 'card' then
    target := public.create_order_with_reservations(p_attempt_token, p_lines, p_contact, p_address, p_totals,
      p_hold_expires_at, p_delivery_service, p_dispatch_date, p_delivery_date, p_buyer_id);
  else
    target := public.create_net30_order_with_holds(p_attempt_token, p_lines, p_contact, p_address, p_totals,
      p_hold_expires_at, p_delivery_service, p_dispatch_date, p_delivery_date, p_buyer_id, p_po_number);
  end if;
  if not existing_order then
    update public.orders set delivery_terms = matched_terms where id = target.id returning * into target;
  end if;
  return target;
end;
$$;

revoke all on function public.reserve_order_with_delivery(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, date, jsonb, public.order_payment_method, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_order_with_delivery(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, date, jsonb, public.order_payment_method, uuid, text) to service_role;
