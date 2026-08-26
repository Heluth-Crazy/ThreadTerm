$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $manifest = Get-Content -Raw .codex-plugin/plugin.json | ConvertFrom-Json
  if ($manifest.name -ne 'threadterm-terminal-host' -or -not $manifest.mcpServers -or $manifest.interface.defaultPrompt.Count -lt 1) { throw 'invalid plugin manifest' }
  $mcp = Get-Content -Raw .mcp.json | ConvertFrom-Json
  $server = $mcp.mcpServers.'threadterm-terminal-host'
  if (-not $server.command.StartsWith('./runtime/') -or $server.cwd -ne '.' -or @($server.env_vars) -ne @('THREADTERM_PROFILE_DIR') -or $server.startup_timeout_sec -ne 5 -or $server.tool_timeout_sec -ne 30) { throw 'invalid connect-only MCP configuration' }
  cargo fmt -- --check
  cargo test
  cargo check
  cargo clippy -- -D warnings
} finally { Pop-Location }
