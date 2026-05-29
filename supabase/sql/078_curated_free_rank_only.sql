-- =============================================================================
-- 078 - Treat only ranked curated exam files as Free
-- =============================================================================

-- Retire legacy free flags. The student portal free set is controlled by
-- free_group + group_free_rank, not by a stale access_tier='free' value.
update public.exam_files
set access_tier = 'premium',
    free_group = null,
    free_rank = null,
    group_free_rank = null
where subject = 'english'
  and coalesce(category, '') <> 'answer'
  and coalesce(access_tier, '') = 'free'
  and not (
    free_group in ('entrance_10', 'university', 'ielts')
    and coalesce(group_free_rank, 0) >= 1
  );

-- Stop using the legacy global free_rank column for student portal access.
update public.exam_files
set free_rank = null
where subject = 'english'
  and coalesce(category, '') <> 'answer';

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
      and e.free_group in ('entrance_10', 'university', 'ielts')
      and coalesce(e.group_free_rank, 0) >= 1
  );
$$;

create or replace function public.set_exam_free_rank(
  p_exam_id uuid,
  p_free_rank integer default null,
  p_free_group text default 'entrance_10'
)
returns table (
  exam_id uuid,
  free_rank integer,
  free_group text,
  group_free_rank integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_group text := case
    when lower(trim(coalesce(p_free_group, 'entrance_10'))) in ('university', 'ielts')
      then lower(trim(coalesce(p_free_group, 'entrance_10')))
    else 'entrance_10'
  end;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'admin'
  ) then
    raise exception 'admin_required';
  end if;

  if p_free_rank is not null and p_free_rank < 1 then
    raise exception 'invalid_free_rank';
  end if;

  if p_free_rank is not null then
    update public.exam_files ef
    set group_free_rank = null,
        free_group = null,
        free_rank = null,
        access_tier = 'premium'
    where ef.free_group = v_group
      and ef.group_free_rank = p_free_rank
      and ef.id <> p_exam_id;
  end if;

  update public.exam_files ef
  set group_free_rank = p_free_rank,
      free_group = case when p_free_rank is not null then v_group else null end,
      free_rank = null,
      access_tier = case when p_free_rank is not null then 'free' else 'premium' end
  where ef.id = p_exam_id
    and ef.subject = 'english'
    and coalesce(ef.category, '') <> 'answer';

  if not found then
    raise exception 'exam_not_found';
  end if;

  return query
    select p_exam_id,
           p_free_rank,
           case when p_free_rank is not null then v_group else null end,
           p_free_rank;
end;
$$;

grant execute on function public.is_curated_free_exam(uuid) to authenticated;
grant execute on function public.set_exam_free_rank(uuid, integer, text) to authenticated;

notify pgrst, 'reload schema';
