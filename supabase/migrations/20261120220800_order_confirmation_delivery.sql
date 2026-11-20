alter table public.order_outbox
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column next_attempt_at timestamptz not null default now(),
  add column last_error text,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column send_started_at timestamptz,
  add column send_provider text check (send_provider in ('resend', 'file')),
  add column send_payload text,
  add column send_in_flight boolean not null default false,
  add column delivery_uncertain boolean not null default false,
  add column provider_message_id text,
  add column sent_at timestamptz,
  add check ((lease_token is null) = (lease_until is null)),
  add check ((send_started_at is null) = (send_payload is null)),
  add check ((send_provider is null) = (send_payload is null)),
  add check (not send_in_flight or (lease_token is not null and send_started_at is not null)),
  add check ((sent_at is null) = (provider_message_id is null)),
  add check (sent_at is null or state = 'sent');

create index outbox_email_pending_idx on public.order_outbox (message_key, next_attempt_at, created_at, id)
where state = 'pending';
create or replace trigger order_outbox_touch before update on public.order_outbox
for each row execute function private.touch_updated_at();

revoke select on public.order_outbox from authenticated;
grant select (
  id, order_id, enquiry_id, trial_request_id, trade_application_id,
  message_key, state, created_at, updated_at, attempt_count, next_attempt_at,
  last_error, delivery_uncertain, provider_message_id, sent_at
) on public.order_outbox to authenticated;

create function private.outbox_email_send_deadline(p_started_at timestamptz)
returns timestamptz
language sql immutable set search_path = ''
as $$
  select p_started_at + interval '23 hours 55 minutes';
$$;

create function public.claim_outbox_email(
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
  if p_message_key is null or p_message_key not in ('order_confirmation', 'confirmation', 'staff_notification')
    or (p_replay_order_id is not null and p_message_key <> 'order_confirmation') then
    raise exception using errcode = '22023', message = 'invalid_outbox_email_queue';
  end if;
  perform private.prune_payment_rate_limits();

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

create function public.begin_outbox_email_send(
  p_outbox_id uuid, p_lease_token uuid, p_provider text default null, p_payload text default null,
  p_recipient_fingerprint text default null
)
returns setof public.order_outbox
language plpgsql security definer set search_path = ''
as $$
declare
  target public.order_outbox;
  started_at timestamptz;
begin
  select * into target from public.order_outbox
  where id = p_outbox_id
    and state = 'pending' and lease_token = p_lease_token and not send_in_flight
  for update;
  if not found then
    return;
  end if;
  started_at := clock_timestamp();
  if target.lease_until <= started_at
    or private.outbox_email_send_deadline(target.send_started_at) <= started_at then
    return;
  end if;

  if target.send_payload is null then
    if p_provider is null or p_provider not in ('file', 'resend')
      or p_payload is null or jsonb_typeof(p_payload::jsonb) <> 'object' then
      raise exception using errcode = '22023', message = 'invalid_outbox_email_payload';
    end if;

    if target.message_key = 'confirmation' then
      if p_recipient_fingerprint is null or p_recipient_fingerprint !~ '^[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'invalid_receipt_recipient_fingerprint';
      end if;
      insert into private.payment_rate_limits as counter (scope, dimension, key, attempts, expires_at)
      values ('request_receipt', 'email', p_recipient_fingerprint, 1, started_at + interval '24 hours')
      on conflict (scope, dimension, key) do update set attempts = 1, expires_at = excluded.expires_at
      where counter.expires_at <= started_at;
      if not found then
        return query update public.order_outbox
        set state = 'failed', last_error = 'recipient_throttled', lease_token = null, lease_until = null
        where id = target.id returning *;
        return;
      end if;
    elsif p_recipient_fingerprint is not null then
      raise exception using errcode = '22023', message = 'unexpected_receipt_recipient_fingerprint';
    end if;
  elsif p_provider is not null or p_payload is not null or p_recipient_fingerprint is not null then
    raise exception using errcode = '22023', message = 'outbox_email_payload_frozen';
  end if;

  return query update public.order_outbox
  set send_started_at = coalesce(send_started_at, started_at), send_payload = coalesce(send_payload, p_payload),
    send_provider = coalesce(send_provider, p_provider), send_in_flight = true,
    attempt_count = attempt_count + 1, lease_until = started_at + interval '60 seconds'
  where id = target.id returning *;
end;
$$;

create function public.finish_outbox_email(
  p_outbox_id uuid, p_lease_token uuid, p_outcome text, p_provider_message_id text default null
)
returns setof public.order_outbox
language plpgsql security definer set search_path = ''
as $$
declare
  target public.order_outbox;
  finished_at timestamptz;
  deadline timestamptz;
  retry_at timestamptz;
  next_state public.order_message_state;
  outcome text := p_outcome;
  uncertain boolean;
begin
  select * into target from public.order_outbox
  where id = p_outbox_id
    and state = 'pending' and lease_token = p_lease_token
  for update;
  if not found then
    return;
  end if;

  if outcome is null or outcome not in (
    'sent', 'defer_invoice', 'preparation_failed', 'configuration_error',
    'provider_rejected', 'provider_rate_limited', 'provider_uncertain', 'provider_conflict'
  ) or target.send_in_flight <> (outcome in (
    'sent', 'provider_rejected', 'provider_rate_limited', 'provider_uncertain', 'provider_conflict'
  )) or (outcome = 'sent' and coalesce(length(btrim(p_provider_message_id)), 0) not between 1 and 200)
    or (outcome <> 'sent' and p_provider_message_id is not null)
    or (outcome = 'defer_invoice' and (target.message_key <> 'order_confirmation' or target.send_started_at is not null)) then
    raise exception using errcode = '22023', message = 'invalid_outbox_email_outcome';
  end if;

  finished_at := clock_timestamp();
  deadline := private.outbox_email_send_deadline(target.send_started_at);
  uncertain := outcome <> 'sent' and (target.delivery_uncertain or outcome in ('provider_uncertain', 'provider_conflict'));
  if outcome = 'sent' then
    next_state := 'sent';
  elsif outcome = 'provider_conflict' or deadline <= finished_at then
    next_state := 'failed';
    outcome := case when uncertain then 'delivery_unconfirmed' else 'retry_window_expired' end;
  elsif outcome = 'defer_invoice' then
    next_state := 'pending';
    retry_at := finished_at + interval '1 minute';
  elsif outcome in ('provider_rate_limited', 'provider_uncertain') and target.attempt_count < 10 then
    next_state := 'pending';
    retry_at := least(deadline, finished_at + interval '1 minute' * (1 << (target.attempt_count - 1)));
  else
    next_state := 'failed';
  end if;

  return query update public.order_outbox
  set state = next_state, next_attempt_at = coalesce(retry_at, finished_at),
    last_error = case when outcome not in ('sent', 'defer_invoice') then outcome end,
    lease_token = null, lease_until = null, send_in_flight = false,
    delivery_uncertain = uncertain, provider_message_id = p_provider_message_id,
    sent_at = case when next_state = 'sent' then finished_at end
  where id = target.id returning *;
end;
$$;

revoke all on function private.outbox_email_send_deadline(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.claim_outbox_email(text, uuid, timestamptz),
  public.begin_outbox_email_send(uuid, uuid, text, text, text),
  public.finish_outbox_email(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_outbox_email(text, uuid, timestamptz),
  public.begin_outbox_email_send(uuid, uuid, text, text, text),
  public.finish_outbox_email(uuid, uuid, text, text) to service_role;
