create table private.variant_price_changes (
  id bigint generated always as identity primary key,
  variant_id uuid not null,
  actor_id uuid,
  old_tiers_pence integer[],
  new_tiers_pence integer[] not null,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table private.variant_price_changes enable row level security;
revoke all on private.variant_price_changes from public, anon, authenticated, service_role;

create function private.record_variant_price_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  old_prices integer[];
  new_prices integer[] := array[new.price_1_4_pence, new.price_5_9_pence, new.price_10_plus_pence];
begin
  if tg_op = 'UPDATE' then
    old_prices := array[old.price_1_4_pence, old.price_5_9_pence, old.price_10_plus_pence];
  end if;
  if new_prices is distinct from old_prices and
    (tg_op = 'UPDATE' or new.price_1_4_pence is not null) then
    insert into private.variant_price_changes (variant_id, actor_id, old_tiers_pence, new_tiers_pence)
    values (new.id, coalesce(nullif(current_setting('edgey.catalogue_actor', true), '')::uuid, auth.uid()),
      old_prices, new_prices);
  end if;
  return new;
end;
$$;

revoke all on function private.record_variant_price_change() from public, anon, authenticated, service_role;
create trigger record_variant_price_change
after insert or update of price_1_4_pence, price_5_9_pence, price_10_plus_pence on public.variants
for each row execute function private.record_variant_price_change();

alter function public.admin_catalogue_update(uuid, uuid, timestamptz, timestamptz, jsonb) set schema private;
revoke all on function private.admin_catalogue_update(uuid, uuid, timestamptz, timestamptz, jsonb)
from public, anon, authenticated, service_role;

create function public.admin_catalogue_update(
  p_actor_id uuid, p_variant_id uuid, p_expected_updated_at timestamptz,
  p_expected_product_updated_at timestamptz, p_selling jsonb
)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  previous_actor text := current_setting('edgey.catalogue_actor', true);
  result text;
begin
  perform set_config('edgey.catalogue_actor', coalesce(p_actor_id::text, ''), true);
  result := private.admin_catalogue_update(p_actor_id, p_variant_id, p_expected_updated_at,
    p_expected_product_updated_at, p_selling);
  perform set_config('edgey.catalogue_actor', coalesce(previous_actor, ''), true);
  return result;
end;
$$;

revoke all on function public.admin_catalogue_update(uuid, uuid, timestamptz, timestamptz, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.admin_catalogue_update(uuid, uuid, timestamptz, timestamptz, jsonb) to service_role;

alter table public.variants
  drop constraint variants_prices_required_outside_draft,
  add constraint variants_prices_required_outside_draft check (
    num_nonnulls(price_1_4_pence, price_5_9_pence, price_10_plus_pence) = 3
    or (publication_status <> 'published'
      and num_nonnulls(price_1_4_pence, price_5_9_pence, price_10_plus_pence) = 0)
  );

create function public.archive_staff_variant(p_variant_id uuid, p_expected_updated_at timestamptz)
returns text language plpgsql security definer set search_path = ''
as $$
declare v public.variants;
begin
  if not private.has_staff_role('catalogue') then
    raise exception using errcode = '42501', message = 'catalogue_role_required';
  end if;
  v := private.lock_admin_catalogue_variant(auth.uid(), p_variant_id, p_expected_updated_at);
  update public.variants set publication_status = 'archived' where id = v.id and publication_status <> 'archived';
  return (select slug from public.products where id = v.product_id);
end;
$$;

revoke all on function public.archive_staff_variant(uuid, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.archive_staff_variant(uuid, timestamptz) to authenticated;
