-- =============================================================================
-- 008 (tuỳ chọn) — Bật Realtime cho bảng chấm công giáo viên (subscribe INSERT/UPDATE)
-- Chỉ chạy nếu bạn cần client subscribe trực tiếp; app hiện tại dùng polling.
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.teacher_check_ins';
  end if;
exception
  when others then
    null; -- bảng đã nằm trong publication hoặc môi trường khác chuẩn
end $$;

notify pgrst, 'reload schema';
