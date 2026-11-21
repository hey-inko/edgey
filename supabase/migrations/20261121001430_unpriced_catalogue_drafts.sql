alter table public.variants
  alter column price_1_4_pence drop not null,
  alter column price_5_9_pence drop not null,
  alter column price_10_plus_pence drop not null,
  add constraint variants_prices_required_outside_draft check (
    num_nonnulls(price_1_4_pence, price_5_9_pence, price_10_plus_pence) = 3
    or (
      publication_status = 'draft'
      and num_nonnulls(price_1_4_pence, price_5_9_pence, price_10_plus_pence) = 0
    )
  );

create or replace function public.admin_catalogue_update(
  p_actor_id uuid, p_variant_id uuid, p_expected_updated_at timestamptz,
  p_expected_product_updated_at timestamptz, p_selling jsonb
)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v public.variants := private.lock_admin_catalogue_variant(p_actor_id, p_variant_id, p_expected_updated_at);
  family public.products;
  fields record;
  current_substrates text[];
  next_substrates text[];
  fit_changed boolean;
begin
  select * into strict family from public.products where id = v.product_id for no key update;
  if family.updated_at is distinct from p_expected_product_updated_at then
    raise exception using errcode = '22023', message = 'catalogue_stale';
  end if;

  select * into fields from jsonb_to_record(p_selling) as input (
    name text, description text, tool_category text, option_label text, tool text,
    supplier_name text, supplier_part_number text, angle_deg numeric, shank_mm numeric,
    cutting_depth_mm numeric, blade_thickness_mm numeric, diameter_mm numeric, specs jsonb,
    substrates text[], price_1_4_pence integer, price_5_9_pence integer, price_10_plus_pence integer
  );

  fields.name := private.catalogue_trim(fields.name);
  fields.description := private.catalogue_trim(fields.description);

  if coalesce(length(fields.name), 0) not between 1 and 160
    or coalesce(length(fields.description), 0) not between 1 and 2000
    or fields.tool_category is null
    or greatest(length(fields.option_label), length(fields.tool), length(fields.supplier_name),
      length(fields.supplier_part_number)) > 160
    or jsonb_typeof(fields.specs) is distinct from 'object'
    or length(fields.specs::text) > 6000
    or cardinality(fields.substrates) is null or cardinality(fields.substrates) > 100
    or not (
      (v.publication_status = 'draft'
        and num_nonnulls(fields.price_1_4_pence, fields.price_5_9_pence, fields.price_10_plus_pence) = 0)
      or (num_nonnulls(fields.price_1_4_pence, fields.price_5_9_pence, fields.price_10_plus_pence) = 3
        and fields.price_10_plus_pence > 0 and fields.price_10_plus_pence <= fields.price_5_9_pence
        and fields.price_5_9_pence <= fields.price_1_4_pence)
    )
    or exists (
      select 1 from unnest(fields.substrates) as substrate where substrate is null
    ) then
    raise exception using errcode = '22023', message = 'catalogue_invalid_selling_data';
  end if;
  if exists (
    select 1 from jsonb_each(fields.specs) as spec
    where length(private.catalogue_trim(spec.key)) not between 1 and 80 or jsonb_typeof(spec.value) <> 'string'
      or length(private.catalogue_trim(spec.value #>> '{}')) not between 1 and 240
  ) then
    raise exception using errcode = '22023', message = 'catalogue_invalid_selling_data';
  end if;
  if fields.angle_deg is not null and (
    fields.angle_deg <= 0 or fields.angle_deg >= 180 or fields.angle_deg <> round(fields.angle_deg, 1)
  ) or exists (
    select 1 from unnest(array[fields.shank_mm, fields.cutting_depth_mm, fields.blade_thickness_mm,
      fields.diameter_mm]) as dimension
    where dimension <= 0 or dimension > 999.99 or dimension <> round(dimension, 2)
  ) then
    raise exception using errcode = '22023', message = 'catalogue_invalid_selling_data';
  end if;

  select array(select substrate from public.variant_substrates where variant_id = v.id order by substrate)
    into current_substrates;
  select array(select distinct substrate from unnest(fields.substrates) as substrate order by substrate)
    into next_substrates;

  fields.option_label := nullif(private.catalogue_trim(fields.option_label), '');
  fields.tool := nullif(private.catalogue_trim(fields.tool), '');
  fields.supplier_name := nullif(private.catalogue_trim(fields.supplier_name), '');
  fields.supplier_part_number := nullif(private.catalogue_trim(fields.supplier_part_number), '');

  fit_changed := (v.option_label, v.tool, v.supplier_name, v.supplier_part_number, v.angle_deg, v.shank_mm,
    v.cutting_depth_mm, v.blade_thickness_mm, v.diameter_mm, v.specs, current_substrates)
    is distinct from (fields.option_label, fields.tool, fields.supplier_name, fields.supplier_part_number,
      fields.angle_deg, fields.shank_mm, fields.cutting_depth_mm, fields.blade_thickness_mm,
      fields.diameter_mm, fields.specs, next_substrates);

  update public.products set name = fields.name, description = fields.description,
    tool_category = fields.tool_category where id = family.id
    and (name, description, tool_category) is distinct from
      (fields.name, fields.description, fields.tool_category);

  update public.variants set
    option_label = fields.option_label, tool = fields.tool, supplier_name = fields.supplier_name,
    supplier_part_number = fields.supplier_part_number, angle_deg = fields.angle_deg, shank_mm = fields.shank_mm,
    cutting_depth_mm = fields.cutting_depth_mm, blade_thickness_mm = fields.blade_thickness_mm,
    diameter_mm = fields.diameter_mm, specs = fields.specs, price_1_4_pence = fields.price_1_4_pence,
    price_5_9_pence = fields.price_5_9_pence, price_10_plus_pence = fields.price_10_plus_pence,
    publication_status = case when fit_changed and v.publication_status = 'published' then 'draft' else v.publication_status end,
    approved_at = case when fit_changed then null else v.approved_at end,
    approved_by = case when fit_changed then null else v.approved_by end,
    rejected_at = case when fit_changed then null else v.rejected_at end,
    rejected_by = case when fit_changed then null else v.rejected_by end
  where id = v.id and (fit_changed or (v.price_1_4_pence, v.price_5_9_pence, v.price_10_plus_pence)
    is distinct from (fields.price_1_4_pence, fields.price_5_9_pence, fields.price_10_plus_pence));

  if current_substrates <> next_substrates then
    delete from public.variant_substrates where variant_id = v.id and not (substrate = any(next_substrates));
    insert into public.variant_substrates (variant_id, substrate)
    select v.id, substrate from unnest(next_substrates) as substrate on conflict do nothing;
  end if;
  if fit_changed then
    update public.compatibility set verification_state = 'candidate', approved_at = null, approved_by = null
      where variant_id = v.id and verification_state = 'approved';
  end if;
  return family.slug;
end;
$$;
