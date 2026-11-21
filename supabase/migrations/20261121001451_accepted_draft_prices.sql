update public.variants as v
set price_1_4_pence = prices.tier_one, price_5_9_pence = prices.tier_five, price_10_plus_pence = prices.tier_ten
from (values
  ('EDG-SUM-9802', 2095, 1850, 1595),
  ('EDG-SUM-9803', 2095, 1850, 1595),
  ('EDG-DF113', 2150, 1895, 1650)
) as prices(sku, tier_one, tier_five, tier_ten)
where v.sku = prices.sku and v.publication_status = 'draft'
  and num_nonnulls(v.price_1_4_pence, v.price_5_9_pence, v.price_10_plus_pence) = 0;
