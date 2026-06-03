-- 089 - Store leaderboard manual scores by month.
-- Each student gets an independent score row per YYYY-MM month, so a new
-- month starts at 0 while older months remain queryable.

alter table if exists public.leaderboard_manual_scores
  add column if not exists score_month text;

update public.leaderboard_manual_scores
set score_month = to_char(now(), 'YYYY-MM')
where score_month is null or not (score_month ~ '^\d{4}-\d{2}$');

alter table if exists public.leaderboard_manual_scores
  alter column score_month set default to_char(now(), 'YYYY-MM'),
  alter column score_month set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'leaderboard_manual_scores_month_chk'
      and conrelid = 'public.leaderboard_manual_scores'::regclass
  ) then
    alter table public.leaderboard_manual_scores
      add constraint leaderboard_manual_scores_month_chk
      check (score_month ~ '^\d{4}-\d{2}$');
  end if;
end $$;

do $$
declare
  v_student_attnum smallint;
  v_constraint record;
begin
  select attnum
  into v_student_attnum
  from pg_attribute
  where attrelid = 'public.leaderboard_manual_scores'::regclass
    and attname = 'student_id'
    and not attisdropped;

  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.leaderboard_manual_scores'::regclass
      and contype in ('p', 'u')
      and conkey = array[v_student_attnum]
  loop
    execute format(
      'alter table public.leaderboard_manual_scores drop constraint %I',
      v_constraint.conname
    );
  end loop;
end $$;

create unique index if not exists leaderboard_manual_scores_student_month_uidx
  on public.leaderboard_manual_scores (student_id, score_month);

alter table if exists public.leaderboard_performance_history
  add column if not exists score_month text;

update public.leaderboard_performance_history
set score_month = coalesce(
  nullif(score_month, ''),
  to_char(coalesce(event_at, created_at, now()), 'YYYY-MM')
)
where score_month is null or not (score_month ~ '^\d{4}-\d{2}$');

alter table if exists public.leaderboard_performance_history
  alter column score_month set default to_char(now(), 'YYYY-MM');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'leaderboard_performance_history_month_chk'
      and conrelid = 'public.leaderboard_performance_history'::regclass
  ) then
    alter table public.leaderboard_performance_history
      add constraint leaderboard_performance_history_month_chk
      check (score_month is null or score_month ~ '^\d{4}-\d{2}$');
  end if;
end $$;
