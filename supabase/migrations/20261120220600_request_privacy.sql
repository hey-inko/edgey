create table private.request_rate_limits (
  scope text not null check (scope in ('enquiry', 'trial', 'trade', 'trade_sign_in', 'trade_verify')),
  dimension text not null check (dimension in ('ip', 'email')),
  key text not null check (key ~ '^[a-f0-9]{64}$'),
  attempts integer not null check (attempts > 0),
  expires_at timestamptz not null,
  primary key (scope, dimension, key)
);
create index request_rate_limits_expiry_idx on private.request_rate_limits (expires_at);
alter table private.request_rate_limits enable row level security;
revoke all on private.request_rate_limits from public, anon, authenticated, service_role;

create function public.consume_request_rate_limit(p_scope text, p_ip_key text, p_email_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  dimension_limit record;
  checked_at timestamptz := clock_timestamp();
begin
  if p_scope is null or p_scope not in ('enquiry', 'trial', 'trade', 'trade_sign_in', 'trade_verify')
    or p_ip_key is null or p_ip_key !~ '^[a-f0-9]{64}$'
    or p_email_key is null or p_email_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_request_rate_limit_input';
  end if;

  for dimension_limit in
    select * from (values
      (1, 'ip', p_ip_key, case when p_scope in ('trade_sign_in', 'trade_verify') then 20 else 10 end),
      (2, 'email', p_email_key, case when p_scope in ('trade_sign_in', 'trade_verify') then 5 else 3 end)
    ) as limits(lock_order, dimension, key, quota) order by lock_order
  loop
    insert into private.request_rate_limits as counter (scope, dimension, key, attempts, expires_at)
    values (p_scope, dimension_limit.dimension, dimension_limit.key, 1, checked_at + interval '1 hour')
    on conflict (scope, dimension, key) do update set
      attempts = case when counter.expires_at <= checked_at then 1 else counter.attempts + 1 end,
      expires_at = case when counter.expires_at <= checked_at then excluded.expires_at else counter.expires_at end
    where counter.expires_at <= checked_at or counter.attempts < dimension_limit.quota;
    if not found then
      raise sqlstate 'P0901' using message = 'request_rate_limit_exceeded';
    end if;
  end loop;
  return true;
exception when sqlstate 'P0901' then
  return false;
end;
$$;

comment on function public.consume_request_rate_limit(text, text, text) is
  'Consume both HMAC-SHA256 dimensions atomically in rolling-start one-hour windows. Forms allow 10/IP and 3/email; trade sign-in and verification allow 20/IP and 5/email each. An unsuccessful admission consumes neither counter.';

create table public.finder_search_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  normalised_query text check (
    length(normalised_query) between 1 and 200 and btrim(normalised_query) = normalised_query
    and normalised_query !~ '[@[:cntrl:]]'
  ),
  query_fingerprint text check (query_fingerprint ~ '^[a-f0-9]{64}$'),
  outcome text not null check (outcome in ('exact', 'suggested', 'unmatched')),
  check (num_nonnulls(normalised_query, query_fingerprint) <= 1)
);
create index finder_search_events_created_at_idx on public.finder_search_events (created_at);
alter table public.finder_search_events enable row level security;
revoke all on public.finder_search_events from public, anon, authenticated, service_role;
grant select on public.finder_search_events to service_role;

create function public.record_finder_search(
  p_outcome text, p_normalised_query text default null, p_query_fingerprint text default null
)
returns uuid
language sql security definer set search_path = ''
as $$
  insert into public.finder_search_events (outcome, normalised_query, query_fingerprint)
  values (p_outcome, p_normalised_query, p_query_fingerprint) returning id;
$$;

comment on function public.record_finder_search(text, text, text) is
  'Send clear text only for normalised public catalogue values. HMAC other safe input with a server-only key; omit both query fields for outcome-only redaction.';

create function public.purge_request_data(
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

  delete from public.enquiries where created_at < cutoff_now - p_enquiry_age and status <> 'converted';
  get diagnostics enquiry_count = row_count;
  delete from public.trial_requests where created_at < cutoff_now - p_trial_age and status <> 'approved';
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
  'Schedule from a trusted job only after operations approves each retention age. Deletes by creation time and cascades request outbox rows in every delivery state. Preserves converted enquiries and approved trade/trial records (including cancelled trials with ledger entries). Never deletes an unexpired rate window or changes order outbox rows.';

revoke all on function
  public.consume_request_rate_limit(text, text, text),
  public.record_finder_search(text, text, text),
  public.purge_request_data(interval, interval, interval, interval, interval)
from public, anon, authenticated, service_role;
grant execute on function
  public.consume_request_rate_limit(text, text, text),
  public.record_finder_search(text, text, text),
  public.purge_request_data(interval, interval, interval, interval, interval)
to service_role;
