create function private.require_finance(p_actor_id uuid)
returns void
language plpgsql set search_path = ''
as $$
begin
  perform 1 from public.staff_members where user_id = p_actor_id and role = 'finance' for key share;
  if not found then
    raise exception using errcode = '42501', message = 'finance_role_required';
  end if;
end;
$$;

create function private.lock_trade_account(p_trade_account_id uuid)
returns public.trade_accounts
language plpgsql set search_path = ''
as $$
declare result public.trade_accounts;
begin
  select * into result from public.trade_accounts where id = p_trade_account_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'trade_account_not_found';
  end if;
  return result;
end;
$$;

create function private.lock_net30_order(p_order_id uuid)
returns public.orders
language plpgsql set search_path = ''
as $$
declare account_id uuid;
begin
  select trade_account_id into account_id from public.orders where id = p_order_id and payment_method = 'net30';
  if not found then
    raise exception using errcode = 'P0002', message = 'net30_order_not_found';
  end if;
  perform private.lock_trade_account(account_id);
  return private.lock_order(p_order_id);
end;
$$;

create function private.record_credit_operation(
  p_account_id uuid, p_order_id uuid, p_actor_id uuid, p_kind public.credit_ledger_kind,
  p_key text, p_input jsonb, p_held_delta integer, p_outstanding_delta integer
)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if coalesce(length(btrim(p_key)), 0) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid_operation_key';
  end if;
  insert into public.credit_ledger (trade_account_id, order_id, actor_id, kind, operation_key,
    input, held_delta_pence, outstanding_delta_pence)
  values (p_account_id, p_order_id, p_actor_id, p_kind, p_key, p_input, p_held_delta, p_outstanding_delta)
  on conflict (kind, operation_key) do nothing;
  if found then
    if p_held_delta <> 0 or p_outstanding_delta <> 0 then
      update public.trade_accounts set updated_at = clock_timestamp() where id = p_account_id;
    end if;
    return true;
  end if;
  if not exists (
    select 1 from public.credit_ledger where kind = p_kind and operation_key = p_key
      and trade_account_id = p_account_id and order_id is not distinct from p_order_id
      and actor_id is not distinct from p_actor_id and input = p_input
  ) then
    raise exception using errcode = '22023', message = 'operation_key_conflict';
  end if;
  return false;
end;
$$;

create function public.approve_trade_account(
  p_application_id uuid, p_actor_id uuid, p_credit_limit_pence integer, p_stripe_customer_id text
)
returns public.trade_accounts
language plpgsql security definer set search_path = ''
as $$
declare
  application public.trade_applications;
  result public.trade_accounts;
  payload jsonb := jsonb_build_array(p_credit_limit_pence, p_stripe_customer_id);
begin
  perform private.require_finance(p_actor_id);
  if p_credit_limit_pence is null or p_credit_limit_pence < 0
    or coalesce(p_stripe_customer_id, '') !~ '^cus_[A-Za-z0-9]{1,196}$' then
    raise exception using errcode = '22023', message = 'invalid_trade_account_terms';
  end if;
  select * into application from public.trade_applications where id = p_application_id for no key update;
  if not found or application.status <> 'approved' then
    raise exception using errcode = '22023', message = 'approved_trade_application_required';
  end if;

  select * into result from public.trade_accounts where application_id = p_application_id;
  if found then
    result := private.lock_trade_account(result.id);
    if private.record_credit_operation(result.id, null, p_actor_id, 'approve', p_application_id::text, payload, 0, 0) then
      raise exception using errcode = '22023', message = 'trade_account_already_exists';
    end if;
    return result;
  end if;
  if not exists (
    select 1 from auth.users where id = application.buyer_id and email_confirmed_at is not null and not is_anonymous
  ) then
    raise exception using errcode = '42501', message = 'verified_buyer_required';
  end if;
  insert into public.trade_accounts (application_id, buyer_id, buyer_name, status, credit_limit_pence, stripe_customer_id)
  values (p_application_id, application.buyer_id, application.buyer_name, 'approved', p_credit_limit_pence, p_stripe_customer_id)
  returning * into result;
  perform private.record_credit_operation(result.id, null, p_actor_id, 'approve', p_application_id::text, payload, 0, 0);
  return result;
