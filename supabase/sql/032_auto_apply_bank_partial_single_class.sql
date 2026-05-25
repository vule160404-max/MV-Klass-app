-- =============================================================================
-- 032 — Auto đối soát CK: HS chỉ còn nợ trên đúng một lớp (đang gán, tier 1),
-- không có nợ lớp cũ song song; CK > 0, nhỏ hơn tổng nợ lớp đó nhưng chia hết
-- học phí/buổi → tự trừ số buổi tương ứng (không cần đối soát tay).
-- Ghi đè public.fn_auto_apply_bank_transaction (bản 019).
-- Sau khi chạy: NOTIFY reload schema (cuối file).
-- =============================================================================

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
  v_debt_class_count integer := 0;
  v_only_class_name text := '';
  v_only_tier integer := 0;
  v_only_pend integer := 0;
  v_only_fee integer := 0;
  v_partial_sessions integer := 0;
  v_is_partial boolean := false;
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
    v_debt_class_count := v_debt_class_count + 1;
    if v_debt_class_count = 1 then
      v_only_class_name := v_row.class_name;
      v_only_tier := v_row.tier;
      v_only_pend := v_row.pend;
      v_only_fee := v_row.fee;
    end if;
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
    v_is_partial := false;
    if v_debt_class_count = 1
       and v_only_tier = 1
       and v_only_fee > 0
       and v_only_pend > 0
       and v_txn.amount_vnd > 0
       and v_txn.amount_vnd < v_only_pend * v_only_fee
       and mod(v_txn.amount_vnd, v_only_fee) = 0
    then
      v_partial_sessions := v_txn.amount_vnd / v_only_fee;
      if v_partial_sessions >= 1 and v_partial_sessions <= v_only_pend then
        v_exact_match_count := 1;
        v_selected_class := v_only_class_name;
        v_apply_sessions := v_partial_sessions;
        v_tier := v_only_tier;
        v_fee := v_only_fee;
        v_is_partial := true;
      end if;
    end if;
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
    case
      when v_is_partial then 'Auto CK: trừ một phần buổi nợ (một lớp đang gán, CK < tổng nợ)'
      when v_tier = 1 then 'Auto CK: khớp đúng tổng nợ lớp đang gán'
      else 'Auto CK: khớp đúng tổng nợ lớp cũ (không còn gán hs)'
    end,
    v_txn.id
  )
  returning id into v_payment_id;

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      matched_class_name = v_selected_class,
      reconcile_note = case
        when v_is_partial then 'Auto: CK trừ ' || v_apply_sessions::text || ' buổi (một lớp đang gán) — ' || v_selected_class
        else 'Auto: CK khớp đúng nợ lớp ' || v_selected_class
      end,
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
    'remainder_vnd', greatest(0, coalesce(v_txn.amount_vnd, 0) - v_applied_amount)
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

notify pgrst, 'reload schema';
