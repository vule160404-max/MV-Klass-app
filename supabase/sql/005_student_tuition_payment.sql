-- =============================================================================
-- 005 — Số buổi đã thu + lịch sử đóng phí
-- Yêu cầu: 003_students (FK student_id)
-- Chỉ admin dùng trong app; RLS khóa giáo viên.
-- =============================================================================

create table if not exists public.student_tuition (
  student_id uuid not null references public.students (id) on delete cascade,
  charged_sessions integer not null default 0 check (charged_sessions >= 0),
  updated_at timestamptz not null default now(),
  primary key (student_id)
);

create table if not exists public.payment_history (
  id bigint generated always as identity primary key,
  student_id uuid not null references public.students (id) on delete cascade,
  sessions_paid integer not null check (sessions_paid > 0),
  amount_vnd integer not null default 0 check (amount_vnd >= 0),
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_payment_history_student_paid_at
  on public.payment_history (student_id, paid_at desc);

alter table public.student_tuition enable row level security;
alter table public.payment_history enable row level security;

drop policy if exists student_tuition_admin_all on public.student_tuition;
create policy student_tuition_admin_all
  on public.student_tuition for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists payment_history_admin_all on public.payment_history;
create policy payment_history_admin_all
  on public.payment_history for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, update, delete on table public.student_tuition to authenticated;
grant select, insert, update, delete on table public.payment_history to authenticated;

do $$
declare
  seq_name text;
begin
  -- Có thể bảng payment_history đã tồn tại từ trước với kiểu id khác/không identity.
  seq_name := pg_get_serial_sequence('public.payment_history', 'id');
  if seq_name is not null then
    execute format('grant usage, select on sequence %s to authenticated', seq_name);
  end if;
end $$;
