-- =============================================================================
-- 004 — Cấu hình lớp: học phí theo lớp, định nghĩa lịch, lớp tùy chỉnh
-- Giáo viên cần SELECT để hiển thị lịch chấm công / tên lớp; chỉ admin sửa.
-- =============================================================================

create table if not exists public.class_fees (
  class_name text primary key,
  fee_amount integer not null default 0 check (fee_amount >= 0)
);

create table if not exists public.class_definitions (
  label text primary key,
  display_name text not null default '',
  days jsonb not null default '[]'::jsonb,
  schedule jsonb not null default '{}'::jsonb
);

create table if not exists public.custom_classes (
  class_name text primary key
);

alter table public.class_fees enable row level security;
alter table public.class_definitions enable row level security;
alter table public.custom_classes enable row level security;

drop policy if exists class_fees_select_auth on public.class_fees;
create policy class_fees_select_auth
  on public.class_fees for select to authenticated
  using (true);

drop policy if exists class_fees_write_admin on public.class_fees;
create policy class_fees_write_admin
  on public.class_fees for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists class_definitions_select_auth on public.class_definitions;
create policy class_definitions_select_auth
  on public.class_definitions for select to authenticated
  using (true);

drop policy if exists class_definitions_write_admin on public.class_definitions;
create policy class_definitions_write_admin
  on public.class_definitions for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists custom_classes_select_auth on public.custom_classes;
create policy custom_classes_select_auth
  on public.custom_classes for select to authenticated
  using (true);

drop policy if exists custom_classes_write_admin on public.custom_classes;
create policy custom_classes_write_admin
  on public.custom_classes for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select, insert, update, delete on table public.class_fees to authenticated;
grant select, insert, update, delete on table public.class_definitions to authenticated;
grant select, insert, update, delete on table public.custom_classes to authenticated;
