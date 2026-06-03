-- 090 - Existing leaderboard scores belonged to May 2026.
-- Migration 089 originally used the current month for legacy rows. If it was
-- run in June 2026, move those legacy score rows back to May and leave June
-- empty until new points are added.

do $$
declare
  v_has_minigame boolean := false;
begin
  if to_regclass('public.leaderboard_manual_scores') is null then
    return;
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'leaderboard_manual_scores'
      and column_name = 'minigame_pts'
  )
  into v_has_minigame;

  if v_has_minigame then
    update public.leaderboard_manual_scores may
    set performance_pts = greatest(
          coalesce(may.performance_pts, 0),
          coalesce(jun.performance_pts, 0)
        ),
        contribution_pts = greatest(
          coalesce(may.contribution_pts, 0),
          coalesce(jun.contribution_pts, 0)
        ),
        minigame_pts = greatest(
          coalesce(may.minigame_pts, 0),
          coalesce(jun.minigame_pts, 0)
        )
    from public.leaderboard_manual_scores jun
    where may.student_id = jun.student_id
      and may.score_month = '2026-05'
      and jun.score_month = '2026-06';
  else
    update public.leaderboard_manual_scores may
    set performance_pts = greatest(
          coalesce(may.performance_pts, 0),
          coalesce(jun.performance_pts, 0)
        ),
        contribution_pts = greatest(
          coalesce(may.contribution_pts, 0),
          coalesce(jun.contribution_pts, 0)
        )
    from public.leaderboard_manual_scores jun
    where may.student_id = jun.student_id
      and may.score_month = '2026-05'
      and jun.score_month = '2026-06';
  end if;

  update public.leaderboard_manual_scores
  set score_month = '2026-05'
  where score_month = '2026-06'
    and not exists (
      select 1
      from public.leaderboard_manual_scores may
      where may.student_id = leaderboard_manual_scores.student_id
        and may.score_month = '2026-05'
    );

  delete from public.leaderboard_manual_scores jun
  where jun.score_month = '2026-06'
    and exists (
      select 1
      from public.leaderboard_manual_scores may
      where may.student_id = jun.student_id
        and may.score_month = '2026-05'
    );
end $$;

do $$
begin
  if to_regclass('public.leaderboard_performance_history') is null then
    return;
  end if;

  update public.leaderboard_performance_history
  set score_month = '2026-05'
  where score_month = '2026-06';
end $$;
