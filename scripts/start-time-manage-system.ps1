$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $ProjectRoot
$NginxRoot = Join-Path $WorkspaceRoot 'nginx-1.30.2\nginx-1.30.2'
$LogRoot = Join-Path $ProjectRoot 'startup-logs'
$WslDistro = 'Ubuntu'
$WslUser = 'lizb'
$WslProjectRoot = '/home/lizb/TimeManageSystem'

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

function Write-StartupLog {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path (Join-Path $LogRoot 'startup.log') -Value "[$timestamp] $Message"
}

function Test-ListeningPort {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  return $null -ne $connection
}

function Start-NpmWorkspace {
  param(
    [string]$Workspace,
    [int]$Port
  )

  if (Test-ListeningPort -Port $Port) {
    Write-StartupLog "$Workspace port $Port is already listening, skipped."
    return
  }

  $stdout = Join-Path $LogRoot "$Workspace.out.log"
  $stderr = Join-Path $LogRoot "$Workspace.err.log"
  Write-StartupLog "Starting $Workspace on port $Port."
  Start-Process -FilePath 'npm.cmd' `
    -ArgumentList @('run', 'dev', '--workspace', $Workspace) `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr
}

function Invoke-WslCommand {
  param(
    [string]$User,
    [string]$Command
  )

  $stdout = Join-Path $LogRoot "wsl-$User.out.log"
  $stderr = Join-Path $LogRoot "wsl-$User.err.log"
  Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $WslDistro, '-u', $User, '--', 'bash', '-lc', $Command) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -Wait
}

function Start-WslServices {
  Write-StartupLog "Starting WSL distro $WslDistro."

  try {
    Invoke-WslCommand -User 'root' -Command 'systemctl start nginx 2>/dev/null || service nginx start'
    Write-StartupLog 'WSL nginx start command finished.'
  } catch {
    Write-StartupLog "WSL nginx start failed: $($_.Exception.Message)"
  }

$serverCommand = @"
wsl_project_root='$WslProjectRoot'
mkdir -p "`$wsl_project_root/startup-logs"
export NVM_DIR="/home/$WslUser/.nvm"
[ -s "`$NVM_DIR/nvm.sh" ] && . "`$NVM_DIR/nvm.sh"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe task-manage-api >/dev/null 2>&1; then
    pm2 restart task-manage-api --update-env
    echo 'WSL PM2 server restarted.'
  else
    cd "`$wsl_project_root/server" && pm2 start dist/index.js --name task-manage-api --update-env
    pm2 save
    echo 'WSL PM2 server started.'
  fi
elif ss -lnt 2>/dev/null | grep -q ':4000 '; then
  echo 'WSL server port 4000 is already listening.'
else
  cd "`$wsl_project_root/server" && nohup npm run start > "`$wsl_project_root/startup-logs/server.out.log" 2> "`$wsl_project_root/startup-logs/server.err.log" < /dev/null &
  echo 'WSL server start command issued.'
fi
"@

  try {
    Invoke-WslCommand -User $WslUser -Command $serverCommand
    Write-StartupLog 'WSL server check finished.'
  } catch {
    Write-StartupLog "WSL server start failed: $($_.Exception.Message)"
  }
}

function Start-Nginx {
  $nginxExe = Join-Path $NginxRoot 'nginx.exe'
  if (-not (Test-Path $nginxExe)) {
    Write-StartupLog "Nginx executable not found: $nginxExe"
    return
  }

  $nginxProcess = Get-Process nginx -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $nginxExe } |
    Select-Object -First 1

  if ($nginxProcess) {
    Write-StartupLog 'Nginx is already running, reloading configuration.'
    Start-Process -FilePath $nginxExe -ArgumentList '-s', 'reload' -WorkingDirectory $NginxRoot -WindowStyle Hidden
    return
  }

  Write-StartupLog 'Starting Nginx.'
  Start-Process -FilePath $nginxExe -WorkingDirectory $NginxRoot -WindowStyle Hidden
}

Write-StartupLog 'Startup sequence begin.'
Start-WslServices
Start-Sleep -Seconds 3
Start-NpmWorkspace -Workspace 'server' -Port 4000
Start-Sleep -Seconds 3
Start-NpmWorkspace -Workspace 'web' -Port 5173
Start-Sleep -Seconds 3
Start-Nginx
Write-StartupLog 'Startup sequence finished.'
