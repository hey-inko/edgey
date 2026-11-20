create type public.trade_account_status as enum ('pending', 'approved', 'suspended');
create type public.credit_hold_status as enum ('held', 'converted', 'released');
create type public.trade_invoice_status as enum ('open', 'partially_paid', 'paid', 'voided');
create type public.credit_ledger_kind as enum (
  'approve', 'set_limit', 'suspend', 'hold', 'release', 'issue', 'payment', 'credit_note', 'void', 'refund'
);

create table public.trade_accounts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.trade_applications (id),
  buyer_id uuid unique references auth.users (id) on delete set null,
  buyer_name text not null check (length(btrim(buyer_name)) between 1 and 200),
  status public.trade_account_status not null,
  credit_limit_pence integer not null check (credit_limit_pence >= 0),
  stripe_customer_id text unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,196}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'pending' or stripe_customer_id is not null)
);

alter table public.orders
  add column trade_account_id uuid references public.trade_accounts (id),
  add unique (id, trade_account_id),
  add constraint orders_trade_terms_check check (
    case payment_method
      when 'net30' then trade_account_id is not null and checkout_session_id is null and payment_intent_id is null
      when 'card' then trade_account_id is null and po_number is null and payment_status not in ('invoiced', 'partially_paid')
    end
  );
grant select (trade_account_id) on public.orders to authenticated;

create table public.credit_holds (
  order_id uuid primary key,
  trade_account_id uuid not null,
  operation_key uuid not null unique,
  amount_pence integer not null check (amount_pence > 0),
  status public.credit_hold_status not null default 'held',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (order_id, trade_account_id) references public.orders (id, trade_account_id),
  check ((status = 'held') = (resolved_at is null))
);
create index credit_holds_active_account_idx on public.credit_holds (trade_account_id) where status = 'held';

create table public.invoices (
  order_id uuid primary key,
  trade_account_id uuid not null,
  provider_invoice_id text not null unique check (provider_invoice_id ~ '^in_[A-Za-z0-9]{1,197}$'),
  po_number text not null check (length(btrim(po_number)) between 1 and 200),
  currency text not null check (currency = 'GBP'),
  amount_due_pence integer not null check (amount_due_pence > 0),
  amount_remaining_pence integer not null check (amount_remaining_pence between 0 and amount_due_pence),
  issued_at timestamptz not null check (isfinite(issued_at)),
  due_at timestamptz not null check (isfinite(due_at) and due_at > issued_at),
  status public.trade_invoice_status not null default 'open',
  updated_at timestamptz not null default now(),
  foreign key (order_id, trade_account_id) references public.orders (id, trade_account_id),
  check ((status in ('paid', 'voided')) = (amount_remaining_pence = 0))
);
create index invoices_account_idx on public.invoices (trade_account_id);
create index invoices_overdue_idx on public.invoices (due_at) where amount_remaining_pence > 0;
create trigger invoices_touch before update on public.invoices
for each row execute function private.touch_updated_at();

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  trade_account_id uuid not null references public.trade_accounts (id),
  order_id uuid,
  actor_id uuid,
  kind public.credit_ledger_kind not null,
  operation_key text not null check (length(btrim(operation_key)) between 1 and 200),
  held_delta_pence integer not null,
  outstanding_delta_pence integer not null,
  input jsonb not null,
  created_at timestamptz not null default now(),
  unique (kind, operation_key),
  foreign key (order_id, trade_account_id) references public.orders (id, trade_account_id),
  check (
    case kind
      when 'approve' then order_id is null and actor_id is not null and held_delta_pence = 0 and outstanding_delta_pence = 0
      when 'set_limit' then order_id is null and actor_id is not null and held_delta_pence = 0 and outstanding_delta_pence = 0
      when 'suspend' then order_id is null and actor_id is not null and held_delta_pence = 0 and outstanding_delta_pence = 0
      when 'hold' then order_id is not null and held_delta_pence > 0 and outstanding_delta_pence = 0
      when 'release' then order_id is not null and held_delta_pence < 0 and outstanding_delta_pence = 0
      when 'issue' then order_id is not null and held_delta_pence <= 0 and outstanding_delta_pence > 0
      when 'payment' then order_id is not null and held_delta_pence = 0 and outstanding_delta_pence < 0
      when 'credit_note' then order_id is not null and held_delta_pence = 0 and outstanding_delta_pence <= 0
      when 'void' then order_id is not null and held_delta_pence = 0 and outstanding_delta_pence <= 0
      when 'refund' then order_id is not null and held_delta_pence = 0 and outstanding_delta_pence = 0
    end
  )
);
create index credit_ledger_account_idx on public.credit_ledger (trade_account_id, id);
create index credit_ledger_order_idx on public.credit_ledger (order_id, id) where order_id is not null;

alter table public.trade_accounts enable row level security;
alter table public.credit_holds enable row level security;
alter table public.invoices enable row level security;
alter table public.credit_ledger enable row level security;

revoke all on public.trade_accounts, public.credit_holds, public.invoices, public.credit_ledger
from public, anon, authenticated, service_role;
grant select on public.trade_accounts, public.credit_holds, public.invoices, public.credit_ledger to service_role;
grant select (id, application_id, buyer_id, buyer_name, status, credit_limit_pence, created_at, updated_at)
on public.trade_accounts to authenticated;
grant select (order_id, trade_account_id, amount_pence, status, created_at, resolved_at)
on public.credit_holds to authenticated;
grant select (order_id, trade_account_id, po_number, currency, amount_due_pence, amount_remaining_pence,
  issued_at, due_at, status, updated_at) on public.invoices to authenticated;
grant select on public.credit_ledger to authenticated;

create policy trade_accounts_read on public.trade_accounts for select to authenticated using (
  buyer_id = (select auth.uid()) or (select private.has_staff_role('finance'))
);
create policy credit_holds_read on public.credit_holds for select to authenticated using (
  exists (select 1 from public.trade_accounts where id = credit_holds.trade_account_id)
);
create policy invoices_read on public.invoices for select to authenticated using (
  exists (select 1 from public.trade_accounts where id = invoices.trade_account_id)
);
create policy credit_ledger_finance_read on public.credit_ledger for select to authenticated
using ((select private.has_staff_role('finance')));

create view public.trade_credit_position with (security_invoker = true) as
select a.id as trade_account_id, a.buyer_id, a.status, a.credit_limit_pence,
  h.held_pence, i.outstanding_pence,
  greatest(a.credit_limit_pence - h.held_pence - i.outstanding_pence, 0) as available_credit_pence
from public.trade_accounts a
cross join lateral (
  select coalesce(sum(amount_pence), 0) as held_pence
  from public.credit_holds where trade_account_id = a.id and status = 'held'
) h
cross join lateral (
  select coalesce(sum(amount_remaining_pence), 0) as outstanding_pence
  from public.invoices where trade_account_id = a.id
) i;

create view public.overdue_invoices with (security_invoker = true) as
select order_id, trade_account_id, po_number, currency, amount_due_pence, amount_remaining_pence, issued_at, due_at, status
from public.invoices where amount_remaining_pence > 0 and due_at < now();

revoke all on public.trade_credit_position, public.overdue_invoices from public, anon, authenticated, service_role;
grant select on public.trade_credit_position to authenticated, service_role;
grant select on public.overdue_invoices to service_role;
