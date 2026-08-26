$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  cargo build --release
  New-Item -ItemType Directory -Force runtime | Out-Null
  Copy-Item target/release/threadterm-terminal-host-mcp.exe runtime/threadterm-terminal-host-mcp.exe -Force
} finally { Pop-Location }
