create temporary table demo_order_ids (id uuid primary key) on commit drop;

do $$
declare
  plan constant jsonb := '[
    [9,"EDG-Z10",2,"card","","Harbourline Displays"],
    [8,"EDG-Z16",3,"card","partial_refund","Juniper Plotworks"],
    [7,"EDG-Z50",1,"net30","paid","Clockfern Printworks"],
    [6,"EDG-SR6223",5,"card","","Orchard Loom Signs"],
    [5,"EDG-Z71",2,"card","cancel_refund","Fable Cut Studio"],
    [5,"EDG-Z1",2,"net30","","Clockfern Printworks"],
    [4,"EDG-MIM-A45",2,"card","","Cloudquay Graphics"],
    [3,"EDG-Z10",10,"card","","Harbourline Displays"],
    [2,"EDG-SUM-DRG-36",3,"net30","part_paid","Clockfern Printworks"],
    [2,"EDG-Z16",1,"card","abandoned","Juniper Plotworks"],
    [1,"EDG-Z1",2,"card","picking","Mosswindow Studio"],
    [1,"EDG-MIM-A45",2,"net30","","Clockfern Printworks"],
    [0,"EDG-SUM-TAN-36",1,"card","ready","Hollowglass Signs"],
    [0,"EDG-Z10",1,"card","held","Harbourline Displays"],
    [0,"EDG-Z16",2,"card","","Juniper Plotworks"]
  ]';
  buyer_id constant uuid := current_setting('edgey.demo_buyer_id');
  application_id constant uuid := current_setting('edgey.demo_application_id');
  actor_id uuid := gen_random_uuid();
  buyer_email constant text := 'accounts@edgey-orders-demo.invalid';
  provider_suffix constant text := replace(gen_random_uuid()::text, '-', '');
  customer_id constant text := 'cus_EdgeyDemo' || provider_suffix;
  provider_account_id constant text := 'acct_EdgeyDemo' || provider_suffix;
  postcode constant text := 'SW9 9ZZ';
  vat_rate_bps constant integer := 2000;
  terms jsonb := public.checkout_delivery_terms(postcode);
  item record;
  variant public.variants;
  target public.orders;
  requested integer;
  unit_price integer;
  goods_net integer;
  delivery_net integer;
  vat integer;
  email text;
  created timestamptz;
  authorised timestamptz;
  dispatched timestamptz;
  adjusted timestamptz;
  local_date date;
  london_minute integer;
  dispatch_date date;
  delivery_date date;
  checkout_id text;
  capture_id text;
  invoice_id text;
  operation_prefix text;
  unavailable text;
