-- 088 - Fix ambiguous Premium entitlement upsert conflict target
-- The admin RPC returns a column named user_id, so PL/pgSQL can treat
-- "on conflict (user_id, product_key)" as ambiguous. Use the named
-- unique constraint instead.

create or replace function public.admin_set_portal_premium_entitlement(
  p_user_id uuid,
  p_product_key text,
  p_enabled boolean default true,
  p_note text default null
)
returns table (
  user_id uuid,
  product_key text,
  portal_free_group text,
  entitlement_status text,
  portal_plan text,
  portal_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_old_plan text;
  v_old_status text;
  v_new_status text;
  v_key text := lower(trim(coalesce(p_product_key, '')));
  v_product public.portal_premium_products%rowtype;
  v_action text;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'admin'
  ) then
    raise exception 'admin_required';
  end if;

  select p.portal_plan, p.portal_status
  into v_old_plan, v_old_status
  from public.profiles p
  where p.id = p_user_id
    and p.role = 'student';

  if not found then
    raise exception 'student_not_found';
  end if;

  select *
  into v_product
  from public.portal_premium_products p
  where p.product_key = v_key;

  if not found then
    raise exception 'product_not_found';
  end if;

  if coalesce(p_enabled, false) then
    v_new_status := 'active';

    update public.profiles p
    set portal_plan = 'free',
        portal_status = v_new_status
    where p.id = p_user_id
      and p.role = 'student';

    insert into public.portal_premium_entitlements (
      user_id,
      product_key,
      portal_free_group,
      source_order_id,
      status,
      activated_at,
      expires_at
    )
    values (
      p_user_id,
      v_product.product_key,
      v_product.portal_free_group,
      null,
      'active',
      now(),
      null
    )
    on conflict on constraint portal_premium_entitlements_user_product_uidx
    do update set
      portal_free_group = excluded.portal_free_group,
      status = 'active',
      expires_at = null,
      updated_at = now();

    v_action := 'admin_grant_premium_product';
  else
    v_new_status := case
      when v_old_status in ('pending', 'blocked') then v_old_status
      else 'active'
    end;

    update public.profiles p
    set portal_plan = 'free',
        portal_status = v_new_status
    where p.id = p_user_id
      and p.role = 'student';

    update public.portal_premium_entitlements pe
    set status = 'revoked',
        expires_at = coalesce(pe.expires_at, now()),
        updated_at = now()
    where pe.user_id = p_user_id
      and pe.product_key = v_product.product_key;

    v_action := 'admin_revoke_premium_product';
  end if;

  insert into public.portal_account_audit (
    actor_id,
    target_user_id,
    action,
    old_portal_plan,
    new_portal_plan,
    old_portal_status,
    new_portal_status,
    note
  )
  values (
    v_actor,
    p_user_id,
    v_action,
    v_old_plan,
    'free',
    v_old_status,
    v_new_status,
    nullif(trim(concat_ws(
      ' - ',
      nullif(trim(coalesce(p_note, '')), ''),
      'product_key=' || v_product.product_key,
      coalesce(v_product.title, '')
    )), '')
  );

  return query
  select
    p_user_id,
    v_product.product_key,
    v_product.portal_free_group,
    case when coalesce(p_enabled, false) then 'active' else 'revoked' end,
    'free'::text,
    v_new_status;
end;
$$;

grant execute on function public.admin_set_portal_premium_entitlement(uuid, text, boolean, text) to authenticated;
