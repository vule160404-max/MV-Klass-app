-- =============================================================================
-- 010 — Xác nhận thủ công đã nhận tiền / chưa nhận tiền (Biến động số dư)
-- Chạy migration này trên Supabase SQL Editor (hoặc pipeline deploy) trước khi
-- dùng nút "Đã nhận tiền" / "Chưa nhận tiền" trên giao diện admin.
-- =============================================================================

-- Mở rộng giá trị status (PostgreSQL đặt tên constraint kiểu bank_transactions_status_check)
alter table public.bank_transactions
  drop constraint if exists bank_transactions_status_check;

alter table public.bank_transactions
  add constraint bank_transactions_status_check
  check (
    status in (
      'pending',
      'needs_review',
      'applied',
      'ignored',
      'error',
      'manual_received',
      'manual_not_received'
    )
  );

create table if not exists public.student_tuition_by_class (
  student_id uuid not null references public.students(id) on delete cascade,
  class_name text not null,
  charged_sessions integer not null default 0 check (charged_sessions >= 0),
  updated_at timestamptz not null default now(),
  primary key (student_id, class_name)
);

alter table public.student_tuition_by_class enable row level security;

drop policy if exists student_tuition_by_class_admin_all on public.student_tuition_by_class;
create policy student_tuition_by_class_admin_all
  on public.student_tuition_by_class
  for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, update, delete on table public.student_tuition_by_class to authenticated;

alter table public.payment_history
  add column if not exists class_name text,
  add column if not exists reconcile_note text,
  add column if not exists bank_transaction_id bigint references public.bank_transactions(id) on delete set null;

alter table public.bank_transactions
  add column if not exists matched_class_name text,
  add column if not exists reconcile_note text;

create index if not exists idx_student_tuition_by_class_student
  on public.student_tuition_by_class(student_id);

create index if not exists idx_payment_history_bank_txn
  on public.payment_history(bank_transaction_id)
  where bank_transaction_id is not null;

create index if not exists idx_bank_transactions_matched_class
  on public.bank_transactions(matched_class_name, created_at desc)
  where matched_class_name is not null;

create or replace function public.fn_sync_student_tuition_total(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer := 0;
begin
  select coalesce(sum(stc.charged_sessions), 0)
  into v_total
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id;

  insert into public.student_tuition(student_id, charged_sessions)
  values (p_student_id, v_total)
  on conflict (student_id)
  do update set charged_sessions = excluded.charged_sessions;
end $$;

create or replace function public.fn_pending_sessions_for_class(p_student_id uuid, p_class_name text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_present integer := 0;
  v_charged integer := 0;
  v_class_norm text := public.normalize_lookup_text(p_class_name);
begin
  select count(*)
  into v_present
  from public.attendance a
  join public.students s on s.id = a.student_id
  where a.student_id = p_student_id
    and a.status = 'present'
    and (
      public.normalize_lookup_text(coalesce(a.class_name, '')) = v_class_norm
      or (
        a.class_name is null
        and public.normalize_lookup_text(coalesce(s.class_name, '')) = v_class_norm
      )
    );

  select coalesce(sum(stc.charged_sessions), 0)
  into v_charged
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id
    and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_class_norm;

  return greatest(v_present - v_charged, 0);
end $$;

-- Đổi chữ ký hàm nếu đã chạy bản cũ
drop function if exists public.fn_manual_confirm_bank_transaction(bigint, boolean);
drop function if exists public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid);

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

  if v_txn.status = 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_APPLIED');
  end if;

  -- Hoàn tác đúng bản ghi của chính giao dịch này (nếu từng áp dụng trước đó)
  if v_txn.applied_payment_history_id is not null then
    select *
    into v_ph
    from public.payment_history ph
    where ph.id = v_txn.applied_payment_history_id
      and coalesce(ph.bank_transaction_id, 0) = v_txn.id
    for update;

    if found then
      if v_ph.class_name is not null and btrim(v_ph.class_name) <> '' then
        update public.student_tuition_by_class stc
        set charged_sessions = greatest(coalesce(stc.charged_sessions, 0) - coalesce(v_ph.sessions_paid, 0), 0)
        where stc.student_id = v_ph.student_id::uuid
          and stc.class_name = v_ph.class_name;
      end if;
      delete from public.payment_history where id = v_ph.id;
      perform public.fn_sync_student_tuition_total(v_ph.student_id::uuid);
    end if;
  end if;

  if coalesce(p_received, false) then
    if p_matched_student_id is null then
      return jsonb_build_object('ok', false, 'reason', 'STUDENT_REQUIRED');
    end if;
    if v_class = '' then
      return jsonb_build_object('ok', false, 'reason', 'CLASS_REQUIRED');
    end if;
    if not exists (
      select 1
      from public.students s
      where s.id = p_matched_student_id::uuid
        and (
          s.class_name = v_class
          or v_class = any(coalesce(s.class_names, '{}'::text[]))
        )
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

    v_sessions := coalesce(v_txn.extracted_sessions, public.extract_sessions_from_transfer_content(v_txn.transfer_content));
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
      do update set charged_sessions = public.student_tuition_by_class.charged_sessions + excluded.charged_sessions;

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
      -- Vẫn cho phép xác nhận đã nhận tiền, nhưng không ghi thêm học phí khi lớp đã không còn buổi nợ.
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

-- Wrapper tương thích chữ ký cũ (3 tham số) -> hàm mới (4 tham số)
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

grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid, text) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid, text) to authenticated;
grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid) to service_role;
grant execute on function public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid) to authenticated;

