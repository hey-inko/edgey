create table public.trial_fulfilments (
  trial_request_id uuid primary key references public.trial_requests (id),
  state text not null default 'allocated' check (state in ('allocated', 'dispatched', 'cancelled')),
  recipient_name text not null check (length(btrim(recipient_name)) between 1 and 200),
  address_line1 text not null check (length(btrim(address_line1)) between 1 and 200),
  address_line2 text check (length(btrim(address_line2)) between 1 and 200),
  address_town text not null check (length(btrim(address_town)) between 1 and 100),
  address_region text check (length(btrim(address_region)) between 1 and 100),
  address_postcode private.uk_request_postcode not null,
  address_country text not null check (address_country = 'GB'),
  address_verified_at timestamptz not null,
  address_verified_by uuid not null,
  carrier text not null check (length(btrim(carrier)) between 1 and 100),
  carrier_service text not null check (length(btrim(carrier_service)) between 1 and 100),
  dispatched_at timestamptz,
  dispatched_by uuid,
  tracking_number text check (length(btrim(tracking_number)) between 1 and 200),
  cancelled_at timestamptz,
  cancelled_by uuid,
  subsequent_order_id uuid unique references public.orders (id),
  check ((state = 'dispatched' and dispatched_at is not null and dispatched_by is not null and tracking_number is not null)
    or (state <> 'dispatched' and num_nonnulls(dispatched_at, dispatched_by, tracking_number) = 0)),
  check ((state = 'cancelled' and cancelled_at is not null and cancelled_by is not null)
    or (state <> 'cancelled' and num_nonnulls(cancelled_at, cancelled_by) = 0)),
  check (subsequent_order_id is null or state = 'dispatched')
);

create table public.trial_allocations (
  trial_request_id uuid not null references public.trial_fulfilments (trial_request_id),
  variant_id uuid not null references public.variants (id),
  quantity integer not null check (quantity in (1, 2)),
  primary key (trial_request_id, variant_id)
);
create index trial_allocations_variant_idx on public.trial_allocations (variant_id);

alter table public.stock_movements
  add column trial_request_id uuid,
  add foreign key (trial_request_id, variant_id) references public.trial_allocations (trial_request_id, variant_id),
  drop constraint stock_movements_check,
  add constraint stock_movements_kind_deltas_and_source check (
    case kind
      when 'opening' then on_hand_delta > 0 and reserved_delta = 0
        and num_nonnulls(order_id, return_id, trial_request_id) = 0
      when 'receive' then on_hand_delta > 0 and reserved_delta = 0
        and num_nonnulls(order_id, return_id, trial_request_id) = 0
      when 'restore' then on_hand_delta > 0 and reserved_delta = 0
        and order_id is not null and return_id is not null and trial_request_id is null
      when 'reserve' then on_hand_delta = 0 and reserved_delta > 0 and return_id is null
        and num_nonnulls(order_id, trial_request_id) = 1
      when 'release' then on_hand_delta = 0 and reserved_delta < 0 and return_id is null
        and num_nonnulls(order_id, trial_request_id) = 1
      when 'dispatch' then on_hand_delta = reserved_delta and on_hand_delta < 0 and return_id is null
        and num_nonnulls(order_id, trial_request_id) = 1
    end
  );
create index stock_movements_trial_idx on public.stock_movements (trial_request_id, variant_id)
where trial_request_id is not null;

alter table public.trial_fulfilments enable row level security;
alter table public.trial_allocations enable row level security;
revoke all on public.trial_fulfilments, public.trial_allocations from public, anon, authenticated, service_role;
grant select on public.trial_fulfilments, public.trial_allocations to authenticated, service_role;
create policy trial_fulfilments_read on public.trial_fulfilments for select to authenticated
using ((select private.has_staff_role('warehouse')));
create policy trial_allocations_read on public.trial_allocations for select to authenticated
using ((select private.has_staff_role('warehouse', 'catalogue')));

create function private.lock_trial_request(p_trial_request_id uuid, p_actor_id uuid)
returns public.trial_requests
language plpgsql set search_path = ''
as $$
declare request public.trial_requests;
begin
  perform private.require_warehouse(p_actor_id);
  select * into strict request from public.trial_requests where id = p_trial_request_id for update;
  return request;
end;
$$;

create function private.apply_trial_stock_movement(
  p_kind public.stock_movement_kind, p_trial_request_id uuid, p_variant_id uuid, p_quantity integer, p_actor_id uuid
)
returns void
language plpgsql set search_path = ''
as $$
declare
  on_hand_change integer := case when p_kind = 'dispatch' then -p_quantity else 0 end;
  reserved_change integer := case when p_kind = 'reserve' then p_quantity else -p_quantity end;
