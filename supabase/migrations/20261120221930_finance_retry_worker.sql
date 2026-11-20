create or replace trigger provider_events_touch before update on public.provider_events
for each row when (old.state is distinct from new.state or old.last_error is distinct from new.last_error)
execute function private.touch_updated_at();

alter table public.finance_retry_requests
  add column worker_token uuid,
  add column worker_until timestamptz,
  add column result text check (result in ('processed', 'failed', 'sent', 'pending', 'not_replayable')),
  add check ((worker_token is null) = (worker_until is null));

grant select (result) on public.finance_retry_requests to authenticated;

create function private.reset_finance_retry_worker()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.worker_token := null;
  new.worker_until := null;
  new.result := null;
  return new;
end;
$$;
revoke all on function private.reset_finance_retry_worker() from public, anon, authenticated, service_role;

create trigger finance_retry_worker_reset before update on public.finance_retry_requests
for each row when (old.target_updated_at is distinct from new.target_updated_at)
execute function private.reset_finance_retry_worker();

create function public.claim_finance_retries(p_kind text)
returns setof public.finance_retry_requests
language sql security definer set search_path = ''
as $$
  with eligible as (
    select request.kind, request.target_id
    from public.finance_retry_requests request
    where request.kind = p_kind and request.result is null
      and (request.worker_until is null or request.worker_until <= clock_timestamp())
      and case request.kind
        when 'event' then exists (
          select 1 from public.provider_events event
          where event.provider = 'stripe' and event.event_id = request.target_id
            and event.state = 'failed' and event.updated_at = request.target_updated_at
        )
        when 'confirmation' then exists (
          select 1 from public.order_outbox message
          where message.order_id = request.target_id::uuid and message.message_key = 'order_confirmation'
            and message.state = 'failed' and message.updated_at = request.target_updated_at
        )
      end
    order by request.requested_at, request.target_id limit 3
    for update of request skip locked
  )
  update public.finance_retry_requests request
  set worker_token = gen_random_uuid(), worker_until = clock_timestamp() + interval '2 minutes'
  from eligible where (request.kind, request.target_id) = (eligible.kind, eligible.target_id)
  returning request.*;
$$;

create function public.finish_finance_retry(p_kind text, p_target_id text, p_worker_token uuid, p_result text)
returns void
language sql security definer set search_path = ''
as $$
  update public.finance_retry_requests
  set result = p_result, worker_token = null, worker_until = null
  where kind = p_kind and target_id = p_target_id and worker_token = p_worker_token;
$$;
revoke all on function public.claim_finance_retries(text),
  public.finish_finance_retry(text, text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_finance_retries(text),
  public.finish_finance_retry(text, text, uuid, text) to service_role;
