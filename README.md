# MV-Klass

MV-Klass is a static Supabase-backed operations app for class, attendance, tuition, bank, teacher, lead, and portal management.

## Folder Layout

- `web/` - Vercel-ready static site. Set this as the Vercel Root Directory.
- `web/assets/` - images grouped by purpose: `brand`, `feedback`, `social`, `ai`.
- `supabase/sql/` - database migrations and SQL maintenance scripts.
- `supabase/functions/` - Supabase Edge Functions.
- `scripts/` - local/ops scripts and MCP runner files.
- `payment/` - legacy parent payment page and SePay setup notes.
- `docs/openclaw/` - OpenClaw/MCP operation notes.

Local runtime folders such as `.codex/`, `data/`, and `test-results/` are ignored by git.

## Vercel Deploy

1. Push this repository to GitHub.
2. Import the GitHub repo in Vercel.
3. Set **Root Directory** to `web`.
4. Leave build command empty for static hosting.
5. Deploy. The main routes are:
   - `/` and `/landing` -> landing page
   - `/app` -> admin app

Do not commit `.env.local` or Firebase service account JSON files.
