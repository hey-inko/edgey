alter table public.trial_requests
  add column eligibility text,
  add column reviewed_variant_ids uuid[] not null default '{}',
  add column reviewed_at timestamptz,
  add column reviewed_by uuid,
  add constraint trial_review_metadata check (
    case
      when eligibility is null then cardinality(reviewed_variant_ids) = 0
        and num_nonnulls(reviewed_at, reviewed_by) = 0
      when eligibility = 'eligible' then status in ('in_review', 'approved')
        and array_ndims(reviewed_variant_ids) = 1
        and cardinality(reviewed_variant_ids) = 2
        and array_position(reviewed_variant_ids, null) is null
        and num_nonnulls(reviewed_at, reviewed_by, staff_notes) = 3
      when eligibility = 'declined' then status = 'declined'
        and cardinality(reviewed_variant_ids) = 0
        and num_nonnulls(reviewed_at, reviewed_by, staff_notes) = 3
      else false
    end
  );

revoke update (status, staff_notes) on public.trial_requests from authenticated;
drop policy trial_requests_review on public.trial_requests;

create function private.touch_request_version()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function private.touch_request_version() from public, anon, authenticated, service_role;

drop trigger trial_requests_touch on public.trial_requests;
create trigger trial_requests_touch before update on public.trial_requests
for each row execute function private.touch_request_version();

