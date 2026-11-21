create extension if not exists pgcrypto with schema extensions;

create function private.order_reference_check(p_payload text)
returns text
language plpgsql immutable strict set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTVWXYZ';
  total integer := 0;
begin
  for i in 1..12 loop
    total := total + (strpos(alphabet, substr(p_payload, i, 1)) - 1) * (1 + (i - 1) % 2);
  end loop;
  return substr(alphabet, total % 31 + 1, 1);
end;
$$;

create function private.random_order_reference()
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTVWXYZ';
  payload text := '';
  entropy bytea;
  digit integer;
begin
  while length(payload) < 12 loop
    entropy := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      digit := get_byte(entropy, i);
      if digit < 248 then
        payload := payload || substr(alphabet, digit % 31 + 1, 1);
        exit when length(payload) = 12;
      end if;
    end loop;
  end loop;
  return 'EDG-' || substr(payload, 1, 4) || '-' || substr(payload, 5, 4) || '-'
    || substr(payload, 9) || private.order_reference_check(payload);
end;
$$;

revoke all on function private.order_reference_check(text), private.random_order_reference()
  from public, anon, authenticated, service_role;
grant execute on function private.order_reference_check(text) to service_role;

alter table public.orders
  alter column order_reference set default private.random_order_reference(),
  drop constraint orders_order_reference_check,
  add constraint orders_order_reference_check check (
    order_reference ~ '^EDG-[0-9]{8}$'
    or (
      order_reference ~ '^EDG-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{5}$'
      and right(order_reference, 1) = private.order_reference_check(left(replace(substr(order_reference, 5), '-', ''), 12))
    )
  );

drop sequence private.order_reference_seq;
