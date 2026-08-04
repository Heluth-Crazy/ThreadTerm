#Requires -Version 5.1
<#
.SYNOPSIS
  Sample the complete ThreadTerm-owned Windows process tree for memory baselines.

.DESCRIPTION
  Reads process metrics only. It does not launch ThreadTerm, create WebViews, or
  open user content. WebView2 is selected from the ThreadTerm EBWebView user-data
  marker and its descendants; Claude/Codex/PTY children are selected strictly
  from the ThreadTerm process tree. Raw command lines are never written.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Label,

  [string]$OutDir = "docs\artifacts\webview-memory-lifecycle",

  [int[]]$SettleSeconds = @(),

  [string]$UserDataMarker = "com.Heluth-Crazy.threadterm",

  [string]$MainProcessName = "threadterm",

  [string]$AppDiagnosticsPath = "",

  [ValidateSet("Release", "Debug", "Unknown")]
  [string]$BuildKind = "Release",

  [string]$Scenario = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-ProcessTable {
  $table = @{}
  foreach ($row in Get-CimInstance Win32_Process -ErrorAction Stop) {
    $processId = [int]$row.ProcessId
    if ($processId -le 0) { continue }
    $table[$processId] = [pscustomobject]@{
      pid = $processId
      ppid = [int]$row.ParentProcessId
      name = [System.IO.Path]::GetFileNameWithoutExtension([string]$row.Name)
      commandLine = [string]$row.CommandLine
    }
  }
  return $table
}

function Get-PrivateWorkingSetMap {
  $result = @{}
  try {
    foreach ($row in Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop) {
      $processId = [int]$row.IDProcess
      if ($processId -gt 0) {
        $result[$processId] = [int64]$row.WorkingSetPrivate
      }
    }
  } catch {
    # Per-process WorkingSet64 is used below when the formatted counter class
    # is unavailable. Never guess an instance name for duplicate processes.
  }
  return $result
}

function Test-IsDescendantOf {
  param(
    [int]$ProcessId,
    [hashtable]$ProcessTable,
    [hashtable]$RootIds
  )
  $seen = @{}
  $currentId = $ProcessId
  for ($depth = 0; $depth -lt 32; $depth += 1) {
    if ($RootIds.ContainsKey($currentId)) { return $true }
    if ($seen.ContainsKey($currentId)) { return $false }
    $seen[$currentId] = $true
    if (-not $ProcessTable.ContainsKey($currentId)) { return $false }
    $parentId = [int]$ProcessTable[$currentId].ppid
    if ($parentId -le 0 -or $parentId -eq $currentId) { return $false }
    $currentId = $parentId
  }
  return $false
}

function New-MemoryProcessSample {
  param(
    [pscustomobject]$Row,
    [string]$Role,
    [hashtable]$PrivateWorkingSetMap
  )
  try {
    $process = Get-Process -Id $Row.pid -ErrorAction Stop
  } catch {
    return $null
  }
  $metricSource = "WorkingSet64-fallback"
  $privateBytes = [int64]$process.WorkingSet64
  if ($PrivateWorkingSetMap.ContainsKey([int]$Row.pid)) {
    $privateBytes = [int64]$PrivateWorkingSetMap[[int]$Row.pid]
    $metricSource = "Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate"
  }
  return [pscustomobject]@{
    pid = [int]$Row.pid
    ppid = [int]$Row.ppid
    name = [string]$Row.name
    role = $Role
    privateBytes = $privateBytes
    privateMb = [math]::Round([double]$privateBytes / 1MB, 1)
    workingSetBytes = [int64]$process.WorkingSet64
    workingSetMb = [math]::Round([double]$process.WorkingSet64 / 1MB, 1)
    metricSource = $metricSource
  }
}

