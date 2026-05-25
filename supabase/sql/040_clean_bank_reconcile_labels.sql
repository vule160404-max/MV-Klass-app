-- 040 - Clean manual bank reconciliation labels shown in the app.
-- "Lớp đã đối soát" should describe classes, not students/technical states.

with tx_summary as (
  select
    bt.id,
    count(ph.id)::integer as line_count,
    count(distinct ph.student_id)::integer as student_count,
    count(distinct split_part(nullif(btrim(ph.class_name), ''), ' ' || chr(8226) || ' ', 1))::integer as class_count,
    string_agg(
      distinct split_part(nullif(btrim(ph.class_name), ''), ' ' || chr(8226) || ' ', 1),
      ', '
      order by split_part(nullif(btrim(ph.class_name), ''), ' ' || chr(8226) || ' ', 1)
    ) as class_names,
    coalesce(sum(coalesce(ph.sessions_paid, 0)), 0)::integer as sessions_paid,
    coalesce(sum(coalesce(ph.prepaid_topup_vnd, 0)), 0)::integer as prepaid_topup
  from public.bank_transactions bt
  join public.payment_history ph on ph.bank_transaction_id = bt.id
  where bt.status in ('manual_received', 'applied')
  group by bt.id
)
update public.bank_transactions bt
set
  matched_class_name = case
    when s.class_count >= 1 then s.class_names
    else null
  end,
  reconcile_note =
    'Đối soát thủ công: ' ||
    s.sessions_paid::text ||
    ' buổi' ||
    case
      when s.prepaid_topup > 0 then ', dư học phí ' || replace(to_char(s.prepaid_topup, 'FM999G999G999'), ',', '.') || ' VND'
      else ''
    end
from tx_summary s
where bt.id = s.id
  and (
    bt.matched_class_name in ('Nhiều học viên', 'Nhieu dong')
    or bt.reconcile_note ~* 'manual|sessions|lines|prepaid|mua|nhiều hv|hoc vien'
  );

update public.payment_history ph
set reconcile_note =
  'Đối soát thủ công giao dịch #' ||
  ph.bank_transaction_id::text ||
  case when coalesce(ph.prepaid_topup_vnd, 0) > 0 then ', có lưu dư học phí' else '' end
where ph.bank_transaction_id is not null
  and ph.reconcile_note ~* 'manual|prepaid|topup|nhiều hv|mua|hoc vien|sessions|lines';

notify pgrst, 'reload schema';
