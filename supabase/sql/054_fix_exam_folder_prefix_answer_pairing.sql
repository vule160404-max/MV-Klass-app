-- =============================================================================
-- 054 - Parse exam filenames by basename, not folder path
-- Fixes paths like:
--   vao-10/De 001 Vao 10 Thanh Hoa 2025.pdf
--   vao-10/Dap an De 001 Vao 10 Thanh Hoa 2025.pdf
-- where the folder prefix made the parser read "10" as the exam code and made
-- answer files appear as separate exam cards.
-- =============================================================================

create or replace function public.exam_file_normalized_text(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
begin
  s := lower(coalesce(p_path, ''));
  s := regexp_replace(s, '^.*/', '');
  s := regexp_replace(s, '\.[^.\/]+$', '');
  s := translate(
    s,
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
  );
  s := regexp_replace(s, '[/_-]+', ' ', 'g');
  s := regexp_replace(s, '\s+', ' ', 'g');
  return btrim(s);
end;
$$;

create or replace function public.exam_file_guess_category(p_path text)
returns text
language sql
immutable
as $$
  select case
    when public.exam_file_normalized_text(p_path) ~ '^(dap an|answer)\s+' then 'answer'
    when public.exam_file_normalized_text(p_path) ~ '^(audio|listening|nghe)\s+' then 'audio'
    when public.exam_file_normalized_text(p_path) ~ '(chuyen de|topic)' then 'topic'
    else 'exam'
  end;
$$;

create or replace function public.exam_file_core_name(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
begin
  s := public.exam_file_normalized_text(p_path);
  s := regexp_replace(s, '^(dap an|answer)\s+', '', 'i');
  s := regexp_replace(s, '^(audio|listening|nghe)\s+', '', 'i');
  return btrim(s);
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
  v_exam_id uuid;
  v_match_key text;
  v_code text;
  v_sort integer;
  v_province text;
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
  v_match_key := public.exam_file_match_key(v_path);
  v_code := public.exam_file_guess_code(v_path);
  v_sort := public.exam_file_guess_sort_order(v_path);
  v_province := public.exam_file_guess_province(v_path);

  if v_kind = 'answer' then
    select id into v_exam_id
    from public.exam_files
    where coalesce(public.exam_file_is_placeholder(storage_path), false) = false
      and category in ('exam', 'topic')
      and public.exam_file_match_key(storage_path) = v_match_key
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
    where coalesce(public.exam_file_is_placeholder(storage_path), false) = false
      and category in ('exam', 'topic')
      and public.exam_file_match_key(storage_path) = v_match_key
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
    title, level, subject, year, province, category, file_url, description,
    storage_path, exam_code, exam_sort_order, is_published
  )
  values (
    public.exam_file_pretty_title(v_path), v_level, 'english', v_year, v_province,
    v_kind, v_url,
    case when v_level = 'university' then 'Đề luyện thi THPT môn Tiếng Anh.'
         else 'Đề luyện thi Vào 10 môn Tiếng Anh.' end,
    v_path, v_code, v_sort, true
  )
  on conflict (storage_path) do update
  set title = excluded.title,
      level = excluded.level,
      year = excluded.year,
      province = excluded.province,
      category = excluded.category,
      file_url = excluded.file_url,
      description = excluded.description,
      exam_code = excluded.exam_code,
      exam_sort_order = excluded.exam_sort_order,
      is_published = true
  returning id into v_exam_id;

  -- If answer/audio were uploaded before the exam file, attach them now and
  -- remove their standalone metadata rows from the public listing table.
  update public.exam_files exam
  set answer_url = ans.file_url,
      answer_path = ans.storage_path
  from public.exam_files ans
  where exam.id = v_exam_id
    and ans.id <> exam.id
    and ans.category = 'answer'
    and public.exam_file_match_key(ans.storage_path) = public.exam_file_match_key(exam.storage_path);

  delete from public.exam_files ans
  where ans.category = 'answer'
    and public.exam_file_match_key(ans.storage_path) = v_match_key;

  update public.exam_files exam
  set audio_url = aud.file_url,
      audio_path = aud.storage_path
  from public.exam_files aud
  where exam.id = v_exam_id
    and aud.id <> exam.id
    and aud.category = 'audio'
    and public.exam_file_match_key(aud.storage_path) = public.exam_file_match_key(exam.storage_path);

  delete from public.exam_files aud
  where aud.category = 'audio'
    and public.exam_file_match_key(aud.storage_path) = v_match_key;

  return new;
end;
$$;

-- Reclassify and reparse existing rows after fixing basename parsing.
update public.exam_files
set title = public.exam_file_pretty_title(storage_path),
    level = public.exam_file_guess_level(storage_path),
    year = public.exam_file_guess_year(storage_path),
    province = public.exam_file_display_province(public.exam_file_guess_province(storage_path)),
    category = public.exam_file_guess_category(storage_path),
    exam_code = public.exam_file_guess_code(storage_path),
    exam_sort_order = public.exam_file_guess_sort_order(storage_path),
    file_url = public.exam_file_public_url(storage_path),
    is_published = true
where storage_path is not null
  and coalesce(public.exam_file_is_placeholder(storage_path), false) = false;

-- Attach answer files to their matching exam rows.
update public.exam_files exam
set answer_url = ans.file_url,
    answer_path = ans.storage_path
from public.exam_files ans
where ans.category = 'answer'
  and exam.category in ('exam', 'topic')
  and exam.id <> ans.id
  and public.exam_file_match_key(exam.storage_path) = public.exam_file_match_key(ans.storage_path);

delete from public.exam_files
where category = 'answer';

-- Attach audio files to their matching exam rows.
update public.exam_files exam
set audio_url = aud.file_url,
    audio_path = aud.storage_path
from public.exam_files aud
where aud.category = 'audio'
  and exam.category in ('exam', 'topic')
  and exam.id <> aud.id
  and public.exam_file_match_key(exam.storage_path) = public.exam_file_match_key(aud.storage_path);

delete from public.exam_files
where category = 'audio';

-- Hide duplicate exam metadata for the same logical paper. Keep the newest row.
delete from public.exam_files e
using public.exam_files keep
where e.id <> keep.id
  and e.category in ('exam', 'topic')
  and keep.category in ('exam', 'topic')
  and public.exam_file_match_key(e.storage_path) = public.exam_file_match_key(keep.storage_path)
  and (
    keep.created_at > e.created_at
    or (keep.created_at = e.created_at and keep.id::text > e.id::text)
  );

notify pgrst, 'reload schema';
