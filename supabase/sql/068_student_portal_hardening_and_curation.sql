-- =============================================================================
-- 068 - Student portal hardening, curation, and audit
-- =============================================================================

alter table public.profiles
  add column if not exists portal_status text not null default 'active';

alter table public.profiles
  drop constraint if exists profiles_portal_status_check;

alter table public.profiles
  add constraint profiles_portal_status_check
  check (portal_status in ('pending', 'active', 'blocked'));

create index if not exists profiles_portal_status_idx
  on public.profiles (role, portal_status, portal_plan);

alter table public.exam_files
  add column if not exists free_rank integer;

alter table public.exam_files
  drop constraint if exists exam_files_free_rank_check;

alter table public.exam_files
  add constraint exam_files_free_rank_check
  check (free_rank is null or free_rank between 1 and 10);

create unique index if not exists exam_files_free_rank_unique_idx
  on public.exam_files (free_rank)
  where free_rank is not null and is_published = true and subject = 'english' and access_tier = 'free' and category <> 'answer';

create table if not exists public.portal_account_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users (id) on delete set null,
  target_user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  old_portal_plan text,
  new_portal_plan text,
  old_portal_status text,
  new_portal_status text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists portal_account_audit_target_idx
  on public.portal_account_audit (target_user_id, created_at desc);

create index if not exists portal_account_audit_created_idx
  on public.portal_account_audit (created_at desc);

alter table public.portal_account_audit enable row level security;

drop policy if exists portal_account_audit_admin_teacher_select on public.portal_account_audit;
create policy portal_account_audit_admin_teacher_select
on public.portal_account_audit
for select
to authenticated
using (public.is_app_admin_or_teacher());

create or replace function public.current_portal_status()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.portal_status
      from public.profiles p
      where p.id = auth.uid()
      limit 1
    ),
    'pending'
  );
$$;

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
      and e.category <> 'answer'
      and (
        (
          exists (
            select 1
            from public.exam_files c
            where c.is_published = true
              and c.access_tier = 'free'
              and c.subject = 'english'
              and c.category <> 'answer'
              and c.free_rank between 1 and public.student_free_exam_limit()
          )
          and e.free_rank between 1 and public.student_free_exam_limit()
        )
        or (
          not exists (
            select 1
            from public.exam_files c
            where c.is_published = true
              and c.access_tier = 'free'
              and c.subject = 'english'
              and c.category <> 'answer'
              and c.free_rank between 1 and public.student_free_exam_limit()
          )
          and e.id in (
            select f.id
            from public.exam_files f
            where f.is_published = true
              and f.access_tier = 'free'
              and f.subject = 'english'
              and f.category <> 'answer'
            order by f.level asc, f.year desc nulls last, f.province asc nulls last, f.exam_sort_order asc nulls last, f.created_at desc
            limit public.student_free_exam_limit()
          )
        )
      )
  );
$$;

create or replace function public.can_access_exam_file(p_exam_id uuid)
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
      and (
        public.is_app_admin_or_teacher()
        or (
          public.current_portal_status() = 'active'
          and (
            public.current_portal_plan() = 'premium'
            or public.is_curated_free_exam(e.id)
          )
        )
      )
  );
$$;

create or replace function public.student_exam_locked_reason(
  p_exam_id uuid,
  p_access_tier text,
  p_free_rank integer
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_app_admin_or_teacher() then null
    when public.current_portal_status() = 'pending' then 'pending_approval'
    when public.current_portal_status() = 'blocked' then 'account_blocked'
    when public.current_portal_plan() = 'premium' then null
    when coalesce(p_access_tier, 'free') = 'premium' then 'premium_required'
    when public.is_curated_free_exam(p_exam_id) then null
    else 'free_limit'
  end;
$$;

create or replace function public.list_student_exam_files()
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
  locked_reason text
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
    public.student_exam_locked_reason(e.id, e.access_tier, e.free_rank) as locked_reason
  from public.exam_files e
  where e.is_published = true
    and e.subject = 'english'
  order by e.level asc, e.year desc nulls last, e.province asc nulls last, e.exam_sort_order asc nulls last, e.created_at desc;
$$;

create or replace function public.set_student_portal_access(
  p_user_id uuid,
  p_portal_plan text,
  p_portal_status text default 'active',
  p_note text default null
)
returns table (
  user_id uuid,
  portal_plan text,
  portal_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_old_plan text;
  v_old_status text;
  v_new_plan text := case when lower(trim(coalesce(p_portal_plan, 'free'))) = 'premium' then 'premium' else 'free' end;
  v_new_status text := lower(trim(coalesce(p_portal_status, 'active')));
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'admin'
  ) then
    raise exception 'admin_required';
  end if;

  if v_new_status not in ('pending', 'active', 'blocked') then
    raise exception 'invalid_portal_status';
  end if;

  select p.portal_plan, p.portal_status
  into v_old_plan, v_old_status
  from public.profiles p
  where p.id = p_user_id
    and p.role = 'student';

  if not found then
    raise exception 'student_not_found';
  end if;

  update public.profiles p
  set portal_plan = v_new_plan,
      portal_status = v_new_status
  where p.id = p_user_id
    and p.role = 'student';

  insert into public.portal_account_audit (
    actor_id,
    target_user_id,
    action,
    old_portal_plan,
    new_portal_plan,
    old_portal_status,
    new_portal_status,
    note
  )
  values (
    v_actor,
    p_user_id,
    'set_portal_access',
    v_old_plan,
    v_new_plan,
    v_old_status,
    v_new_status,
    nullif(trim(coalesce(p_note, '')), '')
  );

  return query select p_user_id, v_new_plan, v_new_status;
end;
$$;

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

  status := case when r = 'student' then 'pending' else 'active' end;

  insert into public.profiles (id, email, role, display_name, portal_plan, portal_status)
  values (new.id, new.email, r, display, 'free', status)
  on conflict (id) do update
  set
    email = coalesce(excluded.email, public.profiles.email),
    role = coalesce(nullif(excluded.role, ''), public.profiles.role),
    display_name = coalesce(nullif(excluded.display_name, ''), public.profiles.display_name);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

grant select on public.portal_account_audit to authenticated;
grant execute on function public.current_portal_status() to authenticated;
grant execute on function public.is_curated_free_exam(uuid) to authenticated;
grant execute on function public.student_exam_locked_reason(uuid, text, integer) to authenticated;
grant execute on function public.list_student_exam_files() to authenticated;
grant execute on function public.set_student_portal_access(uuid, text, text, text) to authenticated;
grant execute on function public.set_exam_free_rank(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
