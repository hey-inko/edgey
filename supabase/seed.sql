-- Catalogue seed: the first inventory order and three retained drafts in PRD Appendix A.
-- Every variant is imported as draft with zero stock. Reference codes are
-- unverified candidates: a listed OEM identity tells the catalogue owner which
-- original to check and does not establish an Edgey fit.
-- For local development and testing only. Do not run against a live project.
-- Reset locally to load a clean catalogue. Upserts are non-destructive and
-- do not remove records from older seeds or replace approvals or stock.

insert into public.tool_categories (slug, name, sort_order) values
  ('drag', 'Drag', 10),
  ('oscillating', 'Oscillating', 20),
  ('rotary', 'Rotary', 30),
  ('kiss-cut', 'Kiss-cut', 40),
  ('v-cut', 'V-cut', 50),
  ('tangential', 'Tangential', 60),
  ('roll-plotter', 'Roll plotter', 70)
on conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order;

insert into public.substrates (slug, name, swatch, sort_order) values
  ('corrugated-board', 'Corrugated board', 'flutes', 10),
  ('vinyl', 'Vinyl', 'film', 20),
  ('textile', 'Textile', 'weave', 30),
  ('foamex', 'Foamex', null, 40),
  ('correx', 'Correx', null, 50),
  ('foam-board', 'Foam board', null, 60),
  ('display-board', 'Display board', null, 70),
  ('re-board', 'Re-board', null, 80),
  ('honeycomb-board', 'Honeycomb board', null, 90),
  ('folding-carton', 'Folding carton', null, 100),
  ('pvc', 'PVC', null, 110),
  ('plastics', 'Plastics', null, 120),
  ('foam', 'Foam', null, 130),
  ('banner', 'Banner', null, 140),
  ('soft-signage', 'Soft signage', null, 150),
  ('technical-fabric', 'Carbon and aramid fabric', null, 160),
  ('reflective-film', 'Reflective film', null, 170),
  ('laminate', 'Laminate', null, 180),
  ('flock', 'Flock', null, 190),
  ('heat-transfer-film', 'Heat-transfer film', null, 200),
  ('sandblast-film', 'Sandblast film', null, 210),
  ('stencil-film', 'Stencil film', null, 220),
  ('styrene', 'Styrene', null, 230)
on conflict (slug) do update
  set name = excluded.name, swatch = excluded.swatch, sort_order = excluded.sort_order;

insert into public.brands (slug, name) values
  ('zund', 'Zünd'),
  ('summa', 'Summa'),
  ('kongsberg', 'Kongsberg'),
  ('dyss', 'DYSS'),
  ('mimaki', 'Mimaki'),
  ('roland', 'Roland'),
  ('graphtec', 'Graphtec')
on conflict (slug) do update set name = excluded.name;

