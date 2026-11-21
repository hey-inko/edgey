create index order_operations_refund_key_idx on private.order_operations (operation_key) where action = 'refund';
create index orders_payment_review_refund_idx on public.orders (payment_review_refund_id) where payment_review_refund_id is not null;

create function public.has_recorded_stripe_refund(p_refund_id text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.order_operations where action = 'refund' and operation_key = p_refund_id
    union all
    select 1 from public.orders where payment_review_refund_id = p_refund_id
    union all
    select 1 from public.credit_ledger where kind = 'refund' and operation_key = p_refund_id
  );
$$;
revoke all on function public.has_recorded_stripe_refund(text) from public, anon, authenticated;
grant execute on function public.has_recorded_stripe_refund(text) to service_role;
