# MV-Klass Tool Policy

Use `mvklass.ops_query` first for natural-language operations questions.

## Read Examples

- "Hôm nay tôi có những lớp nào?" -> `mvklass.ops_query({ "question": "Hôm nay tôi có những lớp nào?" })`
- "Ai còn nợ học phí nhiều nhất?" -> `mvklass.ops_query({ "question": "Ai còn nợ học phí nhiều nhất?" })`
- "Tra cứu học viên Dương" -> `mvklass.ops_query({ "question": "Tra cứu học viên Dương" })`
- "Doanh thu hôm nay" -> `mvklass.ops_query({ "question": "Doanh thu hôm nay" })`
- "Giao dịch ngân hàng cần kiểm tra" -> `mvklass.ops_query({ "question": "Giao dịch ngân hàng cần kiểm tra" })`
- "Soạn nháp nhắc phí cho Sơn" -> `mvklass.ops_query({ "question": "Soạn nháp nhắc phí cho Sơn" })`
- "Ai có nguy cơ bỏ học tuần này?" -> `mvklass.ops_query({ "question": "Ai có nguy cơ bỏ học tuần này?" })`
- "Lớp nào chưa điểm danh?" -> `mvklass.ops_query({ "question": "Lớp nào chưa điểm danh?" })`

If `ops_query` returns an answer, use it as the main response. Do not ignore tool output and do not answer from memory.

Additional FAQ/read examples:

- "Lịch dạy của tôi trong 1 tuần" -> `mvklass.ops_query({ "question": "Lịch dạy của tôi trong 1 tuần" })`
- "Lớp nào chưa điểm danh hôm qua?" -> `mvklass.ops_query({ "question": "Lớp nào chưa điểm danh hôm qua?" })`
- "Tuần này ai vắng nhiều?" -> `mvklass.ops_query({ "question": "Tuần này ai vắng nhiều?" })`
- "Học sinh nào trong lớp MVK_C2_N1 chưa có SĐT?" -> `mvklass.ops_query({ "question": "Học sinh nào trong lớp MVK_C2_N1 chưa có SĐT?" })`
- "Lớp nào đang nợ nhiều nhất?" -> `mvklass.ops_query({ "question": "Lớp nào đang nợ nhiều nhất?" })`
- "Doanh thu theo điểm danh và thực thu chênh nhau không?" -> `mvklass.ops_query({ "question": "Doanh thu theo điểm danh và thực thu chênh nhau không?" })`
- "Giao dịch gần nhất là gì?" -> `mvklass.ops_query({ "question": "Giao dịch gần nhất là gì?" })`
- "Tôi hỏi được gì?" -> `mvklass.faq_catalog({})`

## Write Examples

- "Son dong 1tr2" -> `mvklass.prepare_action({ "request": "Son dong 1tr2" })`
- "Hung nop 700" -> `mvklass.prepare_action({ "request": "Hung nop 700" })`
- "Ghi Son da dong 1.200.000d tien mat hom nay" -> `mvklass.prepare_action({ "request": "Ghi Son da dong 1.200.000d tien mat hom nay" })`

- "Chấm lớp MVK_C2_N1 hôm nay tất cả có mặt trừ Sơn" -> `mvklass.prepare_action({ "request": "Chấm lớp MVK_C2_N1 hôm nay tất cả có mặt trừ Sơn" })`
- "Cập nhật ghi chú Sơn: cần luyện thêm bài đọc" -> `mvklass.prepare_action({ "request": "Cập nhật ghi chú Sơn: cần luyện thêm bài đọc" })`
- "Đánh dấu lead số 090... đã liên hệ" -> `mvklass.prepare_action({ "request": "Đánh dấu lead số 090... đã liên hệ" })`
- "482913" -> `mvklass.confirm_action({ "code": "482913", "message": "482913" })`
- "XÁC NHẬN MVK-482913" -> `mvklass.confirm_action({ "code": "MVK-482913", "message": "XÁC NHẬN MVK-482913" })`
- "HỦY MVK-482913" -> `mvklass.cancel_action({ "code": "MVK-482913" })`
- "Hủy điểm danh của lớp MVK_C2_N1 hôm nay" -> `mvklass.prepare_action({ "request": "Hủy điểm danh của lớp MVK_C2_N1 hôm nay" })`
- "Hoàn tác MVK-482913" -> `mvklass.prepare_undo_action({ "code": "MVK-482913", "request": "Hoàn tác MVK-482913" })`

Rules:

- Cash tuition payment requests are write actions. They are equivalent to the webapp manual "Thu tien mat" flow, not revenue lookup and not bank reconciliation.
- Cash tuition payment examples such as `1tr2`, `700k`, `700`, and `1.200.000d` must be previewed first and confirmed with a code before writing.
- Do not route "doanh thu..." questions to cash payment actions. Revenue remains a read query through `ops_query`.
- `prepare_action` does not write data. It only creates a pending action and returns preview plus confirmation code.
- Only call `confirm_action` when the admin message is exactly the 6-digit code, exactly `MVK-xxxxxx`, or exactly `XÁC NHẬN <mã>`.
- Do not call `confirm_action` for `ok`, `được`, `làm đi`, or any implicit approval.
- Do not call `confirm_action` for a selection number like `1` or `2`.
- Passing only `{ "code": "MVK-..." }` is not enough; include the original exact confirmation message.
- Use `list_pending_actions` when the admin asks what is waiting for confirmation.
- `cancel_action` is only for pending confirmation codes. Do not use it for deleting attendance; deleting attendance must go through `prepare_action` and receive a new confirmation code.
- `prepare_undo_action` is also two-step. It creates a new pending undo action and must be confirmed with the new exact 6-digit code or exact `XÁC NHẬN <mã>`.
- Bank reconciliation and real parent-message sending are not enabled in v1.

## Narrow Read Tools

Use narrow tools only for explicit low-level lookups:

- `mvklass.today_overview`
- `mvklass.faq_catalog`
- `mvklass.student_lookup`
- `mvklass.tuition_debt_list`
- `mvklass.bank_review_list`
- `mvklass.ops_alerts`
- `mvklass.list_audit_log`
- `mvklass.ops_daily_digest`
- `mvklass.draft_parent_tuition_message`

## Proactive Alerts

For automatic Telegram reminders, run `scripts/mvklass-alert-runner.js` from cron. It calls `mvklass.ops_alerts`, deduplicates recent alerts, then sends Telegram using `MVKLASS_TELEGRAM_BOT_TOKEN`/`MVKLASS_TELEGRAM_CHAT_ID` or `/root/.openclaw/openclaw.json`.

For the automatic 7:00 daily report, run the same runner with daily mode:

`0 7 * * * cd /root/ai-server && MVKLASS_RUNNER_MODE=daily node scripts/mvklass-alert-runner.js >> /root/.openclaw/mvklass-daily.log 2>&1`

Use `mvklass.list_audit_log` for questions like "Ai đã sửa điểm danh Sơn hôm qua?", "Mã MVK-123456 đã làm gì?", or "Hôm nay đã thu tiền mặt ai?". Use `mvklass.ops_daily_digest` for "việc cần làm hôm nay" or "báo cáo sáng nay".

Permissions are configured by `/root/.openclaw/mvklass-permissions.json`. When OpenClaw does not pass an actor id, MCP falls back to `Thầy Vũ / admin`; future teacher actors can be class-scoped through that file.

## Write Tools

- `mvklass.prepare_action`
- `mvklass.confirm_action`
- `mvklass.cancel_action`
- `mvklass.prepare_undo_action`
- `mvklass.list_pending_actions`
