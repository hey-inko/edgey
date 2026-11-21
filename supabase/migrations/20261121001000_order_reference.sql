create sequence private.order_reference_seq maxvalue 99999999;
revoke all on sequence private.order_reference_seq from public, anon, authenticated, service_role;

alter table public.orders
  add column order_reference text not null unique
    default ('EDG-' || lpad(nextval('private.order_reference_seq'::regclass)::text, 8, '0'))
    check (order_reference ~ '^EDG-[0-9]{8}$');

create function private.protect_order_reference()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'order_reference_is_immutable';
end;
$$;
revoke all on function private.protect_order_reference() from public, anon, authenticated, service_role;

create trigger orders_protect_reference before update on public.orders
for each row when (old.order_reference is distinct from new.order_reference)
execute function private.protect_order_reference();

grant select (order_reference) on public.orders to authenticated;
