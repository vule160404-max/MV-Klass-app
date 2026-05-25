# Cloudflare R2 Exam Files

This setup keeps existing exam files in Supabase Storage and stores new files in a private Cloudflare R2 bucket.

## Setup

1. Run `supabase/sql/073_exam_files_cloudflare_r2.sql`.
2. Create a private R2 bucket, for example `mvklass-exam-files`.
3. Set Supabase Edge Function secrets:

```powershell
npx supabase secrets set R2_ACCOUNT_ID="..."
npx supabase secrets set R2_ACCESS_KEY_ID="..."
npx supabase secrets set R2_SECRET_ACCESS_KEY="..."
npx supabase secrets set R2_BUCKET="mvklass-exam-files"
```

4. Deploy the Edge Function:

```powershell
npx supabase functions deploy exam-download-url
npx supabase functions deploy exam-sync-r2
```

5. Upload new exam files to R2 using the existing file naming convention.
6. Sync metadata after upload:

```powershell
cd scripts
$env:MVKLASS_R2_SYNC_DRY_RUN='1'
npm run sync:r2-exams

Remove-Item Env:\MVKLASS_R2_SYNC_DRY_RUN
npm run sync:r2-exams
```

Required sync env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`.

Admins can also run the same sync from the web app: open the admin portal tab and click **Đồng bộ kho đề**. The button calls `exam-sync-r2`, upserts current R2 exam files into `exam_files`, and unpublishes R2 rows whose objects were deleted from the bucket.
