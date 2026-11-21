create or replace function public.link_finder_checkout(
  p_event_id uuid, p_order_id uuid, p_attempt_token uuid, p_buyer_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare target public.orders;
begin
  select * into target from public.orders
  where id = p_order_id and checkout_attempt_token = p_attempt_token and buyer_id is not distinct from p_buyer_id
    and fulfilment_status = 'awaiting_authorisation' and authorised_at is null
  for no key update;
  if not found or exists (select 1 from private.finder_order_attributions where order_id = target.id) then
    return false;
  end if;

  insert into private.finder_order_attributions as attribution (event_id, order_id)
  select e.id, target.id from public.finder_search_events e
  where e.id = p_event_id and e.outcome = 'exact'
    and target.created_at >= e.created_at and clock_timestamp() <= e.created_at + interval '30 minutes'
    and exists (
      select 1 from private.finder_exact_matches m
      join public.order_items i on i.variant_id = m.variant_id and i.order_id = target.id
      where m.event_id = e.id
    )
  on conflict (event_id) do update set order_id = excluded.order_id
  where exists (
    select 1 from public.orders prior where prior.id = attribution.order_id
      and prior.fulfilment_status = 'cancelled' and prior.authorised_at is null
      and prior.created_at < target.created_at
      and prior.buyer_id is not distinct from target.buyer_id
    for no key update
  );
  return found;
end;
$$;

alter table public.order_returns
  add column reported_lookup_code text,
  add column reported_public_lookup_code text,
  add constraint order_return_reported_lookup_shape check (
    reported_lookup_code is null or (
      reason_category is not distinct from 'wrong_fit'
      and length(reported_lookup_code) between 2 and 40
      and reported_lookup_code ~ '^[A-Za-z0-9]+([ ._-][A-Za-z0-9]+)*$'
      and reported_lookup_code ~ '[0-9]'
      and reported_lookup_code !~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$'
      and (reported_lookup_code ~ '[A-Za-z]' or length(public.normalise_code(reported_lookup_code)) <= 8)
      and public.normalise_code(reported_lookup_code) !~ '^([A-Z]{1,2}[0-9][A-Z0-9]?|GIR)[0-9][A-Z]{2}$'
    )
  ),
  add constraint order_return_reported_public_lookup_shape check (
    reported_public_lookup_code is null or (
      reported_lookup_code is not null and reported_public_lookup_code = public.normalise_code(reported_lookup_code)
    )
  );

drop function public.record_structured_return(uuid, uuid, uuid, integer, text, text);
create function public.record_structured_return(
  p_order_id uuid, p_return_id uuid, p_variant_id uuid, p_quantity integer, p_reason_category text, p_reason text,
  p_reported_lookup_code text default null
)
returns public.order_returns
language plpgsql security definer set search_path = ''
as $$
declare
  existing public.order_returns;
  result public.order_returns;
  attributed_code text;
  reported_code text := nullif(btrim(p_reported_lookup_code), '');
  reported_key text;
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
    if existing.reason_category is distinct from p_reason_category
      or existing.reported_lookup_code is distinct from reported_code then
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
    if reported_code is not null and length(reported_code) <= 40 then
      reported_key := public.normalise_code(reported_code);
      if not exists (
        select 1 from public.variants v join public.products p on p.id = v.product_id
        where v.publication_status = 'published'
          and (v.sku_normalised = reported_key or public.normalise_code(p.family_code) = reported_key
            or exists (
              select 1 from public.compatibility c where c.variant_id = v.id and c.code_normalised = reported_key
                and c.verification_state = 'approved' and not c.is_private
            ))
      ) then reported_key := null; end if;
    end if;
  end if;

  result := public.record_return(p_order_id, p_return_id, auth.uid(), p_variant_id, p_quantity, p_reason, attributed_code);
  if result.reason_category is null then
    update public.order_returns set reason_category = p_reason_category, reported_lookup_code = reported_code,
      reported_public_lookup_code = reported_key where id = result.id returning * into result;
  end if;
  return result;
end;
$$;

create or replace function public.admin_commercial_measures()
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
        select v.sku, coalesce(r.reported_public_lookup_code, r.lookup_code) as code, count(*) as records, sum(r.quantity) as units
        from public.order_returns r join public.variants v on v.id = r.variant_id
        where r.reason_category = 'wrong_fit'
        group by v.sku, coalesce(r.reported_public_lookup_code, r.lookup_code)
      ) grouped
    )
  );
end;
$$;

revoke all on function public.record_structured_return(uuid, uuid, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_structured_return(uuid, uuid, uuid, integer, text, text, text) to authenticated;
