-- Catalogue: product families, purchasable variants and compatibility records.
-- PRD section 6 data contract. Orders, reservations, stock movements and credit
-- arrive in later migrations and reference variants(id); nothing here needs
-- reworking for them.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Code lookup key: trim, fold case and drop spaces, hyphens and any other
-- punctuation. The printed code is always stored beside it for display.
create function public.normalise_code(code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- Text key for fuzzy matching: lower case without accents, so "Zund" finds "Zünd".
create function public.fold_text(input text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(input, '')));
$$;

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create type public.publication_status as enum ('draft', 'published', 'archived');
create type public.verification_state as enum ('candidate', 'approved', 'rejected');
create type public.compatibility_code_kind as enum ('model', 'item_number', 'alias');

create table public.tool_categories (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  name text not null unique,
  sort_order integer not null default 0
);

create table public.substrates (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  name text not null unique,
  -- Key of an approved swatch treatment in the design pack; null until artwork exists.
  swatch text check (swatch in ('flutes', 'film', 'weave')),
  sort_order integer not null default 0
);

create table public.brands (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  name text not null unique
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  family_code text not null unique,
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  tool_category text not null references public.tool_categories (slug),
  description text not null default '',
  -- Approved artwork keys: {"drawing": "...", "proof": "...", "photo": "..."}.
  media jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  sku text not null unique,
  sku_normalised text generated always as (public.normalise_code(sku)) stored check (sku_normalised <> ''),
  -- What tells this variant from its siblings, for example "36°".
  option_label text,
  tool text,
  angle_deg numeric(4, 1) check (angle_deg > 0 and angle_deg < 180),
  shank_mm numeric(5, 2) check (shank_mm > 0),
  cutting_depth_mm numeric(5, 2) check (cutting_depth_mm > 0),
  blade_thickness_mm numeric(5, 2) check (blade_thickness_mm > 0),
  diameter_mm numeric(5, 2) check (diameter_mm > 0),
  -- Further verified specifications as label/value pairs.
  specs jsonb not null default '{}'::jsonb,
  supplier_name text,
  supplier_part_number text,
  -- GBP per blade excluding VAT, integer pence, all-units tiers.
  price_1_4_pence integer not null check (price_1_4_pence > 0),
  price_5_9_pence integer not null check (price_5_9_pence > 0),
  price_10_plus_pence integer not null check (price_10_plus_pence > 0),
  -- On-hand counts physical blades. Reserved is maintained by the later
  -- reservation slice. Available is on-hand less reserved.
  stock_on_hand integer not null default 0 check (stock_on_hand >= 0),
  stock_reserved integer not null default 0 check (stock_reserved >= 0),
  availability text generated always as (
    case when stock_on_hand - stock_reserved > 0 then 'in_stock' else 'out_of_stock' end
  ) stored,
  publication_status public.publication_status not null default 'draft',
  approved_at timestamptz,
  approved_by text,
  evidence_source text,
  evidence_note text,
  is_staging_fixture boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variants_tiers_do_not_increase
    check (price_5_9_pence <= price_1_4_pence and price_10_plus_pence <= price_5_9_pence),
  constraint variants_reserved_within_on_hand check (stock_reserved <= stock_on_hand),
  constraint variants_published_requires_approval check (
    publication_status <> 'published'
    or (approved_at is not null and evidence_source is not null and supplier_part_number is not null)
  )
);
create index variants_product_id_idx on public.variants (product_id);
create unique index variants_sku_normalised_idx on public.variants (sku_normalised);
create index variants_public_code_idx on public.variants (sku_normalised) where publication_status = 'published';
create index products_family_code_normalised_idx on public.products (public.normalise_code(family_code));
create index variants_published_idx on public.variants (product_id) where publication_status = 'published';

create table public.variant_substrates (
  variant_id uuid not null references public.variants (id) on delete cascade,
  substrate text not null references public.substrates (slug),
  primary key (variant_id, substrate)
);
create index variant_substrates_substrate_idx on public.variant_substrates (substrate);