end;
$$;

create function public.set_credit_limit(
  p_trade_account_id uuid, p_actor_id uuid, p_operation_key text, p_credit_limit_pence integer
)
returns public.trade_accounts
language plpgsql security definer set search_path = ''
as $$
declare result public.trade_accounts;
begin
  perform private.require_finance(p_actor_id);
  if p_credit_limit_pence is null or p_credit_limit_pence < 0 then
    raise exception using errcode = '22023', message = 'invalid_credit_limit';
  end if;
  result := private.lock_trade_account(p_trade_account_id);
  if private.record_credit_operation(result.id, null, p_actor_id, 'set_limit', p_operation_key,
    jsonb_build_array(p_credit_limit_pence), 0, 0) then
    update public.trade_accounts set credit_limit_pence = p_credit_limit_pence, updated_at = clock_timestamp()
    where id = result.id returning * into result;
  end if;
  return result;
end;
$$;

create function public.suspend_trade_account(
  p_trade_account_id uuid, p_actor_id uuid, p_operation_key text, p_reason text
)
returns public.trade_accounts
language plpgsql security definer set search_path = ''
as $$
declare result public.trade_accounts;
begin
  perform private.require_finance(p_actor_id);
  if coalesce(length(btrim(p_reason)), 0) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'suspension_reason_required';
  end if;
  result := private.lock_trade_account(p_trade_account_id);
  if private.record_credit_operation(result.id, null, p_actor_id, 'suspend', p_operation_key,
    jsonb_build_array(btrim(p_reason)), 0, 0) then
    update public.trade_accounts set status = 'suspended', updated_at = clock_timestamp()
    where id = result.id returning * into result;
  end if;
  return result;
end;
$$;

alter function public.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid)
  set schema private;
alter function private.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid)
  security invoker;

