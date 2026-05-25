-- =============================================================================
-- 056 - Remove student exam recent-view tracking
-- Student portal now stores saved documents only, not recently opened files.
-- =============================================================================

drop index if exists public.student_exam_activity_user_opened_idx;

alter table public.student_exam_activity
  drop column if exists last_opened_at;

notify pgrst, 'reload schema';