create table public.compatibility (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants (id) on delete cascade,
  code text not null,
  code_normalised text generated always as (public.normalise_code(code)) stored,
  code_kind public.compatibility_code_kind not null default 'item_number',
  brand text references public.brands (slug),
  machine text,
  tool text,
  adapter text,
  evidence_source text,
  evidence_url text,
  evidence_note text,
  verification_state public.verification_state not null default 'candidate',
  -- A private alias helps staff match enquiries and is never shown or searchable publicly.
  is_private boolean not null default false,
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint compatibility_code_not_blank check (public.normalise_code(code) <> ''),
  constraint compatibility_unique_code_per_variant unique (variant_id, code_normalised),
  constraint compatibility_approved_requires_evidence check (
    verification_state <> 'approved' or (approved_at is not null and evidence_source is not null)
  )
);
create index compatibility_public_code_idx on public.compatibility (code_normalised)
where verification_state = 'approved' and not is_private;

create trigger products_touch before update on public.products
for each row execute function private.touch_updated_at();
create trigger variants_touch before update on public.variants
for each row execute function private.touch_updated_at();
create trigger compatibility_touch before update on public.compatibility
for each row execute function private.touch_updated_at();

-- Row-level security -------------------------------------------------------
-- Public roles read approved records for published variants only, and only
-- the columns granted below. Supplier identity, stock counts, evidence notes
-- and review state stay with the service role.

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

alter table public.tool_categories enable row level security;
alter table public.substrates enable row level security;
alter table public.brands enable row level security;
alter table public.products enable row level security;
alter table public.variants enable row level security;
alter table public.variant_substrates enable row level security;
alter table public.compatibility enable row level security;

revoke all on
  public.tool_categories, public.substrates, public.brands, public.products, public.variants,
  public.variant_substrates, public.compatibility
from public, anon, authenticated;

grant all on
  public.tool_categories, public.substrates, public.brands, public.products, public.variants,
  public.variant_substrates, public.compatibility
to service_role;

grant select on public.tool_categories, public.substrates, public.brands, public.variant_substrates
to anon, authenticated;

grant select (id, family_code, slug, name, tool_category, description, media, sort_order)
on public.products to anon, authenticated;

grant select (
  id, product_id, sku, sku_normalised, option_label, tool, angle_deg, shank_mm, cutting_depth_mm,
  blade_thickness_mm, diameter_mm, specs, price_1_4_pence, price_5_9_pence, price_10_plus_pence,
  availability, publication_status, sort_order
) on public.variants to anon, authenticated;

grant select (id, variant_id, code, code_normalised, code_kind, brand, machine, tool, adapter, verification_state, is_private)
on public.compatibility to anon, authenticated;

create policy "Tool types of public families" on public.tool_categories
for select to anon, authenticated
using (exists (select 1 from public.products p where p.tool_category = tool_categories.slug));

create policy "Substrates of public variants" on public.substrates
for select to anon, authenticated
using (exists (select 1 from public.variant_substrates vs where vs.substrate = substrates.slug));

create policy "Brands from approved public mappings" on public.brands
for select to anon, authenticated
using (exists (select 1 from public.compatibility c where c.brand = brands.slug));

create policy "Published variants are public" on public.variants
for select to anon, authenticated
using (publication_status = 'published');

create policy "Families with a published variant are public" on public.products
for select to anon, authenticated
using (
  exists (
    select 1 from public.variants v
    where v.product_id = products.id and v.publication_status = 'published'
  )
);

create policy "Substrates of published variants are public" on public.variant_substrates
for select to anon, authenticated
using (
  exists (
    select 1 from public.variants v
    where v.id = variant_substrates.variant_id and v.publication_status = 'published'
  )
);

create policy "Approved public mappings of published variants are public" on public.compatibility
for select to anon, authenticated
using (
  verification_state = 'approved'
  and not is_private
  and exists (
    select 1 from public.variants v
    where v.id = compatibility.variant_id and v.publication_status = 'published'
  )
);