-- Families. Names are working names in the design demo's style; the four the
-- design pack names are used as given. Only those four have approved artwork.
insert into public.products (family_code, slug, name, tool_category, description, media, sort_order) values
  ('EDG-Z10', 'edg-z10', 'Flat-stock drag blade', 'drag', 'Drag blade for flat sheet and roll stock.', '{"drawing": "drag-line.svg", "photo": "drag.webp", "proof": "coral"}', 10),
  ('EDG-SUM-9802', 'edg-sum-9802', 'Short flat-stock drag blade', 'drag', 'Double-edge flat drag blade for the Summa F-Series Double-Edge Cutout Tool.', '{}', 11),
  ('EDG-Z11', 'edg-z11', 'Tight-corner drag blade', 'drag', 'Steeper drag blade for carton, thin plastics and tight corners.', '{}', 20),
  ('EDG-SUM-9803', 'edg-sum-9803', 'Short tight-corner drag blade', 'drag', 'Double-edge flat drag blade for the Summa F-Series Double-Edge Cutout Tool.', '{}', 21),
  ('EDG-Z46', 'edg-z46', 'Heavy drag blade', 'drag', 'Long drag blade for thick sheet and high-speed runs.', '{}', 30),
  ('EDG-Z16', 'edg-z16', 'Oscillating blade', 'oscillating', 'Oscillating blade for corrugated and foam-centred boards.', '{"drawing": "oscillating-line.svg", "photo": "oscillating.webp", "proof": "cyan"}', 40),
  ('EDG-Z17', 'edg-z17', 'Tight-radius oscillating blade', 'oscillating', 'Oscillating blade for tight radii in corrugated and foam board.', '{}', 50),
  ('EDG-Z20', 'edg-z20', 'Detail oscillating blade', 'oscillating', 'Thin oscillating blade for detailed corrugated and display board.', '{}', 60),
  ('EDG-Z21', 'edg-z21', 'Fluted-board oscillating blade', 'oscillating', 'Thin oscillating blade for double-wall corrugated and fluted board.', '{}', 70),
  ('EDG-Z28', 'edg-z28', 'Long oscillating blade', 'oscillating', 'Long oscillating blade for thick foam, Re-board and honeycomb.', '{}', 80),
  ('EDG-Z71', 'edg-z71', 'V-cut blade', 'v-cut', 'V-cut blade for Re-board and honeycomb display work.', '{}', 90),
  ('EDG-Z50', 'edg-z50', 'Decagonal rotary blade', 'rotary', 'Driven rotary blade for fabrics and soft signage.', '{"drawing": "rotary-line.svg", "photo": "rotary.webp", "proof": "violet"}', 42),
  ('EDG-Z52', 'edg-z52', 'Large decagonal rotary blade', 'rotary', 'Larger rotary blade for heavy textiles and technical fabric.', '{}', 110),
  ('EDG-Z1', 'edg-z1', 'Kiss-cut blade', 'kiss-cut', 'Kiss-cut blade for self-adhesive vinyl and decals.', '{}', 120),
  ('EDG-Z2', 'edg-z2', 'Thick-vinyl kiss-cut blade', 'kiss-cut', 'Kiss-cut blade for thick and reflective vinyl.', '{}', 130),
  ('EDG-SR6223', 'edg-sr6223', 'Round-shank blade', 'oscillating', 'Round-shank oscillating blade for corrugated, Correx and thin Foamex.', '{"drawing": "cylinder-line.svg", "photo": "cylinder.webp", "proof": "lime"}', 41),
  ('EDG-SR6224', 'edg-sr6224', 'Reinforced round-shank blade', 'oscillating', 'Reinforced round-shank blade for high-recycled corrugated and heavy display board.', '{}', 150),
  ('EDG-SR6310', 'edg-sr6310', 'Long-reach round-shank blade', 'oscillating', 'Round-shank blade for triple-wall corrugated, honeycomb and Re-board.', '{}', 160),
  ('EDG-SR6315', 'edg-sr6315', 'Slender round-shank blade', 'oscillating', 'Slender round-shank blade for soft foam board and tight curves.', '{}', 170),
  ('EDG-DF113', 'edg-df113', 'Flat drag sword knife', 'drag', 'Double-edge flat drag blade for the Kongsberg Static Knife Tool and Heavy Duty Knife.', '{}', 171),
  ('EDG-HTR040', 'edg-htr040', 'Circular rotary blade', 'rotary', 'Circular rotary blade for textiles, flag fabric and soft signage.', '{}', 180),
  ('EDG-MIM-45', 'edg-mim-45', 'Mimaki-pattern plotter blade', 'roll-plotter', 'Roll-plotter blade for cast and calendered vinyl, reflective film and flock.', '{}', 190),
  ('EDG-ROL-45', 'edg-rol-45', 'Roland-pattern plotter blade', 'roll-plotter', 'Roll-plotter blade for standard vinyl, sandblast and heat-transfer film.', '{}', 200),
  ('EDG-SUM-DRG', 'edg-sum-drg', 'Summa-pattern drag plotter blade', 'roll-plotter', 'Drag blade for roll plotters cutting vinyl, thick laminate and reflective film.', '{}', 210),
  ('EDG-SUM-TAN', 'edg-sum-tan', 'Tangential plotter blade', 'tangential', 'Tangential blade for heavy vinyl and high-speed lettering.', '{}', 220),
  ('EDG-GRP-CB', 'edg-grp-cb', 'Graphtec-pattern plotter blade', 'roll-plotter', 'Roll-plotter blade for vinyl, reflective films and sandblast films, depending on the option.', '{}', 230)
on conflict (family_code) do update set
  slug = excluded.slug, name = excluded.name, tool_category = excluded.tool_category,
  description = excluded.description, media = excluded.media, sort_order = excluded.sort_order
where not exists (
  select 1 from public.variants v
  where v.product_id = products.id and v.publication_status <> 'draft'
);

