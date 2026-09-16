Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-HexSecret {
  param(
    [int]$Bytes = 32
  )

  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
  try {
    $rng.GetBytes($buffer)
  }
  finally {
    $rng.Dispose()
  }
  return ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

if (-not (Test-Path 'scripts/generate-keys.mjs')) {
  throw 'scripts/generate-keys.mjs not found. Run this script from the project repository.'
}

Write-Host 'Generating JWT key pair...' -ForegroundColor Cyan
node scripts/generate-keys.mjs | Out-Null

$privatePemPath = Join-Path $repoRoot 'keys/private.pem'
$publicPemPath = Join-Path $repoRoot 'keys/public.pem'

if (-not (Test-Path $privatePemPath) -or -not (Test-Path $publicPemPath)) {
  throw 'Key files were not generated correctly in keys/.'
}

$privatePem = Get-Content $privatePemPath -Raw
$publicPem = Get-Content $publicPemPath -Raw

$jwtPrivateEscaped = $privatePem -replace "`r?`n", '\\n'
$jwtPublicEscaped = $publicPem -replace "`r?`n", '\\n'
$cookieSecret = New-HexSecret -Bytes 32

$defaultAppUrl = 'https://peergriddemo-web.onrender.com'

$envBlock = @"
NODE_ENV=production
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10
ROOM_STORE=memory
COOKIE_SECRET=$cookieSecret
JWT_PRIVATE_KEY=$jwtPrivateEscaped
JWT_PUBLIC_KEY=$jwtPublicEscaped
APP_URL=$defaultAppUrl
"@

$tmpDir = Join-Path $repoRoot 'tmp'
if (-not (Test-Path $tmpDir)) {
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
}

$outputPath = Join-Path $tmpDir 'render-env.generated'
Set-Content -Path $outputPath -Value $envBlock -Encoding UTF8

try {
  Set-Clipboard -Value $envBlock
  $clipboardMessage = 'also copied to clipboard'
}
catch {
  $clipboardMessage = 'clipboard copy failed (this is okay)'
}

Write-Host ''
Write-Host 'Render env block generated successfully.' -ForegroundColor Green
Write-Host "Saved at: $outputPath" -ForegroundColor Yellow
Write-Host "Status: $clipboardMessage" -ForegroundColor Yellow
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '1) In Render Blueprint deploy, open peergriddemo-api service.'
Write-Host '2) Click Environment -> Add from .env and paste clipboard content.'
Write-Host '3) Add DATABASE_URL from Render Postgres Internal URL if not already linked by blueprint.'
Write-Host '4) If static site URL is different, update APP_URL after first frontend deploy.'