function Classify-WebViewRole {
  param([string]$CommandLine)
  $command = $CommandLine.ToLowerInvariant()
  if ($command -match "--type=renderer") { return "WEBVIEW_RENDERER" }
  if ($command -match "--type=gpu-process" -or $command -match "--type=gpu") {
    return "WEBVIEW_GPU"
  }
  if ($command -match "--type=utility") { return "WEBVIEW_UTILITY" }
  if ($command -match "--type=crashpad-handler" -or $command -match "crashpad") {
    return "WEBVIEW_CRASHPAD"
  }
  if ($command -match "--type=") { return "WEBVIEW_OTHER" }
  return "WEBVIEW_BROWSER"
}

function Classify-AppChildRole {
  param(
    [string]$Name,
    [string]$CommandLine
  )
  $nameLower = $Name.ToLowerInvariant()
  $command = $CommandLine.ToLowerInvariant()
  if ($command -match "claude-host(?:\.mjs)?" -or $command -match "threadterm_claude_sidecar") {
    return "CLAUDE_HOST"
  }
  if ($nameLower -eq "claude" -or $command -match "(?:^|[\\/\s])claude(?:\.exe)?(?:\s|$)") {
    return "CLAUDE_CLI"
  }
  if (($nameLower -eq "codex" -or $command -match "(?:^|[\\/\s])codex(?:\.exe)?(?:\s|$)") -and
      $command -match "app-server") {
    return "CODEX_APP_SERVER"
  }
  if ($nameLower -eq "codex" -or $command -match "(?:^|[\\/\s])codex(?:\.exe)?(?:\s|$)") {
    return "CODEX_CLI"
  }
  return "PTY_CHILD"
}

function Get-SumProperty {
  param(
    [object[]]$Items,
    [string]$PropertyName
  )
  $total = [int64]0
  foreach ($item in @($Items)) {
    if ($null -eq $item) { continue }
    $value = $item.$PropertyName
    if ($null -ne $value) { $total += [int64]$value }
  }
  return $total
}

function Get-RoleSummary {
  param([object[]]$Processes)
  $summary = [ordered]@{}
  foreach ($role in @(
    "THREADTERM_MAIN",
    "WEBVIEW_BROWSER", "WEBVIEW_GPU", "WEBVIEW_RENDERER", "WEBVIEW_UTILITY",
    "WEBVIEW_CRASHPAD", "WEBVIEW_OTHER",
    "CLAUDE_HOST", "CLAUDE_CLI", "CODEX_APP_SERVER", "CODEX_CLI", "PTY_CHILD"
  )) {
    $members = @($Processes | Where-Object { $_.role -eq $role })
    $privateBytes = Get-SumProperty -Items $members -PropertyName "privateBytes"
    $summary[$role] = [ordered]@{
      count = $members.Count
      privateBytes = $privateBytes
      privateMb = [math]::Round([double]$privateBytes / 1MB, 1)
    }
  }
  return $summary
}

function Read-AppDiagnostics {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "App diagnostics file not found: $Path"
  }
  $value = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  if ([string]$value.kind -ne "threadterm-lifecycle-diagnostics") {
    throw "Unexpected app diagnostics kind in ${Path}: $($value.kind)"
  }
  return $value
}

