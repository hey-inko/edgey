alter table public.orders
  add column stripe_net30_started_at timestamptz,
  add column stripe_net30_account_id text,
  add column stripe_net30_invoice_id text unique check (stripe_net30_invoice_id ~ '^in_[A-Za-z0-9]{1,197}$'),
  add column stripe_net30_sent boolean not null default false,
  add constraint orders_stripe_net30_attempt_check check (
    (stripe_net30_started_at is null) = (stripe_net30_account_id is null)
    and (stripe_net30_started_at is null or payment_method = 'net30')
    and (stripe_net30_invoice_id is null or stripe_net30_started_at is not null)
    and (not stripe_net30_sent or stripe_net30_invoice_id is not null)
  );

grant update (stripe_net30_invoice_id, stripe_net30_sent) on public.orders to service_role;

create index orders_stripe_net30_reconcile_idx on public.orders (stripe_replay_after, id)
where payment_method = 'net30' and
  (fulfilment_status = 'awaiting_authorisation' or provider_invoice_id is not null);

create function public.start_net30_invoice(p_order_id uuid, p_account_id text)
returns setof public.orders
language plpgsql security definer set search_path = ''
as $$
declare target public.orders := private.lock_net30_order(p_order_id);
begin
  if coalesce(p_account_id, '') !~ '^acct_[A-Za-z0-9]{1,195}$' then
    raise exception using errcode = '22023', message = 'invalid_stripe_account';
  end if;
  if target.fulfilment_status = 'awaiting_authorisation' and target.stripe_net30_started_at is null
    and target.hold_expires_at > clock_timestamp() then
    update public.orders set stripe_net30_started_at = clock_timestamp(), stripe_net30_account_id = p_account_id
    where id = target.id returning * into target;
  end if;
  return next target;
end;
$$;

create function public.close_unstarted_net30_order(p_order_id uuid)
returns setof public.orders
language plpgsql security definer set search_path = ''
as $$
declare target public.orders := private.lock_net30_order(p_order_id);
begin
  if target.fulfilment_status = 'awaiting_authorisation' and target.stripe_net30_started_at is null
    and target.provider_invoice_id is null then
    target := public.release_credit_hold(target.id, 'net30-unstarted:' || target.id, 'not_created');
  end if;
  return next target;
end;
$$;

create function public.bind_issued_net30_invoice(
  p_order_id uuid, p_provider_invoice_id text, p_stripe_customer_id text,
  p_amount_due_pence integer, p_currency text, p_issued_at timestamptz, p_due_at timestamptz,
  p_authorised_at timestamptz, p_dispatch_date date, p_delivery_date date
)
returns setof public.orders
language plpgsql security definer set search_path = ''
as $$
declare
  target public.orders := private.lock_net30_order(p_order_id);
  first_issue boolean := target.provider_invoice_id is null;
begin
  if not target.stripe_net30_sent or target.stripe_net30_invoice_id is distinct from p_provider_invoice_id
    or p_authorised_at is null or not isfinite(p_authorised_at)
    or p_authorised_at > clock_timestamp() + interval '2 minutes' then
    raise exception using errcode = '22023', message = 'net30_invoice_send_not_confirmed';
  end if;
  target := public.bind_invoice(p_order_id, p_provider_invoice_id, p_stripe_customer_id,
    p_amount_due_pence, p_currency, p_issued_at, p_due_at, p_dispatch_date, p_delivery_date);
  if first_issue and target.fulfilment_status = 'ready_to_pick' then
    update public.orders set authorised_at = p_authorised_at where id = target.id returning * into target;
  end if;
  return next target;
end;
$$;

revoke all on function public.start_net30_invoice(uuid, text), public.close_unstarted_net30_order(uuid)
from public, anon, authenticated;
grant execute on function public.start_net30_invoice(uuid, text), public.close_unstarted_net30_order(uuid) to service_role;
revoke all on function public.bind_issued_net30_invoice(uuid, text, text, integer, text, timestamptz, timestamptz,
  timestamptz, date, date) from public, anon, authenticated;
grant execute on function public.bind_issued_net30_invoice(uuid, text, text, integer, text, timestamptz, timestamptz,
  timestamptz, date, date) to service_role;
