-- =============================================================================
-- 031 — Gói prepaid + điểm danh (một file triển khai đủ)
--
-- Gồm: payment_history.attendance_lesson_date; fn_pending_sessions_for_class_strict;
-- fn_pending_sessions_for_class (class_names); payment_history_student_id_to_uuid;
-- fn_reverse_prepaid_auto_resolve_class_for_lesson; fn_reverse_prepaid_auto_one;
-- fn_apply_prepaid_consumption (fee fallback payment_history, rebalance charged khi
-- đã thu trước prepaid, pool prepaid theo norm); trigger AFTER INSERT/UPDATE/DELETE;
-- rpc_apply_prepaid_for_lesson (app gọi dự phòng).
--
-- Chạy sau 021 (tuition prepaid columns). Idempotent (CREATE OR REPLACE).
-- Cuối file: notify pgrst.
-- =============================================================================

alter table public.payment_history
  add column if not exists attendance_lesson_date date;

comment on column public.payment_history.attendance_lesson_date is
  'Ngày buổi học (attendance.date) khi prepaid_auto — dùng để hoàn tác khi hủy điểm danh.';

-- Đồng bộ với 030 — CREATE OR REPLACE để file 031 tự đủ khi triển khai một lần.
create or replace function public.fn_pending_sessions_for_class_strict(p_student_id uuid, p_class_name text)
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
  if p_student_id is null or v_class_norm is null or length(v_class_norm) < 1 then
    return 0;
  end if;

  select count(*)
  into v_present
  from public.attendance a
  where a.student_id = p_student_id
    and a.status = 'present'
    and btrim(coalesce(a.class_name, '')) <> ''
    and public.normalize_lookup_text(a.class_name) = v_class_norm;

  select coalesce(sum(stc.charged_sessions), 0)
  into v_charged
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id
    and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_class_norm;

  return greatest(v_present - v_charged, 0);
end $$;

-- Đếm nợ buổi «lỏng» (đồng bộ prepaid với thu TM / TT). 037 cập nhật: class_names + guard null.
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
  if p_student_id is null or v_class_norm is null or length(v_class_norm) < 1 then
    return 0;
  end if;

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
        and (
          public.normalize_lookup_text(coalesce(s.class_name, '')) = v_class_norm
          or exists (
            select 1
            from unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
            where public.normalize_lookup_text(btrim(u.cn)) = v_class_norm
          )
        )
      )
    );

  select coalesce(sum(stc.charged_sessions), 0)
  into v_charged
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id
    and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_class_norm;

  return greatest(v_present - v_charged, 0);
end $$;

