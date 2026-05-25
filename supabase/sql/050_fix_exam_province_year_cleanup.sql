-- =============================================================================
-- 050 - Remove year suffix from parsed province
-- PostgreSQL regex word-boundary handling can keep 2025 inside province text.
-- Use a simpler year pattern so "Thanh Hoa 2025" becomes "Thanh Hoa".
-- =============================================================================

create or replace function public.exam_file_guess_province(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  core text;
  m text[];
  province text;
begin
  core := public.exam_file_core_name(p_path);
  m := regexp_match(core, '(vao\s*10|vào\s*10|thpt|university)\s+(.+)$', 'i');
  if m is null then
    return null;
  end if;
  province := regexp_replace(m[2], '(19|20)[0-9]{2}', '', 'g');
  province := regexp_replace(province, '\s+', ' ', 'g');
  province := btrim(province);
  if province = '' then
    return null;
  end if;
  return initcap(province);
end;
$$;

update public.exam_files
set title = public.exam_file_pretty_title(storage_path),
    province = public.exam_file_guess_province(storage_path)
where storage_path is not null
  and coalesce(public.exam_file_is_placeholder(storage_path), false) = false;

notify pgrst, 'reload schema';
