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
