-- =============================================================================
-- 065 - Student portal activity analytics
-- Track per-account exam opens/downloads so admin analytics can inspect portal use.
-- =============================================================================

alter table public.student_exam_activity
  add column if not exists last_opened_at timestamptz,
  add column if not exists open_count integer not null default 0,
  add column if not exists last_downloaded_at timestamptz,
  add column if not exists download_count integer not null default 0;

create index if not exists student_exam_activity_user_opened_idx
  on public.student_exam_activity (user_id, last_opened_at desc);

create index if not exists student_exam_activity_activity_idx
  on public.student_exam_activity (updated_at desc, last_opened_at desc, last_downloaded_at desc);

drop policy if exists student_exam_activity_admin_teacher_select_all on public.student_exam_activity;
create policy student_exam_activity_admin_teacher_select_all
on public.student_exam_activity
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'teacher')
  )
);

create or replace function public.track_student_exam_activity(
  p_exam_id uuid,
  p_event text default 'open'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_event text := lower(trim(coalesce(p_event, 'open')));
begin
  if v_uid is null or p_exam_id is null then
    return;
  end if;

  if not exists (
    select 1
    from public.exam_files e
    where e.id = p_exam_id
      and e.is_published = true
  ) then
    return;
  end if;

  insert into public.student_exam_activity (
    user_id,
    exam_file_id,
    is_favorite,
    last_opened_at,
    open_count,
    last_downloaded_at,
    download_count
  )
  values (
    v_uid,
    p_exam_id,
    false,
    case when v_event in ('open', 'preview', 'view') then now() else null end,
    case when v_event in ('open', 'preview', 'view') then 1 else 0 end,
    case when v_event in ('download', 'download_file') then now() else null end,
    case when v_event in ('download', 'download_file') then 1 else 0 end
  )
  on conflict (user_id, exam_file_id)
  do update set
    last_opened_at = case
      when v_event in ('open', 'preview', 'view') then now()
      else student_exam_activity.last_opened_at
    end,
    open_count = student_exam_activity.open_count + case
      when v_event in ('open', 'preview', 'view') then 1
      else 0
    end,
    last_downloaded_at = case
      when v_event in ('download', 'download_file') then now()
      else student_exam_activity.last_downloaded_at
    end,
    download_count = student_exam_activity.download_count + case
      when v_event in ('download', 'download_file') then 1
      else 0
    end;
end;
$$;

grant execute on function public.track_student_exam_activity(uuid, text) to authenticated;

notify pgrst, 'reload schema';
