-- =============================================================================
-- 076 - Harden public Auth signup role assignment
-- Public signup metadata is untrusted. New Auth users must not be able to choose
-- admin/teacher by sending raw_user_meta_data.role from the browser.
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
  display text;
  free_group text;
  class_label text;
begin
  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(trim(split_part(coalesce(new.email, ''), '@', 1)), '')
  );

  free_group := lower(trim(coalesce(
    new.raw_user_meta_data->>'portal_free_group',
    new.raw_user_meta_data->>'student_class_group',
    ''
  )));
  if free_group not in ('entrance_10', 'university', 'ielts') then
    free_group := 'entrance_10';
  end if;

  class_label := case free_group
    when 'university' then 'THPT QG'
    when 'ielts' then 'IELTS'
    else null
  end;

  insert into public.profiles (
    id,
    email,
    role,
    display_name,
    portal_plan,
    portal_status,
    portal_free_group,
    portal_class_label
  )
  values (
    new.id,
    new.email,
    'student',
    display,
    'free',
    'active',
    free_group,
    class_label
  )
  on conflict (id) do update
  set
    email = coalesce(excluded.email, public.profiles.email),
    display_name = coalesce(nullif(excluded.display_name, ''), public.profiles.display_name),
    portal_free_group = case
      when public.profiles.role = 'student'
        then coalesce(excluded.portal_free_group, public.profiles.portal_free_group)
      else public.profiles.portal_free_group
    end,
    portal_class_label = case
      when public.profiles.role = 'student'
        then coalesce(excluded.portal_class_label, public.profiles.portal_class_label)
      else public.profiles.portal_class_label
    end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

notify pgrst, 'reload schema';
