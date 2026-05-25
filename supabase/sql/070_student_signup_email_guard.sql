-- =============================================================================
-- 070 - Guard student signup against existing staff/student emails
-- =============================================================================

create or replace function public.student_signup_email_status(p_email text)
returns table (
  can_register boolean,
  reason text
)
language sql
stable
security definer
set search_path = public, auth
as $$
  with normalized as (
    select lower(trim(coalesce(p_email, ''))) as email
  ),
  existing as (
    select
      u.id,
      coalesce(p.role, '') as role
    from normalized n
    join auth.users u on lower(u.email) = n.email
    left join public.profiles p on p.id = u.id
    where n.email <> ''
    limit 1
  )
  select
    not exists (select 1 from existing) as can_register,
    case
      when (select email from normalized) = '' then 'invalid_email'
      when exists (select 1 from existing where role in ('admin', 'teacher')) then 'staff_email'
      when exists (select 1 from existing) then 'existing_account'
      else 'available'
    end as reason;
$$;

grant execute on function public.student_signup_email_status(text) to anon, authenticated;

notify pgrst, 'reload schema';
