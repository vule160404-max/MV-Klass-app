-- =============================================================================
-- 021 — Học phí trả trước (prepaid): CK / đối soát vượt số buổi nợ hiện tại
--       → ghi khoản dư VND trên student_tuition_by_class; khi có điểm danh
--       (buổi mới còn nợ), tự trừ prepaid để tăng charged_sessions.
-- =============================================================================

alter table public.student_tuition_by_class
  add column if not exists prepaid_balance_vnd integer not null default 0
    check (prepaid_balance_vnd >= 0);

comment on column public.student_tuition_by_class.prepaid_balance_vnd is
  'Số tiền đã thu trước chưa gán vào buổi (đủ học phí/buổi sẽ tự trừ khi có điểm danh).';

alter table public.payment_history
  add column if not exists sessions_applied_to_charged integer;

alter table public.payment_history
  add column if not exists prepaid_topup_vnd integer not null default 0 check (prepaid_topup_vnd >= 0);

comment on column public.payment_history.sessions_applied_to_charged is
  'Số buổi cộng vào charged_sessions ngay khi ghi nhận (≤ sessions_paid). Null = legacy: coi như toàn bộ sessions_paid.';

comment on column public.payment_history.prepaid_topup_vnd is
  'Phần tiền CK ghi vào prepaid_balance_vnd (buổi chưa có điểm danh).';

update public.payment_history
set
  sessions_applied_to_charged = coalesce(sessions_applied_to_charged, sessions_paid),
  prepaid_topup_vnd = coalesce(prepaid_topup_vnd, 0)
where sessions_applied_to_charged is null;

