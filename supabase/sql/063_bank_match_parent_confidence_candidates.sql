-- 063 - Bank transfer matching by parent name with confidence and candidates.
-- Adds backend-owned match metadata for bank review UI and broadens high-confidence
-- auto apply to use debt-first, surplus-to-prepaid behavior.

alter table public.bank_transactions
  add column if not exists match_confidence text,
  add column if not exists match_score integer,
  add column if not exists match_method text,
  add column if not exists match_candidates jsonb not null default '[]'::jsonb;

alter table public.students
  add column if not exists class_names text[] not null default '{}'::text[];

create or replace function public.bank_match_clean_transfer_text(p_content text)
returns text
language sql
immutable
as $$
  with raw as (
    select public.normalize_lookup_text(p_content) as n
  ),
  toks as (
    select t
    from raw, regexp_split_to_table(raw.n, '\s+') as t
    where t <> ''
      and t not in (
        'bankapinotify', 'bankapi', 'notify', 'ibft', 'trace', 'gd',
        'giao', 'dich', 'ma', 'ref', 'id', 'noi', 'dung',
        'chuyen', 'tien', 'chuyen tien', 'ck', 'bank', 'banking',
        'mbbank', 'vietcombank', 'bidv', 'techcombank', 'tpbank',
        'hoc', 'phi', 'hocphi', 'nop', 'dong', 'thanh', 'toan',
        'cho', 'be', 'ban', 'con', 'em', 'hs', 'hocvien', 'hoc', 'sinh',
        'phu', 'huynh', 'ph', 'vnd', 'vn'
      )
      and t !~ '^[0-9]+$'
  )
  select coalesce(string_agg(t, ' '), '') from toks;
$$;

create or replace function public.match_students_from_transfer_content(p_content text)
returns table(
  student_id uuid,
  student_name text,
  parent_name text,
  class_name text,
  phone text,
  score integer,
  confidence text,
  match_method text,
  matched_text text,
  matched_tokens text[]
)
language sql
stable
as $$
  with vars as (
    select
      public.normalize_lookup_text(p_content) as content_norm,
      public.bank_match_clean_transfer_text(p_content) as clean_norm,
      replace(public.normalize_lookup_text(p_content), ' ', '') as content_compact,
      replace(public.bank_match_clean_transfer_text(p_content), ' ', '') as clean_compact,
      regexp_replace(coalesce(p_content, ''), '\D', '', 'g') as content_digits
  ),
  prepared as (
    select
      s.id,
      s.name,
      s.parent_name,
      s.class_name,
      s.phone,
      public.normalize_lookup_text(s.name) as name_norm,
      public.normalize_lookup_text(s.parent_name) as parent_norm,
      replace(public.normalize_lookup_text(s.name), ' ', '') as name_compact,
      replace(public.normalize_lookup_text(s.parent_name), ' ', '') as parent_compact,
      regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') as phone_digits
    from public.students s
    where coalesce(p_content, '') <> ''
  ),
  scored as (
    select
      p.*,
      array(
        select t
        from regexp_split_to_table(p.name_norm, '\s+') t
        where length(t) >= 2
          and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
      ) as name_hits,
      array(
        select t
        from regexp_split_to_table(p.parent_norm, '\s+') t
        where length(t) >= 2
          and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
      ) as parent_hits,
      case
        when length(p.phone_digits) >= 9
          and position(p.phone_digits in v.content_digits) > 0
        then 150 else 0
      end as phone_score,
      case
        when length(p.name_compact) >= 8
          and (
            position(' ' || p.name_norm || ' ' in ' ' || v.clean_norm || ' ') > 0
            or position(p.name_compact in v.clean_compact) > 0
          )
        then 125 else 0
      end as student_full_score,
      case
        when length(p.parent_compact) >= 6
          and (
            position(' ' || p.parent_norm || ' ' in ' ' || v.clean_norm || ' ') > 0
            or position(p.parent_compact in v.clean_compact) > 0
          )
        then 120 else 0
      end as parent_full_score,
      case
        when array_length(array(
          select t
          from regexp_split_to_table(p.name_norm, '\s+') t
          where length(t) >= 2
            and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        ), 1) >= 2
        then 55 + 12 * array_length(array(
          select t
          from regexp_split_to_table(p.name_norm, '\s+') t
          where length(t) >= 2
            and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        ), 1)
        when array_length(array(
          select t
          from regexp_split_to_table(p.name_norm, '\s+') t
          where length(t) >= 3
            and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        ), 1) = 1
        then 24
        else 0
      end as student_token_score,
      case
        when array_length(array(
          select t
          from regexp_split_to_table(p.parent_norm, '\s+') t
          where length(t) >= 2
            and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        ), 1) >= 2
        then 50 + 10 * array_length(array(
          select t
          from regexp_split_to_table(p.parent_norm, '\s+') t
          where length(t) >= 2
            and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        ), 1)
        else 0
      end as parent_token_score
    from prepared p
    cross join vars v
  ),
  ranked as (
    select
      s.*,
      greatest(
        s.phone_score,
        s.student_full_score,
        s.parent_full_score,
        s.student_token_score,
        s.parent_token_score
      )::integer as best_score
    from scored s
  )
  select
    r.id,
    r.name,
    r.parent_name,
    r.class_name,
    r.phone,
    r.best_score,
    case
      when r.best_score >= 110 then 'high'
      when r.best_score >= 70 then 'medium'
      else 'low'
    end,
    case
      when r.phone_score = r.best_score and r.phone_score > 0 then 'phone'
      when r.student_full_score = r.best_score and r.student_full_score > 0 then 'student_name'
      when r.parent_full_score = r.best_score and r.parent_full_score > 0 then 'parent_name'
      when r.student_token_score = r.best_score and r.parent_token_score = r.best_score and r.best_score > 0 then 'mixed'
      when r.student_token_score = r.best_score and r.student_token_score > 0 then 'student_name'
      when r.parent_token_score = r.best_score and r.parent_token_score > 0 then 'parent_name'
      else 'mixed'
    end,
    case
      when r.phone_score = r.best_score and r.phone_score > 0 then r.phone_digits
      when (r.parent_full_score = r.best_score and r.parent_full_score > 0) then r.parent_norm
      when (r.student_full_score = r.best_score and r.student_full_score > 0) then r.name_norm
      else array_to_string(array_cat(coalesce(r.name_hits, '{}'::text[]), coalesce(r.parent_hits, '{}'::text[])), ' ')
    end,
    array_cat(coalesce(r.name_hits, '{}'::text[]), coalesce(r.parent_hits, '{}'::text[]))
  from ranked r
  where r.best_score > 0
  order by r.best_score desc, r.name;
