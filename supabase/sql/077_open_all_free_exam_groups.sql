-- =============================================================================
-- 077 - Open all curated free exam groups to active student accounts
-- =============================================================================

create or replace function public.is_curated_free_exam(p_exam_id uuid)
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
      and e.access_tier = 'free'
      and e.subject = 'english'
      and coalesce(e.category, '') <> 'answer'
      and (
        coalesce(e.storage_provider, '') <> 'r2'
        or coalesce(e.group_free_rank, e.free_rank, 0) >= 1
        or lower(coalesce(nullif(e.object_key, ''), nullif(e.storage_path, ''), e.title, '')) like '%free%'
      )
  );
$$;

grant execute on function public.is_curated_free_exam(uuid) to authenticated;

notify pgrst, 'reload schema';
