-- 068 - Use a student's prepaid balance to clear debt in any class before
-- keeping it as surplus. This covers manual bank reconciliation where the
-- selected class has surplus but an older class still has unpaid attendance.

create or replace function public.fn_apply_student_prepaid_to_pending_debts(
  p_student_id uuid,
  p_bank_transaction_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
  v_prepaid_total int := 0;
  v_fee int := 0;
  v_pending int := 0;
  v_sessions int := 0;
  v_amount int := 0;
  v_total_sessions int := 0;
  v_total_amount int := 0;
  v_source record;
  v_class record;
  v_take int := 0;
  v_remain int := 0;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  if p_student_id is null then
    return jsonb_build_object('ok', false, 'reason', 'STUDENT_REQUIRED');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_student_id::text), hashtext('apply_prepaid_cross_class'));

  for v_class in
    with classes as (
      select nullif(btrim(s.class_name), '') as class_name
      from public.students s
      where s.id = p_student_id
      union
      select nullif(btrim(u.cn), '') as class_name
      from public.students s,
      lateral unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
      where s.id = p_student_id
      union
      select distinct nullif(btrim(a.class_name), '') as class_name
      from public.attendance a
      where a.student_id = p_student_id
        and a.status = 'present'
      union
      select nullif(btrim(stc.class_name), '') as class_name
      from public.student_tuition_by_class stc
      where stc.student_id = p_student_id
    )
    select distinct class_name
    from classes
    where class_name is not null and class_name <> ''
    order by class_name
  loop
    select coalesce(sum(greatest(0, coalesce(stc.prepaid_balance_vnd, 0))), 0)::int
    into v_prepaid_total
    from public.student_tuition_by_class stc
    where stc.student_id = p_student_id;

    exit when v_prepaid_total < 1;

    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where public.normalize_lookup_text(coalesce(cf.class_name, '')) =
          public.normalize_lookup_text(v_class.class_name)
    order by length(cf.class_name) desc, cf.class_name
    limit 1;

    if coalesce(v_fee, 0) <= 0 then
      continue;
    end if;

    v_pending := coalesce(public.fn_pending_sessions_for_class(p_student_id, v_class.class_name), 0);
    if v_pending < 1 then
      continue;
    end if;

    v_sessions := least(v_pending, floor(v_prepaid_total::numeric / v_fee::numeric)::int);
    if v_sessions < 1 then
      continue;
    end if;

    v_amount := v_sessions * v_fee;

    insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
    values (p_student_id, v_class.class_name, v_sessions, 0)
    on conflict (student_id, class_name)
    do update set
      charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
      updated_at = now();

    v_remain := v_amount;
    for v_source in
      select stc.class_name, coalesce(stc.prepaid_balance_vnd, 0) as bal
      from public.student_tuition_by_class stc
      where stc.student_id = p_student_id
        and coalesce(stc.prepaid_balance_vnd, 0) > 0
      order by
        case when public.normalize_lookup_text(stc.class_name) = public.normalize_lookup_text(v_class.class_name) then 0 else 1 end,
        stc.prepaid_balance_vnd desc,
        stc.class_name
    loop
      exit when v_remain < 1;
      v_take := least(v_source.bal, v_remain);
      update public.student_tuition_by_class stc
      set prepaid_balance_vnd = greatest(0, coalesce(stc.prepaid_balance_vnd, 0) - v_take),
          updated_at = now()
      where stc.student_id = p_student_id
        and stc.class_name = v_source.class_name;
      v_remain := v_remain - v_take;
    end loop;

    if v_remain > 0 then
      raise warning 'fn_apply_student_prepaid_to_pending_debts: % VND not deducted for student %',
        v_remain, p_student_id;
    end if;

    insert into public.payment_history(
      student_id,
      sessions_paid,
      sessions_applied_to_charged,
      amount_vnd,
      prepaid_topup_vnd,
      paid_at,
      payment_channel,
      class_name,
      reconcile_note,
      bank_transaction_id
    )
    values (
      p_student_id,
      v_sessions,
      v_sessions,
      v_amount,
      0,
      now(),
      'prepaid_auto',
      v_class.class_name,
      'Tự động: dùng học phí dư để trừ nợ lớp cũ',
      p_bank_transaction_id
    );

    v_total_sessions := v_total_sessions + v_sessions;
    v_total_amount := v_total_amount + v_amount;
  end loop;

  perform public.fn_sync_student_tuition_total(p_student_id);

  if p_bank_transaction_id is not null and v_total_sessions > 0 then
    update public.bank_transactions bt
    set
      matched_class_name = (
        select string_agg(distinct ph.class_name, ', ' order by ph.class_name)
        from public.payment_history ph
        where coalesce(ph.bank_transaction_id, 0) = p_bank_transaction_id
          and public.payment_history_student_id_to_uuid(ph.student_id::text) = p_student_id
          and nullif(btrim(coalesce(ph.class_name, '')), '') is not null
      ),
      applied_sessions = (
        select coalesce(sum(coalesce(ph.sessions_applied_to_charged, ph.sessions_paid, 0)), 0)::integer
        from public.payment_history ph
        where coalesce(ph.bank_transaction_id, 0) = p_bank_transaction_id
          and public.payment_history_student_id_to_uuid(ph.student_id::text) = p_student_id
      ),
      reconcile_note = 'Đối soát tay: đã dùng học phí dư để trừ nợ lớp cũ trước khi giữ phần dư',
      error_note = null
    where bt.id = p_bank_transaction_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'student_id', p_student_id,
    'applied_sessions', v_total_sessions,
    'applied_amount_vnd', v_total_amount
  );
end $$;

grant execute on function public.fn_apply_student_prepaid_to_pending_debts(uuid, bigint) to service_role;
grant execute on function public.fn_apply_student_prepaid_to_pending_debts(uuid, bigint) to authenticated;