-- -----------------------------------------------------------------------------
-- Trừ prepaid khi có buổi nợ (present > charged), lặp tối đa đến khi hết nợ hoặc hết prepaid.
-- -----------------------------------------------------------------------------
create or replace function public.fn_apply_prepaid_consumption(
  p_student_id uuid,
  p_class_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_raw text := btrim(coalesce(p_class_name, ''));
  v_norm text;
  v_fee integer := 0;
  v_pending integer := 0;
  v_prepaid integer := 0;
  v_stc_class text := '';
  v_iter integer := 0;
begin
  if p_student_id is null or v_class_raw = '' then
    return;
  end if;

  v_norm := public.normalize_lookup_text(v_class_raw);
  if v_norm is null or length(v_norm) < 1 then
    return;
  end if;

  select stc.class_name
  into v_stc_class
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id
    and public.normalize_lookup_text(stc.class_name) = v_norm
  limit 1;

  if v_stc_class is null or btrim(v_stc_class) = '' then
    select cf.class_name
    into v_stc_class
    from public.class_fees cf
    where public.normalize_lookup_text(cf.class_name) = v_norm
    limit 1;
  end if;

  if v_stc_class is null or btrim(v_stc_class) = '' then
    v_stc_class := v_class_raw;
  end if;

  while v_iter < 500 loop
    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where cf.class_name = v_stc_class
    limit 1;

    if v_fee <= 0 then
      exit;
    end if;

    v_pending := public.fn_pending_sessions_for_class(p_student_id, v_stc_class);
    if v_pending < 1 then
      exit;
    end if;

    select coalesce(stc.prepaid_balance_vnd, 0)
    into v_prepaid
    from public.student_tuition_by_class stc
    where stc.student_id = p_student_id
      and stc.class_name = v_stc_class
    limit 1;

    if v_prepaid < v_fee then
      exit;
    end if;

    insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
    values (p_student_id, v_stc_class, 1, 0)
    on conflict (student_id, class_name)
    do update set
      charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
      prepaid_balance_vnd = greatest(
        0,
        coalesce(public.student_tuition_by_class.prepaid_balance_vnd, 0) - v_fee
      ),
      updated_at = now();

    perform public.fn_sync_student_tuition_total(p_student_id);

    insert into public.payment_history(
      student_id,
      sessions_paid,
      sessions_applied_to_charged,
      amount_vnd,
      prepaid_topup_vnd,
      paid_at,
      payment_channel,
      class_name,
      reconcile_note
    )
    values (
      p_student_id,
      1,
      1,
      v_fee,
      0,
      now(),
      'prepaid_auto',
      v_stc_class,
      'Tự động: trừ học phí trả trước (1 buổi · ' || v_fee::text || 'đ)'
    );

    v_iter := v_iter + 1;
  end loop;
end;
$$;

grant execute on function public.fn_apply_prepaid_consumption(uuid, text) to service_role;
grant execute on function public.fn_apply_prepaid_consumption(uuid, text) to authenticated;

-- Sau khi điểm danh có mặt: thử trừ prepaid cho lớp tương ứng.
create or replace function public.trg_attendance_after_apply_prepaid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid uuid;
  v_class text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'present' then
      return new;
    end if;
    v_sid := new.student_id;
    v_class := coalesce(
      nullif(btrim(coalesce(new.class_name, '')), ''),
      (select nullif(btrim(s.class_name), '') from public.students s where s.id = new.student_id limit 1)
    );
  elsif tg_op = 'UPDATE' then
    if new.status <> 'present' then
      return new;
    end if;
    if old.status = 'present' and new.status = 'present'
      and coalesce(old.class_name, '') = coalesce(new.class_name, '')
      and old.student_id = new.student_id
      and old.date = new.date
    then
      return new;
    end if;
    v_sid := new.student_id;
    v_class := coalesce(
      nullif(btrim(coalesce(new.class_name, '')), ''),
      (select nullif(btrim(s.class_name), '') from public.students s where s.id = new.student_id limit 1)
    );
  else
    return null;
  end if;

  if v_sid is null or v_class is null or btrim(v_class) = '' then
    return new;
  end if;

  perform public.fn_apply_prepaid_consumption(v_sid, v_class);
  return new;
end;
$$;

drop trigger if exists trg_attendance_prepaid_after on public.attendance;
create trigger trg_attendance_prepaid_after
after insert or update on public.attendance
for each row execute procedure public.trg_attendance_after_apply_prepaid();

-- -----------------------------------------------------------------------------
-- Đối soát tay 1 HV / 1 lớp — có prepaid khi CK > buổi nợ × học phí
-- -----------------------------------------------------------------------------
create or replace function public.fn_manual_confirm_bank_transaction(
  p_txn_id bigint,
  p_received boolean,
  p_matched_student_id uuid default null,
  p_class_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
  v_txn public.bank_transactions%rowtype;
  v_fee integer := 0;
  v_sessions integer := null;
  v_apply_sessions integer := 0;
  v_prepaid_topup integer := 0;
  v_applied_amount integer := 0;
  v_payment_id bigint := null;
  v_class text := btrim(coalesce(p_class_name, ''));
  v_ph public.payment_history%rowtype;
  v_undo_students uuid[] := '{}'::uuid[];
  v_u uuid;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TXN_NOT_FOUND');
  end if;

  if v_txn.status = 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_APPLIED');
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
  end loop;

  foreach v_u in array coalesce(v_undo_students, '{}'::uuid[])
  loop
    if v_u is not null then
      perform public.fn_sync_student_tuition_total(v_u);
    end if;
  end loop;

  if coalesce(p_received, false) then
    if p_matched_student_id is null then
      return jsonb_build_object('ok', false, 'reason', 'STUDENT_REQUIRED');
    end if;
    if v_class = '' then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_REQUIRED');
    end if;

    if not (
      exists (
        select 1
        from public.students s
        where s.id = p_matched_student_id::uuid
          and (
            s.class_name = v_class
            or v_class = any(coalesce(s.class_names, '{}'::text[]))
          )
      )
      or public.fn_pending_sessions_for_class(p_matched_student_id::uuid, v_class) > 0
    ) then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_NOT_ASSIGNED_TO_STUDENT');
    end if;

    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where cf.class_name = v_class
    limit 1;

    if v_fee <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_FEE_NOT_FOUND');
    end if;

    v_sessions :=
      coalesce(v_txn.extracted_sessions, public.extract_sessions_from_transfer_content(v_txn.transfer_content));

    if (v_sessions is null or v_sessions < 1) and v_fee > 0 then
      v_sessions := floor(v_txn.amount_vnd::numeric / v_fee::numeric)::integer;
    end if;
    if v_sessions is null or v_sessions < 1 then
      return jsonb_build_object('ok', false, 'reason', 'SESSIONS_NOT_FOUND');
    end if;

    v_apply_sessions := least(public.fn_pending_sessions_for_class(p_matched_student_id::uuid, v_class), v_sessions);
    v_prepaid_topup := greatest(0, coalesce(v_txn.amount_vnd, 0) - v_apply_sessions * v_fee);

    if v_apply_sessions > 0 or v_prepaid_topup > 0 then
      v_applied_amount := coalesce(v_txn.amount_vnd, 0);

      insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
      values (p_matched_student_id::uuid, v_class, coalesce(v_apply_sessions, 0), coalesce(v_prepaid_topup, 0))
      on conflict (student_id, class_name)
      do update set
        charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
        prepaid_balance_vnd = coalesce(public.student_tuition_by_class.prepaid_balance_vnd, 0) + excluded.prepaid_balance_vnd,
        updated_at = now();

      perform public.fn_sync_student_tuition_total(p_matched_student_id::uuid);

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
        p_matched_student_id::uuid,
        v_sessions,
        v_apply_sessions,
        v_applied_amount,
        v_prepaid_topup,
        coalesce(v_txn.occurred_at, now()),
        'transfer_confirm',
        v_class,
        case
          when v_prepaid_topup > 0 and v_apply_sessions > 0 then 'Đối soát tay: một phần vào buổi đã học, phần còn lại vào trả trước'
          when v_prepaid_topup > 0 then 'Đối soát tay: toàn bộ vào học phí trả trước (chưa đủ buổi điểm danh)'
          else 'Đối soát tay: admin chọn học sinh và lớp thanh toán'
        end,
        v_txn.id
      )
      returning id into v_payment_id;
    else
      v_applied_amount := 0;
      v_payment_id := null;
    end if;

    update public.bank_transactions
    set
      status = 'manual_received',
      matched_student_id = p_matched_student_id::uuid,
      matched_class_name = v_class,
      reconcile_note = case
        when v_payment_id is not null and v_prepaid_topup > 0 then
          'Đối soát tay theo lớp ' || v_class || ' · trả trước ' || (v_prepaid_topup / 1000)::text || 'k'
        when v_payment_id is not null then 'Đối soát tay theo lớp ' || v_class
        else 'Đối soát tay theo lớp ' || v_class || ' (đã nhận tiền, không ghi học phí vì không còn buổi nợ)'
      end,
      extracted_sessions = v_sessions,
      applied_sessions = v_apply_sessions,
      applied_amount_vnd = case when v_payment_id is not null then coalesce(v_txn.amount_vnd, 0) else 0 end,
      applied_payment_history_id = v_payment_id,
      error_note = null
    where id = p_txn_id;
  else
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
  end if;

  return jsonb_build_object(
    'ok', true,
    'txn_id', p_txn_id,
    'received', coalesce(p_received, false),
    'class_name', nullif(v_class, ''),
    'sessions', v_apply_sessions,
    'sessions_purchased', v_sessions,
    'prepaid_topup_vnd', v_prepaid_topup,
    'amount_vnd', coalesce(v_applied_amount, 0),
    'payment_history_id', v_payment_id
  );
end $$;

grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid, text) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid, text) to authenticated;

