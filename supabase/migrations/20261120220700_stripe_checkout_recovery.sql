alter table public.orders
  add column stripe_checkout_request jsonb,
  add column stripe_checkout_started_at timestamptz,
  add column stripe_replay_after timestamptz not null default now(),
  add column stripe_reconciliation_error text,
  add constraint orders_stripe_checkout_request_complete check (
    (stripe_checkout_request is null and stripe_checkout_started_at is null)
    or (stripe_checkout_request is not null and jsonb_typeof(stripe_checkout_request) = 'object' and stripe_checkout_started_at is not null)
  );

alter table public.provider_events add column stripe_replay_after timestamptz not null default now();

create index orders_stripe_replay_idx on public.orders (stripe_replay_after, hold_expires_at)
where payment_method = 'card' and fulfilment_status = 'awaiting_authorisation';
create index provider_events_stripe_replay_idx on public.provider_events (stripe_replay_after)
where provider = 'stripe' and state <> 'processed';

grant select (stripe_reconciliation_error) on public.orders to authenticated;
grant update (stripe_replay_after, stripe_reconciliation_error) on public.orders to service_role;
grant update (stripe_replay_after) on public.provider_events to service_role;

create function public.prepare_stripe_checkout(
  p_order_id uuid, p_request jsonb
) returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  if result.payment_method <> 'card' or result.fulfilment_status <> 'awaiting_authorisation'
    or result.payment_review_reason is not null or result.checkout_session_id is not null
    or result.stripe_checkout_request is not null then
    return result;
  end if;
  if result.hold_expires_at <= clock_timestamp() + interval '30 minutes 15 seconds' then
    return result;
  end if;
  if jsonb_typeof(p_request) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_stripe_checkout_request';
  end if;
  update public.orders set stripe_checkout_request = p_request, stripe_checkout_started_at = clock_timestamp()
  where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.close_unstarted_stripe_checkout(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  if result.payment_method = 'card' and result.fulfilment_status = 'awaiting_authorisation'
    and result.checkout_session_id is null and result.stripe_checkout_request is null
    and result.payment_review_reason is null and result.hold_expires_at <= clock_timestamp() then
    return public.release_reservation(p_order_id, 'stripe-unstarted', 'closed');
  end if;
  return result;
end;
$$;

revoke all on function public.prepare_stripe_checkout(uuid, jsonb),
  public.close_unstarted_stripe_checkout(uuid) from public, anon, authenticated;
grant execute on function public.prepare_stripe_checkout(uuid, jsonb),
  public.close_unstarted_stripe_checkout(uuid) to service_role;
