<#
.SYNOPSIS
  Brings up the entire PRISM stack on this machine, in dependency order.

.DESCRIPTION
  Twelve processes, started bottom-up, each layer waited on before the next
  begins so a failure is reported against the service that actually failed
  rather than surfacing as a confusing error three layers up:

    infra    redis (6379), qdrant (6333)
    ai       face-worker (8001), image-pii-worker (8002), audio-worker (8003, opt-in)
    api      backend (4000)
    workers  recognition, redaction, purge, item-action, retention
    portals  user-portal (5173), admin-portal (5180)

  Postgres is NOT started here: DATABASE_URL points at Supabase, which is remote.

  The five backend workers are separate long-lived processes on purpose - the
  API server runs none of them. Without them sessions never leave PROCESSING,
  deferred PII photos never clear, DSAR purges never execute, and L2 originals
  are never swept. See docs/DEPLOY.md section 6.

  Anything already listening on a service's port is adopted rather than
  restarted, so re-running this is safe and only fills in what is missing.

.PARAMETER Stop
  Kill everything this script started (whole process trees), then exit.

.PARAMETER Status
  Report what is up and what is down, then exit.

.PARAMETER Setup
  One-time prep: npm install where node_modules is missing, prisma generate,
  python venvs via uv. Then continues with a normal start.

.PARAMETER WithAudio
  Also start the audio worker (~4GB RAM, slow first boot: whisper + pyannote
  weights). Needs ai-core/audio-worker/.env with a valid HF_TOKEN, and
  AUDIO_CAPTURE_ENABLED="on" in backend/.env for the recording routes to mount.

.EXAMPLE
  .\scripts\start-all.ps1
.EXAMPLE
  .\scripts\start-all.ps1 -Setup -WithAudio
.EXAMPLE
  .\scripts\start-all.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$Status,
  [switch]$Setup,
  [switch]$WithAudio,
  [switch]$SkipInfra,
  [switch]$SkipAi,
  [switch]$SkipApi,
  [switch]$SkipWorkers,
  [switch]$SkipPortals,
  [switch]$SkipPreflight,
  [switch]$NoWatch
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$RunDir    = Join-Path $Root '.run'
$LogDir    = Join-Path $RunDir 'logs'
$StateFile = Join-Path $RunDir 'services.json'

