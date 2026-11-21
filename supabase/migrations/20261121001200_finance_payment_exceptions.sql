alter table private.order_operations alter column created_at set default clock_timestamp();
alter table public.credit_ledger alter column created_at set default clock_timestamp();

create or replace function public.record_refund(
  p_order_id uuid, p_refund_id text, p_payment_intent_id text, p_amount_pence integer, p_currency text
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  result public.orders := private.lock_order(p_order_id);
  resolves_late_capture boolean;
begin
  if result.payment_method <> 'card'
    or p_payment_intent_id is null or result.payment_intent_id is distinct from p_payment_intent_id
    or upper(p_currency) is distinct from result.currency or p_amount_pence is null or p_amount_pence <= 0 then
    raise exception using errcode = '22023', message = 'refund_does_not_match_captured_payment';
  end if;
  if private.begin_order_operation(p_order_id, 'refund', p_refund_id, jsonb_build_array(p_payment_intent_id, p_amount_pence)) then
    if p_amount_pence > result.paid_pence - result.refunded_pence then
      raise exception using errcode = '22023', message = 'refund_exceeds_captured_payment';
    end if;
    result.refunded_pence := result.refunded_pence + p_amount_pence;
  elsif result.payment_review_refund_id is not null
    or result.payment_review_reason is distinct from 'payment_after_reservation_released'
    or result.refunded_pence <> result.paid_pence then
    return result;
  end if;
  resolves_late_capture := result.fulfilment_status = 'cancelled' and result.paid_pence > 0
    and result.refunded_pence = result.paid_pence
    and result.payment_review_reason is not distinct from 'payment_after_reservation_released';

  update public.orders
  set refunded_pence = result.refunded_pence,
      payment_status = case when result.refunded_pence = paid_pence
        then 'refunded' else 'partially_refunded' end::public.order_payment_status,
      payment_review_refund_id = case when resolves_late_capture then coalesce(payment_review_refund_id, p_refund_id)
        else payment_review_refund_id end,
      stripe_reconciliation_error = case when resolves_late_capture then null else stripe_reconciliation_error end
  where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.prepare_cancelled_card_refund(
  p_order_id uuid, p_actor_id uuid, p_account_id text, p_charge_id text, p_payment_intent_id text,
  p_amount_pence integer, p_previous_request_id uuid default null, p_failed_refund_id text default null
)
returns table(request_id uuid, started_at timestamptz, amount_pence integer)
language plpgsql security definer set search_path = ''
as $$
declare
  target public.orders := private.lock_order(p_order_id);
  prior private.order_operations;
begin
  perform private.require_finance(p_actor_id);
  if target.payment_method <> 'card' or target.fulfilment_status <> 'cancelled' or target.dispatched_at is not null
    or p_account_id is null or target.stripe_checkout_account_id is distinct from p_account_id
    or p_payment_intent_id is null or target.payment_intent_id is distinct from p_payment_intent_id
    or coalesce(p_charge_id, '') !~ '^ch_[A-Za-z0-9]{1,197}$'
    or p_amount_pence is null or p_amount_pence <= 0 then
    raise exception using errcode = '22023', message = 'cancelled_card_refund_not_eligible';
  end if;
  if target.refunded_pence = target.paid_pence then
    return;
  end if;
  select * into prior from private.order_operations
  where order_id = p_order_id and action = 'request_card_refund'
  order by created_at desc, operation_key desc limit 1;
  if found then
    if prior.input->>1 is distinct from p_account_id or prior.input->>2 is distinct from p_charge_id then
      raise exception using errcode = '22023', message = 'card_refund_request_identity_mismatch';
    end if;
    if prior.operation_key::uuid is distinct from p_previous_request_id then
      return query select prior.operation_key::uuid, prior.created_at, (prior.input->>3)::integer;
      return;
    end if;
    if coalesce(p_failed_refund_id, '') !~ '^re_[A-Za-z0-9]{1,197}$' then
      raise exception using errcode = '22023', message = 'card_refund_retry_needs_failure_proof';
    end if;
  elsif p_previous_request_id is not null or p_failed_refund_id is not null then
    raise exception using errcode = '22023', message = 'card_refund_request_not_found';
  end if;
  if p_amount_pence <> target.paid_pence - target.refunded_pence then
    raise exception using errcode = '22023', message = 'card_refund_amount_changed';
  end if;
  return query
    insert into private.order_operations as op (order_id, action, operation_key, input, created_at)
    values (p_order_id, 'request_card_refund', gen_random_uuid()::text,
      jsonb_build_array(p_actor_id, p_account_id, p_charge_id, p_amount_pence, p_previous_request_id, p_failed_refund_id),
      greatest(clock_timestamp(), prior.created_at + interval '1 microsecond'))
    returning op.operation_key::uuid, op.created_at, p_amount_pence;
end;
$$;
revoke all on function public.prepare_cancelled_card_refund(uuid, uuid, text, text, text, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.prepare_cancelled_card_refund(uuid, uuid, text, text, text, integer, uuid, text)
  to service_role;

create or replace function public.get_own_buyer_invoice_url(p_order_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select buyer_invoice_url from public.orders
  where id = p_order_id and buyer_id = (select auth.uid())
    and not (payment_method = 'net30' and fulfilment_status = 'cancelled');
$$;

create or replace function public.set_buyer_invoice_url(p_order_id uuid, p_provider_invoice_id text, p_url text)
returns boolean language sql security definer set search_path = ''
as $$
  with updated as (
    update public.orders set buyer_invoice_url = p_url
    where id = p_order_id and buyer_id is not null
      and provider_invoice_id = p_provider_invoice_id and p_url is not null
      and not (payment_method = 'net30' and fulfilment_status = 'cancelled')
    returning id
  )
  select exists (select 1 from updated);
$$;

create view public.finance_post_dispatch_adjustments as
  select o.id as order_id, o.order_reference, o.payment_method, op.operation_key as provider_reference,
    'refund'::text as kind, (op.input->>1)::integer as amount_pence, 0 as outstanding_delta_pence,
    op.created_at as reconciled_at
  from private.order_operations op join public.orders o on o.id = op.order_id
  where op.action = 'refund' and op.created_at >= o.dispatched_at
  union all
  select o.id, o.order_reference, o.payment_method, c.operation_key, c.kind::text,
    coalesce((c.input->>0)::integer, -c.outstanding_delta_pence), c.outstanding_delta_pence, c.created_at
  from public.credit_ledger c join public.orders o on o.id = c.order_id
  where c.kind in ('credit_note', 'void', 'refund') and c.created_at >= o.dispatched_at;
revoke all on public.finance_post_dispatch_adjustments from public, anon, authenticated;
grant select on public.finance_post_dispatch_adjustments to service_role;