-- Variants. A single-variant family reuses its family code as the SKU. Families
-- with physical options have a distinct draft SKU for each option.
with data (sku, family_code, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm, diameter_mm, specs, evidence_note, p1, p2, p3, sort_order) as (
  values
  ('EDG-Z10', 'EDG-Z10', null, 'UCT, SCT', 50, null, 4.8, 1.5, null, '{"Blade type": "Double-edge flat drag", "Length": "50 mm", "Width": "8 mm", "Other compatible machines": "JWEI and iEcho, 50 mm holders"}', null, 2250, 1995, 1750, 0),
  ('EDG-Z11', 'EDG-Z11', null, 'UCT, SCT', 60, null, 6.9, 1.5, null, '{"Blade type": "Double-edge flat drag", "Length": "50 mm", "Width": "8 mm", "Other compatible machines": "JWEI and iEcho, 50 mm holders"}', null, 2250, 1995, 1750, 0),
  ('EDG-SUM-9802', 'EDG-SUM-9802', null, 'Double-Edge Cutout Tool', 50, null, 4.8, 1.5, null, '{"Blade type": "Double-edge flat drag", "Length": "25 mm", "Width": "8 mm"}', null, null, null, null, 0),
  ('EDG-SUM-9803', 'EDG-SUM-9803', null, 'Double-Edge Cutout Tool', 60, null, 6.5, 1.5, null, '{"Blade type": "Double-edge flat drag", "Length": "25 mm", "Width": "8 mm"}', null, null, null, null, 0),
  ('EDG-Z46', 'EDG-Z46', null, 'UCT, SCT', 45, null, 20.0, 1.5, null, '{"Blade type": "Single-edge heavy drag", "Length": "50 mm", "Width": "6 mm"}', null, 3650, 3250, 2850, 0),
  ('EDG-Z16', 'EDG-Z16', null, 'EOT, POT, UCT', 54, null, 7.4, 0.63, null, '{"Blade type": "Pointed flat oscillating/drag", "Length": "26 mm", "Width": "5.6 mm", "Other compatible machines": "Lectra (models and tool not stated)"}', null, 2150, 1850, 1595, 0),
  ('EDG-Z17', 'EDG-Z17', null, 'EOT, POT, UCT', 65, null, 12.0, 0.63, null, '{"Blade type": "Pointed flat oscillating/drag", "Length": "25 mm", "Width": "5.6 mm"}', null, 2150, 1850, 1595, 0),
  ('EDG-Z20', 'EDG-Z20', null, 'EOT, POT', null, null, 14.3, 0.63, null, '{"Blade type": "Pointed oscillating", "Length": "25 mm", "Width": "4 mm", "Angles": "63° / 84°"}', null, 2350, 2050, 1800, 0),
  ('EDG-Z21', 'EDG-Z21', null, 'EOT, POT', null, null, 17.2, 0.63, null, '{"Blade type": "Pointed oscillating", "Length": "28 mm", "Width": "4 mm", "Angles": "63° / 84°"}', null, 2450, 2150, 1895, 0),
  ('EDG-Z28', 'EDG-Z28', null, 'EOT, POT', null, null, 26.0, 0.63, null, '{"Blade type": "Long-reach pointed oscillating", "Length": "38 mm", "Width": "4 mm", "Angles": "45° / 86°"}', null, 3150, 2750, 2450, 0),
  ('EDG-Z71', 'EDG-Z71', null, 'VCT V-Cut Tool', 90, null, 16.0, 1.5, null, '{"Blade type": "V-Cut bevel blade", "Length": "50 mm", "Width": "8 mm", "V-cut head range": "0°–45°"}', null, 3450, 3050, 2700, 0),
  ('EDG-Z50', 'EDG-Z50', null, 'DRT, PRT', null, null, 3.5, 0.63, 25.0, '{"Blade type": "Decagonal (10-sided) rotary blade", "Bore diameter": "8 mm"}', null, 3800, 3400, 3000, 0),
  ('EDG-Z52', 'EDG-Z52', null, 'DRT, PRT', null, null, 7.0, 0.63, 32.0, '{"Blade type": "Decagonal (10-sided) rotary blade", "Bore diameter": "8 mm"}', null, 4400, 3900, 3500, 0),
  ('EDG-Z1', 'EDG-Z1', null, 'KCT, KCM-S, C2', 35, 3.0, 1.0, null, null, '{"Blade type": "Round-shank kiss-cut drag", "Length": "18.5 mm", "Depth qualifier": "Approximate maximum"}', null, 995, 850, 750, 0),
  ('EDG-Z2', 'EDG-Z2', null, 'KCT, KCM-S, C2', 35, 3.0, 1.5, null, null, '{"Blade type": "Round-shank kiss-cut drag", "Length": "18.5 mm", "Depth qualifier": "Approximate maximum"}', null, 995, 850, 750, 0),
  ('EDG-SR6223', 'EDG-SR6223', null, 'HF VibraCut, MP HF, Oscillating (6 mm adapter)', 66, 6.0, 12.0, 0.64, null, '{"Blade type": "Single-edge 6mm round-shank oscillating", "Length": "39 mm", "Tip angle": "24°"}', null, 2550, 2250, 1995, 0),
  ('EDG-SR6224', 'EDG-SR6224', null, 'HF VibraCut, MP HF, Oscillating (6 mm adapter)', 66, 6.0, 12.0, 0.64, null, '{"Blade type": "Single-edge 6mm round-shank oscillating", "Length": "39 mm", "Tip angle": "24°"}', null, 2650, 2350, 2095, 0),
  ('EDG-SR6310', 'EDG-SR6310', null, 'HF VibraCut, MP HF, Long Stroke (6 mm adapter)', 79, 6.0, 20.0, 0.64, null, '{"Blade type": "Single-edge 6mm round-shank oscillating", "Length": "39 mm", "Tip angle": "11°"}', null, 3050, 2700, 2400, 0),
  ('EDG-SR6315', 'EDG-SR6315', null, 'HF VibraCut, MP HF, Long Stroke (6 mm adapter)', 75, 6.0, 14.0, 0.6, null, '{"Blade type": "Slender single-edge 6mm round-shank oscillating", "Length": "39 mm", "Tip angle": "15°"}', null, 2850, 2500, 2200, 0),
  ('EDG-DF113', 'EDG-DF113', null, 'Static Knife Tool, Heavy Duty Knife', 60, null, 6.5, 1.5, null, '{"Blade type": "Double-edge flat drag sword knife", "Length": "50 mm", "Width": "8 mm"}', 'Stated equivalent to Z11; identity and fit are unconfirmed and the stated cutting depth differs.', null, null, null, 0),
  ('EDG-HTR040', 'EDG-HTR040', null, null, null, null, null, null, 40, '{}', null, 3950, 3500, 3100, 0),
  ('EDG-MIM-A30', 'EDG-MIM-45', '30°', null, 30, null, null, null, null, '{}', null, 1195, 900, 750, 10),
  ('EDG-MIM-A45', 'EDG-MIM-45', '45°', null, 45, null, null, null, 1.5, '{"Blade type": "Standard vinyl drag blade", "Length": "20 mm", "Offset": "0.25–0.30 mm"}', null, 1195, 900, 750, 20),
  ('EDG-MIM-A60', 'EDG-MIM-45', '60°', null, 60, null, null, null, 1.5, '{"Blade type": "Thick/reflective/flock drag blade", "Length": "20 mm", "Offset": "0.50 mm"}', null, 1195, 900, 750, 30),
  ('EDG-ROL-A30', 'EDG-ROL-45', '30°', null, 30, null, null, null, null, '{}', null, 1150, 850, 700, 10),
  ('EDG-ROL-A45', 'EDG-ROL-45', '45°', null, 45, null, null, null, 2.0, '{"Blade type": "Standard vinyl drag blade", "Length": "23.5 mm", "Offset": "0.25 mm", "Other compatible machines": "Mutoh and GCC (models and holders not stated)"}', null, 1150, 850, 700, 20),
  ('EDG-ROL-A60', 'EDG-ROL-45', '60°', null, 60, null, null, null, 2.0, '{"Blade type": "Thick/reflective/sandblast drag blade", "Length": "23.5 mm", "Offset": "0.25 mm", "Other compatible machines": "Mutoh and GCC (models and holders not stated)"}', null, 1150, 850, 700, 30),
  ('EDG-SUM-DRG-36', 'EDG-SUM-DRG', '36°', 'D-Series Drag; F-Series Drag Module', 36, null, 0.25, null, 1.5, '{"Blade type": "Standard vinyl drag blade", "Length": "19 mm"}', null, 1195, 900, 750, 10),
  ('EDG-SUM-DRG-60', 'EDG-SUM-DRG', '60°', 'D-Series Drag; F-Series Drag Module', 60, null, 0.6, null, 1.5, '{"Blade type": "Thick/reflective/flock drag blade", "Length": "19 mm"}', null, 1195, 900, 750, 20),
  ('EDG-SUM-TAN-36', 'EDG-SUM-TAN', '36°', 'T-Series Tangential; F-Series Tangential Module', 36, null, 0.25, null, 2.5, '{"Blade type": "Standard tangential knife", "Length": "31 mm"}', null, 1950, 1700, 1495, 10),
  ('EDG-SUM-TAN-45', 'EDG-SUM-TAN', '45°', 'T-Series Tangential; F-Series Tangential Module', 45, null, 1.0, null, 2.5, '{"Blade type": "Wedge tangential knife", "Length": "31 mm", "Wedge angles": "40°/25°"}', null, 1950, 1700, 1495, 20),
  ('EDG-GRP-CB09-45', 'EDG-GRP-CB', 'CB09 holder · 45°', 'PHP33-CB09N-HS (blue holder)', 45, null, null, null, 0.9, '{"Blade type": "Standard vinyl drag blade", "Length": "19 mm", "Offset": "0.25 mm"}', null, 1195, 900, 750, 10),
  ('EDG-GRP-CB09-60', 'EDG-GRP-CB', 'CB09 holder · 60°', 'PHP33-CB09N-HS (blue holder)', 60, null, null, null, 0.9, '{"Blade type": "Small lettering / thick vinyl drag", "Length": "19 mm", "Offset": "0.25 mm"}', null, 1195, 900, 750, 20),
  ('EDG-GRP-CB15-45', 'EDG-GRP-CB', 'CB15 holder · 45°', 'PHP33-CB15N-HS (red holder)', 45, null, null, null, 1.5, '{"Blade type": "Heavy-duty vinyl/reflective drag", "Length": "19 mm", "Offset": "0.25 mm"}', null, 1195, 900, 750, 30),
  ('EDG-GRP-CB15-60', 'EDG-GRP-CB', 'CB15 holder · 60°', 'PHP33-CB15N-HS (red holder)', 60, null, null, null, 1.5, '{"Blade type": "Heavy-duty reflective/sandblast drag", "Length": "19 mm", "Offset": "0.25 mm"}', null, 1195, 900, 750, 40)
)
insert into public.variants (
  product_id, sku, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm,
  diameter_mm, specs, evidence_source, evidence_note, price_1_4_pence, price_5_9_pence, price_10_plus_pence, sort_order
)
select p.id, d.sku, d.option_label, d.tool, d.angle_deg::numeric, d.shank_mm::numeric, d.cutting_depth_mm::numeric,
  d.blade_thickness_mm::numeric, d.diameter_mm::numeric, d.specs::jsonb,
  case when d.specs::jsonb <> '{}' then 'Owner-supplied specifications (2026-11-21; unverified)' end,
  d.evidence_note, d.p1, d.p2, d.p3, d.sort_order
