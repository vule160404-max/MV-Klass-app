-- =============================================================================
-- 047 - Ignore placeholder objects and match answer/audio to real exam rows
-- Fixes duplicate ghost rows created from `.emptyFolderPlaceholder` and improves
-- pairing when files are uploaded at bucket root or in the same folder.
-- =============================================================================

create or replace function public.exam_file_is_placeholder(p_path text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_path, '')) like '%/.emptyfolderplaceholder'
      or lower(coalesce(p_path, '')) = '.emptyfolderplaceholder';
$$;

create or replace function public.exam_file_match_key(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  base text;
begin
  base := lower(coalesce(p_path, ''));
  base := regexp_replace(base, '^.*/', '');
  base := regexp_replace(base, '\.[^.]+$', '');
  base := regexp_replace(base, '^(dap\s*an|đáp\s*án|answer)[\s_-]*', '', 'i');
  base := regexp_replace(base, '^(audio|listening|nghe)[\s_-]*', '', 'i');
  base := regexp_replace(base, '^(de\s*thi|đề\s*thi|exam)[\s_-]*', '', 'i');
  base := regexp_replace(base, '[-_]+', ' ', 'g');
  base := regexp_replace(base, '\s+', ' ', 'g');
  return btrim(base);
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
  v_match_key text;
begin
  if new.bucket_id <> 'exam-files' then
    return new;
  end if;

  v_path := new.name;
  if public.exam_file_is_placeholder(v_path) then
    return new;
  end if;

  v_url := public.exam_file_public_url(v_path);
  v_kind := public.exam_file_guess_category(v_path);
  v_level := public.exam_file_guess_level(v_path);
  v_year := public.exam_file_guess_year(v_path);
  v_folder := public.exam_file_base_folder(v_path);
  v_match_key := public.exam_file_match_key(v_path);

  if v_kind = 'answer' then
    select id into v_exam_id
    from public.exam_files
    where coalesce(public.exam_file_is_placeholder(storage_path), false) = false
      and category in ('exam', 'topic')
      and (
        public.exam_file_base_folder(storage_path) = v_folder
        or public.exam_file_match_key(storage_path) = v_match_key
      )
    order by
      case when public.exam_file_base_folder(storage_path) = v_folder then 0 else 1 end,
      created_at desc
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
    where coalesce(public.exam_file_is_placeholder(storage_path), false) = false
      and category in ('exam', 'topic')
      and (
        public.exam_file_base_folder(storage_path) = v_folder
        or public.exam_file_match_key(storage_path) = v_match_key
      )
    order by
      case when public.exam_file_base_folder(storage_path) = v_folder then 0 else 1 end,
      created_at desc
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

-- Remove ghost rows created from Storage placeholder files.
delete from public.exam_files
where public.exam_file_is_placeholder(storage_path);

-- Re-attach answer/audio files to the best matching real exam row, then remove
-- any remaining placeholder-created rows (already deleted above).
update public.exam_files ans
set answer_url = src.file_url,
    answer_path = src.storage_path
from public.exam_files src
where src.category = 'answer'
  and ans.category in ('exam', 'topic')
  and ans.id <> src.id
  and (
    public.exam_file_base_folder(ans.storage_path) = public.exam_file_base_folder(src.storage_path)
    or public.exam_file_match_key(ans.storage_path) = public.exam_file_match_key(src.storage_path)
  )
  and (ans.answer_url is null or ans.answer_url = '');

delete from public.exam_files
where category = 'answer';

update public.exam_files aud
set audio_url = src.file_url,
    audio_path = src.storage_path
from public.exam_files src
where src.category = 'audio'
  and aud.category in ('exam', 'topic')
  and aud.id <> src.id
  and (
    public.exam_file_base_folder(aud.storage_path) = public.exam_file_base_folder(src.storage_path)
    or public.exam_file_match_key(aud.storage_path) = public.exam_file_match_key(src.storage_path)
  )
  and (aud.audio_url is null or aud.audio_url = '');

delete from public.exam_files
where category = 'audio';

notify pgrst, 'reload schema';