begin
  insert into public.stock_movements (kind, operation_key, variant_id, trial_request_id, actor_id, on_hand_delta, reserved_delta)
  values (p_kind, 'trial:' || p_trial_request_id || ':' || p_kind || ':' || p_variant_id,
    p_variant_id, p_trial_request_id, p_actor_id, on_hand_change, reserved_change);
  update public.variants
  set stock_on_hand = stock_on_hand + on_hand_change, stock_reserved = stock_reserved + reserved_change
  where id = p_variant_id;
end;
$$;

create function public.approve_trial_fulfilment(
  p_trial_request_id uuid, p_actor_id uuid, p_variant_ids uuid[], p_address jsonb,
  p_carrier text, p_carrier_service text, p_address_verified boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  request public.trial_requests := private.lock_trial_request(p_trial_request_id, p_actor_id);
  fulfilment public.trial_fulfilments;
  item record;
  available integer;
begin
  if p_address_verified is distinct from true
    or exists (
      select 1 from unnest(array['recipient_name', 'line1', 'town', 'postcode', 'country']) as field
      where jsonb_typeof(p_address->field) is distinct from 'string'
    ) or coalesce(jsonb_typeof(p_address->'line2'), 'null') not in ('null', 'string')
      or coalesce(jsonb_typeof(p_address->'region'), 'null') not in ('null', 'string')
      or coalesce(length(btrim(p_carrier)), 0) not between 1 and 100
      or coalesce(length(btrim(p_carrier_service)), 0) not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'verified_delivery_address_and_service_required';
  end if;
  if coalesce(cardinality(p_variant_ids), 0) <> 2 or exists (
    select 1 from unnest(p_variant_ids) as v(id) where id is null
  ) then
    raise exception using errcode = '22023', message = 'two_trial_units_required';
  end if;

  select * into fulfilment from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if found then
    if (fulfilment.recipient_name, fulfilment.address_line1, fulfilment.address_line2, fulfilment.address_town,
        fulfilment.address_region, fulfilment.address_postcode, fulfilment.address_country,
        fulfilment.carrier, fulfilment.carrier_service, fulfilment.address_verified_by) is distinct from
       (btrim(p_address->>'recipient_name'), btrim(p_address->>'line1'), nullif(btrim(p_address->>'line2'), ''),
        btrim(p_address->>'town'), nullif(btrim(p_address->>'region'), ''), btrim(p_address->>'postcode'),
        btrim(p_address->>'country'), btrim(p_carrier), btrim(p_carrier_service), p_actor_id)
       or (
         select array_agg(variant_id order by variant_id) from public.trial_allocations
         cross join lateral generate_series(1, quantity) where trial_request_id = p_trial_request_id
       ) is distinct from (select array_agg(id order by id) from unnest(p_variant_ids) as v(id))
    then
      raise exception using errcode = '22023', message = 'trial_already_approved';
    end if;
    return p_trial_request_id;
  end if;
  if request.status not in ('pending', 'in_review') then
    raise exception using errcode = '22023', message = 'trial_not_approvable';
  end if;

  insert into public.trial_fulfilments (
    trial_request_id, recipient_name, address_line1, address_line2, address_town, address_region, address_postcode,
    address_country, address_verified_at, address_verified_by, carrier, carrier_service
  ) values (
    p_trial_request_id, btrim(p_address->>'recipient_name'), btrim(p_address->>'line1'),
    nullif(btrim(p_address->>'line2'), ''), btrim(p_address->>'town'), nullif(btrim(p_address->>'region'), ''),
    btrim(p_address->>'postcode'), btrim(p_address->>'country'), clock_timestamp(), p_actor_id,
    btrim(p_carrier), btrim(p_carrier_service)
  );
  for item in
    select id, count(*)::integer as quantity from unnest(p_variant_ids) as v(id) group by id order by id
  loop
    select stock_on_hand - stock_reserved into available from public.variants
    where id = item.id and publication_status = 'published' for no key update;
    if not found then
      raise exception using errcode = '22023', message = 'variant_not_published', detail = item.id::text;
    end if;
    if available < item.quantity then
      raise exception using errcode = 'P0001', message = 'insufficient_stock', detail = item.id::text;
    end if;
    insert into public.trial_allocations (trial_request_id, variant_id, quantity)
    values (p_trial_request_id, item.id, item.quantity);
    perform private.apply_trial_stock_movement('reserve', p_trial_request_id, item.id, item.quantity, p_actor_id);
  end loop;
  update public.trial_requests set status = 'approved' where id = p_trial_request_id;
  return p_trial_request_id;
end;
$$;

create function private.finish_trial_fulfilment(
  p_trial_request_id uuid, p_actor_id uuid, p_action public.stock_movement_kind, p_tracking_number text
)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  fulfilment public.trial_fulfilments;
  item public.trial_allocations;
begin
  perform private.lock_trial_request(p_trial_request_id, p_actor_id);
  select * into strict fulfilment from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if p_action = 'dispatch' and coalesce(length(btrim(p_tracking_number)), 0) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'trial_tracking_required';
  end if;
  if (p_action = 'dispatch' and fulfilment.state = 'dispatched'
      and (fulfilment.dispatched_by, fulfilment.tracking_number) = (p_actor_id, btrim(p_tracking_number)))
    or (p_action = 'release' and fulfilment.state = 'cancelled' and fulfilment.cancelled_by = p_actor_id)
  then
    return p_trial_request_id;
  end if;
  if fulfilment.state <> 'allocated' or p_action not in ('dispatch', 'release') or (
    select coalesce(sum(quantity), 0) from public.trial_allocations where trial_request_id = p_trial_request_id
  ) <> 2 then
    raise exception using errcode = '22023', message = 'trial_not_allocated';
  end if;

  for item in
    select * from public.trial_allocations where trial_request_id = p_trial_request_id order by variant_id
  loop
    perform private.apply_trial_stock_movement(p_action, p_trial_request_id, item.variant_id, item.quantity, p_actor_id);
  end loop;
  if p_action = 'dispatch' then
    update public.trial_fulfilments
    set state = 'dispatched', dispatched_at = clock_timestamp(), dispatched_by = p_actor_id,
      tracking_number = btrim(p_tracking_number)
    where trial_request_id = p_trial_request_id;
  else
    update public.trial_fulfilments
    set state = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = p_actor_id
    where trial_request_id = p_trial_request_id;
  end if;
  return p_trial_request_id;
end;
$$;

create function public.dispatch_trial_fulfilment(p_trial_request_id uuid, p_actor_id uuid, p_tracking_number text)
returns uuid
language sql security definer set search_path = ''
as $$
  select private.finish_trial_fulfilment(p_trial_request_id, p_actor_id, 'dispatch', p_tracking_number);
$$;

create function public.cancel_trial_fulfilment(p_trial_request_id uuid, p_actor_id uuid)
returns uuid
language sql security definer set search_path = ''
as $$
  select private.finish_trial_fulfilment(p_trial_request_id, p_actor_id, 'release', null);
$$;

create function public.link_trial_order(p_trial_request_id uuid, p_order_id uuid, p_actor_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  request public.trial_requests := private.lock_trial_request(p_trial_request_id, p_actor_id);
  fulfilment public.trial_fulfilments;
  purchase public.orders;
begin
  select * into strict fulfilment from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if fulfilment.subsequent_order_id = p_order_id then
    return p_trial_request_id;
  end if;
  if fulfilment.state <> 'dispatched' or fulfilment.subsequent_order_id is not null or p_order_id is null then
    raise exception using errcode = '22023', message = 'trial_order_link_not_available';
  end if;
  select * into strict purchase from public.orders where id = p_order_id;
  if purchase.created_at < fulfilment.dispatched_at or purchase.authorised_at is null
    or purchase.fulfilment_status = 'cancelled' or lower(btrim(purchase.email)) <> lower(btrim(request.email)) then
    raise exception using errcode = '22023', message = 'not_a_subsequent_purchase';
  end if;
  update public.trial_fulfilments set subsequent_order_id = p_order_id where trial_request_id = p_trial_request_id;
  return p_trial_request_id;
end;
$$;

comment on function public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean) is
  'Warehouse attests fit, eligibility, and that the named carrier service can deliver to the complete UK address. Supply exactly two variant IDs, repeating an ID for two of the same blade.';
comment on function public.link_trial_order(uuid, uuid, uuid) is
  'Warehouse may attribute one authorised, non-cancelled purchase created after dispatch and matching the trial email. An order can be attributed only once.';

revoke all on function
  private.lock_trial_request(uuid, uuid),
  private.apply_trial_stock_movement(public.stock_movement_kind, uuid, uuid, integer, uuid),
  private.finish_trial_fulfilment(uuid, uuid, public.stock_movement_kind, text),
  public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean),
  public.dispatch_trial_fulfilment(uuid, uuid, text),
  public.cancel_trial_fulfilment(uuid, uuid),
  public.link_trial_order(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean),
  public.dispatch_trial_fulfilment(uuid, uuid, text),
  public.cancel_trial_fulfilment(uuid, uuid),
  public.link_trial_order(uuid, uuid, uuid)
to service_role;
