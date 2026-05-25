-- =============================================================================
-- 055 - Student exam activity
-- Per-account saved documents and recent activity for the student portal.
-- =============================================================================

create table if not exists public.student_exam_activity (
  user_id uuid not null references auth.users (id) on delete cascade,
  exam_file_id uuid not null references public.exam_files (id) on delete cascade,
  is_favorite boolean not null default false,
  favorite_at timestamptz,
  last_opened_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, exam_file_id)
);

create index if not exists student_exam_activity_user_favorite_idx
  on public.student_exam_activity (user_id, is_favorite, favorite_at desc);

create index if not exists student_exam_activity_user_opened_idx
  on public.student_exam_activity (user_id, last_opened_at desc);

create or replace function public.set_student_exam_activity_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if coalesce(new.is_favorite, false) = false then
    new.favorite_at := null;
  elsif new.favorite_at is null then
    new.favorite_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_student_exam_activity_updated_at on public.student_exam_activity;
create trigger trg_student_exam_activity_updated_at
before insert or update on public.student_exam_activity
for each row
execute function public.set_student_exam_activity_updated_at();

alter table public.student_exam_activity enable row level security;

drop policy if exists student_exam_activity_select_own on public.student_exam_activity;
create policy student_exam_activity_select_own
on public.student_exam_activity
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists student_exam_activity_insert_own_published on public.student_exam_activity;
create policy student_exam_activity_insert_own_published
on public.student_exam_activity
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.exam_files e
    where e.id = exam_file_id
      and e.is_published = true
  )
);

drop policy if exists student_exam_activity_update_own_published on public.student_exam_activity;
create policy student_exam_activity_update_own_published
on public.student_exam_activity
for update
to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.exam_files e
    where e.id = exam_file_id
      and e.is_published = true
  )
);

drop policy if exists student_exam_activity_delete_own on public.student_exam_activity;
create policy student_exam_activity_delete_own
on public.student_exam_activity
for delete
to authenticated
using (user_id = auth.uid());

grant select, insert, update, delete on public.student_exam_activity to authenticated;

notify pgrst, 'reload schema';
