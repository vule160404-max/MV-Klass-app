#Requires -Version 5.1
<#
  Triển khai SQL prepaid + điểm danh (file 031) lên Postgres Supabase.
  Cách 1 — Khuyến nghị: trong .env.local đặt DATABASE_URL (URI từ Dashboard → Database).
  Cách 2: chạy `npx supabase login` rồi `npx supabase link --project-ref <ref>` tại thư mục repo,
          sau đó chạy script với -UseLinked (không cần DATABASE_URL).
  Mật khẩu trong URI nếu có ký tự đặc biệt có thể cần URL-encode (Supabase thường có nút copy đã encode).
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$UseLinked
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

function Read-DotEnvFile {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    if ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
    if ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
    $map[$k] = $v
  }
  $map
}

$sqlRel = "supabase\sql\031_attendance_prepaid_reverse.sql"
$sqlPath = Join-Path $RepoRoot $sqlRel
if (-not (Test-Path $sqlPath)) {
  Write-Error "Không tìm thấy $sqlRel (chạy script từ repo MV-Klass)."
}

$envPath = Join-Path $RepoRoot ".env.local"
$vars = Read-DotEnvFile $envPath
$dbUrl = $vars["DATABASE_URL"]
if ([string]::IsNullOrWhiteSpace($dbUrl)) { $dbUrl = [Environment]::GetEnvironmentVariable("DATABASE_URL", "Process") }

if ($UseLinked) {
  Write-Host "Chay supabase db query --linked ..."
  npx --yes supabase@latest db query -f $sqlPath --linked --agent no
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "Xong."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  Write-Host ""
  Write-Host "CHUA CO KET NOI DATABASE:" -ForegroundColor Yellow
  Write-Host "  1) Mo file .env.local va dien DATABASE_URL=... (Supabase: Settings - Database - Connection string - URI), hoac"
  Write-Host "  2) Chay: npx supabase login ; npx supabase link --project-ref <ref>"
  Write-Host "     roi chay lai: .\scripts\deploy-prepaid-sql.ps1 -UseLinked"
  Write-Host ""
  exit 1
}

Write-Host "Chay supabase db query voi DATABASE_URL (khong in ra URI) ..."
npx --yes supabase@latest db query -f $sqlPath --db-url $dbUrl --agent no
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Xong. Neu PostgREST chua thay function moi: Settings - API - Reload schema."
exit 0
