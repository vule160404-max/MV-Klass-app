-- Dashboard notice board setup (Supabase/Postgres)
-- Run once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.dashboard (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  content text not null default '',
  tag text not null default 'general' check (tag in ('urgent', 'general', 'reminder')),
  is_active boolean not null default true,
  start_at timestamptz null,
  end_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_time_range_chk check (end_at is null or start_at is null or end_at >= start_at)
);

create index if not exists dashboard_is_active_idx on public.dashboard (is_active);
create index if not exists dashboard_start_at_idx on public.dashboard (start_at);
create index if not exists dashboard_end_at_idx on public.dashboard (end_at);
create index if not exists dashboard_created_at_idx on public.dashboard (created_at desc);
create index if not exists dashboard_tag_idx on public.dashboard (tag);

create or replace function public.dashboard_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_dashboard_set_updated_at on public.dashboard;
create trigger trg_dashboard_set_updated_at
before update on public.dashboard
for each row execute function public.dashboard_set_updated_at();

alter table public.dashboard enable row level security;

drop policy if exists dashboard_select_active_for_staff on public.dashboard;
create policy dashboard_select_active_for_staff
on public.dashboard
for select
to authenticated
using (
  (
    is_active = true
    and (start_at is null or start_at <= now())
    and (end_at is null or end_at >= now())
  )
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists dashboard_admin_insert on public.dashboard;
create policy dashboard_admin_insert
on public.dashboard
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists dashboard_admin_update on public.dashboard;
create policy dashboard_admin_update
on public.dashboard
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists dashboard_admin_delete on public.dashboard;
create policy dashboard_admin_delete
on public.dashboard
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

comment on table public.dashboard is 'Notice board items for admin/teacher dashboard';
comment on column public.dashboard.tag is 'urgent | general | reminder';
