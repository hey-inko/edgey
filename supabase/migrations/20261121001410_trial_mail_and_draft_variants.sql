create function public.admin_trial_mail_status(p_trial_request_id uuid)
returns table (message_key text, status text, sent_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.has_staff_role('warehouse', 'catalogue') then
    raise exception using errcode = '42501', message = 'request_staff_role_required';
  end if;
  return query select o.message_key,
    case
      when o.state = 'sent' then 'sent'
      when o.state = 'failed' and o.delivery_uncertain then 'unconfirmed'
      when o.state = 'failed' and o.last_error = 'trial_approval_withdrawn' then 'withdrawn'
      when o.state = 'failed' then 'failed'
      when o.lease_until > statement_timestamp() then 'sending'
      when o.attempt_count > 0 then 'retrying'
      else 'queued'
    end, o.sent_at
  from public.order_outbox o
  where o.trial_request_id = p_trial_request_id
    and o.message_key in ('confirmation', 'staff_notification', 'trial_approved', 'trial_declined', 'trial_dispatched');
end;
$$;

create function public.admin_create_draft_variant(
  p_product_id uuid, p_sku text, p_option_label text, p_price_1_4 integer, p_price_5_9 integer, p_price_10_plus integer
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare result uuid;
begin
  if not private.has_staff_role('catalogue') then
    raise exception using errcode = '42501', message = 'catalogue_role_required';
  end if;
  if p_sku is null or p_sku !~ '^EDG-[A-Z0-9]+(-[A-Z0-9]+)*$' or length(p_sku) > 80
    or length(btrim(p_option_label)) > 160 or p_option_label ~ '[[:cntrl:]]'
    or coalesce(p_price_10_plus, 0) < 1 or p_price_5_9 is null or p_price_1_4 is null
    or p_price_5_9 < p_price_10_plus or p_price_1_4 < p_price_5_9 then
    raise exception using errcode = '22023', message = 'invalid_draft_variant';
  end if;
  insert into public.variants (product_id, sku, option_label, price_1_4_pence, price_5_9_pence, price_10_plus_pence)
  values (p_product_id, p_sku, nullif(btrim(p_option_label), ''), p_price_1_4, p_price_5_9, p_price_10_plus)
  returning id into result;
  return result;
end;
$$;

revoke all on function public.admin_trial_mail_status(uuid),
  public.admin_create_draft_variant(uuid, text, text, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_trial_mail_status(uuid),
  public.admin_create_draft_variant(uuid, text, text, integer, integer, integer) to authenticated;
