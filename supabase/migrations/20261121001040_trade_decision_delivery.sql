drop index public.outbox_email_request_follow_up_pending_idx;
create index outbox_email_request_follow_up_pending_idx
on public.order_outbox (next_attempt_at, created_at, id)
where state = 'pending' and (
  message_key in ('trial_approved', 'trial_declined', 'trial_dispatched', 'trade_approved', 'trade_rejected')
  or starts_with(message_key, 'enquiry_reply:')
);

create or replace function public.claim_outbox_email(
  p_message_key text, p_replay_order_id uuid default null, p_expected_updated_at timestamptz default null
)
returns setof public.order_outbox
language plpgsql security definer set search_path = ''
as $$
declare
  target public.order_outbox;
  claimed_at timestamptz := clock_timestamp();
  uncertain boolean;
begin
  if p_message_key is null or p_message_key not in (
    'order_confirmation', 'confirmation', 'staff_notification', 'request_follow_up'
  )
    or (p_replay_order_id is not null and p_message_key <> 'order_confirmation') then
    raise exception using errcode = '22023', message = 'invalid_outbox_email_queue';
  end if;
  perform private.prune_payment_rate_limits();

  if p_message_key = 'request_follow_up' then
    select * into target from public.order_outbox
    where state = 'pending'
      and (message_key in ('trial_approved', 'trial_declined', 'trial_dispatched', 'trade_approved', 'trade_rejected') or starts_with(message_key, 'enquiry_reply:'))
      and next_attempt_at <= claimed_at
      and (lease_until is null or lease_until <= claimed_at)
    order by next_attempt_at, created_at, id
    for update skip locked limit 1;
  else
    select * into target from public.order_outbox
    where message_key = p_message_key
      and (lease_until is null or lease_until <= claimed_at)
      and (
        (p_replay_order_id is null and state = 'pending' and next_attempt_at <= claimed_at)
        or (order_id = p_replay_order_id and state = 'failed'
          and (p_expected_updated_at is null or updated_at = p_expected_updated_at)
          and coalesce(last_error, '') not in ('delivery_unconfirmed', 'retry_window_expired'))
      )
    order by next_attempt_at, created_at, id
    for update skip locked limit 1;
  end if;
  if not found then
    return;
  end if;

  uncertain := target.delivery_uncertain or target.send_in_flight;
  if private.outbox_email_send_deadline(target.send_started_at) <= claimed_at then
    return query update public.order_outbox
    set state = 'failed', lease_token = null, lease_until = null, send_in_flight = false,
      delivery_uncertain = uncertain,
      last_error = case when uncertain then 'delivery_unconfirmed' else 'retry_window_expired' end
    where id = target.id returning *;
    return;
  end if;

  if p_replay_order_id is null and target.attempt_count >= 10 then
    return query update public.order_outbox
    set state = 'failed', lease_token = null, lease_until = null, send_in_flight = false,
      delivery_uncertain = uncertain,
      last_error = case when target.send_in_flight then 'provider_uncertain'
        else coalesce(target.last_error, 'provider_uncertain') end
    where id = target.id returning *;
    return;
  end if;

  return query update public.order_outbox
  set state = 'pending', next_attempt_at = claimed_at, lease_token = gen_random_uuid(),
    lease_until = claimed_at + interval '60 seconds', send_in_flight = false, delivery_uncertain = uncertain
  where id = target.id returning *;
end;
$$;
