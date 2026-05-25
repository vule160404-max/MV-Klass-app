-- 038 - Revoke direct browser execution for internal helpers.
-- These functions are still callable by their owning SECURITY DEFINER RPCs/triggers.

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.extract_payment_ref_from_transfer_content(text)',
    'public.extract_sessions_from_transfer_content(text)',
    'public.fn_get_runtime_setting(text)',
    'public.fn_notify_fcm_balance_change()',
    'public.fn_pending_sessions_for_class(uuid, text)',
    'public.fn_pending_sessions_for_class_strict(uuid, text)',
    'public.handle_new_user()',
    'public.handle_new_user_profile()',
    'public.make_random_hex(integer)',
    'public.match_student_from_transfer_content(text)',
    'public.payment_history_student_id_to_uuid(text)',
    'public.teacher_check_ins_set_email()',
    'public.tg_app_runtime_settings_updated_at()',
    'public.tg_set_updated_at()',
    'public.tg_user_fcm_tokens_updated_at()',
    'public.tg_user_web_push_subscriptions_updated_at()',
    'public.trg_attendance_after_apply_prepaid()',
    'public.trg_attendance_prepaid_after()',
    'public.trg_sync_student_tuition_total_from_class()'
  ] loop
    if to_regprocedure(sig) is not null then
      execute 'revoke execute on function ' || sig || ' from anon';
      execute 'revoke execute on function ' || sig || ' from authenticated';
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
