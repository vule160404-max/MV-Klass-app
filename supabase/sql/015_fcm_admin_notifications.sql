-- =============================================================================
-- 015 -- FCM admin/teacher balance change notifications
-- - Add profiles.fcm_token
-- - Allow user to update own fcm_token only
-- - Trigger HTTP call to Edge Function on payment_history insert
-- =============================================================================

alter table public.profiles
  add column if not exists fcm_token text;

comment on column public.profiles.fcm_token is
  'FCM Web Push token của thiết bị hiện tại để nhận thông báo biến động số dư.';

-- RLS: cho phép user tự cập nhật token của chính mình (không được đổi role).
drop policy if exists profiles_update_own_fcm_token on public.profiles;
create policy profiles_update_own_fcm_token
  on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
  );

-- Cần extension pg_net để bắn HTTP từ trigger.
create extension if not exists pg_net with schema extensions;

create or replace function public.fn_notify_fcm_balance_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := trim(coalesce(public.fn_get_runtime_setting('app.settings.fcm_edge_url'), ''));
  v_bearer text := trim(coalesce(public.fn_get_runtime_setting('app.settings.fcm_edge_bearer'), ''));
  v_headers jsonb := '{"Content-Type":"application/json"}'::jsonb;
  v_payload jsonb;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;
  if new.student_id is null then
    return new;
  end if;
  if coalesce(new.amount_vnd, 0) < 0 then
    return new;
  end if;
  if v_url = '' then
    -- Không cấu hình URL thì bỏ qua, tránh fail luồng ghi nhận học phí.
    return new;
  end if;

  if v_bearer <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_bearer);
  end if;

  v_payload := jsonb_build_object(
    'type', 'INSERT',
    'table', 'payment_history',
    'record', row_to_json(new)
  );

  perform net.http_post(
    url := v_url,
    headers := v_headers,
    body := v_payload
  );

  return new;
exception when others then
  -- Không chặn transaction chính nếu gọi webhook lỗi.
  return new;
end $$;

drop trigger if exists trg_payment_history_fcm_notify on public.payment_history;
create trigger trg_payment_history_fcm_notify
after insert on public.payment_history
for each row
execute procedure public.fn_notify_fcm_balance_change();

notify pgrst, 'reload schema';
