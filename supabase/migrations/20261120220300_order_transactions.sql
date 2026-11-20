create function private.lock_order(p_order_id uuid)
returns public.orders
language plpgsql set search_path = ''
as $$
declare result public.orders;
begin
  select * into result from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order_not_found';
  end if;
  return result;
end;
$$;

create function private.require_warehouse(p_actor_id uuid)
returns void
language plpgsql set search_path = ''
as $$
begin
  if not exists (select 1 from public.staff_members where user_id = p_actor_id and role = 'warehouse') then
    raise exception using errcode = '42501', message = 'warehouse_role_required';
  end if;
end;
$$;

create function private.begin_order_operation(p_order_id uuid, p_action text, p_key text, p_input jsonb)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  insert into private.order_operations (order_id, action, operation_key, input)
  values (p_order_id, p_action, p_key, p_input)
  on conflict do nothing;
  if found then
    return true;
  end if;
  if not exists (
    select 1 from private.order_operations
    where order_id = p_order_id and action = p_action and operation_key = p_key and input = p_input
  ) then
    raise exception using errcode = '22023', message = 'operation_key_conflict';
  end if;
  return false;
end;
$$;

create function private.apply_stock_movement(
  p_kind public.stock_movement_kind, p_key text, p_variant_id uuid,
  p_on_hand_delta integer, p_reserved_delta integer,
  p_order_id uuid default null, p_return_id uuid default null, p_actor_id uuid default null
)
returns public.stock_movements
language plpgsql set search_path = ''
as $$
declare result public.stock_movements;
begin
  insert into public.stock_movements
    (kind, operation_key, variant_id, order_id, return_id, actor_id, on_hand_delta, reserved_delta)
  values (p_kind, p_key, p_variant_id, p_order_id, p_return_id, p_actor_id, p_on_hand_delta, p_reserved_delta)
  on conflict (operation_key) do nothing
  returning * into result;
  if found then
    update public.variants
    set stock_on_hand = stock_on_hand + p_on_hand_delta, stock_reserved = stock_reserved + p_reserved_delta
    where id = p_variant_id;
    return result;
  end if;

  select * into strict result from public.stock_movements where operation_key = p_key;
  if (result.kind, result.variant_id, result.order_id, result.return_id, result.actor_id, result.on_hand_delta, result.reserved_delta)
     is distinct from (p_kind, p_variant_id, p_order_id, p_return_id, p_actor_id, p_on_hand_delta, p_reserved_delta) then
    raise exception using errcode = '22023', message = 'operation_key_conflict';
  end if;
  return result;
end;
$$;

create function private.finish_reservations(
  p_order_id uuid, p_from public.stock_reservation_state, p_kind public.stock_movement_kind,
  p_actor_id uuid default null
)
returns void
language plpgsql set search_path = ''
as $$
declare item record;
begin
  for item in
    select variant_id, quantity from public.stock_reservations
    where order_id = p_order_id and state = p_from
    order by variant_id
  loop
    perform private.apply_stock_movement(
      p_kind, p_kind || ':' || p_order_id || ':' || item.variant_id, item.variant_id,
      case when p_kind = 'dispatch' then -item.quantity else 0 end, -item.quantity, p_order_id, null, p_actor_id
    );
    update public.stock_reservations
    set state = case when p_kind = 'dispatch' then 'dispatched' else 'released' end::public.stock_reservation_state
    where order_id = p_order_id and variant_id = item.variant_id;
  end loop;
end;
$$;

