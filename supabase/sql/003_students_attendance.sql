-- =============================================================================
-- 003 — students + attendance (điểm danh theo ngày)
-- Yêu cầu: 001_profiles, 002_teacher_classes
-- =============================================================================

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  class_name text,
  created_at timestamptz not null default now()
);

create index if not exists students_class_name_idx on public.students (class_name);
create index if not exists students_name_idx on public.students (name);

create table if not exists public.attendance (
  student_id uuid not null references public.students (id) on delete cascade,
  date date not null,
  status text not null check (status in ('present', 'absent')),
  created_at timestamptz not null default now(),
  primary key (student_id, date)
);

create index if not exists attendance_date_idx on public.attendance (date);
create index if not exists attendance_student_idx on public.attendance (student_id);

alter table public.students enable row level security;
alter table public.attendance enable row level security;

drop policy if exists students_select_scope on public.students;
create policy students_select_scope
  on public.students for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or (
      exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
      and class_name is not null
      and exists (
        select 1 from public.teacher_classes tc
        where tc.teacher_id = auth.uid()
          and tc.class_name = students.class_name
      )
    )
  );

drop policy if exists students_write_admin on public.students;
create policy students_write_admin
  on public.students for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists attendance_select_scope on public.attendance;
create policy attendance_select_scope
  on public.attendance for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or (
      exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
      and exists (
        select 1 from public.students s
        inner join public.teacher_classes tc
          on tc.teacher_id = auth.uid() and tc.class_name = s.class_name
        where s.id = attendance.student_id
      )
    )
  );

drop policy if exists attendance_write_admin on public.attendance;
create policy attendance_write_admin
  on public.attendance for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists attendance_write_admin_del on public.attendance;
create policy attendance_write_admin_del
  on public.attendance for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists attendance_write_admin_upd on public.attendance;
create policy attendance_write_admin_upd
  on public.attendance for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists attendance_teacher_insert on public.attendance;
create policy attendance_teacher_insert
  on public.attendance for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
    and exists (
      select 1 from public.students s
      inner join public.teacher_classes tc
        on tc.teacher_id = auth.uid() and tc.class_name = s.class_name
      where s.id = attendance.student_id
    )
  );

drop policy if exists attendance_teacher_delete on public.attendance;
create policy attendance_teacher_delete
  on public.attendance for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
    and exists (
      select 1 from public.students s
      inner join public.teacher_classes tc
        on tc.teacher_id = auth.uid() and tc.class_name = s.class_name
      where s.id = attendance.student_id
    )
  );

drop policy if exists attendance_teacher_update on public.attendance;
create policy attendance_teacher_update
  on public.attendance for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
    and exists (
      select 1 from public.students s
      inner join public.teacher_classes tc
        on tc.teacher_id = auth.uid() and tc.class_name = s.class_name
      where s.id = attendance.student_id
    )
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
    and exists (
      select 1 from public.students s
      inner join public.teacher_classes tc
        on tc.teacher_id = auth.uid() and tc.class_name = s.class_name
      where s.id = attendance.student_id
    )
  );

grant select, insert, update, delete on table public.students to authenticated;
grant select, insert, update, delete on table public.attendance to authenticated;
