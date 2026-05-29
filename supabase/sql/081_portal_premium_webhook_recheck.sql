-- 081 - Premium payment webhook compatibility and delayed webhook recovery

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.fn_try_apply_portal_premium_order(bigint)'::regprocedure)
  into v_def;

  if v_def is null then
    raise exception 'fn_try_apply_portal_premium_order(bigint) not found';
  end if;

  if position('if coalesce(v_txn.occurred_at, now()) > v_order.expires_at then' in v_def) > 0 then
    -- Already patched.
  elsif position('if v_order.expires_at <= now() then' in v_def) = 0 then
    raise exception 'Expected premium expiry guard was not found';
  else
    v_def := replace(
      v_def,
      'if v_order.expires_at <= now() then',
      'if coalesce(v_txn.occurred_at, now()) > v_order.expires_at then'
    );

    execute v_def;
  end if;
end $$;

create or replace function public.recheck_portal_premium_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.portal_premium_orders%rowtype;
  v_txn_id bigint := null;
  v_result jsonb := null;
begin
  if p_order_id is null then
    return jsonb_build_object('ok', false, 'reason', 'ORDER_ID_REQUIRED');
  end if;

  select *
  into v_order
  from public.portal_premium_orders o
  where o.id = p_order_id
    and (
      o.user_id = auth.uid()
      or exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.role in ('admin', 'teacher')
      )
    )
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'ORDER_NOT_FOUND');
  end if;

  if v_order.status <> 'pending' then
    return jsonb_build_object(
      'ok', true,
      'reason', 'ORDER_NOT_PENDING',
      'status', v_order.status,
      'order_id', v_order.id
    );
  end if;

  select bt.id
  into v_txn_id
  from public.bank_transactions bt
  where bt.amount_vnd = v_order.amount_vnd
    and upper(coalesce(bt.transfer_content, '')) like '%' || upper(v_order.ref_code) || '%'
    and coalesce(bt.status, '') <> 'manual_not_received'
  order by
    case when bt.status = 'pending' then 0 else 1 end,
    bt.created_at desc
  limit 1;

  if v_txn_id is null then
    return jsonb_build_object(
      'ok', true,
      'matched', false,
      'reason', 'BANK_TRANSACTION_NOT_FOUND',
      'order_id', v_order.id,
      'status', v_order.status
    );
  end if;

  v_result := public.fn_auto_apply_bank_transaction(v_txn_id);
  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'order_id', v_order.id,
    'txn_id', v_txn_id,
    'rechecked', true
  );
end;
$$;

grant execute on function public.recheck_portal_premium_order(uuid) to authenticated;
grant execute on function public.recheck_portal_premium_order(uuid) to service_role;