begin
  if terms is null then
    raise exception using message = 'demo_delivery_terms_missing', detail = 'Configure checkout delivery for SW9 9ZZ in staging first.';
  end if;

  perform 1 from public.variants
    where sku in (select line->>1 from jsonb_array_elements(plan) line)
    order by id for no key update;
  with needs as (
    select line->>1 as sku, sum((line->>2)::integer)::integer as quantity
    from jsonb_array_elements(plan) line group by line->>1
  )
  select string_agg(needs.sku || ' (' || needs.quantity || ' free)', ', ' order by needs.sku)
  into unavailable
  from needs left join public.variants v on v.sku = needs.sku
  where v.id is null or v.publication_status <> 'published' or not v.is_staging_fixture
    or v.stock_on_hand - v.stock_reserved < needs.quantity
    or least(v.price_1_4_pence, v.price_5_9_pence, v.price_10_plus_pence) <= 0
    or num_nonnulls(v.price_1_4_pence, v.price_5_9_pence, v.price_10_plus_pence) <> 3;
  if unavailable is not null then
    raise exception using message = 'demo_stock_unavailable', detail = unavailable;
  end if;
  if exists (
    select 1 from public.variants v
    cross join lateral (
      select coalesce(sum(on_hand_delta), 0) as hand, coalesce(sum(reserved_delta), 0) as reserved
      from public.stock_movements where variant_id = v.id
    ) m
    where v.sku in (select line->>1 from jsonb_array_elements(plan) line)
      and (v.stock_on_hand, v.stock_reserved) is distinct from (m.hand, m.reserved)
  ) then
    raise exception using message = 'demo_stock_ledger_mismatch';
  end if;

  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, banned_until, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  select users.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', users.email,
    now(), '2099-01-01', now(), now(), '', '', '', ''
  from (values (buyer_id, buyer_email), (actor_id, 'actor@edgey-orders-demo.invalid')) as users(id, email);
  insert into public.staff_members (user_id, role) values (actor_id, 'finance'), (actor_id, 'warehouse');
  insert into public.trade_applications (id, buyer_id, email, buyer_name, company,
    billing_line1, billing_town, billing_postcode)
  values (application_id, buyer_id, buyer_email, '[DEMO] Clockfern buyer', '[DEMO] Clockfern Printworks',
    '1 Demonstration Yard - DO NOT SHIP', 'London', postcode);
  perform public.begin_trade_account_approval(application_id, actor_id, provider_account_id);
  perform public.review_admin_trade_application(application_id, actor_id, 'approved', 200000, customer_id);

  for item in
    select seq, (line->>0)::integer as weeks, line->>1 as sku, (line->>2)::integer as quantity,
      (line->>3)::public.order_payment_method as method, line->>4 as scenario, line->>5 as company
    from jsonb_array_elements(plan) with ordinality as p(line, seq)
    order by seq
  loop
    select * into strict variant from public.variants where sku = item.sku;
    requested := item.quantity;
    unit_price := case when requested < 5 then variant.price_1_4_pence
      when requested < 10 then variant.price_5_9_pence else variant.price_10_plus_pence end;
    goods_net := requested * unit_price;
    delivery_net := case when terms->'quote'->>'kind' = 'next-working-day' and goods_net >= 15000
      then 0 else (terms->'quote'->>'chargeExVatPence')::integer end;
    vat := (goods_net::bigint * vat_rate_bps + 5000) / 10000
      + (delivery_net::bigint * vat_rate_bps + 5000) / 10000;

    created := least(now(), (
      date_trunc('week', now() at time zone 'Europe/London') - item.weeks * interval '1 week'
        + ((item.seq % 4) * interval '1 day') + interval '10 hours'
    ) at time zone 'Europe/London');
    authorised := least(now(), created + interval '5 minutes');
    local_date := (authorised at time zone 'Europe/London')::date;
    london_minute := extract(hour from authorised at time zone 'Europe/London') * 60
      + extract(minute from authorised at time zone 'Europe/London');
    with days as (
      select local_date + day_offset as day
      from generate_series(0, (terms->'warehouseCalendar'->'dateRange'->>'through')::date - local_date) day_offset
      where local_date >= (terms->'warehouseCalendar'->'dateRange'->>'from')::date
    )
    select min(day) into dispatch_date from days
    where (terms->'warehouseCalendar'->'workingWeekdays') @> to_jsonb(extract(dow from day)::integer)
      and not (terms->'warehouseCalendar'->'bankHolidays' ? day::text)
      and not (terms->'warehouseCalendar'->'closures' ? day::text)
      and (day > local_date or london_minute < (terms->>'cutoffMinutes')::integer);
    with days as (
      select dispatch_date + day_offset as day
      from generate_series(1, (terms->'deliveryCalendar'->'dateRange'->>'through')::date - dispatch_date) day_offset
      where dispatch_date >= (terms->'deliveryCalendar'->'dateRange'->>'from')::date
    )
    select day into delivery_date from days
    where (terms->'deliveryCalendar'->'workingWeekdays') @> to_jsonb(extract(dow from day)::integer)
      and not (terms->'deliveryCalendar'->'bankHolidays' ? day::text)
      and not (terms->'deliveryCalendar'->'closures' ? day::text)
    order by day offset ((terms->'quote'->>'workingDays')::integer - 1) limit 1;
    if dispatch_date is null or delivery_date is null then
      raise exception using message = 'demo_delivery_terms_missing', detail = 'Configure warehouse and carrier calendars for the last ten weeks and upcoming promises.';
    end if;
    dispatched := least(now(), greatest(authorised, (dispatch_date + time '13:00') at time zone 'Europe/London'));
    adjusted := least(now(), dispatched + interval '2 hours');

    email := case when item.method = 'net30' then buyer_email else
      'order-' || item.seq || '@edgey-orders-demo.invalid' end;
    target := public.reserve_order_with_delivery(
      gen_random_uuid(), jsonb_build_array(jsonb_build_object('variant_id', variant.id,
        'quantity', requested, 'unit_price_pence', unit_price)),
      jsonb_build_object('email', email, 'business_name', '[DEMO] ' || item.company,
        'recipient_name', '[DEMO] Test buyer', 'buying_for_work', true),
      jsonb_build_object('line1', '1 Demonstration Yard - DO NOT SHIP', 'town', 'London', 'postcode', postcode, 'country', 'GB'),
      jsonb_build_object('goods_net_pence', goods_net, 'delivery_net_pence', delivery_net, 'vat_rate_bps', vat_rate_bps,
        'vat_pence', vat, 'gross_pence', goods_net + delivery_net + vat),
      clock_timestamp() + interval '35 minutes', terms->'quote'->>'serviceName', dispatch_date, delivery_date, terms,
      item.method, case when item.method = 'net30' then buyer_id end,
      case when item.method = 'net30' then 'DEMO-PO-' || item.seq end
    );
    insert into demo_order_ids values (target.id);
    operation_prefix := 'edgey-demo:' || target.id || ':';
    checkout_id := operation_prefix || 'checkout';
    capture_id := operation_prefix || 'capture';
    invoice_id := 'in_EdgeyDemo' || replace(target.id::text, '-', '');

    if item.method = 'net30' then
      perform public.start_net30_invoice(target.id, provider_account_id);
      update public.orders set stripe_net30_invoice_id = invoice_id, stripe_net30_sent = true,
        stripe_net30_started_at = created where id = target.id;
      perform public.bind_issued_net30_invoice(target.id, invoice_id, customer_id, target.gross_pence,
        'GBP', authorised, authorised + interval '30 days', authorised, dispatch_date, delivery_date);
      if item.scenario in ('paid', 'part_paid') then
        perform public.apply_invoice_payment(invoice_id, operation_prefix || 'invoice-payment',
          case when item.scenario = 'paid' then target.gross_pence else target.gross_pence / 2 end, 'GBP');
      end if;
    else
      perform public.bind_checkout_session(target.id, checkout_id, target.hold_expires_at);
      if item.scenario = 'abandoned' then
        perform public.release_reservation(target.id, operation_prefix || 'release', 'closed', checkout_id);
      elsif item.scenario <> 'held' then
        perform public.confirm_payment(target.id, checkout_id, capture_id, target.gross_pence,
          'GBP', authorised, dispatch_date, delivery_date);
      end if;
    end if;

    if item.scenario = 'cancel_refund' then
      perform public.cancel_order(target.id, operation_prefix || 'cancel', actor_id);
      perform public.record_refund(target.id, operation_prefix || 'refund', capture_id, target.gross_pence, 'GBP');
    elsif item.scenario not in ('abandoned', 'held', 'ready') then
      perform public.start_picking(target.id, operation_prefix || 'pick', actor_id);
      if item.scenario <> 'picking' then
        perform public.dispatch_order(target.id, operation_prefix || 'dispatch', actor_id, '[DEMO] Test Carrier',
          'DEMO-DO-NOT-SHIP-' || item.seq);
        if item.scenario = 'partial_refund' then
          perform public.record_refund(target.id, operation_prefix || 'refund', capture_id, target.gross_pence / 4, 'GBP');
        end if;
      end if;
    end if;

    update public.orders set created_at = created, stripe_replay_after = 'infinity',
      dispatched_at = case when fulfilment_status = 'dispatched' then dispatched end,
      hold_expires_at = case when item.scenario = 'held' then hold_expires_at else created + interval '35 minutes' end
    where id = target.id;
    update private.order_operations set created_at = case action
      when 'pick' then authorised when 'dispatch' then dispatched when 'refund' then adjusted else authorised end
    where order_id = target.id;
    update public.credit_ledger set created_at = case kind
      when 'hold' then created when 'issue' then authorised else adjusted end
    where order_id = target.id;
  end loop;

  delete from public.order_outbox
  where order_id in (select id from demo_order_ids) or trade_application_id = application_id;
  delete from public.staff_members where user_id = actor_id;
  delete from auth.users where id = actor_id;
end;
$$;
