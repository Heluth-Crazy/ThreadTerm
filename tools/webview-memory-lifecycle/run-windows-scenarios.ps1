#Requires -Version 5.1
<#
.SYNOPSIS
  Interactive one-command runner for the ThreadTerm Release memory scenarios.

.DESCRIPTION
  The operator performs each documented UI scenario and presses Enter. This
  runner only invokes the read-only sampler and writes artifacts; it never
  drives the app or opens user content itself.
#>
[CmdletBinding()]
param(
  [string]$OutDir = "docs\artifacts\webview-memory-lifecycle\windows-release",

  [string]$DiagnosticsDir = "",

  [string]$UserDataMarker = "com.Heluth-Crazy.threadterm",

  [ValidateSet("Release", "Debug", "Unknown")]
  [string]$BuildKind = "Release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$sampler = Join-Path $PSScriptRoot "sample-windows.ps1"
$analyzer = Join-Path $PSScriptRoot "analyze-samples.mjs"
if (-not (Test-Path -LiteralPath $sampler -PathType Leaf)) {
  throw "Sampler not found: $sampler"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-DiagnosticsPath {
  param([string]$Label)
  if ([string]::IsNullOrWhiteSpace($DiagnosticsDir)) { return "" }
  $candidate = Join-Path $DiagnosticsDir "$Label.json"
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  Write-Warning "No app diagnostics for $Label at $candidate"
  return ""
}

function Invoke-Sample {
  param(
    [string]$Label,
    [string]$Scenario,
    [int[]]$SettleSeconds
  )
  $arguments = @{
    Label = $Label
    Scenario = $Scenario
    SettleSeconds = $SettleSeconds
    OutDir = $OutDir
    UserDataMarker = $UserDataMarker
    BuildKind = $BuildKind
  }
  $diagnosticsPath = Get-DiagnosticsPath -Label $Label
  if (-not [string]::IsNullOrWhiteSpace($diagnosticsPath)) {
    $arguments.AppDiagnosticsPath = $diagnosticsPath
  }
  & $sampler @arguments
}

$scenarios = [ordered]@{
  "S0-cold-start" = "Launch a fresh Release build with only the main window; save S0-cold-start.json diagnostics if configured."
  "S1-hot-37-cards" = "Load the existing 37-card data set and wait until card/session discovery is idle."
  "S2-six-terminal-focus" = "Open and focus each of six terminals once, ending on the sixth terminal."
  "S3-main-float-dual-view" = "Show the same running terminal in the main window and float window."
}

Write-Host "ThreadTerm Windows memory acceptance"
Write-Host "Build kind: $BuildKind"
Write-Host "Artifacts: $OutDir"
Write-Host "Each settle series is measured from the moment you press Enter (T+0/5/30/120)."

foreach ($entry in $scenarios.GetEnumerator()) {
  Write-Host ""
  Write-Host "[$($entry.Key)] $($entry.Value)"
  [void](Read-Host "Press Enter when the scenario is ready")
  Invoke-Sample -Label $entry.Key -Scenario $entry.Key.Split('-')[0] -SettleSeconds @(0, 5, 30, 120)
}

Write-Host ""
Write-Host "[S4-twenty-rounds] Perform one full round: focus six terminals, toggle selector/float, switch clean editors, then visit long Chat."
foreach ($round in 1..20) {
  [void](Read-Host ("Complete round {0}/20, then press Enter" -f $round))
  if ($round -in @(1, 10, 20)) {
    $roundLabel = "S4-round-{0:d2}" -f $round
    Invoke-Sample -Label $roundLabel -Scenario "S4" -SettleSeconds @(120)
  }
}

$remainingScenarios = [ordered]@{
  "S5-overlay-windows" = "Open/close selector, float, and settings according to scenarios.md; end with all auxiliary windows closed."
  "S6-editors-long-chat" = "Prepare dirty/current/diff tabs plus Claude and Codex long histories; hide the heavy views without stopping work."
}
foreach ($entry in $remainingScenarios.GetEnumerator()) {
  Write-Host ""
  Write-Host "[$($entry.Key)] $($entry.Value)"
  [void](Read-Host "Press Enter when the scenario is ready")
  Invoke-Sample -Label $entry.Key -Scenario $entry.Key.Split('-')[0] -SettleSeconds @(0, 5, 30, 120)
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  $reportPath = Join-Path $OutDir "analysis.md"
  & node $analyzer $OutDir --out $reportPath
} else {
  Write-Warning "Node.js not found; run analyze-samples.mjs later to calculate the 20-round gate."
}

Write-Host "Scenario pass complete. Fill report-template.md with the generated evidence."
