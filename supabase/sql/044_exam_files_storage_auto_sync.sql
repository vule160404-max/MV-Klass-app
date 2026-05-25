-- =============================================================================
-- 044 - Auto-sync uploaded Storage files into exam_files
-- Upload to Storage bucket `exam-files`; this trigger creates/updates rows so
-- admins do not need to manually insert exam_files records for common uploads.
-- =============================================================================

alter table public.exam_files
  add column if not exists storage_path text,
  add column if not exists answer_path text,
  add column if not exists audio_path text;

create unique index if not exists exam_files_storage_path_uidx
  on public.exam_files (storage_path)
  where storage_path is not null;

create or replace function public.exam_file_public_url(p_path text)
returns text
language sql
stable
as $$
  select 'https://vfabemdqfydjaookbzvm.supabase.co/storage/v1/object/public/exam-files/' || ltrim(coalesce(p_path, ''), '/');
$$;

create or replace function public.exam_file_guess_level(p_path text)
returns text
language sql
immutable
as $$
  select case
    when lower(coalesce(p_path, '')) ~ '(thpt|qg|dai[-_ ]?hoc|đại[-_ ]?học|university|12)' then 'university'
    else 'entrance_10'
  end;
$$;

create or replace function public.exam_file_guess_category(p_path text)
returns text
language sql
immutable
as $$
  select case
    when lower(coalesce(p_path, '')) ~ '(dap[-_ ]?an|đáp[-_ ]?án|answer)' then 'answer'
    when lower(coalesce(p_path, '')) ~ '(audio|listening|nghe)' then 'audio'
    when lower(coalesce(p_path, '')) ~ '(chuyen[-_ ]?de|chuyên[-_ ]?đề|topic)' then 'topic'
    else 'exam'
  end;
$$;

create or replace function public.exam_file_guess_year(p_path text)
returns integer
language plpgsql
immutable
as $$
declare
  m text[];
begin
  m := regexp_match(coalesce(p_path, ''), '(20[0-9]{2})');
  if m is null then
    return null;
  end if;
  return m[1]::integer;
end;
$$;

create or replace function public.exam_file_pretty_title(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  base text;
begin
  base := regexp_replace(coalesce(p_path, ''), '^.*/', '');
  base := regexp_replace(base, '\.[^.]+$', '');
  base := regexp_replace(base, '[-_]+', ' ', 'g');
  base := regexp_replace(base, '\s+', ' ', 'g');
  base := btrim(base);
  if base = '' then
    return 'Tài liệu Tiếng Anh';
  end if;
  return initcap(base);
end;
$$;

create or replace function public.exam_file_base_folder(p_path text)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_path, '') like '%/%' then regexp_replace(p_path, '/[^/]+$', '')
    else ''
  end;
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
          answer_path = v_path
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
          audio_path = v_path
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
    true
  )
  on conflict (storage_path) do update
  set title = excluded.title,
      level = excluded.level,
      year = excluded.year,
      category = excluded.category,
      file_url = excluded.file_url,
      description = excluded.description,
      is_published = true;

  return new;
end;
$$;

drop trigger if exists trg_sync_exam_file_from_storage on storage.objects;
create trigger trg_sync_exam_file_from_storage
after insert or update of name, bucket_id
on storage.objects
for each row
execute function public.sync_exam_file_from_storage();

notify pgrst, 'reload schema';
