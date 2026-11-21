-- STAGING-ONLY TEST FIXTURE. Never run this against production.
-- It publishes a handful of seeded variants with invented approvals and
-- positive stock so the storefront, search and later checkout work have
-- something to show and contend over. Nothing here is supplier evidence.
-- Run through the local or hosted-staging fixture command, which supplies
-- the transaction and checks the target. Names, artwork and prices come
-- from the canonical catalogue seed; the fixture adds only test approvals
-- and stock.

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

-- The demo's existing delivery assumptions are not live carrier terms.
with calendars as (
  insert into public.delivery_calendars
    (calendar, active_from, active_through, working_weekdays, bank_holidays, closures, cutoff_minutes)
  select calendar, date '2026-01-01', date '2027-12-31', array[1,2,3,4,5]::smallint[],
    '{2026-01-01,2026-04-03,2026-04-06,2026-05-04,2026-05-25,2026-08-31,2026-12-25,2026-12-28,2027-01-01,2027-03-26,2027-03-29,2027-05-03,2027-05-31,2027-08-30,2027-12-27,2027-12-28}'::date[],
    '{}'::date[], cutoff_minutes
  from (values ('warehouse', 930::smallint), ('carrier', null::smallint)) as defaults(calendar, cutoff_minutes)
  where not exists (select 1 from public.delivery_calendars)
    and not exists (select 1 from public.delivery_rules)
  on conflict do nothing
  returning calendar
), rules as (
  select 'area' as scope, unnest(string_to_array(
    'AL B BA BB BD BH BL BN BR BS CA CB CF CH CM CO CR CT CV CW DA DD DE DG DH DL DN DT DY E EC EH EN ' ||
    'EX FY G GL GU HA HD HG HP HR HU HX IG IP KA KT L LA LD LE LL LN LS LU M ME MK ML N NE NG NN NP NR ' ||
    'NW OL OX PE PL PO PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TD TF TN TQ TR TS TW ' ||
    'UB W WA WC WD WF WN WR WS WV YO', ' '
  )) as code, 'next-working-day' as kind, 'Next working day' as service_name, 695 as charge_ex_vat_pence, 1 as working_days
  union all
  select 'district', unnest(string_to_array(
    'KA27 KA28 PO30 PO31 PO32 PO33 PO34 PO35 PO36 PO37 PO38 PO39 PO40 PO41 TR21 TR22 TR23 TR24 TR25', ' '
  )), 'enquiry', null, null, null
)
insert into public.delivery_rules (scope, code, kind, service_name, charge_ex_vat_pence, working_days)
select scope, code, kind, service_name, charge_ex_vat_pence, working_days
from rules
where (select count(*) from calendars) = 2;
