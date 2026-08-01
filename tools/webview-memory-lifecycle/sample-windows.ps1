#Requires -Version 5.1
<#
.SYNOPSIS
  Sample ThreadTerm + WebView2 private memory for lifecycle baselines.

.DESCRIPTION
  Reads process metrics only. Does not launch ThreadTerm, create WebViews, or
  open user content. Filters msedgewebview2.exe by this app's EBWebView
  user-data directory so other apps' WebView2 processes are excluded.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Label,

  [string]$OutDir = "docs\artifacts\webview-memory-lifecycle",

  [int[]]$SettleSeconds = @(),

  [string]$UserDataMarker = "com.Heluth-Crazy.threadterm",

  [string]$MainProcessName = "threadterm"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-PrivateWorkingSetBytes {
  param([System.Diagnostics.Process]$Process)
  try {
    $counter = Get-Counter "\Process($($Process.ProcessName))\Working Set - Private" -ErrorAction Stop
    $samples = @($counter.CounterSamples | Where-Object {
      $_.InstanceName -eq $Process.ProcessName -or
      $_.Path -match [regex]::Escape("($($Process.Id))")
    })
    if ($samples.Count -gt 0) {
      return [int64]$samples[0].CookedValue
    }
  } catch {
    # Fall through to WorkingSet64 when private counter is unavailable.
  }
  return [int64]$Process.WorkingSet64
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$row.CommandLine
  } catch {
    return ""
  }
}

function Classify-WebViewRole {
  param([string]$CommandLine)
  $cl = $CommandLine.ToLowerInvariant()
  if ($cl -match "--type=renderer") { return "RENDERER" }
  if ($cl -match "--type=gpu-process" -or $cl -match "--type=gpu") { return "GPU" }
  if ($cl -match "--type=utility") { return "UTILITY" }
  if ($cl -match "--type=crashpad-handler" -or $cl -match "crashpad") { return "CRASHPAD" }
  if ($cl -match "--type=") { return "OTHER" }
  return "BROWSER"
}

function Get-ThreadTermWebViewProcesses {
  param([string]$Marker)
  $result = @()
  foreach ($proc in Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue) {
    $cmd = Get-ProcessCommandLine -ProcessId $proc.Id
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    if ($cmd -notlike "*$Marker*") { continue }
    if ($cmd -notlike "*EBWebView*" -and $cmd -notlike "*webview2*") {
      # Still accept marker match; some helper processes omit EBWebView token.
    }
    $privateBytes = Get-PrivateWorkingSetBytes -Process $proc
    $result += [pscustomobject]@{
      pid = $proc.Id
      role = (Classify-WebViewRole -CommandLine $cmd)
      privateBytes = $privateBytes
      privateMb = [math]::Round($privateBytes / 1MB, 1)
      workingSetBytes = [int64]$proc.WorkingSet64
      workingSetMb = [math]::Round($proc.WorkingSet64 / 1MB, 1)
      commandLine = $cmd
    }
  }
  return $result
}

function Get-MainProcessSamples {
  param([string]$Name)
  $result = @()
  foreach ($proc in Get-Process -Name $Name -ErrorAction SilentlyContinue) {
    $privateBytes = Get-PrivateWorkingSetBytes -Process $proc
    $result += [pscustomobject]@{
      pid = $proc.Id
      name = $proc.ProcessName
      privateBytes = $privateBytes
      privateMb = [math]::Round($privateBytes / 1MB, 1)
      workingSetBytes = [int64]$proc.WorkingSet64
      workingSetMb = [math]::Round($proc.WorkingSet64 / 1MB, 1)
    }
  }
  return $result
}

function Get-SumProperty {
  param(
    [object[]]$Items,
    [string]$PropertyName
  )
  if ($null -eq $Items -or $Items.Count -eq 0) {
    return [int64]0
  }
  $total = [int64]0
  foreach ($item in $Items) {
    if ($null -eq $item) { continue }
    $value = $item.$PropertyName
    if ($null -ne $value) {
      $total += [int64]$value
    }
  }
  return $total
}

