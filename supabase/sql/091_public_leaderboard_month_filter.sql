-- 091 - Expose leaderboard score_month to the public landing page.
-- The landing page filters this view by the current YYYY-MM month. Legacy
-- May 2026 scores stay in 2026-05, so June starts empty until new points exist.

create or replace view public.public_leaderboard as
select
  s.name as student_name,
  s.class_name,
  'performance'::text as metric,
  coalesce(l.performance_pts, 0)::integer as score,
  l.updated_at,
  l.score_month
from public.leaderboard_manual_scores l
join public.students s on s.id = l.student_id
where coalesce(l.performance_pts, 0) > 0
union all
select
  s.name as student_name,
  s.class_name,
  'contribution'::text as metric,
  coalesce(l.contribution_pts, 0)::integer as score,
  l.updated_at,
  l.score_month
from public.leaderboard_manual_scores l
join public.students s on s.id = l.student_id
where coalesce(l.contribution_pts, 0) > 0
union all
select
  s.name as student_name,
  s.class_name,
  'minigame'::text as metric,
  coalesce(l.minigame_pts, 0)::integer as score,
  l.updated_at,
  l.score_month
from public.leaderboard_manual_scores l
join public.students s on s.id = l.student_id
where coalesce(l.minigame_pts, 0) > 0;

grant select on public.public_leaderboard to anon, authenticated;
