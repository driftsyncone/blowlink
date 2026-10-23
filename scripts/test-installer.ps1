# Installs the per-user setup silently on a Windows runner and checks it behaves:
# user-profile only (no Program Files, no HKLM), Start menu shortcut, app starts,
# and uninstall removes the app but keeps the user's settings (and device tokens).
# Usage: pwsh scripts/test-installer.ps1 -Setup dist/BlowLink-Setup-x.y.z.exe [-ExpectedExeSha256 <hash>]
param([Parameter(Mandatory)][string]$Setup, [string]$ExpectedExeSha256)
$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "::error::$msg"; exit 1 }

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\BlowLink'
$exe = Join-Path $installDir 'BlowLink.exe'
$dataDir = Join-Path $env:APPDATA 'BlowLink'
$uninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$machineKeys = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

Write-Host "Installing $Setup (silent, per-user)"
$p = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { Fail "installer exit code $($p.ExitCode)" }

if (-not (Test-Path $exe)) { Fail "BlowLink.exe not found in $installDir" }
Write-Host "OK installed to $installDir"
if ($ExpectedExeSha256) {
  $got = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $ExpectedExeSha256.Trim().ToLower()) { Fail "installed BlowLink.exe hash $got != built $ExpectedExeSha256" }
  Write-Host 'OK installed BlowLink.exe is byte-identical to the built (and, if enabled, signed) one'
}

foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if ($pf -and (Test-Path (Join-Path $pf 'BlowLink'))) { Fail "found an install under $pf" }
}
foreach ($k in $machineKeys) {
  if (Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'BlowLink*') { Fail "machine-wide uninstall entry under $k" }
}
$entry = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'BlowLink*'
if (-not $entry) { Fail 'no per-user (HKCU) uninstall entry' }
Write-Host "OK per-user uninstall entry: $($entry.DisplayName) $($entry.DisplayVersion)"

$lnk = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter 'BlowLink*.lnk' -ErrorAction SilentlyContinue
if (-not $lnk) { Fail 'no Start menu shortcut' }
Write-Host "OK Start menu shortcut: $($lnk[0].FullName)"

Write-Host 'Launching the installed app for 20s'
$app = Start-Process -FilePath $exe -ArgumentList '--hidden' -PassThru
Start-Sleep -Seconds 20
if ($app.HasExited) { Fail "app exited early with code $($app.ExitCode)" }
if (-not (Test-Path $dataDir)) { Fail "app did not create its data folder $dataDir" }
Write-Host "OK app running (pid $($app.Id)), data in $dataDir"

Get-Process -Name 'BlowLink' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$uninstaller = ($entry.UninstallString -replace '^"([^"]+)".*$', '$1')
Write-Host "Uninstalling via $uninstaller"
$u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($u.ExitCode -ne 0) { Fail "uninstaller exit code $($u.ExitCode)" }
Start-Sleep -Seconds 3 # NSIS uninstaller copies itself to temp and finishes there
if (Test-Path $exe) { Fail 'BlowLink.exe still present after uninstall' }
if (Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'BlowLink*') { Fail 'uninstall entry still present' }
if (-not (Test-Path $dataDir)) { Fail 'uninstall deleted the user settings folder (should be kept)' }
Write-Host 'OK uninstalled cleanly, user settings kept'