-- payment_history.student_id có thể là text — không làm fail cả transaction điểm danh khi dữ liệu bẩn.
create or replace function public.payment_history_student_id_to_uuid(p_raw text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_raw is null or btrim(p_raw) = '' then
    return null;
  end if;
  return btrim(p_raw)::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

-- Khi xóa/đổi điểm danh mà dòng attendance.class_name rỗng, vẫn tìm lớp từ phiếu prepaid_auto cùng ngày buổi để hoàn tác.
create or replace function public.fn_reverse_prepaid_auto_resolve_class_for_lesson(
  p_student_id uuid,
  p_lesson_date date
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select btrim(ph.class_name::text)
  from public.payment_history ph
  where ph.payment_channel = 'prepaid_auto'
    and public.payment_history_student_id_to_uuid(ph.student_id::text) = p_student_id
    and (
      ph.attendance_lesson_date = p_lesson_date
      or (
        ph.attendance_lesson_date is null
        and (ph.paid_at at time zone 'Asia/Ho_Chi_Minh')::date = p_lesson_date
      )
    )
    and btrim(coalesce(ph.class_name, '')) <> ''
  order by ph.paid_at desc nulls last, ph.id desc
  limit 1;
$$;

drop trigger if exists trg_attendance_prepaid_after on public.attendance;
drop function if exists public.fn_apply_prepaid_consumption(uuid, text);
drop function if exists public.fn_apply_prepaid_consumption(uuid, text, date);

create or replace function public.fn_reverse_prepaid_auto_one(
  p_student_id uuid,
  p_class_name text,
  p_lesson_date date,
  p_restore_prepaid boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_raw text := btrim(coalesce(p_class_name, ''));
  v_norm text;
  v_ph public.payment_history%rowtype;
  v_sess integer := 0;
  v_cn text := '';
begin
  if p_student_id is null or v_class_raw = '' or p_lesson_date is null then
    return false;
  end if;

  v_norm := public.normalize_lookup_text(v_class_raw);
  if v_norm is null or length(v_norm) < 1 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_student_id::text), hashtext(v_norm));

  select ph.*
  into v_ph
  from public.payment_history ph
  where ph.payment_channel = 'prepaid_auto'
    and public.payment_history_student_id_to_uuid(ph.student_id::text) = p_student_id
    and public.normalize_lookup_text(coalesce(ph.class_name, '')) = v_norm
    and (
      ph.attendance_lesson_date = p_lesson_date
      or (
        ph.attendance_lesson_date is null
        and (ph.paid_at at time zone 'Asia/Ho_Chi_Minh')::date = p_lesson_date
      )
    )
  order by ph.paid_at desc, ph.id desc
  limit 1;

  if not found then
    return false;
  end if;

  v_sess := greatest(
    1,
    coalesce(v_ph.sessions_applied_to_charged, v_ph.sessions_paid, 1)
  );
  v_cn := btrim(coalesce(v_ph.class_name, ''));

  if v_cn = '' then
    return false;
  end if;

  update public.student_tuition_by_class stc
  set
    charged_sessions = greatest(0, coalesce(stc.charged_sessions, 0) - v_sess),
    prepaid_balance_vnd = case
      when p_restore_prepaid then
        greatest(0, coalesce(stc.prepaid_balance_vnd, 0) + coalesce(v_ph.amount_vnd, 0))
      else stc.prepaid_balance_vnd
    end,
    updated_at = now()
  where stc.student_id = p_student_id
    and stc.class_name = v_cn;

  delete from public.payment_history where id = v_ph.id;

  perform public.fn_sync_student_tuition_total(p_student_id);
  return true;
end;
$$;

create or replace function public.fn_apply_prepaid_consumption(
  p_student_id uuid,
  p_class_name text,
  p_lesson_date date
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
  v_prepaid_total integer := 0;
  v_stc_class text := '';
  v_remain integer := 0;
  v_take integer := 0;
  v_sum_charged integer := 0;
  v_has_prepaid_lesson boolean := false;
  v_has_present_lesson boolean := false;
  r record;
begin
  if p_student_id is null or v_class_raw = '' or p_lesson_date is null then
    return;
  end if;

  v_norm := public.normalize_lookup_text(v_class_raw);
  if v_norm is null or length(v_norm) < 1 then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_student_id::text), hashtext(v_norm));

  select coalesce(sum(greatest(0, coalesce(stc.prepaid_balance_vnd, 0))), 0)::integer
  into v_prepaid_total
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id
    and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_norm;

  select stc.class_name
  into v_stc_class
  from public.student_tuition_by_class stc
  where stc.student_id = p_student_id
    and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_norm
  order by
    coalesce(stc.charged_sessions, 0) desc,
    coalesce(stc.prepaid_balance_vnd, 0) desc,
    length(stc.class_name),
    stc.class_name
  limit 1;

  if v_stc_class is null or btrim(v_stc_class) = '' then
    select cf.class_name
    into v_stc_class
    from public.class_fees cf
    where public.normalize_lookup_text(coalesce(cf.class_name, '')) = v_norm
    order by length(cf.class_name) desc, cf.class_name
    limit 1;
  end if;

  if v_stc_class is null or btrim(v_stc_class) = '' then
    v_stc_class := v_class_raw;
  end if;

  select coalesce(cf.fee_amount, 0)
  into v_fee
  from public.class_fees cf
  where public.normalize_lookup_text(coalesce(cf.class_name, '')) = v_norm
  order by length(cf.class_name) desc, cf.class_name
  limit 1;

  if v_fee <= 0 then
    select coalesce(ph.amount_vnd, 0)
    into v_fee
    from public.payment_history ph
    where public.payment_history_student_id_to_uuid(ph.student_id::text) = p_student_id
      and public.normalize_lookup_text(coalesce(ph.class_name, '')) = v_norm
      and coalesce(ph.sessions_paid, 0) > 0
      and coalesce(ph.amount_vnd, 0) > 0
      and coalesce(ph.payment_channel, '') <> 'prepaid_auto'
    order by ph.paid_at desc nulls last, ph.id desc
    limit 1;
  end if;

  if v_fee <= 0 then
    return;
  end if;

  v_pending := public.fn_pending_sessions_for_class(p_student_id, v_stc_class);

  if v_pending < 1 and v_prepaid_total >= v_fee then
    select coalesce(sum(greatest(0, coalesce(stc.charged_sessions, 0))), 0)::integer
    into v_sum_charged
    from public.student_tuition_by_class stc
    where stc.student_id = p_student_id
      and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_norm;

    select exists (
      select 1
      from public.payment_history ph
      where ph.payment_channel = 'prepaid_auto'
        and public.payment_history_student_id_to_uuid(ph.student_id::text) = p_student_id
        and public.normalize_lookup_text(coalesce(ph.class_name, '')) = v_norm
        and (
          ph.attendance_lesson_date = p_lesson_date
          or (
            ph.attendance_lesson_date is null
            and (ph.paid_at at time zone 'Asia/Ho_Chi_Minh')::date = p_lesson_date
          )
        )
    )
    into v_has_prepaid_lesson;

    select exists (
      select 1
      from public.attendance a
      join public.students s on s.id = a.student_id
      where a.student_id = p_student_id
        and a.status = 'present'
        and a.date = p_lesson_date
        and (
          public.normalize_lookup_text(coalesce(a.class_name, '')) = v_norm
          or (
            a.class_name is null
            and (
              public.normalize_lookup_text(coalesce(s.class_name, '')) = v_norm
              or exists (
                select 1
                from unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
                where public.normalize_lookup_text(btrim(u.cn)) = v_norm
              )
            )
          )
        )
    )
    into v_has_present_lesson;

    if v_sum_charged > 0 and not v_has_prepaid_lesson and v_has_present_lesson then
      with pick as (
        select stc.class_name as cn
        from public.student_tuition_by_class stc
        where stc.student_id = p_student_id
          and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_norm
          and coalesce(stc.charged_sessions, 0) > 0
        order by coalesce(stc.charged_sessions, 0) desc, stc.class_name
        limit 1
      )
      update public.student_tuition_by_class stx
      set
        charged_sessions = greatest(0, coalesce(stx.charged_sessions, 0) - 1),
        updated_at = now()
      from pick
      where stx.student_id = p_student_id
        and stx.class_name = pick.cn;

      perform public.fn_sync_student_tuition_total(p_student_id);
      v_pending := public.fn_pending_sessions_for_class(p_student_id, v_stc_class);
    end if;
  end if;

  if v_pending < 1 then
    return;
  end if;

  if v_prepaid_total < v_fee then
    return;
  end if;

  insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
  values (p_student_id, v_stc_class, 1, 0)
  on conflict (student_id, class_name)
  do update set
    charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
    updated_at = now();

  v_remain := v_fee;
  for r in
    select stc.class_name as cn, coalesce(stc.prepaid_balance_vnd, 0) as bal
    from public.student_tuition_by_class stc
    where stc.student_id = p_student_id
      and public.normalize_lookup_text(coalesce(stc.class_name, '')) = v_norm
      and coalesce(stc.prepaid_balance_vnd, 0) > 0
    order by stc.prepaid_balance_vnd desc, stc.class_name
  loop
    exit when v_remain < 1;
    v_take := least(r.bal, v_remain);
    update public.student_tuition_by_class stx
    set
      prepaid_balance_vnd = greatest(0, coalesce(stx.prepaid_balance_vnd, 0) - v_take),
      updated_at = now()
    where stx.student_id = p_student_id
      and stx.class_name = r.cn;
    v_remain := v_remain - v_take;
  end loop;

  if v_remain > 0 then
    raise warning 'fn_apply_prepaid_consumption: còn % VND chưa trừ được prepaid (race?) — học sinh % lớp %',
      v_remain, p_student_id, v_stc_class;
  end if;

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
    reconcile_note,
    attendance_lesson_date
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
    'Tự động: trừ học phí trả trước (1 buổi · ' || v_fee::text || 'đ)',
    p_lesson_date
  );
