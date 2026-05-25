-- =============================================================================
-- 002 — Gán lớp cho giáo viên (phải chạy trước students/attendance vì RLS tham chiếu)
-- =============================================================================

create table if not exists public.teacher_classes (
  teacher_id uuid not null references auth.users (id) on delete cascade,
  class_name text not null,
  primary key (teacher_id, class_name)
);

create index if not exists teacher_classes_class_name_idx on public.teacher_classes (class_name);

alter table public.teacher_classes enable row level security;

drop policy if exists teacher_classes_select on public.teacher_classes;
create policy teacher_classes_select
  on public.teacher_classes for select to authenticated
  using (
    teacher_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists teacher_classes_insert on public.teacher_classes;
create policy teacher_classes_insert
  on public.teacher_classes for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists teacher_classes_delete on public.teacher_classes;
create policy teacher_classes_delete
  on public.teacher_classes for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, delete on table public.teacher_classes to authenticated;
