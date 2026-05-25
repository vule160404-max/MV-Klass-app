-- =============================================================================
-- 069 - Fix ambiguous free_rank reference in student portal curation RPC
-- =============================================================================

create or replace function public.set_exam_free_rank(
  p_exam_id uuid,
  p_free_rank integer default null
)
returns table (
  exam_id uuid,
  free_rank integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'admin'
  ) then
    raise exception 'admin_required';
  end if;

  if p_free_rank is not null and (p_free_rank < 1 or p_free_rank > public.student_free_exam_limit()) then
    raise exception 'invalid_free_rank';
  end if;

  if p_free_rank is not null then
    update public.exam_files ef
    set free_rank = null
    where ef.free_rank = p_free_rank
      and ef.id <> p_exam_id;
  end if;

  update public.exam_files ef
  set free_rank = p_free_rank,
      access_tier = case when p_free_rank is not null then 'free' else ef.access_tier end
  where ef.id = p_exam_id
    and ef.subject = 'english'
    and ef.category <> 'answer';

  if not found then
    raise exception 'exam_not_found';
  end if;

  return query select p_exam_id as exam_id, p_free_rank as free_rank;
end;
$$;

grant execute on function public.set_exam_free_rank(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
