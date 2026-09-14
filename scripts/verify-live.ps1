# Live verification for the running agent-instructions-editor plugin.
# Hard assertions with a failure counter and exit code — safe to use as a gate.
#
# Usage:
#   ./scripts/verify-live.ps1 [-Workspace <dir>] [-AllowWrites]
#
# Read-only by default: WITHOUT -AllowWrites the script issues GET requests
# only — no POST ever reaches the host, so nothing can be written to the
# real ~/.dsh/AGENTS.md regardless of server behavior (review gate 5,
# AIE-LIVE-008). With -AllowWrites, every write probe targets a temporary
# manual project under $env:TEMP that the script registers via the API,
# fences with the current revision, and removes again afterwards; the real
# global file is never touched.
param(
  [string]$Workspace = (Get-Location).Path,
  [switch]$AllowWrites
)
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3080'
$script:failures = 0
function Fail($msg) { Write-Host "FAIL: $msg"; $script:failures++ }
function Pass($msg) { Write-Host "PASS: $msg" }
function Skip($msg) { Write-Host "SKIP: $msg" }

Write-Host '=== 1. GET /projects ==='
$projects = $null
try {
  $projects = Invoke-RestMethod -Uri "$base/agent-instructions/api/projects" -Method GET
  if ($projects.ok -ne $true) { Fail 'projects ok!=true' } else { Pass "projects ok, count=$($projects.projects.Count), revision=$($projects.revision), global exists=$($projects.global.exists) bytes=$($projects.global.bytes)" }
  $labels = $projects.projects | ForEach-Object { $_.realpath ?? $_.dir }
  $dupes = ($labels | Group-Object | Where-Object { $_.Count -gt 1 })
  if ($null -ne $dupes -and @($dupes).Count -gt 0) { Fail "duplicate project paths: $($dupes.Name -join '; ')" } else { Pass 'no duplicate project paths' }
} catch { Fail "projects: $($_.Exception.Message)" }

Write-Host ''
Write-Host '=== 2. GET /file?scope=global (read-only) ==='
try {
  $file = Invoke-RestMethod -Uri "$base/agent-instructions/api/file?scope=global&name=AGENTS.md" -Method GET
  if ($file.ok -eq $true) { Pass "global read ok, exists=$($file.exists) bytes=$($file.bytes)" }
  else { Fail "global read unexpected: $($file | ConvertTo-Json -Compress -Depth 3)" }
} catch { Fail "global read: $($_.Exception.Message)" }

Write-Host ''
Write-Host '=== 3. GET /chain for -Workspace ==='
try {
  $chain = Invoke-RestMethod -Uri "$base/agent-instructions/api/chain?dir=$([uri]::EscapeDataString($Workspace))" -Method GET
  if ($chain.ok -ne $true) { Fail 'chain ok!=true' }
  elseif ($chain.dirs.Count -lt 1) { Fail 'chain empty' }
  else {
    Pass "chain ok, dirs=$($chain.dirs.Count), totalBytes=$($chain.totalBytes), budgetBytes=$($chain.budgetBytes)"
    if ($chain.global.overLimit -eq $true -and $chain.totalBytes -ge $chain.global.bytes) {
      Fail 'over-limit global was counted into totalBytes (AIE-BUDGET-003 regression)'
    } else { Pass 'global accounting sane (over-limit global excluded if present)' }
  }
} catch { Fail "chain: $($_.Exception.Message)" }

Write-Host ''
Write-Host '=== 4. Host guard (anti-DNS-rebinding) — GET only, safe in read-only mode ==='
$spoof = [int](curl.exe -s -o NUL -w '%{http_code}' -H 'Host: evil.example.com' "$base/agent-instructions/api/projects")
$loop  = [int](curl.exe -s -o NUL -w '%{http_code}' -H 'Host: 127.0.0.1:3080' "$base/agent-instructions/api/projects")
if ($spoof -eq 403) { Pass "spoofed Host -> 403" } else { Fail "spoofed Host -> $spoof (expect 403)" }
if ($loop -eq 200) { Pass "loopback Host -> 200" } else { Fail "loopback Host -> $loop (expect 200)" }

