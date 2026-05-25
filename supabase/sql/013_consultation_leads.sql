-- =============================================================================
-- 013 — Đăng ký tư vấn từ landing (phụ huynh) + quản trị trong ClassHub
-- Yêu cầu: 001_profiles
-- Sau khi chạy: NOTIFY reload schema (cuối file).
-- =============================================================================

create table if not exists public.consultation_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  student_name text not null,
  parent_phone text not null,
  grade text not null,
  program_key text not null,
  program_label text not null,
  notes text,
  status text not null default 'new'
    check (status in ('new', 'contacted', 'closed', 'archived')),
  admin_note text,
  source text not null default 'landing'
);

create index if not exists consultation_leads_created_idx
  on public.consultation_leads (created_at desc);

create index if not exists consultation_leads_status_idx
  on public.consultation_leads (status);

comment on table public.consultation_leads is 'Form tư vấn landing → anon insert; admin đọc/sửa/xóa trong app.';

alter table public.consultation_leads enable row level security;

-- Khách (landing): chỉ được thêm bản ghi, không đọc/sửa
drop policy if exists consultation_leads_insert_anon on public.consultation_leads;
create policy consultation_leads_insert_anon
  on public.consultation_leads for insert to anon
  with check (
    coalesce(source, 'landing') = 'landing'
    and length(trim(student_name)) between 1 and 200
    -- SĐT tối thiểu 8 ký tự sau trim (số thử "111111" sẽ bị từ chối).
    and length(trim(parent_phone)) between 8 and 40
    and length(trim(grade)) between 1 and 30
    and length(trim(program_key)) between 1 and 80
    and length(trim(program_label)) between 1 and 400
    and (notes is null or length(notes) <= 2000)
    and status = 'new'
    and admin_note is null
  );

-- Admin: đọc / cập nhật / xóa
drop policy if exists consultation_leads_select_admin on public.consultation_leads;
create policy consultation_leads_select_admin
  on public.consultation_leads for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists consultation_leads_update_admin on public.consultation_leads;
create policy consultation_leads_update_admin
  on public.consultation_leads for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists consultation_leads_delete_admin on public.consultation_leads;
create policy consultation_leads_delete_admin
  on public.consultation_leads for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant insert on table public.consultation_leads to anon;
grant select, insert, update, delete on table public.consultation_leads to authenticated;

notify pgrst, 'reload schema';
