create type public.order_payment_method as enum ('card', 'net30');
create type public.order_payment_status as enum (
  'pending', 'invoiced', 'partially_paid', 'paid', 'voided', 'partially_refunded', 'refunded'
);
create type public.order_fulfilment_status as enum (
  'awaiting_authorisation', 'ready_to_pick', 'picking', 'dispatched', 'cancelled'
);
create type public.stock_reservation_state as enum ('held', 'allocated', 'released', 'dispatched');
create type public.stock_movement_kind as enum ('opening', 'reserve', 'release', 'dispatch', 'receive', 'restore');
create type public.staff_role as enum ('warehouse', 'catalogue', 'finance');
create type public.provider_event_state as enum ('received', 'failed', 'processed');
create type public.order_message_state as enum ('pending', 'failed', 'sent');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  checkout_attempt_token uuid not null unique,
  buyer_id uuid references auth.users (id) on delete set null,
  email text not null check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  business_name text not null check (length(btrim(business_name)) between 1 and 200),
  recipient_name text not null check (length(btrim(recipient_name)) between 1 and 200),
  phone text check (length(phone) between 1 and 50),
  buying_for_work boolean not null check (buying_for_work),
  address_line1 text not null check (length(btrim(address_line1)) between 1 and 200),
  address_line2 text check (length(address_line2) between 1 and 200),
  address_town text not null check (length(btrim(address_town)) between 1 and 100),
  address_region text check (length(address_region) between 1 and 100),
  address_postcode text not null check (address_postcode ~ '^([A-Z]{1,2}[0-9][A-Z0-9]?|GIR) [0-9][A-Z]{2}$'),
  address_country text not null check (address_country = 'GB'),
  payment_method public.order_payment_method not null default 'card',
  payment_status public.order_payment_status not null default 'pending',
  fulfilment_status public.order_fulfilment_status not null default 'awaiting_authorisation',
  currency text not null default 'GBP' check (currency = 'GBP'),
  goods_net_pence integer not null check (goods_net_pence > 0),
  delivery_net_pence integer not null check (delivery_net_pence >= 0),
  vat_rate_bps integer not null check (vat_rate_bps between 0 and 10000),
  vat_pence integer not null check (vat_pence >= 0),
  gross_pence integer not null check (gross_pence::bigint = goods_net_pence::bigint + delivery_net_pence + vat_pence),
  paid_pence integer not null default 0 check (paid_pence between 0 and gross_pence),
  refunded_pence integer not null default 0 check (refunded_pence between 0 and paid_pence),
  hold_expires_at timestamptz not null check (isfinite(hold_expires_at)),
  delivery_service text not null check (length(btrim(delivery_service)) between 1 and 100),
  promised_dispatch_date date not null check (isfinite(promised_dispatch_date)),
  estimated_delivery_date date not null check (isfinite(estimated_delivery_date) and estimated_delivery_date >= promised_dispatch_date),
  checkout_session_id text unique,
  payment_intent_id text unique,
  provider_invoice_id text unique,
  payment_review_reason text,
  po_number text check (length(btrim(po_number)) between 1 and 200),
  authorised_at timestamptz,
  dispatched_at timestamptz,
  carrier text,
  tracking_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payment_method <> 'net30' or po_number is not null),
  check (fulfilment_status <> 'dispatched' or (dispatched_at is not null and carrier is not null and tracking_number is not null))
);
create index orders_buyer_id_idx on public.orders (buyer_id) where buyer_id is not null;
create index orders_open_holds_idx on public.orders (hold_expires_at) where fulfilment_status = 'awaiting_authorisation';
create index orders_pick_queue_idx on public.orders (promised_dispatch_date, created_at)
where fulfilment_status in ('ready_to_pick', 'picking');
create trigger orders_touch before update on public.orders
for each row execute function private.touch_updated_at();

