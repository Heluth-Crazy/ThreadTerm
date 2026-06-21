[CmdletBinding()]
param(
  [string]$OutDir = "docs\artifacts\windows-terminal-baseline"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-WebView2RuntimeInfo {
  $roots = @(
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
  )

  foreach ($root in $roots) {
    if (-not (Test-Path $root)) {
      continue
    }

    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($props.name -like "*WebView2*" -or $props.pv) {
        [pscustomobject]@{
          registryPath = $_.Name
          name = $props.name
          version = $props.pv
        }
      }
    }
  }
}

$capturedAt = Get-Date -Format "yyyyMMdd-HHmmss"
$path = Join-Path $OutDir "environment-$capturedAt.json"

$environment = [ordered]@{
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  computer = Get-ComputerInfo |
    Select-Object OsName, OsVersion, WindowsVersion, OsBuildNumber, OsArchitecture, CsManufacturer, CsModel
  gpu = Get-CimInstance Win32_VideoController |
    Select-Object Name, DriverVersion, VideoProcessor, AdapterRAM, CurrentHorizontalResolution, CurrentVerticalResolution
  monitors = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue |
    Select-Object InstanceName, MaxHorizontalImageSize, MaxVerticalImageSize
  webView2Runtime = @(Get-WebView2RuntimeInfo)
  displayScaleRegistry = Get-ItemProperty "HKCU:\Control Panel\Desktop\WindowMetrics" -ErrorAction SilentlyContinue |
    Select-Object AppliedDPI
}

$environment | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -Path $path
Write-Host "Wrote environment metadata: $path"