from data d
join public.products p on p.family_code = d.family_code
on conflict (sku) do update set
  product_id = excluded.product_id, option_label = excluded.option_label, tool = excluded.tool,
  angle_deg = excluded.angle_deg, shank_mm = excluded.shank_mm,
  cutting_depth_mm = excluded.cutting_depth_mm, blade_thickness_mm = excluded.blade_thickness_mm,
  diameter_mm = excluded.diameter_mm, specs = excluded.specs,
  price_1_4_pence = coalesce(excluded.price_1_4_pence, variants.price_1_4_pence),
  price_5_9_pence = coalesce(excluded.price_5_9_pence, variants.price_5_9_pence),
  price_10_plus_pence = coalesce(excluded.price_10_plus_pence, variants.price_10_plus_pence),
  sort_order = excluded.sort_order
where variants.publication_status = 'draft';

-- Applications to verify; shared family suggestions and option-specific uses.
with data (family_code, substrate) as (
  values
  ('EDG-Z10', 'foamex'), ('EDG-Z10', 'correx'), ('EDG-Z10', 'pvc'), ('EDG-Z10', 'vinyl'), ('EDG-Z10', 'banner'),
  ('EDG-Z11', 'folding-carton'), ('EDG-Z11', 'plastics'),
  ('EDG-Z46', 'foamex'), ('EDG-Z46', 'plastics'),
  ('EDG-Z16', 'corrugated-board'), ('EDG-Z16', 'foam-board'), ('EDG-Z16', 'correx'),
  ('EDG-Z17', 'corrugated-board'), ('EDG-Z17', 'foam-board'),
  ('EDG-Z20', 'corrugated-board'), ('EDG-Z20', 'display-board'),
  ('EDG-Z21', 'corrugated-board'),
  ('EDG-Z28', 'foam'), ('EDG-Z28', 're-board'), ('EDG-Z28', 'honeycomb-board'),
  ('EDG-Z71', 're-board'), ('EDG-Z71', 'honeycomb-board'),
  ('EDG-Z50', 'textile'), ('EDG-Z50', 'soft-signage'),
  ('EDG-Z52', 'textile'), ('EDG-Z52', 'technical-fabric'), ('EDG-Z52', 'banner'),
  ('EDG-Z1', 'vinyl'),
  ('EDG-Z2', 'vinyl'), ('EDG-Z2', 'reflective-film'),
  ('EDG-SR6223', 'corrugated-board'), ('EDG-SR6223', 'correx'), ('EDG-SR6223', 'foamex'),
  ('EDG-SR6224', 'corrugated-board'), ('EDG-SR6224', 'display-board'),
  ('EDG-SR6310', 'corrugated-board'), ('EDG-SR6310', 'honeycomb-board'), ('EDG-SR6310', 're-board'),
  ('EDG-SR6315', 'foam-board'),
  ('EDG-HTR040', 'textile'), ('EDG-HTR040', 'soft-signage'),
  ('EDG-MIM-45', 'vinyl'), ('EDG-MIM-45', 'reflective-film'), ('EDG-MIM-45', 'flock'),
  ('EDG-ROL-45', 'vinyl'), ('EDG-ROL-45', 'sandblast-film'), ('EDG-ROL-45', 'heat-transfer-film'),
  ('EDG-SUM-DRG', 'vinyl'), ('EDG-SUM-DRG', 'laminate'), ('EDG-SUM-DRG', 'reflective-film'),
  ('EDG-SUM-TAN', 'vinyl'),
  ('EDG-GRP-CB', 'vinyl'),
  ('EDG-DF113', 'vinyl'), ('EDG-DF113', 'folding-carton'), ('EDG-DF113', 'banner'), ('EDG-DF113', 'styrene')
)
insert into public.variant_substrates (variant_id, substrate)
select v.id, d.substrate
from data d
join public.products p on p.family_code = d.family_code
join public.variants v on v.product_id = p.id
where v.publication_status = 'draft'
union all
select v.id, d.substrate
from (values
  ('EDG-SR6315', 'pvc'), ('EDG-SR6315', 'corrugated-board'),
  ('EDG-ROL-A60', 'reflective-film'),
  ('EDG-SUM-DRG-60', 'flock'),
  ('EDG-GRP-CB15-45', 'reflective-film'), ('EDG-GRP-CB15-60', 'reflective-film'), ('EDG-GRP-CB15-60', 'sandblast-film')
) d (sku, substrate)
join public.variants v on v.sku = d.sku
where v.publication_status = 'draft'
on conflict do nothing;

