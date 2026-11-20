alter table public.variants add column rejected_at timestamptz, add column rejected_by text,
  add column catalogue_updated_at timestamptz not null default now();
alter table public.compatibility add column rejected_at timestamptz, add column rejected_by text;

update public.compatibility set is_private = true
  where code_kind = 'alias' and verification_state <> 'approved' and not is_private;
alter table public.compatibility add constraint compatibility_candidate_aliases_are_private
  check (code_kind <> 'alias' or verification_state <> 'candidate' or is_private);

create function private.keep_catalogue_mapping_private()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if (new.code_kind = 'alias' and new.verification_state = 'candidate') or (tg_op = 'UPDATE' and old.is_private) then
    new.is_private := true;
  end if;
  return new;
end;
$$;

create trigger compatibility_keep_private before insert or update on public.compatibility
for each row execute function private.keep_catalogue_mapping_private();

create function private.touch_catalogue_version()
returns trigger language plpgsql set search_path = ''
as $$
declare
  ignored_columns text[] := array[
    'stock_on_hand', 'stock_reserved', 'availability', 'sku_normalised', 'updated_at', 'catalogue_updated_at'
  ];
begin
  new.catalogue_updated_at := case
    when to_jsonb(new) - ignored_columns is distinct from to_jsonb(old) - ignored_columns
    then clock_timestamp()
    else old.catalogue_updated_at
  end;
  return new;
end;
$$;

create trigger variants_catalogue_version before update on public.variants
for each row execute function private.touch_catalogue_version();

create function private.catalogue_trim(input text)
returns text language sql immutable strict set search_path = ''
as $$
  select regexp_replace(input, '^[[:space:]]+|[[:space:]]+$', '', 'g');
$$;

create function private.lock_admin_catalogue_variant(
  p_actor_id uuid, p_variant_id uuid, p_expected_updated_at timestamptz
)
returns public.variants language plpgsql set search_path = ''
as $$
declare
  result public.variants;
begin
  perform 1 from public.staff_members where user_id = p_actor_id and role = 'catalogue' for key share;
  if not found then
    raise exception using errcode = '42501', message = 'catalogue_role_required';
  end if;
  select * into result from public.variants where id = p_variant_id for no key update;
  if not found then
    raise exception using errcode = 'P0002', message = 'catalogue_variant_not_found';
  end if;
  if result.catalogue_updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '22023', message = 'catalogue_stale';
  end if;
  return result;
end;
$$;

create function private.catalogue_has_public_fit(p_variant_id uuid)
returns boolean language sql set search_path = ''
as $$
  select exists (
    select 1 from public.compatibility
    where variant_id = p_variant_id and verification_state = 'approved'
      and not is_private and brand is not null
      and nullif(private.catalogue_trim(evidence_source), '') is not null
  );
$$;