# --- output helpers ---------------------------------------------------------
function Say  ($m) { Write-Host $m }
function Step ($m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Info ($m) { Write-Host "  [ .. ] $m" -ForegroundColor DarkGray }
function Warn ($m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Bad  ($m) { Write-Host "  [fail] $m" -ForegroundColor Red }

# --- probes -----------------------------------------------------------------
function Test-Port([int]$Port) {
  # Both loopback families, because a v4-only probe lies. Vite binds ::1 only,
  # so the portals were reported DOWN - and the whole run reported degraded -
  # while they were serving 200s the entire time.
  foreach ($addr in @('127.0.0.1', '::1')) {
    $c = [System.Net.Sockets.TcpClient]::new()
    try { if ($c.ConnectAsync($addr, $Port).Wait(400) -and $c.Connected) { return $true } }
    catch { }
    finally { $c.Dispose() }
  }
  return $false
}

function Test-Health([string]$Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec 4 -SkipHttpErrorCheck -ErrorAction Stop
    return $r.StatusCode -lt 500
  } catch { return $false }
}

# Polls until the service answers, printing a dot per second so a slow model
# load reads as progress rather than a hang.
function Wait-Up([hashtable]$Svc, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Write-Host "  [ .. ] waiting for $($Svc.Name) " -NoNewline -ForegroundColor DarkGray
  while ((Get-Date) -lt $deadline) {
    $up = if ($Svc.Health) { Test-Health $Svc.Health } else { Test-Port $Svc.Port }
    if ($up) { Write-Host ''; return $true }
    if ($Svc.Proc -and $Svc.Proc.HasExited) {
      Write-Host ''
      Bad "$($Svc.Name) exited with code $($Svc.Proc.ExitCode) - see $(Join-Path $LogDir "$($Svc.Key).err.log")"
      return $false
    }
    Write-Host '.' -NoNewline -ForegroundColor DarkGray
    Start-Sleep -Seconds 1
  }
  Write-Host ''
  Bad "$($Svc.Name) did not come up within ${TimeoutSec}s - see $(Join-Path $LogDir "$($Svc.Key).err.log")"
  return $false
}

# --- pid bookkeeping --------------------------------------------------------
function Read-State {
  if (Test-Path $StateFile) {
    try { return @(Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { return @() }
  }
  return @()
}

function Write-State($Entries) {
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  ,@($Entries) | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding utf8
}

function Stop-Tree([int]$ProcId) {
  # /T because node --watch and vite both fork children that outlive the parent.
  & taskkill.exe /PID $ProcId /T /F *> $null
}

# --- locating the binaries --------------------------------------------------
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$UvExe   = (Get-Command uv -ErrorAction SilentlyContinue).Source
$UserDir = $env:USERPROFILE

function Find-First([string[]]$Paths) {
  foreach ($p in $Paths) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

$RedisExe = Find-First @(
  (Join-Path $UserDir 'Desktop\redis-portable\redis-server.exe'),
  (Join-Path $UserDir 'redis\redis-server.exe')
)
$QdrantExe = Find-First @(
  (Join-Path $UserDir 'Desktop\qdrant-portable\qdrant.exe'),
  (Join-Path $UserDir 'qdrant\qdrant.exe')
)
$FacePy = Join-Path $Root 'face-worker\.venv\Scripts\python.exe'
$PiiPy  = Join-Path $Root 'ai-core\image-pii-worker\.venv\Scripts\python.exe'

$WatchArgs = if ($NoWatch) { @() } else { @('--watch') }

function New-Svc($Key, $Name, $Group, $Exe, $ArgList, $Dir, $Port, $Health, $Timeout) {
  return @{
    Key = $Key; Name = $Name; Group = $Group; Exe = $Exe; ArgList = $ArgList
    Dir = $Dir; Port = $Port; Health = $Health; Timeout = $Timeout; Proc = $null
  }
}

$Services = @(
  # infra ---------------------------------------------------------------------
  (New-Svc 'redis' 'redis (6379)' 'infra' $RedisExe @('--port', '6379') `
      (Split-Path -Parent ([string]$RedisExe)) 6379 $null 20),
  # qdrant must run from its own folder: it writes ./storage and ./snapshots there.
  (New-Svc 'qdrant' 'qdrant (6333)' 'infra' $QdrantExe @() `
      (Split-Path -Parent ([string]$QdrantExe)) 6333 'http://127.0.0.1:6333/' 45),

  # ai workers ----------------------------------------------------------------
  # First face-worker boot downloads ~300MB of insightface weights into
  # ~/.insightface, hence the long timeout.
  (New-Svc 'face' 'face-worker (8001)' 'ai' $FacePy `
      @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8001') `
      (Join-Path $Root 'face-worker') 8001 'http://127.0.0.1:8001/health' 420),
  (New-Svc 'pii' 'image-pii-worker (8002)' 'ai' $PiiPy `
      @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8002') `
      (Join-Path $Root 'ai-core\image-pii-worker') 8002 'http://127.0.0.1:8002/health' 240),
  (New-Svc 'audio' 'audio-worker (8003)' 'audio' $UvExe `
      @('run', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8003') `
      (Join-Path $Root 'ai-core\audio-worker') 8003 'http://127.0.0.1:8003/health' 900),

  # api -----------------------------------------------------------------------
  (New-Svc 'api' 'backend api (4000)' 'api' $NodeExe `
      (@() + $WatchArgs + @('src/server.js')) `
      (Join-Path $Root 'backend') 4000 'http://127.0.0.1:4000/health' 90),

  # backend workers - no ports, checked by liveness only ----------------------
  (New-Svc 'w-recognition' 'worker: recognition' 'workers' $NodeExe @('src/workers/recognition.worker.js') (Join-Path $Root 'backend') $null $null 0),
  (New-Svc 'w-redaction'   'worker: redaction'   'workers' $NodeExe @('src/workers/redaction.worker.js')   (Join-Path $Root 'backend') $null $null 0),
  (New-Svc 'w-purge'       'worker: purge'       'workers' $NodeExe @('src/workers/purge.worker.js')       (Join-Path $Root 'backend') $null $null 0),
  (New-Svc 'w-item-action' 'worker: item-action' 'workers' $NodeExe @('src/workers/itemAction.worker.js')  (Join-Path $Root 'backend') $null $null 0),
  (New-Svc 'w-retention'   'worker: retention'   'workers' $NodeExe @('src/workers/retention.worker.js')   (Join-Path $Root 'backend') $null $null 0),

  # portals -------------------------------------------------------------------
  (New-Svc 'user-portal' 'user-portal (5173)' 'portals' $NodeExe `
      @('node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort') `
      (Join-Path $Root 'user-portal') 5173 $null 120),
  (New-Svc 'admin-portal' 'admin-portal (5180)' 'portals' $NodeExe `
      @('node_modules/vite/bin/vite.js', '--port', '5180', '--strictPort') `
      (Join-Path $Root 'admin-portal') 5180 $null 120)
)

function Get-Svc($Key) { return ($Services | Where-Object { $_.Key -eq $Key }) }

# --- -Stop ------------------------------------------------------------------
if ($Stop) {
  Step 'Stopping PRISM'
  $state = Read-State
  if ($state.Count -eq 0) { Warn 'no recorded processes - nothing was started by this script' }
  foreach ($e in $state) {
    if (Get-Process -Id $e.Pid -ErrorAction SilentlyContinue) {
      Stop-Tree $e.Pid
      Ok "stopped $($e.Name) (pid $($e.Pid))"
    } else {
      Info "$($e.Name) already gone"
    }
  }
  Write-State @()
  Say ''
  exit 0
}

# --- -Status ----------------------------------------------------------------
if ($Status) {
  Step 'Ports'
  $Services | Where-Object { $_.Port } | ForEach-Object {
    $up = if ($_.Health) { Test-Health $_.Health } else { Test-Port $_.Port }
    [pscustomobject]@{ Service = $_.Name; State = $(if ($up) { 'up' } else { 'down' }) }
  } | Format-Table -AutoSize

  Step 'Tracked processes'
  $state = Read-State
  if ($state.Count) {
    $state | ForEach-Object {
      [pscustomobject]@{
        Service = $_.Name; Pid = $_.Pid
        Alive   = [bool](Get-Process -Id $_.Pid -ErrorAction SilentlyContinue)
      }
    } | Format-Table -AutoSize
  } else { Info 'none' }
  exit 0
}

# --- preconditions ----------------------------------------------------------
Step 'Prerequisites'
$fatal = @()

if (-not $NodeExe) { $fatal += 'node is not on PATH' } else { Ok "node $(& $NodeExe -v)" }

if (-not (Test-Path (Join-Path $Root 'backend\.env'))) {
  $fatal += 'backend/.env is missing - copy backend/.env.example and fill it in (DATABASE_URL, the JWT secrets and FACE_EMBEDDING_KEY are all required to boot)'
} else { Ok 'backend/.env' }

if (-not $SkipInfra) {
  if (-not $RedisExe)  { $fatal += 'no redis-server.exe found (looked in ~/Desktop/redis-portable and ~/redis)' } else { Ok "redis  $RedisExe" }
  if (-not $QdrantExe) { $fatal += 'no qdrant.exe found (looked in ~/Desktop/qdrant-portable and ~/qdrant)' }   else { Ok "qdrant $QdrantExe" }
}
if (-not $SkipAi -and -not $Setup) {
  if (-not (Test-Path $FacePy)) { $fatal += "face-worker venv missing ($FacePy) - re-run with -Setup" }       else { Ok 'face-worker venv' }
  if (-not (Test-Path $PiiPy))  { $fatal += "image-pii-worker venv missing ($PiiPy) - re-run with -Setup" }   else { Ok 'image-pii-worker venv' }
}
if ($WithAudio) {
  if (-not $UvExe) { $fatal += 'uv is not on PATH, but -WithAudio needs it' }
  if (-not (Test-Path (Join-Path $Root 'ai-core\audio-worker\.env'))) {
    $fatal += 'ai-core/audio-worker/.env missing - pyannote is a gated model, so HF_TOKEN is required'
  }
}

if ($fatal.Count) {
  Say ''
  foreach ($f in $fatal) { Bad $f }
  Say ''
  exit 1
}

# Advisory: these change behaviour rather than stopping the boot.
$envText = Get-Content (Join-Path $Root 'backend\.env') -Raw
$audioOn = $envText -match '(?m)^\s*AUDIO_CAPTURE_ENABLED\s*=\s*"?on"?\s*$'
if ($WithAudio -and -not $audioOn) {
  Warn 'AUDIO_CAPTURE_ENABLED is not "on" in backend/.env - the audio worker will run, but every recording route answers 503'
}
if ($audioOn -and -not $WithAudio) {
  Warn 'AUDIO_CAPTURE_ENABLED="on" but the audio worker is not being started (-WithAudio) - recording uploads will fail at the analyze step'
}
foreach ($k in @('PII_SERVICE_URL', 'AUDIO_SERVICE_URL')) {
  if ($envText -notmatch "(?m)^\s*$k\s*=") {
    Warn "$k is not in backend/.env - the in-code default is used; set it if your ports differ"
  }
}

# --- -Setup -----------------------------------------------------------------
if ($Setup) {
  Step 'Setup'
  foreach ($d in @('backend', 'admin-portal', 'user-portal')) {
    $dir = Join-Path $Root $d
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
      Info "npm install in $d"
      Push-Location $dir; & npm.cmd install; Pop-Location
      if ($LASTEXITCODE -ne 0) { Bad "npm install failed in $d"; exit 1 }
    }
    Ok "$d deps"
  }

  Info 'prisma generate'
  Push-Location (Join-Path $Root 'backend'); & npx.cmd prisma generate; Pop-Location
  if ($LASTEXITCODE -ne 0) { Bad 'prisma generate failed'; exit 1 }
  Ok 'prisma client'

  if ($UvExe) {
    foreach ($d in @('face-worker', 'ai-core\image-pii-worker')) {
      $dir = Join-Path $Root $d
      if (-not (Test-Path (Join-Path $dir '.venv'))) {
        Info "creating venv for $d"
        Push-Location $dir
        & $UvExe venv
        if (Test-Path (Join-Path $dir 'requirements.txt')) {
          & $UvExe pip install -r requirements.txt
        } else {
          & $UvExe sync
        }
        Pop-Location
      }
      Ok "$d venv"
    }
    if ($WithAudio) {
      Info 'uv sync for audio-worker (large: torch, faster-whisper, pyannote)'
      Push-Location (Join-Path $Root 'ai-core\audio-worker'); & $UvExe sync; Pop-Location
      Ok 'audio-worker venv'
    }
  } else {
    Warn 'uv not on PATH - skipping python env setup'
  }
}

# --- preflight --------------------------------------------------------------
# Never blocks in development: a laptop is allowed to run on defaults. It is
# printed so nobody mistakes a dev-secret stack for a hardened one.
if (-not $SkipPreflight) {
  Step 'Preflight (advisory in development)'
  Push-Location (Join-Path $Root 'backend')
  $pf = (& $NodeExe 'scripts/preflight.js' 2>&1 | Out-String)
  Pop-Location
  Say $pf.TrimEnd()
  $failCount = @($pf -split "`n" | Where-Object { $_ -match 'FAIL' }).Count
  if ($failCount -gt 0) { Warn "$failCount preflight FAIL line(s) above - tolerated in dev, blocking in production" }
}

# --- launcher ---------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Carry forward anything from a previous run that is still alive, so -Stop can
# still reach it after a partial restart.
$state = [System.Collections.Generic.List[object]]::new()
foreach ($e in Read-State) {
  if (Get-Process -Id $e.Pid -ErrorAction SilentlyContinue) { $state.Add($e) }
}

function Start-Svc([hashtable]$Svc) {
  if ($Svc.Port -and (Test-Port $Svc.Port)) {
    Ok "$($Svc.Name) already listening - adopted, not restarted"
    return $true
  }
  $out = Join-Path $LogDir "$($Svc.Key).out.log"
  $err = Join-Path $LogDir "$($Svc.Key).err.log"
  $p = Start-Process -FilePath $Svc.Exe -ArgumentList $Svc.ArgList -WorkingDirectory $Svc.Dir `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $Svc.Proc = $p
  $state.Add([pscustomobject]@{ Key = $Svc.Key; Name = $Svc.Name; Pid = $p.Id })
  Write-State $state

  if ($Svc.Port -or $Svc.Health) {
    if (-not (Wait-Up $Svc $Svc.Timeout)) { return $false }
  } else {
    # Queue workers expose no port. Three seconds is enough for a bad env var or
    # an unreachable Redis to have already killed the process.
    Start-Sleep -Seconds 3
    if ($p.HasExited) {
      Bad "$($Svc.Name) exited immediately (code $($p.ExitCode)) - see $err"
      return $false
    }
  }
  Ok "$($Svc.Name)  pid $($p.Id)"
  return $true
}

function Start-Group([string]$Group, [string]$Title) {
  Step $Title
  $all = $true
  foreach ($s in ($Services | Where-Object { $_.Group -eq $Group })) {
    if (-not (Start-Svc $s)) { $all = $false }
  }
  return $all
}

$degraded = @()

if (-not $SkipInfra) { if (-not (Start-Group 'infra' 'Infrastructure - redis, qdrant')) { $degraded += 'infra' } }
if (-not $SkipAi)    { if (-not (Start-Group 'ai' 'AI workers - face, image-pii'))      { $degraded += 'ai' } }
if ($WithAudio) {
  Step 'AI worker - audio'
  if (-not (Start-Svc (Get-Svc 'audio'))) { $degraded += 'audio' }
}

# The API is the gate: workers and portals against a dead API are just noise.
if (-not $SkipApi) {
  if (-not (Start-Group 'api' 'Backend API')) {
    Bad 'backend failed to start - stopping here. Last lines of its error log:'
    Get-Content (Join-Path $LogDir 'api.err.log') -Tail 25 -ErrorAction SilentlyContinue |
      ForEach-Object { Say "    $_" }
    exit 1
  }
}

if (-not $SkipWorkers) { if (-not (Start-Group 'workers' 'Backend workers - 5 long-lived processes')) { $degraded += 'workers' } }
if (-not $SkipPortals) { if (-not (Start-Group 'portals' 'Portals'))                                  { $degraded += 'portals' } }

# --- summary ----------------------------------------------------------------
Step 'Stack'
$Services | Where-Object { $_.Port -and -not ($_.Key -eq 'audio' -and -not $WithAudio) } | ForEach-Object {
  $up = if ($_.Health) { Test-Health $_.Health } else { Test-Port $_.Port }
  [pscustomobject]@{
    Service = $_.Name
    Url     = "http://localhost:$($_.Port)"
    State   = $(if ($up) { 'up' } else { 'DOWN' })
  }
} | Format-Table -AutoSize

$workerRows = @($state | Where-Object { $_.Key -like 'w-*' } | ForEach-Object {
  [pscustomobject]@{
    Worker = $_.Name; Pid = $_.Pid
    Alive  = [bool](Get-Process -Id $_.Pid -ErrorAction SilentlyContinue)
  }
})
if ($workerRows.Count) { $workerRows | Format-Table -AutoSize }

Say '  User portal   http://localhost:5173'
Say '  Admin portal  http://localhost:5180'
Say '  API health    http://localhost:4000/health'
Say ''
Say "  Logs    $LogDir"
Say '  Status  .\scripts\start-all.ps1 -Status'
Say '  Stop    .\scripts\start-all.ps1 -Stop'
Say ''

if ($degraded.Count) {
  Bad "degraded - these groups did not come up fully: $($degraded -join ', ')"
  exit 1
}
Ok 'all services healthy'
exit 0
