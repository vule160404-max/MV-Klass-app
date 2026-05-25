-- =============================================================================
-- 001 — profiles: quyền đăng nhập (admin / teacher) + trigger khi tạo user Auth
-- Chạy sau khi project Supabase đã có auth.users (mặc định có sẵn).
-- =============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'teacher'
    check (role in ('admin', 'teacher')),
  created_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);

comment on table public.profiles is 'Một dòng / user; role dùng cho RLS và verifyAdminRole() trong app.';

-- Trigger: mỗi user mới trong auth.users → tạo profile (mặc định teacher)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'teacher')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Chỉ admin (đã có trong bảng) mới được cập nhật profile — tránh tự nâng quyền
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
  on public.profiles for update to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

grant select, update on table public.profiles to authenticated;
