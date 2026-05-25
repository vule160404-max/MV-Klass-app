-- 069 - Clean legacy mojibake bank note text so the UI no longer displays
-- broken Vietnamese in the transaction info column.

update public.bank_transactions
set error_note = 'Không match được học sinh theo nội dung chuyển khoản'
where error_note = 'Kh?ng match ???c h?c sinh theo n?i dung chuy?n kho?n';

update public.bank_transactions
set error_note = 'Match chưa đủ chắc chắn, cần chọn học sinh từ gợi ý'
where error_note = 'Match ch?a ?? ch?c ch?n, c?n ch?n h?c sinh t? g?i ?';

update public.bank_transactions
set error_note = 'Match độ tin cậy cao, chờ đối soát / auto apply'
where error_note = 'Match high confidence, ch? ??i so?t/auto apply';

update public.bank_transactions
set error_note = null
where status in ('applied', 'manual_received')
  and error_note in (
    'Không match được học sinh theo nội dung chuyển khoản',
    'Match chưa đủ chắc chắn, cần chọn học sinh từ gợi ý',
    'Match độ tin cậy cao, chờ đối soát / auto apply'
  );

update public.bank_transactions
set reconcile_note = replace(reconcile_note, 'Auto: match parent_name (high, score 120) - tru no truoc qua nhieu lop', 'Tự động: khớp tên phụ huynh, đã trừ nợ trước qua nhiều lớp')
where reconcile_note = 'Auto: match parent_name (high, score 120) - tru no truoc qua nhieu lop';
