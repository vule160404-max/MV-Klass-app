-- =============================================================================
-- 042 - Public performance leaderboard for landing page
-- Exposes only display-safe fields for public visitors.
-- Requires: 003_students_attendance, 029_leaderboard_manual_scores
-- =============================================================================

create or replace view public.public_leaderboard as
select
  s.name::text as student_name,
  coalesce(
    nullif(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              coalesce(s.class_name, ''),
              '\s*[•·,-]?\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*$',
              '',
              'i'
            ),
            '\s*[•·,-]?\s*(Thu\s*[2-7]|Thứ\s*[2-7]|Chu\s*nhat|Chủ\s*nhật|CN)\b.*$',
            '',
            'i'
          ),
          '\s*[•·,-]?\s*\(?\d{1,2}\s*[:h]\s*\d{0,2}\s*[-–]\s*\d{1,2}\s*[:h]\s*\d{0,2}\)?\s*$',
          '',
          'i'
        )
      ),
      ''
    ),
    'Chưa gán lớp'
  )::text as class_name,
  'performance'::text as metric,
  l.performance_pts::integer as score,
  l.updated_at
from public.leaderboard_manual_scores l
join public.students s on s.id = l.student_id
where l.performance_pts > 0;

comment on view public.public_leaderboard is
  'Public landing leaderboard. Only exposes student display name, class label, performance score, and update time.';

grant select on public.public_leaderboard to anon, authenticated;

notify pgrst, 'reload schema';
