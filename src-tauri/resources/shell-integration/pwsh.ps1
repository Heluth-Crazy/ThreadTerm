# ThreadTerm shell integration (PowerShell)

function global:prompt {
  if ($global:ThreadTermBlockActive) {
    $code = if ($?) { 0 } else { 1 }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $duration = 0
    if ($null -ne $global:ThreadTermBlockStartedAt) {
      $duration = [Math]::Max(0, $now - [int64]$global:ThreadTermBlockStartedAt)
    }
    [Console]::Write("`e]133;D;$code`a")
    [Console]::Write("`e]6973;duration=$duration`a")
    $global:ThreadTermBlockActive = $false
    Remove-Variable -Scope Global -Name ThreadTermBlockStartedAt -ErrorAction SilentlyContinue
  }
  [Console]::Write("`e]133;A`a")
  "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}

Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
  $id = "tt-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  $cwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))
  $global:ThreadTermBlockActive = $true
  $global:ThreadTermBlockStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [Console]::Write("`e]133;B`a")
  [Console]::Write("`e]6973;cmd_id=$id;cwd=$cwd`a")
  [Console]::Write("`e]133;C`a")
  [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}
