-- =============================================================================
-- 999 — Làm mới cache schema PostgREST (sau khi tạo/sửa bảng)
-- =============================================================================

alter table if exists public.bank_webhook_events
  alter column provider set default 'sepay';

alter table if exists public.bank_transactions
  alter column provider set default 'sepay';

alter table if exists public.students
  add column if not exists class_names text[] not null default '{}'::text[];

update public.students
set class_names = case
  when coalesce(array_length(class_names, 1), 0) > 0 then class_names
  when class_name is null or btrim(class_name) = '' then '{}'::text[]
  else array[class_name]
end;

alter table if exists public.attendance
  add column if not exists class_name text;

update public.attendance a
set class_name = s.class_name
from public.students s
where s.id = a.student_id
  and (a.class_name is null or btrim(a.class_name) = '');

create or replace function public.delete_class_payment_link(p_link_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  delete from public.parent_payment_refs
  where class_link_id = p_link_id;

  delete from public.class_payment_links
  where id = p_link_id;

  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.delete_class_payment_link(bigint) to authenticated;

notify pgrst, 'reload schema';
