$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backupDirectory = Join-Path $projectRoot 'backups'
$keyPath = Join-Path $backupDirectory 'biomant-backup.key.dpapi'
$entropy = [System.Text.Encoding]::UTF8.GetBytes('BioMant backup key v1')
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData

if (Test-Path -LiteralPath $keyPath) {
    $protected = [System.IO.File]::ReadAllBytes($keyPath)
    $key = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
    $key = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $random.GetBytes($key)
    $random.Dispose()
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($key, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.IO.File]::WriteAllBytes($keyPath, $protected)
}

$env:BIOMANT_BACKUP_KEY = [Convert]::ToBase64String($key)
Push-Location $projectRoot
try {
    npm run backup:supabase
    $resultCode = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:BIOMANT_BACKUP_KEY -ErrorAction SilentlyContinue
}
if ($resultCode -ne 0) { exit $resultCode }
