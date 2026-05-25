-- =============================================================================
-- 029 — Điểm thành tích / cống hiến bảng xếp hạng (lưu server, đồng bộ đa thiết bị)
-- Yêu cầu: 001_profiles, 003_students_attendance (bảng students)
-- Sau khi chạy: NOTIFY reload schema (cuối file).
-- =============================================================================

create table if not exists public.leaderboard_manual_scores (
  student_id uuid not null references public.students (id) on delete cascade,
  performance_pts integer not null default 0 check (performance_pts >= 0),
  contribution_pts integer not null default 0 check (contribution_pts >= 0),
  updated_at timestamptz not null default now(),
  primary key (student_id)
);

create index if not exists leaderboard_manual_scores_updated_idx
  on public.leaderboard_manual_scores (updated_at desc);

comment on table public.leaderboard_manual_scores is 'Điểm tay thành tích + lượt giới thiệu cho tab Bảng xếp hạng (admin).';

-- Dùng chung public.tg_set_updated_at() (định nghĩa trong 009_bank_webhook_integration.sql).
drop trigger if exists trg_leaderboard_manual_scores_updated on public.leaderboard_manual_scores;
create trigger trg_leaderboard_manual_scores_updated
  before update on public.leaderboard_manual_scores
  for each row execute procedure public.tg_set_updated_at();

alter table public.leaderboard_manual_scores enable row level security;

drop policy if exists leaderboard_manual_scores_select_admin on public.leaderboard_manual_scores;
create policy leaderboard_manual_scores_select_admin
  on public.leaderboard_manual_scores for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists leaderboard_manual_scores_insert_admin on public.leaderboard_manual_scores;
create policy leaderboard_manual_scores_insert_admin
  on public.leaderboard_manual_scores for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists leaderboard_manual_scores_update_admin on public.leaderboard_manual_scores;
create policy leaderboard_manual_scores_update_admin
  on public.leaderboard_manual_scores for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists leaderboard_manual_scores_delete_admin on public.leaderboard_manual_scores;
create policy leaderboard_manual_scores_delete_admin
  on public.leaderboard_manual_scores for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, update, delete on table public.leaderboard_manual_scores to authenticated;

notify pgrst, 'reload schema';
