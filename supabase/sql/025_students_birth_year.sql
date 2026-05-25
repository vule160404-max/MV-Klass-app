-- =============================================================================
-- 010 — bổ sung năm sinh cho học viên
-- =============================================================================

alter table public.students
  add column if not exists birth_year int;

alter table public.students
  drop constraint if exists students_birth_year_range_chk;

alter table public.students
  add constraint students_birth_year_range_chk
  check (
    birth_year is null
    or (birth_year between 1990 and (extract(year from now())::int + 1))
  );
