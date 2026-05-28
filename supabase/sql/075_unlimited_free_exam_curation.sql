-- =============================================================================
-- 075 - Unlimited grouped free exam curation
-- =============================================================================

alter table public.exam_files
  drop constraint if exists exam_files_group_free_rank_check;

alter table public.exam_files
  add constraint exam_files_group_free_rank_check
  check (group_free_rank is null or group_free_rank >= 1);

create or replace function public.is_curated_free_exam(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with my_group as (
    select public.current_portal_free_group() as g
  ),
  curated as (
    select e.id
    from public.exam_files e, my_group
    where e.is_published = true
      and e.access_tier = 'free'
      and e.subject = 'english'
      and e.category <> 'answer'
      and e.free_group = my_group.g
      and e.group_free_rank >= 1
  ),
  fallback as (
    select e.id
    from public.exam_files e, my_group
    where e.is_published = true
      and e.access_tier = 'free'
      and e.subject = 'english'
      and e.category <> 'answer'
      and (
        (my_group.g = 'university' and e.level = 'university')
        or (my_group.g = 'ielts' and e.level = 'ielts')
        or (my_group.g = 'entrance_10' and coalesce(e.level, '') not in ('university', 'ielts'))
      )
    order by e.year desc nulls last, e.province asc nulls last, e.exam_sort_order asc nulls last, e.created_at desc
    limit 5
  )
  select exists (
    select 1
    from (
      select id from curated
      union all
      select id from fallback where not exists (select 1 from curated)
    ) x
    where x.id = p_exam_id
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
        free_group = null
    where ef.free_group = v_group
      and ef.group_free_rank = p_free_rank
      and ef.id <> p_exam_id;
  end if;

  update public.exam_files ef
  set group_free_rank = p_free_rank,
      free_group = case when p_free_rank is not null then v_group else null end,
      access_tier = case when p_free_rank is not null then 'free' else ef.access_tier end
  where ef.id = p_exam_id
    and ef.subject = 'english'
    and ef.category <> 'answer';

  if not found then
    raise exception 'exam_not_found';
  end if;

  return query select p_exam_id, p_free_rank, case when p_free_rank is not null then v_group else null end, p_free_rank;
end;
$$;

grant execute on function public.is_curated_free_exam(uuid) to authenticated;
grant execute on function public.set_exam_free_rank(uuid, integer, text) to authenticated;

notify pgrst, 'reload schema';
