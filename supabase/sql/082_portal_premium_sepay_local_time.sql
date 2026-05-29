-- 082 - Treat SePay transactionDate as Vietnam local time for Premium expiry checks

do $$
declare
  v_def text;
  v_old text := 'if coalesce(v_txn.occurred_at, now()) > v_order.expires_at then';
  v_new text := 'if (case when v_txn.occurred_at is not null and v_txn.created_at is not null and v_txn.occurred_at > v_txn.created_at + interval ''1 hour'' then v_txn.occurred_at - interval ''7 hours'' else coalesce(v_txn.occurred_at, now()) end) > v_order.expires_at then';
begin
  select pg_get_functiondef('public.fn_try_apply_portal_premium_order(bigint)'::regprocedure)
  into v_def;

  if v_def is null then
    raise exception 'fn_try_apply_portal_premium_order(bigint) not found';
  end if;

  if position(v_new in v_def) > 0 then
    -- Already patched.
  elsif position(v_old in v_def) > 0 then
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  else
    raise exception 'Expected premium expiry guard was not found';
  end if;
end $$;

with recover as (
  update public.portal_premium_orders o
  set status = 'pending',
      review_note = null
  from public.bank_transactions bt
  where bt.portal_premium_order_id = o.id
    and o.status = 'expired'
    and bt.payment_kind = 'premium'
    and bt.match_method = 'premium_ref_expired'
    and bt.amount_vnd = o.amount_vnd
    and upper(coalesce(bt.transfer_content, '')) like '%' || upper(o.ref_code) || '%'
    and (
      case
        when bt.occurred_at is not null
          and bt.created_at is not null
          and bt.occurred_at > bt.created_at + interval '1 hour'
          then bt.occurred_at - interval '7 hours'
        else coalesce(bt.occurred_at, bt.created_at, now())
      end
    ) <= o.expires_at
  returning bt.id
)
select public.fn_auto_apply_bank_transaction(id)
from recover;
