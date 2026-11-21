create or replace function private.has_staff_role(variadic p_roles public.staff_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.jwt()->>'aal' = 'aal2'
    and (auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb
    and exists (
      select 1 from public.staff_members where user_id = auth.uid() and role = any(p_roles)
    );
$$;

alter table private.trial_order_attributions enable row level security;

revoke execute on function public.fold_text(text), public.normalise_code(text) from public;
grant execute on function public.fold_text(text), public.normalise_code(text) to anon, authenticated, service_role;
revoke execute on function private.touch_updated_at() from public;
