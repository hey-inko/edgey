alter table public.enquiries
  drop constraint enquiries_status_check,
  add constraint enquiries_status_check
    check (status in ('pending', 'in_review', 'replied', 'resolved', 'converted')),
  add column matched_variant_id uuid references public.variants (id) on delete set null;

revoke update (status, staff_notes) on public.enquiries from authenticated;
drop policy enquiries_update on public.enquiries;

drop trigger enquiries_touch on public.enquiries;
create trigger enquiries_touch before update on public.enquiries
for each row execute function private.touch_request_version();

create function public.handle_admin_enquiry(
  p_enquiry_id uuid, p_actor_id uuid, p_action text, p_expected_updated_at timestamptz,
  p_operation_key uuid default null, p_reply text default null, p_variant_id uuid default null,
  p_candidate_code text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  enquiry public.enquiries;
  reply_body text := private.catalogue_trim(p_reply);
  candidate text := nullif(private.catalogue_trim(p_candidate_code), '');
  reply_key text := 'enquiry_reply:' || p_operation_key;
  previous_reply text;
begin
  perform 1 from public.staff_members
  where user_id = p_actor_id and role in ('warehouse', 'catalogue')
  order by role limit 1 for key share;
  if not found then
    raise exception using errcode = '42501', message = 'requests_role_required';
  end if;

  select * into enquiry from public.enquiries where id = p_enquiry_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'enquiry_not_found';
  end if;

  if p_action = 'reply' then
    if p_operation_key is null or coalesce(length(reply_body), 0) not between 1 and 2000 then
      raise exception using errcode = '22023', message = 'enquiry_reply_required';
    end if;
    select message_body into previous_reply from public.order_outbox
    where enquiry_id = enquiry.id and message_key = reply_key;
    if found then
      if previous_reply is distinct from reply_body then
        raise exception using errcode = '22023', message = 'enquiry_operation_conflict';
      end if;
      return enquiry.id;
    end if;
  elsif p_action = 'close' and enquiry.status = 'resolved' then
    return enquiry.id;
  end if;

  if enquiry.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '22023', message = 'enquiry_stale';
  end if;
  if enquiry.status = 'resolved' then
    raise exception using errcode = '22023', message = 'enquiry_closed';
  end if;

  case p_action
    when 'reply' then
      insert into public.order_outbox (enquiry_id, message_key, message_subject, message_body)
      values (enquiry.id, reply_key, 'Your Edgey enquiry', reply_body);
      update public.enquiries
      set status = case when status = 'converted' then status else 'replied' end
      where id = enquiry.id;
    when 'match' then
      if enquiry.kind <> 'compatibility' or enquiry.status = 'converted' then
        raise exception using errcode = '22023', message = 'enquiry_cannot_match';
      end if;
      perform 1 from public.variants where id = p_variant_id and publication_status = 'published'
      for no key update;
      if not found then
        raise exception using errcode = '22023', message = 'variant_not_published';
      end if;
      if candidate is not null then
        if candidate !~ '^[A-Za-z0-9][A-Za-z0-9 ./_+-]{0,79}$' then
          raise exception using errcode = '22023', message = 'invalid_candidate_code';
        end if;
        insert into public.compatibility (variant_id, code, code_kind, evidence_source, verification_state, is_private)
        values (p_variant_id, candidate, 'alias', 'Staff enquiry match', 'candidate', true)
        on conflict (variant_id, code_normalised) do nothing;
      end if;
      update public.enquiries set status = 'converted', matched_variant_id = p_variant_id where id = enquiry.id;
    when 'close' then
      update public.enquiries set status = 'resolved' where id = enquiry.id;
    else
      raise exception using errcode = '22023', message = 'invalid_enquiry_action';
  end case;
  return enquiry.id;
end;
$$;

revoke all on function public.handle_admin_enquiry(uuid, uuid, text, timestamptz, uuid, text, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.handle_admin_enquiry(uuid, uuid, text, timestamptz, uuid, text, uuid, text)
to service_role;

create index admin_trial_email_history_idx on public.trial_requests (lower(email), created_at);
create index admin_trial_company_history_idx on public.trial_requests (lower(btrim(company)), created_at);
create index admin_trial_postcode_history_idx on public.trial_requests (postcode, created_at);

create function public.admin_trial_duplicate_evidence(p_trial_request_id uuid)
returns table (id uuid, company text, created_at timestamptz, same_email boolean, same_company boolean, same_postcode boolean)
language sql stable security invoker set search_path = ''
as $$
  select earlier.id, earlier.company, earlier.created_at,
    lower(earlier.email) = lower(current_trial.email),
    lower(btrim(earlier.company)) = lower(btrim(current_trial.company)),
    earlier.postcode = current_trial.postcode
  from public.trial_requests as current_trial
  join public.trial_requests as earlier on earlier.created_at < current_trial.created_at
    and (lower(earlier.email) = lower(current_trial.email)
      or lower(btrim(earlier.company)) = lower(btrim(current_trial.company))
      or earlier.postcode = current_trial.postcode)
  where current_trial.id = p_trial_request_id
  order by (lower(earlier.email) = lower(current_trial.email)) desc,
    (lower(btrim(earlier.company)) = lower(btrim(current_trial.company))) desc,
    earlier.created_at desc, earlier.id
  limit 20;
$$;

revoke all on function public.admin_trial_duplicate_evidence(uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_trial_duplicate_evidence(uuid) to authenticated;

create function public.admin_trial_order_candidates(p_trial_request_id uuid, p_actor_id uuid)
returns table (id uuid, created_at timestamptz, match_kind text)
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_warehouse(p_actor_id);
  return query
  select purchase.id, purchase.created_at,
    case when lower(account.email) = lower(request.email) and account.email_confirmed_at is not null
      and not account.is_anonymous then 'verified_account_email' else 'order_email' end
  from public.trial_requests as request
  join public.trial_fulfilments as fulfilment on fulfilment.trial_request_id = request.id
  join public.orders as purchase on purchase.created_at > fulfilment.dispatched_at
  left join auth.users as account on account.id = purchase.buyer_id
  where request.id = p_trial_request_id and fulfilment.state = 'dispatched'
    and fulfilment.subsequent_order_id is null and purchase.authorised_at is not null
    and purchase.fulfilment_status <> 'cancelled' and purchase.payment_status not in ('voided', 'refunded')
    and not exists (select 1 from public.trial_fulfilments where subsequent_order_id = purchase.id)
    and (lower(purchase.email) = lower(request.email)
      or (lower(account.email) = lower(request.email) and account.email_confirmed_at is not null and not account.is_anonymous))
  order by (lower(account.email) = lower(request.email) and account.email_confirmed_at is not null
      and not account.is_anonymous) desc nulls last, purchase.created_at, purchase.id
  limit 5;
end;
$$;

revoke all on function public.admin_trial_order_candidates(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_trial_order_candidates(uuid, uuid) to service_role;

create or replace function public.purge_request_data(
  p_enquiry_age interval, p_trial_age interval, p_trade_age interval, p_search_age interval,
  p_rate_window_grace interval default interval '0'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  cutoff_now timestamptz := clock_timestamp();
  enquiry_count bigint;
  trial_count bigint;
  trade_count bigint;
  search_count bigint;
  window_count bigint;
begin
  if coalesce(p_enquiry_age, interval '0') <= interval '0'
    or coalesce(p_trial_age, interval '0') <= interval '0'
    or coalesce(p_trade_age, interval '0') <= interval '0'
    or coalesce(p_search_age, interval '0') <= interval '0'
    or p_rate_window_grace is null or p_rate_window_grace < interval '0'
  then
    raise exception using errcode = '22023', message = 'invalid_request_retention_period';
  end if;

  delete from public.enquiries where created_at < cutoff_now - p_enquiry_age and status <> 'converted'
    and (status = 'pending' or updated_at < cutoff_now - p_enquiry_age);
  get diagnostics enquiry_count = row_count;
  delete from public.trial_requests where created_at < cutoff_now - p_trial_age and status <> 'approved'
    and (status = 'pending' or updated_at < cutoff_now - p_trial_age);
  get diagnostics trial_count = row_count;
  delete from public.trade_applications where created_at < cutoff_now - p_trade_age and status <> 'approved';
  get diagnostics trade_count = row_count;
  delete from public.finder_search_events where created_at < cutoff_now - p_search_age;
  get diagnostics search_count = row_count;
  with expired as (
    select scope, dimension, key from private.request_rate_limits
    where expires_at < least(cutoff_now, cutoff_now - p_rate_window_grace)
    for update skip locked
  )
  delete from private.request_rate_limits as counter using expired
  where (counter.scope, counter.dimension, counter.key) = (expired.scope, expired.dimension, expired.key);
  get diagnostics window_count = row_count;
  return jsonb_build_object('enquiries', enquiry_count, 'trials', trial_count, 'trade_applications', trade_count,
    'finder_search_events', search_count, 'rate_limit_windows', window_count);
end;
$$;

comment on function public.purge_request_data(interval, interval, interval, interval, interval) is
  'Run only with approved retention. Preserve recently handled enquiries and trial requests; keep matched enquiries and approved trade/trial records including cancelled trial ledger history. Deleting a request cascades its outbox, never an order outbox.';
