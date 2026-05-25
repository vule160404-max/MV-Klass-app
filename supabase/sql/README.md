# SQL migrations — MV-Klass

Chạy theo **số tăng dần** trên môi trường mới (Supabase SQL Editor hoặc `psql`). Các file dùng `CREATE OR REPLACE` / `IF NOT EXISTS` nên lặp lại an toàn trong nhiều trường hợp.

## Thứ tự chuẩn

| Thứ tự | File | Nội dung gợi ý |
|--------:|------|-----------------|
| 1 | `001_profiles.sql` | Vai trò admin / profiles |
| 2 | `002_teacher_classes.sql` | Lớp–giáo viên |
| 3 | `003_students_attendance.sql` | Học sinh + điểm danh |
| 4 | `004_class_catalog.sql` | Danh mục lớp + học phí |
| 5 | `005_student_tuition_payment.sql` | Học phí tổng + payment_history |
| 6 | `006_teacher_check_ins.sql` | Check-in giáo viên |
| 7 | `007_app_branding_storage.sql` | Logo storage |
| 8 | `008_optional_realtime.sql` | Realtime (tuỳ chọn) |
| 9 | `009_bank_webhook_integration.sql` | Webhook bank + `match_student_from_transfer_content` (bản gốc) |
| 10 | `010_bank_manual_receipt_confirm.sql` | Thu tay, `fn_pending_sessions_for_class`, `fn_sync_student_tuition_total` |
| 11 | `011_list_teachers_for_admin.sql` | RPC danh sách GV |
| 12 | `012_students_learning_note.sql` | Ghi chú học tập |
| 13 | `013_consultation_leads.sql` | Lead tư vấn |
| 14 | `014_payment_history_channel.sql` | Cột `payment_channel` |
| 15 | `015_fcm_admin_notifications.sql` | FCM admin |
| 16 | `016_schedule_notifications.sql` | Cron / thông báo lịch |
| 17 | `017_class_dashboard_hidden.sql` | Ẩn lớp trên dashboard |
| 18 | `018_web_push_subscriptions.sql` | Web push |
| 19 | `019_student_transfer_outstanding_class.sql` | Chuyển lớp / nợ |
| 20 | `020_bank_manual_multi_alloc.sql` | Đối soát đa lớp |
| 21 | `021_tuition_prepaid_balance.sql` | Prepaid balance + bản `fn_apply` 2 tham số cũ; **031** ghi đè trigger và hàm 3 tham số |
| 22 | `022_parent_portal_tuition_align.sql` | Cổng phụ huynh / học phí |
| 23 | `023_parent_payment_optional_phone.sql` | Thanh toán link + SĐT tuỳ chọn |
| 24 | `024_parent_payment_all_classes_debt.sql` | Nợ đa lớp |
| 25 | `025_students_birth_year.sql` | Năm sinh HV |
| 26 | `026_students_parent_name.sql` | Tên phụ huynh |
| 27 | `027_user_fcm_tokens_multi_device.sql` | FCM đa thiết bị |
| 28 | `028_match_student_from_transfer_content.sql` | Siết khớp CK (ghi đè 009) |
| 29 | `029_leaderboard_manual_scores.sql` | Điểm tay bảng xếp hạng (thành tích / cống hiến) |
| 30 | *(trống)* | Dành bổ sung; không bắt buộc |
| 31 | `031_attendance_prepaid_reverse.sql` | **Toàn bộ prepaid điểm danh + RPC** — nên chạy sau 021 |
| 32 | `032_auto_apply_bank_partial_single_class.sql` | Auto CK một lớp: CK < tổng nợ nhưng chia hết học phí/buổi |
| 33 | `033_leaderboard_performance_history.sql` | Lịch sử cộng điểm leaderboard (thành tích / cống hiến) |
| 34 | `034_leaderboard_minigame_pts.sql` | **Top minigame**: thêm `minigame_pts` cho `leaderboard_manual_scores` + mở rộng metric history |
| 55 | `055_student_exam_activity.sql` | Student portal: tài liệu đã lưu |
| 56 | `056_drop_student_exam_recent_activity.sql` | Student portal: chỉ giữ tài liệu đã lưu |
| 57 | `057_exam_upload_filename_standard.sql` | Chuẩn tên file upload kho đề + đồng bộ tên hiển thị |
| 58 | `058_exam_official_mock_badges.sql` | Phân biệt đề chính thức / đề minh họa trên kho đề |
| 59 | `059_exam_storage_attachment_backfill.sql` | Ghép đáp án/audio từ Storage khi upload gần đồng thời |
| 60 | `060_app_payment_config.sql` | Cấu hình QR/STK chuyển khoản cho PDF phiếu thu |
| 61 | `061_exam_sync_advisory_lock.sql` | Khóa đồng bộ theo mã đề để tránh race khi upload cặp file |
| 62 | `062_drop_theme_branding.sql` | Xóa cấu hình Theme & Branding đã gỡ khỏi app |
| 99 | `999_post_deploy.sql` | Hậu kiểm (class_names, …) + `notify pgrst` |

## Thư mục `tools/`

Script **không** nằm trong chuỗi số; chỉ chạy khi cần xử lý sự cố:

- `tools/cleanup_orphan_prepaid_auto.sql` — dọn `prepaid_auto` mồ côi (sửa `v_sid` trong file).

## Chuẩn tên file kho đề

Upload vào bucket Supabase Storage `exam-files` bằng tên không dấu để hệ thống tự sinh tên đẹp trên web:

- Đề chính: `De 001 Vao 10 Thanh Hoa 2025.pdf`
- Đề chính thức: `De chinh thuc Vao 10 Thanh Hoa 2025.pdf`
- Đề minh họa: `De 001 Vao 10 Thanh Hoa 2025.pdf`
- Đáp án: `Dap an De 001 Vao 10 Thanh Hoa 2025.pdf`
- Audio: `Audio De 001 Vao 10 Thanh Hoa 2025.mp3`
- THPT: `De 001 THPT Thanh Hoa 2025.pdf`

Có thể đặt trong thư mục như `vao-10/` hoặc `thpt/`; parser chỉ đọc tên file cuối cùng.

## Triển khai nhanh chỉ phần prepaid điểm danh

Repo có `scripts/deploy-prepaid-sql.ps1` trỏ tới `031_attendance_prepaid_reverse.sql` (cần `DATABASE_URL` trong `.env.local` hoặc `-UseLinked`).
