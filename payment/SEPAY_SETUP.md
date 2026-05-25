# SePay Setup for ClassHub

This project now supports SePay webhook -> Supabase -> auto tuition apply.
Parent payment links support:
- Class signed link (parent enters phone)
- Center signed link (parent enters phone)

Parent portal page is served as static file (not from edge function HTML render):
- Upload `parent-payment.html` to a public storage bucket (example: `public-pages`)
- Set `APP_CONFIG.payments.parentPortalBaseUrl` to:
  `https://<your-project-ref>.supabase.co/storage/v1/object/public/public-pages/parent-payment.html`

## 1) Run SQL migrations

In Supabase SQL Editor, run:

1. Existing files in order (`001...008`, if not done yet)
2. `supabase/sql/009_bank_webhook_integration.sql`
3. `supabase/sql/999_post_deploy.sql`

## 2) Deploy edge function

From project root:

```bash
supabase functions deploy bank-webhook
supabase functions deploy parent-payment
```

> Note: `parent-payment` is JSON API only. Do not use `?view=1` to render HTML from the function URL.

## 3) Set function secrets

Choose a strong random value for `BANK_WEBHOOK_SECRET`.

```bash
supabase secrets set \
  BANK_WEBHOOK_SECRET="replace_with_random_secret" \
  SEPAY_QR_ACC="688616046886" \
  SEPAY_QR_BANK="MB" \
  SUPABASE_URL="https://<your-project-ref>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
```

## 4) Configure SePay webhook

In SePay dashboard webhook settings:

- **Webhook URL**:
  `https://<your-project-ref>.supabase.co/functions/v1/bank-webhook`
- **Method**: `POST`
- **Auth header**: `Authorization: Bearer <BANK_WEBHOOK_SECRET>`
  - If SePay cannot set Authorization, you can use:
    - header `x-sepay-token: <BANK_WEBHOOK_SECRET>`, or
    - query string `?token=<BANK_WEBHOOK_SECRET>`

## 5) Transfer content format (important)

Parent portal now pre-fills transfer content as:

`<Student Name> - <Parent Phone>`

Examples:

- `Ngoc Babi - 0905123456`
- `Tran An - 0912345678`

Auto apply ưu tiên match theo `REF` (nếu ngân hàng vẫn có REF trong nội dung), fallback theo SĐT trong nội dung CK.
Số buổi được suy ra theo số tiền / học phí lớp khi không có số buổi trong nội dung.

## 6) How auto-apply works

1. Webhook payload is stored in `bank_webhook_events`
2. Transaction is upserted into `bank_transactions`
3. RPC `fn_auto_apply_bank_transaction` runs:
   - if `REF` hợp lệ -> ưu tiên map đúng học sinh theo `parent_payment_refs`
   - else fallback theo tên/SĐT trong nội dung chuyển khoản
   - số buổi ưu tiên tách từ nội dung; nếu không có thì suy ra từ `amount_vnd / fee_per_session`
   - nếu match chắc chắn + có buổi nợ:
     - update `student_tuition.charged_sessions`
     - insert into `payment_history`
     - mark transaction `applied`
   - otherwise mark `needs_review`

## 7) Verify quickly

Run in SQL editor:

```sql
select id, provider, provider_txn_id, amount_vnd, transfer_content, status, error_note, created_at
from public.bank_transactions
order by id desc
limit 20;
```

And:

```sql
select id, student_id, sessions_paid, amount_vnd, paid_at
from public.payment_history
order by id desc
limit 20;
```

## 8) Common issues

- `Unauthorized`:
  wrong/missing `BANK_WEBHOOK_SECRET`
- `needs_review`:
  transfer content does not uniquely match a student, hoặc số tiền không suy ra được số buổi
- `SESSIONS_NOT_FOUND`:
  không có số buổi trong nội dung và cũng không suy ra được từ amount/fee
- `NO_PENDING_SESSIONS`:
  student has no unpaid present sessions left
