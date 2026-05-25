-- =============================================================================
-- 016 -- Scheduled notifications (daily schedule / class reminder / attendance alert)
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.app_runtime_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

create or replace function public.tg_app_runtime_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_app_runtime_settings_updated_at on public.app_runtime_settings;
create trigger trg_app_runtime_settings_updated_at
before update on public.app_runtime_settings
for each row execute procedure public.tg_app_runtime_settings_updated_at();

create or replace function public.fn_get_runtime_setting(p_key text)
returns text
language sql
stable
as $$
  select coalesce((
    select ars.value
    from public.app_runtime_settings ars
    where ars.key = p_key
    limit 1
  ), '');
$$;

create table if not exists public.notification_dispatch_log (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('daily_summary', 'class_reminder', 'attendance_alert')),
  target_user_id uuid not null references auth.users(id) on delete cascade,
  class_name text not null default '',
  slot_date date not null,
  slot_start time not null,
  title text not null default '',
  body text not null default '',
  created_at timestamptz not null default now(),
  unique (kind, target_user_id, class_name, slot_date, slot_start)
);

create index if not exists idx_notification_dispatch_log_kind_date
  on public.notification_dispatch_log(kind, slot_date desc, created_at desc);

alter table public.notification_dispatch_log enable row level security;
alter table public.app_runtime_settings enable row level security;

drop policy if exists notification_dispatch_log_admin_select on public.notification_dispatch_log;
create policy notification_dispatch_log_admin_select
  on public.notification_dispatch_log for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert on table public.notification_dispatch_log to service_role;
grant select on table public.notification_dispatch_log to authenticated;
grant usage, select on sequence public.notification_dispatch_log_id_seq to service_role;
grant select, insert, update on table public.app_runtime_settings to authenticated, service_role;

drop policy if exists app_runtime_settings_admin_all on public.app_runtime_settings;
create policy app_runtime_settings_admin_all
  on public.app_runtime_settings for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create or replace function public.fn_call_schedule_notification(url_key text, bearer_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := trim(coalesce(public.fn_get_runtime_setting(url_key), ''));
  v_bearer text := trim(coalesce(public.fn_get_runtime_setting(bearer_key), ''));
  v_headers jsonb := '{"Content-Type":"application/json"}'::jsonb;
begin
  if v_url = '' then
    return;
  end if;
  if v_bearer <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_bearer);
  end if;
  perform net.http_post(
    url := v_url,
    headers := v_headers,
    body := '{}'::jsonb
  );
exception when others then
  return;
end;
$$;

-- 07:00 sáng hàng ngày (giờ VN)
select cron.unschedule('mvk_fcm_daily_summary') where exists (
  select 1 from cron.job where jobname = 'mvk_fcm_daily_summary'
);
select cron.schedule(
  'mvk_fcm_daily_summary',
  '0 7 * * *',
  $$select public.fn_call_schedule_notification('app.settings.fcm_daily_summary_url', 'app.settings.fcm_schedule_bearer');$$
);

-- Mỗi 2 phút trong khung 07:00-23:59: cân bằng độ ổn định và giới hạn gói Free
select cron.unschedule('mvk_fcm_class_reminder') where exists (
  select 1 from cron.job where jobname = 'mvk_fcm_class_reminder'
);
select cron.schedule(
  'mvk_fcm_class_reminder',
  '*/2 7-23 * * *',
  $$select public.fn_call_schedule_notification('app.settings.fcm_class_reminder_url', 'app.settings.fcm_schedule_bearer');$$
);

-- Mỗi 5 phút: cảnh báo lớp chưa điểm danh sau 30 phút
select cron.unschedule('mvk_fcm_attendance_alert') where exists (
  select 1 from cron.job where jobname = 'mvk_fcm_attendance_alert'
);
select cron.schedule(
  'mvk_fcm_attendance_alert',
  '*/5 * * * *',
  $$select public.fn_call_schedule_notification('app.settings.fcm_attendance_alert_url', 'app.settings.fcm_schedule_bearer');$$
);

notify pgrst, 'reload schema';
