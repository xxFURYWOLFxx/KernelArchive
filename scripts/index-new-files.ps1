# Indexes files that were added to Archive, then finishes the follow-up work.
#
# Run it from the application root:  powershell -ExecutionPolicy Bypass -File scripts\index-new-files.ps1
#
# It checks first, because two of the ways this goes wrong are silent. Without the
# DIA runtime the indexer records modules with no symbols at all and reports
# success, and the boot loaders publish no exports, so they would land as empty
# pages. And if the added files arrived with disturbed timestamps the importer
# treats the whole archive as changed and rebuilds millions of records that did
# not move, which takes days.
#
# Nothing here starts or stops the API. It says when to, and waits, because how
# the service is launched on this machine is not something the script should guess.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Say([string]$text) { Write-Host $text }
function Head([string]$text) { Write-Host ""; Write-Host "> $text" -ForegroundColor Cyan }
function Good([string]$text) { Write-Host "  OK    $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  WARN  $text" -ForegroundColor Yellow }
function Bad([string]$text) { Write-Host "  FAIL  $text" -ForegroundColor Red }

function Env-Value([string]$name) {
    if (-not (Test-Path ".env")) { return "" }
    $line = Select-String -Path ".env" -Pattern "^\s*$name\s*=" | Select-Object -First 1
    if (-not $line) { return "" }
    return ($line.Line -split "=", 2)[1].Trim()
}

function Resolve-Configured([string]$value, [string]$fallback) {
    if ([string]::IsNullOrWhiteSpace($value)) { $value = $fallback }
    if ([System.IO.Path]::IsPathRooted($value)) { return $value }
    return (Join-Path $root $value)
}

function Set-ImportFlag([string]$state) {
    $name = "KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED"
    $text = Get-Content ".env" -Raw
    if ($text -match "(?m)^\s*$name\s*=.*$") {
        $text = $text -replace "(?m)^\s*$name\s*=.*$", "$name=$state"
    } else {
        if (-not $text.EndsWith("`n")) { $text += "`r`n" }
        $text += "$name=$state`r`n"
    }
    Set-Content ".env" -Value $text -Encoding utf8 -NoNewline
    Good "$name=$state"
}

function Api-Up() {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:4002/api/v1/health" -TimeoutSec 5
        return $true
    } catch { return $false }
}

function Wait-For([scriptblock]$test, [string]$label, [int]$seconds = 300) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $test) { return $true }
        Start-Sleep -Seconds 2
    }
    Bad "timed out waiting for $label"
    return $false
}

# node:sqlite prints an ExperimentalWarning to stderr on every run, and with
# $ErrorActionPreference set to Stop PowerShell turns a native command's stderr
# into a terminating error even when it exits zero. --no-warnings silences it at
# the source; relaxing the preference covers anything else it writes.
function Invoke-Node([string[]]$arguments, [switch]$Quiet) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($Quiet) { return (& node --no-warnings @arguments 2>$null) }
        return (& node --no-warnings @arguments)
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Db-Counts([string]$db) {
    $script = @"
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const rows = db.prepare("SELECT collection, records FROM archive_collection_counts").all();
  const out = {};
  for (const r of rows) { out[r.collection] = Number(r.records); }
  console.log(JSON.stringify(out));
  db.close();
} catch (e) { console.log('{}'); }
"@
    $file = Join-Path $env:TEMP "ka-counts.cjs"
    Set-Content $file -Value $script -Encoding utf8
    $json = Invoke-Node @($file, $db) -Quiet
    Remove-Item $file -ErrorAction SilentlyContinue
    if (-not $json) { return @{} }
    try { return ($json | ConvertFrom-Json) } catch { return @{} }
}

Say "KernelArchive: index newly added files"
Say "root  $root"

# ---- checks -------------------------------------------------------------------
Head "checking the install"

$failures = 0

if (Test-Path ".env") { Good ".env present" } else { Bad ".env missing"; $failures++ }

$archive_dir = Resolve-Configured (Env-Value "KERNELARCHIVE_ARCHIVE_DIR") "Archive"
if (Test-Path $archive_dir) {
    $builds = @(Get-ChildItem $archive_dir -Directory -ErrorAction SilentlyContinue)
    Good "Archive at $archive_dir ($($builds.Count) build folders)"
    $stray = $builds | Where-Object { $_.Name -like "Collected_*" -or $_.Name -eq "dist" }
    if ($stray) {
        Bad "a staging folder is inside Archive: $($stray.Name -join ', ')"
        Say "        Indexing this would duplicate every build. Move it out first."
        $failures++
    }
} else { Bad "Archive not found at $archive_dir"; $failures++ }

$cache_dir = Resolve-Configured (Env-Value "KERNELARCHIVE_LOCAL_CACHE_DIR") "local-cache"
$db_path = Resolve-Configured (Env-Value "KERNELARCHIVE_DATA_DB_PATH") (Join-Path $cache_dir "archive.sqlite")
if (Test-Path $db_path) {
    $gb = [math]::Round((Get-Item $db_path).Length / 1GB, 1)
    Good "archive database $db_path ($gb GB)"
} else { Bad "archive database not found at $db_path"; $failures++ }