create table public.order_items (
  order_id uuid not null references public.orders (id),
  variant_id uuid not null references public.variants (id),
  sku text not null,
  option_label text not null,
  quantity integer not null check (quantity > 0),
  unit_price_pence integer not null check (unit_price_pence > 0),
  net_pence integer not null check (net_pence = quantity::bigint * unit_price_pence),
  tax_pence integer not null check (tax_pence >= 0),
  gross_pence integer not null check (gross_pence = net_pence::bigint + tax_pence),
  primary key (order_id, variant_id)
);
create index order_items_variant_id_idx on public.order_items (variant_id);

create table public.stock_reservations (
  order_id uuid not null,
  variant_id uuid not null,
  quantity integer not null check (quantity > 0),
  state public.stock_reservation_state not null default 'held',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (order_id, variant_id),
  foreign key (order_id, variant_id) references public.order_items (order_id, variant_id)
);
create index stock_reservations_active_variant_idx on public.stock_reservations (variant_id)
where state in ('held', 'allocated');
create trigger stock_reservations_touch before update on public.stock_reservations
for each row execute function private.touch_updated_at();

create table public.staff_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.staff_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.order_returns (
  id uuid primary key,
  order_id uuid not null,
  variant_id uuid not null,
  quantity integer not null check (quantity > 0),
  restored_quantity integer not null default 0 check (restored_quantity between 0 and quantity),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  lookup_code text check (length(lookup_code) between 1 and 100),
  recorded_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (order_id, variant_id) references public.order_items (order_id, variant_id)
);
create index order_returns_item_idx on public.order_returns (order_id, variant_id);

create table public.stock_movements (
  id bigint generated always as identity primary key,
  kind public.stock_movement_kind not null,
  operation_key text not null unique check (length(btrim(operation_key)) between 1 and 500),
  variant_id uuid not null references public.variants (id),
  order_id uuid,
  return_id uuid references public.order_returns (id),
  actor_id uuid,
  on_hand_delta integer not null,
  reserved_delta integer not null,
  created_at timestamptz not null default now(),
  foreign key (order_id, variant_id) references public.order_items (order_id, variant_id),
  check (
    case kind
      when 'opening' then on_hand_delta > 0 and reserved_delta = 0 and order_id is null and return_id is null
      when 'receive' then on_hand_delta > 0 and reserved_delta = 0 and order_id is null and return_id is null
      when 'restore' then on_hand_delta > 0 and reserved_delta = 0 and order_id is not null and return_id is not null
      when 'reserve' then on_hand_delta = 0 and reserved_delta > 0 and order_id is not null and return_id is null
      when 'release' then on_hand_delta = 0 and reserved_delta < 0 and order_id is not null and return_id is null
      when 'dispatch' then on_hand_delta = reserved_delta and on_hand_delta < 0 and order_id is not null and return_id is null
    end
  )
);
create index stock_movements_variant_id_idx on public.stock_movements (variant_id, created_at);
create index stock_movements_order_id_idx on public.stock_movements (order_id) where order_id is not null;

create table public.provider_events (
  provider text not null check (length(btrim(provider)) between 1 and 50),
  event_id text not null check (length(btrim(event_id)) between 1 and 200),
  event_type text not null check (length(btrim(event_type)) between 1 and 100),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  state public.provider_event_state not null default 'received',
  last_error text check (length(btrim(last_error)) between 1 and 500),
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, event_id),
  check ((state = 'failed') = (last_error is not null))
);
create index provider_events_pending_idx on public.provider_events (received_at) where state <> 'processed';
create trigger provider_events_touch before update on public.provider_events
for each row execute function private.touch_updated_at();

create table public.order_outbox (
  order_id uuid not null references public.orders (id),
  message_key text not null check (message_key = 'order_confirmation'),
  state public.order_message_state not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (order_id, message_key)
);
create index order_outbox_pending_idx on public.order_outbox (created_at) where state <> 'sent';

