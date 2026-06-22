[CmdletBinding()]
param(
  [string]$OutDir = "docs\artifacts\windows-terminal-baseline",

  [switch]$SkipHundredMb
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Wait-Step {
  param([string]$Message)

  Write-Host ""
  Write-Host "=== $Message ===" -ForegroundColor Cyan
  Write-Host "Start DevTools Performance recording or screen recording now, then press Enter."
  [void](Read-Host)
}

& (Join-Path $ScriptDir "capture-env.ps1") -OutDir $OutDir

Wait-Step "10 MB continuous output"
& (Join-Path $ScriptDir "large-output.ps1") -Megabytes 10

if (-not $SkipHundredMb) {
  Wait-Step "100 MB continuous output"
  & (Join-Path $ScriptDir "large-output.ps1") -Megabytes 100
}

Wait-Step "Long selection fixture"
& (Join-Path $ScriptDir "selection-fixture.ps1") -Lines 2500

Wait-Step "Unicode / emoji / bidi fixture"
& (Join-Path $ScriptDir "unicode-fixture.ps1") -Repeat 20

Write-Host ""
Write-Host "Baseline fixture run complete. Fill docs/windows-terminal-baseline-report.json with measured FPS, latency, screenshots, and control results."
