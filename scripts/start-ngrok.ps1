# orchestrator(:3001) ngrok tunnel for Slack Interactivity
# Run: scripts\start-ngrok.bat

if ($env:NGROK_SETUP_FROM_BAT -ne '1') {
  $bat = Join-Path $PSScriptRoot 'start-ngrok.bat'
  if (Test-Path -LiteralPath $bat) {
    Start-Process -FilePath $bat -WorkingDirectory $PSScriptRoot
    exit 0
  }
}

$ErrorActionPreference = "Continue"
$Port = 3001
$OutFile = Join-Path $PSScriptRoot "last-ngrok-url.txt"
$LogFile = Join-Path $PSScriptRoot "ngrok-start.log"

function Save-Result {
  param([string]$Body)
  [System.IO.File]::WriteAllText($OutFile, $Body, [System.Text.UTF8Encoding]::new($false))
}

function Resolve-NgrokPath {
  $cmd = Get-Command ngrok -ErrorAction SilentlyContinue
  $ngrokFromPath = if ($cmd) { $cmd.Source } else { $null }
  $candidates = @(
    $ngrokFromPath,
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ngrok.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
  )
  return ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Ensure-NgrokVersion {
  param([string]$NgrokExe)
  $verLine = & $NgrokExe version 2>&1 | Out-String
  if ($verLine -match 'version (\d+)\.(\d+)\.(\d+)') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 20)) {
      Write-Host "ngrok version too old ($($Matches[0])). Updating..." -ForegroundColor Yellow
      & $NgrokExe update 2>&1 | Out-String | Write-Host
    }
  }
  Write-Host "ngrok: $(& $NgrokExe version 2>&1)" -ForegroundColor Gray
}

function Start-NgrokTunnel {
  param([string]$NgrokExe, [int]$TargetPort)
  $existing = Get-Process ngrok -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "ngrok already running (PID $($existing.Id))." -ForegroundColor Yellow
    return $true
  }

  $proc = Start-Process -FilePath $NgrokExe -ArgumentList @("http", "$TargetPort") -WindowStyle Normal -PassThru

  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
      Write-Host "ngrok exited immediately." -ForegroundColor Red
      Write-Host "Fix: run in PowerShell ->  ngrok update" -ForegroundColor Yellow
      Write-Host "Then: ngrok config add-authtoken YOUR_TOKEN" -ForegroundColor Yellow
      if (Test-Path $LogFile) { Get-Content $LogFile | Write-Host -ForegroundColor Red }
      return $false
    }
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 1
      return $true
    } catch {
      # API not ready yet
    }
  }
  return $true
}

$ngrok = Resolve-NgrokPath
if (-not $ngrok) {
  Write-Host "ngrok.exe not found. Install: winget install Ngrok.Ngrok" -ForegroundColor Red
  Save-Result "FAILED: ngrok not installed"
  exit 1
}

Write-Host ""
Write-Host "=== ngrok -> localhost:$Port (orchestrator) ===" -ForegroundColor Cyan
Write-Host ""

Ensure-NgrokVersion -NgrokExe $ngrok
if (-not (Start-NgrokTunnel -NgrokExe $ngrok -TargetPort $Port)) {
  Save-Result @"
FAILED: ngrok could not start or exited immediately.

Most common cause (fixed on this machine):
  ngrok version too old (need 3.20+). Run: ngrok update

Also check:
  ngrok config add-authtoken YOUR_TOKEN
  orchestrator running on port $Port

See log: $LogFile
"@
  exit 1
}

$tunnelUrl = $null
for ($i = 0; $i -lt 20; $i++) {
  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
    $tunnelUrl = ($resp.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1).public_url
    if ($tunnelUrl) { break }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $tunnelUrl) {
  Write-Host "Could not read tunnel URL from http://127.0.0.1:4040" -ForegroundColor Red
  Write-Host "Open http://127.0.0.1:4040 in browser and copy Forwarding URL manually." -ForegroundColor Yellow
  Save-Result "FAILED: could not get ngrok URL`r`nCheck http://127.0.0.1:4040`r`nMaybe ngrok is still starting - wait and retry.`r`n"
  exit 1
}

$interactivityUrl = "$tunnelUrl/api/slack/interactivity"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Write-Host ""
Write-Host "Public URL:" -ForegroundColor Green
Write-Host "  $tunnelUrl"
Write-Host "Slack Interactivity URL:" -ForegroundColor Green
Write-Host "  $interactivityUrl"
Write-Host ""

$envPath = Join-Path $PSScriptRoot "..\.env.local"
if (Test-Path $envPath) {
  $content = Get-Content $envPath -Raw -Encoding UTF8
  $newLine = "SLACK_INTERACTIVITY_URL=$interactivityUrl"
  if ($content -match "(?m)^SLACK_INTERACTIVITY_URL=.*$") {
    $content = $content -replace "(?m)^SLACK_INTERACTIVITY_URL=.*$", $newLine
  } else {
    $content = $content.TrimEnd() + "`r`n$newLine`r`n"
  }
  [System.IO.File]::WriteAllText($envPath, $content.TrimEnd() + "`r`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host ".env.local updated" -ForegroundColor Cyan
}

$saveText = @"
ngrok setup - $timestamp

Public URL:
$tunnelUrl

Slack Interactivity Request URL (paste in Slack App):
$interactivityUrl

Next:
1. SLACK_SIGNING_SECRET in .env.local
2. Slack App - Interactivity ON - Request URL = line above
3. Restart mcp-server + orchestrator
4. New approval from http://localhost:3000/sourcing
"@
Save-Result $saveText

Write-Host "Saved to: $OutFile" -ForegroundColor Cyan
Write-Host ""
exit 0
