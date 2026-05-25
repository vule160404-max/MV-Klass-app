-- 037 - Lock remaining admin RPC entry points.
-- Keep app-facing admin features available, but reject non-admin authenticated users.

create or replace function public.rename_class_everywhere(old_label text, new_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  att_updated      integer := 0;
  checkin_updated  integer := 0;
  link_updated     integer := 0;
  tc_migrated      integer := 0;
begin
  if not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  if old_label is null or btrim(old_label) = '' or old_label = new_label then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  update public.attendance
  set class_name = new_label
  where class_name = old_label;
  get diagnostics att_updated = row_count;

  update public.teacher_check_ins
  set class_name = new_label
  where class_name = old_label;
  get diagnostics checkin_updated = row_count;

  update public.class_payment_links
  set class_name = new_label
  where class_name = old_label;
  get diagnostics link_updated = row_count;

  insert into public.teacher_classes (teacher_id, class_name)
  select teacher_id, new_label
  from public.teacher_classes
  where class_name = old_label
  on conflict (teacher_id, class_name) do nothing;

  delete from public.teacher_classes where class_name = old_label;
  get diagnostics tc_migrated = row_count;

  return jsonb_build_object(
    'ok', true,
    'attendance_updated', att_updated,
    'checkin_updated', checkin_updated,
    'links_updated', link_updated,
    'teacher_cls_migrated', tc_migrated
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke execute on function public.rename_class_everywhere(text, text) from anon;
grant execute on function public.rename_class_everywhere(text, text) to authenticated;

-- These are scheduled/internal helpers. They should not be callable from browser sessions.
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.cleanup_leaderboard_history_older_than_30_days()',
    'public.fn_call_schedule_notification(text, text)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute 'revoke execute on function ' || sig || ' from anon';
      execute 'revoke execute on function ' || sig || ' from authenticated';
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
