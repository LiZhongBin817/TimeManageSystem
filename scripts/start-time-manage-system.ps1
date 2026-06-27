$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $ProjectRoot
$NginxRoot = Join-Path $WorkspaceRoot 'nginx-1.30.2\nginx-1.30.2'
$LogRoot = Join-Path $ProjectRoot 'startup-logs'
$WslDistro = 'Ubuntu'
$WslUser = 'lizb'
$WslProjectRoot = '/home/lizb/TimeManageSystem'
$WslCommandTimeoutSeconds = 60

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

function Wait-ListeningPort {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ListeningPort -Port $Port) {
      Write-StartupLog "Port $Port is listening."
      return $true
    }

    Start-Sleep -Seconds 1
  }

  Write-StartupLog "Port $Port did not start listening within $TimeoutSeconds seconds."
  return $false
}

function ConvertTo-WslPath {
  param([string]$WindowsPath)

  $resolvedPath = (Resolve-Path -LiteralPath $WindowsPath).Path
  if ($resolvedPath -notmatch '^([A-Za-z]):\\(.*)$') {
    throw "Unsupported Windows path for WSL: $resolvedPath"
  }

  $drive = $matches[1].ToLowerInvariant()
  $path = $matches[2] -replace '\\', '/'
  return "/mnt/$drive/$path"
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

  Wait-ListeningPort -Port $Port -TimeoutSeconds 45 | Out-Null
}

function Invoke-WslCommand {
  param(
    [string]$User,
    [string]$Command
  )

  $stdout = Join-Path $LogRoot "wsl-$User.out.log"
  $stderr = Join-Path $LogRoot "wsl-$User.err.log"
  $scriptPath = Join-Path $LogRoot "wsl-$User-command.sh"
  $scriptContent = "set -e`n$Command`n" -replace "`r`n", "`n" -replace "`r", "`n"
  [System.IO.File]::WriteAllText($scriptPath, $scriptContent, [System.Text.Encoding]::ASCII)
  $wslScriptPath = ConvertTo-WslPath -WindowsPath $scriptPath

  $process = Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $WslDistro, '-u', $User, '--', 'bash', $wslScriptPath) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  if (-not $process.WaitForExit($WslCommandTimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "WSL command timed out after $WslCommandTimeoutSeconds seconds."
  }

  $process.Refresh()
  if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
    throw "WSL command exited with code $($process.ExitCode)."
  }
}

function Start-WslServices {
  Write-StartupLog "Starting WSL distro $WslDistro."

  try {
    Invoke-WslCommand -User 'root' -Command 'systemctl start nginx 2>/dev/null || service nginx start'
    Write-StartupLog 'WSL nginx start command finished.'
  } catch {
    Write-StartupLog "WSL nginx start failed: $($_.Exception.Message)"
  }

$serverCommandTemplate = @'
wsl_project_root='__WSL_PROJECT_ROOT__'
wsl_user='__WSL_USER__'
mkdir -p "$wsl_project_root/startup-logs"
export NVM_DIR="/home/$wsl_user/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe task-manage-api >/dev/null 2>&1; then
    pm2 restart task-manage-api --update-env
    echo 'WSL PM2 server restarted.'
  else
    cd "$wsl_project_root/server" && pm2 start dist/index.js --name task-manage-api --update-env
    pm2 save
    echo 'WSL PM2 server started.'
  fi
elif ss -lnt 2>/dev/null | grep -q ':4000 '; then
  echo 'WSL server port 4000 is already listening.'
else
  cd "$wsl_project_root/server" && nohup npm run start > "$wsl_project_root/startup-logs/server.out.log" 2> "$wsl_project_root/startup-logs/server.err.log" < /dev/null &
  echo 'WSL server start command issued.'
fi
'@

  $serverCommand = $serverCommandTemplate.Replace('__WSL_PROJECT_ROOT__', $WslProjectRoot).Replace('__WSL_USER__', $WslUser)

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
  Wait-ListeningPort -Port 8888 -TimeoutSeconds 15 | Out-Null
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
