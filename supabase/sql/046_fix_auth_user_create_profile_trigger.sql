-- =============================================================================
-- 046 - Fix Supabase Auth user creation
-- Auth user creation was failing because old profile triggers referenced
-- profiles.full_name (missing) and role='staff' (not allowed).
-- Also allow role='student' for the new student exam portal.
-- =============================================================================

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'teacher', 'student'));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  display text;
begin
  r := lower(trim(coalesce(new.raw_user_meta_data->>'role', '')));
  if r not in ('admin', 'teacher', 'student') then
    r := 'teacher';
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(trim(split_part(coalesce(new.email, ''), '@', 1)), '')
  );

  insert into public.profiles (id, email, role, display_name)
  values (new.id, new.email, r, display)
  on conflict (id) do update
  set
    email = coalesce(excluded.email, public.profiles.email),
    role = coalesce(nullif(excluded.role, ''), public.profiles.role),
    display_name = coalesce(nullif(excluded.display_name, ''), public.profiles.display_name);

  return new;
end;
$$;

-- Keep only one Auth -> profiles trigger to avoid duplicate/legacy behavior.
drop trigger if exists on_auth_user_created_profile on auth.users;
drop function if exists public.handle_new_user_profile();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

notify pgrst, 'reload schema';