$$;

create or replace function public.match_student_from_transfer_content(p_content text)
returns table(student_id uuid, candidate_count integer, top_score integer)
language sql
stable
as $$
  with c as (
    select *
    from public.match_students_from_transfer_content(p_content)
    where score >= 60
  ),
  t as (
    select coalesce(max(score), 0)::integer as top_score from c
  ),
  near_best as (
    select c.*
    from c cross join t
    where t.top_score >= 60
      and c.score >= t.top_score - 8
  )
  select
    case
      when (select count(*) from near_best) = 1
       and (select confidence from near_best order by score desc limit 1) = 'high'
      then (select nb.student_id from near_best nb order by nb.score desc, nb.student_name limit 1)
      else null
    end,
    (select count(*)::integer from near_best),
    (select top_score from t);
$$;

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
  v_row record;
  v_best record;
  v_best_set boolean := false;
  v_best_count integer := 0;
  v_apply_sessions integer := 0;
  v_fee integer := 0;
  v_applied_amount integer := 0;
  v_prepaid_topup integer := 0;
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

  for v_row in
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
        when fee <= 0 then -100000
        when pend > 0 and pend * fee = v_txn.amount_vnd then 10000 - tier
        when pend > 0 and v_txn.amount_vnd > pend * fee then 9000 - tier
        when pend > 0 and v_txn.amount_vnd < pend * fee and mod(v_txn.amount_vnd, fee) = 0 then 8000 - tier
        when pend = 0 and v_txn.amount_vnd >= fee and tier = 1 then 6000 - tier
        else -1000 - tier
      end as rank_score
    from with_meta
    where fee > 0
    order by rank_score desc, tier, class_name
  loop
    if not v_best_set then
      v_best := v_row;
      v_best_set := true;
      v_best_count := 1;
    elsif v_row.rank_score = v_best.rank_score then
      v_best_count := v_best_count + 1;
    end if;
  end loop;

  if not v_best_set then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Không chọn được lớp đủ chắc chắn để tự đối soát'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_NOT_CONFIDENT');
  end if;

  if coalesce(v_best.rank_score, -100000) < 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Không chọn được lớp đủ chắc chắn để tự đối soát'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_NOT_CONFIDENT');
  end if;

  if v_best_count > 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Nhiều lớp có mức khớp ngang nhau, cần đối soát tay'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_AMOUNT_AMBIGUOUS');
  end if;

  v_fee := coalesce(v_best.fee, 0);
  v_apply_sessions := case
    when coalesce(v_best.pend, 0) > 0 and v_txn.amount_vnd >= coalesce(v_best.pend, 0) * v_fee then coalesce(v_best.pend, 0)
    when coalesce(v_best.pend, 0) > 0 and v_txn.amount_vnd < coalesce(v_best.pend, 0) * v_fee then floor(v_txn.amount_vnd::numeric / v_fee::numeric)::integer
    else 0
  end;
  v_apply_sessions := least(greatest(coalesce(v_apply_sessions, 0), 0), greatest(coalesce(v_best.pend, 0), 0));
  v_applied_amount := v_apply_sessions * v_fee;
  v_prepaid_topup := greatest(0, coalesce(v_txn.amount_vnd, 0) - v_applied_amount);

  if v_apply_sessions < 1 and v_prepaid_topup < 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        matched_class_name = v_best.class_name,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Số tiền CK không đủ ghi nhận buổi hoặc học phí dư'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'AMOUNT_TOO_SMALL');
  end if;

  insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
  values (v_student_id, v_best.class_name, v_apply_sessions, v_prepaid_topup)
  on conflict (student_id, class_name)
  do update set
    charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
    prepaid_balance_vnd = coalesce(public.student_tuition_by_class.prepaid_balance_vnd, 0) + excluded.prepaid_balance_vnd,
    updated_at = now();

  perform public.fn_sync_student_tuition_total(v_student_id);

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
    case when v_fee > 0 then floor(coalesce(v_txn.amount_vnd, 0)::numeric / v_fee::numeric)::integer else v_apply_sessions end,
    v_apply_sessions,
    coalesce(v_txn.amount_vnd, 0),
    v_prepaid_topup,
    coalesce(v_txn.occurred_at, now()),
    'bank_auto',
    v_best.class_name,
    'Auto CK: match ' || coalesce(v_match_method, 'unknown') ||
      ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
      case when v_prepaid_topup > 0 then ' · trừ nợ trước, dư vào trả trước' else ' · trừ nợ' end,
    v_txn.id
  )
  returning id into v_payment_id;

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      matched_class_name = v_best.class_name,
      match_confidence = v_match_confidence,
      match_score = v_match_score,
      match_method = v_match_method,
      match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
      reconcile_note = 'Auto: match ' || coalesce(v_match_method, 'unknown') ||
        ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
        ' · lớp ' || v_best.class_name ||
        case when v_prepaid_topup > 0 then ' · dư ' || replace(to_char(v_prepaid_topup, 'FM999G999G999'), ',', '.') || ' VND vào trả trước' else '' end,
      extracted_sessions = v_apply_sessions,
      applied_sessions = v_apply_sessions,
      applied_amount_vnd = coalesce(v_txn.amount_vnd, 0),
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
    'class_name', v_best.class_name,
    'sessions', v_apply_sessions,
    'amount_vnd', coalesce(v_txn.amount_vnd, 0),
    'prepaid_topup_vnd', v_prepaid_topup,
    'payment_history_id', v_payment_id
  );
exception when others then
  update public.bank_transactions
  set status = 'error',
      error_note = sqlerrm
  where id = p_txn_id;
  return jsonb_build_object('ok', false, 'reason', 'EXCEPTION', 'message', sqlerrm);
end $$;

grant execute on function public.bank_match_clean_transfer_text(text) to service_role;
grant execute on function public.match_students_from_transfer_content(text) to service_role;
grant execute on function public.match_student_from_transfer_content(text) to service_role;
grant execute on function public.fn_auto_apply_bank_transaction(bigint) to service_role;
grant execute on function public.fn_auto_apply_bank_transaction(bigint) to authenticated;

notify pgrst, 'reload schema';