create function public.admin_catalogue_update(
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
    or fields.price_10_plus_pence is null or fields.price_5_9_pence is null or fields.price_1_4_pence is null
    or not (fields.price_10_plus_pence > 0 and fields.price_10_plus_pence <= fields.price_5_9_pence
      and fields.price_5_9_pence <= fields.price_1_4_pence)
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

create function public.admin_catalogue_review(
  p_actor_id uuid, p_variant_id uuid, p_expected_updated_at timestamptz, p_approve boolean,
  p_evidence_source text, p_evidence_note text, p_compatibility_id uuid default null,
  p_expected_mapping_updated_at timestamptz default null,
  p_evidence_url text default null, p_brand text default null, p_machine text default null,
  p_tool text default null, p_adapter text default null
)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v public.variants := private.lock_admin_catalogue_variant(p_actor_id, p_variant_id, p_expected_updated_at);
  mapping public.compatibility;
begin
  p_evidence_source := private.catalogue_trim(p_evidence_source);
  p_evidence_note := private.catalogue_trim(p_evidence_note);
  if p_approve is null or coalesce(length(p_evidence_source), 0) not between 1 and 240
    or coalesce(length(p_evidence_note), 0) not between 1 and 2000
    or p_evidence_source = 'PRD Appendix A working list (unverified)'
    or (p_evidence_url is not null and (length(p_evidence_url) > 500 or p_evidence_url !~ '^https?://[^[:space:]]+$'))
    or greatest(length(p_machine), length(p_tool), length(p_adapter)) > 160 then
    raise exception using errcode = '22023', message = 'catalogue_review_evidence_required';
  end if;

  if p_compatibility_id is null then
    update public.variants set
      evidence_source = p_evidence_source, evidence_note = p_evidence_note,
      approved_at = case when p_approve then clock_timestamp() end,
      approved_by = case when p_approve then p_actor_id::text end,
      rejected_at = case when not p_approve then clock_timestamp() end,
      rejected_by = case when not p_approve then p_actor_id::text end,
      publication_status = case when not p_approve and v.publication_status = 'published' then 'draft' else v.publication_status end
    where id = v.id;
  else
    select * into mapping from public.compatibility
    where id = p_compatibility_id and variant_id = v.id for no key update;
    if not found then
      raise exception using errcode = 'P0002', message = 'catalogue_mapping_not_found';
    end if;
    if mapping.updated_at is distinct from p_expected_mapping_updated_at then
      raise exception using errcode = '22023', message = 'catalogue_stale';
    end if;
    if p_approve and not mapping.is_private and p_brand is null then
      raise exception using errcode = '22023', message = 'catalogue_mapping_brand_required';
    end if;
    update public.compatibility set
      evidence_source = p_evidence_source, evidence_note = p_evidence_note,
      evidence_url = p_evidence_url,
      brand = case when p_approve then p_brand else mapping.brand end,
      machine = case when p_approve then nullif(private.catalogue_trim(p_machine), '') else mapping.machine end,
      tool = case when p_approve then nullif(private.catalogue_trim(p_tool), '') else mapping.tool end,
      adapter = case when p_approve then nullif(private.catalogue_trim(p_adapter), '') else mapping.adapter end,
      verification_state = case when p_approve then 'approved'::public.verification_state else 'rejected'::public.verification_state end,
      approved_at = case when p_approve then clock_timestamp() end,
      approved_by = case when p_approve then p_actor_id::text end,
      rejected_at = case when not p_approve then clock_timestamp() end,
      rejected_by = case when not p_approve then p_actor_id::text end
    where id = mapping.id;

    if not p_approve and not mapping.is_private and mapping.verification_state = 'approved'
      and v.publication_status = 'published' and not private.catalogue_has_public_fit(v.id) then
      update public.variants set publication_status = 'draft' where id = v.id;
    end if;
  end if;
  return (select slug from public.products where id = v.product_id);
end;
$$;

create function public.admin_catalogue_set_publication(
  p_actor_id uuid, p_variant_id uuid, p_expected_updated_at timestamptz, p_publish boolean
)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v public.variants := private.lock_admin_catalogue_variant(p_actor_id, p_variant_id, p_expected_updated_at);
  family public.products;
begin
  if p_publish is null or v.publication_status = 'archived' then
    raise exception using errcode = '22023', message = 'catalogue_invalid_publication';
  end if;

  select * into strict family from public.products where id = v.product_id for no key update;

  if p_publish then
    if v.approved_at is null or nullif(private.catalogue_trim(v.approved_by), '') is null
      or nullif(private.catalogue_trim(v.evidence_source), '') is null
      or nullif(private.catalogue_trim(v.evidence_note), '') is null then
      raise exception using errcode = '22023', message = 'catalogue_variant_not_approved';
    end if;
    if nullif(private.catalogue_trim(family.name), '') is null or nullif(private.catalogue_trim(family.description), '') is null
      or nullif(private.catalogue_trim(v.supplier_name), '') is null or nullif(private.catalogue_trim(v.supplier_part_number), '') is null
      or nullif(private.catalogue_trim(v.tool), '') is null
      or (num_nonnulls(v.angle_deg, v.shank_mm, v.cutting_depth_mm, v.blade_thickness_mm, v.diameter_mm) = 0
        and (jsonb_typeof(v.specs) <> 'object' or v.specs = '{}'::jsonb))
      or not exists (select 1 from public.variant_substrates where variant_id = v.id)
      or (nullif(private.catalogue_trim(v.option_label), '') is null and exists (
        select 1 from public.variants sibling where sibling.product_id = family.id and sibling.id <> v.id
      ))
      or exists (
        select 1 from public.variants sibling where sibling.product_id = family.id and sibling.id <> v.id
          and sibling.publication_status = 'published'
          and (nullif(private.catalogue_trim(sibling.option_label), '') is null
            or lower(private.catalogue_trim(sibling.option_label)) = lower(private.catalogue_trim(v.option_label)))
      ) then
      raise exception using errcode = '22023', message = 'catalogue_incomplete_selling_data';
    end if;
    if not private.catalogue_has_public_fit(v.id) then
      raise exception using errcode = '22023', message = 'catalogue_verified_fit_required';
    end if;
    update public.variants set publication_status = 'published' where id = v.id and publication_status <> 'published';
  else
    update public.variants set publication_status = 'draft' where id = v.id and publication_status = 'published';
  end if;
  return family.slug;
end;
$$;

revoke all on function private.keep_catalogue_mapping_private(),
  private.lock_admin_catalogue_variant(uuid, uuid, timestamptz), private.catalogue_has_public_fit(uuid),
  private.catalogue_trim(text), private.touch_catalogue_version()
  from public, anon, authenticated, service_role;

revoke all on function
  public.admin_catalogue_update(uuid, uuid, timestamptz, timestamptz, jsonb),
  public.admin_catalogue_review(uuid, uuid, timestamptz, boolean, text, text, uuid, timestamptz, text, text, text, text, text),
  public.admin_catalogue_set_publication(uuid, uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role;
grant execute on function
  public.admin_catalogue_update(uuid, uuid, timestamptz, timestamptz, jsonb),
  public.admin_catalogue_review(uuid, uuid, timestamptz, boolean, text, text, uuid, timestamptz, text, text, text, text, text),
  public.admin_catalogue_set_publication(uuid, uuid, timestamptz, boolean)
  to service_role;

revoke insert, update, delete, truncate, trigger on
  public.products, public.compatibility, public.variant_substrates, public.variants from service_role;
grant insert (id, product_id, sku, option_label, tool, angle_deg, shank_mm, cutting_depth_mm,
  blade_thickness_mm, diameter_mm, specs, supplier_name, supplier_part_number, price_1_4_pence, price_5_9_pence,
  price_10_plus_pence, sort_order, created_at),
  update (price_1_4_pence, price_5_9_pence, price_10_plus_pence)
on public.variants to service_role;
