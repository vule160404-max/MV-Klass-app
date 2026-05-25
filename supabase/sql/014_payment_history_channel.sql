-- =============================================================================
-- 014 — Kênh ghi nhận học phí (Thu tiền mặt / lớp / xác nhận CK / ngân hàng tự động)
-- Chạy sau 005_student_tuition_payment.sql
-- Giúp lịch sử rõ nguồn, tránh nhầm với ghi nhận khác.
-- =============================================================================

alter table public.payment_history
  add column if not exists payment_channel text;

comment on column public.payment_history.payment_channel is
  'cash | transfer_confirm | class_collect | bank_auto — null = bản ghi cũ';

create index if not exists idx_payment_history_channel
  on public.payment_history (payment_channel)
  where payment_channel is not null;

-- PostgREST (REST API) đôi khi chưa “thấy” cột mới: chạy thêm dòng này trong SQL Editor, rồi thử lại app.
notify pgrst, 'reload schema';
