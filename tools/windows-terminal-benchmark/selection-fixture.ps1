[CmdletBinding()]
param(
  [ValidateRange(100, 200000)]
  [int]$Lines = 2500
)

$ErrorActionPreference = "Stop"

for ($i = 1; $i -le $Lines; $i++) {
  $prefix = "{0:D6}" -f $i
  Write-Output "$prefix selection fixture: abcdefghijklmnopqrstuvwxyz 0123456789 中文かな한국어 ───── copy-range-check"
}

[Console]::Error.WriteLine("ThreadTermBenchmark selection-fixture lines=$Lines")
