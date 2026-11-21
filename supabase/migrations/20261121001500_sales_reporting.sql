create index orders_sales_authorisation_idx on public.orders (authorised_at)
where authorised_at is not null and (fulfilment_status <> 'cancelled' or dispatched_at is not null);

create index orders_sales_identity_idx on public.orders (
  (coalesce(buyer_id::text, lower(btrim(email)))), authorised_at
)
where authorised_at is not null and (fulfilment_status <> 'cancelled' or dispatched_at is not null);

create index order_operations_sales_refunds_idx on private.order_operations (created_at)
where action = 'refund';

create index credit_ledger_sales_adjustments_idx on public.credit_ledger (created_at)
where kind in ('refund', 'credit_note', 'void');

create index stock_movements_sales_receipts_idx on public.stock_movements (variant_id, created_at desc, id desc)
where kind = 'receive';

create function public.admin_sales_report(p_from date, p_to date, p_grain text default 'day')
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  can_see_margin boolean;
  days integer;
  prior_from date;
  prior_start timestamptz;
  range_start timestamptz;
  range_end timestamptz;
  result jsonb;
begin
  if not private.has_staff_role('warehouse', 'catalogue', 'finance') then
    raise exception using errcode = '42501', message = 'staff_sales_role_required';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_from < date '1900-01-01' or p_to < p_from or p_to > (now() at time zone 'Europe/London')::date then
    raise exception using errcode = '22023', message = 'invalid_sales_range';
  end if;
  if p_to > p_from + 365 then
    raise exception using errcode = '22023', message = 'invalid_sales_range';
  end if;
  if p_grain is null or p_grain not in ('day', 'week', 'month') then
    raise exception using errcode = '22023', message = 'invalid_sales_grain';
  end if;

  can_see_margin := private.has_staff_role('finance');
  days := p_to - p_from + 1;
  prior_from := p_from - days;
  prior_start := prior_from::timestamp at time zone 'Europe/London';
  range_start := p_from::timestamp at time zone 'Europe/London';
  range_end := (p_to + 1)::timestamp at time zone 'Europe/London';

  with bookings as materialized (
    select o.id, o.authorised_at, (o.authorised_at at time zone 'Europe/London')::date as day,
      o.payment_method, coalesce(o.buyer_id::text, lower(btrim(o.email))) as identity,
      o.goods_net_pence, o.vat_pence, o.delivery_net_pence
    from public.orders o
    where o.authorised_at >= prior_start and o.authorised_at < range_end
      and (o.fulfilment_status <> 'cancelled' or o.dispatched_at is not null)
  ), lines as materialized (
    select b.id as order_id, b.day, i.variant_id, i.quantity, i.net_pence,
      i.net_pence - i.quantity::bigint * coalesce(effective.landed_unit_pence, estimate.landed_unit_pence)
        as margin_pence
    from bookings b
    join public.order_items i on i.order_id = b.id
    left join lateral (
      select m.id
      from public.stock_movements m
      join public.staff_receipt_costs r on r.stock_movement_id = m.id
      where can_see_margin and m.kind = 'receive' and m.variant_id = i.variant_id
        and m.created_at <= b.authorised_at
      order by m.created_at desc, m.id desc limit 1
    ) receipt on true
    left join public.staff_effective_receipt_costs effective on effective.stock_movement_id = receipt.id
    left join public.staff_variant_costs estimate
      on can_see_margin and receipt.id is null and estimate.variant_id = i.variant_id
  ), order_units as (
    select order_id, sum(quantity) as units, sum(margin_pence) as margin_pence,
      bool_or(margin_pence is null) as cost_unknown
    from lines group by order_id
  ), booking_totals as materialized (
    select b.*, coalesce(u.units, 0) as units, coalesce(u.margin_pence, 0) as margin_pence,
      coalesce(u.cost_unknown, false) as cost_unknown
    from bookings b left join order_units u on b.id = u.order_id
  ), booked_days as (
    select day, sum(goods_net_pence) as revenue, sum(vat_pence) as vat, sum(delivery_net_pence) as delivery,
      count(*) as orders, sum(units) as units, sum(margin_pence) as margin_pence,
      bool_or(cost_unknown) as cost_unknown
    from booking_totals group by day
  ), adjustment_events as (
    select (op.created_at at time zone 'Europe/London')::date as day,
      (op.input->>1)::integer as refund, 0 as credit
    from private.order_operations op
    join public.orders o on o.id = op.order_id and o.payment_method = 'card'
    where op.action = 'refund' and op.created_at >= prior_start and op.created_at < range_end
    union all
    select (l.created_at at time zone 'Europe/London')::date,
      case when l.kind = 'refund' then (l.input->>0)::integer else 0 end,
      -l.outstanding_delta_pence
    from public.credit_ledger l
    where l.kind in ('refund', 'credit_note', 'void') and l.created_at >= prior_start and l.created_at < range_end
  ), adjustment_days as (
    select day, sum(refund) as refunds, sum(credit) as credits from adjustment_events group by day
  ), calendar as (
    select prior_from + g.offset_days as day from generate_series(0, days * 2 - 1) as g(offset_days)
  ), daily as materialized (
    select c.day, coalesce(b.revenue, 0) as revenue, coalesce(b.vat, 0) as vat,
      coalesce(b.delivery, 0) as delivery, coalesce(b.orders, 0) as orders, coalesce(b.units, 0) as units,
      coalesce(b.margin_pence, 0) as margin_pence, coalesce(b.cost_unknown, false) as cost_unknown,
      coalesce(a.refunds, 0) as refunds, coalesce(a.credits, 0) as credits
    from calendar c left join booked_days b using (day) left join adjustment_days a using (day)
  ), period_totals as (
    select case when day >= p_from then 'current' else 'previous' end as period,
      sum(revenue) as revenue, sum(vat) as vat, sum(delivery) as delivery, sum(orders) as orders,
      sum(units) as units, sum(refunds) as refunds, sum(credits) as credits,
      case when can_see_margin and not bool_or(cost_unknown) then sum(margin_pence) end as margin_pence
    from daily group by 1
  ), period_json as (
    select jsonb_object_agg(period, jsonb_build_object(
      'revenuePence', revenue, 'vatPence', vat, 'deliveryPence', delivery, 'orders', orders, 'units', units,
      'refundsPence', refunds, 'creditsPence', credits,
      'aovPence', round(revenue / nullif(orders, 0)),
      'marginPence', margin_pence, 'marginBps', round(10000 * margin_pence / nullif(revenue, 0))
    )) as data
    from period_totals
  ), bucket_totals as (
    select bucket.kind, bucket.day, sum(revenue) as revenue, sum(vat) as vat, sum(delivery) as delivery,
      sum(orders) as orders, sum(units) as units, sum(refunds) as refunds, sum(credits) as credits
    from daily d
    cross join lateral (values ('daily', d.day), ('series', date_trunc(p_grain, d.day::timestamp)::date))
      as bucket(kind, day)
    where d.day >= p_from
    group by bucket.kind, bucket.day
  ), series_json as (
    select kind, jsonb_agg(jsonb_build_object(
      'date', to_char(day, 'YYYY-MM-DD'), 'revenuePence', revenue, 'vatPence', vat, 'deliveryPence', delivery,
      'orders', orders, 'units', units, 'refundsPence', refunds, 'creditsPence', credits
    ) order by day) as data
    from bucket_totals group by kind
  ), current_lines as materialized (
    select * from lines where day >= p_from
  ), product_totals as (
    select variant_id, sum(quantity) as units, sum(net_pence) as revenue, sum(margin_pence) as margin_pence,
      bool_or(margin_pence is null) as cost_unknown
    from current_lines group by variant_id
  ), product_rows as (
    select v.id, v.sku, p.name, coalesce(t.units, 0) as units, coalesce(t.revenue, 0) as revenue,
      v.stock_on_hand - v.stock_reserved as available,
      case when can_see_margin and not coalesce(t.cost_unknown, false) then coalesce(t.margin_pence, 0) end
        as margin_pence,
      case when can_see_margin then coalesce(t.cost_unknown, false) end as cost_unknown
    from public.variants v
    join public.products p on p.id = v.product_id
    left join product_totals t on t.variant_id = v.id
    where v.publication_status = 'published' or t.variant_id is not null
  ), products_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'sku', p.sku, 'name', p.name, 'units', p.units, 'revenuePence', p.revenue,
      'marginPence', p.margin_pence, 'marginBps', round(10000 * p.margin_pence / nullif(p.revenue, 0)),
      'shareBps', round(10000 * p.revenue::numeric / nullif(k.revenue, 0)),
      'available', p.available, 'weeklyUnits', p.units::numeric * 7 / days,
      'weeksCover', p.available::numeric * days / nullif(p.units::numeric * 7, 0),
      'costUnknown', p.cost_unknown,
      'stockFlag', case
        when p.units = 0 then case when exists (
          select 1 from public.order_items i join public.orders o on o.id = i.order_id
          where i.variant_id = p.id and o.authorised_at is not null
            and (o.fulfilment_status <> 'cancelled' or o.dispatched_at is not null)
        ) then 'no_sales' else 'never_sold' end
        when p.available::numeric * days < p.units::numeric * 14 then 'low'
      end
    ) order by p.revenue desc, p.sku), '[]'::jsonb) as data
    from product_rows p cross join period_totals k where k.period = 'current'
  ), tier_totals as (
    select case when quantity < 5 then '1-4' when quantity < 10 then '5-9' else '10+' end as key,
      sum(net_pence) as revenue, sum(quantity) as units
    from current_lines group by 1
  ), tiers_json as (
    select jsonb_agg(jsonb_build_object('key', s.key, 'revenuePence', coalesce(t.revenue, 0),
      'units', coalesce(t.units, 0)) order by s.position) as data
    from (values ('1-4', 1), ('5-9', 2), ('10+', 3)) s(key, position) left join tier_totals t using (key)
  ), payment_totals as (
    select payment_method, sum(goods_net_pence) as revenue, sum(units) as units, count(*) as orders
    from booking_totals where day >= p_from group by payment_method
  ), payments_json as (
    select jsonb_agg(jsonb_build_object('key', s.key, 'revenuePence', coalesce(t.revenue, 0),
      'units', coalesce(t.units, 0), 'orders', coalesce(t.orders, 0)) order by s.key) as data
    from (values ('card'::public.order_payment_method), ('net30'::public.order_payment_method)) s(key)
    left join payment_totals t on t.payment_method = s.key
  ), buyer_history as (
    select exists (
      select 1 from public.orders o
      where coalesce(o.buyer_id::text, lower(btrim(o.email))) = b.identity
        and o.authorised_at is not null and o.authorised_at < range_start
        and (o.fulfilment_status <> 'cancelled' or o.dispatched_at is not null)
    ) as has_prior
    from (select distinct identity from bookings where day >= p_from) b
  ), buyers_json as (
    select jsonb_build_object(
      'new', count(*) filter (where not has_prior), 'returning', count(*) filter (where has_prior)
    ) as data
    from buyer_history
  )
  select k.data || jsonb_build_object(
    'canSeeMargin', can_see_margin, 'daily', d.data, 'series', s.data,
    'products', p.data, 'tiers', t.data, 'payments', m.data, 'buyers', b.data
  ) into result
  from period_json k cross join products_json p cross join tiers_json t cross join payments_json m
  cross join buyers_json b join series_json d on d.kind = 'daily' join series_json s on s.kind = 'series';
  return result;
end;
$$;

revoke all on function public.admin_sales_report(date, date, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_sales_report(date, date, text) to authenticated;