create table private.order_operations (
  order_id uuid not null references public.orders (id),
  action text not null,
  operation_key text not null check (length(btrim(operation_key)) between 1 and 200),
  input jsonb not null,
  created_at timestamptz not null default now(),
  primary key (order_id, action, operation_key)
);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.staff_members enable row level security;
alter table public.order_returns enable row level security;
alter table public.stock_movements enable row level security;
alter table public.provider_events enable row level security;
alter table public.order_outbox enable row level security;
alter table private.order_operations enable row level security;

revoke all on public.orders, public.order_items, public.stock_reservations, public.staff_members,
  public.order_returns, public.stock_movements, public.provider_events, public.order_outbox,
  private.order_operations from public, anon, authenticated, service_role;
grant select on public.orders, public.order_items, public.stock_reservations, public.staff_members,
  public.order_returns, public.stock_movements, public.provider_events, public.order_outbox to service_role;
grant insert, delete on public.staff_members to service_role;
grant select (
  id, buyer_id, email, business_name, recipient_name, phone, buying_for_work, address_line1,
  address_line2, address_town, address_region, address_postcode, address_country, payment_method,
  payment_status, fulfilment_status, currency, goods_net_pence, delivery_net_pence, vat_rate_bps,
  vat_pence, gross_pence, paid_pence, refunded_pence, hold_expires_at, delivery_service,
  promised_dispatch_date, estimated_delivery_date, po_number, authorised_at, dispatched_at,
  carrier, tracking_number, created_at, updated_at
) on public.orders to authenticated;
grant select on public.order_items, public.stock_reservations, public.staff_members,
  public.order_returns, public.stock_movements, public.order_outbox to authenticated;
grant select (provider, event_id, event_type, state, last_error, received_at, updated_at)
on public.provider_events to authenticated;

create function private.has_staff_role(variadic p_roles public.staff_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff_members where user_id = auth.uid() and role = any(p_roles)
  );
$$;
revoke all on function private.has_staff_role(public.staff_role[]) from public;
grant execute on function private.has_staff_role(public.staff_role[]) to authenticated;

create policy orders_read on public.orders for select to authenticated using (
  buyer_id = (select auth.uid())
  or (select private.has_staff_role('finance'))
  or (authorised_at is not null and (select private.has_staff_role('warehouse')))
);
create policy order_items_read on public.order_items for select to authenticated using (
  exists (select 1 from public.orders where orders.id = order_items.order_id)
);
create policy staff_members_read_self on public.staff_members for select to authenticated
using (user_id = (select auth.uid()));
create policy stock_reservations_read on public.stock_reservations for select to authenticated
using ((select private.has_staff_role('warehouse')));
create policy order_returns_read on public.order_returns for select to authenticated
using ((select private.has_staff_role('warehouse', 'finance')));
create policy stock_movements_read on public.stock_movements for select to authenticated
using ((select private.has_staff_role('warehouse')));
create policy provider_events_read on public.provider_events for select to authenticated
using ((select private.has_staff_role('finance')));
create policy order_outbox_read on public.order_outbox for select to authenticated
using ((select private.has_staff_role('finance')));

do $$
declare
  write_columns text;
begin
  lock table public.variants in share row exclusive mode;
  if exists (select 1 from public.variants where stock_reserved <> 0) then
    raise exception 'Cannot migrate stock: existing reserved counts have no reservation records';
  end if;

  insert into public.stock_movements (kind, operation_key, variant_id, on_hand_delta, reserved_delta)
  select 'opening', 'opening:' || id, id, stock_on_hand, 0
  from public.variants where stock_on_hand > 0;

  revoke insert, update, truncate, trigger on public.variants from service_role;
  select string_agg(quote_ident(attname), ', ' order by attnum) into write_columns
  from pg_catalog.pg_attribute
  where attrelid = 'public.variants'::regclass and attnum > 0 and not attisdropped
    and attgenerated = '' and attname not in ('stock_on_hand', 'stock_reserved');
  execute format('grant insert (%s), update (%s) on public.variants to service_role', write_columns, write_columns);
end;
$$;
