-- =============================================================================
-- 012 -- ghi chu nhan xet hoc luc hoc vien
-- =============================================================================

alter table public.students
  add column if not exists learning_note text;
