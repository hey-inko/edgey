-- Catalogue seed: the 23 proposed families in PRD Appendix A.
-- Every variant is imported as draft with zero stock. Reference codes are
-- unverified candidates: a listed OEM identity tells the catalogue owner which
-- original to check and does not establish an Edgey fit.
-- For local development and testing only. Do not run against a live project.
-- Repeatable: run it again and descriptive data and prices are refreshed while
-- publication status, approvals and stock are left alone.

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
  ('stencil-film', 'Stencil film', null, 220)
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
  ('EDG-Z11', 'edg-z11', 'Tight-corner drag blade', 'drag', 'Steeper drag blade for carton, thin plastics and tight corners.', '{}', 20),
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
  ('EDG-Z2', 'edg-z2', 'Steep kiss-cut blade', 'kiss-cut', 'Steeper kiss-cut blade for thick vinyl, reflective film and small lettering.', '{}', 130),
  ('EDG-SR6223', 'edg-sr6223', 'Round-shank blade', 'oscillating', 'Round-shank oscillating blade for corrugated, Correx and thin Foamex.', '{"drawing": "cylinder-line.svg", "photo": "cylinder.webp", "proof": "lime"}', 41),
  ('EDG-SR6224', 'edg-sr6224', 'Reinforced round-shank blade', 'oscillating', 'Reinforced round-shank blade for high-recycled corrugated and heavy display board.', '{}', 150),
  ('EDG-SR6310', 'edg-sr6310', 'Long-reach round-shank blade', 'oscillating', 'Round-shank blade for triple-wall corrugated, honeycomb and Re-board.', '{}', 160),
  ('EDG-SR6315', 'edg-sr6315', 'Slender round-shank blade', 'oscillating', 'Slender round-shank blade for soft foam board and tight curves.', '{}', 170),
  ('EDG-HTR040', 'edg-htr040', 'Circular rotary blade', 'rotary', 'Circular rotary blade for textiles, flag fabric and soft signage.', '{}', 180),
  ('EDG-MIM-45', 'edg-mim-45', 'Mimaki-pattern plotter blade', 'roll-plotter', 'Roll-plotter blade for cast and calendered vinyl, reflective film and flock.', '{}', 190),
  ('EDG-ROL-45', 'edg-rol-45', 'Roland-pattern plotter blade', 'roll-plotter', 'Roll-plotter blade for standard vinyl, sandblast and heat-transfer film.', '{}', 200),
  ('EDG-SUM-DRG', 'edg-sum-drg', 'Summa-pattern drag plotter blade', 'roll-plotter', 'Drag blade for roll plotters cutting vinyl, thick laminate and reflective film.', '{}', 210),
  ('EDG-SUM-TAN', 'edg-sum-tan', 'Tangential plotter blade', 'tangential', 'Tangential blade for heavy vinyl and high-speed lettering.', '{}', 220),
  ('EDG-GRP-CB', 'edg-grp-cb', 'Graphtec-pattern plotter blade', 'roll-plotter', 'Roll-plotter blade for vinyl, stencil film and flock.', '{}', 230)
on conflict (family_code) do update set
  slug = excluded.slug, name = excluded.name, tool_category = excluded.tool_category,
  description = excluded.description, media = excluded.media, sort_order = excluded.sort_order
where not exists (
  select 1 from public.variants v
  where v.product_id = products.id and v.publication_status <> 'draft'
);

