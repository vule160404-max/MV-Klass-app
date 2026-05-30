-- =============================================================================
-- 078 - Keep curated free exams and access_tier in sync
-- =============================================================================

update public.exam_files
set access_tier = case
  when lower(trim(coalesce(access_tier, ''))) = 'free' then 'free'
  else 'premium'
end
where access_tier is distinct from case
  when lower(trim(coalesce(access_tier, ''))) = 'free' then 'free'
  else 'premium'
end;

update public.exam_files
set access_tier = 'free'
where subject = 'english'
  and coalesce(category, '') <> 'answer'
  and free_group in ('entrance_10', 'university', 'ielts')
  and coalesce(group_free_rank, free_rank, 0) >= 1;

alter table public.exam_files
  alter column access_tier set default 'premium';

alter table public.exam_files
  alter column access_tier set not null;

alter table public.exam_files
  drop constraint if exists exam_files_access_tier_check;

alter table public.exam_files
  add constraint exam_files_access_tier_check
  check (access_tier in ('free', 'premium'));

create or replace function public.normalize_exam_file_access_tier()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.access_tier := case
    when lower(trim(coalesce(new.access_tier, ''))) = 'free' then 'free'
    else 'premium'
  end;

  if new.subject = 'english'
    and coalesce(new.category, '') <> 'answer'
    and new.free_group in ('entrance_10', 'university', 'ielts')
    and coalesce(new.group_free_rank, new.free_rank, 0) >= 1
  then
    new.access_tier := 'free';
  end if;

  return new;
end;
$$;

drop trigger if exists normalize_exam_file_access_tier on public.exam_files;

create trigger normalize_exam_file_access_tier
before insert or update of access_tier, free_group, group_free_rank, free_rank, subject, category
on public.exam_files
for each row
execute function public.normalize_exam_file_access_tier();

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
        access_tier = 'premium'
    where ef.free_group = v_group
      and ef.group_free_rank = p_free_rank
      and ef.id <> p_exam_id;
  end if;

  update public.exam_files ef
  set group_free_rank = p_free_rank,
      free_group = case when p_free_rank is not null then v_group else null end,
      access_tier = case when p_free_rank is not null then 'free' else 'premium' end
  where ef.id = p_exam_id
    and ef.subject = 'english'
    and coalesce(ef.category, '') <> 'answer';

  if not found then
    raise exception 'exam_not_found';
  end if;

  return query select p_exam_id, p_free_rank, case when p_free_rank is not null then v_group else null end, p_free_rank;
end;
$$;

grant execute on function public.set_exam_free_rank(uuid, integer, text) to authenticated;

notify pgrst, 'reload schema';
