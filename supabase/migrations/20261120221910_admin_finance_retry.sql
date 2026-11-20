create table public.finance_retry_requests (
  kind text not null check (kind in ('event', 'confirmation')),
  target_id text not null,
  target_updated_at timestamptz not null,
  requested_at timestamptz not null default now(),
  requested_by uuid not null,
  primary key (kind, target_id)
);

alter table public.finance_retry_requests enable row level security;
revoke all on public.finance_retry_requests from public, anon, authenticated, service_role;
grant select (kind, target_id, target_updated_at, requested_at) on public.finance_retry_requests to authenticated, service_role;
create policy finance_retry_requests_read on public.finance_retry_requests for select to authenticated
using ((select private.has_staff_role('finance')));

create function public.request_finance_retry(p_actor_id uuid, p_kind text, p_target_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  retry_version timestamptz;
begin
  perform 1 from public.staff_members where user_id = p_actor_id and role = 'finance' for key share;
  if not found then
    raise exception using errcode = '42501', message = 'finance_role_required';
  end if;

  if p_kind = 'event' and p_target_id ~ '^evt_[A-Za-z0-9_]{1,196}$' then
    select updated_at into retry_version from public.provider_events
    where provider = 'stripe' and event_id = p_target_id and state = 'failed'
    for no key update;
  elsif p_kind = 'confirmation' and p_target_id ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
    p_target_id := lower(p_target_id);
    select updated_at into retry_version from public.order_outbox
    where order_id = p_target_id::uuid and message_key = 'order_confirmation' and state = 'failed'
    for no key update;
  else
    return false;
  end if;
  if not found then return false; end if;

  insert into public.finance_retry_requests as request (kind, target_id, target_updated_at, requested_by)
  values (p_kind, p_target_id, retry_version, p_actor_id)
  on conflict (kind, target_id) do update set target_updated_at = excluded.target_updated_at,
    requested_at = excluded.requested_at, requested_by = excluded.requested_by
  where request.target_updated_at is distinct from excluded.target_updated_at;
  return true;
end;
$$;

revoke all on function public.request_finance_retry(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.request_finance_retry(uuid, text, text) to service_role;
