-- =============================================================================
-- 006 — Chấm công giáo viên (teacher_check_ins)
-- Yêu cầu: 001_profiles
-- =============================================================================

create table if not exists public.teacher_check_ins (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references auth.users (id) on delete cascade,
  teacher_email text,
  checked_in_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'on_time', 'late', 'absent')),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  class_name text,
  auto_absent boolean not null default false
);

create index if not exists teacher_check_ins_teacher_time_idx
  on public.teacher_check_ins (teacher_id, checked_in_at desc);

create index if not exists teacher_check_ins_pending_idx
  on public.teacher_check_ins (checked_in_at desc)
  where status = 'pending';

create index if not exists teacher_check_ins_auto_absent_idx
  on public.teacher_check_ins (teacher_id, class_name)
  where auto_absent = true;

create or replace function public.teacher_check_ins_set_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.teacher_email is null or btrim(new.teacher_email) = '' then
    select au.email into new.teacher_email from auth.users au where au.id = new.teacher_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_teacher_check_ins_email on public.teacher_check_ins;
create trigger trg_teacher_check_ins_email
  before insert on public.teacher_check_ins
  for each row execute procedure public.teacher_check_ins_set_email();

alter table public.teacher_check_ins enable row level security;

drop policy if exists teacher_check_ins_select on public.teacher_check_ins;
create policy teacher_check_ins_select
  on public.teacher_check_ins for select to authenticated
  using (
    teacher_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists teacher_check_ins_insert on public.teacher_check_ins;
create policy teacher_check_ins_insert
  on public.teacher_check_ins for insert to authenticated
  with check (
    teacher_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
  );

drop policy if exists teacher_check_ins_insert_admin_auto_absent on public.teacher_check_ins;
create policy teacher_check_ins_insert_admin_auto_absent
  on public.teacher_check_ins for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    and coalesce(auto_absent, false) = true
    and status = 'absent'
  );

drop policy if exists teacher_check_ins_update on public.teacher_check_ins;
create policy teacher_check_ins_update
  on public.teacher_check_ins for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists teacher_check_ins_delete on public.teacher_check_ins;
create policy teacher_check_ins_delete
  on public.teacher_check_ins for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, update, delete on table public.teacher_check_ins to authenticated;
grant usage, select on sequence public.teacher_check_ins_id_seq to authenticated;
