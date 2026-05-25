-- =============================================================================
-- 033 — Lịch sử cộng điểm leaderboard (thành tích / cống hiến)
-- Yêu cầu: 001_profiles, 003_students_attendance, 029_leaderboard_manual_scores
-- =============================================================================

create table if not exists public.leaderboard_performance_history (
  id uuid primary key default gen_random_uuid(),
  client_event_id text not null unique,
  student_id uuid not null references public.students (id) on delete cascade,
  student_name text not null default '',
  class_short text not null default '',
  points integer not null check (points > 0),
  metric text not null check (metric in ('performance', 'contribution')),
  top_name text not null default 'Top thành tích',
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid null default auth.uid()
);

create index if not exists leaderboard_perf_history_event_idx
  on public.leaderboard_performance_history (event_at desc, created_at desc);

create index if not exists leaderboard_perf_history_student_idx
  on public.leaderboard_performance_history (student_id, event_at desc);

comment on table public.leaderboard_performance_history is
  'Lịch sử các lần cộng điểm leaderboard để hiển thị tab lịch sử và cho phép hủy.';

alter table public.leaderboard_performance_history enable row level security;

drop policy if exists leaderboard_perf_history_select_admin on public.leaderboard_performance_history;
create policy leaderboard_perf_history_select_admin
  on public.leaderboard_performance_history for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists leaderboard_perf_history_insert_admin on public.leaderboard_performance_history;
create policy leaderboard_perf_history_insert_admin
  on public.leaderboard_performance_history for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists leaderboard_perf_history_delete_admin on public.leaderboard_performance_history;
create policy leaderboard_perf_history_delete_admin
  on public.leaderboard_performance_history for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, delete on table public.leaderboard_performance_history to authenticated;

notify pgrst, 'reload schema';
