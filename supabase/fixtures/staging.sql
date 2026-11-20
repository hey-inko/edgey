-- STAGING-ONLY TEST FIXTURE. Never run this against production.
-- It publishes a handful of seeded variants with invented approvals and
-- positive stock so the storefront, search and later checkout work have
-- something to show and contend over. Nothing here is supplier evidence.
-- Apply it with `pnpm db:fixture`, which refuses non-local database addresses.

begin;

-- sku, stock on hand, codes to approve
create temporary table fixture_variants (sku text primary key, stock integer not null, codes text[] not null) on commit drop;
insert into fixture_variants values
  ('EDG-Z10', 40, array['Z10', '3910301']),       -- 500-9802 stays an unverified candidate
  ('EDG-Z16', 25, array['Z16', '3910306']),
  ('EDG-SR6223', 18, array['BLD-SR6223', '42437293']),
  ('EDG-Z50', 12, array['Z50', '3910335']),
  ('EDG-Z71', 6, array['Z71', '5006045']),
  ('EDG-Z1', 30, array['Z1', '3910105']),
  ('EDG-SUM-DRG-36', 20, array['391-360']),
  ('EDG-SUM-DRG-60', 0, array['391-231']),       -- published and out of stock
  ('EDG-SUM-TAN-36', 8, array['390-534']),        -- EDG-SUM-TAN-45 stays draft
  ('EDG-MIM-A45', 15, array['SPB-0030']),         -- one code, two configurations
  ('EDG-MIM-A60', 1, array['SPB-0030']);          -- EDG-MIM-A30 stays draft

do $$
declare missing text;
begin
  select string_agg(f.sku, ', ') into missing
  from fixture_variants f left join public.variants v on v.sku = f.sku
  where v.id is null;
  if missing is not null then
    raise exception 'Run the catalogue seed first. Missing variants: %', missing;
  end if;
end $$;

update public.variants v set
  publication_status = 'published',
  approved_at = now(),
  approved_by = 'staging-fixture',
  evidence_source = 'STAGING FIXTURE - not supplier evidence',
  supplier_name = 'Staging fixture supplier',
  supplier_part_number = 'FIXTURE-' || v.sku,
  is_staging_fixture = true
from fixture_variants f
where v.sku = f.sku;

select private.apply_stock_movement('receive', 'receive:staging-fixture:' || v.sku, v.id, f.stock, 0)
from fixture_variants f join public.variants v on v.sku = f.sku
where f.stock > 0 and not exists (
  select 1 from public.stock_movements m where m.variant_id = v.id and m.kind = 'opening'
);

update public.compatibility c set
  verification_state = 'approved',
  approved_at = now(),
  approved_by = 'staging-fixture',
  evidence_source = 'STAGING FIXTURE - not supplier evidence'
from fixture_variants f
join public.variants v on v.sku = f.sku
where c.variant_id = v.id
  and c.code_normalised in (select public.normalise_code(code) from unnest(f.codes) as code);

-- An approved but private alias on a published variant. It must never surface.
insert into public.compatibility (
  variant_id, code, code_kind, evidence_source, evidence_note, verification_state, is_private, approved_at, approved_by
)
select v.id, 'PRIV-Z10-ALIAS', 'alias', 'STAGING FIXTURE - not supplier evidence',
  'Private alias used to test that it never surfaces publicly.', 'approved', true, now(), 'staging-fixture'
from public.variants v where v.sku = 'EDG-Z10'
on conflict (variant_id, code_normalised) do nothing;

commit;
