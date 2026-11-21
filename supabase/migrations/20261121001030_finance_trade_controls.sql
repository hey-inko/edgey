alter table public.trade_applications
  add column approval_started_at timestamptz,
  add column approval_stripe_account_id text check (approval_stripe_account_id ~ '^acct_[A-Za-z0-9]{1,195}$'),
  add constraint trade_approval_provider_evidence_check
    check ((approval_started_at is null) = (approval_stripe_account_id is null)),
  add column rejection_reason text check (
    rejection_reason is null or (status = 'rejected' and length(btrim(rejection_reason)) between 1 and 500)
  );

alter table public.order_outbox
  drop constraint outbox_message_matches_source,
  drop constraint outbox_message_copy_required,
  add constraint outbox_message_matches_source check (
    (order_id is not null and message_key = 'order_confirmation')
    or (order_id is null and message_key in ('confirmation', 'staff_notification'))
    or (trial_request_id is not null and message_key in ('trial_approved', 'trial_declined', 'trial_dispatched'))
    or (enquiry_id is not null and
      message_key ~ '^enquiry_reply:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (trade_application_id is not null and message_key in ('trade_approved', 'trade_rejected'))
  ),
  add constraint outbox_message_copy_required check (
    (
      message_key not in ('trial_approved', 'trial_declined', 'trial_dispatched', 'trade_approved', 'trade_rejected')
      and message_key not like 'enquiry_reply:%'
    )
    or (
      coalesce(length(btrim(message_subject)), 0) > 0
      and coalesce(length(btrim(message_body)), 0) > 0
    )
  );

create function public.begin_trade_account_approval(p_application_id uuid, p_actor_id uuid, p_stripe_account_id text)
returns public.trade_applications
language plpgsql security definer set search_path = ''
as $$
declare application public.trade_applications;
begin
  perform private.require_finance(p_actor_id);
  if coalesce(p_stripe_account_id, '') !~ '^acct_[A-Za-z0-9]{1,195}$' then
    raise exception using errcode = '22023', message = 'invalid_trade_approval_stripe_account';
  end if;
  select * into strict application from public.trade_applications where id = p_application_id for update;
  if application.status not in ('pending', 'approved') then
    raise exception using errcode = '22023', message = 'trade_application_not_reviewable';
  end if;
  if not exists (
    select 1 from auth.users where id = application.buyer_id and email_confirmed_at is not null and not is_anonymous
  ) then
    raise exception using errcode = '42501', message = 'verified_buyer_required';
  end if;
  if application.approval_started_at is null then
    update public.trade_applications set approval_started_at = clock_timestamp(), approval_stripe_account_id = p_stripe_account_id
    where id = p_application_id returning * into application;
  elsif application.approval_stripe_account_id <> p_stripe_account_id then
    raise exception using errcode = '22023', message = 'trade_approval_stripe_account_mismatch';
  end if;
  return application;
end;
$$;

create function public.review_admin_trade_application(
  p_application_id uuid, p_actor_id uuid, p_decision text,
  p_credit_limit_pence integer default null, p_stripe_customer_id text default null, p_reason text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  application public.trade_applications;
begin
  perform private.require_finance(p_actor_id);
  select * into strict application from public.trade_applications where id = p_application_id for update;

  if p_decision = 'approved' then
    if p_reason is not null then
      raise exception using errcode = '22023', message = 'invalid_trade_application_decision';
    end if;
    if application.status not in ('pending', 'approved') or application.approval_started_at is null then
      raise exception using errcode = '22023', message = 'trade_application_not_reviewable';
    end if;
    if application.status = 'pending' then
      perform public.review_trade_application(p_application_id, p_actor_id, 'approved');
    end if;
    perform public.approve_trade_account(p_application_id, p_actor_id, p_credit_limit_pence, p_stripe_customer_id);
    insert into public.order_outbox (trade_application_id, message_key, message_subject, message_body)
    values (p_application_id, 'trade_approved', 'Your Edgey trade account is approved',
      'Your Edgey trade account is approved. Sign in to view your account and credit limit.')
    on conflict (trade_application_id, message_key) do nothing;
  elsif p_decision = 'rejected' then
    if p_credit_limit_pence is not null or p_stripe_customer_id is not null then
      raise exception using errcode = '22023', message = 'invalid_trade_application_decision';
    end if;
    if coalesce(length(btrim(p_reason)), 0) not between 1 and 500 then
      raise exception using errcode = '22023', message = 'trade_rejection_reason_required';
    end if;
    if application.status = 'rejected' and application.reviewed_by = p_actor_id
      and application.rejection_reason = btrim(p_reason) then
      return p_application_id;
    end if;
    if application.status <> 'pending' or application.approval_started_at is not null then
      raise exception using errcode = '22023', message = 'trade_application_not_reviewable';
    end if;
    perform public.review_trade_application(p_application_id, p_actor_id, 'rejected');
    update public.trade_applications set rejection_reason = btrim(p_reason) where id = p_application_id;
    insert into public.order_outbox (trade_application_id, message_key, message_subject, message_body)
    values (p_application_id, 'trade_rejected', 'Update on your Edgey trade application',
      'We could not approve your Edgey trade application. You can still pay by card at checkout.');
  else
    raise exception using errcode = '22023', message = 'invalid_trade_application_decision';
  end if;

  return p_application_id;
end;
$$;

alter type public.credit_ledger_kind add value 'reinstate';
alter table public.credit_ledger add constraint credit_ledger_reinstate_check check (
  kind::text <> 'reinstate' or (
    order_id is null and actor_id is not null and held_delta_pence = 0 and outstanding_delta_pence = 0
  )
);

create function public.reinstate_trade_account(
  p_trade_account_id uuid, p_actor_id uuid, p_operation_key text, p_reason text
)
returns public.trade_accounts
language plpgsql security definer set search_path = ''
as $$
declare account public.trade_accounts;
begin
  perform private.require_finance(p_actor_id);
  if coalesce(length(btrim(p_reason)), 0) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reinstatement_reason_required';
  end if;
  account := private.lock_trade_account(p_trade_account_id);
  if not private.record_credit_operation(account.id, null, p_actor_id, 'reinstate', p_operation_key,
    jsonb_build_array(btrim(p_reason)), 0, 0) then
    return account;
  end if;
  if account.status <> 'suspended' then
    raise exception using errcode = '22023', message = 'trade_account_not_suspended';
  end if;
  if not exists (
    select 1 from auth.users where id = account.buyer_id and email_confirmed_at is not null and not is_anonymous
  ) then
    raise exception using errcode = '42501', message = 'verified_buyer_required';
  end if;
  update public.trade_accounts set status = 'approved', updated_at = clock_timestamp()
  where id = account.id returning * into account;
  return account;
end;
$$;

revoke all on function public.begin_trade_account_approval(uuid, uuid, text),
  public.review_admin_trade_application(uuid, uuid, text, integer, text, text),
  public.reinstate_trade_account(uuid, uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.begin_trade_account_approval(uuid, uuid, text),
  public.review_admin_trade_application(uuid, uuid, text, integer, text, text),
  public.reinstate_trade_account(uuid, uuid, text, text)
to service_role;
