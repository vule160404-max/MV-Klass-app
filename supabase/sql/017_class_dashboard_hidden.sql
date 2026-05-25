-- =============================================================================
-- 017 — Ẩn lớp khỏi dashboard (admin + GV): không đụng học phí / điểm danh / báo cáo
-- Sau khi chạy: Supabase → Settings → API → Reload schema (nếu PostgREST cache cũ).
-- =============================================================================

alter table public.class_definitions
  add column if not exists dashboard_hidden boolean not null default false;

alter table public.custom_classes
  add column if not exists dashboard_hidden boolean not null default false;

comment on column public.class_definitions.dashboard_hidden is
  'true = không hiển thị lớp này trên dashboard (lịch hôm nay, KPI lớp). Học phí và tab khác không đổi.';

comment on column public.custom_classes.dashboard_hidden is
  'true = không hiển thị lớp tùy chỉnh trên dashboard.';
