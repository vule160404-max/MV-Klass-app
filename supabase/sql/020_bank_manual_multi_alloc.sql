-- =============================================================================
-- 020 — Đối soát tay một giao dịch CK cho nhiều học viên (nhiều dòng lớp/buổi).
-- Tổng (buổi × học phí/lớp) phải khớp chính xác amount_vnd của bank_transactions.
-- =============================================================================

create or replace function public.fn_manual_confirm_bank_transaction_multi(
  p_txn_id bigint,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
  v_txn public.bank_transactions%rowtype;
  v_sid uuid;
  v_class text;
  v_sess int;
  v_fee int;
  v_pending int;
  v_apply int;
  v_line_amt int;
  v_sum int := 0;
  v_sum_sess int := 0;
  v_ph public.payment_history%rowtype;
  v_sync_sid uuid := null;
  v_first_payment_id bigint := null;
  v_last_payment_id bigint := null;
  v_line_count int := 0;
  v_undo_students uuid[] := '{}'::uuid[];
  v_u uuid;
  v_line_el jsonb;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    return jsonb_build_object('ok', false, 'reason', 'LINES_REQUIRED');
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TXN_NOT_FOUND');
  end if;

  if v_txn.status = 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_APPLIED');
  end if;

  if coalesce(v_txn.amount_vnd, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_AMOUNT');
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
      set charged_sessions = greatest(coalesce(stc.charged_sessions, 0) - coalesce(v_ph.sessions_paid, 0), 0)
      where stc.student_id = v_ph.student_id::uuid
        and stc.class_name = v_ph.class_name;
    end if;
    delete from public.payment_history where id = v_ph.id;
  end loop;

  foreach v_u in array coalesce(v_undo_students, '{}'::uuid[])
  loop
    if v_u is not null then
      perform public.fn_sync_student_tuition_total(v_u);
    end if;
  end loop;

  -- Pass 1: validate + tính tổng tiền
  for v_line_el in select value from jsonb_array_elements(p_lines) as t(value)
  loop
    v_line_count := v_line_count + 1;
    begin
      v_sid := (v_line_el->>'student_id')::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'reason', 'INVALID_STUDENT_ID', 'line', v_line_count);
    end;
    v_class := btrim(coalesce(v_line_el->>'class_name', ''));
    if v_class = '' then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_REQUIRED', 'line', v_line_count);
    end if;
    v_sess := floor(coalesce(nullif(v_line_el->>'sessions', '')::numeric, 0))::integer;
    if v_sess < 1 then
      return jsonb_build_object('ok', false, 'reason', 'SESSIONS_INVALID', 'line', v_line_count);
    end if;

    if not (
      exists (
        select 1
        from public.students s
        where s.id = v_sid
          and (
            s.class_name = v_class
            or v_class = any(coalesce(s.class_names, '{}'::text[]))
          )
      )
      or public.fn_pending_sessions_for_class(v_sid, v_class) > 0
    ) then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_NOT_ASSIGNED_TO_STUDENT', 'line', v_line_count);
    end if;

    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where cf.class_name = v_class
    limit 1;
    if v_fee <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_FEE_NOT_FOUND', 'line', v_line_count);
    end if;

    v_pending := public.fn_pending_sessions_for_class(v_sid, v_class);
    if v_sess > v_pending then
      return jsonb_build_object('ok', false, 'reason', 'EXCEEDS_PENDING', 'line', v_line_count);
    end if;

    v_line_amt := v_sess * v_fee;
    v_sum := v_sum + v_line_amt;
    v_sum_sess := v_sum_sess + v_sess;
  end loop;

  if v_sum <> v_txn.amount_vnd then
    return jsonb_build_object(
      'ok', false,
      'reason', 'AMOUNT_MISMATCH',
      'expected_vnd', v_txn.amount_vnd,
      'computed_vnd', v_sum
    );
  end if;

  -- Pass 2: ghi học phí + payment_history
  for v_line_el in select value from jsonb_array_elements(p_lines) as t(value)
  loop
    v_sid := (v_line_el->>'student_id')::uuid;
    v_class := btrim(coalesce(v_line_el->>'class_name', ''));
    v_sess := floor(coalesce(nullif(v_line_el->>'sessions', '')::numeric, 0))::integer;
    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where cf.class_name = v_class
    limit 1;
    v_line_amt := v_sess * v_fee;

    insert into public.student_tuition_by_class(student_id, class_name, charged_sessions)
    values (v_sid, v_class, v_sess)
    on conflict (student_id, class_name)
    do update set charged_sessions = public.student_tuition_by_class.charged_sessions + excluded.charged_sessions;

    insert into public.payment_history(
      student_id,
      sessions_paid,
      amount_vnd,
      paid_at,
      payment_channel,
      class_name,
      reconcile_note,
      bank_transaction_id
    )
    values (
      v_sid,
      v_sess,
      v_line_amt,
      coalesce(v_txn.occurred_at, now()),
      'transfer_confirm',
      v_class,
      'Đối soát tay (nhiều HV): CK #' || p_txn_id::text,
      v_txn.id
    )
    returning id into v_last_payment_id;

    if v_first_payment_id is null then
      v_first_payment_id := v_last_payment_id;
    end if;

    perform public.fn_sync_student_tuition_total(v_sid);
  end loop;

  update public.bank_transactions
  set
    status = 'manual_received',
    matched_student_id = null,
    matched_class_name = 'Nhiều học viên',
    reconcile_note = 'Đối soát tay: ' || v_line_count::text || ' học viên · ' || v_sum_sess::text || ' buổi',
    extracted_sessions = v_sum_sess,
    applied_sessions = v_sum_sess,
    applied_amount_vnd = v_sum,
    applied_payment_history_id = v_first_payment_id,
    error_note = null
  where id = p_txn_id;

  return jsonb_build_object(
    'ok', true,
    'reason', 'APPLIED_MULTI',
    'txn_id', p_txn_id,
    'lines', v_line_count,
    'sessions', v_sum_sess,
    'amount_vnd', v_sum,
    'payment_history_id', v_first_payment_id
  );
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'EXCEPTION', 'message', sqlerrm);
end;
$$;

grant execute on function public.fn_manual_confirm_bank_transaction_multi(bigint, jsonb) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction_multi(bigint, jsonb) to authenticated;

notify pgrst, 'reload schema';