end;
$$;

grant execute on function public.fn_apply_prepaid_consumption(uuid, text, date) to service_role;
grant execute on function public.fn_apply_prepaid_consumption(uuid, text, date) to authenticated;

create or replace function public.trg_attendance_prepaid_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_class text;
  v_new_class text;
begin
  if tg_op = 'DELETE' then
    if old.status = 'present' then
      v_old_class := nullif(btrim(coalesce(old.class_name, '')), '');
      if v_old_class is null and old.date is not null then
        v_old_class := nullif(
          btrim(public.fn_reverse_prepaid_auto_resolve_class_for_lesson(old.student_id, old.date)),
          ''
        );
      end if;
      if v_old_class is null and old.student_id is not null then
        select coalesce(
          nullif(btrim(coalesce(s.class_name, '')), ''),
          (
            select nullif(btrim(u.cn), '')
            from unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
            where btrim(u.cn) <> ''
            limit 1
          )
        )
        into v_old_class
        from public.students s
        where s.id = old.student_id
        limit 1;
      end if;
      if v_old_class is not null then
        perform public.fn_reverse_prepaid_auto_one(old.student_id, v_old_class, old.date, true);
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'present' then
      return new;
    end if;
    v_new_class := nullif(btrim(coalesce(new.class_name, '')), '');
    if v_new_class is null and new.student_id is not null then
      select coalesce(
        nullif(btrim(coalesce(s.class_name, '')), ''),
        (
          select nullif(btrim(u.cn), '')
          from unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
          where btrim(u.cn) <> ''
          limit 1
        )
      )
      into v_new_class
      from public.students s
      where s.id = new.student_id
      limit 1;
    end if;
    if v_new_class is null or btrim(v_new_class) = '' then
      return new;
    end if;
    perform public.fn_apply_prepaid_consumption(new.student_id, v_new_class, new.date);
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'present' then
      v_old_class := nullif(btrim(coalesce(old.class_name, '')), '');
      if v_old_class is null and old.date is not null then
        v_old_class := nullif(
          btrim(public.fn_reverse_prepaid_auto_resolve_class_for_lesson(old.student_id, old.date)),
          ''
        );
      end if;
      if v_old_class is null and old.student_id is not null then
        select coalesce(
          nullif(btrim(coalesce(s.class_name, '')), ''),
          (
            select nullif(btrim(u.cn), '')
            from unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
            where btrim(u.cn) <> ''
            limit 1
          )
        )
        into v_old_class
        from public.students s
        where s.id = old.student_id
        limit 1;
      end if;
      if v_old_class is not null then
        if new.status <> 'present'
          or nullif(btrim(coalesce(new.class_name, '')), '') is distinct from v_old_class
        then
          perform public.fn_reverse_prepaid_auto_one(old.student_id, v_old_class, old.date, true);
        end if;
      end if;
    end if;

    if new.status <> 'present' then
      return new;
    end if;

    v_new_class := nullif(btrim(coalesce(new.class_name, '')), '');
    if v_new_class is null and new.student_id is not null then
      select coalesce(
        nullif(btrim(coalesce(s.class_name, '')), ''),
        (
          select nullif(btrim(u.cn), '')
          from unnest(coalesce(s.class_names, '{}'::text[])) as u(cn)
          where btrim(u.cn) <> ''
          limit 1
        )
      )
      into v_new_class
      from public.students s
      where s.id = new.student_id
      limit 1;
    end if;
    if v_new_class is null or btrim(v_new_class) = '' then
      return new;
    end if;

    if old.status = 'present'
      and new.status = 'present'
      and coalesce(old.class_name, '') = coalesce(new.class_name, '')
      and old.student_id = new.student_id
      and old.date = new.date
    then
      return new;
    end if;

    perform public.fn_apply_prepaid_consumption(new.student_id, v_new_class, new.date);
    return new;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_attendance_prepaid_after on public.attendance;
create trigger trg_attendance_prepaid_after
after insert or update or delete on public.attendance
for each row execute procedure public.trg_attendance_prepaid_after();

-- RPC idempotent: app gọi sau POST attendance (dự phòng trigger). Trùng logic với trigger → pending=0 thì thoát.
create or replace function public.rpc_apply_prepaid_for_lesson(
  p_student_id uuid,
  p_class_name text,
  p_lesson_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_student_id is null or p_lesson_date is null then
    return;
  end if;
  perform public.fn_apply_prepaid_consumption(
    p_student_id,
    btrim(coalesce(p_class_name, '')),
    p_lesson_date
  );
end;
$$;

grant execute on function public.rpc_apply_prepaid_for_lesson(uuid, text, date) to authenticated;
grant execute on function public.rpc_apply_prepaid_for_lesson(uuid, text, date) to service_role;

notify pgrst, 'reload schema';
