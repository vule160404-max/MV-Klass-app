-- =============================================================================
-- 051 - Parse standard exam filenames
-- Supported examples:
--   "De 001 Vao 10 Thanh Hoa 2025.pdf"
--   "Dap an De 001 Vao 10 Thanh Hoa 2025.pdf"
--   "De 001 THPT Thanh Hoa 2025.pdf"
--
-- Note: "Vao 10" and "THPT" are two different level markers.
-- =============================================================================

alter table public.exam_files
  add column if not exists exam_code text,
  add column if not exists exam_sort_order integer;

create index if not exists exam_files_code_level_province_idx
  on public.exam_files (level, province, exam_sort_order, created_at desc);

create or replace function public.exam_file_normalized_text(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
begin
  s := lower(coalesce(p_path, ''));
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

create or replace function public.exam_file_guess_code(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  m text[];
begin
  m := regexp_match(public.exam_file_core_name(p_path), '^(de thi|de|exam)\s+([a-z0-9]+)', 'i');
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
  c := public.exam_file_guess_code(p_path);
  if c ~ '^[0-9]+$' then
    return c::integer;
  end if;
  return null;
end;
$$;

create or replace function public.exam_file_guess_level(p_path text)
returns text
language sql
immutable
as $$
  select case
    when public.exam_file_core_name(p_path) ~ '\m(thpt|qg|dai hoc|university|12)\M' then 'university'
    else 'entrance_10'
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
  m := regexp_match(public.exam_file_core_name(p_path), '((?:19|20)[0-9]{2})');
  if m is null then
    return null;
  end if;
  return m[1]::integer;
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
  province := regexp_replace(core, '^(de thi|de|exam)\s+[a-z0-9]+\s+', '', 'i');
  province := regexp_replace(province, '^(vao\s*10|thpt)\s+', '', 'i');
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
  province := public.exam_file_guess_province(p_path);
  y := public.exam_file_guess_year(p_path);
  if code is not null then
    return 'De ' || code || ' ' ||
      case when level = 'university' then 'THPT' else 'Vao 10' end ||
      coalesce(' ' || province, '') ||
      coalesce(' ' || y::text, '');
  end if;
  return initcap(public.exam_file_core_name(p_path));
end;
$$;

create or replace function public.exam_file_match_key(p_path text)
returns text
language sql
immutable
as $$
  select coalesce(public.exam_file_guess_code(p_path), '') || '|' ||
         coalesce(public.exam_file_guess_level(p_path), '') || '|' ||
         lower(coalesce(public.exam_file_guess_province(p_path), '')) || '|' ||
         coalesce(public.exam_file_guess_year(p_path)::text, '');
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
  v_folder := public.exam_file_base_folder(v_path);
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
    case when v_level = 'university' then 'Tài liệu luyện thi THPT Quốc Gia môn Tiếng Anh.'
         else 'Tài liệu luyện thi Tiếng Anh 9 lên 10.' end,
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
      is_published = true;

  return new;
end;
$$;

update public.exam_files
set title = public.exam_file_pretty_title(storage_path),
    level = public.exam_file_guess_level(storage_path),
    year = public.exam_file_guess_year(storage_path),
    province = public.exam_file_guess_province(storage_path),
    exam_code = public.exam_file_guess_code(storage_path),
    exam_sort_order = public.exam_file_guess_sort_order(storage_path)
where storage_path is not null
  and coalesce(public.exam_file_is_placeholder(storage_path), false) = false;

notify pgrst, 'reload schema';