alter table public.order_outbox
  add column message_subject text,
  add column message_body text,
  drop constraint outbox_message_matches_source,
  add constraint outbox_message_matches_source check (
    (order_id is not null and message_key = 'order_confirmation')
    or (order_id is null and message_key in ('confirmation', 'staff_notification'))
    or (trial_request_id is not null and message_key in ('trial_approved', 'trial_declined', 'trial_dispatched'))
    or (enquiry_id is not null and
      message_key ~ '^enquiry_reply:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ),
  add constraint outbox_message_copy_required check (
    (
      message_key not in ('trial_approved', 'trial_declined', 'trial_dispatched')
      and message_key not like 'enquiry_reply:%'
    )
    or (
      coalesce(length(btrim(message_subject)), 0) > 0
      and coalesce(length(btrim(message_body)), 0) > 0
    )
  );

create function public.review_admin_trial(
  p_trial_request_id uuid, p_actor_id uuid, p_decision text, p_reason text, p_variant_ids uuid[],
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  request public.trial_requests;
  reason text := btrim(p_reason);
  units uuid[] := array(select id from unnest(p_variant_ids) as unit(id) order by id);
  published_variants integer;
begin
  perform 1 from public.staff_members where user_id = p_actor_id and role = 'catalogue' for key share;
  if not found then
    raise exception using errcode = '42501', message = 'catalogue_role_required';
  end if;
  if p_decision is null or p_decision not in ('eligible', 'declined')
    or coalesce(length(reason), 0) not between 1 and 2000 or reason !~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'invalid_trial_review';
  end if;
  if p_decision = 'eligible' and (cardinality(units) <> 2 or array_position(units, null) is not null) then
    raise exception using errcode = '22023', message = 'two_trial_units_required';
  end if;
  if p_decision = 'declined' and cardinality(units) <> 0 then
    raise exception using errcode = '22023', message = 'declined_trial_has_variants';
  end if;

  select * into strict request from public.trial_requests where id = p_trial_request_id for update;
  if (request.eligibility, request.reviewed_variant_ids, request.reviewed_by, request.staff_notes)
    is not distinct from (p_decision, units, p_actor_id, reason) then
    return p_trial_request_id;
  end if;
  if request.status not in ('pending', 'in_review') then
    raise exception using errcode = '22023', message = 'trial_not_reviewable';
  end if;
  if request.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '22023', message = 'trial_stale';
  end if;
  if p_decision = 'eligible' then
    select count(*) into published_variants from (
      select id from public.variants
      where id = any(units) and publication_status = 'published' order by id for share
    ) as published;
    if published_variants <> (select count(distinct id) from unnest(units) as unit(id)) then
      raise exception using errcode = '22023', message = 'variant_not_published';
    end if;
  end if;

  update public.trial_requests
  set status = case when p_decision = 'eligible' then 'in_review' else 'declined' end,
    eligibility = p_decision, staff_notes = reason, reviewed_variant_ids = units,
    reviewed_by = p_actor_id, reviewed_at = clock_timestamp()
  where id = p_trial_request_id;

  if p_decision = 'declined' then
    insert into public.order_outbox (trial_request_id, message_key, message_subject, message_body)
    values (p_trial_request_id, 'trial_declined', 'Your Edgey trial request',
      'We cannot offer a trial pack for this request. Thank you for getting in touch.');
  end if;
  return p_trial_request_id;
end;
$$;

alter function public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean) set schema private;
alter function private.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean)
  rename to allocate_reviewed_trial;
revoke all on function private.allocate_reviewed_trial(uuid, uuid, uuid[], jsonb, text, text, boolean)
from public, anon, authenticated, service_role;

create function public.approve_trial_fulfilment(
  p_trial_request_id uuid, p_actor_id uuid, p_variant_ids uuid[], p_address jsonb,
  p_carrier text, p_carrier_service text, p_address_verified boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  request public.trial_requests := private.lock_trial_request(p_trial_request_id, p_actor_id);
  fulfilment_state text;
begin
  select state into fulfilment_state from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if fulfilment_state = 'cancelled' then
    raise exception using errcode = '22023', message = 'trial_was_cancelled';
  end if;
  if fulfilment_state is null then
    if request.eligibility is distinct from 'eligible' or request.status <> 'in_review' then
      raise exception using errcode = '22023', message = 'eligible_trial_review_required';
    end if;
    if cardinality(p_variant_ids) = 2 and not exists (select 1 from unnest(p_variant_ids) as unit(id) where id is null)
      and request.reviewed_variant_ids is distinct from array(
        select id from unnest(p_variant_ids) as unit(id) order by id
      ) then
      raise exception using errcode = '22023', message = 'trial_units_do_not_match_review';
    end if;
  end if;

  if p_address_verified is true and exists (
    select 1 from unnest(array['recipient_name', 'line1', 'town']) as field
    where p_address->>field ~ '^[[:space:]]*$'
  ) then
    raise exception using errcode = '23514', message = 'invalid_trial_address';
  end if;
  perform private.allocate_reviewed_trial(p_trial_request_id, p_actor_id, p_variant_ids, p_address,
    p_carrier, p_carrier_service, p_address_verified);
  if fulfilment_state is null then
    insert into public.order_outbox (trial_request_id, message_key, message_subject, message_body)
    values (p_trial_request_id, 'trial_approved', 'Your Edgey trial pack has been approved',
      'We have approved your trial pack. We will let you know when it has been dispatched.');
  end if;
  return p_trial_request_id;
end;
$$;

create or replace function public.dispatch_trial_fulfilment(
  p_trial_request_id uuid, p_actor_id uuid, p_tracking_number text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  fulfilment public.trial_fulfilments;
begin
  perform private.lock_trial_request(p_trial_request_id, p_actor_id);
  select * into strict fulfilment from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if p_tracking_number ~ '^[[:space:]]*$|[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'trial_tracking_required';
  end if;
  if fulfilment.state = 'dispatched' and fulfilment.tracking_number is distinct from btrim(p_tracking_number) then
    raise exception using errcode = '22023', message = 'trial_tracking_already_recorded';
  end if;
  perform private.finish_trial_fulfilment(p_trial_request_id, p_actor_id, 'dispatch', p_tracking_number);
  if fulfilment.state = 'allocated' then
    insert into public.order_outbox (trial_request_id, message_key, message_subject, message_body)
    values (p_trial_request_id, 'trial_dispatched', 'Your Edgey trial pack has been dispatched',
      'Your trial pack has been dispatched. Tracking number: ' || btrim(p_tracking_number) || '.');
  end if;
  return p_trial_request_id;
end;
$$;

create table private.trial_order_attributions (
  id bigint generated always as identity primary key,
  trial_request_id uuid not null references public.trial_fulfilments (trial_request_id),
  order_id uuid not null references public.orders (id),
  actor_id uuid not null,
  action text not null check (action in ('linked', 'unlinked')),
  created_at timestamptz not null default clock_timestamp()
);
create index trial_order_attributions_trial_idx on private.trial_order_attributions (trial_request_id, id);
revoke all on private.trial_order_attributions from public, anon, authenticated, service_role;

create or replace function public.link_trial_order(p_trial_request_id uuid, p_order_id uuid, p_actor_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  fulfilment public.trial_fulfilments;
  purchase public.orders;
begin
  perform private.lock_trial_request(p_trial_request_id, p_actor_id);
  select * into strict fulfilment from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if fulfilment.subsequent_order_id = p_order_id then
    return p_trial_request_id;
  end if;
  if fulfilment.state <> 'dispatched' or fulfilment.subsequent_order_id is not null or p_order_id is null then
    raise exception using errcode = '22023', message = 'trial_order_link_not_available';
  end if;
  select * into strict purchase from public.orders where id = p_order_id for update;
  if purchase.created_at <= fulfilment.dispatched_at or purchase.authorised_at is null
    or purchase.fulfilment_status = 'cancelled' or purchase.payment_status in ('voided', 'refunded') then
    raise exception using errcode = '22023', message = 'not_a_subsequent_purchase';
  end if;
  if exists (select 1 from public.trial_fulfilments where subsequent_order_id = p_order_id) then
    raise exception using errcode = '23505', message = 'trial_order_already_linked';
  end if;
  update public.trial_fulfilments set subsequent_order_id = p_order_id where trial_request_id = p_trial_request_id;
  insert into private.trial_order_attributions (trial_request_id, order_id, actor_id, action)
  values (p_trial_request_id, p_order_id, p_actor_id, 'linked');
  return p_trial_request_id;
end;
$$;

create function public.unlink_trial_order(p_trial_request_id uuid, p_order_id uuid, p_actor_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  fulfilment public.trial_fulfilments;
begin
  perform private.lock_trial_request(p_trial_request_id, p_actor_id);
  select * into strict fulfilment from public.trial_fulfilments where trial_request_id = p_trial_request_id;
  if fulfilment.state <> 'dispatched' or p_order_id is null then
    raise exception using errcode = '22023', message = 'trial_order_link_not_available';
  end if;
  if fulfilment.subsequent_order_id is null then
    return p_trial_request_id;
  end if;
  if fulfilment.subsequent_order_id <> p_order_id then
    raise exception using errcode = '22023', message = 'trial_order_link_changed';
  end if;
  update public.trial_fulfilments set subsequent_order_id = null where trial_request_id = p_trial_request_id;
  insert into private.trial_order_attributions (trial_request_id, order_id, actor_id, action)
  values (p_trial_request_id, p_order_id, p_actor_id, 'unlinked');
  return p_trial_request_id;
end;
$$;

create function public.count_admin_trial_first_purchases(p_actor_id uuid)
returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare
  total integer;
begin
  perform private.require_warehouse(p_actor_id);
  select count(*) into total
  from public.trial_fulfilments as trial
  join public.orders as purchase on purchase.id = trial.subsequent_order_id
  where trial.state = 'dispatched' and purchase.created_at > trial.dispatched_at
    and purchase.authorised_at is not null and purchase.fulfilment_status <> 'cancelled'
    and purchase.payment_status not in ('voided', 'refunded')
    and not exists (
      select 1 from public.orders as prior
      where (prior.authorised_at, prior.created_at, prior.id)
          < (purchase.authorised_at, purchase.created_at, purchase.id)
        and prior.fulfilment_status <> 'cancelled' and prior.payment_status not in ('voided', 'refunded')
        and case when purchase.buyer_id is not null and prior.buyer_id is not null
          then prior.buyer_id = purchase.buyer_id
          else lower(btrim(prior.email)) = lower(btrim(purchase.email))
        end
    );
  return total;
end;
$$;

comment on function public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean) is
  'Warehouse approval checks the eligible catalogue review and its two units before attesting that the carrier service can deliver to the complete UK address.';
comment on function public.link_trial_order(uuid, uuid, uuid) is
  'Warehouse calls only after explicitly identifying a later authorised purchase for a dispatched trial. An email match is neither required nor sufficient. An order can be attributed only once.';
comment on function public.count_admin_trial_first_purchases(uuid) is
  'Counts linked authorised purchases without a prior qualifying authorisation (ties by order creation and ID). Uses buyer ID when both orders have one, otherwise normalized email for guest history. Excludes cancelled, voided and fully refunded orders from both sides.';

revoke all on function
  public.review_admin_trial(uuid, uuid, text, text, uuid[], timestamptz),
  public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean),
  public.unlink_trial_order(uuid, uuid, uuid),
  public.count_admin_trial_first_purchases(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.review_admin_trial(uuid, uuid, text, text, uuid[], timestamptz),
  public.approve_trial_fulfilment(uuid, uuid, uuid[], jsonb, text, text, boolean),
  public.unlink_trial_order(uuid, uuid, uuid),
  public.count_admin_trial_first_purchases(uuid)
to service_role;
