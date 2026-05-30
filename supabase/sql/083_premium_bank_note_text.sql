-- 083 - Clean Premium bank reconciliation wording

create or replace function public.portal_premium_bank_note(
  p_product_title text,
  p_product_key text,
  p_ref_code text
)
returns text
language sql
immutable
as $$
  select
    'Đăng ký ' ||
    case
      when lower(coalesce(p_product_key, '') || ' ' || coalesce(p_product_title, '')) ~ 'entrance_10|vào[[:space:]]*10|vao[[:space:]]*10'
        then 'gói Premium Vào 10 Tiếng Anh'
      when lower(coalesce(p_product_key, '') || ' ' || coalesce(p_product_title, '')) ~ 'university|thpt|qg'
        then 'gói Premium THPT QG Tiếng Anh'
      when nullif(trim(coalesce(p_product_title, '')), '') is not null
        then 'gói Premium ' || regexp_replace(trim(p_product_title), '^gói[[:space:]]+', '', 'i')
      else 'gói Premium'
    end ||
    case
      when nullif(trim(coalesce(p_ref_code, '')), '') is not null
        then ' · Mã đơn ' || upper(trim(p_ref_code))
      else ''
    end
$$;

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.fn_try_apply_portal_premium_order(bigint)'::regprocedure)
  into v_def;

  if v_def is null then
    raise exception 'fn_try_apply_portal_premium_order(bigint) not found';
  end if;

  v_next := v_def;
  v_next := replace(
    v_next,
    '''Auto Premium: '' || coalesce(v_product.title, v_order.product_key) || '' / REF '' || v_ref_code',
    'public.portal_premium_bank_note(v_product.title, v_order.product_key, v_ref_code)'
  );
  v_next := replace(
    v_next,
    '''Auto Premium: '' || coalesce(v_product.title, v_order.product_key) || '' / REF '' || v_order.ref_code',
    'public.portal_premium_bank_note(v_product.title, v_order.product_key, v_order.ref_code)'
  );

  if v_next is distinct from v_def then
    execute v_next;
  end if;
end $$;

update public.bank_transactions bt
set reconcile_note = public.portal_premium_bank_note(p.title, o.product_key, o.ref_code),
    matched_class_name = coalesce(p.title, bt.matched_class_name)
from public.portal_premium_orders o
left join public.portal_premium_products p on p.product_key = o.product_key
where bt.portal_premium_order_id = o.id
  and (
    bt.payment_kind = 'premium'
    or bt.match_method like 'premium_ref%'
    or coalesce(bt.reconcile_note, '') like 'Auto Premium:%'
  );

update public.portal_account_audit a
set note = public.portal_premium_bank_note(p.title, o.product_key, o.ref_code)
from public.portal_premium_orders o
left join public.portal_premium_products p on p.product_key = o.product_key
where a.action = 'premium_payment_activated'
  and a.target_user_id = o.user_id
  and coalesce(a.note, '') like 'Auto Premium:%'
  and coalesce(a.note, '') like '%' || o.ref_code || '%';