-- RPC ổn định cho frontend: tránh ambiguity do overload chữ ký cũ.
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

-- Không chạy lại đối soát tự động khi admin đã xác nhận chưa nhận tiền.
-- Đối với học sinh học nhiều lớp, ưu tiên lớp có số tiền nợ khớp chính xác amount chuyển khoản.
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
  v_class text := '';
  v_selected_class text := '';
  v_fee integer := 0;
  v_pending integer := 0;
  v_pending_amount integer := 0;
  v_exact_match_count integer := 0;
  v_apply_sessions integer := 0;
  v_applied_amount integer := 0;
  v_payment_id bigint;
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
  ) u;

  if coalesce(array_length(v_classes, 1), 0) = 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Học sinh chưa có lớp để đối soát'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_CLASS_FOR_STUDENT');
  end if;

  foreach v_class in array v_classes loop
    select coalesce(cf.fee_amount, 0)
    into v_fee
    from public.class_fees cf
    where cf.class_name = v_class
    limit 1;

    if v_fee <= 0 then
      continue;
    end if;

    v_pending := public.fn_pending_sessions_for_class(v_student_id, v_class);
    if v_pending < 1 then
      continue;
    end if;

    v_pending_amount := v_pending * v_fee;
    if v_pending_amount = v_txn.amount_vnd then
      v_exact_match_count := v_exact_match_count + 1;
      v_selected_class := v_class;
      v_apply_sessions := v_pending;
      v_applied_amount := v_pending_amount;
    end if;
  end loop;

  if v_exact_match_count = 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Không xác định được lớp phù hợp theo số tiền chuyển khoản'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_AMOUNT_NOT_MATCHED');
  end if;

  if v_exact_match_count > 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Có nhiều lớp cùng khớp số tiền, cần admin xác nhận'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CLASS_AMOUNT_AMBIGUOUS');
  end if;

  if v_apply_sessions < 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        error_note = 'Lớp khớp tiền nhưng không còn buổi nợ để áp dụng'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_PENDING_SESSIONS');
  end if;

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
    'Tự đối soát: ưu tiên lớp có số tiền nợ khớp chính xác',
    v_txn.id
  )
  returning id into v_payment_id;

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      matched_class_name = v_selected_class,
      reconcile_note = 'Auto-match theo số tiền lớp ' || v_selected_class,
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
    'payment_history_id', v_payment_id
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