$extractor = Resolve-Configured (Env-Value "KERNELARCHIVE_PDB_DUMP_PATH") "tools\pdb-dump\pdb_dump.exe"
if (Test-Path $extractor) { Good "symbol extractor $extractor" } else { Bad "pdb_dump.exe not found at $extractor"; $failures++ }

$dia = Env-Value "KERNELARCHIVE_DIA_DLL_PATH"
if ([string]::IsNullOrWhiteSpace($dia)) {
    Bad "KERNELARCHIVE_DIA_DLL_PATH is not set in .env"
    $failures++
} elseif (Test-Path $dia) {
    Good "DIA runtime $dia"
} else {
    Bad "DIA runtime not found at $dia"
    Say "        Without it every new module indexes with no symbols and the run"
    Say "        still reports success. The boot loaders have no exports, so they"
    Say "        would become empty pages."
    $failures++
}

if ($failures -gt 0) {
    Say ""
    Bad "$failures problem(s). Nothing was changed. Fix these and run again."
    exit 1
}

$before = Db-Counts $db_path
Head "current archive contents"
$counted = $false
foreach ($k in @("builds", "modules", "types", "functions")) {
    if ($before.$k) { Say ("  {0,-12} {1,12:N0}" -f $k, $before.$k); $counted = $true }
}
if (-not $counted) { Warn "counts unavailable, the before and after comparison will be skipped" }

# ---- enable the importer ------------------------------------------------------
Head "stopping the API"
if (Api-Up) {
    Say "  The API is running. Stop it now (close its window or stop the service)."
    if (-not (Wait-For { -not (Api-Up) } "the API to stop" 600)) { exit 1 }
}
Good "API is not listening on 4002"

Head "enabling the importer"
Set-ImportFlag "true"
Warn "if you stop this script from here on, set that back to false yourself,"
Warn "otherwise the importer keeps watching Archive on every API start."

Head "starting the API"
Say "  Start the API now, the same way you normally do."
Say "    pnpm --filter @kernelarchive/api start"
if (-not (Wait-For { Api-Up } "the API to come up" 900)) { exit 1 }
Good "API is responding"

# ---- watch the scan -----------------------------------------------------------
Head "indexing"
Say "  Watching. A run that starts working through thousands of modules means the"
Say "  added files arrived with disturbed timestamps; this will stop and say so."
Say ""

$runaway = 0
$idle_polls = 0
$last = ""
while ($true) {
    Start-Sleep -Seconds 5
    try {
        $s = Invoke-RestMethod -Uri "http://127.0.0.1:4002/api/v1/archive/scan-status" -TimeoutSec 15
        $s = $s.data
    } catch { Warn "status unavailable, retrying"; continue }

    $line = "  state={0} discovered={1} pe={2} processed={3} indexed={4} unchanged={5} skipped={6} failed={7}" -f `
        $s.state, $s.discovered_files, $s.portable_executables, $s.processed_files, $s.indexed_files, $s.unchanged_files, $s.skipped_files, $s.failed_files
    if ($line -ne $last) { Say $line; $last = $line }

    if ($s.indexed_files -gt 12000) {
        $runaway++
        if ($runaway -ge 3) {
            Say ""
            Bad "indexed $($s.indexed_files) files. That is a full re-index, not an incremental one."
            Say "        Stop the API, set KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED=false, and ask"
            Say "        before letting it continue. The flag is still true right now."
            exit 1
        }
    }

    if ($s.state -eq "idle" -and -not $s.queued) {
        $idle_polls++
        if ($idle_polls -ge 3) { break }
    } else { $idle_polls = 0 }
}
Good "indexing finished"
if ($s.failed_files -gt 0) { Warn "$($s.failed_files) file(s) failed, see the API log" }

# ---- disable and finish -------------------------------------------------------
Head "disabling the importer"
Set-ImportFlag "false"
Say "  Restart the API so it stops watching, then press Enter."
Read-Host "  [Enter] once the API has been restarted" | Out-Null

Head "folding the WAL into the database"
Invoke-Node @((Join-Path $root "scripts\prepare-data.mjs"))

Head "regenerating the sitemap"
Invoke-Node @((Join-Path $root "scripts\generate-sitemap.mjs"))

# ---- report -------------------------------------------------------------------
$after = Db-Counts $db_path
Head "result"
foreach ($k in @("builds", "modules", "types", "functions")) {
    $b = 0; if ($before.$k) { $b = [int]$before.$k }
    $a = 0; if ($after.$k) { $a = [int]$after.$k }
    Say ("  {0,-12} {1,12:N0} -> {2,12:N0}  ({3,+N0})" -f $k, $b, $a, ($a - $b))
}

Say ""
Good "done"
Say "  Restart the frontend so it serves the regenerated sitemap."
Say "  Then check a new build:  https://kernelarchive.com/builds"
