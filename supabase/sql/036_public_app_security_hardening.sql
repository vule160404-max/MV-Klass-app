-- 036 - Public web hardening
-- Goal: make the static app safe to publish without breaking authenticated admin flows.

-- 1) Direct payment_history access must be admin-only.
drop policy if exists payment_history_select_authenticated on public.payment_history;
drop policy if exists payment_history_insert_authenticated on public.payment_history;
drop policy if exists payment_history_delete_authenticated on public.payment_history;
drop policy if exists payment_history_admin_all on public.payment_history;
create policy payment_history_admin_all
  on public.payment_history
  for all to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());

grant select, insert, update, delete on table public.payment_history to authenticated;
revoke all on table public.payment_history from anon;

-- 2) Public users must not be able to execute admin / accounting RPCs.
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.create_center_payment_link(integer)',
    'public.create_class_payment_link(text, integer)',
    'public.create_parent_payment_link(uuid, text, integer)',
    'public.revoke_class_payment_link(bigint)',
    'public.delete_class_payment_link(bigint)',
    'public.revoke_parent_payment_link(bigint)',
    'public.rename_class_everywhere(text, text)',
    'public.list_teachers_for_admin()',
    'public.cleanup_leaderboard_history_older_than_30_days()',
    'public.fn_auto_apply_bank_transaction(bigint)',
    'public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid)',
    'public.fn_manual_confirm_bank_transaction(bigint, boolean, uuid, text)',
    'public.fn_manual_confirm_bank_transaction_v2(bigint, boolean, uuid, text)',
    'public.fn_manual_confirm_bank_transaction_multi(bigint, jsonb)',
    'public.fn_call_schedule_notification(text, text)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute 'revoke execute on function ' || sig || ' from anon';
    end if;
  end loop;
end $$;

-- 3) Prepaid helpers are internal. Attendance triggers can still call them as owner;
--    clients should not call them directly.
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.fn_apply_prepaid_consumption(uuid, text, date)',
    'public.rpc_apply_prepaid_for_lesson(uuid, text, date)',
    'public.fn_reverse_prepaid_auto_one(uuid, text, date, boolean)',
    'public.fn_reverse_prepaid_auto_resolve_class_for_lesson(uuid, date)',
    'public.fn_sync_student_tuition_total(uuid)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute 'revoke execute on function ' || sig || ' from anon';
      execute 'revoke execute on function ' || sig || ' from authenticated';
    end if;
  end loop;
end $$;

-- 4) Keep only truly public parent-payment token readers exposed to anon.
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.resolve_parent_payment_token(text)',
    'public.resolve_class_payment_token(text)',
    'public.resolve_class_parent_payment(text, text, uuid)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute 'grant execute on function ' || sig || ' to anon, authenticated, service_role';
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
