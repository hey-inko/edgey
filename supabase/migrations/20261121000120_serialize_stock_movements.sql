create or replace function private.apply_stock_movement(
  p_kind public.stock_movement_kind, p_key text, p_variant_id uuid,
  p_on_hand_delta integer, p_reserved_delta integer,
  p_order_id uuid default null, p_return_id uuid default null, p_actor_id uuid default null
)
returns public.stock_movements
language plpgsql set search_path = ''
as $$
declare result public.stock_movements;
begin
  perform 1 from public.variants where id = p_variant_id for no key update;

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

revoke all on function private.apply_stock_movement(public.stock_movement_kind, text, uuid, integer, integer, uuid, uuid, uuid)
from public, anon, authenticated, service_role;
