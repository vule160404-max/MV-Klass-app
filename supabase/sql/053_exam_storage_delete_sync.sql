-- =============================================================================
-- 053 - Keep exam_files in sync when files are deleted from Storage
-- The student portal reads public.exam_files, so deleting only the Storage
-- object must also remove or detach its metadata row.
-- =============================================================================

create or replace function public.sync_exam_file_delete_from_storage()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if old.bucket_id <> 'exam-files' then
    return old;
  end if;

  -- If the main exam/topic file is deleted, remove the public row entirely.
  delete from public.exam_files
  where storage_path = old.name;

  -- If an attached answer/audio is deleted, keep the exam but remove that file.
  update public.exam_files
  set answer_url = null,
      answer_path = null
  where answer_path = old.name;

  update public.exam_files
  set audio_url = null,
      audio_path = null
  where audio_path = old.name;

  return old;
end;
$$;

drop trigger if exists trg_sync_exam_file_delete_from_storage on storage.objects;
create trigger trg_sync_exam_file_delete_from_storage
after delete
on storage.objects
for each row
execute function public.sync_exam_file_delete_from_storage();

-- One-time cleanup for metadata rows that point to already-deleted objects.
delete from public.exam_files e
where e.storage_path is not null
  and not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'exam-files'
      and o.name = e.storage_path
  );

update public.exam_files e
set answer_url = null,
    answer_path = null
where e.answer_path is not null
  and not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'exam-files'
      and o.name = e.answer_path
  );

update public.exam_files e
set audio_url = null,
    audio_path = null
where e.audio_path is not null
  and not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'exam-files'
      and o.name = e.audio_path
  );

notify pgrst, 'reload schema';
