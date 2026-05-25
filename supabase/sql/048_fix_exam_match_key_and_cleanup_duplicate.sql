-- =============================================================================
-- 048 - Improve exam file matching and clean duplicate row
-- Makes "dap an_de thi ..." match "de thi ..." by stripping both prefixes, then
-- re-attaches answer files and removes the mistaken duplicate under Untitled folder.
-- =============================================================================

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
  base := regexp_replace(base, '^(de\s*thi|đề\s*thi|exam)[\s_-]*', '', 'i');
  base := regexp_replace(base, '[-_]+', ' ', 'g');
  base := regexp_replace(base, '\s+', ' ', 'g');
  return btrim(base);
end;
$$;

update public.exam_files exam
set answer_url = ans.file_url,
    answer_path = ans.storage_path
from (
  select name as storage_path, file_url
  from storage.objects
  cross join lateral (
    select public.exam_file_public_url(name) as file_url
  ) u
  where bucket_id = 'exam-files'
    and public.exam_file_guess_category(name) = 'answer'
) ans
where exam.category in ('exam', 'topic')
  and (
    public.exam_file_base_folder(exam.storage_path) = public.exam_file_base_folder(ans.storage_path)
    or public.exam_file_match_key(exam.storage_path) = public.exam_file_match_key(ans.storage_path)
  )
  and (
    exam.answer_url is null
    or exam.answer_url = ''
    or exam.answer_path = ans.storage_path
  );

-- Remove the mistaken duplicate uploaded into "Untitled folder".
delete from public.exam_files
where storage_path = 'Untitled folder/de thi 01_vao 10_thanh hoa_2025.pdf';

notify pgrst, 'reload schema';
