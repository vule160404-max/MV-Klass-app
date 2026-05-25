-- 064 - Bank auto apply should clear all pending debt for a high-confidence student
-- before putting any remaining transfer amount into prepaid.

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
  v_student_id uuid := null;
  v_match_confidence text := null;
  v_match_score integer := null;
  v_match_method text := null;
  v_match_candidates jsonb := '[]'::jsonb;
  v_top record;
  v_near_count integer := 0;
  v_classes text[] := '{}'::text[];
  v_line record;
  v_remaining integer := 0;
  v_total_sessions integer := 0;
  v_total_applied integer := 0;
  v_first_payment_id bigint := null;
  v_last_payment_id bigint := null;
  v_prepaid_class text := '';
  v_prepaid_fee integer := 0;
  v_class_names text[] := '{}'::text[];
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
    set status = 'ignored',
        error_note = 'Số tiền <= 0',
        match_candidates = '[]'::jsonb
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'INVALID_AMOUNT');
  end if;

  v_content_digits := regexp_replace(coalesce(v_txn.transfer_content, ''), '\D', '', 'g');
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
      v_match_confidence := 'high';
      v_match_score := 200;
      v_match_method := 'ref';
      select jsonb_build_array(jsonb_build_object(
        'student_id', s.id,
        'student_name', s.name,
        'parent_name', s.parent_name,
        'class_name', s.class_name,
        'phone', s.phone,
        'score', 200,
        'confidence', 'high',
        'match_method', 'ref',
        'matched_text', v_ref_code
      ))
      into v_match_candidates
      from public.students s
      where s.id = v_student_id;
    end if;
  end if;

  if v_student_id is null then
    with c as (
      select *
      from public.match_students_from_transfer_content(v_txn.transfer_content)
      where score >= 60
      order by score desc, student_name
      limit 5
    ),
    top_score as (
      select coalesce(max(score), 0)::integer as score from c
    ),
    near_best as (
      select c.*
      from c, top_score t
      where t.score >= 60
        and c.score >= t.score - 8
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'student_id', c.student_id,
        'student_name', c.student_name,
        'parent_name', c.parent_name,
        'class_name', c.class_name,
        'phone', c.phone,
        'score', c.score,
        'confidence', c.confidence,
        'match_method', c.match_method,
        'matched_text', c.matched_text,
        'matched_tokens', c.matched_tokens
      ) order by c.score desc, c.student_name), '[]'::jsonb),
      (select count(*)::integer from near_best)
    into v_match_candidates, v_near_count
    from c;

    select *
    into v_top
    from public.match_students_from_transfer_content(v_txn.transfer_content)
    where score >= 60
    order by score desc, student_name
    limit 1;

    if found then
      v_match_confidence := v_top.confidence;
      v_match_score := v_top.score;
      v_match_method := v_top.match_method;
      if v_top.confidence = 'high' and v_near_count = 1 then
        v_student_id := v_top.student_id;
      end if;
    end if;
  end if;

  if v_student_id is null then
    update public.bank_transactions
    set status = 'needs_review',
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = case
          when jsonb_array_length(coalesce(v_match_candidates, '[]'::jsonb)) = 0 then
            'Không match được học sinh theo nội dung chuyển khoản'
          else
            'Match chưa đủ chắc chắn, cần chọn học sinh từ gợi ý'
        end
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CANDIDATE_NOT_UNIQUE', 'count', v_near_count);
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
      and nullif(btrim(coalesce(a.class_name, '')), '') is not null
    union all
    select nullif(btrim(stc.class_name), '') as c
    from public.student_tuition_by_class stc
    where stc.student_id = v_student_id
  ) u;

  if coalesce(array_length(v_classes, 1), 0) = 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Học sinh chưa có lớp để đối soát'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_CLASS_FOR_STUDENT');
  end if;

  v_remaining := coalesce(v_txn.amount_vnd, 0);

  for v_line in
    with raw as (
      select distinct nullif(btrim(c), '') as class_name
      from unnest(v_classes) c
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
        r.class_name,
        public.fn_pending_sessions_for_class(v_student_id, r.class_name) as pend,
        (select coalesce(cf.fee_amount, 0) from public.class_fees cf where cf.class_name = r.class_name limit 1) as fee,
        case when exists (
          select 1 from assigned_norm an where an.n = public.normalize_lookup_text(r.class_name)
        ) then 1 else 2 end as tier
      from raw r
    )
    select *,
      case
        when pend > 0 and pend * fee = v_txn.amount_vnd then 1
        when pend > 0 and v_txn.amount_vnd > pend * fee then 2
        when pend > 0 and v_txn.amount_vnd < pend * fee and mod(v_txn.amount_vnd, fee) = 0 then 3
        when pend > 0 then 4
        else 9
      end as debt_rank
    from with_meta
    where fee > 0
    order by debt_rank, tier, class_name
  loop
    if v_prepaid_class = '' and v_line.tier = 1 then
      v_prepaid_class := v_line.class_name;
      v_prepaid_fee := v_line.fee;
    end if;
    if coalesce(v_line.pend, 0) <= 0 or v_remaining < coalesce(v_line.fee, 0) then
      continue;
    end if;

    declare
      v_sessions integer := least(v_line.pend, floor(v_remaining::numeric / v_line.fee::numeric)::integer);
      v_amount integer := v_sessions * v_line.fee;
    begin
      if v_sessions < 1 then
        continue;
      end if;

      insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
      values (v_student_id, v_line.class_name, v_sessions, 0)
      on conflict (student_id, class_name)
      do update set
        charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
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
        v_student_id,
        v_sessions,
        v_sessions,
        v_amount,
        0,
        coalesce(v_txn.occurred_at, now()),
        'bank_auto',
        v_line.class_name,
        'Auto CK: match ' || coalesce(v_match_method, 'unknown') ||
          ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
          ' · trừ nợ trước',
        v_txn.id
      )
      returning id into v_last_payment_id;

      if v_first_payment_id is null then
        v_first_payment_id := v_last_payment_id;
      end if;
      v_total_sessions := v_total_sessions + v_sessions;
      v_total_applied := v_total_applied + v_amount;
      v_remaining := greatest(0, v_remaining - v_amount);
      v_class_names := array_append(v_class_names, v_line.class_name);
    end;
  end loop;

  if v_remaining > 0 then
    if v_prepaid_class = '' then
      select c, coalesce(cf.fee_amount, 0)
      into v_prepaid_class, v_prepaid_fee
      from unnest(v_classes) c
      left join public.class_fees cf on cf.class_name = c
      where c is not null and btrim(c) <> '' and coalesce(cf.fee_amount, 0) > 0
      order by c
      limit 1;
    end if;

    if coalesce(v_prepaid_class, '') = '' then
      update public.bank_transactions
      set status = 'needs_review',
          matched_student_id = v_student_id,
          match_confidence = v_match_confidence,
          match_score = v_match_score,
          match_method = v_match_method,
          match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
          error_note = 'Không chọn được lớp để lưu học phí dư'
      where id = v_txn.id;
      return jsonb_build_object('ok', false, 'reason', 'NO_PREPAID_CLASS');
    end if;

    insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
    values (v_student_id, v_prepaid_class, 0, v_remaining)
    on conflict (student_id, class_name)
    do update set
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
      v_student_id,
      case when coalesce(v_prepaid_fee, 0) > 0 then floor(v_remaining::numeric / v_prepaid_fee::numeric)::integer else 0 end,
      0,
      v_remaining,
      v_remaining,
      coalesce(v_txn.occurred_at, now()),
      'bank_auto',
      v_prepaid_class,
      'Auto CK: match ' || coalesce(v_match_method, 'unknown') ||
        ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
        ' · hết nợ trước, phần còn lại vào trả trước',
      v_txn.id
    )
    returning id into v_last_payment_id;

    if v_first_payment_id is null then
      v_first_payment_id := v_last_payment_id;
    end if;
    v_class_names := array_append(v_class_names, v_prepaid_class);
  end if;

  if v_first_payment_id is null then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Số tiền CK không đủ ghi nhận buổi hoặc học phí dư'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'AMOUNT_TOO_SMALL');
  end if;

  perform public.fn_sync_student_tuition_total(v_student_id);

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      matched_class_name = (
        select string_agg(distinct x, ', ' order by x)
        from unnest(v_class_names) x
        where x is not null and btrim(x) <> ''
      ),
      match_confidence = v_match_confidence,
      match_score = v_match_score,
      match_method = v_match_method,
      match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
      reconcile_note = 'Auto: match ' || coalesce(v_match_method, 'unknown') ||
        ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
        ' · trừ nợ trước' ||
        case when greatest(0, coalesce(v_txn.amount_vnd, 0) - v_total_applied) > 0
          then ' · còn dư vào trả trước'
          else ''
        end,
      extracted_sessions = v_total_sessions,
      applied_sessions = v_total_sessions,
      applied_amount_vnd = coalesce(v_txn.amount_vnd, 0),
      applied_payment_history_id = v_first_payment_id,
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
    'sessions', v_total_sessions,
    'amount_vnd', coalesce(v_txn.amount_vnd, 0),
    'prepaid_topup_vnd', greatest(0, coalesce(v_txn.amount_vnd, 0) - v_total_applied),
    'payment_history_id', v_first_payment_id
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