Write-Host ''
Write-Host '=== 5. client bundle (informational) ==='
Write-Host 'INFO: bundles load via the boot-graph combo URLs (/plugins/??...&rev=...), which require the'
Write-Host '      browser session; a settings page that renders InstructionsSection is the ground truth.'

# ── write probes: gated, sandboxed into a temp project, revision-fenced ────
$probeDir = $null
$cleanupError = $null
if ($AllowWrites) {
  Write-Host ''
  Write-Host '=== 6. write probes against a TEMP project (real global file untouched) ==='
  try {
    try {
      $probeDir = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("aie-live-probe-" + [guid]::NewGuid().ToString('N')))).FullName
      Set-Content -Path (Join-Path $probeDir 'AGENTS.md') -Value 'probe original'
      Set-Content -Path (Join-Path $probeDir '.git') -Value '' -Force
    } catch { throw "temp fixture creation failed: $($_.Exception.Message)" }

    # 6a. register (revision-fenced: read fresh revision, then add)
    $view = Invoke-RestMethod -Uri "$base/agent-instructions/api/projects" -Method GET
    $add = Invoke-RestMethod -Uri "$base/agent-instructions/api/projects" -Method POST -ContentType 'application/json; charset=utf-8' -Body (@{ op = 'add'; dir = $probeDir; expectedRevision = $view.revision } | ConvertTo-Json -Depth 3)
    if ($add.ok -ne $true) { throw "temp project add failed: $($add | ConvertTo-Json -Compress)" }
    Pass 'temp project registered (revision-fenced add)'

    # 6b. mtime-fenced write-back of identical content
    $fresh = Invoke-RestMethod -Uri "$base/agent-instructions/api/file?scope=project&dir=$([uri]::EscapeDataString($probeDir))&name=AGENTS.md" -Method GET
    $body = @{ scope = 'project'; dir = $probeDir; name = 'AGENTS.md'; content = $fresh.content; expectedMtimeMs = $fresh.mtimeMs } | ConvertTo-Json -Depth 3
    $written = Invoke-RestMethod -Uri "$base/agent-instructions/api/file" -Method POST -ContentType 'application/json; charset=utf-8' -Body $body
    if ($written.ok -eq $true) { Pass "write-back ok, bytes=$($written.bytes)" } else { Fail 'write-back ok!=true' }

    # 6c. stale mtime must 409 (placeholder can only land in the temp file even if broken)
    $staleBody = @{ scope = 'project'; dir = $probeDir; name = 'AGENTS.md'; content = 'SHOULD NOT BE WRITTEN'; expectedMtimeMs = 1 } | ConvertTo-Json -Depth 3
    $response = Invoke-WebRequest -Uri "$base/agent-instructions/api/file" -Method POST -ContentType 'application/json; charset=utf-8' -Body $staleBody -SkipHttpErrorCheck
    if ($response.StatusCode -eq 409) { Pass 'conflict fence 409' } else { Fail "conflict fence status=$($response.StatusCode) (expect 409)" }

    # 6d. same-version CONCURRENCY (AIE-WRITE-006): two requests fired in
    # parallel — not sequentially — must yield 200 + 409 under the
    # per-target write queue.
    $fresh2 = Invoke-RestMethod -Uri "$base/agent-instructions/api/file?scope=project&dir=$([uri]::EscapeDataString($probeDir))&name=AGENTS.md" -Method GET
    $bodyA = @{ scope = 'project'; dir = $probeDir; name = 'AGENTS.md'; content = 'probe concurrent A'; expectedMtimeMs = $fresh2.mtimeMs } | ConvertTo-Json -Depth 3
    $bodyB = @{ scope = 'project'; dir = $probeDir; name = 'AGENTS.md'; content = 'probe concurrent B'; expectedMtimeMs = $fresh2.mtimeMs } | ConvertTo-Json -Depth 3
    $codes = 1..2 | ForEach-Object -Parallel {
      $payload = if ($_.Equals(1)) { $using:bodyA } else { $using:bodyB }
      [int](Invoke-WebRequest -Uri "$using:base/agent-instructions/api/file" -Method POST -ContentType 'application/json; charset=utf-8' -Body $payload -SkipHttpErrorCheck).StatusCode
    }
    $sorted = @($codes) | Sort-Object
    if ("$sorted" -eq '200 409') { Pass "same-version concurrent writes -> 200 + 409 (serialized queue)" } else { Fail "same-version concurrent writes -> $($sorted -join ',') (expect 200,409)" }

    # 6e. cross-origin write must die at the guard (never reaches the file)
    $cross = [int](curl.exe -s -o NUL -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:9999' -H 'Host: 127.0.0.1:3080' --data-binary $bodyA "$base/agent-instructions/api/file")
    if ($cross -eq 403) { Pass "cross-origin POST -> 403" } else { Fail "cross-origin POST -> $cross (expect 403)" }
    # 6f. no-Origin local-script POST passes the guard and hits the mtime fence
    $noOrigin = [int](curl.exe -s -o NUL -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Host: 127.0.0.1:3080' --data-binary $staleBody "$base/agent-instructions/api/file")
    if ($noOrigin -eq 409) { Pass "no-Origin POST -> 409 (past guards, hit mtime fence)" }
    elseif ($noOrigin -eq 403) { Fail "no-Origin POST -> 403 (should be allowed for local scripts)" }
    else { Fail "no-Origin POST -> $noOrigin (expect 409)" }
  } catch {
    Fail "write probes: $($_.Exception.Message)"
  } finally {
    # AIE-LIVE-008: cleanup must cover every path after fixture creation —
    # registration may have failed while the temp dir already exists, and a
    # failed cleanup is a visible failure, never a silent leftover.
    try {
      if ($null -ne $probeDir -and (Test-Path $probeDir)) {
        try {
          $view = Invoke-RestMethod -Uri "$base/agent-instructions/api/projects" -Method GET
          $entry = $view.projects | Where-Object { ($_.realpath ?? $_.dir) -ieq $probeDir -and $_.source -eq 'manual' } | Select-Object -First 1
          if ($null -ne $entry) {
            $rawId = $entry.id -replace '^manual:', ''
            $remove = Invoke-RestMethod -Uri "$base/agent-instructions/api/projects" -Method POST -ContentType 'application/json; charset=utf-8' -Body (@{ op = 'remove'; id = $rawId; expectedRevision = $view.revision } | ConvertTo-Json -Depth 3)
            if ($remove.ok -eq $true) { Pass 'temp probe project removed (revision-fenced, raw id)' } else { Fail "temp project remove failed: $($remove | ConvertTo-Json -Compress)" }
          }
        } catch { $cleanupError = "registry removal failed: $($_.Exception.Message)" }
        try {
          Remove-Item $probeDir -Recurse -Force -ErrorAction Stop
        } catch { $cleanupError = "temp dir removal failed: $($_.Exception.Message)" }
      }
    } catch {
      $cleanupError = $_.Exception.Message
    }
    if ($null -ne $cleanupError) { Fail "cleanup: $cleanupError" }
  }
} else {
  Write-Host ''
  Write-Host '=== 6. write probes ==='
  Skip 'read-only mode (no POST issued at all); re-run with -AllowWrites to exercise writes against a temp project only'
}

Write-Host ''
if ($script:failures -gt 0) { Write-Host "RESULT: $($script:failures) failure(s)"; exit 1 }
Write-Host 'RESULT: all assertions passed'
exit 0
