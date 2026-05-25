-- =============================================================================
-- 007 - Center logo storage bucket.
-- Keeps the public logo asset path used by static pages. Dynamic branding config
-- was removed with the retired Theme & Branding feature.
-- =============================================================================

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding',
  'branding',
  true,
  2097152,
  array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists branding_objects_select_public on storage.objects;
create policy branding_objects_select_public
  on storage.objects for select
  using (bucket_id = 'branding');

commit;
