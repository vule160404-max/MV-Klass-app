-- =============================================================================
-- 058 - Official vs mock exam names
--
-- Upload filename convention:
--   Official: De chinh thuc Vao 10 Thanh Hoa 2025.pdf
--   Mock:     De 001 Vao 10 Thanh Hoa 2025.pdf
--
-- Answer/audio follow the same prefix rule:
--   Dap an De chinh thuc Vao 10 Thanh Hoa 2025.pdf
--   Dap an De 001 Vao 10 Thanh Hoa 2025.pdf
-- =============================================================================

create or replace function public.exam_file_is_official(p_path text)
returns boolean
language sql
immutable
as $$
  select public.exam_file_core_name(p_path) ~ '\m(chinh thuc|official)\M';
$$;

create or replace function public.exam_file_guess_code(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  m text[];
begin
  if public.exam_file_is_official(p_path) then
    return 'CHINH_THUC';
  end if;

  m := regexp_match(public.exam_file_core_name(p_path), '^(de thi|de|exam|de minh hoa|minh hoa|mock)\s+([a-z0-9]+)', 'i');
  if m is null then
    m := regexp_match(public.exam_file_core_name(p_path), '\s([0-9]{1,4})\s');
  end if;
  if m is null then
    return null;
  end if;
  return upper(m[array_length(m, 1)]);
end;
$$;

create or replace function public.exam_file_guess_sort_order(p_path text)
returns integer
language plpgsql
immutable
as $$
declare
  c text;
begin
  if public.exam_file_is_official(p_path) then
    return 0;
  end if;

  c := public.exam_file_guess_code(p_path);
  if c ~ '^[0-9]+$' then
    return c::integer;
  end if;
  return null;
end;
$$;

create or replace function public.exam_file_guess_province(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  core text;
  province text;
begin
  core := public.exam_file_core_name(p_path);
  province := regexp_replace(core, '^(de thi|de|exam)\s+(chinh thuc|official)\s+', '', 'i');
  province := regexp_replace(province, '^(de thi|de|exam|de minh hoa|minh hoa|mock)\s+[a-z0-9]+\s+', '', 'i');
  province := regexp_replace(province, '^(vao\s*10|thpt|qg|dai hoc|university|12)\s+', '', 'i');
  province := regexp_replace(province, '(19|20)[0-9]{2}', '', 'g');
  province := regexp_replace(province, '\s+', ' ', 'g');
  province := btrim(province);
  if province = '' then
    return null;
  end if;
  return initcap(province);
end;
$$;

create or replace function public.exam_file_pretty_title(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  code text;
  level text;
  province text;
  y integer;
begin
  code := public.exam_file_guess_code(p_path);
  level := public.exam_file_guess_level(p_path);
  province := public.exam_file_display_province(public.exam_file_guess_province(p_path));
  y := public.exam_file_guess_year(p_path);

  if public.exam_file_is_official(p_path) then
    return 'Đề chính thức ' ||
      case when level = 'university' then 'THPT' else 'Vào 10' end ||
      coalesce(' ' || province, '') ||
      coalesce(' ' || y::text, '');
  end if;

  if code is not null then
    return 'Đề ' || code || ' ' ||
      case when level = 'university' then 'THPT' else 'Vào 10' end ||
      coalesce(' ' || province, '') ||
      coalesce(' ' || y::text, '');
  end if;

  return initcap(public.exam_file_core_name(p_path));
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
  v_province := public.exam_file_display_province(public.exam_file_guess_province(v_path));

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

notify pgrst, 'reload schema';