-- Reference codes are candidates, including cross-brand compatibility. Do not
-- map 5201345 (Z60) to Z71 or map Z11 to the separately stocked DF113.
with data (sku, code, code_kind, brand, machine, tool, adapter, legacy, evidence_note) as (
  values
  ('EDG-Z10', 'Z10', 'model', 'zund', 'G3, S3, L3, D3, PN', 'UCT, SCT', null, false, null),
  ('EDG-Z10', '3910301', 'item_number', 'zund', 'G3, S3, L3, D3, PN', 'UCT, SCT', null, false, null),
  ('EDG-Z11', 'Z11', 'model', 'zund', 'G3, S3, L3, D3, PN', 'UCT, SCT', null, false, null),
  ('EDG-Z11', '3910309', 'item_number', 'zund', 'G3, S3, L3, D3, PN', 'UCT, SCT', null, false, null),
  ('EDG-SUM-9802', '500-9802', 'item_number', 'summa', 'F-Series (F1612, F1330, F1832, F3220)', 'Double-Edge Cutout Tool', null, false, null),
  ('EDG-SUM-9802', 'BLD-DF112', 'model', 'kongsberg', null, null, null, false, null),
  ('EDG-SUM-9803', '500-9803', 'item_number', 'summa', 'F-Series (F1612, F1330, F1832, F3220)', 'Double-Edge Cutout Tool', null, false, null),
  ('EDG-Z46', 'Z46', 'model', 'zund', 'G3, S3, L3', 'UCT, SCT', null, false, null),
  ('EDG-Z46', '3910328', 'item_number', 'zund', 'G3, S3, L3', 'UCT, SCT', null, false, null),
  ('EDG-Z46', '500-9807', 'item_number', 'summa', 'F-Series', 'Heavy-Duty Cutout', null, false, null),
  ('EDG-Z16', 'Z16', 'model', 'zund', 'G3, S3, L3', 'EOT, POT, UCT', null, false, null),
  ('EDG-Z16', '3910306', 'item_number', 'zund', 'G3, S3, L3', 'EOT, POT, UCT', null, false, null),
  ('EDG-Z16', 'BLD-SF216', 'model', 'kongsberg', null, null, 'BLD-SF216', false, null),
  ('EDG-Z17', 'Z17', 'model', 'zund', 'G3, S3, L3', 'EOT, POT, UCT', null, false, null),
  ('EDG-Z17', '3910307', 'item_number', 'zund', 'G3, S3, L3', 'EOT, POT, UCT', null, false, null),
  ('EDG-Z17', 'BLD-SF217', 'model', 'kongsberg', null, null, 'BLD-SF217', false, null),
  ('EDG-Z20', 'Z20', 'model', 'zund', 'G3, S3, L3', 'EOT, POT', null, false, null),
  ('EDG-Z20', '3910313', 'item_number', 'zund', 'G3, S3, L3', 'EOT, POT', null, false, null),
  ('EDG-Z20', '500-9811', 'item_number', 'summa', 'F-Series', 'EOT', null, false, null),
  ('EDG-Z20', 'SF427', 'model', 'kongsberg', null, null, null, false, null),
  ('EDG-Z21', 'Z21', 'model', 'zund', 'G3, S3, L3', 'EOT, POT', null, false, null),
  ('EDG-Z21', '3910314', 'item_number', 'zund', 'G3, S3, L3', 'EOT, POT', null, false, null),
  ('EDG-Z21', '500-9812', 'item_number', 'summa', 'F-Series', 'EOT', null, false, null),
  ('EDG-Z28', 'Z28', 'model', 'zund', 'G3, S3, L3', 'EOT, POT', null, false, null),
  ('EDG-Z28', '3910318', 'item_number', 'zund', 'G3, S3, L3', 'EOT, POT', null, false, null),
  ('EDG-Z28', '500-9814', 'item_number', 'summa', 'F-Series', 'EOT', null, false, null),
  ('EDG-Z71', 'Z71', 'model', 'zund', 'G3, S3, L3', 'VCT V-Cut Tool', null, false, null),
  ('EDG-Z71', '3910334', 'item_number', 'zund', 'G3, S3, L3', 'VCT V-Cut Tool', null, false, null),
  ('EDG-Z71', '500-9826', 'item_number', 'summa', 'F-Series', 'V-Cut Tool', null, false, null),
  ('EDG-Z50', 'Z50', 'model', 'zund', 'G3, S3, L3', 'DRT, PRT', null, false, null),
  ('EDG-Z50', '3910335', 'item_number', 'zund', 'G3, S3, L3', 'DRT, PRT', null, false, null),
  ('EDG-Z50', '500-9860', 'item_number', 'summa', 'F-Series', 'Rotary', null, false, null),
  ('EDG-Z52', 'Z52', 'model', 'zund', 'G3, S3, L3', 'DRT, PRT', null, false, null),
  ('EDG-Z52', '3910337', 'item_number', 'zund', 'G3, S3, L3', 'DRT, PRT', null, false, null),
  ('EDG-Z52', '500-9862', 'item_number', 'summa', 'F-Series', 'Rotary', null, false, null),
  ('EDG-Z1', 'Z1', 'model', 'zund', 'G3, S3, L3', 'KCT, KCM-S, C2', null, false, null),
  ('EDG-Z1', '3910110', 'item_number', 'zund', 'G3, S3, L3', 'KCT, KCM-S, C2', null, false, null),
  ('EDG-Z2', 'Z2', 'model', 'zund', 'G3, S3, L3', 'KCT, KCM-S, C2', null, false, null),
  ('EDG-Z2', '3910115', 'item_number', 'zund', 'G3, S3, L3', 'KCT, KCM-S, C2', null, false, null),
  ('EDG-SR6223', 'BLD-SR6223', 'model', 'kongsberg', 'X, XN, XL, XP, C, XE, V', 'HF VibraCut, MP HF, Oscillating', '6 mm for Oscillating', false, null),
  ('EDG-SR6223', 'G42437293', 'item_number', 'kongsberg', 'X, XN, XL, XP, C, XE, V', 'HF VibraCut, MP HF, Oscillating', '6 mm for Oscillating', false, null),
  ('EDG-SR6224', 'BLD-SR6224', 'model', 'kongsberg', 'X, XN, XL, XP, C, XE, V', 'HF VibraCut, MP HF, Oscillating', '6 mm for Oscillating', false, null),
  ('EDG-SR6224', 'G42438135', 'item_number', 'kongsberg', 'X, XN, XL, XP, C, XE, V', 'HF VibraCut, MP HF, Oscillating', '6 mm for Oscillating', false, null),
  ('EDG-SR6310', 'BLD-SR6310', 'model', 'kongsberg', 'X, XN, XL, XP, C', 'HF VibraCut, MP HF, Long Stroke', '6 mm for Long Stroke', false, null),
  ('EDG-SR6310', 'G42441626', 'item_number', 'kongsberg', 'X, XN, XL, XP, C', 'HF VibraCut, MP HF, Long Stroke', '6 mm for Long Stroke', false, null),
  ('EDG-SR6315', 'BLD-SR6315', 'model', 'kongsberg', 'X, XN, XL, XP, C', 'HF VibraCut, MP HF, Long Stroke', '6 mm for Long Stroke', false, null),
  ('EDG-SR6315', 'G42449504', 'item_number', 'kongsberg', 'X, XN, XL, XP, C', 'HF VibraCut, MP HF, Long Stroke', '6 mm for Long Stroke', false, null),
  ('EDG-DF113', 'BLD-DF113', 'model', 'kongsberg', 'X, XN, XL, XP, C, V', 'Static Knife Tool, Heavy Duty Knife', null, false, null),
  ('EDG-DF113', 'G42443036', 'item_number', 'kongsberg', 'X, XN, XL, XP, C, V', 'Static Knife Tool, Heavy Duty Knife', null, false, null),
  ('EDG-HTR040', 'HTR-040', 'model', 'dyss', null, null, null, true, 'Reference model from Appendix A.'),
  ('EDG-HTR040', 'DYSS-40MM', 'alias', 'dyss', null, null, null, true, 'Reference code to review.'),
  ('EDG-MIM-A30', 'SPB-0030', 'item_number', 'mimaki', null, null, null, true, 'Angle not mapped to this code. Map it from the supplier''s packet.'),
  ('EDG-MIM-A30', 'MD300V', 'item_number', 'mimaki', null, null, null, true, 'Angle not mapped to this code. Map it from the supplier''s packet.'),
  ('EDG-MIM-A45', 'SPB-0030', 'item_number', 'mimaki', 'CG-SRIII, CG-AR, CG-FXII, CJV150, CJV300, UCJV series', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-MIM-A45', 'MD300V', 'item_number', 'mimaki', 'CG-SRIII, CG-AR, CG-FXII, CJV150, CJV300, UCJV series', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-MIM-A60', 'SPB-0030', 'item_number', 'mimaki', 'CG-SRIII, CG-AR, CG-FXII, CJV150, CJV300, UCJV series', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-MIM-A60', 'MD300V', 'item_number', 'mimaki', 'CG-SRIII, CG-AR, CG-FXII, CJV150, CJV300, UCJV series', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-ROL-A30', 'ZEC-U1005', 'item_number', 'roland', null, null, null, true, 'Angle not mapped to this code. Map it from the supplier''s packet.'),
  ('EDG-ROL-A30', 'ZEC-U5025', 'item_number', 'roland', null, null, null, true, 'Angle not mapped to this code. Map it from the supplier''s packet.'),
  ('EDG-ROL-A45', 'ZEC-U1005', 'item_number', 'roland', 'VersaCAMM, TrueVIS, CAMM-1 (GS-24, GR2, GX series)', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-ROL-A45', 'ZEC-U5025', 'item_number', 'roland', 'VersaCAMM, TrueVIS, CAMM-1 (GS-24, GR2, GX series)', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-ROL-A60', 'ZEC-U1005', 'item_number', 'roland', 'VersaCAMM, TrueVIS, CAMM-1 (GS-24, GR2, GX series)', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-ROL-A60', 'ZEC-U5025', 'item_number', 'roland', 'VersaCAMM, TrueVIS, CAMM-1 (GS-24, GR2, GX series)', null, null, true, 'Legacy code; compatible machines are owner-supplied and unverified. Check the actual part number for this angle on the packet.'),
  ('EDG-SUM-DRG-36', '391-360', 'item_number', 'summa', 'SummaCut, S Class 2 / 3 D-Series, F-Series', 'D-Series Drag; F-Series Drag Module', null, false, null),
  ('EDG-SUM-DRG-60', '391-231', 'item_number', 'summa', 'SummaCut, S Class 2 / 3 D-Series, F-Series', 'D-Series Drag; F-Series Drag Module', null, false, null),
  ('EDG-SUM-TAN-36', '390-534', 'item_number', 'summa', 'S Class 2 / 3 T-Series, F-Series', 'T-Series Tangential; F-Series Tangential Module', null, false, null),
  ('EDG-SUM-TAN-45', '390-560', 'item_number', 'summa', 'S Class 2 / 3 T-Series, F-Series', 'T-Series Tangential; F-Series Tangential Module', null, false, null),
  ('EDG-GRP-CB09-45', 'CB09U', 'item_number', 'graphtec', 'CE6000, CE7000, CE8000, FC8600, FC9000', 'PHP33-CB09N-HS (blue holder)', null, false, 'This reference is shared by two stated angles. Confirm holder and angle from the packet.'),
  ('EDG-GRP-CB09-60', 'CB09U', 'item_number', 'graphtec', 'CE6000, CE7000, CE8000, FC8600, FC9000', 'PHP33-CB09N-HS (blue holder)', null, false, 'This reference is shared by two stated angles. Confirm holder and angle from the packet.'),
  ('EDG-GRP-CB15-45', 'CB15U', 'item_number', 'graphtec', 'FC8600, FC9000, CE7000, CE8000', 'PHP33-CB15N-HS (red holder)', null, false, 'This reference is shared by two stated angles. Confirm holder and angle from the packet.'),
  ('EDG-GRP-CB15-60', 'CB15U', 'item_number', 'graphtec', 'FC8600, FC9000, CE7000, CE8000', 'PHP33-CB15N-HS (red holder)', null, false, 'This reference is shared by two stated angles. Confirm holder and angle from the packet.')
)
insert into public.compatibility (variant_id, code, code_kind, brand, machine, tool, adapter, evidence_source, evidence_note)
select v.id, d.code, d.code_kind::public.compatibility_code_kind, d.brand, d.machine, d.tool, d.adapter,
  case when d.legacy then 'PRD Appendix A working list (unverified)'
       else 'Owner-supplied specifications (2026-11-21; unverified)' end,
  d.evidence_note
from data d
join public.variants v on v.sku = d.sku
on conflict (variant_id, code_normalised) do nothing;
