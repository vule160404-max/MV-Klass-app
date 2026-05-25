-- 062 - Remove retired Theme & Branding configuration.

do $$
begin
  if to_regclass('public.app_theme_config') is not null then
    drop trigger if exists trg_app_theme_config_set_updated_at on public.app_theme_config;
  end if;
end $$;

drop table if exists public.app_theme_config;
drop function if exists public.app_theme_config_set_updated_at();

drop table if exists public.app_branding;

drop policy if exists branding_objects_insert_admin on storage.objects;
drop policy if exists branding_objects_update_admin on storage.objects;
drop policy if exists branding_objects_delete_admin on storage.objects;

notify pgrst, 'reload schema';
