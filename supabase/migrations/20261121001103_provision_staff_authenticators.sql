create table private.staff_authenticators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  factor_id uuid not null unique references auth.mfa_factors(id) on delete cascade
);

alter table private.staff_authenticators enable row level security;
revoke all on private.staff_authenticators from public, anon, authenticated, service_role;

create function private.staff_session_factor()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select f.id
  from auth.sessions s
  join auth.mfa_factors f on f.id = s.factor_id and f.user_id = s.user_id
  where s.id = (auth.jwt()->>'session_id')::uuid
    and s.user_id = auth.uid()
    and s.aal = 'aal2' and auth.jwt()->>'aal' = 'aal2'
    and (s.not_after is null or s.not_after > now())
    and (auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb
    and f.factor_type = 'totp' and f.status = 'verified';
$$;

create or replace function private.has_staff_role(variadic p_roles public.staff_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_members m
    join private.staff_authenticators a on a.user_id = m.user_id
    where m.user_id = auth.uid() and m.role = any(p_roles)
      and a.factor_id = (select private.staff_session_factor())
  );
$$;

create function public.get_staff_authenticator()
returns table (approved_factor_id uuid, session_factor_id uuid)
language sql stable security definer set search_path = ''
as $$
  select a.factor_id, private.staff_session_factor()
  from (select auth.uid() as user_id) u
  left join private.staff_authenticators a using (user_id)
  where (auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb
    and exists (select 1 from public.staff_members m where m.user_id = u.user_id);
$$;

create function public.activate_staff_authenticator(p_user_id uuid, p_factor_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.staff_members where user_id = p_user_id for key share;
  if not found then
    raise exception using errcode = '22023', message = 'staff_membership_required';
  end if;
  perform 1 from auth.mfa_factors
  where id = p_factor_id and user_id = p_user_id and factor_type = 'totp' and status = 'verified'
  for share;
  if not found then
    raise exception using errcode = '22023', message = 'verified_staff_factor_required';
  end if;
  insert into private.staff_authenticators (user_id, factor_id)
  values (p_user_id, p_factor_id)
  on conflict (user_id) do update set factor_id = excluded.factor_id;
end;
$$;

revoke all on function private.staff_session_factor(), public.get_staff_authenticator(),
  public.activate_staff_authenticator(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_staff_authenticator() to authenticated;
grant execute on function public.activate_staff_authenticator(uuid, uuid) to service_role;
