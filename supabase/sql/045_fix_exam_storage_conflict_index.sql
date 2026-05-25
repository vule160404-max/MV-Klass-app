-- =============================================================================
-- 045 - Fix exam Storage auto-sync ON CONFLICT target
-- The trigger in 044 uses `on conflict (storage_path)`, which requires a
-- non-partial unique index/constraint. A partial unique index causes Postgres
-- error 42P10 during Storage upload.
-- =============================================================================

drop index if exists public.exam_files_storage_path_uidx;

create unique index if not exists exam_files_storage_path_uidx
  on public.exam_files (storage_path);

notify pgrst, 'reload schema';