drop function if exists public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid);
create or replace function public.fn_manual_confirm_bank_transaction(
  p_txn_id bigint,
  p_received boolean,
  p_matched_student_id uuid
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.fn_manual_confirm_bank_transaction(
    p_txn_id := p_txn_id,
    p_received := p_received,
    p_matched_student_id := p_matched_student_id,
    p_class_name := null
  );
$$;

grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid) to authenticated;

drop function if exists public.fn_manual_confirm_bank_transaction_v2(bigint, boolean, uuid, text);
create or replace function public.fn_manual_confirm_bank_transaction_v2(
  p_txn_id bigint,
  p_received boolean,
  p_matched_student_id uuid default null,
  p_class_name text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.fn_manual_confirm_bank_transaction(
    p_txn_id::bigint,
    p_received::boolean,
    p_matched_student_id::uuid,
    p_class_name::text
  );
$$;

grant execute on function public.fn_manual_confirm_bank_transaction_v2(bigint, boolean, uuid, text) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction_v2(bigint, boolean, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Đối soát tay nhiều HV — cho phép sessions > pending; phần thừa vào prepaid
-- -----------------------------------------------------------------------------
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
  v_raw_sid text;
  v_class text;
  v_sess int;
  v_fee int;
  v_pending int;
  v_apply int;
  v_prep int;
  v_line_amt int;
  v_sum int := 0;
  v_sum_sess int := 0;
  v_ph public.payment_history%rowtype;
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
  end loop;

  foreach v_u in array coalesce(v_undo_students, '{}'::uuid[])
  loop
    if v_u is not null then
      perform public.fn_sync_student_tuition_total(v_u);
    end if;
  end loop;

  for v_line_el in select value from jsonb_array_elements(p_lines) as t(value)
  loop
    v_line_count := v_line_count + 1;
    v_raw_sid := btrim(coalesce(
      v_line_el->>'student_id',
      v_line_el->>'studentId',
      ''
    ));
    if v_raw_sid = '' then
      return jsonb_build_object(
        'ok', false,
        'reason', 'INVALID_STUDENT_ID',
        'line', v_line_count,
        'detail', 'EMPTY'
      );
    end if;
    begin
      v_sid := v_raw_sid::uuid;
    exception when others then
      return jsonb_build_object(
        'ok', false,
        'reason', 'INVALID_STUDENT_ID',
        'line', v_line_count,
        'detail', left(v_raw_sid, 80)
      );
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

    v_pending := coalesce(public.fn_pending_sessions_for_class(v_sid, v_class), 0);
    v_apply := coalesce(least(v_sess, v_pending), 0);
    v_prep := greatest(0, coalesce(v_sess * v_fee - v_apply * v_fee, 0));

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

  for v_line_el in select value from jsonb_array_elements(p_lines) as t(value)
  loop
    v_raw_sid := btrim(coalesce(
      v_line_el->>'student_id',
      v_line_el->>'studentId',
      ''
    ));
    v_sid := v_raw_sid::uuid;
    v_class := btrim(coalesce(v_line_el->>'class_name', ''));
    v_sess := floor(coalesce(nullif(v_line_el->>'sessions', '')::numeric, 0))::integer;
    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where cf.class_name = v_class
    limit 1;

    v_pending := coalesce(public.fn_pending_sessions_for_class(v_sid, v_class), 0);
    v_apply := coalesce(least(v_sess, v_pending), 0);
    v_prep := greatest(0, coalesce(v_sess * v_fee - v_apply * v_fee, 0));

    insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
    values (v_sid, v_class, coalesce(v_apply, 0), coalesce(v_prep, 0))
    on conflict (student_id, class_name)
    do update set
      charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
      prepaid_balance_vnd = coalesce(public.student_tuition_by_class.prepaid_balance_vnd, 0) + excluded.prepaid_balance_vnd,
      updated_at = now();

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
      v_sid,
      v_sess,
      v_apply,
      v_sess * v_fee,
      v_prep,
      coalesce(v_txn.occurred_at, now()),
      'transfer_confirm',
      v_class,
      'Đối soát tay (nhiều HV): CK #' || p_txn_id::text || case when v_prep > 0 then ' · có trả trước' else '' end,
      v_txn.id
    )
    returning id into v_last_payment_id;

    perform public.fn_sync_student_tuition_total(v_sid);

    if v_first_payment_id is null then
      v_first_payment_id := v_last_payment_id;
    end if;
  end loop;

  update public.bank_transactions
  set
    status = 'manual_received',
    matched_student_id = null,
    matched_class_name = 'Nhiều học viên',
    reconcile_note = 'Đối soát tay: ' || v_line_count::text || ' học viên · ' || v_sum_sess::text || ' buổi (mua)',
    extracted_sessions = v_sum_sess,
    applied_sessions = (
      select coalesce(sum(coalesce(ph.sessions_applied_to_charged, ph.sessions_paid, 0)), 0)::integer
      from public.payment_history ph
      where coalesce(ph.bank_transaction_id, 0) = v_txn.id
    ),
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
  return jsonb_build_object(
    'ok', false,
    'reason', 'EXCEPTION',
    'message', SQLERRM,
    'sqlstate', SQLSTATE
  );
end;
$$;

grant execute on function public.fn_manual_confirm_bank_transaction_multi(bigint, jsonb) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction_multi(bigint, jsonb) to authenticated;

notify pgrst, 'reload schema';
