-- =============================================================================
-- 019 — Chuyển lớp: vẫn thu được học phí / đối soát CK cho lớp cũ (còn nợ nhưng
-- không còn trong students.class_names). Đồng bộ tổng student_tuition khi sửa
-- student_tuition_by_class qua REST.
-- =============================================================================

-- Cho phép xác nhận đối soát tay vào một lớp nếu còn buổi nợ theo attendance,
-- không bắt buộc lớp đó đang trong class_names của học sinh.
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
  v_applied_amount integer := 0;
  v_payment_id bigint := null;
  v_class text := btrim(coalesce(p_class_name, ''));
  v_ph public.payment_history%rowtype;
  v_sync_sid uuid := null;
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

  -- Hoàn tác mọi ghi nhận học phí gắn giao dịch này (một hoặc nhiều lớp — auto CK có thể tách nhiều dòng)
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
    v_sync_sid := v_ph.student_id::uuid;
  end loop;
  if v_sync_sid is not null then
    perform public.fn_sync_student_tuition_total(v_sync_sid);
  end if;

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

    if v_apply_sessions > 0 then
      v_applied_amount := v_apply_sessions * v_fee;

      insert into public.student_tuition_by_class(student_id, class_name, charged_sessions)
      values (p_matched_student_id::uuid, v_class, v_apply_sessions)
      on conflict (student_id, class_name)
      do update set
        charged_sessions = public.student_tuition_by_class.charged_sessions + excluded.charged_sessions;

      perform public.fn_sync_student_tuition_total(p_matched_student_id::uuid);

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
        p_matched_student_id::uuid,
        v_apply_sessions,
        v_applied_amount,
        coalesce(v_txn.occurred_at, now()),
        'transfer_confirm',
        v_class,
        'Đối soát tay: admin chọn học sinh và lớp thanh toán',
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
        when v_apply_sessions > 0 then 'Đối soát tay theo lớp ' || v_class
        else 'Đối soát tay theo lớp ' || v_class || ' (đã nhận tiền, không ghi học phí vì không còn buổi nợ)'
      end,
      extracted_sessions = v_sessions,
      applied_sessions = v_apply_sessions,
      applied_amount_vnd = v_applied_amount,
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
    'amount_vnd', v_applied_amount,
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