-- Variants. A single-variant family reuses its family code as the SKU. Families
-- whose label lists several angles or holders get one draft SKU per option.
-- Dimensions are the buying team's working values from Appendix A.
with data (sku, family_code, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm, diameter_mm, p1, p2, p3, sort_order) as (
  values
  ('EDG-Z10', 'EDG-Z10', null, 'UCT', 50, null, null, null, null, 2250, 1995, 1750, 0),
  ('EDG-Z11', 'EDG-Z11', null, 'UCT', 60, null, null, null, null, 2250, 1995, 1750, 0),
  ('EDG-Z46', 'EDG-Z46', null, 'UCT', 45, null, 20, null, null, 3650, 3250, 2850, 0),
  ('EDG-Z16', 'EDG-Z16', null, 'EOT', null, null, null, null, null, 2150, 1850, 1595, 0),
  ('EDG-Z17', 'EDG-Z17', null, 'EOT', null, null, null, null, null, 2150, 1850, 1595, 0),
  ('EDG-Z20', 'EDG-Z20', null, 'EOT', null, null, 14, 0.63, null, 2350, 2050, 1800, 0),
  ('EDG-Z21', 'EDG-Z21', null, 'EOT', null, null, 17, 0.63, null, 2450, 2150, 1895, 0),
  ('EDG-Z28', 'EDG-Z28', null, 'EOT', null, null, 26, null, null, 3150, 2750, 2450, 0),
  ('EDG-Z71', 'EDG-Z71', null, 'VCT', null, null, null, null, null, 3450, 3050, 2700, 0),
  ('EDG-Z50', 'EDG-Z50', null, null, null, null, null, null, 25, 3800, 3400, 3000, 0),
  ('EDG-Z52', 'EDG-Z52', null, null, null, null, null, null, 32, 4400, 3900, 3500, 0),
  ('EDG-Z1', 'EDG-Z1', null, 'KCT', 45, null, null, null, null, 995, 850, 750, 0),
  ('EDG-Z2', 'EDG-Z2', null, 'KCT', 60, null, null, null, null, 995, 850, 750, 0),
  ('EDG-SR6223', 'EDG-SR6223', null, null, null, 6, 12, null, null, 2550, 2250, 1995, 0),
  ('EDG-SR6224', 'EDG-SR6224', null, null, null, 6, 12, null, null, 2650, 2350, 2095, 0),
  ('EDG-SR6310', 'EDG-SR6310', null, null, null, 6, null, null, null, 3050, 2700, 2400, 0),
  ('EDG-SR6315', 'EDG-SR6315', null, null, null, 6, 14, null, null, 2850, 2500, 2200, 0),
  ('EDG-HTR040', 'EDG-HTR040', null, null, null, null, null, null, 40, 3950, 3500, 3100, 0),
  ('EDG-MIM-A30', 'EDG-MIM-45', '30°', null, 30, null, null, null, null, 1195, 900, 750, 10),
  ('EDG-MIM-A45', 'EDG-MIM-45', '45°', null, 45, null, null, null, null, 1195, 900, 750, 20),
  ('EDG-MIM-A60', 'EDG-MIM-45', '60°', null, 60, null, null, null, null, 1195, 900, 750, 30),
  ('EDG-ROL-A30', 'EDG-ROL-45', '30°', null, 30, null, null, null, null, 1150, 850, 700, 10),
  ('EDG-ROL-A45', 'EDG-ROL-45', '45°', null, 45, null, null, null, null, 1150, 850, 700, 20),
  ('EDG-ROL-A60', 'EDG-ROL-45', '60°', null, 60, null, null, null, null, 1150, 850, 700, 30),
  ('EDG-SUM-DRG-36', 'EDG-SUM-DRG', '36°', null, 36, null, null, null, null, 1195, 900, 750, 10),
  ('EDG-SUM-DRG-60', 'EDG-SUM-DRG', '60°', null, 60, null, null, null, null, 1195, 900, 750, 20),
  ('EDG-SUM-TAN-36', 'EDG-SUM-TAN', '36°', null, 36, null, null, null, null, 1950, 1700, 1495, 10),
  ('EDG-SUM-TAN-45', 'EDG-SUM-TAN', '45°', null, 45, null, null, null, null, 1950, 1700, 1495, 20),
  ('EDG-GRP-CB09', 'EDG-GRP-CB', 'CB09 holder', 'CB09', null, null, null, null, null, 1195, 900, 750, 10),
  ('EDG-GRP-CB15', 'EDG-GRP-CB', 'CB15 holder', 'CB15', null, null, null, null, null, 1195, 900, 750, 20)
)
insert into public.variants (
  product_id, sku, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm,
  diameter_mm, price_1_4_pence, price_5_9_pence, price_10_plus_pence, sort_order
)
select p.id, d.sku, d.option_label, d.tool, d.angle_deg::numeric, d.shank_mm::numeric, d.cutting_depth_mm::numeric,
  d.blade_thickness_mm::numeric, d.diameter_mm::numeric, d.p1, d.p2, d.p3, d.sort_order
from data d
join public.products p on p.family_code = d.family_code
on conflict (sku) do update set
  product_id = excluded.product_id, option_label = excluded.option_label, tool = excluded.tool,
  angle_deg = excluded.angle_deg, shank_mm = excluded.shank_mm,
  cutting_depth_mm = excluded.cutting_depth_mm, blade_thickness_mm = excluded.blade_thickness_mm,
  diameter_mm = excluded.diameter_mm, price_1_4_pence = excluded.price_1_4_pence,
  price_5_9_pence = excluded.price_5_9_pence, price_10_plus_pence = excluded.price_10_plus_pence,
  sort_order = excluded.sort_order
where variants.publication_status = 'draft';

-- Applications to verify, per family, applied to each of its variants.
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
  ('EDG-GRP-CB', 'vinyl'), ('EDG-GRP-CB', 'stencil-film'), ('EDG-GRP-CB', 'flock')
)
insert into public.variant_substrates (variant_id, substrate)
select v.id, d.substrate
from data d
join public.products p on p.family_code = d.family_code
join public.variants v on v.product_id = p.id
where v.publication_status = 'draft'
on conflict do nothing;

