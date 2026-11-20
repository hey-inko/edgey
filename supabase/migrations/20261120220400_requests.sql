create domain private.request_email as text
  check (length(value) <= 254 and value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

create domain private.uk_request_postcode as text
  check (value ~ '^(GIR 0AA|[A-PR-UWYZ]([0-9]([0-9]|[A-HJKPSTUW])?|[A-HK-Y][0-9]([0-9]|[ABEHMNPRVWXY])?) [0-9][ABD-HJLNP-UW-Z]{2})$');

create table public.enquiries (
  id uuid primary key,
  kind text not null check (kind in ('compatibility', 'delivery')),
  email private.request_email not null,
  query text check (length(btrim(query)) between 1 and 200),
  postcode private.uk_request_postcode,
  machine_brand text check (length(btrim(machine_brand)) between 1 and 100),
  message text not null check (length(btrim(message)) between 1 and 2000),
  status text not null default 'pending'
    check (status in ('pending', 'in_review', 'resolved', 'converted')),
  staff_notes text check (length(btrim(staff_notes)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'delivery' or postcode is not null)
);

create table public.trial_requests (
  id uuid primary key,
  machine_brand text not null check (length(btrim(machine_brand)) between 1 and 100),
  oem_code text not null check (length(btrim(oem_code)) between 1 and 200),
  email private.request_email not null,
  company text not null check (length(btrim(company)) between 1 and 200),
  postcode private.uk_request_postcode not null,
  status text not null default 'pending'
    check (status in ('pending', 'in_review', 'declined', 'approved')),
  staff_notes text check (length(btrim(staff_notes)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.trade_applications (
  id uuid primary key,
  buyer_id uuid unique references auth.users (id) on delete set null,
  email private.request_email not null,
  buyer_name text not null check (length(btrim(buyer_name)) between 1 and 200),
  company text not null check (length(btrim(company)) between 1 and 200),
  billing_line1 text not null check (length(btrim(billing_line1)) between 1 and 200),
  billing_line2 text check (length(btrim(billing_line2)) between 1 and 200),
  billing_town text not null check (length(btrim(billing_town)) between 1 and 100),
  billing_postcode private.uk_request_postcode not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'pending' and reviewed_at is null and reviewed_by is null)
    or (status <> 'pending' and reviewed_at is not null and reviewed_by is not null))
);

create index enquiries_purge_idx on public.enquiries (created_at) where status <> 'converted';
create index trial_requests_purge_idx on public.trial_requests (created_at) where status <> 'approved';
create index trade_applications_purge_idx on public.trade_applications (created_at) where status <> 'approved';

create trigger enquiries_touch before update on public.enquiries
for each row execute function private.touch_updated_at();
create trigger trial_requests_touch before update on public.trial_requests
for each row execute function private.touch_updated_at();
create trigger trade_applications_touch before update on public.trade_applications
for each row execute function private.touch_updated_at();

alter table public.enquiries enable row level security;
alter table public.trial_requests enable row level security;
alter table public.trade_applications enable row level security;
revoke all on public.enquiries, public.trial_requests, public.trade_applications
from public, anon, authenticated, service_role;
grant select on public.enquiries, public.trial_requests to authenticated, service_role;
grant select on public.trade_applications to service_role;
grant select (id, buyer_id, email, buyer_name, company, billing_line1, billing_line2, billing_town,
  billing_postcode, status, reviewed_at, created_at, updated_at) on public.trade_applications to authenticated;
grant update (status, staff_notes) on public.enquiries, public.trial_requests to authenticated;

create policy enquiries_read on public.enquiries for select to authenticated
using ((select private.has_staff_role('warehouse', 'catalogue')));
create policy enquiries_update on public.enquiries for update to authenticated
using ((select private.has_staff_role('warehouse', 'catalogue')))
with check ((select private.has_staff_role('warehouse', 'catalogue')));
create policy trial_requests_read on public.trial_requests for select to authenticated
using ((select private.has_staff_role('warehouse', 'catalogue')));
create policy trial_requests_review on public.trial_requests for update to authenticated
using (status <> 'approved' and (select private.has_staff_role('warehouse', 'catalogue')))
with check (status <> 'approved' and (select private.has_staff_role('warehouse', 'catalogue')));
create policy trade_applications_read on public.trade_applications for select to authenticated
using (buyer_id = (select auth.uid()) or (select private.has_staff_role('finance')));

alter table public.order_outbox
  drop constraint order_outbox_pkey,
  drop constraint order_outbox_message_key_check,
  alter column order_id drop not null,
  add column id uuid primary key default gen_random_uuid(),
  add column enquiry_id uuid references public.enquiries (id) on delete cascade,
  add column trial_request_id uuid references public.trial_requests (id) on delete cascade,
  add column trade_application_id uuid references public.trade_applications (id) on delete cascade,
  add unique (order_id, message_key),
  add unique (enquiry_id, message_key),
  add unique (trial_request_id, message_key),
  add unique (trade_application_id, message_key),
  add constraint outbox_one_source
    check (num_nonnulls(order_id, enquiry_id, trial_request_id, trade_application_id) = 1),
  add constraint outbox_message_matches_source check (
    (order_id is not null and message_key = 'order_confirmation')
    or (order_id is null and message_key in ('confirmation', 'staff_notification'))
  );

alter policy order_outbox_read on public.order_outbox
using (order_id is not null and (select private.has_staff_role('finance')));
grant update (state) on public.order_outbox to service_role;
create trigger order_outbox_touch before update on public.order_outbox
for each row execute function private.touch_updated_at();

create function public.submit_enquiry(
  p_id uuid, p_kind text, p_email text, p_message text, p_query text default null,
  p_postcode text default null, p_machine_brand text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.enquiries (id, kind, email, query, postcode, machine_brand, message)
  values (p_id, p_kind, p_email, p_query, p_postcode, p_machine_brand, p_message)
  on conflict (id) do nothing;
  if found then
    insert into public.order_outbox (enquiry_id, message_key)
    values (p_id, 'confirmation'), (p_id, 'staff_notification');
  elsif not exists (
    select 1 from public.enquiries
    where id = p_id and (kind, email, query, postcode, machine_brand, message) is not distinct from
      (p_kind, p_email, p_query, p_postcode, p_machine_brand, p_message)
  ) then
    raise exception using errcode = '22023', message = 'request_attempt_conflict';
  end if;
  return p_id;
end;
$$;

create function public.submit_trial_request(
  p_id uuid, p_machine_brand text, p_oem_code text, p_email text, p_company text, p_postcode text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.trial_requests (id, machine_brand, oem_code, email, company, postcode)
  values (p_id, p_machine_brand, p_oem_code, p_email, p_company, p_postcode)
  on conflict (id) do nothing;
  if found then
    insert into public.order_outbox (trial_request_id, message_key)
    values (p_id, 'confirmation'), (p_id, 'staff_notification');
  elsif not exists (
    select 1 from public.trial_requests
    where id = p_id and (machine_brand, oem_code, email, company, postcode) is not distinct from
      (p_machine_brand, p_oem_code, p_email, p_company, p_postcode)
  ) then
    raise exception using errcode = '22023', message = 'request_attempt_conflict';
  end if;
  return p_id;
end;
$$;

create function public.submit_trade_application(
  p_id uuid, p_buyer_id uuid, p_buyer_name text, p_company text, p_billing_line1 text,
  p_billing_town text, p_billing_postcode text, p_billing_line2 text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  verified_email text;
  existing public.trade_applications;
begin
  select lower(btrim(email)) into verified_email from auth.users
  where id = p_buyer_id and email_confirmed_at is not null and not is_anonymous;
  if verified_email is null then
    raise exception using errcode = '42501', message = 'verified_buyer_required';
  end if;

  insert into public.trade_applications (
    id, buyer_id, email, buyer_name, company, billing_line1, billing_line2, billing_town, billing_postcode
  ) values (
    p_id, p_buyer_id, verified_email, p_buyer_name, p_company,
    p_billing_line1, p_billing_line2, p_billing_town, p_billing_postcode
  ) on conflict do nothing;
  if found then
    insert into public.order_outbox (trade_application_id, message_key)
    values (p_id, 'confirmation'), (p_id, 'staff_notification');
    return p_id;
  end if;

  select * into existing from public.trade_applications where id = p_id;
  if found then
    if (existing.buyer_id, existing.buyer_name, existing.company, existing.billing_line1,
        existing.billing_line2, existing.billing_town, existing.billing_postcode) is distinct from
       (p_buyer_id, p_buyer_name, p_company, p_billing_line1, p_billing_line2, p_billing_town, p_billing_postcode) then
      raise exception using errcode = '22023', message = 'request_attempt_conflict';
    end if;
    return existing.id;
  end if;
  raise exception using errcode = '23505', message = 'trade_application_exists';
end;
$$;

create function public.review_trade_application(p_application_id uuid, p_actor_id uuid, p_decision text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare application public.trade_applications;
begin
  if not exists (
    select 1 from public.staff_members where user_id = p_actor_id and role = 'finance'
  ) then
    raise exception using errcode = '42501', message = 'finance_role_required';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_trade_application_decision';
  end if;
  select * into strict application from public.trade_applications where id = p_application_id for update;
  if application.status = p_decision and application.reviewed_by = p_actor_id then
    return p_application_id;
  end if;
  if application.status <> 'pending' or application.buyer_id is null then
    raise exception using errcode = '22023', message = 'trade_application_not_reviewable';
  end if;
  update public.trade_applications set status = p_decision, reviewed_at = clock_timestamp(), reviewed_by = p_actor_id
  where id = p_application_id;
  return p_application_id;
end;
$$;

comment on function public.review_trade_application(uuid, uuid, text) is
  'Records an application decision only. Approval here never grants credit or authorises Net 30 checkout.';

revoke all on function
  public.submit_enquiry(uuid, text, text, text, text, text, text),
  public.submit_trial_request(uuid, text, text, text, text, text),
  public.submit_trade_application(uuid, uuid, text, text, text, text, text, text),
  public.review_trade_application(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.submit_enquiry(uuid, text, text, text, text, text, text),
  public.submit_trial_request(uuid, text, text, text, text, text),
  public.submit_trade_application(uuid, uuid, text, text, text, text, text, text),
  public.review_trade_application(uuid, uuid, text)
to service_role;
