-- =============================================================================
-- 034 — Top minigame: bổ sung cột minigame_pts cho leaderboard_manual_scores
--      và mở rộng metric của leaderboard_performance_history sang 'minigame'.
-- Yêu cầu: 029_leaderboard_manual_scores, 033_leaderboard_performance_history
-- =============================================================================

alter table public.leaderboard_manual_scores
  add column if not exists minigame_pts integer not null default 0
    check (minigame_pts >= 0);

comment on column public.leaderboard_manual_scores.minigame_pts is
  'Điểm minigame trên lớp — cập nhật thủ công bởi admin/giáo viên.';

-- Mở rộng metric của bảng lịch sử để chấp nhận thêm 'minigame'.
do $$
declare
  v_conname text;
begin
  select c.conname
    into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'leaderboard_performance_history'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%metric%';
  if v_conname is not null then
    execute format('alter table public.leaderboard_performance_history drop constraint %I', v_conname);
  end if;
end$$;

alter table public.leaderboard_performance_history
  add constraint leaderboard_perf_history_metric_chk
  check (metric in ('performance', 'contribution', 'minigame'));

notify pgrst, 'reload schema';
