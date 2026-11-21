create table public.delivery_rules (
  scope text not null check (scope in ('area', 'district')),
  code text not null,
  kind text not null check (kind in ('enquiry', 'next-working-day', 'agreed')),
  service_name text,
  charge_ex_vat_pence integer,
  working_days integer,
  primary key (scope, code),
  check (case scope
    when 'area' then code ~ '^[A-Z]{1,2}$' or code = 'GIR'
    when 'district' then code ~ '^([A-Z]{1,2}[0-9][A-Z0-9]?|GIR)$'
  end),
  check ((
    case kind
      when 'enquiry' then service_name is null and charge_ex_vat_pence is null and working_days is null
      when 'next-working-day' then charge_ex_vat_pence = 695 and working_days = 1
      when 'agreed' then charge_ex_vat_pence >= 0 and working_days between 2 and 366
    end and (kind = 'enquiry' or (
      service_name = btrim(service_name) and length(service_name) between 1 and 100 and service_name !~ '[[:cntrl:]]'
    ))
  ) is true)
);

create table public.delivery_calendars (
  calendar text primary key check (calendar in ('warehouse', 'carrier')),
  active_from date not null,
  active_through date not null,
  working_weekdays smallint[] not null,
  bank_holidays date[] not null,
  closures date[] not null,
  cutoff_minutes smallint,
  check (active_from between date '0001-01-01' and date '9999-12-31'
    and active_through between active_from and date '9999-12-31'
    and active_through - active_from <= 3660),
  check (cardinality(working_weekdays) between 1 and 7
    and working_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  check (array_position(bank_holidays, null) is null and cardinality(bank_holidays) <= 3660
    and (cardinality(bank_holidays) = 0 or (active_from <= all(bank_holidays) and active_through >= all(bank_holidays)))),
  check (array_position(closures, null) is null and cardinality(closures) <= 3660
    and (cardinality(closures) = 0 or (active_from <= all(closures) and active_through >= all(closures)))),
  check ((case calendar
    when 'warehouse' then cutoff_minutes between 0 and 1439
    when 'carrier' then cutoff_minutes is null
  end) is true)
);

alter table public.delivery_rules enable row level security;
alter table public.delivery_calendars enable row level security;
revoke all on public.delivery_rules, public.delivery_calendars from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.delivery_rules to authenticated;
grant select, insert, update on public.delivery_calendars to authenticated;

create policy warehouse_delivery_rules on public.delivery_rules for all to authenticated
using ((select private.has_staff_role('warehouse'))) with check ((select private.has_staff_role('warehouse')));
create policy warehouse_delivery_calendars on public.delivery_calendars for all to authenticated
using ((select private.has_staff_role('warehouse'))) with check ((select private.has_staff_role('warehouse')));

alter table public.orders add column delivery_terms jsonb
  check (delivery_terms is null or jsonb_typeof(delivery_terms) = 'object');

create function private.delivery_calendar_snapshot(p_calendar public.delivery_calendars)
returns jsonb
language sql stable strict set search_path = ''
as $$
  select jsonb_build_object(
    'dateRange', jsonb_build_object('from', to_char(p_calendar.active_from, 'YYYY-MM-DD'),
      'through', to_char(p_calendar.active_through, 'YYYY-MM-DD')),
    'workingWeekdays', p_calendar.working_weekdays,
    'bankHolidays', array(select to_char(day, 'YYYY-MM-DD') from unnest(p_calendar.bank_holidays) as day),
    'closures', array(select to_char(day, 'YYYY-MM-DD') from unnest(p_calendar.closures) as day)
  );
$$;

create function private.resolve_delivery_terms(p_postcode text)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'quote', jsonb_build_object('kind', rule.kind, 'serviceName', rule.service_name,
      'chargeExVatPence', rule.charge_ex_vat_pence, 'workingDays', rule.working_days),
    'warehouseCalendar', private.delivery_calendar_snapshot(warehouse),
    'deliveryCalendar', private.delivery_calendar_snapshot(carrier),
    'cutoffMinutes', warehouse.cutoff_minutes
  )
  from (
    select r.* from public.delivery_rules r
    where (r.scope = 'district' and r.code = split_part(p_postcode, ' ', 1))
       or (r.scope = 'area' and r.code = substring(p_postcode from '^[A-Z]+'))
    order by (r.scope = 'district') desc
    limit 1
  ) rule
  join public.delivery_calendars warehouse on warehouse.calendar = 'warehouse'
  join public.delivery_calendars carrier on carrier.calendar = 'carrier'
  where rule.kind <> 'enquiry';
$$;

create function public.checkout_delivery_terms(p_postcode text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.resolve_delivery_terms(p_postcode);
$$;

create function public.checkout_warehouse_calendar()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'warehouseCalendar', private.delivery_calendar_snapshot(warehouse),
    'cutoffMinutes', warehouse.cutoff_minutes
  )
  from public.delivery_calendars warehouse
  where warehouse.calendar = 'warehouse';
$$;

revoke all on function private.delivery_calendar_snapshot(public.delivery_calendars),
  private.resolve_delivery_terms(text), public.checkout_delivery_terms(text), public.checkout_warehouse_calendar()
from public, anon, authenticated, service_role;
grant execute on function public.checkout_delivery_terms(text), public.checkout_warehouse_calendar() to service_role;