create function public.create_order_with_reservations(
  p_attempt_token uuid, p_lines jsonb, p_contact jsonb, p_address jsonb, p_totals jsonb,
  p_hold_expires_at timestamptz, p_delivery_service text, p_dispatch_date date, p_delivery_date date,
  p_buyer_id uuid default null
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders;
begin
  result := private.create_order_with_reservations(p_attempt_token, p_lines, p_contact, p_address, p_totals,
    p_hold_expires_at, p_delivery_service, p_dispatch_date, p_delivery_date, p_buyer_id);
  if result.payment_method <> 'card' then
    raise exception using errcode = '22023', message = 'attempt_payment_method_mismatch';
  end if;
  return result;
end;
$$;

create function public.create_net30_order_with_holds(
  p_attempt_token uuid, p_lines jsonb, p_contact jsonb, p_address jsonb, p_totals jsonb,
  p_hold_expires_at timestamptz, p_delivery_service text, p_dispatch_date date, p_delivery_date date,
  p_buyer_id uuid, p_po_number text
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  account public.trade_accounts;
  result public.orders;
  existing_order boolean;
  available_pence bigint;
begin
  if p_attempt_token is null then
    raise exception using errcode = '22023', message = 'checkout_attempt_token_required';
  end if;
  p_po_number := regexp_replace(p_po_number, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if coalesce(length(p_po_number), 0) not between 1 and 200 or p_po_number ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'po_number_required';
  end if;
  if not exists (
    select 1 from auth.users where id = p_buyer_id and email_confirmed_at is not null and not is_anonymous
  ) then
    raise exception using errcode = '42501', message = 'verified_buyer_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order-attempt:' || p_attempt_token, 0));
  select * into result from public.orders where checkout_attempt_token = p_attempt_token;
  existing_order := found;
  if existing_order then
    if result.buyer_id is distinct from p_buyer_id then
      raise exception using errcode = '22023', message = 'attempt_owner_mismatch';
    end if;
    if result.payment_method <> 'net30' then
      raise exception using errcode = '22023', message = 'attempt_payment_method_mismatch';
    end if;
    if result.po_number is distinct from p_po_number then
      raise exception using errcode = '22023', message = 'attempt_payload_mismatch';
    end if;
  else
    select * into account from public.trade_accounts where buyer_id = p_buyer_id for update;
    if not found or account.status <> 'approved' then
      raise exception using errcode = '42501', message = 'approved_trade_account_required';
    end if;
  end if;

  result := private.create_order_with_reservations(p_attempt_token, p_lines, p_contact, p_address, p_totals,
    p_hold_expires_at, p_delivery_service, p_dispatch_date, p_delivery_date, p_buyer_id);
  if existing_order then
    return result;
  end if;
  select available_credit_pence into strict available_pence
  from public.trade_credit_position where trade_account_id = account.id;
  if available_pence < result.gross_pence then
    raise exception using errcode = 'P0001', message = 'insufficient_trade_credit';
  end if;

  update public.orders set payment_method = 'net30', po_number = p_po_number, trade_account_id = account.id
  where id = result.id returning * into result;
  insert into public.credit_holds (order_id, trade_account_id, operation_key, amount_pence)
  values (result.id, account.id, p_attempt_token, result.gross_pence);
  perform private.record_credit_operation(account.id, result.id, null, 'hold', p_attempt_token::text,
    jsonb_build_array(result.gross_pence), result.gross_pence, 0);
  return result;
end;
$$;

alter function public.release_reservation(uuid, text, text, text) set schema private;
alter function private.release_reservation(uuid, text, text, text) security invoker;

create function public.release_reservation(
  p_order_id uuid, p_operation_key text, p_reason text, p_session_id text default null
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare target public.orders := private.lock_order(p_order_id);
begin
  if target.payment_method <> 'card' then
    raise exception using errcode = '22023', message = 'net30_requires_credit_hold_release';
  end if;
  return private.release_reservation(p_order_id, p_operation_key, p_reason, p_session_id);
end;
$$;

create function public.bind_invoice(
  p_order_id uuid, p_provider_invoice_id text, p_stripe_customer_id text, p_amount_due_pence integer, p_currency text,
  p_issued_at timestamptz, p_due_at timestamptz, p_dispatch_date date, p_delivery_date date
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  result public.orders := private.lock_net30_order(p_order_id);
  hold public.credit_holds;
  allocate_stock boolean := result.fulfilment_status = 'awaiting_authorisation';
begin
  if coalesce(p_provider_invoice_id, '') !~ '^in_[A-Za-z0-9]{1,197}$'
    or not exists (
      select 1 from public.trade_accounts
      where id = result.trade_account_id and stripe_customer_id = p_stripe_customer_id
    ) then
    raise exception using errcode = '22023', message = 'invoice_provider_identity_mismatch';
  end if;
  if p_amount_due_pence is distinct from result.gross_pence or upper(p_currency) is distinct from result.currency then
    raise exception using errcode = '22023', message = 'invoice_amount_or_currency_mismatch';
  end if;
  if p_issued_at is null or not isfinite(p_issued_at)
    or p_due_at is null or not isfinite(p_due_at) or p_due_at <= p_issued_at then
    raise exception using errcode = '22023', message = 'invalid_invoice_dates';
  end if;
  select * into strict hold from public.credit_holds where order_id = result.id;
  if not private.record_credit_operation(result.trade_account_id, result.id, null, 'issue', p_provider_invoice_id,
    jsonb_build_array(p_stripe_customer_id, p_amount_due_pence, upper(p_currency), p_issued_at at time zone 'UTC', p_due_at at time zone 'UTC'),
    case when hold.status = 'held' then -hold.amount_pence else 0 end, result.gross_pence) then
    return result;
  end if;
  if result.provider_invoice_id is not null
    or (allocate_stock and hold.status <> 'held')
    or (not allocate_stock and (result.fulfilment_status <> 'cancelled' or hold.status <> 'released')) then
    raise exception using errcode = '22023', message = 'invoice_does_not_match_hold';
  end if;
  if not allocate_stock and exists (
    select 1 from public.credit_ledger
    where order_id = result.id and kind = 'release' and input->>1 = p_provider_invoice_id
  ) then
    raise exception using errcode = '22023', message = 'invoice_already_closed';
  end if;
  if allocate_stock and (p_dispatch_date is null or not isfinite(p_dispatch_date)
    or p_delivery_date is null or not isfinite(p_delivery_date) or p_delivery_date < p_dispatch_date) then
    raise exception using errcode = '22023', message = 'invalid_invoice_delivery_promise';
  end if;
  insert into public.invoices (order_id, trade_account_id, provider_invoice_id, po_number, currency, amount_due_pence,
    amount_remaining_pence, issued_at, due_at)
  values (result.id, result.trade_account_id, p_provider_invoice_id, result.po_number, result.currency, result.gross_pence,
    result.gross_pence, p_issued_at, p_due_at);
  if allocate_stock then
    update public.credit_holds set status = 'converted', resolved_at = clock_timestamp() where order_id = result.id;
    update public.stock_reservations set state = 'allocated' where order_id = result.id and state = 'held';
  end if;
  update public.orders set provider_invoice_id = p_provider_invoice_id, payment_status = 'invoiced',
    fulfilment_status = case when allocate_stock then 'ready_to_pick' else fulfilment_status end,
    authorised_at = case when allocate_stock then p_issued_at else authorised_at end,
    promised_dispatch_date = case when allocate_stock then p_dispatch_date else promised_dispatch_date end,
    estimated_delivery_date = case when allocate_stock then p_delivery_date else estimated_delivery_date end,
    payment_review_reason = case when not allocate_stock then 'invoice_issued_after_hold_released' else null end
  where id = result.id returning * into result;
  if allocate_stock then
    perform public.enqueue_order_confirmation(result.id);
  end if;
  return result;
end;
$$;

create function public.release_credit_hold(
  p_order_id uuid, p_operation_key text, p_resolution text, p_provider_invoice_id text default null
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  result public.orders := private.lock_net30_order(p_order_id);
  hold public.credit_holds;
begin
  if p_resolution is null or p_resolution not in ('not_created', 'deleted', 'voided')
    or (p_resolution = 'not_created' and p_provider_invoice_id is not null)
    or (p_resolution <> 'not_created' and coalesce(p_provider_invoice_id, '') !~ '^in_[A-Za-z0-9]{1,197}$') then
    raise exception using errcode = '22023', message = 'invalid_credit_hold_release';
  end if;
  select * into strict hold from public.credit_holds where order_id = result.id;
  if not private.record_credit_operation(result.trade_account_id, result.id, null, 'release', p_operation_key,
    jsonb_build_array(p_resolution, p_provider_invoice_id), -hold.amount_pence, 0) then
    return result;
  end if;
  if hold.status <> 'held' or result.fulfilment_status <> 'awaiting_authorisation' or result.provider_invoice_id is not null then
    raise exception using errcode = '22023', message = 'credit_hold_not_releasable';
  end if;
  perform private.finish_reservations(result.id, 'held', 'release');
  update public.credit_holds set status = 'released', resolved_at = clock_timestamp() where order_id = result.id;
  update public.orders set payment_status = 'voided', fulfilment_status = 'cancelled'
  where id = result.id returning * into result;
  return result;
end;
$$;

create function private.apply_trade_invoice_operation(
  p_provider_invoice_id text, p_operation_key text, p_kind public.credit_ledger_kind,
  p_amount_pence integer, p_currency text, p_pre_payment_pence integer default null
)
returns public.invoices
language plpgsql set search_path = ''
as $$
declare
  invoice public.invoices;
  target public.orders;
  debt_delta integer;
  remaining_pence integer;
  note_total bigint;
  note_post_payment bigint;
begin
  select order_id into invoice.order_id from public.invoices where provider_invoice_id = p_provider_invoice_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'trade_invoice_not_found';
  end if;
  target := private.lock_net30_order(invoice.order_id);
  select * into strict invoice from public.invoices where order_id = target.id;

  if p_kind <> 'void' and (p_amount_pence is null or p_amount_pence <= 0
    or upper(p_currency) is distinct from invoice.currency) then
    raise exception using errcode = '22023', message = 'invalid_invoice_amount_or_currency';
  end if;
  if p_kind = 'credit_note' and (p_pre_payment_pence is null or p_pre_payment_pence not between 0 and p_amount_pence) then
    raise exception using errcode = '22023', message = 'invalid_credit_note_split';
  end if;
  debt_delta := case p_kind
    when 'payment' then -p_amount_pence
    when 'credit_note' then -p_pre_payment_pence
    when 'void' then -invoice.amount_remaining_pence
    when 'refund' then 0
  end;
  if not private.record_credit_operation(invoice.trade_account_id, invoice.order_id, null, p_kind, p_operation_key,
    jsonb_build_array(p_amount_pence, upper(p_currency), p_pre_payment_pence), 0, debt_delta) then
    return invoice;
  end if;
  if (invoice.status = 'voided' and (p_kind not in ('refund', 'credit_note') or debt_delta <> 0))
    or (p_kind = 'void' and invoice.status in ('paid', 'credited')) then
    raise exception using errcode = '22023', message = 'invoice_operation_not_allowed';
  end if;
  if p_kind = 'void' and target.paid_pence > target.refunded_pence then
    raise exception using errcode = '22023', message = 'invoice_has_unrefunded_payments';
  end if;
  if -debt_delta > invoice.amount_remaining_pence then
    raise exception using errcode = '22023', message = 'invoice_adjustment_exceeds_amount_remaining';
  end if;
  if p_kind = 'refund' and p_amount_pence > target.paid_pence - target.refunded_pence then
    raise exception using errcode = '22023', message = 'refund_exceeds_invoice_payments';
  end if;
  if p_kind = 'credit_note' then
    select sum((input->>0)::integer), sum((input->>0)::integer + outstanding_delta_pence)
      into note_total, note_post_payment
    from public.credit_ledger where order_id = invoice.order_id and kind = 'credit_note';
    if note_total > invoice.amount_due_pence or note_post_payment > target.paid_pence then
      raise exception using errcode = '22023', message = 'credit_note_exceeds_invoice_amounts';
    end if;
  end if;

  remaining_pence := invoice.amount_remaining_pence + debt_delta;
  if p_kind = 'payment' then
    target.paid_pence := target.paid_pence + p_amount_pence;
  elsif p_kind = 'refund' then
    target.refunded_pence := target.refunded_pence + p_amount_pence;
  end if;
  if debt_delta <> 0 or p_kind = 'void' then
    update public.invoices set amount_remaining_pence = remaining_pence,
      status = (case
        when p_kind = 'void' then 'voided'
        when remaining_pence = 0 and target.paid_pence = 0 then 'credited'
        when remaining_pence = 0 then 'paid'
        when target.paid_pence > 0 then 'partially_paid'
        else 'open'
      end)::public.trade_invoice_status
    where order_id = invoice.order_id returning * into invoice;
  end if;
  if invoice.status in ('voided', 'credited') and target.fulfilment_status in ('ready_to_pick', 'picking') then
    perform private.finish_reservations(target.id, 'allocated', 'release');
    target.fulfilment_status := 'cancelled';
  end if;

  update public.orders set paid_pence = target.paid_pence, refunded_pence = target.refunded_pence,
    fulfilment_status = target.fulfilment_status,
    payment_status = (case
      when invoice.status in ('voided', 'credited') then 'voided'
      when invoice.status = 'open' then 'invoiced'
      when invoice.status = 'partially_paid' then 'partially_paid'
      when target.refunded_pence > 0 and target.refunded_pence = target.paid_pence then 'refunded'
      when target.refunded_pence > 0 then 'partially_refunded'
      else 'paid'
    end)::public.order_payment_status
  where id = target.id;
  return invoice;
end;
$$;

create function public.apply_invoice_payment(
  p_provider_invoice_id text, p_operation_key text, p_amount_pence integer, p_currency text
)
returns public.invoices
language sql security definer set search_path = ''
as $$
  select private.apply_trade_invoice_operation(p_provider_invoice_id, p_operation_key, 'payment', p_amount_pence, p_currency);
$$;

create function public.apply_credit_note(
  p_provider_invoice_id text, p_operation_key text, p_amount_pence integer, p_pre_payment_pence integer, p_currency text
)
returns public.invoices
language sql security definer set search_path = ''
as $$
  select private.apply_trade_invoice_operation(p_provider_invoice_id, p_operation_key, 'credit_note', p_amount_pence, p_currency,
    p_pre_payment_pence);
$$;

create function public.void_invoice(p_provider_invoice_id text)
returns public.invoices
language sql security definer set search_path = ''
as $$
  select private.apply_trade_invoice_operation(p_provider_invoice_id, p_provider_invoice_id, 'void', null, null);
$$;

create function public.apply_invoice_refund(
  p_provider_invoice_id text, p_operation_key text, p_amount_pence integer, p_currency text
)
returns public.invoices
language sql security definer set search_path = ''
as $$
  select private.apply_trade_invoice_operation(p_provider_invoice_id, p_operation_key, 'refund', p_amount_pence, p_currency);
$$;

revoke all on function
  private.require_finance(uuid), private.lock_trade_account(uuid), private.lock_net30_order(uuid),
  private.record_credit_operation(uuid, uuid, uuid, public.credit_ledger_kind, text, jsonb, integer, integer),
  private.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid),
  private.release_reservation(uuid, text, text, text),
  private.apply_trade_invoice_operation(text, text, public.credit_ledger_kind, integer, text, integer)
from public, anon, authenticated, service_role;

revoke all on function
  public.approve_trade_account(uuid, uuid, integer, text), public.set_credit_limit(uuid, uuid, text, integer),
  public.suspend_trade_account(uuid, uuid, text, text),
  public.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid),
  public.create_net30_order_with_holds(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid, text),
  public.release_reservation(uuid, text, text, text),
  public.bind_invoice(uuid, text, text, integer, text, timestamptz, timestamptz, date, date),
  public.release_credit_hold(uuid, text, text, text),
  public.apply_invoice_payment(text, text, integer, text), public.apply_credit_note(text, text, integer, integer, text),
  public.void_invoice(text), public.apply_invoice_refund(text, text, integer, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.approve_trade_account(uuid, uuid, integer, text), public.set_credit_limit(uuid, uuid, text, integer),
  public.suspend_trade_account(uuid, uuid, text, text),
  public.create_order_with_reservations(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid),
  public.create_net30_order_with_holds(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, text, date, date, uuid, text),
  public.release_reservation(uuid, text, text, text),
  public.bind_invoice(uuid, text, text, integer, text, timestamptz, timestamptz, date, date),
  public.release_credit_hold(uuid, text, text, text),
  public.apply_invoice_payment(text, text, integer, text), public.apply_credit_note(text, text, integer, integer, text),
  public.void_invoice(text), public.apply_invoice_refund(text, text, integer, text)
to service_role;
