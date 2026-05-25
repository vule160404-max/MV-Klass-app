-- 067 - Allow undoing an auto-applied bank transaction from the admin UI.
-- The older manual-confirm RPC rejects status = applied before it reaches its
-- rollback block. This helper performs only the rollback + mark-not-received
-- path, so it cannot create duplicate tuition payments.

create or replace function public.fn_undo_applied_bank_transaction_not_received(
  p_txn_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
  v_txn public.bank_transactions%rowtype;
  v_ph public.payment_history%rowtype;
  v_undo_students uuid[] := '{}'::uuid[];
  v_u uuid;
  v_deleted_count int := 0;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  select * into v_txn
  from public.bank_transactions
  where id = p_txn_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TXN_NOT_FOUND');
  end if;

  select coalesce(array_agg(distinct ph.student_id), '{}')
  into v_undo_students
  from public.payment_history ph
  where coalesce(ph.bank_transaction_id, 0) = v_txn.id;

  for v_ph in
    select *
    from public.payment_history ph
    where coalesce(ph.bank_transaction_id, 0) = v_txn.id
    order by ph.id
    for update
  loop
    if v_ph.class_name is not null and btrim(v_ph.class_name) <> '' then
      update public.student_tuition_by_class stc
      set
        charged_sessions = greatest(
          0,
          coalesce(stc.charged_sessions, 0) - coalesce(v_ph.sessions_applied_to_charged, v_ph.sessions_paid, 0)
        ),
        prepaid_balance_vnd = greatest(
          0,
          coalesce(stc.prepaid_balance_vnd, 0) - coalesce(v_ph.prepaid_topup_vnd, 0)
        ),
        updated_at = now()
      where stc.student_id = v_ph.student_id::uuid
        and stc.class_name = v_ph.class_name;
    end if;

    delete from public.payment_history where id = v_ph.id;
    v_deleted_count := v_deleted_count + 1;
  end loop;

  foreach v_u in array coalesce(v_undo_students, '{}'::uuid[])
  loop
    if v_u is not null then
      perform public.fn_sync_student_tuition_total(v_u);
    end if;
  end loop;

  update public.bank_transactions
  set
    status = 'manual_not_received',
    matched_class_name = null,
    reconcile_note = null,
    extracted_sessions = null,
    applied_sessions = null,
    applied_amount_vnd = null,
    applied_payment_history_id = null,
    error_note = 'Xác nhận thủ công: chưa nhận tiền'
  where id = p_txn_id;

  return jsonb_build_object(
    'ok', true,
    'txn_id', p_txn_id,
    'received', false,
    'undone_payment_rows', v_deleted_count,
    'students_synced', coalesce(array_length(v_undo_students, 1), 0)
  );
end $$;

grant execute on function public.fn_undo_applied_bank_transaction_not_received(bigint) to service_role;
grant execute on function public.fn_undo_applied_bank_transaction_not_received(bigint) to authenticated;
