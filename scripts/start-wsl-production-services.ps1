$ErrorActionPreference = 'Stop'

$WSL_DISTRO = 'Ubuntu'
$WSL_USER = 'lizb'
$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$WORKSPACE_ROOT = Split-Path -Parent $PROJECT_ROOT
$WINDOWS_NGINX_ROOT = Join-Path $WORKSPACE_ROOT 'nginx-1.30.2\nginx-1.30.2'
$WINDOWS_NGINX_EXE = Join-Path $WINDOWS_NGINX_ROOT 'nginx.exe'
$LOG_ROOT = Join-Path $PROJECT_ROOT 'startup-logs'
$STARTUP_LOG = Join-Path $LOG_ROOT 'wsl-production-startup.log'

New-Item -ItemType Directory -Force -Path $LOG_ROOT | Out-Null

function Write-StartupLog {
  param([string]$Message)

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $STARTUP_LOG -Value "[$timestamp] $Message"
}

function Invoke-WslScript {
  param(
    [string]$User,
    [string]$Script
  )

  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  $output = & wsl.exe -d $WSL_DISTRO -u $User -- bash -lc "echo $encodedScript | base64 -d | bash" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "WSL command failed: $($output -join [Environment]::NewLine)"
  }
  return $output
}

function Test-ListeningPort {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  return $null -ne $connection
}

function Wait-ListeningPort {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 15
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ListeningPort -Port $Port) {
      return
    }
    Start-Sleep -Seconds 1
  }

  throw "Port $Port did not start listening within $TimeoutSeconds seconds."
}

function Start-WindowsNginx {
  if (-not (Test-Path -LiteralPath $WINDOWS_NGINX_EXE)) {
    throw "Windows Nginx executable not found: $WINDOWS_NGINX_EXE"
  }

  if (Test-ListeningPort -Port 8888) {
    Write-StartupLog 'Windows Nginx port 8888 already listening.'
    return
  }

  Start-Process -FilePath $WINDOWS_NGINX_EXE -WorkingDirectory $WINDOWS_NGINX_ROOT -WindowStyle Hidden
  Wait-ListeningPort -Port 8888
  Write-StartupLog 'Windows Nginx started on port 8888.'
}

try {
  Write-StartupLog 'Starting WSL production services.'

  $nginxOutput = Invoke-WslScript -User 'root' -Script @'
set -e
if pgrep -x nginx >/dev/null 2>&1; then
  echo 'Nginx already running.'
elif command -v service >/dev/null 2>&1; then
  service nginx start
  echo 'Nginx started.'
else
  nginx
  echo 'Nginx started.'
fi
'@
  Write-StartupLog ($nginxOutput -join ' ')

  $pm2Output = Invoke-WslScript -User $WSL_USER -Script @'
set -e
export NVM_DIR=/home/lizb/.nvm
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo 'PM2 not found.' >&2
  exit 1
fi
if pm2 describe task-manage-api >/dev/null 2>&1; then
  pm2 restart task-manage-api --update-env >/dev/null
else
  pm2 resurrect >/dev/null
fi
pm2 save >/dev/null
echo 'task-manage-api started.'
'@
  Write-StartupLog ($pm2Output -join ' ')

  Start-Sleep -Seconds 5
  $healthOutput = Invoke-WslScript -User $WSL_USER -Script @'
set -e
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:4000/health
'@
  Write-StartupLog "Health check passed: $($healthOutput -join ' ')"

  Start-WindowsNginx
  $publicHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8888/health' -TimeoutSec 10
  if (-not $publicHealth.ok) {
    throw 'Public health check returned an invalid response.'
  }
  Write-StartupLog 'Public health check passed on port 8888.'
} catch {
  Write-StartupLog "Startup failed: $($_.Exception.Message)"
  exit 1
}

Write-StartupLog 'WSL production services started.'
