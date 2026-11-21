alter table public.stock_movements
  add column adjustment_reason text,
  add column adjustment_note text,
  add column on_hand_before integer,
  add column on_hand_after integer,
  add column reserved_before integer,
  add column reserved_after integer,
  add constraint stock_movements_stock_snapshot check (
    num_nonnulls(on_hand_before, on_hand_after, reserved_before, reserved_after) = 0
    or (
      num_nonnulls(on_hand_before, on_hand_after, reserved_before, reserved_after) = 4
      and reserved_before >= 0 and reserved_before <= on_hand_before
      and reserved_after >= 0 and reserved_after <= on_hand_after
      and on_hand_after - on_hand_before = on_hand_delta
      and reserved_after - reserved_before = reserved_delta
    )
  ),
  add constraint stock_movements_adjustment check (
    case when kind = 'adjust' then
      actor_id is not null and on_hand_delta <> 0 and reserved_delta = 0
      and num_nonnulls(order_id, return_id, trial_request_id) = 0
      and adjustment_reason is not null
      and adjustment_reason in ('damaged', 'lost', 'sample_given', 'count_correction', 'returned_to_supplier', 'other')
      and (on_hand_delta < 0 or adjustment_reason in ('count_correction', 'other'))
      and (adjustment_note is null or (length(adjustment_note) <= 500 and adjustment_note ~ '[^[:space:]]'))
      and (adjustment_reason <> 'other' or adjustment_note is not null)
      and on_hand_before is not null
    else num_nonnulls(adjustment_reason, adjustment_note) = 0
    end
  );

create function private.snapshot_stock_movement()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  select stock_on_hand, stock_reserved into new.on_hand_before, new.reserved_before
  from public.variants where id = new.variant_id for no key update;
  if found then
    new.on_hand_after := new.on_hand_before + new.on_hand_delta;
    new.reserved_after := new.reserved_before + new.reserved_delta;
  end if;
  return new;
end;
$$;
revoke all on function private.snapshot_stock_movement() from public, anon, authenticated, service_role;

create trigger stock_movements_snapshot_on_insert
before insert on public.stock_movements for each row
when (new.kind <> 'opening')
execute function private.snapshot_stock_movement();

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

  select * into result from public.stock_movements where operation_key = p_key;
  if not found then
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
  end if;
  if (result.kind, result.variant_id, result.order_id, result.return_id, result.actor_id, result.on_hand_delta, result.reserved_delta)
      is distinct from (p_kind, p_variant_id, p_order_id, p_return_id, p_actor_id, p_on_hand_delta, p_reserved_delta) then
    raise exception using errcode = '22023', message = 'operation_key_conflict';
  end if;
  return result;
end;
$$;

