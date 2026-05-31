-- Limit student portal downloads by distinct exam per local day.
-- Preview/open requests do not use this table; only attachment downloads do.

create table if not exists public.exam_download_daily_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  exam_file_id uuid not null references public.exam_files(id) on delete cascade,
  download_date date not null,
  first_downloaded_at timestamptz not null default now(),
  last_downloaded_at timestamptz not null default now(),
  download_count integer not null default 1 check (download_count >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, download_date, exam_file_id)
);

create index if not exists idx_exam_download_daily_credits_user_date
  on public.exam_download_daily_credits (user_id, download_date desc);

create index if not exists idx_exam_download_daily_credits_exam_date
  on public.exam_download_daily_credits (exam_file_id, download_date desc);

alter table public.exam_download_daily_credits enable row level security;

revoke all on public.exam_download_daily_credits from anon, authenticated;

create or replace function public.claim_exam_download_credit(
  p_user_id uuid,
  p_exam_id uuid,
  p_daily_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_limit integer := p_daily_limit;
  v_used integer := 0;
  v_already_counted boolean := false;
begin
  if p_user_id is null or p_exam_id is null then
    return jsonb_build_object('ok', false, 'allowed', false, 'reason', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_today::text, 85085));

  select exists (
    select 1
    from public.exam_download_daily_credits c
    where c.user_id = p_user_id
      and c.download_date = v_today
      and c.exam_file_id = p_exam_id
  ) into v_already_counted;

  if v_already_counted then
    update public.exam_download_daily_credits
    set
      download_count = download_count + 1,
      last_downloaded_at = now(),
      updated_at = now()
    where user_id = p_user_id
      and download_date = v_today
      and exam_file_id = p_exam_id;

    select count(*)::integer
    into v_used
    from public.exam_download_daily_credits c
    where c.user_id = p_user_id
      and c.download_date = v_today;

    return jsonb_build_object(
      'ok', true,
      'allowed', true,
      'date', v_today,
      'limit', v_limit,
      'used', v_used,
      'remaining', case when v_limit is null then null else greatest(v_limit - v_used, 0) end,
      'already_counted', true
    );
  end if;

  select count(*)::integer
  into v_used
  from public.exam_download_daily_credits c
  where c.user_id = p_user_id
    and c.download_date = v_today;

  if v_limit is not null and v_limit >= 0 and v_used >= v_limit then
    return jsonb_build_object(
      'ok', true,
      'allowed', false,
      'reason', 'daily_limit_exceeded',
      'date', v_today,
      'limit', v_limit,
      'used', v_used,
      'remaining', 0,
      'already_counted', false
    );
  end if;

  insert into public.exam_download_daily_credits (
    user_id,
    exam_file_id,
    download_date,
    first_downloaded_at,
    last_downloaded_at,
    download_count
  ) values (
    p_user_id,
    p_exam_id,
    v_today,
    now(),
    now(),
    1
  );

  v_used := v_used + 1;

  return jsonb_build_object(
    'ok', true,
    'allowed', true,
    'date', v_today,
    'limit', v_limit,
    'used', v_used,
    'remaining', case when v_limit is null then null else greatest(v_limit - v_used, 0) end,
    'already_counted', false
  );
end;
$$;

revoke all on function public.claim_exam_download_credit(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_exam_download_credit(uuid, uuid, integer) to service_role;
