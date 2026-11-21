create table private.catalogue_sync_baselines (
  kind text not null check (kind in ('family', 'variant')),
  row_id uuid not null,
  snapshot jsonb not null,
  primary key (kind, row_id)
);

alter table private.catalogue_sync_baselines enable row level security;
revoke all on private.catalogue_sync_baselines from public, anon, authenticated, service_role;
