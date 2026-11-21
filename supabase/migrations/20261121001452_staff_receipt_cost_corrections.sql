alter table public.staff_variant_cost_audit
  add column stock_movement_id bigint references public.staff_receipt_costs (stock_movement_id),
  add constraint receipt_cost_correction_requires_old_cost check (stock_movement_id is null or old_cost is not null);

create index staff_variant_cost_audit_receipt_idx
  on public.staff_variant_cost_audit (stock_movement_id, id desc) where stock_movement_id is not null;

create view public.staff_effective_receipt_costs with (security_invoker = true) as
select r.stock_movement_id, r.variant_id, r.received_quantity, effective.supplier_unit_minor,
  effective.currency, effective.landed_unit_pence, effective.exchange_rate, effective.freight_unit_pence,
  effective.duty_unit_pence, effective.note, effective.actor_id, effective.recorded_at
from public.staff_receipt_costs r
left join lateral (
  select a.new_cost, a.actor_id, a.recorded_at
  from public.staff_variant_cost_audit a
  where a.stock_movement_id = r.stock_movement_id
  order by a.id desc limit 1
) correction on true
cross join lateral jsonb_populate_record(r, coalesce(
  correction.new_cost || jsonb_build_object('actor_id', correction.actor_id, 'recorded_at', correction.recorded_at),
  '{}'::jsonb
)) effective;

revoke all on public.staff_effective_receipt_costs from public, anon, authenticated, service_role;
grant select on public.staff_effective_receipt_costs to authenticated;

create or replace view public.staff_current_variant_costs with (security_invoker = true) as
  (
    select distinct on (variant_id)
      variant_id, 'receipt'::text as source, stock_movement_id, received_quantity,
      supplier_unit_minor, currency, landed_unit_pence, exchange_rate, freight_unit_pence,
      duty_unit_pence, note, actor_id, recorded_at
    from public.staff_effective_receipt_costs
    order by variant_id, stock_movement_id desc
  )
  union all
  select e.variant_id, 'estimate', null::bigint, null::integer,
    e.supplier_unit_minor, e.currency, e.landed_unit_pence, e.exchange_rate, e.freight_unit_pence,
    e.duty_unit_pence, e.note, e.actor_id, e.recorded_at
  from public.staff_variant_costs e
  where not exists (select 1 from public.staff_receipt_costs r where r.variant_id = e.variant_id);

create function public.correct_staff_receipt_cost(
  p_variant_id uuid, p_stock_movement_id bigint, p_expected_recorded_at timestamptz, p_cost jsonb
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  receipt public.staff_effective_receipt_costs;
  cost jsonb;
  previous_cost jsonb;
begin
  if not private.has_staff_role('catalogue', 'finance') then
    raise exception using errcode = '42501', message = 'staff_cost_role_required';
  end if;
  select to_jsonb(parsed) into strict cost from private.parse_staff_unit_cost(p_cost) parsed;
  perform 1 from public.variants where id = p_variant_id for no key update;
  select * into receipt from public.staff_effective_receipt_costs
  where variant_id = p_variant_id
    and stock_movement_id = (
      select max(r.stock_movement_id) from public.staff_receipt_costs r where r.variant_id = p_variant_id
    );
  if not found or receipt.stock_movement_id is distinct from p_stock_movement_id then
    raise exception using errcode = '22023', message = 'staff_cost_stale';
  end if;
  previous_cost := to_jsonb(receipt) -
    array['variant_id', 'stock_movement_id', 'received_quantity', 'actor_id', 'recorded_at'];
  if previous_cost = cost then
    return p_stock_movement_id;
  end if;
  if receipt.recorded_at is distinct from p_expected_recorded_at then
    raise exception using errcode = '22023', message = 'staff_cost_stale';
  end if;
  insert into public.staff_variant_cost_audit (variant_id, stock_movement_id, old_cost, new_cost, actor_id, recorded_at)
  values (p_variant_id, p_stock_movement_id, previous_cost, cost, auth.uid(), clock_timestamp());
  return p_stock_movement_id;
end;
$$;

revoke all on function public.correct_staff_receipt_cost(uuid, bigint, timestamptz, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.correct_staff_receipt_cost(uuid, bigint, timestamptz, jsonb) to authenticated;
