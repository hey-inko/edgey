alter table public.orders
  add column stripe_checkout_request jsonb,
  add column stripe_checkout_started_at timestamptz,
  add column stripe_checkout_account_id text,
  add column stripe_replay_after timestamptz not null default now(),
  add column stripe_reconciliation_error text,
  add constraint orders_stripe_checkout_request_complete check (
    (stripe_checkout_request is null and stripe_checkout_started_at is null and stripe_checkout_account_id is null)
    or (stripe_checkout_request is not null and jsonb_typeof(stripe_checkout_request) = 'object'
      and stripe_checkout_started_at is not null and stripe_checkout_account_id is not null
      and stripe_checkout_account_id ~ '^acct_[A-Za-z0-9]+$')
  );

alter table public.provider_events add column stripe_replay_after timestamptz not null default now();

create index orders_stripe_replay_idx on public.orders (stripe_replay_after, hold_expires_at)
where payment_method = 'card' and fulfilment_status = 'awaiting_authorisation';
create index provider_events_stripe_replay_idx on public.provider_events (stripe_replay_after)
where provider = 'stripe' and state <> 'processed';

grant update (stripe_replay_after, stripe_reconciliation_error) on public.orders to service_role;
grant update (stripe_replay_after) on public.provider_events to service_role;

create function public.prepare_stripe_checkout(
  p_order_id uuid, p_request jsonb, p_account_id text
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
  update public.orders set stripe_checkout_request = p_request, stripe_checkout_started_at = clock_timestamp(),
    stripe_checkout_account_id = p_account_id
  where id = p_order_id returning * into result;
  return result;
end;
$$;

create function public.close_unbound_stripe_checkout(
  p_order_id uuid, p_account_id text default null, p_close_now boolean default false
)
returns public.orders
language plpgsql security definer set search_path = ''
as $$
declare result public.orders := private.lock_order(p_order_id);
begin
  if result.payment_method = 'card' and result.fulfilment_status = 'awaiting_authorisation'
    and result.checkout_session_id is null and result.payment_review_reason is null
    and (
      (result.stripe_checkout_request is null and (p_close_now or result.hold_expires_at <= clock_timestamp()))
      or (result.stripe_checkout_account_id = p_account_id
        and result.hold_expires_at + interval '2 minutes' <= clock_timestamp())
    ) then
    return public.release_reservation(p_order_id, 'stripe-unbound-closed', 'closed');
  end if;
  return result;
end;
$$;

revoke all on function public.prepare_stripe_checkout(uuid, jsonb, text),
  public.close_unbound_stripe_checkout(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.prepare_stripe_checkout(uuid, jsonb, text),
  public.close_unbound_stripe_checkout(uuid, text, boolean) to service_role;

create table private.closed_checkout_attempts (attempt_token uuid primary key);
alter table private.closed_checkout_attempts enable row level security;
revoke all on private.closed_checkout_attempts from public, anon, authenticated, service_role;

create function public.close_missing_checkout_attempt(p_attempt_token uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('order-attempt:' || p_attempt_token, 0));
  if exists (select 1 from public.orders where checkout_attempt_token = p_attempt_token) then
    return false;
  end if;
  insert into private.closed_checkout_attempts values (p_attempt_token) on conflict do nothing;
  return true;
end;
$$;
revoke all on function public.close_missing_checkout_attempt(uuid) from public, anon, authenticated;
grant execute on function public.close_missing_checkout_attempt(uuid) to service_role;

create function private.reject_closed_checkout_attempt()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.payment_method = 'card' and exists (
    select 1 from private.closed_checkout_attempts where attempt_token = new.checkout_attempt_token
  ) then
    raise exception using errcode = '22023', message = 'checkout_attempt_closed';
  end if;
  return new;
end;
$$;
revoke all on function private.reject_closed_checkout_attempt() from public, anon, authenticated, service_role;
create trigger orders_reject_closed_checkout_attempt before insert on public.orders
for each row execute function private.reject_closed_checkout_attempt();

create table private.payment_rate_limits (
  scope text not null check (scope in ('checkout', 'checkout_close', 'request_receipt')),
  dimension text not null check (dimension in ('ip', 'email')),
  key text not null check (key ~ '^[a-f0-9]{64}$'),
  attempts integer not null check (attempts > 0),
  expires_at timestamptz not null,
  primary key (scope, dimension, key)
);
create index payment_rate_limits_expiry_idx on private.payment_rate_limits (expires_at);
alter table private.payment_rate_limits enable row level security;
revoke all on private.payment_rate_limits from public, anon, authenticated, service_role;

create function private.prune_payment_rate_limits()
returns void
language sql set search_path = ''
as $$
  delete from private.payment_rate_limits using (
    select scope, dimension, key from private.payment_rate_limits
    where expires_at <= clock_timestamp()
    order by expires_at limit 50 for update skip locked
  ) expired
  where (payment_rate_limits.scope, payment_rate_limits.dimension, payment_rate_limits.key)
    = (expired.scope, expired.dimension, expired.key)
$$;
revoke all on function private.prune_payment_rate_limits() from public, anon, authenticated, service_role;

create function public.consume_checkout_rate_limit(p_scope text, p_ip_key text, p_email_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  dimension_limit record;
  checked_at timestamptz := clock_timestamp();
begin
  if p_scope is null or p_scope not in ('checkout', 'checkout_close')
    or p_ip_key is null or p_ip_key !~ '^[a-f0-9]{64}$'
    or p_email_key is null or p_email_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_checkout_rate_limit_input';
  end if;

  for dimension_limit in
    select * from (values
      (1, 'ip', p_ip_key, 10),
      (2, 'email', p_email_key, 3)
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
revoke all on function public.consume_checkout_rate_limit(text, text, text) from public, anon, authenticated;
grant execute on function public.consume_checkout_rate_limit(text, text, text) to service_role;