-- Đối soát auto: CHỈ khi số tiền CK khớp chính xác tổng nợ VND của đúng một lớp
-- (lớp đang gán hoặc lớp cũ không còn trên hồ sơ). Không khớp hoặc nhiều lớp cùng số nợ → needs_review.
create or replace function public.fn_auto_apply_bank_transaction(p_txn_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions%rowtype;
  v_ref_code text := null;
  v_parent_ref_rec public.parent_payment_refs%rowtype;
  v_content_digits text := '';
  v_candidate_count integer := 0;
  v_student_id uuid;
  v_matched_candidate_id uuid;
  v_classes text[] := '{}'::text[];
  v_row record;
  v_exact_match_count integer := 0;
  v_any_pending boolean := false;
  v_selected_class text := '';
  v_apply_sessions integer := 0;
  v_tier integer := 0;
  v_fee integer := 0;
  v_applied_amount integer := 0;
  v_payment_id bigint := null;
begin
  if auth.role() = 'authenticated' and not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  select * into v_txn
  from public.bank_transactions
  where id = p_txn_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TXN_NOT_FOUND');
  end if;

  if v_txn.status = 'applied' then
    return jsonb_build_object('ok', true, 'reason', 'ALREADY_APPLIED', 'txn_id', v_txn.id);
  end if;

  if v_txn.status = 'manual_not_received' then
    return jsonb_build_object('ok', false, 'reason', 'MANUAL_NOT_RECEIVED', 'txn_id', v_txn.id);
  end if;

  if v_txn.amount_vnd <= 0 then
    update public.bank_transactions
    set status = 'ignored', error_note = 'Số tiền <= 0'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'INVALID_AMOUNT');
  end if;

  v_ref_code := public.extract_payment_ref_from_transfer_content(v_txn.transfer_content);
  if v_ref_code is not null then
    select *
    into v_parent_ref_rec
    from public.parent_payment_refs pr
    where pr.ref_code = v_ref_code
      and pr.status = 'active'
      and pr.expires_at > now()
    order by pr.id desc
    limit 1;
    if found then
      v_student_id := v_parent_ref_rec.student_id;
      v_candidate_count := 1;
    end if;
  end if;

  v_content_digits := regexp_replace(coalesce(v_txn.transfer_content, ''), '\D', '', 'g');

  if v_candidate_count = 0 then
    select m.student_id, m.candidate_count
    into v_matched_candidate_id, v_candidate_count
    from public.match_student_from_transfer_content(v_txn.transfer_content) m;
    if v_candidate_count = 1 then
      v_student_id := v_matched_candidate_id;
    end if;
  end if;

  if v_candidate_count <> 1 then
    update public.bank_transactions
    set status = 'needs_review',
        error_note = case
          when v_candidate_count = 0 then 'Không match được học sinh theo nội dung chuyển khoản'
          else 'Match nhiều học sinh, cần duyệt tay'
        end
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CANDIDATE_NOT_UNIQUE', 'count', v_candidate_count);
  end if;

  if v_student_id is null and v_candidate_count = 1 then
    v_student_id := v_matched_candidate_id;
  end if;

  select array_agg(distinct c) filter (where c is not null and btrim(c) <> '')
  into v_classes
  from (
    select unnest(coalesce(s.class_names, '{}'::text[])) as c
    from public.students s
    where s.id = v_student_id
    union all
    select nullif(btrim(s.class_name), '') as c
    from public.students s
    where s.id = v_student_id
    union all
    select distinct nullif(btrim(a.class_name), '') as c
    from public.attendance a
    where a.student_id = v_student_id
      and a.status = 'present'
      and coalesce(nullif(btrim(a.class_name), ''), '') is not null
    union all
    select nullif(btrim(stc.class_name), '') as c
    from public.student_tuition_by_class stc
    where stc.student_id = v_student_id
  ) u;

  if coalesce(array_length(v_classes, 1), 0) = 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Học sinh chưa có lớp để đối soát'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_CLASS_FOR_STUDENT');
  end if;

  for v_row in
    with raw as (
      select distinct nullif(btrim(c), '') as c
      from (
        select unnest(coalesce(s.class_names, '{}'::text[])) as c
        from public.students s
        where s.id = v_student_id
        union all
        select nullif(btrim(s.class_name), '') as c
        from public.students s
        where s.id = v_student_id
        union all
        select distinct nullif(btrim(a.class_name), '') as c
        from public.attendance a
        where a.student_id = v_student_id
          and a.status = 'present'
          and coalesce(nullif(btrim(a.class_name), ''), '') is not null
        union all
        select nullif(btrim(stc.class_name), '') as c
        from public.student_tuition_by_class stc
        where stc.student_id = v_student_id
      ) u
      where nullif(btrim(c), '') is not null
    ),
    assigned_norm as (
      select distinct public.normalize_lookup_text(nullif(btrim(t.x), '')) as n
      from public.students s,
      lateral (
        select s.class_name as x
        union all
        select unnest(coalesce(s.class_names, '{}'::text[])) as x
      ) t
      where s.id = v_student_id
        and nullif(btrim(t.x), '') is not null
    ),
    with_meta as (
      select
        r.c as class_name,
        public.fn_pending_sessions_for_class(v_student_id, r.c) as pend,
        (select coalesce(cf.fee_amount, 0) from public.class_fees cf where cf.class_name = r.c limit 1) as fee,
        case
          when exists (
            select 1
            from assigned_norm an
            where an.n = public.normalize_lookup_text(r.c)
          )
          then 1
          else 2
        end as tier
      from raw r
    )
    select *
    from with_meta
    where pend > 0
      and fee > 0
    order by tier, class_name
  loop
    v_any_pending := true;
    if v_row.pend * v_row.fee = v_txn.amount_vnd then
      v_exact_match_count := v_exact_match_count + 1;
      if v_exact_match_count = 1 then
        v_selected_class := v_row.class_name;
        v_apply_sessions := v_row.pend;
        v_tier := v_row.tier;
        v_fee := v_row.fee;
      end if;
    end if;
  end loop;

  if not v_any_pending then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Không còn buổi nợ để đối soát'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_PENDING_SESSIONS');
  end if;

  if v_exact_match_count = 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Số tiền CK không khớp chính xác tổng nợ một lớp — chờ đối soát tay'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_AMOUNT_NOT_MATCHED');
  end if;

  if v_exact_match_count > 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Nhiều lớp có cùng tổng nợ trùng số tiền CK — chờ đối soát tay'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_AMOUNT_AMBIGUOUS');
  end if;

  v_applied_amount := v_apply_sessions * v_fee;

  insert into public.student_tuition_by_class(student_id, class_name, charged_sessions)
  values (v_student_id, v_selected_class, v_apply_sessions)
  on conflict (student_id, class_name)
  do update set charged_sessions = public.student_tuition_by_class.charged_sessions + excluded.charged_sessions;

  perform public.fn_sync_student_tuition_total(v_student_id);

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
    v_student_id,
    v_apply_sessions,
    v_applied_amount,
    coalesce(v_txn.occurred_at, now()),
    'bank_auto',
    v_selected_class,
    case v_tier
      when 1 then 'Auto CK: khớp đúng tổng nợ lớp đang gán'
      else 'Auto CK: khớp đúng tổng nợ lớp cũ (không còn gán hs)'
    end,
    v_txn.id
  )
  returning id into v_payment_id;

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      matched_class_name = v_selected_class,
      reconcile_note = 'Auto: CK khớp đúng nợ lớp ' || v_selected_class,
      extracted_sessions = v_apply_sessions,
      applied_sessions = v_apply_sessions,
      applied_amount_vnd = v_applied_amount,
      applied_payment_history_id = v_payment_id,
      error_note = null
  where id = v_txn.id;

  if v_parent_ref_rec.id is null then
    select *
    into v_parent_ref_rec
    from public.parent_payment_refs pr
    where pr.student_id = v_student_id
      and regexp_replace(coalesce(pr.parent_phone, ''), '\D', '', 'g') <> ''
      and position(regexp_replace(coalesce(pr.parent_phone, ''), '\D', '', 'g') in v_content_digits) > 0
      and pr.status = 'active'
      and pr.expires_at > now()
    order by pr.id desc
    limit 1;
  end if;

  if v_parent_ref_rec.id is not null then
    update public.parent_payment_refs
    set status = 'used',
        used_at = now()
    where id = v_parent_ref_rec.id
      and status = 'active';
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', 'APPLIED',
    'txn_id', v_txn.id,
    'student_id', v_student_id,
    'class_name', v_selected_class,
    'sessions', v_apply_sessions,
    'amount_vnd', v_applied_amount,
    'payment_history_id', v_payment_id,
    'remainder_vnd', 0
  );
exception when others then
  update public.bank_transactions
  set status = 'error',
      error_note = sqlerrm
  where id = p_txn_id;
  return jsonb_build_object('ok', false, 'reason', 'EXCEPTION', 'message', sqlerrm);
end $$;

grant execute on function public.fn_auto_apply_bank_transaction(bigint) to service_role;
grant execute on function public.fn_auto_apply_bank_transaction(bigint) to authenticated;

-- REST PATCH/INSERT vào student_tuition_by_class: cập nhật tổng student_tuition
create or replace function public.trg_sync_student_tuition_total_from_class()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_sid uuid := coalesce(new.student_id, old.student_id);
begin
  if v_sid is not null then
    perform public.fn_sync_student_tuition_total(v_sid);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_student_tuition_by_class_sync_total on public.student_tuition_by_class;
create trigger trg_student_tuition_by_class_sync_total
after insert or update or delete on public.student_tuition_by_class
for each row execute procedure public.trg_sync_student_tuition_total_from_class();

notify pgrst, 'reload schema';
