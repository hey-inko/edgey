insert into public.tool_categories (slug, name, sort_order) values ('drag', 'Demo drag', 998);
insert into public.substrates (slug, name, sort_order) values ('foamex', 'Demo Foamex', 999);
insert into public.brands (slug, name) values ('zund', 'Demo Zund');

insert into public.products (family_code, slug, name, tool_category) values
  ('EDG-Z10', 'edg-z10', 'Published demo drag blade', 'drag'),
  ('EDG-Z11', 'edg-z11', 'Untracked draft family', 'drag'),
  ('EDG-SUM-TAN', 'edg-sum-tan', 'Mixed demo and new family', 'drag'),
  ('EDG-OLD', 'edg-old', 'Only in old demo', 'drag'),
  ('EDG-LEGACY', 'edg-z28', 'Unrelated family with a colliding slug', 'drag');

insert into public.variants
  (product_id, sku, price_1_4_pence, price_5_9_pence, price_10_plus_pence, is_staging_fixture,
    publication_status, approved_at, approved_by, supplier_part_number, evidence_source)
select p.id, v.sku, 1440, 1330, 1220, v.demo,
  case when v.demo then 'published'::public.publication_status else 'draft' end,
  case when v.demo then now() end, case when v.demo then 'old fixture' end,
  case when v.demo then 'DEMO-' || v.sku end, case when v.demo then 'Old demo listing' end
from (values ('EDG-Z10', 'EDG-Z10', true), ('EDG-Z11', 'EDG-Z11', false),
  ('EDG-SUM-TAN', 'EDG-SUM-TAN-36', true), ('EDG-OLD', 'EDG-OLD', true),
  ('EDG-OLD', 'edg z20', false), ('EDG-OLD', 'EDG-SUM-DRG', false)) v (family_code, sku, demo) join public.products p using (family_code);

select private.apply_stock_movement('receive', 'old-demo-receipt', id, 25, 0)
from public.variants where sku = 'EDG-Z10';

insert into public.compatibility (variant_id, code, code_kind, brand, evidence_source, verification_state, approved_at)
select v.id, c.code, c.kind::public.compatibility_code_kind, 'zund', 'Old demo mapping', 'approved', now()
from (values ('EDG-Z10', 'Z10', 'model'), ('EDG-OLD', '5009802', 'item_number'),
  ('EDG-OLD', 'bld sf217', 'alias'), ('EDG-OLD', 'OLD-DEMO-ALIAS', 'alias'),
  ('EDG-OLD', 'EDGDF113', 'alias'), ('EDG-OLD', 'EDG MIM 45', 'alias')) c (sku, code, kind) join public.variants v using (sku);

insert into public.variant_substrates (variant_id, substrate)
select id, 'foamex' from public.variants where sku in ('EDG-Z10', 'EDG-OLD');

insert into auth.users (id, email) values (gen_random_uuid(), 'staff@example.test');
insert into public.staff_members (user_id, role) select id, 'catalogue' from auth.users where email = 'staff@example.test';

insert into public.orders (checkout_attempt_token, email, business_name, recipient_name,
  buying_for_work, address_line1, address_town, address_postcode, address_country,
  goods_net_pence, delivery_net_pence, vat_rate_bps, vat_pence, gross_pence, hold_expires_at,
  delivery_service, promised_dispatch_date, estimated_delivery_date, fulfilment_status)
values (gen_random_uuid(), 'older-order@example.test', 'Demo buyer', 'Demo recipient', true,
  '1 Test Lane', 'London', 'SW9 9ZZ', 'GB', 1440, 0, 2000, 288, 1728, now(),
  'Test service', current_date, current_date, 'cancelled');

insert into public.order_items
  (order_id, variant_id, sku, option_label, quantity, unit_price_pence, net_pence, tax_pence, gross_pence)
select o.id, v.id, v.sku, 'Old demo option', 1, 1440, 1440, 288, 1728
from public.orders o cross join public.variants v
where o.email = 'older-order@example.test' and v.sku = 'EDG-Z10';

insert into public.trial_requests (id, machine_brand, oem_code, email, company, postcode)
values (gen_random_uuid(), 'Test machine', 'Z10', 'old-trial@example.test', 'Trial company', 'SW9 9ZZ');
insert into public.enquiries (id, kind, email, query, message)
values (gen_random_uuid(), 'compatibility', 'old-enquiry@example.test', 'Z10', 'Which blade fits?');
insert into public.staff_variant_costs (variant_id, supplier_unit_minor, currency, landed_unit_pence, actor_id, recorded_at)
select v.id, 400, 'USD', 510, s.user_id, now() from public.variants v cross join public.staff_members s
where v.sku = 'EDG-Z10';
