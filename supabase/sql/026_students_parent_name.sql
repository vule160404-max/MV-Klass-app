-- =============================================================================
-- 014 -- ten phu huynh hoc vien (ho tro doi soat noi dung chuyen khoan)
-- =============================================================================

alter table public.students
  add column if not exists parent_name text;