-- Appendix A corrections: 5201345 (Z60) is not a Z71 reference.
-- SR6224 and SR6315 use 42438135 and 42449504, not the earlier unverified codes.
-- SR6310's 20 mm OEM maximum is kept as evidence, not a measurement of the replacement.
-- Reference models and codes to review, all as unverified candidates.
-- Where a family label lists several angles without mapping each code to one,
-- the code is attached to every draft option with a note to map it from the
-- supplier's packet.
with data (sku, code, code_kind, brand, tool, evidence_note, evidence_url) as (
  values
  ('EDG-Z10', 'Z10', 'model', 'zund', 'UCT', 'Reference model from Appendix A.', null),
  ('EDG-Z10', '3910301', 'item_number', 'zund', 'UCT', 'Reference code to review.', null),
  ('EDG-Z10', '500-9802', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z11', 'Z11', 'model', 'zund', 'UCT', 'Reference model from Appendix A.', null),
  ('EDG-Z11', '3910309', 'item_number', 'zund', 'UCT', 'Reference code to review.', null),
  ('EDG-Z11', '500-9803', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z46', 'Z46', 'model', 'zund', 'UCT', 'Reference model from Appendix A.', null),
  ('EDG-Z46', '4800073', 'item_number', 'zund', 'UCT', 'Reference code to review.', null),
  ('EDG-Z46', '500-9807', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z16', 'Z16', 'model', 'zund', 'EOT', 'Reference model from Appendix A.', null),
  ('EDG-Z16', '3910306', 'item_number', 'zund', 'EOT', 'Reference code to review.', null),
  ('EDG-Z16', 'SEF-16', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-Z17', 'Z17', 'model', 'zund', 'EOT', 'Reference model from Appendix A.', null),
  ('EDG-Z17', '3910307', 'item_number', 'zund', 'EOT', 'Reference code to review.', null),
  ('EDG-Z17', 'SEF-17', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-Z20', 'Z20', 'model', 'zund', 'EOT', 'Reference model from Appendix A.', null),
  ('EDG-Z20', '3910313', 'item_number', 'zund', 'EOT', 'Reference code to review.', null),
  ('EDG-Z20', '500-9811', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z21', 'Z21', 'model', 'zund', 'EOT', 'Reference model from Appendix A.', null),
  ('EDG-Z21', '3910314', 'item_number', 'zund', 'EOT', 'Reference code to review.', null),
  ('EDG-Z21', '500-9812', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z28', 'Z28', 'model', 'zund', 'EOT', 'Reference model from Appendix A.', null),
  ('EDG-Z28', '3910318', 'item_number', 'zund', 'EOT', 'Reference code to review.', null),
  ('EDG-Z28', '500-9814', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z71', 'Z71', 'model', 'zund', 'VCT', 'Reference model from Appendix A.', null),
  ('EDG-Z71', '5006045', 'item_number', 'zund', 'VCT', 'Zünd lists 5006045 as the Z71 item. 5201345 is the Z60 and is excluded.', 'https://books.zund.com/catalog-en'),
  ('EDG-Z71', '500-9826', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z50', 'Z50', 'model', 'zund', null, 'Reference model from Appendix A.', null),
  ('EDG-Z50', '3910335', 'item_number', 'zund', null, 'Zünd lists 3910335 for the Z50.', 'https://my.zund.com/en/shop/product/3910335'),
  ('EDG-Z50', '500-9860', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', 'https://www.summa.com/media/jrujznt0/f_series_optionsconsumablesaccessories_eu_rev001_en.pdf'),
  ('EDG-Z50', 'RC110', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-Z52', 'Z52', 'model', 'zund', null, 'Reference model from Appendix A.', null),
  ('EDG-Z52', '3910337', 'item_number', 'zund', null, 'Reference code to review.', null),
  ('EDG-Z52', '500-9862', 'item_number', 'summa', null, 'Proposed Summa F-Series cross-reference. Check against the specific tool.', null),
  ('EDG-Z1', 'Z1', 'model', 'zund', 'KCT', 'Reference model from Appendix A.', null),
  ('EDG-Z1', '3910105', 'item_number', 'zund', 'KCT', 'Zünd lists 3910105 for the Z1.', 'https://books.zund.com/catalog-en'),
  ('EDG-Z1', 'SEK-01', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-Z1', 'KC101', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-Z2', 'Z2', 'model', 'zund', 'KCT', 'Reference model from Appendix A.', null),
  ('EDG-Z2', '3910110', 'item_number', 'zund', 'KCT', 'Zünd lists 3910110 for the Z2.', 'https://books.zund.com/catalog-en'),
  ('EDG-Z2', 'SEK-02', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-Z2', 'KC102', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-SR6223', 'BLD-SR6223', 'model', 'kongsberg', null, 'Reference model from Appendix A.', null),
  ('EDG-SR6223', '42437293', 'item_number', 'kongsberg', null, 'Reference code to review.', null),
  ('EDG-SR6223', 'SER-23', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-SR6224', 'BLD-SR6224', 'model', 'kongsberg', null, 'Reference model from Appendix A.', null),
  ('EDG-SR6224', '42438135', 'item_number', 'kongsberg', null, 'Kongsberg lists 42438135 for BLD-SR6224.', 'https://store.kongsbergsystems.com/cms/delivery/media/MCT7MYITJDOZE3ZEZAE73L6V3OYU'),
  ('EDG-SR6224', 'SER-24', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-SR6310', 'BLD-SR6310', 'model', 'kongsberg', null, 'Reference model from Appendix A.', null),
  ('EDG-SR6310', '42441626', 'item_number', 'kongsberg', null, 'Kongsberg lists 42441626 and a 20 mm maximum for the configuration cited. Publish dimensions for the supplied replacement and its verified tool configuration.', 'https://store.kongsbergsystems.com/cms/delivery/media/MCT7MYITJDOZE3ZEZAE73L6V3OYU'),
  ('EDG-SR6310', 'SER-310', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-SR6315', 'BLD-SR6315', 'model', 'kongsberg', null, 'Reference model from Appendix A.', null),
  ('EDG-SR6315', '42449504', 'item_number', 'kongsberg', null, 'Kongsberg lists 42449504 for BLD-SR6315.', 'https://store.kongsbergsystems.com/cms/delivery/media/MCT7MYITJDOZE3ZEZAE73L6V3OYU'),
  ('EDG-SR6315', 'SER-315', 'alias', null, null, 'Reference code to review. Origin of this code is not recorded.', null),
  ('EDG-HTR040', 'HTR-040', 'model', 'dyss', null, 'Reference model from Appendix A.', null),
  ('EDG-HTR040', 'DYSS-40MM', 'alias', 'dyss', null, 'Reference code to review.', null),
  ('EDG-MIM-A30', 'SPB-0030', 'item_number', 'mimaki', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-MIM-A30', 'MD300V', 'item_number', 'mimaki', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-MIM-A45', 'SPB-0030', 'item_number', 'mimaki', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-MIM-A45', 'MD300V', 'item_number', 'mimaki', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-MIM-A60', 'SPB-0030', 'item_number', 'mimaki', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-MIM-A60', 'MD300V', 'item_number', 'mimaki', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-ROL-A30', 'ZEC-U1005', 'item_number', 'roland', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-ROL-A30', 'ZEC-U5025', 'item_number', 'roland', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-ROL-A45', 'ZEC-U1005', 'item_number', 'roland', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-ROL-A45', 'ZEC-U5025', 'item_number', 'roland', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-ROL-A60', 'ZEC-U1005', 'item_number', 'roland', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-ROL-A60', 'ZEC-U5025', 'item_number', 'roland', null, 'Angle not mapped to this code. Map it from the supplier''s packet.', null),
  ('EDG-SUM-DRG-36', '391-360', 'item_number', 'summa', null, 'Appendix A lists this code at 36°. Summa D/S-Class drag.', null),
  ('EDG-SUM-DRG-60', '391-231', 'item_number', 'summa', null, 'Appendix A lists this code at 60°. Summa D/S-Class drag.', null),
  ('EDG-SUM-TAN-36', '390-534', 'item_number', 'summa', null, 'Appendix A lists this code at 36°. Summa S-Class tangential.', null),
  ('EDG-SUM-TAN-45', '390-560', 'item_number', 'summa', null, 'Appendix A lists this code at 45°. Summa S-Class tangential.', null),
  ('EDG-GRP-CB09', 'CB09UB', 'item_number', 'graphtec', 'CB09', 'Appendix A lists 45°/60°. Confirm holder and angle separately. Keep CB09 and CB15 stock separate.', null),
  ('EDG-GRP-CB15', 'CB15U', 'item_number', 'graphtec', 'CB15', 'Appendix A lists 45°/60°. Confirm holder and angle separately. Keep CB09 and CB15 stock separate.', null)
)
insert into public.compatibility (variant_id, code, code_kind, brand, tool, evidence_source, evidence_note, evidence_url)
select v.id, d.code, d.code_kind::public.compatibility_code_kind, d.brand, d.tool,
  'PRD Appendix A working list (unverified)', d.evidence_note, d.evidence_url
from data d
join public.variants v on v.sku = d.sku
on conflict (variant_id, code_normalised) do nothing;
