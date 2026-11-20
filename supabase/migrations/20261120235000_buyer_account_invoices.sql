alter table public.orders
  add column buyer_invoice_url text,
  add constraint orders_buyer_invoice_url_check check (
    buyer_invoice_url is null or (
      provider_invoice_id is not null
      and length(buyer_invoice_url) <= 2048
      and buyer_invoice_url ~ '^https://invoice[.]stripe[.]com/i/[A-Za-z0-9_/-]+([?][A-Za-z0-9_=&%-]+)?$'
    )
  );

grant select (buyer_invoice_url) on public.orders to authenticated;

create function public.set_buyer_invoice_url(p_order_id uuid, p_provider_invoice_id text, p_url text)
returns boolean language sql security definer set search_path = ''
as $$
  with updated as (
    update public.orders
    set buyer_invoice_url = p_url
    where id = p_order_id and buyer_id is not null
      and provider_invoice_id = p_provider_invoice_id
      and p_url is not null
    returning id
  )
  select exists (select 1 from updated);
$$;
revoke all on function public.set_buyer_invoice_url(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_buyer_invoice_url(uuid, text, text) to service_role;