function New-SampleSnapshot {
  param(
    [string]$SampleLabel,
    [nullable[int]]$SettleSecondsValue
  )

  $main = @(Get-MainProcessSamples -Name $MainProcessName)
  $webviews = @(Get-ThreadTermWebViewProcesses -Marker $UserDataMarker)

  $byRole = @{}
  foreach ($role in @("BROWSER", "GPU", "RENDERER", "UTILITY", "CRASHPAD", "OTHER")) {
    $members = @($webviews | Where-Object { $_.role -eq $role })
    $sumPrivate = Get-SumProperty -Items $members -PropertyName "privateBytes"
    $byRole[$role] = [ordered]@{
      count = $members.Count
      privateBytes = [int64]$sumPrivate
      privateMb = [math]::Round([double]$sumPrivate / 1MB, 1)
    }
  }

  $webviewPrivate = Get-SumProperty -Items $webviews -PropertyName "privateBytes"
  $mainPrivate = Get-SumProperty -Items $main -PropertyName "privateBytes"

  return [ordered]@{
    schemaVersion = 1
    kind = "threadterm-webview-memory-sample"
    platform = "windows"
    label = $SampleLabel
    settleSeconds = $SettleSecondsValue
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    filter = [ordered]@{
      mainProcessName = $MainProcessName
      userDataMarker = $UserDataMarker
      webviewProcessName = "msedgewebview2"
    }
    mainProcesses = $main
    webviewProcesses = @($webviews | ForEach-Object {
      [ordered]@{
        pid = $_.pid
        role = $_.role
        privateBytes = $_.privateBytes
        privateMb = $_.privateMb
        workingSetBytes = $_.workingSetBytes
        workingSetMb = $_.workingSetMb
      }
    })
    totals = [ordered]@{
      mainPrivateBytes = [int64]$mainPrivate
      mainPrivateMb = [math]::Round([double]$mainPrivate / 1MB, 1)
      webviewPrivateBytes = [int64]$webviewPrivate
      webviewPrivateMb = [math]::Round([double]$webviewPrivate / 1MB, 1)
      appGroupPrivateBytes = [int64]($mainPrivate + $webviewPrivate)
      appGroupPrivateMb = [math]::Round([double]($mainPrivate + $webviewPrivate) / 1MB, 1)
      webviewProcessCount = $webviews.Count
      rendererCount = $byRole["RENDERER"].count
      gpuCount = $byRole["GPU"].count
      browserCount = $byRole["BROWSER"].count
      utilityCount = $byRole["UTILITY"].count
    }
    byRole = $byRole
    notes = @(
      "Private working set preferred; falls back to WorkingSet64 if counter unavailable.",
      "Does not include appDiagnostics; paste window.__threadtermLifecycleDiagnostics() separately.",
      "Debug builds are not valid for acceptance comparisons."
    )
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeLabel = ($Label -replace '[^\w\.-]+', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($safeLabel)) { $safeLabel = "sample" }

$samples = @()
if ($SettleSeconds.Count -eq 0) {
  $samples += New-SampleSnapshot -SampleLabel $safeLabel -SettleSecondsValue $null
} else {
  foreach ($wait in $SettleSeconds) {
    if ($wait -gt 0) {
      Write-Host "Settling ${wait}s before sample '$safeLabel'..."
      Start-Sleep -Seconds $wait
    }
    $samples += New-SampleSnapshot -SampleLabel "$safeLabel-t${wait}s" -SettleSecondsValue $wait
  }
}

$document = [ordered]@{
  schemaVersion = 1
  kind = "threadterm-webview-memory-sample-set"
  label = $safeLabel
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  machine = [ordered]@{
    os = [System.Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
  }
  samples = $samples
}

$outPath = Join-Path $OutDir "$safeLabel-$stamp.json"
$document | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -Path $outPath

foreach ($sample in $samples) {
  $t = $sample.totals
  Write-Host ("[{0}] main={1} MB  webview={2} MB  appGroup={3} MB  webviews={4} renderers={5}" -f `
    $sample.label, $t.mainPrivateMb, $t.webviewPrivateMb, $t.appGroupPrivateMb, $t.webviewProcessCount, $t.rendererCount)
}

Write-Host "Wrote $outPath"