create function public.create_order_with_reservations(
  p_attempt_token uuid, p_lines jsonb, p_contact jsonb, p_address jsonb, p_totals jsonb,
  p_hold_expires_at timestamptz, p_delivery_service text, p_dispatch_date date, p_delivery_date date,
  p_buyer_id uuid default null
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  result public.orders;
  variant public.variants;
  line record;
  unit_price integer;
  line_net bigint;
  line_tax bigint;
  goods_net bigint := 0;
  vat_total bigint;
  postcode text;
begin
  if p_attempt_token is null then
    raise exception using errcode = '22023', message = 'checkout_attempt_token_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order-attempt:' || p_attempt_token, 0));
  select * into result from public.orders where checkout_attempt_token = p_attempt_token;
  if found then
    if result.buyer_id is distinct from p_buyer_id then
      raise exception using errcode = '22023', message = 'attempt_owner_mismatch';
    end if;
    return result;
  end if;

  if coalesce(jsonb_typeof(p_lines), '') <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_order_lines';
  end if;
  if jsonb_array_length(p_lines) not between 1 and 100 or exists (
    select 1 from jsonb_array_elements(p_lines) as l
    where jsonb_typeof(l->'variant_id') is distinct from 'string'
       or jsonb_typeof(l->'quantity') is distinct from 'number'
       or (l->>'quantity') !~ '^[1-9][0-9]{0,9}$'
       or jsonb_typeof(l->'unit_price_pence') is distinct from 'number'
       or (l->>'unit_price_pence') !~ '^[1-9][0-9]{0,9}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_order_lines';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) as l group by (l->>'variant_id')::uuid having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'duplicate_variant';
  end if;
  if p_hold_expires_at is null or not isfinite(p_hold_expires_at) or p_hold_expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'invalid_hold_expiry';
  end if;
  if exists (
    select 1 from unnest(array['email','business_name','recipient_name']) as k
    where jsonb_typeof(p_contact->k) is distinct from 'string'
  ) or p_contact->'buying_for_work' is distinct from 'true'::jsonb
    or coalesce(jsonb_typeof(p_contact->'phone'), 'null') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'invalid_order_contact';
  end if;
  if exists (
    select 1 from unnest(array['line1','town','postcode','country']) as k
    where jsonb_typeof(p_address->k) is distinct from 'string'
  ) or exists (
    select 1 from unnest(array['line2','region']) as k
    where coalesce(jsonb_typeof(p_address->k), 'null') not in ('string', 'null')
  ) then
    raise exception using errcode = '22023', message = 'invalid_order_address';
  end if;
  if exists (
    select 1 from unnest(array['goods_net_pence','delivery_net_pence','vat_rate_bps','vat_pence','gross_pence']) as k
    where jsonb_typeof(p_totals->k) is distinct from 'number' or (p_totals->>k) !~ '^[0-9]{1,10}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_order_totals';
  end if;

  postcode := upper(regexp_replace(p_address->>'postcode', '[[:space:]]', '', 'g'));
  postcode := left(postcode, -3) || ' ' || right(postcode, 3);
  insert into public.orders (
    checkout_attempt_token, buyer_id, email, business_name, recipient_name, phone, buying_for_work,
    address_line1, address_line2, address_town, address_region, address_postcode, address_country,
    goods_net_pence, delivery_net_pence, vat_rate_bps, vat_pence, gross_pence,
    hold_expires_at, delivery_service, promised_dispatch_date, estimated_delivery_date
  )
  values (
    p_attempt_token, p_buyer_id, btrim(p_contact->>'email'), btrim(p_contact->>'business_name'),
    btrim(p_contact->>'recipient_name'), nullif(btrim(p_contact->>'phone'), ''), true,
    btrim(p_address->>'line1'), nullif(btrim(p_address->>'line2'), ''), btrim(p_address->>'town'),
    nullif(btrim(p_address->>'region'), ''), postcode, upper(btrim(p_address->>'country')),
    (p_totals->>'goods_net_pence')::integer, (p_totals->>'delivery_net_pence')::integer,
    (p_totals->>'vat_rate_bps')::integer, (p_totals->>'vat_pence')::integer, (p_totals->>'gross_pence')::integer,
    p_hold_expires_at, btrim(p_delivery_service), p_dispatch_date, p_delivery_date
  ) returning * into result;

  vat_total := (result.delivery_net_pence::bigint * result.vat_rate_bps + 5000) / 10000;
  for line in
    select (l->>'variant_id')::uuid as variant_id, (l->>'quantity')::integer as quantity,
      (l->>'unit_price_pence')::integer as unit_price_pence
    from jsonb_array_elements(p_lines) as l order by variant_id
  loop
    select * into variant from public.variants
    where id = line.variant_id and publication_status = 'published' for no key update;
    if not found then
      raise exception using errcode = '22023', message = 'variant_not_published', detail = line.variant_id::text;
    end if;
    unit_price := case
      when line.quantity < 5 then variant.price_1_4_pence
      when line.quantity < 10 then variant.price_5_9_pence
      else variant.price_10_plus_pence
    end;
    if unit_price <> line.unit_price_pence then
      raise exception using errcode = '22023', message = 'stale_unit_price', detail = variant.id::text;
    end if;
    if line.quantity > variant.stock_on_hand - variant.stock_reserved then
      raise exception using errcode = 'P0001', message = 'insufficient_stock', detail = variant.id::text;
    end if;
    line_net := line.quantity::bigint * unit_price;
    if line_net > result.goods_net_pence then
      raise exception using errcode = '22023', message = 'order_totals_mismatch';
    end if;
    line_tax := (line_net * result.vat_rate_bps + 5000) / 10000;
    goods_net := goods_net + line_net;
    vat_total := vat_total + line_tax;

    insert into public.order_items (order_id, variant_id, sku, option_label, quantity, unit_price_pence, net_pence, tax_pence, gross_pence)
    values (
      result.id, variant.id, variant.sku, coalesce(nullif(btrim(variant.option_label), ''), nullif(btrim(variant.tool), ''), variant.sku),
      line.quantity, unit_price, line_net, line_tax, line_net + line_tax
    );
    insert into public.stock_reservations (order_id, variant_id, quantity)
    values (result.id, variant.id, line.quantity);
    perform private.apply_stock_movement('reserve', 'reserve:' || result.id || ':' || variant.id,
      variant.id, 0, line.quantity, result.id);
  end loop;
  if goods_net <> result.goods_net_pence or vat_total <> result.vat_pence then
    raise exception using errcode = '22023', message = 'order_totals_mismatch';
  end if;
  if result.hold_expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'invalid_hold_expiry';
  end if;
  return result;
end;
$$;

create function public.bind_checkout_session(p_order_id uuid, p_session_id text, p_expires_at timestamptz)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  if coalesce(length(btrim(p_session_id)), 0) not between 1 and 200
    or p_expires_at is distinct from result.hold_expires_at then
    raise exception using errcode = '22023', message = 'checkout_session_does_not_match_hold';
  end if;
  if result.checkout_session_id = p_session_id then
    return result;
  end if;
  if result.checkout_session_id is not null or result.fulfilment_status <> 'awaiting_authorisation' then
    raise exception using errcode = '22023', message = 'checkout_session_conflict';
  end if;
  update public.orders set checkout_session_id = p_session_id where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.release_reservation(p_order_id uuid, p_operation_key text, p_reason text, p_session_id text default null)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  if p_reason is null or p_reason not in ('expired', 'closed')
    or (p_session_id is not null and length(btrim(p_session_id)) not between 1 and 200)
    or (p_reason = 'expired' and p_session_id is null)
    or (result.checkout_session_id is not null and result.checkout_session_id is distinct from p_session_id) then
    raise exception using errcode = '22023', message = 'invalid_reservation_release';
  end if;
  if not private.begin_order_operation(p_order_id, 'release', p_operation_key, jsonb_build_array(p_reason, p_session_id))
    or result.fulfilment_status <> 'awaiting_authorisation' then
    return result;
  end if;
  if p_reason = 'expired' and clock_timestamp() < result.hold_expires_at then
    raise exception using errcode = '22023', message = 'hold_not_expired';
  end if;
  perform private.finish_reservations(p_order_id, 'held', 'release');
  update public.orders
  set fulfilment_status = 'cancelled', checkout_session_id = coalesce(checkout_session_id, p_session_id)
  where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.enqueue_order_confirmation(p_order_id uuid)
returns public.order_outbox
language plpgsql security definer set search_path = ''
as $$
declare
  target public.orders := private.lock_order(p_order_id);
  result public.order_outbox;
begin
  if target.authorised_at is null then
    raise exception using errcode = '22023', message = 'order_not_authorised';
  end if;
  insert into public.order_outbox (order_id, message_key)
  values (p_order_id, 'order_confirmation')
  on conflict do nothing;
  select * into strict result from public.order_outbox
  where order_id = p_order_id and message_key = 'order_confirmation';
  return result;
end;
$$;

create function public.confirm_payment(
  p_order_id uuid, p_session_id text, p_payment_intent_id text, p_amount_pence integer, p_currency text,
  p_invoice_id text default null, p_dispatch_date date default null, p_delivery_date date default null
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  result public.orders := private.lock_order(p_order_id);
  needs_allocation boolean := result.fulfilment_status = 'awaiting_authorisation';
begin
  if result.payment_method <> 'card' or p_amount_pence is distinct from result.gross_pence
    or upper(p_currency) is distinct from result.currency then
    raise exception using errcode = '22023', message = 'payment_amount_or_currency_mismatch';
  end if;
  if coalesce(length(btrim(p_session_id)), 0) not between 1 and 200
    or coalesce(length(btrim(p_payment_intent_id)), 0) not between 1 and 200
    or (p_invoice_id is not null and length(btrim(p_invoice_id)) not between 1 and 200)
    or (result.checkout_session_id is not null and result.checkout_session_id <> p_session_id)
    or (result.payment_intent_id is not null and result.payment_intent_id <> p_payment_intent_id)
    or (p_invoice_id is not null and result.provider_invoice_id is not null and result.provider_invoice_id <> p_invoice_id) then
    raise exception using errcode = '22023', message = 'payment_provider_identity_mismatch';
  end if;
  if (p_dispatch_date is null) <> (p_delivery_date is null) then
    raise exception using errcode = '22023', message = 'incomplete_delivery_promise';
  end if;
  if result.payment_intent_id is not null then
    if result.provider_invoice_id is null and p_invoice_id is not null then
      update public.orders set provider_invoice_id = p_invoice_id where id = p_order_id returning * into result;
    end if;
    return result;
  end if;
  if needs_allocation then
    update public.stock_reservations set state = 'allocated' where order_id = p_order_id and state = 'held';
  end if;
  update public.orders
  set payment_status = 'paid', paid_pence = p_amount_pence, checkout_session_id = p_session_id,
      payment_intent_id = p_payment_intent_id, provider_invoice_id = p_invoice_id,
      fulfilment_status = case when needs_allocation then 'ready_to_pick' else fulfilment_status end,
      authorised_at = case when needs_allocation then clock_timestamp() else authorised_at end,
      promised_dispatch_date = case when needs_allocation then coalesce(p_dispatch_date, promised_dispatch_date) else promised_dispatch_date end,
      estimated_delivery_date = case when needs_allocation then coalesce(p_delivery_date, estimated_delivery_date) else estimated_delivery_date end,
      payment_review_reason = case when fulfilment_status = 'cancelled' then 'payment_after_reservation_released' else null end
  where id = p_order_id returning * into result;
  if needs_allocation then
    perform public.enqueue_order_confirmation(p_order_id);
  end if;
  return result;
end;
$$;

create function public.record_refund(
  p_order_id uuid, p_refund_id text, p_payment_intent_id text, p_amount_pence integer, p_currency text
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  if p_payment_intent_id is null or result.payment_intent_id is distinct from p_payment_intent_id
    or upper(p_currency) is distinct from result.currency or p_amount_pence is null or p_amount_pence <= 0 then
    raise exception using errcode = '22023', message = 'refund_does_not_match_captured_payment';
  end if;
  if not private.begin_order_operation(p_order_id, 'refund', p_refund_id, jsonb_build_array(p_payment_intent_id, p_amount_pence)) then
    return result;
  end if;
  if p_amount_pence > result.paid_pence - result.refunded_pence then
    raise exception using errcode = '22023', message = 'refund_exceeds_captured_payment';
  end if;
  update public.orders
  set refunded_pence = refunded_pence + p_amount_pence,
      payment_status = case when refunded_pence + p_amount_pence = paid_pence
        then 'refunded' else 'partially_refunded' end::public.order_payment_status
  where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.cancel_order(p_order_id uuid, p_operation_key text, p_actor_id uuid)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  perform private.require_warehouse(p_actor_id);
  if not private.begin_order_operation(p_order_id, 'cancel', p_operation_key, jsonb_build_array(p_actor_id))
    or result.fulfilment_status = 'cancelled' then
    return result;
  end if;
  if result.fulfilment_status not in ('ready_to_pick', 'picking') then
    raise exception using errcode = '22023', message = 'order_cannot_be_cancelled';
  end if;
  perform private.finish_reservations(p_order_id, 'allocated', 'release', p_actor_id);
  update public.orders set fulfilment_status = 'cancelled' where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.start_picking(p_order_id uuid, p_operation_key text, p_actor_id uuid)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  perform private.require_warehouse(p_actor_id);
  if not private.begin_order_operation(p_order_id, 'pick', p_operation_key, jsonb_build_array(p_actor_id))
    or result.fulfilment_status = 'picking' then
    return result;
  end if;
  if result.fulfilment_status <> 'ready_to_pick' then
    raise exception using errcode = '22023', message = 'order_not_ready_to_pick';
  end if;
  update public.orders set fulfilment_status = 'picking' where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.dispatch_order(
  p_order_id uuid, p_operation_key text, p_actor_id uuid, p_carrier text, p_tracking_number text
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  perform private.require_warehouse(p_actor_id);
  if coalesce(length(btrim(p_carrier)), 0) not between 1 and 100
    or coalesce(length(btrim(p_tracking_number)), 0) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'carrier_and_tracking_required';
  end if;
  if not private.begin_order_operation(p_order_id, 'dispatch', p_operation_key,
    jsonb_build_array(p_actor_id, btrim(p_carrier), btrim(p_tracking_number))) then
    return result;
  end if;
  if result.fulfilment_status = 'dispatched'
    and result.carrier = btrim(p_carrier) and result.tracking_number = btrim(p_tracking_number) then
    return result;
  end if;
  if result.fulfilment_status <> 'picking' then
    raise exception using errcode = '22023', message = 'order_not_picking';
  end if;
  perform private.finish_reservations(p_order_id, 'allocated', 'dispatch', p_actor_id);
  update public.orders
  set fulfilment_status = 'dispatched', dispatched_at = clock_timestamp(), carrier = btrim(p_carrier),
      tracking_number = btrim(p_tracking_number)
  where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.record_return(
  p_order_id uuid, p_return_id uuid, p_actor_id uuid, p_variant_id uuid, p_quantity integer,
  p_reason text, p_lookup_code text default null
)
returns public.order_returns
language plpgsql security definer set search_path = ''
as $$
declare
  target public.orders := private.lock_order(p_order_id);
  result public.order_returns;
  dispatched_quantity integer;
  already_returned bigint;
begin
  perform private.require_warehouse(p_actor_id);
  if target.fulfilment_status <> 'dispatched' then
    raise exception using errcode = '22023', message = 'order_not_dispatched';
  end if;
  if not private.begin_order_operation(p_order_id, 'return', p_return_id::text,
    jsonb_build_array(p_actor_id, p_variant_id, p_quantity, btrim(p_reason), nullif(btrim(p_lookup_code), ''))) then
    select * into strict result from public.order_returns where id = p_return_id;
    return result;
  end if;
  select quantity into dispatched_quantity from public.order_items where order_id = p_order_id and variant_id = p_variant_id;
  select coalesce(sum(quantity), 0) into already_returned
  from public.order_returns where order_id = p_order_id and variant_id = p_variant_id;
  if dispatched_quantity is null or p_quantity is null or p_quantity <= 0
    or already_returned + p_quantity > dispatched_quantity then
    raise exception using errcode = '22023', message = 'return_exceeds_dispatched_quantity';
  end if;
  insert into public.order_returns (id, order_id, variant_id, quantity, reason, lookup_code, recorded_by)
  values (p_return_id, p_order_id, p_variant_id, p_quantity, btrim(p_reason), nullif(btrim(p_lookup_code), ''), p_actor_id)
  returning * into result;
  return result;
end;
$$;

create function public.restore_stock(p_return_id uuid, p_operation_key text, p_actor_id uuid, p_quantity integer)
returns public.order_returns
language plpgsql security definer set search_path = ''
as $$
declare result public.order_returns;
begin
  perform private.require_warehouse(p_actor_id);
  select * into result from public.order_returns where id = p_return_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'return_not_found';
  end if;
  perform private.lock_order(result.order_id);
  select * into strict result from public.order_returns where id = p_return_id;

  if not private.begin_order_operation(result.order_id, 'restore', p_operation_key, jsonb_build_array(p_return_id, p_actor_id, p_quantity)) then
    return result;
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > result.quantity - result.restored_quantity then
    raise exception using errcode = '22023', message = 'restore_exceeds_returned_quantity';
  end if;
  perform private.apply_stock_movement('restore', 'restore:' || result.order_id || ':' || p_operation_key,
    result.variant_id, p_quantity, 0, result.order_id, p_return_id, p_actor_id);
  update public.order_returns set restored_quantity = restored_quantity + p_quantity
  where id = p_return_id returning * into result;
  return result;
end;
$$;

create function public.receive_stock(p_variant_id uuid, p_operation_key text, p_quantity integer, p_actor_id uuid)
returns public.stock_movements
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_warehouse(p_actor_id);
  if coalesce(length(btrim(p_operation_key)), 0) not between 1 and 200 or p_quantity is null or p_quantity <= 0 then
    raise exception using errcode = '22023', message = 'invalid_stock_receipt';
  end if;
  return private.apply_stock_movement('receive', 'receive:' || p_operation_key,
    p_variant_id, p_quantity, 0, null, null, p_actor_id);
end;
$$;

create function public.record_provider_event(p_provider text, p_event_id text, p_event_type text, p_payload jsonb)
returns public.provider_events
language plpgsql security definer set search_path = ''
as $$
declare result public.provider_events;
begin
  insert into public.provider_events (provider, event_id, event_type, payload)
  values (p_provider, p_event_id, p_event_type, p_payload)
  on conflict (provider, event_id) do nothing;
  select * into strict result from public.provider_events where provider = p_provider and event_id = p_event_id;
  if result.event_type <> p_event_type then
    raise exception using errcode = '22023', message = 'provider_event_identity_conflict';
  end if;
  return result;
end;
$$;

create function public.mark_provider_event(
  p_provider text, p_event_id text, p_state public.provider_event_state, p_error text default null
)
returns public.provider_events
language plpgsql security definer set search_path = ''
as $$
declare result public.provider_events;
begin
  select * into result from public.provider_events where provider = p_provider and event_id = p_event_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'provider_event_not_found';
  end if;
  if p_state is null or p_state = 'received' or (p_state = 'failed') <> (p_error is not null) then
    raise exception using errcode = '22023', message = 'invalid_provider_event_state';
  end if;
  if result.state = 'processed' or (result.state = p_state and result.last_error is not distinct from p_error) then
    return result;
  end if;
  update public.provider_events set state = p_state, last_error = p_error
  where provider = p_provider and event_id = p_event_id returning * into result;
  return result;
end;
$$;

revoke all on function
  private.lock_order(uuid),
  private.require_warehouse(uuid),
  private.begin_order_operation(uuid, text, text, jsonb),
  private.apply_stock_movement(public.stock_movement_kind, text, uuid, integer, integer, uuid, uuid, uuid),
  private.finish_reservations(uuid, public.stock_reservation_state, public.stock_movement_kind, uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid),
  public.bind_checkout_session(uuid, text, timestamptz),
  public.release_reservation(uuid, text, text, text),
  public.enqueue_order_confirmation(uuid),
  public.confirm_payment(uuid, text, text, integer, text, text, date, date),
  public.record_refund(uuid, text, text, integer, text),
  public.cancel_order(uuid, text, uuid),
  public.start_picking(uuid, text, uuid),
  public.dispatch_order(uuid, text, uuid, text, text),
  public.record_return(uuid, uuid, uuid, uuid, integer, text, text),
  public.restore_stock(uuid, text, uuid, integer),
  public.receive_stock(uuid, text, integer, uuid),
  public.record_provider_event(text, text, text, jsonb),
  public.mark_provider_event(text, text, public.provider_event_state, text)
from public, anon, authenticated;

grant execute on function
  public.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid),
  public.bind_checkout_session(uuid, text, timestamptz),
  public.release_reservation(uuid, text, text, text),
  public.enqueue_order_confirmation(uuid),
  public.confirm_payment(uuid, text, text, integer, text, text, date, date),
  public.record_refund(uuid, text, text, integer, text),
  public.cancel_order(uuid, text, uuid),
  public.start_picking(uuid, text, uuid),
  public.dispatch_order(uuid, text, uuid, text, text),
  public.record_return(uuid, uuid, uuid, uuid, integer, text, text),
  public.restore_stock(uuid, text, uuid, integer),
  public.receive_stock(uuid, text, integer, uuid),
  public.record_provider_event(text, text, text, jsonb),
  public.mark_provider_event(text, text, public.provider_event_state, text)
to service_role;
