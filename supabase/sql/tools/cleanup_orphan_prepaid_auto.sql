-- =============================================================================
-- Công cụ — Dọn prepaid_auto mồ côi khi KHÔNG còn điểm danh «có mặt» khớp ngày + lớp
--
-- Không nằm trong chuỗi migration số; chạy tay trên Supabase SQL Editor khi cần.
-- Yêu cầu đã triển khai 031 (fn_reverse_prepaid_auto_one, payment_history_student_id_to_uuid).
-- Đổi v_sid trong khối DO nếu cần học sinh khác.
-- =============================================================================

do $$
declare
  v_sid uuid := '1cda449b-e66a-4afb-9b52-d22c52d59104'::uuid;
  v_cn text;
  v_ph_lesson date;
  v_paid_at timestamptz;
  v_lesson date;
  v_ok boolean;
begin
  while exists (
    select 1
    from public.payment_history ph
    where ph.payment_channel = 'prepaid_auto'
      and public.payment_history_student_id_to_uuid(ph.student_id::text) = v_sid
      and not exists (
        select 1
        from public.attendance a
        where a.student_id = v_sid
          and a.status = 'present'
          and btrim(coalesce(a.class_name, '')) <> ''
          and a.date = coalesce(
            ph.attendance_lesson_date,
            (ph.paid_at at time zone 'Asia/Ho_Chi_Minh')::date
          )
          and public.normalize_lookup_text(a.class_name) =
            public.normalize_lookup_text(ph.class_name)
      )
  ) loop
    select ph.class_name, ph.attendance_lesson_date, ph.paid_at
    into v_cn, v_ph_lesson, v_paid_at
    from public.payment_history ph
    where ph.payment_channel = 'prepaid_auto'
      and public.payment_history_student_id_to_uuid(ph.student_id::text) = v_sid
      and not exists (
        select 1
        from public.attendance a
        where a.student_id = v_sid
          and a.status = 'present'
          and btrim(coalesce(a.class_name, '')) <> ''
          and a.date = coalesce(
            ph.attendance_lesson_date,
            (ph.paid_at at time zone 'Asia/Ho_Chi_Minh')::date
          )
          and public.normalize_lookup_text(a.class_name) =
            public.normalize_lookup_text(ph.class_name)
      )
    order by ph.paid_at, ph.id
    limit 1;

    exit when not found;

    v_lesson := coalesce(
      v_ph_lesson,
      (v_paid_at at time zone 'Asia/Ho_Chi_Minh')::date
    );

    v_ok := public.fn_reverse_prepaid_auto_one(
      v_sid,
      btrim(v_cn),
      v_lesson,
      true
    );

    exit when not v_ok;
  end loop;

  perform public.fn_sync_student_tuition_total(v_sid);
end $$;