create function public.adjust_staff_stock(
  p_variant_id uuid, p_operation_key text, p_quantity integer, p_reason text, p_note text default null
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  key text := 'adjust:' || p_operation_key;
  note text;
  movement public.stock_movements;
  stock public.variants;
  next_on_hand bigint;
begin
  if not private.has_staff_role('warehouse') then
    raise exception using errcode = '42501', message = 'warehouse_role_required';
  end if;
  note := nullif(regexp_replace(p_note, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if p_operation_key is null or p_operation_key !~ '[^[:space:]]' or length(p_operation_key) > 200
    or p_quantity is null or p_quantity = 0
    or p_reason is null or p_reason not in ('damaged', 'lost', 'sample_given', 'count_correction', 'returned_to_supplier', 'other')
    or (p_quantity > 0 and p_reason not in ('count_correction', 'other'))
    or (p_reason = 'other' and note is null) or length(note) > 500 then
    raise exception using errcode = '22023', message = 'invalid_stock_adjustment';
  end if;

  select * into stock from public.variants where id = p_variant_id for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'stock_variant_not_found';
  end if;

  select * into movement from public.stock_movements where operation_key = key;
  if not found then
    next_on_hand := stock.stock_on_hand::bigint + p_quantity;
    if next_on_hand < stock.stock_reserved then
      raise exception using errcode = '22023', message = 'stock_adjustment_below_reserved';
    end if;
    if next_on_hand > 2147483647 then
      raise exception using errcode = '22023', message = 'invalid_stock_adjustment';
    end if;
    insert into public.stock_movements (
      kind, operation_key, variant_id, actor_id, on_hand_delta, reserved_delta,
      adjustment_reason, adjustment_note, created_at
    ) values (
      'adjust', key, p_variant_id, actor, p_quantity, 0,
      p_reason, note, clock_timestamp()
    )
    on conflict (operation_key) do nothing
    returning * into movement;
    if found then
      update public.variants set stock_on_hand = next_on_hand where id = p_variant_id;
      return movement.id;
    end if;
    select * into strict movement from public.stock_movements where operation_key = key;
  end if;

  if (movement.kind, movement.variant_id, movement.actor_id, movement.on_hand_delta, movement.adjustment_reason, movement.adjustment_note)
      is distinct from ('adjust'::public.stock_movement_kind, p_variant_id, actor, p_quantity, p_reason, note) then
    raise exception using errcode = '22023', message = 'operation_key_conflict';
  end if;
  return movement.id;
end;
$$;

create table public.staff_variant_costs (
  variant_id uuid primary key references public.variants (id),
  supplier_unit_minor integer not null check (supplier_unit_minor >= 0),
  currency text not null check (currency in ('GBP', 'USD', 'EUR')),
  landed_unit_pence integer not null check (landed_unit_pence >= 0),
  exchange_rate numeric check (exchange_rate > 0 and exchange_rate <= 1000000 and scale(exchange_rate) <= 8),
  freight_unit_pence integer check (freight_unit_pence >= 0),
  duty_unit_pence integer check (duty_unit_pence >= 0),
  note text check (length(note) <= 500),
  actor_id uuid not null,
  recorded_at timestamptz not null
);

create table public.staff_receipt_costs (
  stock_movement_id bigint primary key references public.stock_movements (id),
  variant_id uuid not null references public.variants (id),
  received_quantity integer not null check (received_quantity > 0),
  supplier_unit_minor integer not null check (supplier_unit_minor >= 0),
  currency text not null check (currency in ('GBP', 'USD', 'EUR')),
  landed_unit_pence integer not null check (landed_unit_pence >= 0),
  exchange_rate numeric check (exchange_rate > 0 and exchange_rate <= 1000000 and scale(exchange_rate) <= 8),
  freight_unit_pence integer check (freight_unit_pence >= 0),
  duty_unit_pence integer check (duty_unit_pence >= 0),
  note text check (length(note) <= 500),
  actor_id uuid not null,
  recorded_at timestamptz not null
);
create index staff_receipt_costs_latest_idx on public.staff_receipt_costs (variant_id, stock_movement_id desc);

create table public.staff_variant_cost_audit (
  id bigint generated always as identity primary key,
  variant_id uuid not null references public.variants (id),
  old_cost jsonb,
  new_cost jsonb not null,
  actor_id uuid not null,
  recorded_at timestamptz not null
);
create index staff_variant_cost_audit_variant_idx on public.staff_variant_cost_audit (variant_id, id);

alter table public.staff_variant_costs enable row level security;
alter table public.staff_receipt_costs enable row level security;
alter table public.staff_variant_cost_audit enable row level security;
revoke all on public.staff_variant_costs, public.staff_receipt_costs, public.staff_variant_cost_audit
  from public, anon, authenticated, service_role;
grant select on public.staff_variant_costs, public.staff_receipt_costs, public.staff_variant_cost_audit to authenticated;

create policy staff_variant_costs_read on public.staff_variant_costs for select to authenticated
  using ((select private.has_staff_role('catalogue', 'finance')));
create policy staff_receipt_costs_read on public.staff_receipt_costs for select to authenticated
  using ((select private.has_staff_role('catalogue', 'finance')));
create policy staff_variant_cost_audit_read on public.staff_variant_cost_audit for select to authenticated
  using ((select private.has_staff_role('catalogue', 'finance')));

create view public.staff_current_variant_costs with (security_invoker = true) as
  (
    select distinct on (variant_id)
      variant_id, 'receipt'::text as source, stock_movement_id, received_quantity,
      supplier_unit_minor, currency, landed_unit_pence, exchange_rate, freight_unit_pence,
      duty_unit_pence, note, actor_id, recorded_at
    from public.staff_receipt_costs
    order by variant_id, stock_movement_id desc
  )
  union all
  select e.variant_id, 'estimate', null::bigint, null::integer,
    e.supplier_unit_minor, e.currency, e.landed_unit_pence, e.exchange_rate, e.freight_unit_pence,
    e.duty_unit_pence, e.note, e.actor_id, e.recorded_at
  from public.staff_variant_costs e
  where not exists (select 1 from public.staff_receipt_costs r where r.variant_id = e.variant_id);

revoke all on public.staff_current_variant_costs from public, anon, authenticated, service_role;
grant select on public.staff_current_variant_costs to authenticated;

create function private.parse_staff_unit_cost(p_cost jsonb)
returns table (
  supplier_unit_minor integer, currency text, landed_unit_pence integer, exchange_rate numeric,
  freight_unit_pence integer, duty_unit_pence integer, note text
)
language plpgsql immutable set search_path = ''
as $$
declare
  field text;
  amount numeric;
begin
  if jsonb_typeof(p_cost) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_staff_cost';
  end if;
  if p_cost - array['supplier_unit_minor', 'currency', 'landed_unit_pence', 'exchange_rate',
      'freight_unit_pence', 'duty_unit_pence', 'note'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'invalid_staff_cost';
  end if;

  foreach field in array array['supplier_unit_minor', 'landed_unit_pence', 'freight_unit_pence', 'duty_unit_pence'] loop
    if field in ('freight_unit_pence', 'duty_unit_pence') and p_cost->>field is null then
      continue;
    end if;
    if jsonb_typeof(p_cost->field) is distinct from 'number' then
      raise exception using errcode = '22023', message = 'invalid_staff_cost';
    end if;
    amount := (p_cost->>field)::numeric;
    if amount < 0 or amount > 2147483647 or amount <> trunc(amount) then
      raise exception using errcode = '22023', message = 'invalid_staff_cost';
    end if;
  end loop;

  currency := p_cost->>'currency';
  if currency is null or currency not in ('GBP', 'USD', 'EUR')
    or coalesce(jsonb_typeof(p_cost->'note'), 'null') not in ('null', 'string') then
    raise exception using errcode = '22023', message = 'invalid_staff_cost';
  end if;

  if p_cost->>'exchange_rate' is not null then
    if jsonb_typeof(p_cost->'exchange_rate') <> 'number'
      and (jsonb_typeof(p_cost->'exchange_rate') <> 'string'
        or p_cost->>'exchange_rate' !~ '^[0-9]{1,7}([.][0-9]{1,8})?$') then
      raise exception using errcode = '22023', message = 'invalid_staff_cost';
    end if;
    exchange_rate := trim_scale((p_cost->>'exchange_rate')::numeric);
    if exchange_rate <= 0 or exchange_rate > 1000000 or scale(exchange_rate) > 8 then
      raise exception using errcode = '22023', message = 'invalid_staff_cost';
    end if;
  end if;

  note := nullif(regexp_replace(p_cost->>'note', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if length(note) > 500 then
    raise exception using errcode = '22023', message = 'invalid_staff_cost';
  end if;
  supplier_unit_minor := (p_cost->>'supplier_unit_minor')::numeric::integer;
  landed_unit_pence := (p_cost->>'landed_unit_pence')::numeric::integer;
  freight_unit_pence := (p_cost->>'freight_unit_pence')::numeric::integer;
  duty_unit_pence := (p_cost->>'duty_unit_pence')::numeric::integer;
  return next;
end;
$$;

create function public.set_staff_variant_cost(p_variant_id uuid, p_cost jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  cost record;
  previous_cost jsonb;
  changed_at timestamptz;
begin
  if not private.has_staff_role('catalogue', 'finance') then
    raise exception using errcode = '42501', message = 'staff_cost_role_required';
  end if;
  select * into cost from private.parse_staff_unit_cost(p_cost);

  perform 1 from public.variants where id = p_variant_id for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'stock_variant_not_found';
  end if;
  select to_jsonb(e) - array['variant_id', 'actor_id', 'recorded_at'] into previous_cost
  from public.staff_variant_costs e where variant_id = p_variant_id;
  if exists (select 1 from public.staff_receipt_costs where variant_id = p_variant_id) then
    raise exception using errcode = '22023', message = 'staff_cost_stale';
  end if;
  if previous_cost = to_jsonb(cost) then
    return p_variant_id;
  end if;
  changed_at := clock_timestamp();

  insert into public.staff_variant_costs (
    variant_id, supplier_unit_minor, currency, landed_unit_pence, exchange_rate, freight_unit_pence,
    duty_unit_pence, note, actor_id, recorded_at
  ) values (
    p_variant_id, cost.supplier_unit_minor, cost.currency, cost.landed_unit_pence, cost.exchange_rate,
    cost.freight_unit_pence, cost.duty_unit_pence, cost.note, actor, changed_at
  )
  on conflict (variant_id) do update set
    supplier_unit_minor = excluded.supplier_unit_minor, currency = excluded.currency,
    landed_unit_pence = excluded.landed_unit_pence, exchange_rate = excluded.exchange_rate,
    freight_unit_pence = excluded.freight_unit_pence, duty_unit_pence = excluded.duty_unit_pence,
    note = excluded.note, actor_id = excluded.actor_id, recorded_at = excluded.recorded_at;

  insert into public.staff_variant_cost_audit (variant_id, old_cost, new_cost, actor_id, recorded_at)
  values (p_variant_id, previous_cost, to_jsonb(cost), actor, changed_at);
  return p_variant_id;
end;
$$;

create function public.receive_staff_stock_with_cost(p_variant_id uuid, p_operation_key text, p_quantity integer, p_cost jsonb)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  key text := 'receive:' || p_operation_key;
  cost record;
  movement public.stock_movements;
  existing_receipt boolean;
  previous_cost jsonb;
begin
  if not private.has_staff_role('warehouse') then
    raise exception using errcode = '42501', message = 'warehouse_role_required';
  end if;
  if not private.has_staff_role('catalogue', 'finance') then
    raise exception using errcode = '42501', message = 'staff_cost_role_required';
  end if;
  if p_operation_key is null or p_operation_key !~ '[^[:space:]]' or length(p_operation_key) > 200
    or p_quantity is null or p_quantity <= 0 then
    raise exception using errcode = '22023', message = 'invalid_stock_receipt';
  end if;
  select * into cost from private.parse_staff_unit_cost(p_cost);

  perform 1 from public.variants where id = p_variant_id for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'stock_variant_not_found';
  end if;
  existing_receipt := exists (select 1 from public.stock_movements where operation_key = key);
  movement := private.apply_stock_movement('receive', key, p_variant_id, p_quantity, 0, null, null, actor);
  if existing_receipt then
    select to_jsonb(r) - array['stock_movement_id', 'variant_id', 'received_quantity', 'actor_id', 'recorded_at']
      into previous_cost
    from public.staff_receipt_costs r where stock_movement_id = movement.id;
    if previous_cost is distinct from to_jsonb(cost) then
      raise exception using errcode = '22023', message = 'operation_key_conflict';
    end if;
    return movement.id;
  end if;

  insert into public.staff_receipt_costs (
    stock_movement_id, variant_id, received_quantity, supplier_unit_minor, currency, landed_unit_pence,
    exchange_rate, freight_unit_pence, duty_unit_pence, note, actor_id, recorded_at
  ) values (
    movement.id, movement.variant_id, movement.on_hand_delta, cost.supplier_unit_minor, cost.currency,
    cost.landed_unit_pence, cost.exchange_rate, cost.freight_unit_pence, cost.duty_unit_pence,
    cost.note, movement.actor_id, clock_timestamp()
  );
  return movement.id;
end;
$$;

revoke all on function private.parse_staff_unit_cost(jsonb),
  public.adjust_staff_stock(uuid, text, integer, text, text),
  public.set_staff_variant_cost(uuid, jsonb),
  public.receive_staff_stock_with_cost(uuid, text, integer, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.adjust_staff_stock(uuid, text, integer, text, text),
  public.set_staff_variant_cost(uuid, jsonb),
  public.receive_staff_stock_with_cost(uuid, text, integer, jsonb)
to authenticated;
