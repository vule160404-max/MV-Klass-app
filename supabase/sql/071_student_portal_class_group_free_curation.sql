-- =============================================================================
-- 071 - Student portal class group and grouped free exam curation
-- =============================================================================

alter table public.profiles
  add column if not exists portal_free_group text not null default 'entrance_10',
  add column if not exists portal_class_label text;

alter table public.profiles
  drop constraint if exists profiles_portal_free_group_check;

alter table public.profiles
  add constraint profiles_portal_free_group_check
  check (portal_free_group in ('entrance_10', 'university'));

create index if not exists profiles_portal_free_group_idx
  on public.profiles (role, portal_free_group, portal_status, portal_plan);

alter table public.exam_files
  add column if not exists free_group text,
  add column if not exists group_free_rank integer;

alter table public.exam_files
  drop constraint if exists exam_files_free_group_check;

alter table public.exam_files
  add constraint exam_files_free_group_check
  check (free_group is null or free_group in ('entrance_10', 'university'));

alter table public.exam_files
  drop constraint if exists exam_files_group_free_rank_check;

alter table public.exam_files
  add constraint exam_files_group_free_rank_check
  check (group_free_rank is null or group_free_rank between 1 and 5);

drop index if exists exam_files_group_free_rank_unique_idx;
create unique index exam_files_group_free_rank_unique_idx
  on public.exam_files (free_group, group_free_rank)
  where free_group is not null
    and group_free_rank is not null
    and is_published = true
    and subject = 'english'
    and access_tier = 'free'
    and category <> 'answer';

with ranked as (
  select
    e.id,
    case when e.level = 'university' then 'university' else 'entrance_10' end as free_group,
    row_number() over (
      partition by case when e.level = 'university' then 'university' else 'entrance_10' end
      order by e.free_rank nulls last, e.year desc nulls last, e.province asc nulls last, e.exam_sort_order asc nulls last, e.created_at desc
    ) as rn
  from public.exam_files e
  where e.is_published = true
    and e.access_tier = 'free'
    and e.subject = 'english'
    and e.category <> 'answer'
    and (
      e.free_rank between 1 and 10
      or e.group_free_rank between 1 and 5
    )
)
update public.exam_files e
set free_group = ranked.free_group,
    group_free_rank = ranked.rn
from ranked
where e.id = ranked.id
  and ranked.rn between 1 and 5
  and e.group_free_rank is null
  and not exists (
    select 1
    from public.exam_files x
    where x.id <> e.id
      and x.free_group = ranked.free_group
      and x.group_free_rank = ranked.rn
      and x.is_published = true
      and x.subject = 'english'
      and x.access_tier = 'free'
      and x.category <> 'answer'
  );

create or replace function public.current_portal_free_group()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select case
        when p.portal_free_group = 'university' then 'university'
        else 'entrance_10'
      end
      from public.profiles p
      where p.id = auth.uid()
      limit 1
    ),
    'entrance_10'
  );
$$;

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
      and e.group_free_rank between 1 and 5
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
        or (my_group.g = 'entrance_10' and coalesce(e.level, '') <> 'university')
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
  group_free_rank integer
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
    e.group_free_rank
  from public.exam_files e
  where e.is_published = true
    and e.subject = 'english'
  order by e.level asc, e.year desc nulls last, e.province asc nulls last, e.exam_sort_order asc nulls last, e.created_at desc;
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
  v_group text := case when lower(trim(coalesce(p_free_group, 'entrance_10'))) = 'university' then 'university' else 'entrance_10' end;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'admin'
  ) then
    raise exception 'admin_required';
  end if;

  if p_free_rank is not null and (p_free_rank < 1 or p_free_rank > 5) then
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

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  display text;
  status text;
  free_group text;
  class_label text;
begin
  r := lower(trim(coalesce(new.raw_user_meta_data->>'role', '')));
  if r not in ('admin', 'teacher', 'student') then
    r := 'teacher';
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(trim(split_part(coalesce(new.email, ''), '@', 1)), '')
  );

  class_label := coalesce(
    nullif(trim(new.raw_user_meta_data->>'student_class_label'), ''),
    nullif(trim(new.raw_user_meta_data->>'class_label'), '')
  );

  free_group := lower(trim(coalesce(
    new.raw_user_meta_data->>'portal_free_group',
    new.raw_user_meta_data->>'student_class_group',
    ''
  )));
  if free_group not in ('entrance_10', 'university') then
    free_group := 'entrance_10';
  end if;
  if class_label in ('THPT / Đại học', 'THPT / Dai hoc') then
    class_label := 'THPT QG';
  elsif class_label in ('Lớp 8', 'Lop 8', 'Lớp 9', 'Lop 9') then
    class_label := 'Thi vào 10';
  end if;

  status := 'active';

  insert into public.profiles (id, email, role, display_name, portal_plan, portal_status, portal_free_group, portal_class_label)
  values (new.id, new.email, r, display, 'free', status, free_group, class_label)
  on conflict (id) do update
  set
    email = coalesce(excluded.email, public.profiles.email),
    role = coalesce(nullif(excluded.role, ''), public.profiles.role),
    display_name = coalesce(nullif(excluded.display_name, ''), public.profiles.display_name),
    portal_free_group = case when public.profiles.role = 'student' then coalesce(excluded.portal_free_group, public.profiles.portal_free_group) else public.profiles.portal_free_group end,
    portal_class_label = case when public.profiles.role = 'student' then coalesce(excluded.portal_class_label, public.profiles.portal_class_label) else public.profiles.portal_class_label end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

grant execute on function public.current_portal_free_group() to authenticated;
grant execute on function public.is_curated_free_exam(uuid) to authenticated;
grant execute on function public.list_student_exam_files() to authenticated;
grant execute on function public.set_exam_free_rank(uuid, integer, text) to authenticated;

notify pgrst, 'reload schema';

update public.profiles p
set portal_status = 'active'
where p.role = 'student'
  and p.portal_status = 'pending'
  and exists (
    select 1
    from auth.users u
    where u.id = p.id
      and (u.confirmed_at is not null or u.email_confirmed_at is not null)
  );

update public.profiles
set portal_class_label = case
  when portal_class_label in ('Lớp 8', 'Lop 8', 'Lớp 9', 'Lop 9') then 'Thi vào 10'
  when portal_class_label in ('THPT / Đại học', 'THPT / Dai hoc') then 'THPT QG'
  else portal_class_label
end
where role = 'student'
  and portal_class_label in ('Lớp 8', 'Lop 8', 'Lớp 9', 'Lop 9', 'THPT / Đại học', 'THPT / Dai hoc');

notify pgrst, 'reload schema';