function Get-GitCommit {
  try {
    $value = (& git rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
    if ($value -match '^[0-9a-fA-F]{40}$') { return $value }
  } catch {
    # Sampling can run from an unpacked Release bundle without git metadata.
  }
  return $null
}

function New-SampleSnapshot {
  param(
    [string]$SampleLabel,
    [nullable[int]]$SettleSecondsValue,
    [object]$AppDiagnostics
  )

  $processTable = Get-ProcessTable
  $privateMap = Get-PrivateWorkingSetMap
  $mainRows = @($processTable.Values | Where-Object {
    $_.name -ieq $MainProcessName
  })
  $mainIds = @{}
  foreach ($row in $mainRows) { $mainIds[[int]$row.pid] = $true }

  $webviewRows = @($processTable.Values | Where-Object { $_.name -ieq "msedgewebview2" })
  $webviewSeedIds = @{}
  foreach ($row in $webviewRows) {
    if (-not [string]::IsNullOrWhiteSpace($row.commandLine) -and
        $row.commandLine.IndexOf($UserDataMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $webviewSeedIds[[int]$row.pid] = $true
    }
  }
  $ownedWebviewRows = @($webviewRows | Where-Object {
    $webviewSeedIds.ContainsKey([int]$_.pid) -or
      (Test-IsDescendantOf -ProcessId ([int]$_.pid) -ProcessTable $processTable -RootIds $webviewSeedIds)
  })
  $ownedWebviewIds = @{}
  foreach ($row in $ownedWebviewRows) { $ownedWebviewIds[[int]$row.pid] = $true }

  $childRows = @($processTable.Values | Where-Object {
    -not $mainIds.ContainsKey([int]$_.pid) -and
      -not $ownedWebviewIds.ContainsKey([int]$_.pid) -and
      (Test-IsDescendantOf -ProcessId ([int]$_.pid) -ProcessTable $processTable -RootIds $mainIds)
  })

  $main = @($mainRows | ForEach-Object {
    New-MemoryProcessSample -Row $_ -Role "THREADTERM_MAIN" -PrivateWorkingSetMap $privateMap
  } | Where-Object { $null -ne $_ })
  $webviews = @($ownedWebviewRows | ForEach-Object {
    $role = Classify-WebViewRole -CommandLine $_.commandLine
    New-MemoryProcessSample -Row $_ -Role $role -PrivateWorkingSetMap $privateMap
  } | Where-Object { $null -ne $_ })
  $children = @($childRows | ForEach-Object {
    $role = Classify-AppChildRole -Name $_.name -CommandLine $_.commandLine
    New-MemoryProcessSample -Row $_ -Role $role -PrivateWorkingSetMap $privateMap
  } | Where-Object { $null -ne $_ })
  $allProcesses = @($main) + @($webviews) + @($children)
  $byRole = Get-RoleSummary -Processes $allProcesses

  $mainPrivate = Get-SumProperty -Items $main -PropertyName "privateBytes"
  $webviewPrivate = Get-SumProperty -Items $webviews -PropertyName "privateBytes"
  $childPrivate = Get-SumProperty -Items $children -PropertyName "privateBytes"
  $appGroupPrivate = [int64]($mainPrivate + $webviewPrivate)
  $ownedGroupPrivate = [int64]($appGroupPrivate + $childPrivate)

  return [ordered]@{
    schemaVersion = 2
    kind = "threadterm-memory-sample"
    platform = "windows"
    label = $SampleLabel
    scenario = $Scenario
    settleSeconds = $SettleSecondsValue
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    filter = [ordered]@{
      mainProcessName = $MainProcessName
      userDataMarker = $UserDataMarker
      webviewSelection = "marker-seed-and-descendants"
      appChildSelection = "threadterm-process-tree"
    }
    processes = $allProcesses
    totals = [ordered]@{
      mainPrivateBytes = $mainPrivate
      mainPrivateMb = [math]::Round([double]$mainPrivate / 1MB, 1)
      webviewPrivateBytes = $webviewPrivate
      webviewPrivateMb = [math]::Round([double]$webviewPrivate / 1MB, 1)
      appGroupPrivateBytes = $appGroupPrivate
      appGroupPrivateMb = [math]::Round([double]$appGroupPrivate / 1MB, 1)
      childPrivateBytes = $childPrivate
      childPrivateMb = [math]::Round([double]$childPrivate / 1MB, 1)
      ownedProcessGroupPrivateBytes = $ownedGroupPrivate
      ownedProcessGroupPrivateMb = [math]::Round([double]$ownedGroupPrivate / 1MB, 1)
      webviewProcessCount = $webviews.Count
      rendererCount = $byRole["WEBVIEW_RENDERER"].count
      claudeHostCount = $byRole["CLAUDE_HOST"].count
      claudeCliCount = $byRole["CLAUDE_CLI"].count
      codexAppServerCount = $byRole["CODEX_APP_SERVER"].count
      codexCliCount = $byRole["CODEX_CLI"].count
      ptyChildCount = $byRole["PTY_CHILD"].count
    }
    byRole = $byRole
    appDiagnostics = $AppDiagnostics
    notes = @(
      "Private working set is PID-matched through Win32_PerfFormattedData_PerfProc_Process.",
      "WorkingSet64 fallback is identified per process when that counter is unavailable.",
      "Raw command lines are used only for classification and are not persisted.",
      "Debug builds are not valid for acceptance comparisons."
    )
  }
}

$appDiagnostics = Read-AppDiagnostics -Path $AppDiagnosticsPath
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeLabel = ($Label -replace '[^\w\.-]+', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($safeLabel)) { $safeLabel = "sample" }

$samples = @()
if ($SettleSeconds.Count -eq 0) {
  $samples += New-SampleSnapshot -SampleLabel $safeLabel -SettleSecondsValue $null -AppDiagnostics $appDiagnostics
} else {
  $elapsed = 0
  foreach ($targetSecond in @($SettleSeconds | Sort-Object -Unique)) {
    if ($targetSecond -lt 0) { throw "SettleSeconds cannot contain negative values" }
    $delay = $targetSecond - $elapsed
    if ($delay -gt 0) {
      Write-Host "Settling to T+${targetSecond}s before sample '$safeLabel'..."
      Start-Sleep -Seconds $delay
    }
    $samples += New-SampleSnapshot -SampleLabel "$safeLabel-t${targetSecond}s" -SettleSecondsValue $targetSecond -AppDiagnostics $appDiagnostics
    $elapsed = $targetSecond
  }
}

$appGroupValues = @($samples | ForEach-Object { [int64]$_.totals.appGroupPrivateBytes })
$ownedGroupValues = @($samples | ForEach-Object { [int64]$_.totals.ownedProcessGroupPrivateBytes })
$document = [ordered]@{
  schemaVersion = 2
  kind = "threadterm-memory-sample-set"
  label = $safeLabel
  scenario = $Scenario
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  build = [ordered]@{
    kind = $BuildKind
    commit = Get-GitCommit
  }
  machine = [ordered]@{
    os = [System.Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
    logicalProcessorCount = [System.Environment]::ProcessorCount
  }
  observed = [ordered]@{
    sampleCount = $samples.Count
    peakAppGroupPrivateBytes = [int64](($appGroupValues | Measure-Object -Maximum).Maximum)
    peakOwnedProcessGroupPrivateBytes = [int64](($ownedGroupValues | Measure-Object -Maximum).Maximum)
    finalAppGroupPrivateBytes = [int64]$appGroupValues[-1]
    finalOwnedProcessGroupPrivateBytes = [int64]$ownedGroupValues[-1]
  }
  samples = $samples
}

$outPath = Join-Path $OutDir "$safeLabel-$stamp.json"
$document | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath $outPath

foreach ($sample in $samples) {
  $totals = $sample.totals
  Write-Host ("[{0}] main={1} MB webview={2} MB children={3} MB owned={4} MB webviews={5} renderers={6} claude={7}/{8} codex={9}/{10} pty={11}" -f `
    $sample.label, $totals.mainPrivateMb, $totals.webviewPrivateMb, $totals.childPrivateMb,
    $totals.ownedProcessGroupPrivateMb, $totals.webviewProcessCount, $totals.rendererCount,
    $totals.claudeHostCount, $totals.claudeCliCount, $totals.codexAppServerCount,
    $totals.codexCliCount, $totals.ptyChildCount)
}

Write-Host "Wrote $outPath"
