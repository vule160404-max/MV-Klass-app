-- =============================================================================
-- 066 - Student portal signup + free/premium access
-- =============================================================================

alter table public.profiles
  add column if not exists portal_plan text not null default 'free';

alter table public.profiles
  drop constraint if exists profiles_portal_plan_check;

alter table public.profiles
  add constraint profiles_portal_plan_check
  check (portal_plan in ('free', 'premium'));

create index if not exists profiles_portal_plan_idx
  on public.profiles (role, portal_plan);

alter table public.exam_files
  add column if not exists access_tier text not null default 'free';

alter table public.exam_files
  drop constraint if exists exam_files_access_tier_check;

alter table public.exam_files
  add constraint exam_files_access_tier_check
  check (access_tier in ('free', 'premium'));

create index if not exists exam_files_access_tier_idx
  on public.exam_files (is_published, access_tier, level, year desc, created_at desc);

update public.exam_files
set access_tier = case
  when lower(coalesce(storage_path, '')) like 'premium/%'
    or lower(coalesce(answer_path, '')) like 'premium/%'
    or lower(coalesce(audio_path, '')) like 'premium/%'
    or lower(coalesce(storage_path, '')) like '%/premium/%'
    or lower(coalesce(category, '')) = 'topic'
  then 'premium'
  else 'free'
end;

create or replace function public.is_app_admin_or_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'teacher')
  );
$$;

create or replace function public.current_portal_plan()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.portal_plan
      from public.profiles p
      where p.id = auth.uid()
      limit 1
    ),
    'free'
  );
$$;

create or replace function public.student_free_exam_limit()
returns integer
language sql
immutable
as $$
  select 10;
$$;

create or replace function public.can_access_exam_file(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.exam_files e
    where e.id = p_exam_id
      and e.is_published = true
      and (
        public.is_app_admin_or_teacher()
        or public.current_portal_plan() = 'premium'
        or (
          e.access_tier = 'free'
          and e.id in (
            select f.id
            from public.exam_files f
            where f.is_published = true
              and f.access_tier = 'free'
              and f.subject = 'english'
              and f.category <> 'answer'
            order by f.level asc, f.year desc nulls last, f.province asc nulls last, f.exam_sort_order asc nulls last, f.created_at desc
            limit public.student_free_exam_limit()
          )
        )
      )
  );
$$;

create or replace function public.can_access_exam_storage(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.exam_files e
    where e.is_published = true
      and (
        e.storage_path = p_path
        or e.answer_path = p_path
        or e.audio_path = p_path
      )
      and public.can_access_exam_file(e.id)
  );
$$;

create or replace function public.exam_file_public_url(p_path text)
returns text
language sql
stable
as $$
  select 'https://vfabemdqfydjaookbzvm.supabase.co/storage/v1/object/authenticated/exam-files/' || ltrim(coalesce(p_path, ''), '/');
$$;

create or replace function public.sync_exam_file_from_storage()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_path text;
  v_url text;
  v_kind text;
  v_level text;
  v_year integer;
  v_folder text;
  v_exam_id uuid;
  v_access_tier text;
begin
  if new.bucket_id <> 'exam-files' then
    return new;
  end if;

  v_path := new.name;
  v_url := public.exam_file_public_url(v_path);
  v_kind := public.exam_file_guess_category(v_path);
  v_level := public.exam_file_guess_level(v_path);
  v_year := public.exam_file_guess_year(v_path);
  v_folder := public.exam_file_base_folder(v_path);
  v_access_tier := case
    when lower(coalesce(v_path, '')) like 'premium/%'
      or lower(coalesce(v_path, '')) like '%/premium/%'
      or v_kind = 'topic'
    then 'premium'
    else 'free'
  end;

  if v_kind = 'answer' then
    select id into v_exam_id
    from public.exam_files
    where storage_path is not null
      and public.exam_file_base_folder(storage_path) = v_folder
      and category in ('exam', 'topic')
    order by created_at desc
    limit 1;

    if v_exam_id is not null then
      update public.exam_files
      set answer_url = v_url,
          answer_path = v_path,
          access_tier = case when v_access_tier = 'premium' then 'premium' else access_tier end
      where id = v_exam_id;
      return new;
    end if;
  elsif v_kind = 'audio' then
    select id into v_exam_id
    from public.exam_files
    where storage_path is not null
      and public.exam_file_base_folder(storage_path) = v_folder
      and category in ('exam', 'topic')
    order by created_at desc
    limit 1;

    if v_exam_id is not null then
      update public.exam_files
      set audio_url = v_url,
          audio_path = v_path,
          access_tier = case when v_access_tier = 'premium' then 'premium' else access_tier end
      where id = v_exam_id;
      return new;
    end if;
  end if;

  insert into public.exam_files (
    title,
    level,
    subject,
    year,
    province,
    category,
    file_url,
    description,
    storage_path,
    access_tier,
    is_published
  )
  values (
    public.exam_file_pretty_title(v_path),
    v_level,
    'english',
    v_year,
    null,
    v_kind,
    v_url,
    case
      when v_level = 'university' then 'Tài liệu luyện thi THPT Quốc Gia môn Tiếng Anh.'
      else 'Tài liệu luyện thi Tiếng Anh 9 lên 10.'
    end,
    v_path,
    v_access_tier,
    true
  )
  on conflict (storage_path) do update
  set title = excluded.title,
      level = excluded.level,
      year = excluded.year,
      category = excluded.category,
      file_url = excluded.file_url,
      description = excluded.description,
      access_tier = excluded.access_tier,
      is_published = true;

  return new;
end;
$$;

drop policy if exists profiles_admin_teacher_select_all on public.profiles;
create policy profiles_admin_teacher_select_all
on public.profiles
for select
to authenticated
using (public.is_app_admin_or_teacher());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
on public.profiles
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists "exam_files_read_published" on public.exam_files;
create policy "exam_files_read_published"
on public.exam_files
for select
to authenticated
using (is_published = true);

update storage.buckets
set public = false
where id = 'exam-files';

drop policy if exists "exam_files_storage_read" on storage.objects;
create policy "exam_files_storage_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'exam-files'
  and public.can_access_exam_storage(name)
);

create or replace function public.increment_exam_download_count(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_access_exam_file(p_exam_id) then
    return;
  end if;

  update public.exam_files
  set download_count = coalesce(download_count, 0) + 1
  where id = p_exam_id
    and is_published = true;
end;
$$;

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

  if not public.can_access_exam_file(p_exam_id) then
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

grant select, update on public.profiles to authenticated;
grant execute on function public.current_portal_plan() to authenticated;
grant execute on function public.student_free_exam_limit() to authenticated;
grant execute on function public.can_access_exam_file(uuid) to authenticated;
grant execute on function public.can_access_exam_storage(text) to authenticated;

notify pgrst, 'reload schema';
