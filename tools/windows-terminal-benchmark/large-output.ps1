[CmdletBinding()]
param(
  [ValidateRange(1, 1024)]
  [int]$Megabytes = 10,

  [ValidateRange(1, 5000)]
  [int]$ChunkLines = 400
)

$ErrorActionPreference = "Stop"

$targetBytes = [int64]$Megabytes * 1MB
$encoding = [System.Text.UTF8Encoding]::new($false)
$lineSeed = "ThreadTerm W0 large-output fixture | CJK=中文かな한국어 | emoji=👩‍💻🚀✅ | box=┌─┬─┐ | arabic=مرحبا"
$writtenBytes = [int64]0
$lineNumber = 0
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

while ($writtenBytes -lt $targetBytes) {
  $builder = [System.Text.StringBuilder]::new()

  for ($i = 0; $i -lt $ChunkLines -and $writtenBytes -lt $targetBytes; $i++) {
    $line = "{0:D8} {1} utc={2:o}" -f $lineNumber, $lineSeed, (Get-Date).ToUniversalTime()
    [void]$builder.AppendLine($line)
    $writtenBytes += $encoding.GetByteCount($line + [Environment]::NewLine)
    $lineNumber += 1
  }

  [Console]::Out.Write($builder.ToString())
}

$stopwatch.Stop()
$summary = "ThreadTermBenchmark large-output megabytes=$Megabytes bytes=$writtenBytes lines=$lineNumber elapsedMs=$($stopwatch.ElapsedMilliseconds)"
[Console]::Error.WriteLine($summary)
