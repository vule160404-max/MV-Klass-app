-- =============================================================================
-- 073 - Cloudflare R2 support for student exam files
--
-- Keeps existing Supabase Storage files working while allowing new exam files
-- to be stored in a private Cloudflare R2 bucket and downloaded via signed URL.
-- =============================================================================

alter table public.exam_files
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists object_key text,
  add column if not exists answer_object_key text,
  add column if not exists audio_object_key text;

alter table public.exam_files
  drop constraint if exists exam_files_storage_provider_check;

alter table public.exam_files
  add constraint exam_files_storage_provider_check
  check (storage_provider in ('supabase', 'r2'));

create index if not exists exam_files_storage_provider_idx
  on public.exam_files (storage_provider, is_published, subject, access_tier);

create unique index if not exists exam_files_object_key_uidx
  on public.exam_files (object_key)
  where object_key is not null;

update public.exam_files
set storage_provider = 'supabase'
where storage_provider is null
   or storage_provider not in ('supabase', 'r2');

drop function if exists public.list_student_exam_files();

create function public.list_student_exam_files()
returns table (
  id uuid,
  title text,
  level text,
  subject text,
  year integer,
  province text,
  exam_code text,
  exam_sort_order integer,
  category text,
  storage_path text,
  answer_path text,
  audio_path text,
  access_tier text,
  free_rank integer,
  description text,
  download_count integer,
  created_at timestamptz,
  is_published boolean,
  can_access boolean,
  locked_reason text,
  free_group text,
  group_free_rank integer,
  storage_provider text,
  object_key text,
  answer_object_key text,
  audio_object_key text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    e.title,
    e.level,
    e.subject,
    e.year,
    e.province,
    e.exam_code,
    e.exam_sort_order,
    e.category,
    e.storage_path,
    e.answer_path,
    e.audio_path,
    e.access_tier,
    e.free_rank,
    e.description,
    e.download_count,
    e.created_at,
    e.is_published,
    public.can_access_exam_file(e.id) as can_access,
    public.student_exam_locked_reason(e.id, e.access_tier, e.free_rank) as locked_reason,
    e.free_group,
    e.group_free_rank,
    e.storage_provider,
    e.object_key,
    e.answer_object_key,
    e.audio_object_key
  from public.exam_files e
  where e.is_published = true
    and e.subject = 'english'
  order by e.level asc, e.year desc nulls last, e.province asc nulls last, e.exam_sort_order asc nulls last, e.created_at desc;
$$;

grant execute on function public.list_student_exam_files() to authenticated;

notify pgrst, 'reload schema';
