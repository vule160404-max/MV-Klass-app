-- =============================================================================
-- 061 - Serialize exam/answer sync by logical match key
--
-- Supabase Storage can upload the exam and answer as separate near-simultaneous
-- transactions. Without a per-paper lock, both triggers can run before the
-- other transaction commits, leaving a published exam row with no answer_url.
--
-- This version takes a transaction advisory lock by match key so files for the
-- same logical paper are processed one at a time.
-- =============================================================================

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
  v_province := public.exam_file_display_province(public.exam_file_guess_province(v_path));

  perform pg_advisory_xact_lock(hashtextextended(v_match_key, 0));

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

  update public.exam_files exam
  set answer_url = ans.file_url,
      answer_path = ans.storage_path
  from public.exam_files ans
  where exam.id = v_exam_id
    and ans.id <> exam.id
    and ans.category = 'answer'
    and public.exam_file_match_key(ans.storage_path) = public.exam_file_match_key(exam.storage_path);

  update public.exam_files exam
  set answer_url = public.exam_file_public_url(obj.name),
      answer_path = obj.name
  from storage.objects obj
  where exam.id = v_exam_id
    and obj.bucket_id = 'exam-files'
    and public.exam_file_guess_category(obj.name) = 'answer'
    and public.exam_file_match_key(obj.name) = public.exam_file_match_key(exam.storage_path);

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

  update public.exam_files exam
  set audio_url = public.exam_file_public_url(obj.name),
      audio_path = obj.name
  from storage.objects obj
  where exam.id = v_exam_id
    and obj.bucket_id = 'exam-files'
    and public.exam_file_guess_category(obj.name) = 'audio'
    and public.exam_file_match_key(obj.name) = public.exam_file_match_key(exam.storage_path);

  delete from public.exam_files aud
  where aud.category = 'audio'
    and public.exam_file_match_key(aud.storage_path) = v_match_key;

  return new;
end;
$$;

update public.exam_files exam
set answer_url = public.exam_file_public_url(obj.name),
    answer_path = obj.name
from storage.objects obj
where exam.category in ('exam', 'topic')
  and obj.bucket_id = 'exam-files'
  and public.exam_file_guess_category(obj.name) = 'answer'
  and public.exam_file_match_key(obj.name) = public.exam_file_match_key(exam.storage_path);

update public.exam_files exam
set audio_url = public.exam_file_public_url(obj.name),
    audio_path = obj.name
from storage.objects obj
where exam.category in ('exam', 'topic')
  and obj.bucket_id = 'exam-files'
  and public.exam_file_guess_category(obj.name) = 'audio'
  and public.exam_file_match_key(obj.name) = public.exam_file_match_key(exam.storage_path);

delete from public.exam_files
where category in ('answer', 'audio');

notify pgrst, 'reload schema';
