-- 060 — App payment config for estimated receipt PDFs.
-- Run once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.app_payment_config (
  id uuid primary key default gen_random_uuid(),
  config_key text not null unique default 'global',
  bank_name text null,
  account_number text null,
  account_name text null,
  qr_image_url text null,
  transfer_note text null,
  updated_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.app_payment_config_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_app_payment_config_set_updated_at on public.app_payment_config;
create trigger trg_app_payment_config_set_updated_at
before update on public.app_payment_config
for each row execute function public.app_payment_config_set_updated_at();

insert into public.app_payment_config (config_key)
values ('global')
on conflict (config_key) do nothing;

alter table public.app_payment_config enable row level security;

drop policy if exists app_payment_config_select_public on public.app_payment_config;
create policy app_payment_config_select_public
on public.app_payment_config
for select
to public
using (true);

drop policy if exists app_payment_config_admin_insert on public.app_payment_config;
create policy app_payment_config_admin_insert
on public.app_payment_config
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

drop policy if exists app_payment_config_admin_update on public.app_payment_config;
create policy app_payment_config_admin_update
on public.app_payment_config
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

comment on table public.app_payment_config is 'Global bank transfer and QR config displayed on estimated receipt PDFs';
comment on column public.app_payment_config.qr_image_url is 'Public URL or data URL for the transfer QR image';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-assets',
  'payment-assets',
  true,
  2097152,
  array['image/png','image/jpeg']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists payment_assets_select_public on storage.objects;
create policy payment_assets_select_public
on storage.objects
for select
using (bucket_id = 'payment-assets');

drop policy if exists payment_assets_insert_admin on storage.objects;
create policy payment_assets_insert_admin
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-assets'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists payment_assets_update_admin on storage.objects;
create policy payment_assets_update_admin
on storage.objects
for update
to authenticated
using (
  bucket_id = 'payment-assets'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
)
with check (
  bucket_id = 'payment-assets'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists payment_assets_delete_admin on storage.objects;
create policy payment_assets_delete_admin
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'payment-assets'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);
