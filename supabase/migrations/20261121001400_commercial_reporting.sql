create table private.finder_exact_matches (
  event_id uuid not null references public.finder_search_events (id) on delete cascade,
  variant_id uuid not null references public.variants (id) on delete cascade,
  primary key (event_id, variant_id)
);
create table private.finder_order_attributions (
  event_id uuid primary key references public.finder_search_events (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade
);
alter table private.finder_exact_matches enable row level security;
alter table private.finder_order_attributions enable row level security;
revoke all on private.finder_exact_matches, private.finder_order_attributions
  from public, anon, authenticated, service_role;

create function public.record_exact_finder_search(p_code text, p_variant_ids uuid[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  event uuid;
  matches uuid[];
begin
  if p_code ~ '^[A-Z0-9]{1,80}$' then
    select array_agg(v.id) into matches
    from public.variants v join public.products p on p.id = v.product_id
    where v.id = any(p_variant_ids) and v.publication_status = 'published'
      and (v.sku_normalised = p_code or public.normalise_code(p.family_code) = p_code
        or exists (
          select 1 from public.compatibility c where c.variant_id = v.id and c.code_normalised = p_code
            and c.verification_state = 'approved' and not c.is_private
        ));
  end if;
  insert into public.finder_search_events (outcome, normalised_query)
  values ('exact', case when matches is not null then p_code end)
  returning id into event;
  if matches is null then return null; end if;
  insert into private.finder_exact_matches (event_id, variant_id)
  select event, unnest(matches);
  return event;
end;
$$;

create function public.link_finder_checkout(
  p_event_id uuid, p_order_id uuid, p_attempt_token uuid, p_buyer_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.finder_order_attributions (event_id, order_id)
  select e.id, o.id from public.finder_search_events e
  join public.orders o on o.id = p_order_id
  where e.id = p_event_id and e.outcome = 'exact'
    and o.checkout_attempt_token = p_attempt_token and o.buyer_id is not distinct from p_buyer_id
    and o.fulfilment_status = 'awaiting_authorisation'
    and o.created_at >= e.created_at and clock_timestamp() <= e.created_at + interval '30 minutes'
    and exists (
      select 1 from private.finder_exact_matches m
      join public.order_items i on i.variant_id = m.variant_id and i.order_id = o.id
      where m.event_id = e.id
    )
  on conflict do nothing;
  return found;
end;
$$;

alter table public.order_returns add column reason_category text
  check (reason_category in ('wrong_fit', 'damaged', 'ordered_in_error', 'other'));

create function public.record_structured_return(
  p_order_id uuid, p_return_id uuid, p_variant_id uuid, p_quantity integer, p_reason_category text, p_reason text
)
returns public.order_returns
language plpgsql security definer set search_path = ''
as $$
declare
  existing public.order_returns;
  result public.order_returns;
  attributed_code text;
begin
  if not private.has_staff_role('warehouse') then
    raise exception using errcode = '42501', message = 'warehouse_role_required';
  end if;
  if p_reason_category is null or p_reason_category not in ('wrong_fit', 'damaged', 'ordered_in_error', 'other')
    or coalesce(length(btrim(p_reason)), 0) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'invalid_return_reason';
  end if;
  perform private.lock_order(p_order_id);
  select * into existing from public.order_returns where id = p_return_id and order_id = p_order_id;
  if found then
    if existing.reason_category is distinct from p_reason_category then
      raise exception using errcode = '22023', message = 'operation_key_conflict';
    end if;
    attributed_code := existing.lookup_code;
  elsif p_reason_category = 'wrong_fit' then
    select e.normalised_query into attributed_code
    from private.finder_order_attributions a
    join public.finder_search_events e on e.id = a.event_id
    join private.finder_exact_matches m on m.event_id = a.event_id and m.variant_id = p_variant_id
    join public.orders o on o.id = a.order_id and o.authorised_at is not null
    where a.order_id = p_order_id;
  end if;
  result := public.record_return(p_order_id, p_return_id, auth.uid(), p_variant_id, p_quantity, p_reason, attributed_code);
  if result.reason_category is null then
    update public.order_returns set reason_category = p_reason_category where id = result.id returning * into result;
  end if;
  return result;
end;
$$;

create function public.admin_commercial_measures()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.has_staff_role('warehouse') then
    raise exception using errcode = '42501', message = 'warehouse_role_required';
  end if;
  return jsonb_build_object(
    'finder', (
      select jsonb_build_object(
        'exact', count(*) filter (where e.outcome = 'exact'),
        'suggested', count(*) filter (where e.outcome = 'suggested'),
        'unmatched', count(*) filter (where e.outcome = 'unmatched'),
        'converted', count(*) filter (where o.authorised_at is not null),
        'linkedWithoutAuthorisation', count(*) filter (where o.id is not null and o.authorised_at is null),
        'noLink', count(*) filter (where e.outcome = 'exact' and a.event_id is null)
      )
      from public.finder_search_events e
      left join private.finder_order_attributions a on a.event_id = e.id
      left join public.orders o on o.id = a.order_id
    ),
    'trials', (
      select jsonb_build_object(
        'dispatched', count(*),
        'linked', count(*) filter (where subsequent_order_id is not null),
        'firstPurchases', public.count_admin_trial_first_purchases(auth.uid())
      ) from public.trial_fulfilments where state = 'dispatched'
    ),
    'dispatch', (
      select jsonb_build_object(
        'total', count(*),
        'withPromise', count(promised_dispatch_date),
        'onTime', count(*) filter (
          where (dispatched_at at time zone 'Europe/London')::date <= promised_dispatch_date
        )
      ) from public.orders where dispatched_at is not null
    ),
    'uncategorisedReturns', (select count(*) from public.order_returns where reason_category is null),
    'wrongFit', (
      select coalesce(jsonb_agg(to_jsonb(grouped) order by grouped.sku, grouped.code nulls last), '[]')
      from (
        select v.sku, r.lookup_code as code, count(*) as records, sum(r.quantity) as units
        from public.order_returns r join public.variants v on v.id = r.variant_id
        where r.reason_category = 'wrong_fit'
        group by v.sku, r.lookup_code
      ) grouped
    )
  );
end;
$$;

revoke all on function public.record_exact_finder_search(text, uuid[]),
  public.link_finder_checkout(uuid, uuid, uuid, uuid),
  public.record_structured_return(uuid, uuid, uuid, integer, text, text),
  public.admin_commercial_measures() from public, anon, authenticated, service_role;
grant execute on function public.record_exact_finder_search(text, uuid[]),
  public.link_finder_checkout(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.record_structured_return(uuid, uuid, uuid, integer, text, text),
  public.admin_commercial_measures() to authenticated;
