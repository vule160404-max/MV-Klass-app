-- =============================================================================
-- 011 — Admin: liệt kê giáo viên để gán lớp trên app
-- Cần chạy sau 001_profiles.sql
-- =============================================================================

drop function if exists public.list_teachers_for_admin();

create function public.list_teachers_for_admin()
returns table (id uuid, email text, display_name text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'NO_PERMISSION';
  end if;

  return query
  select p.id, u.email::text, nullif(trim(p.display_name), '')::text
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'teacher'
  order by nullif(trim(p.display_name), '') asc nulls last, u.email asc nulls last;
end;
$$;

grant execute on function public.list_teachers_for_admin() to authenticated;

notify pgrst, 'reload schema';
